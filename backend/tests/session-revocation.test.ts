/**
 * session-revocation.test.ts — a session must not outlive its subject.
 *
 * The hole (CWE-613, Medium): verifyToken() fell through to the token's OWN
 * embedded role whenever the subject id was missing from users.json. Deleting a
 * compromised admin — the first move an operator reaches for — left their
 * unexpired 24h token fully working: user management, provider keys and
 * POST /api/updates/apply kept answering 200 for up to a day, while
 * verifyEmbedToken() (which always demanded the live user) had already killed
 * the same user's proxy credential. The fallback existed "for test helpers";
 * helpers.ts signs its own JWTs and can mint throwaway users through
 * POST /api/users, so nothing was actually traded away.
 *
 * Two halves:
 *   1. OFFLINE units on the real verifiers against a temp data dir (same
 *      pattern as jwt-secret.test.ts / embed-proxy.test.ts) — every verifier in
 *      user-store.ts, including the sibling providers-unlock and 2FA-pending
 *      ones, so the rule is pinned per verifier rather than once.
 *   2. LIVE rows against the running container — the deleted-admin 401 matrix
 *      (/users, /webhooks, /auth/audit), embed-cookie parity at the proxy, and
 *      the "live role beats the token's claim" rule over HTTP.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { register } from 'node:module';
import {
  API_URL, JSON_HEADERS, LIVE_USER_PASSWORD, authHeaders, req, reqAuth, initTestAuth,
  liveUser, cleanupLiveUsers, signUserToken, uniqueId,
} from './helpers.ts';

// user-store imports ./jwt-secret extensionless, which node's ESM loader cannot
// resolve — see tests/ts-ext-resolve.mjs.
register(new URL('./ts-ext-resolve.mjs', import.meta.url).href);

const PW = 'Revoked-Suite-1234';

// ── 1 · the verifiers themselves, offline ─────────────────────
// A temp data dir keeps these units hermetic: they never touch the running
// server's users.json. WSD_DATA_DIR must be set BEFORE these modules are
// imported — jwt-secret.ts captures the dir at import time, exactly like the
// server process does.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsd-session-revocation-'));
process.env.WSD_DATA_DIR = dataDir;
const { jwtSecretValue } = await import('../src/services/jwt-secret.ts');
const store = await import('../src/services/user-store.ts');

/** The one secret these verifiers accept — read through the store's own
 *  resolver, so a forged-for-the-test token exercises the real verify path. */
const SECRET = jwtSecretValue();

function session(id: string, username: string, role: string, claims: Record<string, unknown> = {}, expiresIn = '24h'): string {
  return jwt.sign({ id, username, role, tv: 0, ...claims }, SECRET, { expiresIn });
}

type Role = 'admin' | 'editor' | 'viewer';
async function makeUser(role: Role, name = uniqueId('sv')) {
  return store.createUser(name, PW, role);
}

