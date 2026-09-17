/**
 * ws-terminal.ts
 * Madar — In-page project terminal.
 * Two modes, both scoped to the project path:
 *   mode=project  → docker exec into the project container at /workspace (dev toolchain).
 *   mode=control  → shell in the app/control container at /workspaces/<slug> (git + docker CLI + socket).
 * Protocol: raw binary frames carry terminal I/O; text frames are JSON control
 * messages ({ type: 'resize', cols, rows }). Server closes on error with a
 * text { type: 'error', message } frame first.
 */
import { WebSocket } from 'ws';
import Docker from 'dockerode';
import path from 'path';
import * as pty from 'node-pty';
import { WORKSPACES_ROOT } from '../services/docker-manager';
import { resolveProjectSubdir } from '../services/workspace-files';

const docker = new Docker();

const active = new Set<string>();
const MAX_SESSIONS = 16;

interface ShellHandle {
  write: (data: Buffer) => void;
  resize: (cols: number, rows: number) => void;
  close: () => void;
}

export function handleTerminalSocket(
  ws: WebSocket,
  slug: string,
  mode: 'project' | 'control',
  onRelease: () => void
): void {
  const key = `${slug}:${mode}`;
  if (active.has(key)) {
    sendJson(ws, { type: 'error', message: `A ${mode} terminal for '${slug}' is already open. Close it first.` });
    ws.close(1013, 'session busy');
    onRelease();
    return;
  }
  if (active.size >= MAX_SESSIONS) {
    sendJson(ws, { type: 'error', message: 'Too many open terminals. Close another one first.' });
    ws.close(1013, 'too many sessions');
    onRelease();
    return;
  }

  const send = (data: Buffer) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  };

  // Resolve the project subdir (workspace root → subdirectory heuristic).
  const subdirInfo = resolveProjectSubdir(slug);

  // Attach handlers immediately so frames sent right after connect are not
  // dropped while the shell is still starting up; queue stdin until ready.
  const queue: Buffer[] = [];
  let shell: ShellHandle | null = null;
  let ready = false;
  let closed = false;

  const finish = () => {
    if (closed) return;
    closed = true;
    active.delete(key);
    if (shell) {
      try {
        shell.close();
      } catch {
        /* ignore */
      }
    }
    if (ws.readyState === WebSocket.OPEN) ws.close();
    onRelease();
  };

  ws.on('message', (data, isBinary) => {
    if (closed) return;
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    if (!isBinary) {
      const text = buf.toString('utf8');
      try {
        const msg = JSON.parse(text);
        if (msg?.type === 'resize') {
          const cols = Math.max(2, Math.min(500, Number(msg.cols) || 80));
          const rows = Math.max(2, Math.min(300, Number(msg.rows) || 24));
          if (shell) shell.resize(cols, rows);
        }
      } catch {
        /* ignore malformed control frame */
      }
    } else {
      if (ready && shell) shell.write(buf);
      else queue.push(buf);
    }
  });
  ws.on('close', finish);
  ws.on('error', finish);

  let notifyExit = finish;
  // pty.spawn can throw SYNCHRONOUSLY (e.g. missing shell binary on exotic
  // hosts); a throw here would propagate through the ws connection handler
  // and take down the whole backend. Convert every failure path into a
  // graceful socket close.
  const start = (async () => {
    if (mode === 'control') return startControlShell(slug, subdirInfo, send, () => notifyExit());
    try {
      return await startProjectExec(slug, subdirInfo, send, () => notifyExit());
    } catch (err: any) {
      if (err?.statusCode === 404) {
        throw new Error(`Project container 'wsd-${slug}' not found. Start the project first.`);
      }
      throw err;
    }
  })();

  start
    .then((sh) => {
      if (ws.readyState !== WebSocket.OPEN) {
        sh.close();
        onRelease();
        return;
      }
      shell = sh;
      active.add(key);
      ready = true;
      while (queue.length > 0) {
        sh.write(queue.shift()!);
      }
      sendJson(ws, { type: 'ready' });
      // Send the resolved working directory so the frontend can show it in
      // the header and use it for the IDE deep-link.
      sendJson(ws, {
        type: 'path',
        path: subdirInfo.subdir || '',
        containerPath: subdirInfo.containerPath,
        hostPath: subdirInfo.hostPath,
      });
    })
    .catch((err) => {
      if (ws.readyState === WebSocket.OPEN) {
        sendJson(ws, { type: 'error', message: String(err?.message || err) });
        ws.close(1011, 'terminal failed');
      }
      onRelease();
    });
}

