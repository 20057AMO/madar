import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import jwt from 'jsonwebtoken';
import type { Res } from './helpers.ts';
import { currentTotp } from '../src/services/totp.ts';

let h: typeof import('./helpers.ts');
let apiUrl = '';
let jwtSecret = '';

// The 10/min-per-IP auth limiter is shared with every other suite (and can
// still be draining from a previous run's window). Back off on exact
// Retry-After instead of letting a 429 flake an otherwise-correct test.
async function postWithBackoff(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(`${apiUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    if (res.status !== 429 || attempt >= 8) return res;
    const secs = Math.max(1, parseInt(String(res.headers.get('Retry-After') || '2'), 10));
    await new Promise((r) => setTimeout(r, secs * 1000 + 250));
  }
}

describe('Auth & access control', () => {
  before(async () => {
    h = await import('./helpers.ts');
    apiUrl = h.API_URL;
    jwtSecret = h.JWT_SECRET;
    await h.initTestAuth();
  });

  test('GET /auth/status is public and reports hasUser', async () => {
    const res = await h.req('GET', '/auth/status');
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(typeof data.hasUser, 'boolean');
  });

  test('protected endpoints reject requests without a token', async () => {
    for (const path of ['/projects', '/providers', '/agents', '/server/info']) {
      const res = await h.req('GET', path);
      assert.strictEqual(res.status, 401, `expected 401 for ${path}, got ${res.status}`);
    }
  });

  test('login rejects wrong credentials with 401', async () => {
    const res = await postWithBackoff('/auth/login', { username: 'no-such-user-xyz', password: 'wrong-pass' });
    assert.strictEqual(res.status, 401);
  });

  test('tokens signed with the wrong secret are rejected', async () => {
    const forged = jwt.sign({ id: 'attacker', username: 'attacker' }, 'completely-wrong-secret', { expiresIn: '1h' });
    const res = await fetch(`${apiUrl}/projects`, { headers: { Authorization: `Bearer ${forged}` } });
    assert.strictEqual(res.status, 401);
  });

  test('tampered token signatures are rejected', async () => {
    const valid = h.signTestToken();
    const tampered = valid.slice(0, -3) + (valid.endsWith('aaa') ? 'bbb' : 'aaa');
    const res = await fetch(`${apiUrl}/projects`, { headers: { Authorization: `Bearer ${tampered}` } });
    assert.strictEqual(res.status, 401);
  });

  test('expired tokens are rejected', async () => {
    const expired = jwt.sign({ id: 'test-user', username: 'test' }, jwtSecret, { expiresIn: '-10s' });
    const res = await fetch(`${apiUrl}/projects`, { headers: { Authorization: `Bearer ${expired}` } });
    assert.strictEqual(res.status, 401);
  });

  test('a correctly signed token grants access', async () => {
    const res = await h.reqAuth('GET', '/projects');
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.projects));
  });

  test('audit log endpoint returns entries array (newest first)', async () => {
    // generate one real event so the log is non-deterministically empty-safe
    await postWithBackoff('/auth/login', { username: 'no-such-user-xyz', password: 'x' });
    const res = await h.reqAuth('GET', '/auth/audit');
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.entries));
    if (data.entries.length > 1) {
      assert.ok(
        new Date(data.entries[0].ts).getTime() >= new Date(data.entries[data.entries.length - 1].ts).getTime(),
        'entries must be newest-first'
      );
    }
  });

  test('setup refuses to run when a user already exists', async () => {
    const statusRes = await h.req('GET', '/auth/status');
    const { hasUser } = await statusRes.json();
    if (!hasUser) return; // nothing to verify on a fresh install
    const res = await postWithBackoff('/auth/setup', { username: 'hijacker', password: 'pass1234' });
    assert.ok([400, 403, 409].includes(res.status), `expected rejection, got ${res.status}`);
  });

  test('login issues a session for the AUTHENTICATED user — editor/viewer identities, not the first admin; 2FA is per-user', async (t) => {
    // Regression: every UI login used to sign the FIRST admin (issueSessionToken)
    // and gate 2FA on usersMap[0]. Prove identity is tied to the resolved user.
    //
    // The deep per-user 2FA journey (enrolling TOTP on a NON-first account) is
    // gated behind WSD_TEST_ACCOUNT_PASSWORD: that extra block spends 4 more
    // slots of the shared 10/min-per-IP auth limiter (2fa-setup, 2fa-enable,
    // the gated editor login, and the viewer re-login; only /login/verify is
    // off-bucket on the separate totp scope), so it only runs against an
    // isolated server (same convention as totp.test.ts). On any server where
    // the FIRST admin has 2FA, the editor-direct-login assertion below is
    // itself the cross-taint regression guard.
    const suffix = h.uniqueId('lg').replace(/-/g, '');
    const editorUser = `login-ed-${suffix}`;
    const viewerUser = `login-vw-${suffix}`;
    const pw = 'Pass-1234-x';
    const doTotpJourney = !!process.env.WSD_TEST_ACCOUNT_PASSWORD;
    const loginUser = (u: string) => postWithBackoff('/auth/login', { username: u, password: pw });

    const created: string[] = [];
    const adminCtl = { 'Content-Type': 'application/json', ...h.authHeaders() };

    const createUser = (username: string, role: string): Promise<Res> =>
      h.req('POST', '/users', { username, password: pw, role }, adminCtl);

    try {
      const editorCreate = await createUser(editorUser, 'editor');
      const editorAcc = editorCreate.status === 201 ? await editorCreate.json() : null;
      assert.ok(editorAcc?.id, `create editor failed with status ${editorCreate.status}`);
      const viewerCreate = await createUser(viewerUser, 'viewer');
      const viewerAcc = viewerCreate.status === 201 ? await viewerCreate.json() : null;
      assert.ok(viewerAcc?.id, `create viewer failed with status ${viewerCreate.status}`);
      created.push(editorAcc.id, viewerAcc.id);

      // ── Editor (no TOTP) → its OWN session, even when the first admin has 2FA.
      const adminId = (jwt.decode(h.authHeaders().Authorization.replace('Bearer ', '')) as jwt.JwtPayload)?.id;
      const e = await loginUser(editorUser);
      assert.strictEqual(e.status, 200);
      const eData = await e.json();
      assert.strictEqual(eData.requires2fa, undefined, 'editor without TOTP must not be challenged');
      assert.strictEqual(eData.pendingToken, undefined, 'direct login must not leak a pending token');
      assert.strictEqual(eData.id, editorAcc.id, 'login must sign the editor, not the first admin');
      assert.strictEqual(eData.role, 'editor');
      const eTok = jwt.verify(eData.token, jwtSecret) as jwt.JwtPayload;
      assert.strictEqual(eTok.id, editorAcc.id, 'JWT id must be the editor');
      assert.strictEqual(eTok.role, 'editor');
      assert.strictEqual(eTok.username, editorUser, 'JWT username must be the editor');
      assert.strictEqual(eTok.scope, undefined, 'a session must never carry the 2fa-pending scope');
      assert.strictEqual(typeof eTok.tv, 'number', 'login must mint a revocation-aware token');
      assert.notStrictEqual(eTok.id, adminId, 'the session must not be the first admin');

      // Editor identity is enforced by requireAdmin (real user, not the admin).
      const denied = await h.req('POST', '/users', { username: `x-${suffix}`, password: pw }, { Authorization: `Bearer ${eData.token}` });
      assert.strictEqual(denied.status, 403, 'editor token must be 403 on admin-only routes');

      // ...while the editor's own session is valid (reads its project list).
      const readProjects = await fetch(`${apiUrl}/projects`, { headers: { Authorization: `Bearer ${eData.token}` } });
      assert.strictEqual(readProjects.status, 200);

      // ── Viewer login → viewer identity; blocking on writes.
      const v = await loginUser(viewerUser);
      assert.strictEqual(v.status, 200);
      const vData = await v.json();
      assert.strictEqual(vData.id, viewerAcc.id);
      assert.strictEqual(vData.role, 'viewer');
      assert.strictEqual((jwt.verify(vData.token, jwtSecret) as jwt.JwtPayload).id, viewerAcc.id);
      // Viewer is blocked from editor-gated endpoints (requireRole('editor')) — project creation
      // itself is open to any authed user, so the import route (editor-only) is the clean probe.
      const vDenied = await h.req('POST', '/projects/import', {}, { Authorization: `Bearer ${vData.token}` });
      assert.strictEqual(vDenied.status, 403, 'viewer token must be 403 on an editor-gated route');

      // ── Per-user 2FA (isolated server only): TOTP belongs to the editor alone.
      if (doTotpJourney) {
        const editorAuth = { Authorization: `Bearer ${eData.token}` };
        const setupRes = await postWithBackoff('/auth/2fa/setup', {}, editorAuth);
        assert.strictEqual(setupRes.status, 200);
        const { secret } = await setupRes.json();
        assert.ok(secret, 'editor must be able to enroll its OWN TOTP');
        const enableRes = await postWithBackoff('/auth/2fa/enable', { code: currentTotp(secret) }, editorAuth);
        assert.strictEqual(enableRes.status, 200);

        // Editor login now demands the code (no session leaked)...
        const gated = await loginUser(editorUser);
        assert.strictEqual(gated.status, 200);
        const gatedData = await gated.json();
        assert.strictEqual(gatedData.requires2fa, true);
        assert.ok(gatedData.pendingToken);
        assert.strictEqual(gatedData.token, undefined, 'challenge must not leak a session');
        assert.strictEqual(
          (jwt.decode(gatedData.pendingToken) as jwt.JwtPayload).id,
          editorAcc.id,
          'the pending token must be minted for the challenged user'
        );

        // ...while the viewer (no TOTP) still logs straight in.
        const v2 = await loginUser(viewerUser);
        assert.strictEqual(v2.status, 200);
        assert.strictEqual((await v2.json()).requires2fa, undefined, 'viewer is unaffected by the editor enrolling 2FA');

        // Verify the code → a session for the EDITOR.
        const verify = await postWithBackoff('/auth/login/verify', { pendingToken: gatedData.pendingToken, code: currentTotp(secret) });
        assert.strictEqual(verify.status, 200);
        const verified = await verify.json();
        assert.strictEqual(verified.id, editorAcc.id, 'verify must sign the editor, not the first admin');
        assert.strictEqual(verified.role, 'editor');
        assert.strictEqual((jwt.verify(verified.token, jwtSecret) as jwt.JwtPayload).id, editorAcc.id);
      } else {
        t.skip('WSD_TEST_ACCOUNT_PASSWORD not set — deep per-user 2FA journey skipped (identity matrix still runs)');
      }
    } finally {
      // Deleting the users (each carrying its own TOTP record once removed) is the cleanup.
      for (const id of created) await h.reqAuth('DELETE', `/users/${id}`);
    }
  });

  test('optional real login works when WSD_TEST_USER/WSD_TEST_PASS are set', async (t) => {
    const user = process.env.WSD_TEST_USER;
    const pass = process.env.WSD_TEST_PASS;
    if (!user || !pass) return t.skip('WSD_TEST_USER / WSD_TEST_PASS not set');
    const res = await fetch(`${apiUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: user, password: pass }),
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.token, 'login response must include a token');
  });

});
