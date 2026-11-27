import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';

register(new URL('./ts-ext-resolve.mjs', import.meta.url).href);

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsd-setup-token-'));
const hashFile = path.join(dataDir, 'setup.token.sha256');
const originalDataDir = process.env.WSD_DATA_DIR;
const originalSetupToken = process.env.WSD_SETUP_TOKEN;
const originalJwtSecret = process.env.JWT_SECRET;
process.env.WSD_DATA_DIR = dataDir;
process.env.JWT_SECRET = 'setup-token-suite-jwt-secret-0123456789';

const setupToken = await import('../src/services/setup-token.ts');
const userStore = await import('../src/services/user-store.ts');
const {
  initSetupToken,
  performSetup,
  verifySetupToken,
  setupTokenCandidates,
  hashSetupToken,
  resetSetupTokenState,
} = setupToken;

after(() => {
  if (originalDataDir === undefined) delete process.env.WSD_DATA_DIR;
  else process.env.WSD_DATA_DIR = originalDataDir;
  if (originalSetupToken === undefined) delete process.env.WSD_SETUP_TOKEN;
  else process.env.WSD_SETUP_TOKEN = originalSetupToken;
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = originalJwtSecret;
});

function readHash(): string {
  return fs.readFileSync(hashFile, 'utf8').trim();
}

function captureLogs(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try { fn(); } finally { console.log = original; }
  return lines;
}

delete process.env.WSD_SETUP_TOKEN;
const bootLogs = captureLogs(() => { initSetupToken(); });
const generatedToken = bootLogs
  .map((line) => line.match(/^Madar setup token: (.+)$/)?.[1])
  .find((value): value is string => !!value);

describe('setup token boot initialization', () => {
  test('a fresh install generates one token, prints it once, and persists only its hash', () => {
    assert.ok(generatedToken, 'the boot log must contain the generated token');
    assert.match(generatedToken, /^[a-f0-9]{64}$/);
    assert.strictEqual(readHash(), hashSetupToken(generatedToken));
    assert.ok(!readHash().includes(generatedToken));
    assert.strictEqual(bootLogs.filter((line) => line.startsWith('Madar setup token:')).length, 1);
    assert.ok(bootLogs.some((line) => line.includes('docker compose logs app')));
  });

  test('a restart reuses the persisted hash without printing a token again', () => {
    resetSetupTokenState();
    const logs = captureLogs(() => { initSetupToken(); });
    assert.strictEqual(logs.some((line) => line.startsWith('Madar setup token:')), false);
    assert.strictEqual(readHash(), hashSetupToken(generatedToken!));
    assert.strictEqual(verifySetupToken([generatedToken]), true);
  });

  test('a blank env value does not override the persisted hash', () => {
    process.env.WSD_SETUP_TOKEN = '   ';
    resetSetupTokenState();
    initSetupToken();
    assert.strictEqual(readHash(), hashSetupToken(generatedToken!));
    assert.strictEqual(verifySetupToken([generatedToken]), true);
  });

  test('a strong env token overrides the persisted hash and is never logged', () => {
    const envToken = 'setup-env-token-abcdefghijklmnopqrstuvwxyz';
    process.env.WSD_SETUP_TOKEN = envToken;
    resetSetupTokenState();
    const logs = captureLogs(() => { initSetupToken(); });
    assert.strictEqual(readHash(), hashSetupToken(envToken));
    assert.ok(!readHash().includes(envToken));
    assert.ok(!logs.some((line) => line.includes(envToken)));
    assert.strictEqual(verifySetupToken([generatedToken]), false);
    assert.strictEqual(verifySetupToken([envToken]), true);
  });
});

describe('setup token verification', () => {
  const envToken = 'setup-env-token-abcdefghijklmnopqrstuvwxyz';

  test('body and header candidates are trimmed, ordered and de-duplicated', () => {
    assert.deepStrictEqual(setupTokenCandidates(`  ${envToken}  `, envToken), [envToken]);
    assert.deepStrictEqual(setupTokenCandidates(undefined, envToken), [envToken]);
  });

  test('blank, non-string and wrong candidates never verify', () => {
    assert.strictEqual(verifySetupToken([]), false);
    assert.strictEqual(verifySetupToken([undefined, null, '', '   ', 42]), false);
    assert.strictEqual(verifySetupToken(['not-the-token']), false);
    assert.strictEqual(verifySetupToken(['not-the-token', envToken]), true);
  });
});

