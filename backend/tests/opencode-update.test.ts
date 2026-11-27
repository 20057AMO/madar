/**
 * opencode-update.test.ts — offline evidence for the runtime update gate.
 *
 * Drives the real wiring module with a stubbed registry (no Docker, no npm)
 * so a future change cannot silently reintroduce a major bypass or a
 * shell-interpolated install argv.
 */
import { test, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { register } from 'node:module';

register(new URL('./ts-ext-resolve.mjs', import.meta.url).href);

const api = await import('../src/services/opencode-api.ts');
const apiSource = fs.readFileSync(new URL('../src/services/opencode-api.ts', import.meta.url), 'utf8');
const studioSource = fs.readFileSync(new URL('../src/services/opencode-studio.ts', import.meta.url), 'utf8');
const bootSource = fs.readFileSync(new URL('../src/services/updates-boot.ts', import.meta.url), 'utf8');

const ENV_KEYS = ['WSD_UPDATE_OPENCODE_MAJOR', 'WSD_UPDATE_NPM_REGISTRY'] as const;
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;

function setEnv(key: (typeof ENV_KEYS)[number], value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function resetRegistry(): void {
  setEnv('WSD_UPDATE_NPM_REGISTRY', 'https://registry.npmjs.org');
  api.clearLatestVersionCache();
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function requestUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url;
}

after(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of savedEnv) setEnv(key, value);
  api.clearLatestVersionCache();
});

test('runtime major resolver defaults to 1 and accepts only positive integers', () => {
  setEnv('WSD_UPDATE_OPENCODE_MAJOR', undefined);
  assert.deepEqual(api.getSupportedOpencodeMajors(), [1]);

  setEnv('WSD_UPDATE_OPENCODE_MAJOR', '2');
  assert.deepEqual(api.getSupportedOpencodeMajors(), [2]);

  setEnv('WSD_UPDATE_OPENCODE_MAJOR', ' 3 ');
  assert.deepEqual(api.getSupportedOpencodeMajors(), [3]);

  for (const junk of ['', 'latest', '0', '-1', '1.9', '2,3', '999999999999999999999999']) {
    setEnv('WSD_UPDATE_OPENCODE_MAJOR', junk);
    assert.deepEqual(api.getSupportedOpencodeMajors(), [1], `junk value ${junk} must fall back`);
  }
});

test('Studio and boot consumers use the runtime major resolver', () => {
  for (const [name, source] of [['Studio', studioSource], ['boot', bootSource]]) {
    assert.match(source, /getSupportedOpencodeMajors/, `${name} must import the runtime resolver`);
    assert.doesNotMatch(source, /\bSUPPORTED_MAJORS\b/, `${name} must not use the static major list`);
    assert.match(source, /supportedMajors:\s*getSupportedOpencodeMajors\(\)/, `${name} must resolve majors at call time`);
  }
});

test('registry selection picks the highest exact release inside the configured major', async () => {
  resetRegistry();
  setEnv('WSD_UPDATE_OPENCODE_MAJOR', undefined);
  const calls: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = requestUrl(input);
    calls.push(url);
    if (url.endsWith('/opencode-ai')) {
      return jsonResponse({
        versions: {
          '1.8.0': {},
          '2.0.0': {},
          '1.9.0': {},
          '1.10.0-beta.1': {},
          '1.0.0; rm -rf /': {},
        },
      });
    }
    return jsonResponse({ version: '2.0.0' });
  }) as typeof fetch;

  const info = await api.fetchLatestVersion(true);
  assert.deepEqual(info, { latest: '1.9.0', latestMajor: 1, channelUnlocked: true });
  assert.equal(calls.some((url) => url.endsWith('/opencode-ai')), true);
  assert.equal(calls.some((url) => url.endsWith('/opencode-ai/latest')), false);
});

test('configuring major 2 unlocks the matching packument release', async () => {
  resetRegistry();
  setEnv('WSD_UPDATE_OPENCODE_MAJOR', '2');
  globalThis.fetch = (async () => jsonResponse({ versions: { '2.0.0': {}, '2.1.0': {}, '1.9.0': {} } })) as typeof fetch;

  const info = await api.fetchLatestVersion(true);
  assert.deepEqual(info, { latest: '2.1.0', latestMajor: 2, channelUnlocked: true });
});

test('malicious and non-exact versions are rejected before install', async () => {
  resetRegistry();
  setEnv('WSD_UPDATE_OPENCODE_MAJOR', '1');

  const injected = await api.installOpencodeVersion('1.0.0; rm -rf /');
  assert.equal(injected.ok, false);
  assert.equal(injected.error, 'Invalid target version: 1.0.0; rm -rf /');
  assert.equal(api.isUpdateRunning(), false);

  const prerelease = await api.installOpencodeVersion('1.2.3-beta.1');
  assert.equal(prerelease.ok, false);
  assert.equal(prerelease.error, 'Invalid target version: 1.2.3-beta.1');

  const rollback = await api.rollbackOpencodeTo('1.0.0 || 2.0.0');
  assert.equal(rollback.ok, false);
  assert.equal(rollback.error, 'Invalid rollback version: 1.0.0 || 2.0.0');

  globalThis.fetch = (async (input: unknown) => {
    if (requestUrl(input).endsWith('/opencode-ai')) return new Response('not found', { status: 404 });
    return jsonResponse({ version: '1.0.0; rm -rf /' });
  }) as typeof fetch;
  const registry = await api.fetchLatestVersion(true);
  assert.deepEqual(registry, { latest: null, latestMajor: null, channelUnlocked: false });
});

test('argv-only npm and rollback/boot verification wiring stay intact', () => {
  assert.match(apiSource, /\['install', '-g', `opencode-ai@\$\{exact\}`, '--no-fund', '--no-audit'\]/);
  assert.doesNotMatch(apiSource, /shell:\s*true/);
  assert.match(apiSource, /execFile\(\s*'npm',/);
  assert.match(apiSource, /waitForOpencodeBoot\(exact, pidBefore\)/);
  assert.match(apiSource, /export function rollbackOpencodeTo/);
  assert.match(apiSource, /return installOpencodeVersion\(currentVersion\)/);
  assert.match(apiSource, /probeOpencodeVersion\(true\)/);
});
