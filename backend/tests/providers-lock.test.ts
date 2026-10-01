import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { uniqueId, reqAuth, signTestToken, signUserToken, testIdentity, API_URL, initTestAuth } from './helpers.ts';

/**
 * Providers-lock + settings backup tests.
 * These mutate the real user record (providers password) — they always
 * clean up by removing the lock at the end. The account password itself
 * is never changed here. Set WSD_TEST_ACCOUNT_PASSWORD to enable;
 * otherwise the suite self-skips.
 */
describe('Providers security lock & backup', () => {
  before(async () => { await initTestAuth(); });

  const accountPassword = process.env.WSD_TEST_ACCOUNT_PASSWORD || '';
  let providersPw = `pl-${uniqueId('k')}-secret`;
  let lockWasEnabled = false;

  function authHeader(): Record<string, string> {
    return { Authorization: `Bearer ${signTestToken()}` };
  }

  /** Remove the lock; retry once past the rate-limit window on a rare 429. */
  async function removeLock(): Promise<number> {
    const res = await reqAuth('DELETE', '/auth/providers-password', { accountPassword });
    if (res.status !== 429) return res.status;
    await new Promise((r) => setTimeout(r, 61_000));
    const again = await reqAuth('DELETE', '/auth/providers-password', { accountPassword });
    return again.status;
  }

  after(async () => {
    if (!lockWasEnabled || !accountPassword) return;
    try { await removeLock(); } catch { /* best effort */ }
  });

  test('lock status endpoint responds with enabled flag', async () => {
    const res = await reqAuth('GET', '/providers-lock');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(typeof (await res.json()).enabled, 'boolean');
  });

  test('management routes reject when unauthenticated regardless of lock state', async () => {
    const res = await fetch(`${API_URL}/providers`);
    assert.strictEqual(res.status, 401);
  });

  test('setting the lock without account password → rejected', async (t) => {
    if (!accountPassword) return t.skip();
    const res = await reqAuth('POST', '/auth/providers-password', { newPassword: 'whatever123' });
    assert.ok([400, 401].includes(res.status), `expected 400/401, got ${res.status}`);
  });

  test('setting the lock with WRONG account password → 401', async (t) => {
    if (!accountPassword) return t.skip();
    const res = await reqAuth('POST', '/auth/providers-password', {
      accountPassword: 'definitely-wrong',
      newPassword: providersPw,
    });
    assert.strictEqual(res.status, 401);
  });

  test('enabling the lock with correct account password → ok', async (t) => {
    if (!accountPassword) return t.skip();
    const res = await reqAuth('POST', '/auth/providers-password', { accountPassword, newPassword: providersPw });
    assert.strictEqual(res.status, 200);
    const check = await reqAuth('GET', '/providers-lock');
    assert.strictEqual((await check.json()).enabled, true);
    lockWasEnabled = true;
  });

  test('management endpoints are locked without unlock token (403)', async (t) => {
    if (!lockWasEnabled) return t.skip();
    const res = await reqAuth('GET', '/providers');
    assert.strictEqual(res.status, 403);
    assert.strictEqual((await res.json()).error, 'providers_locked');
  });

  test('options endpoint stays reachable while locked', async (t) => {
    if (!lockWasEnabled) return t.skip();
    const res = await reqAuth('GET', '/providers/options');
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray((await res.json()).providers));
  });

  test('unlock with wrong password → 401', async (t) => {
    if (!lockWasEnabled) return t.skip();
    const res = await reqAuth('POST', '/providers/unlock', { password: 'wrong-guess-123' });
    assert.strictEqual(res.status, 401);
  });

  test('unlock with correct password → scoped token unlocks management', async (t) => {
    if (!lockWasEnabled) return t.skip();
    const res = await reqAuth('POST', '/providers/unlock', { password: providersPw });
    assert.strictEqual(res.status, 200);
    const { unlockToken, expiresInSec } = await res.json();
    assert.ok(unlockToken, 'expected an unlock token');
    assert.ok(expiresInSec > 0 && expiresInSec <= 1800);

    const list = await fetch(`${API_URL}/providers`, {
      headers: { ...authHeader(), 'X-Providers-Unlock': String(unlockToken) },
    });
    assert.strictEqual(list.status, 200);
  });

  test('changing providers password requires re-auth and invalidates old tokens', async (t) => {
    if (!lockWasEnabled) return t.skip();

    const first = await reqAuth('POST', '/providers/unlock', { password: providersPw });
    const firstToken = String((await first.json()).unlockToken);

    const wrongAcct = await reqAuth('POST', '/auth/providers-password', {
      accountPassword: 'nope-wrong',
      newPassword: `${providersPw}-v2`,
    });
    assert.strictEqual(wrongAcct.status, 401);

    const change = await reqAuth('POST', '/auth/providers-password', {
      accountPassword,
      newPassword: `${providersPw}-v2`,
    });
    assert.strictEqual(change.status, 200);
    providersPw = `${providersPw}-v2`;

    // old unlock token must now be rejected (version bump)
    const stale = await fetch(`${API_URL}/providers`, {
      headers: { ...authHeader(), 'X-Providers-Unlock': firstToken },
    });
    assert.strictEqual(stale.status, 403);

    // new password unlocks again
    const again = await reqAuth('POST', '/providers/unlock', { password: providersPw });
    assert.strictEqual(again.status, 200);
  });

  test('backup export requires account password and never contains raw API keys', async (t) => {
    if (!lockWasEnabled) return t.skip();

    const no = await fetch(`${API_URL}/settings/export`, {
      method: 'POST',
      headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountPassword: '' }),
    });
    assert.ok([400, 401].includes(no.status));

    const yes = await fetch(`${API_URL}/settings/export`, {
      method: 'POST',
      headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ accountPassword }),
    });
    assert.strictEqual(yes.status, 200);
    const backup = await yes.json();
    assert.strictEqual(backup.kind, 'madar-backup');
    assert.strictEqual(backup.sanitized, true);
    const text = JSON.stringify(backup.data?.providers ?? []);
    assert.ok(!text.includes('"apiKey":"'), 'export must not contain raw API keys');
  });

  test('unlock tokens are bound to their issuing session', async (t) => {
    if (!lockWasEnabled) return t.skip();

    // Two real sessions with different jti claims (as login tokens carry) — the
    // same account signing in twice, which is exactly the two-devices case. Both
    // must be REAL sessions: verifyToken refuses an id absent from users.json.
    const me = testIdentity();
    assert.ok(me, 'a real test identity must be resolved');
    const sessionA = signUserToken(me!, { jti: 'jti-a-fixed' }, '10m');
    const sessionB = signUserToken(me!, { jti: 'jti-b-fixed' }, '10m');

    // Unlock from session A...
    const unl = await fetch(`${API_URL}/providers/unlock`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sessionA}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: providersPw }),
    });
    assert.strictEqual(unl.status, 200);
    const { unlockToken } = await unl.json();
    assert.ok(unlockToken);

    // ...same session → management opens
    const same = await fetch(`${API_URL}/providers`, {
      headers: { Authorization: `Bearer ${sessionA}`, 'X-Providers-Unlock': String(unlockToken) },
    });
    assert.strictEqual(same.status, 200);

    // ...replayed from session B → rejected despite valid token + password state
    const other = await fetch(`${API_URL}/providers`, {
      headers: { Authorization: `Bearer ${sessionB}`, 'X-Providers-Unlock': String(unlockToken) },
    });
    assert.strictEqual(other.status, 403);
    assert.strictEqual((await other.json()).error, 'providers_locked');
  });

  test('consecutive unlock failures trigger a cooldown window', async (t) => {
    if (!lockWasEnabled) return t.skip();

    // Burn the failure budget (5 wrong passwords).
    for (let i = 0; i < 5; i++) {
      const bad = await reqAuth('POST', '/providers/unlock', { password: `wrong-${uniqueId('w')}` });
      assert.strictEqual(bad.status, 401);
    }

    // Next attempt is cooldown-blocked before password verification runs.
    const blocked = await reqAuth('POST', '/providers/unlock', { password: providersPw });
    assert.strictEqual(blocked.status, 429);
    assert.ok(blocked.headers.get('retry-after'), 'expected Retry-After header');

    // Even the CORRECT password stays blocked for the cooldown window —
    // this is the last lock-dependent test; cleanup happens next.
  });

  test('disabling the lock requires the account password, then management opens', async (t) => {
    if (!lockWasEnabled) return t.skip();

    const wrong = await reqAuth('DELETE', '/auth/providers-password', { accountPassword: 'wrong-again' });
    assert.strictEqual(wrong.status, 401);

    const right = await removeLock();
    assert.strictEqual(right, 200);
    lockWasEnabled = false;

    const open = await reqAuth('GET', '/providers');
    assert.strictEqual(open.status, 200);
  });

});
