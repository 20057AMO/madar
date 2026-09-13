/**
 * project-serve.ts
 * Madar — Static-site serve for project containers.
 *
 * Project containers idle on `sleep infinity`, so static files in a workspace
 * are never served → Preview gives ERR_EMPTY_RESPONSE. This module runs
 * `python3 -m http.server <port> -d /workspace` inside a container when the
 * per-project toggle (`meta.serve.enabled`) is on, auto re-runs it after
 * start/create/recreate, and reports honest live state via an HTTP probe of
 * the published host port.
 *
 * The pure rules (sanitizeServeConfig / deriveServeState / buildServeCmd /
 * serveUrl) live in serve-core.ts and are offline-testable; this module wires
 * them to dockerode exec + a host.docker.internal HTTP probe.
 */
import Docker from 'dockerode';
import { loadMeta, saveMeta } from './projects-meta';
import { recordActivity } from './project-activity';
import {
  HttpError,
  buildServeCmd,
  deriveServeState,
  sanitizeServeConfig,
  type ServeConfig,
  type ServeState,
} from './serve-core';

const docker = new Docker();

export type {
  ServeConfig,
  ServeState,
} from './serve-core';
export {
  HttpError as ServeHttpError,
  buildServeCmd,
  sanitizeServeConfig,
  deriveServeState,
  serveUrl,
} from './serve-core';

const PROBE_WAIT = 500;
const PROBE_MAX_ATTEMPTS = 5; // ~2.5s total
const PROBE_TIMEOUT_MS = 3000;

/**
 * Probe a published host port over HTTP from inside the control container,
 * mirroring checkbox `checkProjectPorts` vocabulary: 'refused' | 'timeout' |
 * 'error'. 2xx/3xx → active. The probe hits host.docker.internal because the
 * serving process runs inside the *project* container, which publishes its
 * port on the host; the control container reaches it via that host mapping.
 */
export async function probeServe(
  slug: string,
  hostPort: string | number
): Promise<{ active: boolean; httpCode: number | null; status: string }> {
  const url = `http://host.docker.internal:${hostPort}/`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return { active: res.status >= 200 && res.status < 400, httpCode: res.status, status: 'open' };
  } catch (err: any) {
    const status = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'refused';
    return { active: false, httpCode: null, status };
  }
}

/** Run a command inside the project container via dockerode exec. */
async function execInContainer(
  slug: string,
  cmd: string[]
): Promise<{ pid?: number; output: string; exitCode: number | null }> {
  let exec;
  try {
    exec = await docker.getContainer(`wsd-${slug}`).exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
    });
  } catch (e: any) {
    // e.g. container is stopped/removed and can't accept execs — non-fatal.
    return { output: `exec create failed: ${e?.message || e}`, exitCode: null };
  }
  try {
    const stream: any = await exec.start({ hijack: false });
    let output = '';
    await new Promise<void>((resolve) => {
      stream.on('data', (d: Buffer) => {
        const s = d.toString('utf8');
        output += s.length > 4000 ? s.slice(-4000) : s;
      });
      stream.on('end', resolve);
      stream.on('error', resolve);
      stream.on('close', resolve);
      const timer = setTimeout(() => {
        try {
          stream.destroy();
        } catch {
          /* ignore */
        }
        resolve();
      }, 10_000);
      stream.on('close', () => clearTimeout(timer));
    });
    const info = await exec.inspect().catch(() => null);
    return { pid: info?.Pid ?? undefined, output, exitCode: info?.ExitCode ?? null };
  } catch (e: any) {
    return { output: `exec failed: ${e?.message || e}`, exitCode: null };
  }
}

/**
 * Start the http.server process inside a running container and confirm it is
 * actually serving before persisting `serve.enabled`.
 *
 * - Container must be running (else 409).
 * - Runs `python3 -m http.server <port> -d /workspace` detached.
 * - Polls the HTTP probe (~2.5s) to confirm the process is really serving.
 * - On success persists {enabled: true, port, pid}; on probe failure it kills
 *   the process and throws 409 (the port is already taken inside the container).
 */
