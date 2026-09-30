/**
 * jwt-secret.test.ts — the signing-secret resolution rules, offline.
 *
 * This is the regression guard for the RCE chain: compose used to fall back to
 * the literal `wsd-pro-insecure-default`, which is published in this repo, and
 * a token signed with it bought a dashboard-admin session → an embed cookie →
 * a live opencode session running as root beside /var/run/docker.sock. The fix
 * removes the fallback instead of warning about it, so the assertions below
 * pin the three properties that closed the hole:
 *
 *   - a value published in the repo (or any too-short/blank one) is REFUSED and
 *     replaced by a random secret persisted in the data dir;
 *   - a token signed with the public default no longer verifies — neither as a
 *     session nor as the embed credential that gates code execution;
 *   - the resolved value is the single memoized one every signer and verifier
 *     reads, so a signer/verifier split cannot silently re-open the hole.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { register } from 'node:module';
import { classifyJwtSecret, describeJwtSecretRejection, MIN_JWT_SECRET_LENGTH } from '../src/services/jwt-secret-core.ts';

// user-store imports ./jwt-secret extensionless, which node's ESM loader cannot
// resolve — see tests/ts-ext-resolve.mjs.
register(new URL('./ts-ext-resolve.mjs', import.meta.url).href);

const PUBLIC_DEFAULTS = ['wsd-pro-insecure-default', 'wsd-pro-default-secret-change-me'];

// ── the pure rules ─────────────────────────────────────────────

describe('classifyJwtSecret (pure rules)', () => {
  test('every literal published in the repository is refused as known-weak', () => {
    for (const value of PUBLIC_DEFAULTS) {
      assert.strictEqual(classifyJwtSecret(value), 'known-weak', value);
    }
  });

  test('a blank, whitespace-only or non-string value counts as missing', () => {
    for (const value of [undefined, null, '', '   ', '\n\t', 0, 42, {}, []]) {
      assert.strictEqual(classifyJwtSecret(value), 'missing', String(value));
    }
  });

  test('anything shorter than the minimum is refused', () => {
    assert.strictEqual(MIN_JWT_SECRET_LENGTH, 32);
    assert.strictEqual(classifyJwtSecret('a'.repeat(31)), 'too-short');
    assert.strictEqual(classifyJwtSecret('a'.repeat(32)), null);
  });

  test('other obvious placeholders are refused too', () => {
    for (const value of ['change-me', 'ChangeMe', 'SECRET', 'jwt-secret', 'password', 'supersecret', 'your-secret-here']) {
      assert.strictEqual(classifyJwtSecret(value), 'known-weak', value);
    }
  });

  test('a weak value is still refused when it is padded or re-cased', () => {
    assert.strictEqual(classifyJwtSecret('  wsd-pro-insecure-default  '), 'known-weak');
    assert.strictEqual(classifyJwtSecret('WSD-PRO-INSECURE-DEFAULT'), 'known-weak');
  });

  test('a strong value survives whitespace padding (a .env line or file body)', () => {
    const strong = 'b'.repeat(48);
    assert.strictEqual(classifyJwtSecret(strong), null);
    assert.strictEqual(classifyJwtSecret(strong + '\n'), null);
  });

  test('every refusal has an honest, specific description', () => {
    assert.match(describeJwtSecretRejection('missing'), /not set/);
    assert.match(describeJwtSecretRejection('known-weak'), /published in the public repository/);
    assert.match(describeJwtSecretRejection('too-short'), /32 characters/);
    assert.match(describeJwtSecretRejection(null), /in use/);
  });
});

// ── the resolution the server actually performs ────────────────

// Set up the environment BEFORE the env-reading modules load: user-store
// captures the secret at import time, exactly like the server process.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsd-jwt-secret-'));
const secretFile = path.join(dataDir, 'jwt.secret');
const originalEnv = process.env.JWT_SECRET;
delete process.env.JWT_SECRET;
process.env.WSD_DATA_DIR = dataDir;

const { getJwtSecret, jwtSecretValue, resetJwtSecretCache, JWT_SECRET_FILE } =
  await import('../src/services/jwt-secret.ts');
const store = await import('../src/services/user-store.ts');

const resolvedSecret = jwtSecretValue();
const ADMIN = { id: 'u-admin', username: 'owner', role: 'admin' };

function forge(secret: string, claims: Record<string, unknown> = {}): string {
  return jwt.sign({ id: ADMIN.id, username: ADMIN.username, role: 'admin', tv: 0, ...claims }, secret, { expiresIn: '24h' });
}

describe('resolveJwtSecret (what the app does at boot)', () => {
  test('the secret file lives in the data dir and the resolved value is reported honestly', () => {
    const state = getJwtSecret();
    assert.strictEqual(JWT_SECRET_FILE, secretFile);
    assert.strictEqual(state.source, 'file');
    assert.strictEqual(state.envRejection, 'missing');
    assert.strictEqual(state.path, secretFile);
    assert.match(state.secret, /^[0-9a-f]{64}$/);
    assert.strictEqual(fs.readFileSync(secretFile, 'utf8').trim(), state.secret);
  });

  test('the persisted secret is 0600 and NOT the public default', function (t) {
    if (process.platform === 'win32') return t.skip('POSIX file modes only');
    assert.strictEqual(fs.statSync(secretFile).mode & 0o777, 0o600);
    assert.ok(!PUBLIC_DEFAULTS.includes(resolvedSecret));
  });

  test('a restart keeps the same secret (the whole point of persisting it)', () => {
    resetJwtSecretCache();
    assert.strictEqual(jwtSecretValue(), resolvedSecret);
    resetJwtSecretCache();
    assert.strictEqual(getJwtSecret().source, 'file');
  });

  test('a token signed with the public default is REJECTED as a session', () => {
    for (const weak of PUBLIC_DEFAULTS) {
      assert.strictEqual(store.verifyToken(forge(weak)), null, `session forged with "${weak}" must not verify`);
    }
  });

  test('a token signed with the public default is REJECTED as an embed credential', () => {
    for (const weak of PUBLIC_DEFAULTS) {
      const forgedEmbed = jwt.sign({ scope: 'embed', id: ADMIN.id, username: ADMIN.username, role: 'admin', tv: 0 }, weak, { expiresIn: '12h' });
      assert.strictEqual(store.verifyEmbedToken(forgedEmbed), null, `embed cookie forged with "${weak}" must not verify`);
    }
  });

  test('a token signed with the resolved secret still verifies — sign and verify agree', () => {
    // The half-fix this guards: a signer using the generated secret while the
    // verifier kept the old literal (or vice versa) would fail exactly here.
    assert.deepStrictEqual(
      store.verifyToken(forge(resolvedSecret, { jti: 'suite' })),
      { id: ADMIN.id, username: ADMIN.username, role: 'admin', jti: 'suite' },
    );
    const unlock = jwt.sign({ scope: 'providers', pv: 0, sid: 's' }, resolvedSecret, { expiresIn: '30m' });
    assert.strictEqual((jwt.verify(unlock, jwtSecretValue()) as jwt.JwtPayload).scope, 'providers');
  });

  test('a deliberately weak JWT_SECRET is refused, not silently accepted', () => {
    process.env.JWT_SECRET = 'wsd-pro-insecure-default';
    resetJwtSecretCache();
    const state = getJwtSecret();
    assert.strictEqual(state.envRejection, 'known-weak');
    assert.strictEqual(state.source, 'file');
    assert.strictEqual(state.secret, resolvedSecret);
    process.env.JWT_SECRET = 'a'.repeat(20);
    resetJwtSecretCache();
    assert.strictEqual(getJwtSecret().envRejection, 'too-short');
    process.env.JWT_SECRET = '';
    resetJwtSecretCache();
    assert.strictEqual(getJwtSecret().envRejection, 'missing');
  });

  test('a weak persisted file is replaced, never trusted', () => {
    fs.writeFileSync(secretFile, 'wsd-pro-insecure-default\n', { mode: 0o600 });
    resetJwtSecretCache();
    const state = getJwtSecret();
    assert.strictEqual(state.envRejection, 'missing');
    assert.ok(!PUBLIC_DEFAULTS.includes(state.secret));
    assert.match(state.secret, /^[0-9a-f]{64}$/);
    // restore the fixture secret for anything that runs after this test
    fs.writeFileSync(secretFile, resolvedSecret + '\n', { mode: 0o600 });
    resetJwtSecretCache();
    assert.strictEqual(jwtSecretValue(), resolvedSecret);
  });

  test('a strong JWT_SECRET in the environment always wins over the persisted one', () => {
    const strong = 'c'.repeat(48);
    process.env.JWT_SECRET = strong;
    resetJwtSecretCache();
    const state = getJwtSecret();
    assert.strictEqual(state.source, 'env');
    assert.strictEqual(state.envRejection, null);
    assert.strictEqual(state.secret, strong);
    assert.strictEqual(jwtSecretValue(), strong);
    if (originalEnv === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalEnv;
    resetJwtSecretCache();
    assert.strictEqual(jwtSecretValue(), resolvedSecret);
  });
});