/** Shell running in the app/control container, cwd = the project workspace. Uses node-pty for real PTY support. */
/**
 * Env allowlist for the control shell. NEVER pass `process.env` through: the
 * backend container holds JWT_SECRET, encryption keys, and provider API keys
 * that must not leak into an interactive shell. Only known-safe variables are
 * inherited; everything else the shell needs is set explicitly.
 */
const CONTROL_ENV_ALLOWLIST = [
  'PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TZ',
  'HOSTNAME', 'SHELL', 'USER', 'LOGNAME',
] as const;

function controlEnv(): Record<string, string> {
  const env: Record<string, string> = {
    TERM: 'xterm-256color',
    LANG: 'C.UTF-8',
  };
  for (const key of CONTROL_ENV_ALLOWLIST) {
    const v = process.env[key];
    if (typeof v === 'string') env[key] = v;
  }
  return env;
}

function startControlShell(
  slug: string,
  subdirInfo: { subdir: string },
  send: (d: Buffer) => void,
  onExit: () => void
): Promise<ShellHandle> {
  const base = path.join(WORKSPACES_ROOT, slug);
  const cwd = subdirInfo.subdir ? path.join(base, subdirInfo.subdir) : base;

  const shellBinary = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : '/bin/bash';
  const ptyProcess = pty.spawn(shellBinary, ['-l'], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd,
    env: controlEnv(),
  });

  let exited = false;

  ptyProcess.onData((data: string) => {
    send(Buffer.from(data, 'utf-8'));
  });

  ptyProcess.onExit(() => {
    if (!exited) {
      exited = true;
      onExit();
    }
  });

  return Promise.resolve({
    write: (d: Buffer) => {
      if (!exited) ptyProcess.write(d.toString('utf-8'));
    },
    resize: (cols: number, rows: number) => {
      if (!exited) ptyProcess.resize(cols, rows);
    },
    close: () => {
      if (exited) return;
      exited = true;
      try { ptyProcess.kill(); } catch { /* already dead */ }
    },
  });
}

/** Shell inside the project container (docker exec, TTY). */
function startProjectExec(
  slug: string,
  subdirInfo: { subdir: string },
  send: (d: Buffer) => void,
  onExit: () => void
): Promise<ShellHandle> {
  const workDir = subdirInfo.subdir ? `/workspace/${subdirInfo.subdir}` : '/workspace';
  return docker
    .getContainer(`wsd-${slug}`)
    .exec({
      Cmd: ['/bin/bash', '-l'],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      Env: ['TERM=xterm-256color', 'LANG=C.UTF-8'],
      WorkingDir: workDir,
    })
    .then(async (exec) => {
      const stream: any = await exec.start({ hijack: true, stdin: true });
      return { exec, stream };
    })
    .then(({ exec, stream }) => {
      let closed = false;
      const finish = () => {
        if (closed) return;
        closed = true;
        onExit();
      };
      stream.on('data', (d: Buffer) => send(d));
      stream.on('close', () => finish());
      stream.on('end', () => finish());
      stream.on('error', () => finish());
      return {
        write: (d: Buffer) => {
          try {
            stream.write(d);
          } catch {
            /* stream closed */
          }
        },
        resize: (cols: number, rows: number) => {
          exec.resize({ h: rows, w: cols }, () => {});
        },
        close: () => {
          finish();
          try {
            stream.destroy();
          } catch {
            /* ignore */
          }
        },
      } as ShellHandle;
    });
}

function sendJson(ws: WebSocket, obj: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}
