/**
 * component-updates.test.ts
 *
 * Real-Docker HTTP surface for the unified component-update endpoints
 * (`GET /api/updates`, `POST /api/updates/check`, `POST /api/updates/apply`)
 * covering BOTH components (opencode + code-server).
 *
 * The suite is SELF-DRIVING against the live `wsd-pro` container (webhooks-test
 * style, where the "external" services are an in-process mock reachable via
 * host.docker.internal):
 *
 *   before()
 *     • starts a mock HTTP server on 0.0.0.0:8987..8997 implementing the GitHub
 *       releases API, the npm registry `latest` endpoint and the .deb download
 *       endpoints the backend expects;
 *     • recreates the container with WSD_UPDATE_GITHUB_BASE /
 *       WSD_UPDATE_DOWNLOAD_BASE / WSD_UPDATE_NPM_REGISTRY pointed at the mock
 *       and WSD_TESTING=1 (relaxed rate budgets) via `docker compose up -d`
 *       (compose recreates on env change; --force-recreate only when the
 *       installed code-server binary is already a fake one from an aborted run);
 *     • waits for health + the embedded IDE port;
 *     • clears `$DATA_DIR/updates/` (the wsd-data volume survives recreates, so
 *       an applyState from a previous abort would poison the shape assertions);
 *     • backs up the pristine code-server install (429 MB — restored in after());
 *     • builds REAL fake code-server packages with dpkg-deb INSIDE the container
 *       (same package name so `dpkg -i` performs a clean version swap);
 *     • creates a throwaway admin account and forges its JWT (repo JWT_SECRET) —
 *       applies authenticate as a real known user without the real account
 *       password and without touching the REAL first-admin login.
 *
 *   after()
 *     • restores the backed-up code-server files + launcher and SIGTERMs the
 *       supervised child so the entrypoint revives the ORIGINAL binary;
 *     • recreates the container with the DEFAULT env (WSD_UPDATE_*=, WSD_TESTING=0);
 *     • clears updates state, deletes the temp admin, and asserts a final
 *       4.96.x code-server + healthy /api/updates so the box is left as found.
 *
 * Cases:
 *  1. GET /api/updates shape (anonymous 401, 2 components, idle flags)
 *  2. Access matrix + password gates (401/403/403, missing/incorrect applied)
 *  3. POST /api/updates/check → checkedAt bump + `updates-check` audit row
 *  4. code-server happy path: 202 → `ok` → 4.99.0 live + state file + audit
 *  5. Real boot-failure rollback: broken 4.99.1 → `failed` rolledBack → back on 4.99.0
 *  6. Synchronous downgrade gate: 4.95.0 → immediate 400 "already up to date",
 *     state file untouched, zero downloads
 *  7. Single-flight: second apply during a running one → 409
 *  8. opencode npm status: channelUnlocked true when supported / false on 99.x
 *  9. Rate budgets under WSD_TESTING=1: 7-check burst + no 429 anywhere in the run
 *
 * Downgrade gate: `POST /api/updates/apply` now carries a SYNCHRONOUS gate (a
 * fresh registry compare inside the request flow, before the background run) —
 * a target not strictly newer than the installed version returns an immediate
 * 400, and an unreachable registry returns 503 (cannot verify). The backend's
 * "not-newer" preflight stays as a second defense layer. Test 6 asserts the 400.
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import jwt from 'jsonwebtoken';

import { API_URL, JWT_SECRET, authHeaders, initTestAuth, req, reqAuth, uniqueId } from './helpers.ts';

const CONTAINER = 'wsd-pro';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MOCK_PORTS = Array.from({ length: 11 }, (_, i) => 8987 + i);

const HAPPY_VERSION = '4.99.0';   // newest success target
const BROKEN_VERSION = '4.99.1';  // newest, fails to boot → rollback
const BASELINE_VERSION = '4.96.4'; // the really installed code-server
const DOWNGRADE_VERSION = '4.95.0'; // not newer → gate
const FAKE_COMMIT = 'b'.repeat(40);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const debName = (v: string) => `code-server_${v}_amd64.deb`;

// ── docker helpers ──────────────────────────────────────────────────────────

interface ExecOut { stdout: string; stderr: string }

function execFileOut(cmd: string, args: string[], opts: { timeout?: number; cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<ExecOut> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      timeout: opts.timeout ?? 120_000,
      maxBuffer: 64 * 1024 * 1024,
      cwd: opts.cwd,
      env: opts.env,
    }, (err, stdout, stderr) => {
      if (err) reject(new Error(`exec ${cmd} ${args.join(' ')} failed: ${err.message}\nstderr: ${stderr}`));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function dockerExec(args: string[], opts: { timeout?: number } = {}): Promise<string> {
  return execFileOut('docker', ['exec', CONTAINER, ...args], { timeout: opts.timeout ?? 90_000 })
    .then((r) => r.stdout);
}

function dockerCp(src: string, dst: string): Promise<void> {
  return execFileOut('docker', ['cp', src, dst], { timeout: 300_000 }).then(() => undefined);
}

async function composeUp(overrides: Record<string, string>, forceRecreate: boolean): Promise<void> {
  const args = ['compose', 'up', '-d'];
  if (forceRecreate) args.push('--force-recreate');
  args.push('app');
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(overrides)) env[k] = v;
  await execFileOut('docker', args, { timeout: 300_000, cwd: REPO_ROOT, env });
}

async function pollHealth(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${API_URL}/health`, { signal: AbortSignal.timeout(4000) });
      if (r.ok) {
        const j: any = await r.json();
        if (j && j.status === 'ok') return;
      }
    } catch { /* booting */ }
    await sleep(1500);
  }
  throw new Error(`container health not ok within ${timeoutMs}ms`);
}

