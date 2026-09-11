import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import jwt from 'jsonwebtoken';
import { uniqueId, req, reqAuth, initTestAuth, JWT_SECRET, authHeaders, API_URL, JSON_HEADERS } from './helpers.ts';

/**
 * Team page & permissions round:
 *  - GET /api/users/with-memberships — full-team roster with per-user project
 *    affiliations, now ADMIN-ONLY (the project-level Team tab keeps the open
 *    GET /api/users route for regular members).
 *  - Role changes are sudo ops — the acting admin must re-confirm their
 *    account password (missing → 400, wrong → 401, correct → 200).
 *  - Activity attribution — project lifecycle events carry the acting user's
 *    id (who stopped/started), not just an anonymous action string.
 *  - Safety guard — an admin cannot demote their own system role.
 *  - Membership governance is audited (member-added / ownership-transferred
 *    land in the security log / account activity).
 *
 * Requires a live container (Docker) — like team-access.test.ts.
 */

function signUser(id: string, username: string, role: string): string {
  return jwt.sign({ id, username, role, tv: 0 }, JWT_SECRET, { expiresIn: '24h' });
}

function runAs(token: string) {
  return {
    headers: { ...authHeaders(), Authorization: `Bearer ${token}` },
  };
}

async function requestWithBackoff(method: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(`${API_URL}${path}`, {
      method: method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    if (res.status !== 429 || attempt >= 20) return res;
    const secs = Math.max(1, parseInt(String(res.headers.get('Retry-After') || '2'), 10));
    await new Promise((r) => setTimeout(r, secs * 1000 + 250));
  }
}

async function deleteRobust(path: string, attempts = 20): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await reqAuth('DELETE', path);
      if (res.status === 200 || res.status === 404) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

describe('Team page & permissions (real Docker container)', () => {
  before(async () => { await initTestAuth(); });

  const slug = uniqueId('teampage');
  const editorName = `tp_${Date.now().toString(36)}`;
  const viewerName = `tv_${Date.now().toString(36)}`;
  const pw = 'teampage-pass-123';

  let editorId = '';
  let viewerId = '';
  let editorToken = '';
  let viewerToken = '';
  let created = false;

  after(async () => {
    if (created) {
      await deleteRobust(`/projects/${slug}`);
    }
    await deleteRobust(`/users/${viewerId}`);
    await deleteRobust(`/users/${editorId}`);
  });

  test('with-memberships requires a session (401)', async () => {
    const res = await req('GET', '/users/with-memberships');
    assert.strictEqual(res.status, 401);
  });

  test('create project + editor/viewer users + memberships', async () => {
    const prj = await reqAuth('POST', '/projects', { name: 'Team Page Test', slug, description: 'temp' });
    assert.strictEqual(prj.status, 201, `create project: ${prj.status}`);
    created = true;

    const e = await reqAuth('POST', '/users', { username: editorName, password: pw, role: 'editor' });
    assert.strictEqual(e.status, 201);
    editorId = (await e.json()).id;
    const v = await reqAuth('POST', '/users', { username: viewerName, password: pw, role: 'viewer' });
    assert.strictEqual(v.status, 201);
    viewerId = (await v.json()).id;

    editorToken = signUser(editorId, editorName, 'editor');
    viewerToken = signUser(viewerId, viewerName, 'viewer');

    const r1 = await reqAuth('POST', `/projects/${slug}/members`, { userId: editorId, role: 'editor' });
    assert.strictEqual(r1.status, 200, `add editor: ${r1.status}`);
    const r2 = await reqAuth('POST', `/projects/${slug}/members`, { userId: viewerId, role: 'viewer' });
    assert.strictEqual(r2.status, 200, `add viewer: ${r2.status}`);
  });

  test('with-memberships is admin-only — viewers and editors get 403', async () => {
    const viewer = await req('GET', '/users/with-memberships', undefined, runAs(viewerToken).headers);
    assert.strictEqual(viewer.status, 403, 'viewer with-memberships: must be 403');
    const editor = await req('GET', '/users/with-memberships', undefined, runAs(editorToken).headers);
    assert.strictEqual(editor.status, 403, 'editor with-memberships: must be 403');

    // Admin sees the full roster with per-user project affiliations.
    const admin = await reqAuth('GET', '/users/with-memberships');
    assert.strictEqual(admin.status, 200);
    const data = await admin.json();
    assert.ok(Array.isArray(data.users));

    const editorRow = data.users.find((u: any) => u.id === editorId);
    assert.ok(editorRow, 'editor appears in the roster');
    const membership = editorRow.memberships.find((m: any) => m.slug === slug);
    assert.ok(membership, 'editor is affiliated to the project');
    assert.strictEqual(membership.role, 'editor');
    assert.strictEqual(membership.isOwner, false);

    const viewerRow = data.users.find((u: any) => u.id === viewerId);
    const viewerMembership = viewerRow.memberships.find((m: any) => m.slug === slug);
    assert.strictEqual(viewerMembership.role, 'viewer');
  });

  test('roster is read-only for viewers — no admin write surface leaks', async () => {
    const res = await req('PATCH', `/users/${viewerId}/role`, { role: 'admin' }, runAs(viewerToken).headers);
    assert.strictEqual(res.status, 403, 'viewer cannot change roles');
  });

  test('admin cannot demote their own role (400 — lockout guard)', async () => {
    await new Promise(r => setTimeout(r, 2000));
    // The shared forged admin token pads id 'test-user'; PATCH own role away
    // from admin must be refused before any store write (and before any
    // password check — a self-demote is a lockout, not a mutation).
    const res = await requestWithBackoff('PATCH', `/users/test-user/role`, { role: 'viewer', accountPassword: 'irrelevant' }, authHeaders());
    assert.strictEqual(res.status, 400, `self-demote: ${res.status}`);
    const body = await res.json();
    assert.match(String(body.error || ''), /own role/i);
  });

  test('role change requires the admin account password (missing 400, wrong 401)', async () => {
    const missing = await requestWithBackoff('PATCH', `/users/${viewerId}/role`, { role: 'editor' }, { ...authHeaders(), 'Content-Type': 'application/json' });
    assert.strictEqual(missing.status, 400, 'role change without password must be 400');

    const wrong = await requestWithBackoff('PATCH', `/users/${viewerId}/role`, { role: 'editor', accountPassword: 'definitely-not-the-password' }, { ...authHeaders(), 'Content-Type': 'application/json' });
    assert.strictEqual(wrong.status, 401, 'role change with a wrong password must be 401');
    const wrongBody = await wrong.json();
    assert.match(String(wrongBody.error || ''), /incorrect/i);

    // A failed sudo attempt does not mutate the role.
    const roster = await (await reqAuth('GET', '/users/with-memberships')).json();
    const viewerRow = (roster.users as any[]).find((u: any) => u.id === viewerId);
    assert.strictEqual(viewerRow.role, 'viewer');
  });

  test('role change succeeds after sudo verification (real admin login; self-skips)', async (t) => {
    // The sudo check validates the ACTING admin's own password, so we need a
    // real session — forged tokens resolve to an unknown user id. Mirror the
    // shared helpers: the suite container's first admin is created via setup
    // as 'test-admin' (or login with WSD_TEST_ACCOUNT_PASSWORD).
    const pw = process.env.WSD_TEST_ACCOUNT_PASSWORD || 'test-password-123';
    const loginRes = await req('POST', '/auth/login', { username: 'test-admin', password: pw });
    const loginData = await loginRes.json();
    if (!loginData.token) return t.skip('no real admin login available (set WSD_TEST_ACCOUNT_PASSWORD)');
    const realAdmin = { headers: { ...authHeaders(), Authorization: `Bearer ${loginData.token}` } };

    const ok = await req('PATCH', `/users/${viewerId}/role`, { role: 'editor', accountPassword: pw }, realAdmin.headers);
    assert.strictEqual(ok.status, 200, `role change with correct password: ${ok.status}`);

    const roster = await (await req('GET', '/users/with-memberships', undefined, realAdmin.headers)).json();
    const viewerRow = (roster.users as any[]).find((u: any) => u.id === viewerId);
    assert.strictEqual(viewerRow.role, 'editor', 'role persisted after sudo');

    // Revert so the rest of the suite sees viewer as a viewer.
    const rev = await req('PATCH', `/users/${viewerId}/role`, { role: 'viewer', accountPassword: pw }, realAdmin.headers);
    assert.strictEqual(rev.status, 200);
  });

  test('project activity is attributed (stopped/started carry the acting user)', async () => {
    const stop = await req('POST', `/projects/${slug}/stop`, undefined, runAs(editorToken).headers);
    assert.strictEqual(stop.status, 200);

    const start = await req('POST', `/projects/${slug}/start`, undefined, runAs(editorToken).headers);
    assert.strictEqual(start.status, 200);

    const detail = await req('GET', `/projects/${slug}`, undefined, runAs(viewerToken).headers);
    assert.strictEqual(detail.status, 200);
    const project = (await detail.json()).project || (await detail.json());
    const acts: any[] = project.activity || [];
    const stopEntry = acts.find((a) => a.action === 'stopped');
    assert.ok(stopEntry, 'stop action recorded');
    assert.strictEqual(stopEntry.userId, editorId, 'stop attributed to the actor');
    const startEntry = acts.find((a) => a.action === 'started');
    assert.ok(startEntry, 'start action recorded');
    assert.strictEqual(startEntry.userId, editorId, 'start attributed to the actor');
    const createdEntry = acts.find((a) => a.action === 'created');
    assert.ok(createdEntry, 'created action recorded');
  });

  test('membership governance is audited (member-added)', async () => {
    const auditRes = await reqAuth('GET', '/auth/audit');
    assert.strictEqual(auditRes.status, 200);
    const entries: any[] = (await auditRes.json()).entries;
    assert.ok(
      entries.some((e) => e.event === 'member-added' && e.userId === editorId),
      'member-added audit entry exists for the editor'
    );
  });

  test('ownership transfer is a sudo op and lands in the roster + audit (real login; self-skips)', async (t) => {
    const pw = process.env.WSD_TEST_ACCOUNT_PASSWORD || 'test-password-123';
    const loginRes = await req('POST', '/auth/login', { username: 'test-admin', password: pw });
    const loginData = await loginRes.json();
    if (!loginData.token) return t.skip('no real admin login available (set WSD_TEST_ACCOUNT_PASSWORD)');
    const realAdmin = { headers: { ...authHeaders(), Authorization: `Bearer ${loginData.token}` } };

    // The acting admin must re-confirm their account password — missing → 400,
    // wrong → 401, correct → 200 (transfer mutates nothing on a failed sudo).
    const missing = await req('POST', `/projects/${slug}/transfer-owner`, { userId: editorId }, realAdmin.headers);
    assert.strictEqual(missing.status, 400, 'transfer without password must be 400');
    const wrong = await requestWithBackoff('POST', `/projects/${slug}/transfer-owner`, { userId: editorId, accountPassword: 'definitely-not-the-password' }, realAdmin.headers);
    assert.strictEqual(wrong.status, 401, 'transfer with a wrong password must be 401');

    // Ownership transfer to the editor → audited and reflected by the roster.
    const transfer = await requestWithBackoff('POST', `/projects/${slug}/transfer-owner`, { userId: editorId, accountPassword: pw }, realAdmin.headers);
    assert.strictEqual(transfer.status, 200, 'transfer with the correct password must be 200');

    const roster = await (await req('GET', '/users/with-memberships', undefined, realAdmin.headers)).json();
    const editorRow = (roster.users as any[]).find((u: any) => u.id === editorId);
    assert.strictEqual(editorRow.memberships.find((m: any) => m.slug === slug).isOwner, true);

    const auditRes2 = await reqAuth('GET', '/auth/audit');
    const entries2: any[] = (await auditRes2.json()).entries;
    assert.ok(
      entries2.some((e) => e.event === 'ownership-transferred' && e.userId === editorId),
      'ownership-transferred audit entry exists for the new owner'
    );
  });
});