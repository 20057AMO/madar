/**
 * code-server-update-core.test.ts — offline evidence for fail-closed SHA-256
 * verification and strict WSD_UPDATE_* endpoint configuration.
 *
 * Drives the real wiring module with stubbed fetch/hooks: no Docker, no dpkg,
 * no network. The injected ApplyHooks seam exists so the preflight/download/
 * install ordering can be asserted without touching a running IDE.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';

register(new URL('./ts-ext-resolve.mjs', import.meta.url).href);

const ENV_KEYS = [
  'WSD_TESTING',
  'WSD_DATA_DIR',
  'WSD_UPDATE_GITHUB_BASE',
  'WSD_UPDATE_DOWNLOAD_BASE',
  'WSD_UPDATE_NPM_REGISTRY',
  'WSD_UPDATES_MAX_BYTES',
  'WSD_UPDATE_BOOT_TIMEOUT_MS',
] as const;

type EnvKey = (typeof ENV_KEYS)[number];

const savedEnv = new Map<EnvKey, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'madar-code-server-update-'));

function setEnv(key: EnvKey, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

// Configure BEFORE the dynamic import: the wiring module validates its update
// bases at module load and would otherwise emit warnings from a stale env.
setEnv('WSD_TESTING', '1');
setEnv('WSD_DATA_DIR', tempDir);
setEnv('WSD_UPDATE_GITHUB_BASE', 'https://api.github.com');
setEnv('WSD_UPDATE_DOWNLOAD_BASE', 'https://github.com/coder/code-server/releases');
setEnv('WSD_UPDATE_NPM_REGISTRY', 'https://registry.npmjs.org');
setEnv('WSD_UPDATES_MAX_BYTES', undefined);
setEnv('WSD_UPDATE_BOOT_TIMEOUT_MS', undefined);

const mod = await import('../src/services/code-server-update.ts');
const core = await import('../src/services/updates-core.ts');

const DEB_ARCH = process.arch === 'arm64' ? 'arm64' : 'amd64';
const VERSION = '4.97.0';
const DEB_NAME = `code-server_${VERSION}_${DEB_ARCH}.deb`;
const DEB_URL = `https://github.com/coder/code-server/releases/download/v${VERSION}/${DEB_NAME}`;
const FULL_DIGEST = `sha256:${'c'.repeat(64)}`;

interface DownloadCall {
  url: string;
  dest: string;
  expectedSha: string | null;
  bytesCap: number;
  opts?: { allowStructuralFallback?: boolean };
}

function requestUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url;
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function withFetch<T>(handler: (input: unknown) => Response | Promise<Response>, fn: () => Promise<T>): Promise<T> {
  const saved = globalThis.fetch;
  globalThis.fetch = handler as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = saved;
  }
}

function makeRelease(digest: string | null) {
  return {
    version: VERSION,
    debUrl: DEB_URL,
    digest,
    debSizeBytes: 2048,
  };
}

function makeHooks(overrides: Partial<Parameters<typeof mod.applyCodeServerUpdate>[0]> = {}) {
  const calls = {
    downloads: [] as DownloadCall[],
    installs: [] as string[],
    hardens: 0,
    restarts: 0,
    boots: [] as string[],
    caches: [] as string[],
  };
  const hooks = {
    probeCurrentVersion: async () => '4.96.4',
    fetchLatestRelease: async () => makeRelease(FULL_DIGEST.toUpperCase().replace('sha256:', 'sha256:')),
    isCachedDebValid: async () => true,
    downloadDeb: async (url: string, dest: string, expectedSha: string | null, bytesCap: number, opts?: { allowStructuralFallback?: boolean }) => {
      calls.downloads.push({ url, dest, expectedSha, bytesCap, opts });
    },
    installDeb: async (debPath: string) => {
      calls.installs.push(debPath);
    },
    hardenIdeInstall: async () => {
      calls.hardens += 1;
      return { ok: true };
    },
    restartCodeServer: async () => {
      calls.restarts += 1;
      return { ok: true, oldPid: 123 };
    },
    waitForBoot: async (targetVersion: string) => {
      calls.boots.push(targetVersion);
      return true;
    },
    cacheInstalledDeb: (version: string) => {
      calls.caches.push(version);
    },
    getCodeServerUpdateState: () => ({ applyState: 'idle' as const }),
    persistCodeServerState: async () => undefined,
    log: () => undefined,
    freeSpace: () => null,
    ...overrides,
  };
  return { hooks, calls };
}

after(() => {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
  core.resetUpdateBaseWarningsForTests();
  mod.clearCaches();
  for (const [key, value] of savedEnv) setEnv(key, value);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('release parsing normalizes only a complete SHA-256 digest', () => {
  assert.equal(core.normalizeReleaseDigest(`sha256:${'A'.repeat(64)}`), `sha256:${'a'.repeat(64)}`);
  for (const junk of [null, undefined, '', 'sha256:abc', 'abc'.repeat(64), `sha256:${'z'.repeat(64)}`, `sha256:${'a'.repeat(65)}`]) {
    assert.equal(core.normalizeReleaseDigest(junk), null, `${String(junk)} must not be treated as a digest`);
  }
});

test('fetchLatestRelease carries a normalized digest into the downloader', async () => {
  const digestHex = 'b'.repeat(64);
  mod.clearCaches();
  await withFetch(async () => jsonResponse({
    tag_name: `v${VERSION}`,
    assets: [{
      name: DEB_NAME,
      browser_download_url: DEB_URL,
      digest: `sha256:${digestHex.toUpperCase()}`,
      size: 2048,
    }],
  }), async () => {
    const release = await mod.fetchLatestRelease(true);
    assert.equal(release?.version, VERSION);
    assert.equal(release?.digest, `sha256:${digestHex}`);
    assert.equal(release?.debSizeBytes, 2048);
  });
});

test('missing or malformed release digest aborts before download or install', async () => {
  for (const digest of [null, 'sha256:abc', `sha256:${'z'.repeat(64)}`]) {
    const { hooks, calls } = makeHooks({
      fetchLatestRelease: async () => makeRelease(digest),
    });
    const result = await mod.applyCodeServerUpdate(hooks);
    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /complete SHA-256 digest/);
    assert.equal(calls.downloads.length, 0, `${String(digest)} must not reach the downloader`);
    assert.equal(calls.installs.length, 0);
    assert.equal(calls.hardens, 0);
    assert.equal(calls.restarts, 0);
  }
});

test('digest mismatch aborts and removes the partial download', async () => {
  const dest = path.join(tempDir, 'mismatch.deb');
  let fetchCalls = 0;
  await withFetch(async () => {
    fetchCalls += 1;
    return new Response('corrupted payload', { status: 200 });
  }, async () => {
    await assert.rejects(
      () => mod.downloadDeb(DEB_URL, dest, `sha256:${'0'.repeat(64)}`, 1024),
      /SHA-256 checksum mismatch — download rejected/,
    );
  });
  assert.equal(fetchCalls, 1);
  assert.equal(fs.existsSync(dest), false);
});

test('complete matching digest streams the deb to disk', async () => {
  const dest = path.join(tempDir, 'valid.deb');
  const payload = Buffer.from('a valid deb payload');
  const digest = `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}`;
  await withFetch(async () => new Response(payload, { status: 200 }), async () => {
    await mod.downloadDeb(DEB_URL, dest, digest, 1024);
  });
  assert.equal(fs.readFileSync(dest).equals(payload), true);
});

test('complete digest proceeds through download and dpkg install', async () => {
  const { hooks, calls } = makeHooks({
    fetchLatestRelease: async () => makeRelease(`sha256:${'C'.repeat(64)}`),
  });
  const result = await mod.applyCodeServerUpdate(hooks);
  assert.deepEqual(result, { ok: true, updatedTo: VERSION, restarted: true });
  assert.equal(calls.downloads.length, 1);
  assert.equal(calls.downloads[0].expectedSha, FULL_DIGEST);
  assert.equal(calls.downloads[0].opts, undefined, 'release downloads must not use the structural fallback');
  assert.equal(calls.installs.length, 1);
  assert.match(calls.installs[0], new RegExp(`${DEB_NAME}$`));
  assert.equal(calls.hardens, 1);
  assert.equal(calls.restarts, 1);
  assert.deepEqual(calls.boots, [VERSION]);
  assert.deepEqual(calls.caches, [VERSION]);
});

test('download size cap remains enforced before digest acceptance', async () => {
  const dest = path.join(tempDir, 'capped.deb');
  const payload = Buffer.alloc(4096, 7);
  const digest = `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}`;
  await withFetch(async () => new Response(payload, { status: 200 }), async () => {
    await assert.rejects(
      () => mod.downloadDeb(DEB_URL, dest, digest, 64),
      /Download exceeds the size cap/,
    );
  });
  assert.equal(fs.existsSync(dest), false);
});

test('structural fallback remains limited to pinned baseline downloads', async () => {
  const source = fs.readFileSync(new URL('../src/services/code-server-update.ts', import.meta.url), 'utf8');
  assert.equal(source.match(/allowStructuralFallback: true/g)?.length, 2);
  assert.doesNotMatch(source, /shell:\s*true/);
  assert.doesNotMatch(source, /\bexec\(/);
  assert.match(source, /execFile\(/);

  const dest = path.join(tempDir, 'no-digest.deb');
  let fetchCalls = 0;
  await withFetch(async () => {
    fetchCalls += 1;
    return new Response('payload', { status: 200 });
  }, async () => {
    await assert.rejects(
      () => mod.downloadDeb(DEB_URL, dest, null, 1024),
      /A complete SHA-256 digest is required before downloading/,
    );
  });
  assert.equal(fetchCalls, 0);
  assert.equal(fs.existsSync(dest), false);
});

test('WSD_UPDATE_* env bases require explicit https and confine plaintext http to testing loopback', () => {
  for (const [envName, defaultValue] of Object.entries(core.DEFAULT_UPDATE_BASES)) {
    assert.equal(core.assertAllowedUpdateEnvBase(defaultValue, envName, false), defaultValue);
    assert.throws(
      () => core.assertAllowedUpdateEnvBase(new URL(defaultValue).host, envName, false),
      /explicit https:\/\/ scheme/,
      `${envName} must not accept a bare host`,
    );
    assert.throws(
      () => core.assertAllowedUpdateEnvBase('http://mirror.example.test', envName, true),
      /may use http only for localhost\/loopback/,
      `${envName} must not downgrade a remote mirror to http`,
    );
    assert.throws(
      () => core.assertAllowedUpdateEnvBase('http://localhost:8080', envName, false),
      /must use https/,
      `${envName} must refuse loopback http outside WSD_TESTING=1`,
    );
    assert.equal(core.assertAllowedUpdateEnvBase('http://localhost:8080', envName, true), 'http://localhost:8080');
    assert.equal(core.assertAllowedUpdateEnvBase('http://127.0.0.1:8080', envName, true), 'http://127.0.0.1:8080');
    assert.equal(core.assertAllowedUpdateEnvBase('http://[::1]:8080', envName, true), 'http://[::1]:8080');
    assert.equal(core.assertAllowedUpdateEnvBase('http://host.docker.internal:8080', envName, true), 'http://host.docker.internal:8080');
  }
});

test('githubBase and downloadBase apply strict validation to their env values', () => {
  setEnv('WSD_UPDATE_GITHUB_BASE', 'api.github.com');
  assert.throws(() => mod.githubBase(), /explicit https:\/\/ scheme/);
  setEnv('WSD_UPDATE_GITHUB_BASE', 'http://mirror.example.test');
  assert.throws(() => mod.githubBase(), /may use http only for localhost\/loopback/);

  setEnv('WSD_UPDATE_DOWNLOAD_BASE', 'github.com/coder/code-server/releases');
  assert.throws(() => mod.downloadBase(), /explicit https:\/\/ scheme/);
  setEnv('WSD_UPDATE_DOWNLOAD_BASE', 'http://169.254.169.254/latest');
  assert.throws(() => mod.downloadBase(), /cannot point at this host/);

  setEnv('WSD_UPDATE_GITHUB_BASE', 'https://api.github.com');
  setEnv('WSD_UPDATE_DOWNLOAD_BASE', 'https://github.com/coder/code-server/releases');
});

test('custom update endpoints warn once without echoing the URL', () => {
  core.resetUpdateBaseWarningsForTests();
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(' '));
  };
  try {
    const custom = 'https://mirror.example.test/secret?token=abc123';
    core.assertAllowedUpdateEnvBase(custom, 'WSD_UPDATE_GITHUB_BASE', false);
    core.assertAllowedUpdateEnvBase(custom, 'WSD_UPDATE_GITHUB_BASE', false);
    core.assertAllowedUpdateEnvBase('https://api.github.com', 'WSD_UPDATE_GITHUB_BASE', false);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /WSD_UPDATE_GITHUB_BASE differs from its default/);
  assert.doesNotMatch(warnings[0], /mirror\.example\.test|token=abc123|secret/);
});