function tcpProbeHost(port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port });
    let done = false;
    const finish = (ok: boolean) => { if (!done) { done = true; s.destroy(); resolve(ok); } };
    s.setTimeout(timeoutMs);
    s.once('connect', () => finish(true));
    s.once('timeout', () => finish(false));
    s.once('error', () => finish(false));
  });
}

async function resolveIdeHostPort(): Promise<number> {
  try {
    const { stdout } = await execFileOut('docker', ['port', CONTAINER, '8080'], { timeout: 30_000 });
    const m = stdout.match(/0\.0\.0\.0:(\d+)/);
    if (m) return Number(m[1]);
  } catch { /* fall through */ }
  return 8100;
}

async function waitForCodeServerVersion(timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const out = (await dockerExec(['sh', '-c', 'code-server --version 2>/dev/null'])).trim();
      const m = out.match(/\d+\.\d+\.\d+/);
      if (m) return m[0];
      last = out;
    } catch { /* container restarting */ }
    await sleep(1500);
  }
  throw new Error(`code-server did not report a version within ${timeoutMs}ms (last: ${JSON.stringify(last)})`);
}

async function clearUpdatesState(): Promise<void> {
  await dockerExec(['sh', '-c', 'rm -rf /app/data/updates']);
}

async function readCodeServerState(): Promise<any> {
  const out = await dockerExec(['sh', '-c', 'cat /app/data/updates/code-server.json 2>/dev/null || echo "{}"']);
  try { return JSON.parse(out); } catch { return {}; }
}

// ── mock GitHub / npm / .deb server ─────────────────────────────────────────

interface FakeDeb { bytes: Buffer; sha256: string }

const mock = {
  csLatest: '',
  npmLatest: '',
  debs: new Map<string, FakeDeb>(),
  counters: { deb: {} as Record<string, number>, download: {} as Record<string, number>, npm: 0, release: 0 },
  port: 0,
  server: null as http.Server | null,
};

async function startMock(): Promise<void> {
  const server = http.createServer((req, res) => {
    const url = req.url || '/';
    const u = new URL(url, 'http://127.0.0.1');

    if (u.pathname === '/repos/coder/code-server/releases/latest') {
      mock.counters.release += 1;
      const v = mock.csLatest || HAPPY_VERSION;
      const d = mock.debs.get(v);
      const payload = {
        tag_name: `v${v}`,
        assets: [{
          name: debName(v),
          browser_download_url: `http://host.docker.internal:${mock.port}/deb/${debName(v)}`,
          digest: d ? `sha256:${d.sha256}` : undefined,
          size: d ? d.bytes.length : undefined,
        }],
      };
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('x-ratelimit-remaining', '9999');
      res.end(JSON.stringify(payload));
      return;
    }

    if (u.pathname === '/npm/opencode-ai/latest') {
      mock.counters.npm += 1;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ version: mock.npmLatest || '1.18.22' }));
      return;
    }

    let m: RegExpExecArray | null;
    if ((m = /^\/deb\/(code-server_\d+\.\d+\.\d+_amd64\.deb)$/.exec(u.pathname)) !== null) {
      const v = m[1].replace(/^code-server_/, '').replace(/_amd64\.deb$/, '');
      mock.counters.deb[m[1]] = (mock.counters.deb[m[1]] ?? 0) + 1;
      const d = mock.debs.get(v);
      if (!d) { res.statusCode = 404; res.end('not found'); return; }
      res.setHeader('Content-Type', 'application/octet-stream');
      res.end(d.bytes);
      return;
    }
    if ((m = /^\/download\/v((?:\d+)\.(?:\d+)\.(?:\d+))\/code-server_\1_amd64\.deb$/.exec(u.pathname)) !== null) {
      const name = debName(m[1]);
      mock.counters.download[name] = (mock.counters.download[name] ?? 0) + 1;
      const d = mock.debs.get(m[1]);
      if (!d) { res.statusCode = 404; res.end('not found'); return; }
      res.setHeader('Content-Type', 'application/octet-stream');
      res.end(d.bytes);
      return;
    }

    if (u.pathname === '/mock/control' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        try {
          const ctl = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { codeServer?: string; npm?: string };
          if (typeof ctl.codeServer === 'string') mock.csLatest = ctl.codeServer;
          if (typeof ctl.npm === 'string') mock.npmLatest = ctl.npm;
        } catch { /* junk */ }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    if (u.pathname === '/mock/stats') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ counters: mock.counters, csLatest: mock.csLatest, npmLatest: mock.npmLatest }));
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  });

  for (const port of MOCK_PORTS) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '0.0.0.0', () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      mock.port = port;
      mock.server = server;
      console.log(`[mock] listening on host.docker.internal:${port}`);
      return;
    } catch { /* try next port */ }
  }
  throw new Error('no free mock port in 8987..8997');
}

