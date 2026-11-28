import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { reqAuth, req, API_URL, JWT_SECRET } from './helpers.ts';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  currentTotp,
  verifyTotp,
  otpauthUri,
} from '../src/services/totp.ts';

/**
 * ════════════════════════════════════════════════════════════════
 *  TOTP two-factor authentication — algorithm + endpoint journey
 * ════════════════════════════════════════════════════════════════
 * The crypto block always runs (RFC 6238 official test vectors).
 * Endpoint flows mutate users.json — self-skip unless
 * WSD_TEST_ACCOUNT_PASSWORD points at an ISOLATED server.
 */

// ── Algorithm correctness ─────────────────────────────────────

describe('TOTP algorithm (RFC vectors)', () => {

  test('base32 round-trips arbitrary bytes', () => {
    for (let i = 0; i < 25; i++) {
      const raw = crypto.randomBytes(20);
      assert.deepStrictEqual(base32Decode(base32Encode(raw)), raw);
    }
  });

  test('RFC 4648 base32 test vector', () => {
    assert.strictEqual(base32Encode(Buffer.from('Hello!', 'ascii')), 'JBSWY3DPEE');
    assert.deepStrictEqual(base32Decode('JBSWY3DPEE'), Buffer.from('Hello!', 'ascii'));
    assert.deepStrictEqual(base32Decode('JBSWY3DPEE======'), Buffer.from('Hello!', 'ascii'));
  });

  test('RFC seed decodes to the documented hex', () => {
    assert.strictEqual(
      base32Decode('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ').toString('hex'),
      Buffer.from('12345678901234567890', 'ascii').toString('hex')
    );
  });

  test('RFC 6238 Appendix B codes (SHA-1, 6 digits)', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    // [time in seconds, expected 6-digit code]
    const vectors: Array<[number, string]> = [
      [59, '287082'],
      [1_111_111_109, '081804'],
      [1_111_111_111, '050471'],
      [1_234_567_890, '005924'],
      [2_000_000_000, '279037'],
      [20_000_000_000, '353130'],
    ];
    for (const [seconds, expected] of vectors) {
      assert.strictEqual(currentTotp(secret, seconds * 1000), expected, `t=${seconds}`);
    }
  });

  test('verification accepts current, adjacent-step and spaced codes', () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    assert.ok(verifyTotp(secret, currentTotp(secret, now), now));
    assert.ok(verifyTotp(secret, currentTotp(secret, now - 29_000), now)); // -1 step
    assert.ok(verifyTotp(secret, currentTotp(secret, now + 29_000), now)); // +1 step
    const spaced = currentTotp(secret, now);
    assert.ok(verifyTotp(secret, `${spaced.slice(0, 3)} ${spaced.slice(3)}`, now));
  });

  test('verification rejects wrong, stale and malformed codes', () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    assert.ok(!verifyTotp(secret, '000000', now), 'wrong code');
    assert.ok(!verifyTotp(secret, currentTotp(secret, now - 91_000), now), 'outside window');
    assert.ok(!verifyTotp(secret, '12345', now), 'too short');
    assert.ok(!verifyTotp(secret, 'abcdef', now), 'not digits');
    assert.ok(!verifyTotp(secret, '', now), 'empty');
    assert.ok(!verifyTotp('ZZZZZZZZ', '123456', now), 'invalid base32 secret');
  });

  test('provisioning URI encodes issuer/account/digits', () => {
    const uri = otpauthUri('ABC234DEF234', 'someone');
    assert.ok(uri.startsWith('otpauth://totp/Madar%3Asomeone'));
    assert.ok(uri.includes('issuer=Madar'));
    assert.ok(uri.includes('digits=6'));
    assert.ok(uri.includes('period=30'));
  });
});

// ── Endpoint journey (isolated server only) ───────────────────