describe('verifyToken — the subject must exist (offline)', () => {
  test('a live user verifies and the identity is read LIVE, not from the claim', async () => {
    const admin = await makeUser('admin');
    const login = (await store.login(admin.username, PW)) as { token: string };
    const decoded = store.verifyToken(login.token);
    assert.deepStrictEqual(decoded, { id: admin.id, username: admin.username, role: 'admin', jti: decoded?.jti });
    assert.strictEqual(typeof decoded?.jti, 'string', 'login mints a session-bound jti');
  });

  test('an id that was never a user is refused — never the embedded role', () => {
    // The regression itself: a correctly signed token for a non-existent subject
    // used to authenticate with whatever role the token claimed.
    assert.strictEqual(store.verifyToken(session('ghost-never-existed', 'ghost', 'admin')), null);
    assert.strictEqual(store.verifyToken(session('', 'ghost', 'admin')), null);
    assert.strictEqual(store.verifyToken(session('u-1', 'ghost', 'admin', { tv: 7 })), null);
  });

  test('deleting a user kills their still-unexpired session immediately', async () => {
    const victim = await makeUser('admin', uniqueId('victim'));
    const login = (await store.login(victim.username, PW)) as { token: string };
    assert.ok(store.verifyToken(login.token), 'precondition: the session works while the account exists');

    assert.strictEqual(store.deleteUser(victim.id), true);
    assert.strictEqual(store.verifyToken(login.token), null, 'a deleted account must not keep a live admin session');
  });

  test('a token whose role claim lies is reported with the LIVE role', async () => {
    const editor = await makeUser('editor', uniqueId('liar'));
    // A viewer claiming to be an admin: the claim must not be believed.
    const forged = session(editor.id, editor.username, 'admin');
    assert.strictEqual(store.verifyToken(forged)?.role, 'editor');

    // …and the username claim is ignored too — only the stored one is reported.
    assert.strictEqual(store.verifyToken(session(editor.id, 'not-me', 'editor'))?.username, editor.username);
  });

  test('a demotion takes effect on the very next verification', async () => {
    const editor = await makeUser('editor', uniqueId('demote'));
    const token = session(editor.id, editor.username, 'editor');
    assert.strictEqual(store.verifyToken(token)?.role, 'editor');
    assert.strictEqual(store.updateUserRole(editor.id, 'viewer'), true);
    assert.strictEqual(store.verifyToken(token)?.role, 'viewer', 'a demoted session must lose the role it was minted with');
  });

  test('a matching tokenVersion still works and a bumped one is refused', async () => {
    const user = await makeUser('editor', uniqueId('tv'));
    const session1 = (await store.login(user.username, PW)) as { token: string };
    assert.ok(store.verifyToken(session1.token), 'precondition: a freshly issued session verifies');

    await store.revokeAllSessions(PW, user.id);
    assert.strictEqual(store.verifyToken(session1.token), null, 'logout-everywhere must kill it');
  });

  test('an expired token is still refused', async () => {
    const user = await makeUser('editor', uniqueId('expired'));
    // Non-vacuous: the same id inside a valid window does verify.
    assert.ok(store.verifyToken(session(user.id, user.username, 'editor')), 'precondition: a live window verifies');
    assert.strictEqual(store.verifyToken(session(user.id, user.username, 'editor', {}, '-10s')), null);
  });

  test('no scoped token can ever authenticate as a session', async () => {
    const user = await makeUser('admin', uniqueId('scope'));
    for (const scope of ['embed', 'providers', '2fa-pending']) {
      const scoped = jwt.sign({ scope, id: user.id, username: user.username, role: 'admin', tv: 0 }, SECRET, { expiresIn: '1h' });
      assert.strictEqual(store.verifyToken(scoped), null, `scope:${scope} must not authenticate`);
    }
  });
});