function mockControl(ctl: { codeServer?: string; npm?: string }): Promise<void> {
  return fetch(`http://127.0.0.1:${mock.port}/mock/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ctl),
  }).then(() => undefined);
}

// ── fake .deb factory (dpkg-deb inside the container) ───────────────────────

async function buildFakeDeb(version: string, kind: 'good' | 'broken', hostTmp: string): Promise<void> {
  const pkg = path.join(hostTmp, `deb-src-${version}`);
  fs.mkdirSync(path.join(pkg, 'DEBIAN'), { recursive: true });
  fs.mkdirSync(path.join(pkg, 'usr/lib/code-server'), { recursive: true });
  fs.mkdirSync(path.join(pkg, 'usr/bin'), { recursive: true });

  fs.writeFileSync(path.join(pkg, 'DEBIAN', 'control'), [
    'Package: code-server',
    `Version: ${version}`,
    'Architecture: amd64',
    'Maintainer: madar-e2e <test@madar.local>',
    'Description: fake code-server package for the component-update suite',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(pkg, 'DEBIAN', 'postinst'), '#!/bin/sh\nexit 0\n');
  fs.writeFileSync(path.join(pkg, 'usr/lib/code-server', 'version'), `${version} ${FAKE_COMMIT} with Code ${version}\n`);

  // Launcher: --version answer from the version file; supervisor mode either
  // serves HTTP on 8080 (good) or exits 7 (broken → boot-verify fails → rollback).
  const nodeServer =
    'exec node -e \'const n=require("net");const s=n.createServer(c=>c.on("error",()=>{}));' +
    's.listen(8080,"0.0.0.0");process.on("SIGTERM",()=>process.exit(0));setInterval(()=>{},1<<30);\'';
  const stub = [
    '#!/bin/sh',
    'V=$(cat /usr/lib/code-server/version)',
    'if [ "$1" = "--version" ]; then',
    '  echo "$V"',
    '  exit 0',
    'fi',
    kind === 'good' ? nodeServer : 'exit 7',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(pkg, 'usr/bin', 'code-server'), stub);

  const remote = `/tmp/madar-deb-src-${version}`;
  // DO NOT pre-create the remote dir: `docker cp dir dest` creates `dest` as a
  // copy of the source only when the destination does not exist (an existing
  // dir would receive the source as a nested child).
  await dockerExec(['sh', '-c', `rm -rf ${remote}`]);
  await dockerCp(pkg, `${CONTAINER}:${remote}`);
  await dockerExec(['sh', '-c',
    `chmod 0755 ${remote}/DEBIAN/postinst ${remote}/usr/bin/code-server && ` +
    `dpkg-deb --build ${remote} /tmp/${debName(version)}`,
  ]);
  const hostDeb = path.join(hostTmp, debName(version));
  await dockerCp(`${CONTAINER}:/tmp/${debName(version)}`, hostDeb);
  await dockerExec(['sh', '-c', `rm -rf ${remote} /tmp/${debName(version)}`]);
  const bytes = fs.readFileSync(hostDeb);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  mock.debs.set(version, { bytes, sha256 });
  console.log(`[mock] fake deb built: code-server ${version} (${kind}, ${bytes.length} bytes)`);
}

// ── code-server filesystem backup/restore (guards against a failed final recreate)
// NB: the archive is created INSIDE the container (tar keeps symlinks natively);
// Windows hosts cannot materialize the install's symlinks via docker cp, so the
// archive crosses the host boundary as a single opaque file.
const CS_BACKUP_TAR = '/tmp/madar-cs-backup.tar.gz';

async function backupCodeServer(hostTmp: string): Promise<{ tar: string }> {
  const hostTar = path.join(hostTmp, 'cs-backup.tar.gz');
  await dockerExec(['sh', '-c',
    `rm -f ${CS_BACKUP_TAR} && tar -czf ${CS_BACKUP_TAR} -C / usr/lib/code-server usr/bin/code-server`],
  { timeout: 300_000 });
  await dockerCp(`${CONTAINER}:${CS_BACKUP_TAR}`, hostTar);
  await dockerExec(['sh', '-c', `rm -f ${CS_BACKUP_TAR}`]);
  return { tar: hostTar };
}

async function restoreCodeServer(backup: { tar: string }): Promise<void> {
  await dockerCp(backup.tar, `${CONTAINER}:${CS_BACKUP_TAR}`);
  await dockerExec(['sh', '-c',
    `rm -rf /usr/lib/code-server && tar -xzf ${CS_BACKUP_TAR} -C / && rm -f ${CS_BACKUP_TAR}`],
  { timeout: 300_000 });
  await dockerExec(['sh', '-c',
    'if [ -f /app/data/code-server.pid ]; then kill -TERM $(cat /app/data/code-server.pid) 2>/dev/null || true; fi']);
}

// ── container bootstrap ─────────────────────────────────────────────────────

const UPDATES_ENV = (port: number) => ({
  WSD_UPDATE_GITHUB_BASE: `http://host.docker.internal:${port}`,
  WSD_UPDATE_DOWNLOAD_BASE: `http://host.docker.internal:${port}`,
  WSD_UPDATE_NPM_REGISTRY: `http://host.docker.internal:${port}/npm`,
  WSD_TESTING: '1',
  // Explicit budgets give the suite headroom beyond even the relaxed defaults
  // (check 60 / apply 20 under WSD_TESTING=1 — compose now defaults these envs
  // to empty so rateCeil's relaxation actually applies).
  WSD_RATE_UPDATE_APPLY_MAX: '100',
  WSD_RATE_UPDATE_CHECK_MAX: '200',
});

