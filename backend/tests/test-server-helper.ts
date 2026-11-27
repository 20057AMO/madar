import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface TestServer {
  apiUrl: string;
  wsUrl: string;
  port: number;
  dataDir: string;
  stop(): Promise<void>;
}

const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANAGED_ENV_KEYS = [
  'PORT',
  'HOST',
  'JWT_SECRET',
  'WSD_SETUP_TOKEN',
  'WSD_TEST_SETUP_TOKEN',
  'WSD_TEST_API_URL',
  'WSD_TEST_WS_URL',
  'WSD_TESTING',
  'WSD_DATA_DIR',
  'WSD_PROJECTS_DIR',
  'WSD_EMBED_PROXY_PORT',
];

function snapshotEnv(): Map<string, string | undefined> {
  return new Map(MANAGED_ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(saved: Map<string, string | undefined>): void {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function allocatePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, host, () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        probe.close(() => reject(new Error('Could not allocate a test server port')));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.off('exit', finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    child.once('exit', finish);
  });
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    try {
      if (child.pid) execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 });
    } catch {
      try { child.kill('SIGKILL'); } catch {}
    }
  } else {
    try { if (child.pid) process.kill(-child.pid, 'SIGTERM'); } catch {}
    await waitForExit(child, 3000);
    try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
  await waitForExit(child, 5000);
}

function tail(buffer: { value: string }, chunk: Buffer): void {
  buffer.value = (buffer.value + chunk.toString('utf8')).slice(-12000);
}

export async function startTestServer(): Promise<TestServer> {
  const savedEnv = snapshotEnv();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wsd-test-server-'));
  const dataDir = path.join(tempRoot, 'data');
  const workspacesDir = path.join(tempRoot, 'workspaces');
  const compiledDir = path.join(tempRoot, 'compiled');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workspacesDir, { recursive: true });

  let child: ChildProcess | undefined;
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (child) await terminate(child);
    restoreEnv(savedEnv);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  };

  try {
    const tsc = path.join(BACKEND_DIR, 'node_modules', 'typescript', 'bin', 'tsc');
    execFileSync(process.execPath, [tsc, '--project', path.join(BACKEND_DIR, 'tsconfig.json'), '--outDir', compiledDir], {
      cwd: BACKEND_DIR,
      encoding: 'utf8',
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const port = await allocatePort('127.0.0.1');
    let embedPort = await allocatePort('127.0.0.1');
    while (embedPort === port) embedPort = await allocatePort('127.0.0.1');

    const apiUrl = `http://127.0.0.1:${port}/api`;
    const wsUrl = `ws://127.0.0.1:${port}/api`;
    const secret = `test-server-${crypto.randomBytes(32).toString('hex')}`;
    const setupToken = crypto.randomBytes(32).toString('hex');

    process.env.PORT = String(port);
    process.env.HOST = '127.0.0.1';
    process.env.JWT_SECRET = secret;
    process.env.WSD_SETUP_TOKEN = setupToken;
    process.env.WSD_TEST_SETUP_TOKEN = setupToken;
    process.env.WSD_TEST_API_URL = apiUrl;
    process.env.WSD_TEST_WS_URL = wsUrl;
    process.env.WSD_TESTING = '1';
    process.env.WSD_DATA_DIR = dataDir;
    process.env.WSD_PROJECTS_DIR = workspacesDir;
    process.env.WSD_EMBED_PROXY_PORT = String(embedPort);

    const logs = { value: '' };
    let spawnError: Error | undefined;
    child = spawn(process.execPath, [path.join(compiledDir, 'index.js')], {
      cwd: BACKEND_DIR,
      env: { ...process.env, NODE_PATH: path.join(BACKEND_DIR, 'node_modules') },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    child.once('error', (error) => { spawnError = error; });
    child.stdout?.on('data', (chunk: Buffer) => tail(logs, chunk));
    child.stderr?.on('data', (chunk: Buffer) => tail(logs, chunk));

    const deadline = Date.now() + 45_000;
    let lastError = 'no health response';
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`Test server exited before becoming healthy (code=${child.exitCode}, signal=${child.signalCode})\n${logs.value}`);
      }
      try {
        const res = await fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(1500) });
        if (res.ok) {
          const data = await res.json() as { status?: string };
          if (data?.status === 'ok') {
            return { apiUrl, wsUrl, port, dataDir, stop };
          }
          lastError = `unexpected health payload: ${JSON.stringify(data)}`;
        } else {
          lastError = `health returned ${res.status}`;
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Test server did not become healthy within 45s: ${lastError}\n${logs.value}`);
  } catch (error) {
    await stop();
    throw error;
  }
}