export async function startServeProcess(
  slug: string,
  port: number,
  hostPort: string | number,
  userId?: string
): Promise<ServeState> {
  // Idempotent double-POST guard: if the toggle is already on AND the live
  // probe says we're actually serving, return the existing state rather than
  // spawning a redundant process that would just die on EADDRINUSE and leave
  // a dead PID persisted in meta. (Reuses the already-published serve port.)
  const metaNow = loadMeta(slug);
  const existing = metaNow?.serve;
  if (metaNow && existing?.enabled) {
    const existingHostPort =
      existing.port !== undefined && metaNow.ports?.includes(existing.port)
        ? existing.port
        : metaNow.ports?.[0];
    if (existingHostPort !== undefined) {
      const probe = await probeServe(slug, existingHostPort);
      if (probe.active) {
        return deriveServeState(existing, metaNow.ports, probe);
      }
    }
  }

  const container = docker.getContainer(`wsd-${slug}`);
  let running = false;
  try {
    const info = await container.inspect();
    running = Boolean(info.State?.Running);
  } catch {
    throw new HttpError(404, `Project '${slug}' not found`);
  }
  if (!running) {
    throw new HttpError(409, 'Project is stopped. Start it first.');
  }

  // Create a detached exec. AttachStdout/Stderr false — we only need the PID.
  // `Detach: true` is a real Docker ExecCreate API field that the bundled
  // @types/dockerode omits, so the options object is cast — the runtime contract
  // (cmd + detached + no attachments) is what matters here.
  const exec: Docker.Exec = await container.exec({
    Cmd: buildServeCmd(port),
    Detach: true,
    AttachStdout: false,
    AttachStderr: false,
  } as any);

  let pid: number | undefined;
  try {
    await exec.start({ Detach: true });
    const inspect = await exec.inspect().catch(() => null);
    pid = inspect?.Pid ?? pid;
  } catch {
    // Some dockerode/Docker versions want hijack explicitly false for a
    // detached (non-streaming) start.
    await exec.start({ hijack: false, Detach: true });
    const inspect = await exec.inspect().catch(() => null);
    pid = inspect?.Pid ?? pid;
  }

  // Poll the probe to confirm the server is really up before we claim success.
  let active = await probeServe(slug, hostPort);
  for (let i = 0; i < PROBE_MAX_ATTEMPTS - 1 && !active.active; i++) {
    await sleep(PROBE_WAIT);
    active = await probeServe(slug, hostPort);
  }

  if (!active.active) {
    // The process didn't come up (likely the port is already bound by
    // something else inside the container). Kill the orphan and tell the user.
    if (pid) {
      try {
        await execInContainer(slug, ['sh', '-c', `kill -TERM ${pid} 2>/dev/null`]);
      } catch {
        /* best-effort cleanup */
      }
    }
    throw new HttpError(409, `Port ${port} is already in use inside the container`);
  }

  const meta = loadMeta(slug) || { activity: [] };
  meta.serve = { enabled: true, port, pid };
  saveMeta(slug, meta);
  recordActivity(slug, 'serve_started', { userId, details: { port } });
  return deriveServeState(meta.serve, meta.ports, { active: true, httpCode: null, status: 'open' });
}

/**
 * Stop the http.server process. Verifies the recorded PID is actually OUR
 * http.server before killing it (never kill an unrelated reused PID); falls
 * back to a literal pkill pattern for robustness. Persists enabled:false while
 * keeping the port for UX memory.
 */
export async function stopServeProcess(slug: string, userId?: string): Promise<ServeState> {
  const meta = loadMeta(slug);
  if (!meta) throw new HttpError(404, `Project '${slug}' not found`);

  const serve = meta.serve as ServeConfig | undefined;
  const port = serve?.port;

  if (serve?.pid !== undefined) {
    // Verify the PID still points at OUR http.server command before killing.
    const check = await execInContainer(slug, ['sh', '-c', `ps -p ${serve.pid} -o args= 2>/dev/null`]);
    const args = (check.output || '').trim();
    if (port !== undefined && args.includes(`http.server ${port}`)) {
      await execInContainer(slug, ['sh', '-c', `kill -TERM ${serve.pid} 2>/dev/null`]);
    } else {
      // PID is gone or not ours — fall through to the literal pkill cleanup.
      // The port is validated (an integer), so the pattern is safe from shell
      // interpolation of user input.
      await execInContainer(slug, [
        'sh',
        '-c',
        `pkill -f 'python3 -m http.server ${port} -d /workspace' 2>/dev/null`,
      ]);
    }
  } else if (port !== undefined) {
    await execInContainer(slug, [
      'sh',
      '-c',
      `pkill -f 'python3 -m http.server ${port} -d /workspace' 2>/dev/null`,
    ]);
  }

  const next: ServeConfig = { enabled: false, port };
  meta.serve = next;
  saveMeta(slug, meta);
  recordActivity(slug, 'serve_stopped', { userId, details: port !== undefined ? { port } : undefined });
  return deriveServeState(next, meta.ports, null);
}