const RESTORE_ENV: Record<string, string> = {
  WSD_UPDATE_GITHUB_BASE: '',
  WSD_UPDATE_DOWNLOAD_BASE: '',
  WSD_UPDATE_NPM_REGISTRY: '',
  WSD_TESTING: '0',
  WSD_RATE_UPDATE_APPLY_MAX: '',
  WSD_RATE_UPDATE_CHECK_MAX: '',
};

async function ensureContainerConfigured(mockPort: number): Promise<void> {
  const want = UPDATES_ENV(mockPort);
  let env = '';
  let currentVersion = '';
  for (let i = 0; i < 30; i += 1) {
    try {
      env = await dockerExec(['env']);
      currentVersion = await waitForCodeServerVersion(5000);
      break;
    } catch { await sleep(1500); }
  }
  const envOk = env.includes(`WSD_UPDATE_GITHUB_BASE=${want.WSD_UPDATE_GITHUB_BASE}`)
    && env.includes('WSD_TESTING=1')
    && env.includes(`WSD_UPDATE_NPM_REGISTRY=${want.WSD_UPDATE_NPM_REGISTRY}`)
    && env.includes('WSD_RATE_UPDATE_APPLY_MAX=100')
    && env.includes('WSD_RATE_UPDATE_CHECK_MAX=200');
  const binaryOk = currentVersion === BASELINE_VERSION;
  if (envOk && binaryOk) return; // fast path — already the mock container

  console.log(`[container] recreating for mock env (envOk=${envOk}, binary=${currentVersion || 'unknown'})`);
  await composeUp(want, envOk && !binaryOk);
  await pollHealth(240_000);
  await waitForCodeServerVersion(60_000);
  await clearUpdatesState();
}

// ── temp admin account (real applies without the real account password) ─────

interface TempAdmin { id: string; username: string; password: string; headers: Record<string, string> }

async function provisionTempAdmin(): Promise<TempAdmin> {
  const username = uniqueId('upd-admin');
  const password = 'madar-upd-pw-' + Math.random().toString(36).slice(2, 10);
  const r = await reqAuth('POST', '/users', { username, password, role: 'admin' });
  assert.strictEqual(r.status, 201, `temp admin create expected 201, got ${r.status}`);
  const body: any = await r.json();
  const id = String(body.id);
  const token = jwt.sign({ id, username, role: 'admin', tv: 0 }, JWT_SECRET, { expiresIn: '24h' });
  return { id, username, password, headers: { Authorization: `Bearer ${token}` } };
}

// ── suite-level helpers ─────────────────────────────────────────────────────

let hostTmp = '';
let fsBackup: { lib: string; bin: string } | null = null;
let tempAdmin: TempAdmin | null = null;
let installedOpencode = '1.18.22';
const applyPosts: number[] = [];
const checkPosts: number[] = [];

async function piGet(headers: Record<string, string>): Promise<any> {
  const r = await req('GET', '/updates', undefined, headers);
  assert.strictEqual(r.status, 200, `GET /updates status ${r.status}`);
  return r.json();
}

function byId(j: any, id: string): any {
  const c = (j.components ?? []).find((x: any) => x.id === id);
  assert.ok(c, `component ${id} present`);
  return c;
}

async function piPostApply(headers: Record<string, string>, body: unknown): Promise<{ status: number; body: any }> {
  const r = await req('POST', '/updates/apply', body, headers);
  applyPosts.push(r.status);
  let b: any = {};
  try { b = await r.json(); } catch { /* empty body */ }
  return { status: r.status, body: b };
}

async function piPostCheck(headers: Record<string, string>): Promise<number> {
  const r = await req('POST', '/updates/check', {}, headers);
  checkPosts.push(r.status);
  return r.status;
}

async function piMockStats(): Promise<any> {
  return fetch(`http://127.0.0.1:${mock.port}/mock/stats`).then((x) => x.json());
}

async function piLogContains(pattern: string): Promise<boolean> {
  const out = await dockerExec(['sh', '-c', `grep -F "${pattern}" /app/data/updates/update.log 2>/dev/null || true`]);
  return out.includes(pattern);
}

async function piPollComponent(id: 'opencode' | 'code-server', target: string, timeoutMs: number, headers: Record<string, string>): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < deadline) {
    const j = await piGet(headers);
    const c = (j.components ?? []).find((x: any) => x.id === id);
    last = c;
    if (!c) throw new Error(`component ${id} missing from status`);
    if (c.applyState === target) return c;
    if (c.applyState === 'failed' && target !== 'failed') {
      throw new Error(`${id} apply failed unexpectedly: ${JSON.stringify(c)}`);
    }
    await sleep(1000);
  }
  throw new Error(`timeout waiting for ${id}.applyState=${target}; last: ${JSON.stringify(last)}`);
}