describe('performSetup outcome mapping', () => {
  const envToken = 'setup-env-token-abcdefghijklmnopqrstuvwxyz';

  test('a missing or wrong token is a 401 invalid_setup_token and creates no user', async () => {
    const missing = await performSetup({ username: 'owner', password: 'long-enough', bodyToken: undefined });
    assert.deepStrictEqual(missing, {
      ok: false,
      status: 401,
      error: 'invalid_setup_token',
      message: 'A valid setup token is required.',
    });
    const wrong = await performSetup({ username: 'owner', password: 'long-enough', bodyToken: 'wrong-token' });
    assert.strictEqual(wrong.ok, false);
    if (!wrong.ok) assert.strictEqual(wrong.status, 401);
    assert.strictEqual(userStore.hasUser(), false);
    assert.strictEqual(fs.existsSync(hashFile), true);
  });

  test('a valid token but missing or invalid credentials is a 400 invalid_setup_request', async () => {
    const missing = await performSetup({ username: '', password: '', bodyToken: envToken });
    assert.deepStrictEqual(missing, {
      ok: false,
      status: 400,
      error: 'invalid_setup_request',
      message: 'Username and password are required.',
    });
    const shortPassword = await performSetup({ username: 'owner', password: 'short', bodyToken: envToken });
    assert.deepStrictEqual(shortPassword, {
      ok: false,
      status: 400,
      error: 'invalid_setup_request',
      message: 'Password must be at least 6 characters.',
    });
    assert.strictEqual(userStore.hasUser(), false);
    assert.strictEqual(fs.existsSync(hashFile), true);
  });

  test('a valid body or header token creates the first admin and consumes the hash', async () => {
    const result = await performSetup({
      username: ' owner ',
      password: 'correct-horse-battery-staple',
      headerToken: `  ${envToken} `,
    });
    assert.strictEqual(result.ok, true);
    if (!result.ok) throw new Error('setup unexpectedly failed');
    assert.strictEqual(result.user.username, 'owner');
    assert.match(result.user.id, /^user-/);
    assert.ok(result.user.token);
    assert.strictEqual(userStore.hasUser(), true);
    assert.strictEqual(fs.existsSync(hashFile), false);
    assert.strictEqual(verifySetupToken([envToken]), false);
  });

  test('a second setup is 409 setup_complete even after the hash is consumed', async () => {
    const again = await performSetup({
      username: 'another',
      password: 'another-long-password',
      bodyToken: envToken,
    });
    assert.deepStrictEqual(again, {
      ok: false,
      status: 409,
      error: 'setup_complete',
      message: 'Setup is already complete.',
    });
  });

  test('boot after setup does not regenerate or persist a token', () => {
    resetSetupTokenState();
    const logs = captureLogs(() => { initSetupToken(); });
    assert.strictEqual(logs.some((line) => line.startsWith('Madar setup token:')), false);
    assert.strictEqual(fs.existsSync(hashFile), false);
  });
});

describe('setup route wiring', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'index.ts'), 'utf8');

  test('the route delegates to performSetup and maps the discriminated outcome', () => {
    assert.match(source, /app\.post\('\/api\/auth\/setup', authLimiter, async/);
    assert.match(source, /const result = await performSetup\(\{/);
    assert.match(source, /req\.body\?\.setupToken \?\? req\.body\?\.token/);
    assert.match(source, /req\.headers\['x-setup-token'\]/);
    assert.match(source, /res\.status\(result\.status\)\.json\(\{ error: result\.error, message: result\.message \}\)/);
    assert.match(source, /res\.status\(201\)\.json\(result\.user\)/);
    assert.doesNotMatch(source, /await setup\(/);
  });
});