/** Is the served state actually live right now? (enabled + running container). */
function serveShouldProbe(serve: ServeConfig | undefined, running: boolean): boolean {
  return Boolean(serve?.enabled) && running;
}

/**
 * Current honest serve state. Probes only when the config says enabled AND the
 * container is running — otherwise config-only (active=false).
 */
export async function serveStatus(slug: string): Promise<ServeState> {
  const meta = loadMeta(slug);
  if (!meta) throw new HttpError(404, `Project '${slug}' not found`);

  let running = false;
  try {
    const info = await docker.getContainer(`wsd-${slug}`).inspect();
    running = Boolean(info.State?.Running);
  } catch {
    /* container gone → not running */
  }

  const serve = meta.serve;
  if (serveShouldProbe(serve, running)) {
    const port = serve?.port;
    const hostPort =
      port !== undefined && meta.ports?.includes(port) ? port : meta.ports?.[0];
    if (hostPort !== undefined) {
      const probe = await probeServe(slug, hostPort);
      return deriveServeState(serve, meta.ports, probe);
    }
    return deriveServeState(serve, meta.ports, null);
  }
  return deriveServeState(serve, meta.ports, null);
}

// A serve config with the runtime-only `error` field we persist when serving
// fails (not part of the public ServeConfig shape, but stored in meta).
type ServeWithError = ServeConfig & { error?: string | null };
const serveWithError = (s: any): ServeWithError | undefined => s as ServeWithError | undefined;

/**
 * Ensure the serve process is running when the config says enabled — called
 * by docker-manager after start/create/recreate. MUST NEVER throw: any failure
 * is persisted as serve.error and logged, never propagated up to break the
 * container lifecycle op.
 */
export async function ensureServeRunning(slug: string): Promise<void> {
  try {
    const meta = loadMeta(slug);
    if (!meta?.serve?.enabled) return;
    const serve = meta.serve as ServeConfig;
    if (serve.port === undefined) return;

    let running = false;
    try {
      const info = await docker.getContainer(`wsd-${slug}`).inspect();
      running = Boolean(info.State?.Running);
    } catch {
      running = false;
    }
    if (!running) return;

    // Re-derive the serve port against the CURRENT published ports. The stored
    // port may be stale (e.g. the user later edited published ports and removed
    // it) — sanitize throws if there's no published port to serve on anymore,
    // which we catch and record as serve.error instead of letting it propagate.
    let cfg: ServeConfig;
    try {
      cfg = sanitizeServeConfig({ enabled: true }, meta.serve, meta.ports || []);
    } catch (err: any) {
      console.warn(`[serve] no valid published port to serve for '${slug}':`, err?.message || err);
      try {
        const m = loadMeta(slug);
        const sv = serveWithError(m?.serve);
        if (m && sv?.enabled) {
          sv.error = String(err?.message || err);
          saveMeta(slug, m);
        }
      } catch {
        /* best-effort */
      }
      return;
    }
    const rederivedPort = cfg.port!;
    // sanitizeServeConfig guarantees the port is published → host port maps 1:1.
    const hostPort = rederivedPort;

    const probe = await probeServe(slug, hostPort);
    if (probe.active) {
      // Already serving — clear any stale error (there's no PID to update; we
      // re-derive state from the config + probe).
      const m = loadMeta(slug);
      const sv = serveWithError(m?.serve);
      if (sv?.error) {
        delete sv.error;
        saveMeta(slug, m!);
      }
      return;
    }

    // Not serving but enabled → (re)start it on the re-derived published port.
    const started = await startServeProcess(slug, rederivedPort, hostPort);
    if (started.active && !started.error) {
      const m = loadMeta(slug);
      const sv = serveWithError(m?.serve);
      if (sv?.error) {
        delete sv.error;
        saveMeta(slug, m!);
      }
    }
  } catch (err: any) {
    // Never propagate — record the failure on the serve object for the UI.
    console.warn(`[serve] ensureServeRunning failed for '${slug}':`, err?.message || err);
    try {
      const m = loadMeta(slug);
      const sv = serveWithError(m?.serve);
      if (m && sv?.enabled) {
        sv.error = String(err?.message || err);
        saveMeta(slug, m);
      }
    } catch {
      /* best-effort */
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