/**
 * The status surface carries `error` and `rolledBack` (persisted to the state
 * file on every terminal failure) so the admin can see WHY an update failed
 * and whether a rollback landed. The state file stays authoritative for exact
 * target/current facts; the surface is asserted directly where it matters.
 */
const CODE_SERVER_STATE = '/app/data/updates/code-server.json';

async function piReadCsState(): Promise<any> {
  // dockerExec resolves to the stdout STRING (see readCodeServerState above)
  const out = await dockerExec(['sh', '-c', `cat ${CODE_SERVER_STATE} 2>/dev/null || echo "{}"`]);
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

const CS_EXEC_STATES = ['downloading', 'verifying', 'installing', 'restarting', 'verifying-boot', 'rollback'];

/** Wait for a leftover apply (e.g. from an aborted earlier test) to settle. */
async function piWaitCsSettled(timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < deadline) {
    const s = await piReadCsState();
    last = s;
    if (!s || !CS_EXEC_STATES.includes(s.applyState)) return;
    await sleep(1000);
  }
  throw new Error(`previous code-server apply did not settle: ${what}; last=${JSON.stringify(last)}`);
}

/** Wait until a NEW apply has refreshed the state file (its startedAt moved). */
async function piWaitCsStarted(prevStartedAt: string | undefined, timeoutMs: number): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < deadline) {
    const s = await piReadCsState();
    last = s;
    if (s && typeof s.startedAt === 'string' && s.startedAt !== prevStartedAt) return s;
    await sleep(500);
  }
  throw new Error(`code-server apply never started (prev startedAt=${prevStartedAt}; last=${JSON.stringify(last)})`);
}