describe('sibling verifiers — same rule, no embedded-identity fallback (offline)', () => {
  test("a deleted user's embed cookie dies with the account (parity)", async () => {
    const editor = await makeUser('editor', uniqueId('embedvictim'));
    const cookie = store.signEmbedToken(editor.id);
    assert.ok(cookie, 'precondition: the credential was minted for a live editor');
    assert.ok(store.verifyEmbedToken(cookie));

    store.deleteUser(editor.id);
    assert.strictEqual(store.verifyEmbedToken(cookie), null, 'deleting the editor must revoke the root-code credential too');
    assert.strictEqual(store.signEmbedToken(editor.id), null, 'and no new one can be minted');
  });

  test('the embed credential reports the LIVE role', async () => {
    const editor = await makeUser('editor', uniqueId('embedrole'));
    const cookie = store.signEmbedToken(editor.id) as string;
    assert.strictEqual(store.verifyEmbedToken(cookie)?.role, 'editor');
    store.updateUserRole(editor.id, 'viewer');
    assert.strictEqual(store.verifyEmbedToken(cookie)?.role, 'viewer');
  });

  test('a 2FA challenge for a deleted user cannot complete into a session', async () => {
    const user = await makeUser('editor', uniqueId('pending'));
    const pending = jwt.sign({ scope: '2fa-pending', id: user.id }, SECRET, { expiresIn: '5m' });
    assert.strictEqual(store.verifyPending2faToken(pending), user.id, 'precondition: a live challenge resolves');

    store.deleteUser(user.id);
    assert.strictEqual(store.verifyPending2faToken(pending), null, 'a challenge for a ghost must not become a session');
  });

  test('providers-unlock carries no user identity: it dies with the lock, not with a claim', async () => {
    const holder = await makeUser('admin', uniqueId('lockholder'));
    await store.setProvidersPassword(PW, `${PW}-lock`, holder.id);
    const issued = await store.issueUnlockToken(`${PW}-lock`, 'session-jti');
    assert.ok(issued?.unlockToken, 'precondition: the lock is on and an unlock token exists');
    assert.strictEqual(store.verifyUnlockToken(issued!.unlockToken, 'session-jti'), true);
    assert.strictEqual(store.verifyUnlockToken(issued!.unlockToken, 'other-session'), false, 'sid binding holds');

    // Deleting the account that owns the lock removes the lock itself, so no
    // outstanding unlock token can open providers management any more.
    store.deleteUser(holder.id);
    assert.strictEqual(store.verifyUnlockToken(issued!.unlockToken, 'session-jti'), false);
  });

  test('changing the lock password invalidates outstanding unlock tokens', async () => {
    const holder = await makeUser('admin', uniqueId('lockrotate'));
    await store.setProvidersPassword(PW, `${PW}-one`, holder.id);
    const first = await store.issueUnlockToken(`${PW}-one`, 'jti');
    assert.strictEqual(store.verifyUnlockToken(first!.unlockToken, 'jti'), true);

    await store.setProvidersPassword(PW, `${PW}-two`, holder.id);
    assert.strictEqual(store.verifyUnlockToken(first!.unlockToken, 'jti'), false);
    store.revokeProvidersUnlocks();
    store.deleteUser(holder.id);
  });
});

// ── 2 · the same rule over HTTP, against the running container ──

const EMBED_ORIGIN = `http://127.0.0.1:${Number(process.env.WSD_EMBED_PROXY_PORT || 4097)}`;
const ADMIN_ROUTES = ['/users', '/webhooks', '/auth/audit'] as const;

