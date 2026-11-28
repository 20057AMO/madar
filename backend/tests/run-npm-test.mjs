/**
 * run-npm-test.mjs
 * Madar — isolated test harness for `npm test`. Owns ONE server child on an
 * OS-assigned port, exports the env contract to `node --test`, then tears the
 * child and its temp dirs down in `finally`. No pre-running server on :3000.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(BACKEND_DIR, '..');
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
  'OPENCODE_CONFIG_DIR',
  'WSD_TEST_DOCKER',
  'WSD_TEST_DOCKER_HEAVY',
];
const OPENCODE_FIXTURES = [
  ['opencode/agents', 'agents'],
  ['opencode/skills', 'skills'],
  ['opencode/command', 'command'],
  ['opencode.json', 'opencode.json'],
];
const PORT_LINE = /\[Madar\] TEST_API_PORT=(\d+)/;
const START_TIMEOUT_MS = 45_000;
const HEALTH_TIMEOUT_MS = 1_500;
const POLL_INTERVAL_MS = 100;
const TSC_TIMEOUT_MS = 120_000;
const MAX_START_ATTEMPTS = 3;

function snapshotEnv() {
  return new Map(MANAGED_ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(saved) {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dockerFlag(key) {
  return process.env[key] === '1' ? '1' : '0';
}

function seedOpencodeConfig(configDir) {
  fs.mkdirSync(configDir, { recursive: true });
  for (const [relativeSource, relativeTarget] of OPENCODE_FIXTURES) {
    const source = path.join(REPO_ROOT, relativeSource);
    if (!fs.existsSync(source)) {
      throw new Error(`Opencode Studio fixture is missing: ${source}`);
    }
    const target = path.join(configDir, relativeTarget);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true });
  }
}

function tail(state, chunk) {
  state.value = (state.value + chunk.toString('utf8')).slice(-12_000);
}

function parseAnnouncedPort(text) {
  const match = PORT_LINE.exec(text);
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function allocatePort(host) {
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

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
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

async function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    try {
      if (child.pid) execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 });
    } catch {
      try { child.kill('SIGKILL'); } catch {}
    }
  } else {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGTERM');
      else child.kill('SIGTERM');
    } catch {
      try { child.kill('SIGTERM'); } catch {}
    }
    await waitForExit(child, 3000);
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {
      try { child.kill('SIGKILL'); } catch {}
    }
  }
  await waitForExit(child, 5000);
}

function compileServer(outDir) {
  const tsc = path.join(BACKEND_DIR, 'node_modules', 'typescript', 'bin', 'tsc');
  try {
    execFileSync(process.execPath, [tsc, '--project', path.join(BACKEND_DIR, 'tsconfig.json'), '--outDir', outDir], {
      cwd: BACKEND_DIR,
      encoding: 'utf8',
      timeout: TSC_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const details = error?.stderr?.toString?.() || error?.stdout?.toString?.() || error?.message || String(error);
    throw new Error(`Could not compile the server for isolated tests:\n${details}`);
  }
}

function spawnServer(compiledEntry) {
  return spawn(process.execPath, [compiledEntry], {
    cwd: BACKEND_DIR,
    env: { ...process.env, NODE_PATH: path.join(BACKEND_DIR, 'node_modules') },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
}

async function waitForStartup(child, logs) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastError = 'no TEST_API_PORT line yet';
  while (Date.now() < deadline) {
    if (logs.spawnError) throw logs.spawnError;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Test server exited before becoming healthy (code=${child.exitCode}, signal=${child.signalCode})\n${logs.value}`);
    }
    const port = parseAnnouncedPort(logs.value);
    if (port !== null) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
        if (res.ok) {
          const body = await res.json();
          if (body?.status === 'ok') return port;
          lastError = `unexpected health payload: ${JSON.stringify(body)}`;
        } else {
          lastError = `health returned ${res.status}`;
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`Test server did not become healthy within ${START_TIMEOUT_MS / 1000}s: ${lastError}\n${logs.value}`);
}

function parseRunnerArgs(argv) {
  const separator = argv.indexOf('--');
  return separator === -1 ? argv : argv.slice(separator + 1);
}

async function main() {
  const savedEnv = snapshotEnv();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'madar-npm-test-'));
  const dataDir = path.join(tempRoot, 'data');
  const workspacesDir = path.join(tempRoot, 'workspaces');
  const compiledDir = path.join(tempRoot, 'compiled');
  const opencodeConfigDir = path.join(tempRoot, 'opencode-config');

  let serverChild;
  let runnerChild;
  let cleanupPromise;
  const performCleanup = async () => {
    if (runnerChild) {
      await terminate(runnerChild);
      runnerChild = undefined;
    }
    if (serverChild) {
      await terminate(serverChild);
      serverChild = undefined;
    }
    restoreEnv(savedEnv);
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch (error) {
      console.warn(`[Madar] could not remove isolated test dir ${tempRoot}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const cleanup = () => {
    if (!cleanupPromise) cleanupPromise = performCleanup();
    return cleanupPromise;
  };
  const onSignal = (signal) => {
    void (async () => {
      await cleanup();
      process.exit(signal === 'SIGINT' ? 130 : 143);
    })();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(workspacesDir, { recursive: true });
    fs.mkdirSync(compiledDir, { recursive: true });
    seedOpencodeConfig(opencodeConfigDir);
    compileServer(compiledDir);

    const compiledEntry = path.join(compiledDir, 'index.js');
    const setupToken = crypto.randomBytes(32).toString('hex');
    let embedPort = await allocatePort('127.0.0.1');
    Object.assign(process.env, {
      PORT: '0',
      HOST: '127.0.0.1',
      JWT_SECRET: crypto.randomBytes(32).toString('hex'),
      WSD_SETUP_TOKEN: setupToken,
      WSD_TEST_SETUP_TOKEN: setupToken,
      WSD_TESTING: '1',
      WSD_DATA_DIR: dataDir,
      WSD_PROJECTS_DIR: workspacesDir,
      WSD_EMBED_PROXY_PORT: String(embedPort),
      OPENCODE_CONFIG_DIR: opencodeConfigDir,
      WSD_TEST_DOCKER: dockerFlag('WSD_TEST_DOCKER'),
      WSD_TEST_DOCKER_HEAVY: dockerFlag('WSD_TEST_DOCKER_HEAVY'),
    });

    let apiPort = 0;
    for (let attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt += 1) {
      const logs = { value: '', spawnError: undefined };
      serverChild = spawnServer(compiledEntry);
      serverChild.once('error', (error) => { logs.spawnError = error; });
      serverChild.stdout?.on('data', (chunk) => tail(logs, chunk));
      serverChild.stderr?.on('data', (chunk) => tail(logs, chunk));
      apiPort = await waitForStartup(serverChild, logs);
      if (apiPort !== embedPort) break;
      await terminate(serverChild);
      serverChild = undefined;
      if (attempt === MAX_START_ATTEMPTS) {
        throw new Error('The API port kept colliding with the embed proxy port; refusing to conflate them');
      }
      embedPort = await allocatePort('127.0.0.1');
      process.env.WSD_EMBED_PROXY_PORT = String(embedPort);
    }

    process.env.WSD_TEST_API_URL = `http://127.0.0.1:${apiPort}/api`;
    process.env.WSD_TEST_WS_URL = `ws://127.0.0.1:${apiPort}`;
    console.log(`[Madar] TEST_API_PORT=${apiPort}`);
    if (process.env.WSD_TEST_HARNESS_DEBUG === '1') {
      console.log(`[Madar] test env: ${JSON.stringify({
        WSD_TEST_API_URL: process.env.WSD_TEST_API_URL,
        WSD_TEST_WS_URL: process.env.WSD_TEST_WS_URL,
        WSD_TESTING: process.env.WSD_TESTING,
        PORT: process.env.PORT,
        HOST: process.env.HOST,
        WSD_EMBED_PROXY_PORT: process.env.WSD_EMBED_PROXY_PORT,
        OPENCODE_CONFIG_DIR: process.env.OPENCODE_CONFIG_DIR,
        WSD_TEST_DOCKER: process.env.WSD_TEST_DOCKER,
        WSD_TEST_DOCKER_HEAVY: process.env.WSD_TEST_DOCKER_HEAVY,
        WSD_DATA_DIR: process.env.WSD_DATA_DIR,
        WSD_PROJECTS_DIR: process.env.WSD_PROJECTS_DIR,
        JWT_SECRET_LENGTH: process.env.JWT_SECRET.length,
        setupTokenLength: process.env.WSD_TEST_SETUP_TOKEN.length,
      })}`);
    }

    const runnerArgs = parseRunnerArgs(process.argv.slice(2));
    const targets = runnerArgs.length > 0 ? runnerArgs : ['tests/**/*.test.ts'];
    runnerChild = spawn(process.execPath, ['--test', '--test-concurrency=1', ...targets], {
      cwd: BACKEND_DIR,
      env: { ...process.env },
      stdio: 'inherit',
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    const exitCode = await new Promise((resolve) => {
      let settled = false;
      const finish = (code) => {
        if (settled) return;
        settled = true;
        resolve(code);
      };
      runnerChild.once('error', (error) => {
        console.error(`[Madar] test runner failed to start: ${error instanceof Error ? error.message : String(error)}`);
        finish(1);
      });
      runnerChild.once('close', (code, signal) => finish(typeof code === 'number' ? code : signal ? 1 : 0));
    });
    process.exitCode = exitCode;
  } catch (error) {
    console.error(`[Madar] isolated test harness failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await cleanup();
  }
}

void main();