describe('TOTP endpoints & login flow', {
  skip: process.env.WSD_TEST_DOCKER === '1' && (process.env.WSD_TEST_ACCOUNT_PASSWORD || '').trim()
    ? false
    : 'requires WSD_TEST_DOCKER=1 + WSD_TEST_ACCOUNT_PASSWORD (isolated server + real login)',
}, () => {

  // ⚠ Budget math: every password-verifying endpoint shares the server's
  // 10/min-per-IP auth limiter. The account SETUP call made before this
  // suite consumes slot #1, so this file must issue at most 9 more:
  //   setup ×3 · enable ×2 · login ×2 · disable ×2  = 9  ✓ (total 10)
  // Adding another authLimiter'd call WILL cascade 429s into later tests.

  const accountPassword = (process.env.WSD_TEST_ACCOUNT_PASSWORD || '').trim();
  const accountSkip = 'requires WSD_TEST_ACCOUNT_PASSWORD (live 2FA endpoint journey)';
  let enrolledSecret = '';     // captured from /2fa/setup while enrolling
  let pendingToken = '';       // captured from the gated login response

  after(async () => {
    if (!accountPassword) return;
    try {
      await reqAuth('POST', '/auth/2fa/disable', { accountPassword });
    } catch { /* best-effort cleanup */ }
  });

  test('status reports disabled initially', async (t) => {
    if (!accountPassword) return t.skip(accountSkip);
    const res = await reqAuth('GET', '/auth/2fa/status');
    assert.strictEqual(res.status, 200);
    assert.strictEqual((await res.json()).enabled, false);
  });

  test('setup returns a base32 secret and provisioning URI', async (t) => {
    if (!accountPassword) return t.skip(accountSkip);
    const res = await reqAuth('POST', '/auth/2fa/setup');
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.match(body.secret, /^[A-Z2-7]{32}$/);
    assert.ok(String(body.uri).startsWith('otpauth://totp/Madar%3A'), body.uri);
    assert.ok(String(body.uri).includes(`secret=${body.secret}`));
    enrolledSecret = String(body.secret);
  });

  test('enable rejects an invalid code and stays disabled', async (t) => {
    if (!accountPassword) return t.skip(accountSkip);
    const res = await reqAuth('POST', '/auth/2fa/enable', { code: '000000' });
    assert.strictEqual(res.status, 400);
    const status = await reqAuth('GET', '/auth/2fa/status');
    assert.strictEqual((await status.json()).enabled, false);
  });

  test('enable with a live-generated code activates 2FA', async (t) => {
    if (!accountPassword) return t.skip(accountSkip);
    // Fresh pending secret so this test owns the enrollment end-to-end.
    const setupRes = await reqAuth('POST', '/auth/2fa/setup');
    enrolledSecret = String((await setupRes.json()).secret);

    const res = await reqAuth('POST', '/auth/2fa/enable', { code: currentTotp(enrolledSecret) });
    assert.strictEqual(res.status, 200);
    const status = await reqAuth('GET', '/auth/2fa/status');
    assert.strictEqual((await status.json()).enabled, true);
  });

  test('setup refuses while 2FA is enabled', async (t) => {
    if (!accountPassword) return t.skip(accountSkip);
    const res = await reqAuth('POST', '/auth/2fa/setup');
    assert.strictEqual(res.status, 400);
  });

  test('login now demands the second factor (no session leaked)', async (t) => {
    if (!accountPassword) return t.skip(accountSkip);
    const res = await req('POST', '/auth/login', { username: 'isolated', password: accountPassword });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.requires2fa, true);
    assert.ok(body.pendingToken, 'expected a pending token');
    assert.strictEqual(body.token, undefined, 'must NOT contain a session token');
    pendingToken = String(body.pendingToken);

    // CRITICAL regression: the scoped pending token must never authenticate
    // generic routes — otherwise possession of password alone would bypass
    // TOTP by replaying it as a session.
    const smuggled = await fetch(`${API_URL}/projects`, {
      headers: { Authorization: `Bearer ${pendingToken}` },
    });
    assert.strictEqual(smuggled.status, 401, 'pending token is not a session');
  });

  test('verify rejects wrong codes, junk and hostile tokens', async (t) => {
    if (!accountPassword) return t.skip(accountSkip);
    void t;

    const post = (body: unknown): Promise<Response> =>
      fetch(`${API_URL}/auth/login/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    const wrong = await post({ pendingToken, code: '999999' });
    assert.strictEqual(wrong.status, 401, 'valid pending token + wrong code');

    const junk = await post({ pendingToken: 'garbage', code: '123456' });
    assert.strictEqual(junk.status, 401, 'unparseable pending token');

    const forged = await post({
      pendingToken: jwt.sign({ scope: '2fa-pending', id: 'user-x' }, 'attacker-secret', { expiresIn: '5m' }),
      code: '123456',
    });
    assert.strictEqual(forged.status, 401, 'attacker-signed token');

    const expired = await post({
      pendingToken: jwt.sign({ scope: '2fa-pending', id: 'user-y' }, JWT_SECRET, { expiresIn: -10 }),
      code: '123456',
    });
    assert.strictEqual(expired.status, 401, 'correctly signed but expired');

    const missing = await post({ code: '123456' });
    assert.strictEqual(missing.status, 401, 'pending token absent');
  });

  test('verify with the live code yields a working session', async (t) => {
    if (!accountPassword || !enrolledSecret || !pendingToken) {
      return t.skip(`${accountSkip}; a completed enrollment + pending challenge is also required`);
    }

    const verify = await fetch(`${API_URL}/auth/login/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pendingToken, code: currentTotp(enrolledSecret) }),
    });
    assert.strictEqual(verify.status, 200);
    const { token } = await verify.json();
    assert.ok(token, 'expected a full session token');
    const decoded = jwt.decode(token) as any;
    assert.strictEqual(decoded?.username, 'isolated', 'the session must belong to the account that completed the 2FA challenge');
    assert.strictEqual(decoded?.scope, undefined, 'a session must never carry the 2fa-pending scope');

    const probe = await fetch(`${API_URL}/providers-lock`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(probe.status, 200, 'session token must open protected routes');
  });

  test('disable requires the account password', async (t) => {
    if (!accountPassword) return t.skip(accountSkip);
    const bad = await reqAuth('POST', '/auth/2fa/disable', { accountPassword: 'wrong-password' });
    assert.strictEqual(bad.status, 401);
    const good = await reqAuth('POST', '/auth/2fa/disable', { accountPassword });
    assert.strictEqual(good.status, 200);
    const status = await reqAuth('GET', '/auth/2fa/status');
    assert.strictEqual((await status.json()).enabled, false);
  });

  test('plain login works again after disabling', async (t) => {
    if (!accountPassword) return t.skip(accountSkip);
    const ok = await req('POST', '/auth/login', { username: 'isolated', password: accountPassword });
    assert.strictEqual(ok.status, 200);
    assert.ok((await ok.json()).token);
  });
});