/** Poll the code-server state FILE until pred(s) is true. */
async function piWaitCsState(pred: (s: any) => boolean, timeoutMs: number, what: string): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < deadline) {
    const s = await piReadCsState();
    last = s;
    if (s && pred(s)) return s;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for state: ${what}; last=${JSON.stringify(last)}`);
}

async function piAudit(headers: Record<string, string>): Promise<any[]> {
  const r = await req('GET', '/auth/audit', undefined, headers);
  assert.strictEqual(r.status, 200, `audit status ${r.status}`);
  const j: any = await r.json();
  return Array.isArray(j.entries) ? j.entries : [];
}

// Assumes the fake version string `v bbb… with Code v` is already deployed (or that
// the real /usr/lib/code-server/version exists). Used to assert the LIVE binary.
async function liveCodeServerVersion(): Promise<string> {
  return waitForCodeServerVersion(30_000);
}

// ── the suite ───────────────────────────────────────────────────────────────

describe('Unified component updates (Real Docker, mock GitHub/npm/deb)', () => {
  before(async () => {
    // 0. preflight
    await execFileOut('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 30_000 })
      .catch((e) => { throw new Error(`docker unavailable: ${e.message}`); });
    const runningOut = await execFileOut('docker', ['inspect', '-f', '{{.State.Running}}', CONTAINER], { timeout: 30_000 })
      .catch(() => ({ stdout: 'false', stderr: '' }));
    if (runningOut.stdout.trim() !== 'true') throw new Error(`container ${CONTAINER} is not running`);

    hostTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'madar-upd-'));
    await startMock();
    mock.csLatest = HAPPY_VERSION;
    mock.npmLatest = '1.18.22';

    // 1. container pointed at the mock
    await ensureContainerConfigured(mock.port);
    await pollHealth(120_000);
    const hostIde = await resolveIdeHostPort();
    console.log(`[container] healthy; IDE host port ${hostIde}`);

    // 2. fresh updates state (volume persists; stale applyState would poison tests)
    try { await clearUpdatesState(); } catch { /* maybe mid-restart */ }

    // 3. backups + fake debs (baseline too, so the mock can serve /download/v4.96.4/…)
    fsBackup = await backupCodeServer(hostTmp);
    await buildFakeDeb(BASELINE_VERSION, 'good', hostTmp);
    await buildFakeDeb(HAPPY_VERSION, 'good', hostTmp);
    await buildFakeDeb(BROKEN_VERSION, 'broken', hostTmp);

    // 4. auth
    await initTestAuth();
    tempAdmin = await provisionTempAdmin();
    console.log(`[auth] temp admin provisioned: ${tempAdmin.username}`);

    // 5. the opencode "latest" baseline must equal what the image actually ships,
    //    so `upToDate` starts true. Read it from the fresh container rather than
    //    hardcoding (the image version moves between builds).
    const st = await piGet(tempAdmin.headers);
    const oc = st.components.find((c: any) => c.id === 'opencode');
    installedOpencode = String(oc?.current ?? installedOpencode);
    mock.npmLatest = installedOpencode;
    console.log(`[mock] opencode baseline set to ${installedOpencode}`);
  });

  test('1. GET /api/updates: anonymous 401, two components, idle shape', async () => {
    const anon = await req('GET', '/updates');
    assert.strictEqual(anon.status, 401, `anon expected 401, got ${anon.status}`);

    const j = await piGet(authHeaders());
    assert.equal(typeof j.checkedAt, 'string', 'checkedAt is a fresh ISO stamp');
    assert.ok(new Date(j.checkedAt).getTime() > 0, 'checkedAt parses');
    assert.ok(Array.isArray(j.components), 'components array');
    assert.equal(j.components.length, 2, 'exactly two components');
    const ids = j.components.map((c: any) => c.id).sort();
    assert.deepEqual(ids, ['code-server', 'opencode']);

    const cs = byId(j, 'code-server');
    assert.match(cs.current, /^\d+\.\d+\.\d+$/);
    assert.equal(cs.current.startsWith('4.96.'), true, `current is the installed 4.96.x (${cs.current})`);
    assert.equal(cs.latest, HAPPY_VERSION, 'mock latest serves 4.99.0');
    assert.equal(cs.upToDate, false, '4.96.4 < 4.99.0');
    assert.equal(cs.channelUnlocked, true);
    assert.equal(cs.applyState, 'idle');
    assert.equal(cs.updateRunning, false);

    const oc = byId(j, 'opencode');
    assert.match(oc.current, /^\d+\.\d+\.\d+$/);
    assert.equal(oc.latest, installedOpencode, 'npm mock baseline == installed');
    assert.equal(oc.upToDate, true);
    assert.equal(oc.channelUnlocked, true);
    assert.equal(oc.applyState, 'idle');
    assert.equal(oc.updateRunning, false);
  });

  test('2. access matrix + password gates on /apply', async () => {
    const anon = await req('POST', '/updates/apply', { component: 'code-server' });
    assert.equal(anon.status, 401, 'anon 401');

    const viewer = jwt.sign({ id: 'upd-viewer', username: 'upd-viewer', role: 'viewer', tv: 0 }, JWT_SECRET, { expiresIn: '1h' });
    const editor = jwt.sign({ id: 'upd-editor', username: 'upd-editor', role: 'editor', tv: 0 }, JWT_SECRET, { expiresIn: '1h' });
    const asViewer = await req('POST', '/updates/apply', { component: 'code-server' }, { Authorization: `Bearer ${viewer}` });
    assert.equal(asViewer.status, 403, 'viewer 403');
    const asEditor = await req('POST', '/updates/apply', { component: 'code-server' }, { Authorization: `Bearer ${editor}` });
    assert.equal(asEditor.status, 403, 'editor 403');

    assert.ok(tempAdmin, 'tempAdmin expected');
    const h = tempAdmin!.headers;

    const noPw = await piPostApply(h, { component: 'code-server' });
    assert.equal(noPw.status, 400, 'missing password 400');
    assert.match(String(noPw.body.error ?? ''), /password/i);

    const wrongPw = await piPostApply(h, { component: 'code-server', accountPassword: 'definitely-wrong' });
    assert.equal(wrongPw.status, 401, 'wrong password 401');

    // state stays idle — the gates never started an apply
    const j = await piGet(h);
    const cs = byId(j, 'code-server');
    assert.equal(cs.applyState, 'idle');
  });

  test('3. POST /api/updates/check: 200 + cache-bypass + updates-check audit', async () => {
    assert.ok(tempAdmin);
    const h = tempAdmin!.headers;
    const before = await piMockStats();
    const releaseBefore = (before.counters?.release ?? 0);

    const statusCheck = await piPostCheck(h);
    assert.equal(statusCheck, 200, 'manual check is 200');

    const j1 = await piGet(h);
    assert.equal(typeof j1.checkedAt, 'string');
    assert.equal(byId(j1, 'code-server').upToDate, false);

    const after = await piMockStats();
    const releaseAfter = (after.counters?.release ?? 0);
    assert.ok(releaseAfter > releaseBefore, `checkNow bypassed the release cache (${releaseBefore} → ${releaseAfter})`);

    const rows = await piAudit(h);
    assert.ok(rows.some((r: any) => r.event === 'updates-check' && r.ok === true), 'audit has updates-check');
  });

  test('4. code-server happy path: 202 → ok → live 4.99.0 (dpkg + supervisor revive)', async () => {
    assert.ok(tempAdmin);
    const h = tempAdmin!.headers;

    const r = await piPostApply(h, { component: 'code-server', accountPassword: tempAdmin!.password });
    assert.equal(r.status, 202, 'apply accepted as 202');
    assert.equal(r.body.ok, true, '202 body ok');
    assert.equal(r.body.component, 'code-server');

    const cs = await piPollComponent('code-server', 'ok', 180_000, h);
    assert.equal(cs.applyState, 'ok');
    assert.equal(cs.updateRunning, false);

    const live = await liveCodeServerVersion();
    assert.equal(live, HAPPY_VERSION, `live binary is 4.99.0 (got ${live})`);

    const state = await readCodeServerState();
    assert.equal(state.applyState, 'ok');
    assert.equal(state.currentVersion, BASELINE_VERSION, 'state records the pre-update current');
    assert.equal(state.targetVersion, HAPPY_VERSION);

    const rows = await piAudit(h);
    assert.ok(rows.some((r2: any) => r2.event === 'code-server-update' && r2.ok === true), 'audit code-server-update');

    const after = await piMockStats();
    assert.equal(after.counters.deb[debName(HAPPY_VERSION)] ?? 0, 1, 'release asset fetched once');
    assert.equal(after.counters.download[debName(BASELINE_VERSION)] ?? 0, 1, 'baseline downloaded once');
  });

  test('5. real boot-failure rollback: broken 4.99.1 → failed + rolled back to 4.99.0', async () => {
    assert.ok(tempAdmin);
    const h = tempAdmin!.headers;
    await piWaitCsSettled(240_000, 'before test 5');
    const prev = await piReadCsState();
    await mockControl({ codeServer: BROKEN_VERSION });

    const r = await piPostApply(h, { component: 'code-server', accountPassword: tempAdmin!.password });
    assert.equal(r.status, 202);
    assert.equal(r.body.ok, true);
    await piWaitCsStarted(prev?.startedAt, 15_000); // the new run must actually begin

    const cs = await piPollComponent('code-server', 'failed', 240_000, h);
    assert.equal(cs.applyState, 'failed');
    assert.equal(cs.updateRunning, false);

    // rolledBack lives in the state file (authoritative) AND on the status
    // surface now — assert both.
    const state = await piWaitCsState(
      (s: any) => s.applyState === 'failed' && s.rolledBack === true && s.targetVersion === BROKEN_VERSION,
      30_000,
      'failed + rolledBack for 4.99.1',
    );
    assert.equal(state.currentVersion, HAPPY_VERSION, 'state records the pre-update current (4.99.0)');
    assert.equal(typeof state.error, 'string', 'state file records the failure reason');
    assert.match(String(state.error), /failed to boot.*rolled back to/i, `state error names the rollback (${state.error})`);

    const live = await liveCodeServerVersion();
    assert.equal(live, HAPPY_VERSION, `survives on 4.99.0 (got ${live})`);

    // the status surface exposes the same facts (regression guard for the
    // rolledBack/error surfacing fix)
    const surf = await piGet(h);
    const surfCs = byId(surf, 'code-server');
    assert.equal(surfCs.rolledBack, true, 'status surface carries rolledBack');
    assert.match(String(surfCs.error ?? ''), /failed to boot.*rolled back to/i, `status surface carries the failure reason (${JSON.stringify(surfCs.error)})`);
    assert.equal(await piLogContains(`rolled back to ${HAPPY_VERSION}`), true, 'update log names the rollback target');

    const rows = await piAudit(h);
    assert.ok(rows.some((r2: any) => r2.event === 'code-server-update-rollback'), 'audit code-server-update-rollback');
    assert.ok(rows.filter((r2: any) => r2.event === 'code-server-update-failed').length >= 1, 'audit code-server-update-failed');

    const stats = await piMockStats();
    assert.equal(stats.counters.deb[debName(BROKEN_VERSION)] ?? 0, 1, 'broken release fetched once');
    assert.equal(stats.counters.download[debName(HAPPY_VERSION)] ?? 0, 1, 'rollback baseline (4.99.0) downloaded once');
  });

  test('6. synchronous downgrade gate: 4.95.0 → immediate 400, state untouched, zero downloads',
    async () => {
      assert.ok(tempAdmin);
      const h = tempAdmin!.headers;
      await piWaitCsSettled(240_000, 'before test 6');
      const prev = await piReadCsState();
      await mockControl({ codeServer: DOWNGRADE_VERSION });

      // The router now runs a synchronous downgrade gate (fresh registry read,
      // before beginApply/202; skipped only while an update is already in
      // flight — nothing is running here): latest 4.95.0 <= installed 4.99.0
      // → plain 400.
      const r = await piPostApply(h, { component: 'code-server', accountPassword: tempAdmin!.password });
      assert.equal(r.status, 400, `synchronous downgrade gate rejects with 400, got ${r.status}`);
      assert.equal(r.body.ok, undefined, 'rejected apply has no 202 body');
      assert.match(String(r.body.error ?? ''), /up to date|cannot downgrade|no downgrades/i,
        `400 body names the downgrade (${JSON.stringify(r.body)})`);

      // the gate must NOT start a run — the state file stays exactly as it was
      // (previous run's terminal state, same startedAt)
      const state = await piReadCsState();
      assert.equal(state.startedAt, prev?.startedAt, 'state file untouched by the rejected apply');
      assert.equal(state.applyState, prev?.applyState, 'applyState unchanged');

      const live = await liveCodeServerVersion();
      assert.equal(live, HAPPY_VERSION, 'version untouched');

      const stats = await piMockStats();
      assert.equal(stats.counters.deb[debName(DOWNGRADE_VERSION)] ?? 0, 0, 'no release asset fetch for 4.95.0');
      assert.equal(stats.counters.download[debName(DOWNGRADE_VERSION)] ?? 0, 0, 'no download for 4.95.0');
    });

  test('7. single-flight: a second apply while one is running → 409', async () => {
    assert.ok(tempAdmin);
    const h = tempAdmin!.headers;
    await piWaitCsSettled(240_000, 'before test 7');
    const prev = await piReadCsState();
    await mockControl({ codeServer: BROKEN_VERSION }); // broken → long-running until boot-verify fails

    const first = await piPostApply(h, { component: 'code-server', accountPassword: tempAdmin!.password });
    assert.equal(first.status, 202);
    assert.equal(first.body.ok, true);
    await piWaitCsStarted(prev?.startedAt, 15_000); // first run confirmed in flight

    // expected to be rejected immediately (no waits involved)
    const second = await piPostApply(h, { component: 'code-server', accountPassword: tempAdmin!.password });
    assert.equal(second.status, 409, `second concurrent apply 409, got ${second.status}`);
    assert.match(String(second.body.error ?? ''), /already running/i, `409 body (${JSON.stringify(second.body)})`);

    // the first run completes on its own terms (broken → failed + rollback);
    // assert the rollback on the state file and the surfaced rolledBack flag
    const state = await piWaitCsState(
      (s: any) => s.applyState === 'failed' && s.rolledBack === true && s.targetVersion === BROKEN_VERSION,
      240_000,
      'first run failed with rolledBack for 4.99.1',
    );
    assert.equal(typeof state.error, 'string', 'state file carries the failure reason');

    const live = await liveCodeServerVersion();
    assert.equal(live, HAPPY_VERSION, 'finished on 4.99.0 again');
  });

  test('8. opencode npm status: channelUnlocked true/false and upToDate', async () => {
    assert.ok(tempAdmin);
    const h = tempAdmin!.headers;

    // /api/updates caches the npm registry response for 60s; every mock shift
    // below is preceded by a manual check (POST /updates/check) which clears
    // the cache server-side so the next status read reflects the NEW registry
    // state — otherwise a warm cache would freeze `latest` across the asserts.
    await mockControl({ npm: installedOpencode }); // == installed
    await piPostCheck(h);
    let j = await piGet(h);
    let oc = j.components.find((c: any) => c.id === 'opencode');
    assert.equal(oc.latest, installedOpencode);
    assert.equal(oc.upToDate, true);
    assert.equal(oc.channelUnlocked, true, 'major 1 supported');
    assert.equal(j.components.find((c: any) => c.id === 'code-server').channelUnlocked, true);

    await mockControl({ npm: '99.1.0' }); // major 99 outside SUPPORTED_MAJORS
    await piPostCheck(h);
    j = await piGet(h);
    oc = j.components.find((c: any) => c.id === 'opencode');
    assert.equal(oc.latest, '99.1.0');
    assert.equal(oc.upToDate, false, `${installedOpencode} != 99.1.0`);
    assert.equal(oc.channelUnlocked, false, 'major 99 blocked');

    const stats = await fetch(`http://127.0.0.1:${mock.port}/mock/stats`).then((x) => x.json()) as any;
    assert.ok(stats.counters.npm >= 2, `npm registry consulted (${stats.counters.npm})`);
  });

  test('9. rate budgets under WSD_TESTING=1: 7-check burst all 200, no 429 anywhere', async () => {
    assert.ok(tempAdmin);
    const h = tempAdmin!.headers;

    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) statuses.push(await piPostCheck(h));
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 200], 'burst of 7 manual checks all 200');

    assert.ok(applyPosts.length >= 3, 'applyPosts was collected');
    assert.ok(!applyPosts.some((s) => s === 429), 'no apply hit 429');
    assert.ok(!checkPosts.some((s) => s === 429), 'no check hit 429');

    const j = await piGet(h);
    for (const c of j.components) {
      assert.equal(c.updateRunning, false, `${c.id} not mid-run at the end`);
    }
  });

  after(async () => {
    const results: string[] = [];
    const tryStep = async (name: string, fn: () => Promise<void>) => {
      try { await fn(); results.push(`${name}: ok`); }
      catch (err: any) { results.push(`${name}: FAILED — ${err?.message ?? err}`); console.error(`after(): ${name} failed:`, err); }
    };

    await tryStep('restore code-server fs + revive original', async () => {
      if (!fsBackup) throw new Error('no fs backup');
      await restoreCodeServer(fsBackup);
      const v = await waitForCodeServerVersion(90_000);
      if (!v.startsWith('4.96.')) throw new Error(`restored binary is ${v}, expected 4.96.x`);
    });

    await tryStep('recreate container with default env', async () => {
      await composeUp(RESTORE_ENV, false);
      await pollHealth(240_000);
    });

    await tryStep('clear updates state', clearUpdatesState);

    await tryStep('wait for embedded IDE on host port', async () => {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        if (await tcpProbeHost(8100, 1500)) return;
        await sleep(2000);
      }
      throw new Error('IDE not answering on host 8100 after restore');
    });

    await tryStep('delete temp admin account', async () => {
      if (!tempAdmin) throw new Error('no temp admin');
      const r = await req('DELETE', `/users/${tempAdmin.id}`, undefined, authHeaders());
      if (r.status !== 200) throw new Error(`DELETE /users/${tempAdmin.id} -> ${r.status}`);
    });

    await tryStep('final verification', async () => {
      const v = await liveCodeServerVersion();
      if (!v.startsWith('4.96.')) throw new Error(`final version ${v}, expected 4.96.x`);
      const r = await reqAuth('GET', '/updates');
      if (r.status !== 200) throw new Error(`final GET /updates -> ${r.status}`);
      console.log(`   → container final: code-server ${v}, GET /api/updates ${r.status}`);
    });

    if (mock.server) mock.server.close();
    fs.rmSync(hostTmp, { recursive: true, force: true });
    console.log(`cleanup summary: ${results.join(' | ')}`);
  });
});