async function embedCookieFor(token: string): Promise<string> {
  const res = await fetch(`${API_URL}/embed/session`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  assert.strictEqual(res.status, 200, `embed session mint failed: ${res.status}`);
  const setCookie = res.headers.get('set-cookie') || '';
  const match = /madar_embed=([^;]+)/.exec(setCookie);
  assert.ok(match, `no madar_embed cookie in: ${setCookie}`);
  return `madar_embed=${match[1]}`;
}

describe('deleted-account sessions (live server)', () => {
  before(async () => { await initTestAuth(); });
  after(async () => { await cleanupLiveUsers(); });

  test('a deleted admin loses every administrative route its unexpired token names', async () => {
    const doomed = await liveUser('admin', 'doomed-admin');

    for (const path of ADMIN_ROUTES) {
      const res = await req('GET', path, undefined, { Authorization: `Bearer ${doomed.token}` });
      assert.strictEqual(res.status, 200, `precondition: the admin session must read ${path} first (got ${res.status})`);
    }

    const del = await reqAuth('DELETE', `/users/${doomed.id}`);
    assert.strictEqual(del.status, 200, `delete failed: ${del.status}`);
    assert.strictEqual((await del.json()).ok, true);
    const roster = await reqAuth('GET', '/users');
    const users = (await roster.json()) as Array<{ id: string }>;
    assert.ok(Array.isArray(users) && !users.some((u) => u.id === doomed.id), 'the account is really gone');

    for (const path of ADMIN_ROUTES) {
      const res = await req('GET', path, undefined, { Authorization: `Bearer ${doomed.token}` });
      assert.strictEqual(res.status, 401, `a deleted admin must be refused on ${path} (got ${res.status})`);
    }
  });

  test("the live role governs, never the token's role claim", async () => {
    const viewer = await liveUser('viewer', 'claim-liar');
    const liarToken = signUserToken({ id: viewer.id, username: viewer.username, role: 'admin' });

    const open = await req('GET', '/users', undefined, { Authorization: `Bearer ${liarToken}` });
    assert.strictEqual(open.status, 200, 'a live viewer still authenticates');
    const adminOnly = await req('GET', '/users/with-memberships', undefined, { Authorization: `Bearer ${liarToken}` });
    assert.strictEqual(adminOnly.status, 403, 'a viewer token that CLAIMS admin must still be refused the admin route');
  });

  test('a real promotion is honoured on the very next request (sudo role change)', async (t) => {
    const accountPassword = process.env.WSD_TEST_ACCOUNT_PASSWORD || '';
    if (!accountPassword) return t.skip('WSD_TEST_ACCOUNT_PASSWORD not set — the role PATCH is a sudo op');
    const editor = await liveUser('editor', 'promote-live');
    const editorToken = editor.token;

    const before = await req('GET', '/users/with-memberships', undefined, { Authorization: `Bearer ${editorToken}` });
    assert.strictEqual(before.status, 403, 'precondition: a plain editor is not an admin');

    const promote = await req('PATCH', `/users/${editor.id}/role`, { role: 'admin', accountPassword }, authHeaders());
    assert.strictEqual(promote.status, 200, `role change failed: ${promote.status}`);
    const after = await req('GET', '/users/with-memberships', undefined, { Authorization: `Bearer ${editorToken}` });
    assert.strictEqual(after.status, 200, 'the session must see the admin route on its next request, without re-login');
    await req('PATCH', `/users/${editor.id}/role`, { role: 'editor', accountPassword }, authHeaders());
  });

  test("a deleted editor's embed cookie is refused by the proxy", async () => {
    const editor = await liveUser('editor', 'embed-doomed');
    const cookie = await embedCookieFor(editor.token);
    const open = await fetch(`${EMBED_ORIGIN}/ide/`, { headers: { Cookie: cookie } });
    assert.ok(open.status !== 401 && open.status !== 403, `precondition: a live editor's cookie opens the gate (got ${open.status})`);

    assert.strictEqual((await reqAuth('DELETE', `/users/${editor.id}`)).status, 200);

    const res = await fetch(`${EMBED_ORIGIN}/ide/`, { headers: { Cookie: cookie } });
    assert.strictEqual(res.status, 401, `a deleted editor's embed cookie must be refused (got ${res.status})`);
  });

  test('a live editor keeps working: dashboard routes, embed proxy and real login', async () => {
    const editor = await liveUser('editor', 'still-good');
    const cookie = await embedCookieFor(editor.token);

    for (const path of ['/projects', '/storage']) {
      const res = await req('GET', path, undefined, { Authorization: `Bearer ${editor.token}` });
      assert.strictEqual(res.status, 200, `a live editor must still read ${path} (got ${res.status})`);
    }
    const refresh = await fetch(`${API_URL}/embed/session`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${editor.token}`, Cookie: cookie },
    });
    assert.strictEqual(refresh.status, 200, 'the embed credential is still mintable');

    const login = await fetch(`${API_URL}/auth/login`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ username: editor.username, password: LIVE_USER_PASSWORD }),
    });
    assert.ok([200, 429].includes(login.status), `real login must still work for a live account (got ${login.status})`);
    if (login.status === 200) {
      const body = await login.json() as { id: string; role: string; token: string };
      assert.strictEqual(body.id, editor.id);
      assert.strictEqual(body.role, 'editor');
      const withRealToken = await req('GET', '/projects', undefined, { Authorization: `Bearer ${body.token}` });
      assert.strictEqual(withRealToken.status, 200, 'a genuinely issued session authenticates');
    }
  });
});