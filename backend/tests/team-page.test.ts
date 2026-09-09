import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import jwt from 'jsonwebtoken';
import { uniqueId, req, reqAuth, initTestAuth, JWT_SECRET, authHeaders } from './helpers.ts';

/**
 * Team page & permissions round:
 *  - GET /api/users/with-memberships — read-only roster with per-user project
 *    affiliations, open to ANY authenticated user (viewer included).
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

  test('viewer can read the team roster with memberships (200)', async () => {
    const res = await req('GET', '/users/with-memberships', undefined, runAs(viewerToken).headers);
    assert.strictEqual(res.status, 200, `viewer with-memberships: ${res.status}`);
    const data = await res.json();
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
    // The shared forged admin token pads id 'test-user'; PATCH own role away
    // from admin must be refused before any store write.
    const res = await reqAuth('PATCH', `/users/test-user/role`, { role: 'viewer' });
    assert.strictEqual(res.status, 400, `self-demote: ${res.status}`);
    const body = await res.json();
    assert.match(String(body.error || ''), /own role/i);

    // A real target is still changeable → transfer the guard did not break it.
    const ok = await reqAuth('PATCH', `/users/${viewerId}/role`, { role: 'editor' });
    assert.strictEqual(ok.status, 200, `change other role: ${ok.status}`);
    await reqAuth('PATCH', `/users/${viewerId}/role`, { role: 'viewer' });
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

  test('membership governance is audited (member-added + ownership-transferred)', async () => {
    const auditRes = await reqAuth('GET', '/auth/audit');
    assert.strictEqual(auditRes.status, 200);
    const entries: any[] = (await auditRes.json()).entries;
    assert.ok(
      entries.some((e) => e.event === 'member-added' && e.userId === editorId),
      'member-added audit entry exists for the editor'
    );

    // Ownership transfer to the editor → audited and reflected by the roster.
    const transfer = await reqAuth('POST', `/projects/${slug}/transfer-owner`, { userId: editorId });
    assert.strictEqual(transfer.status, 200);

    const roster = await (await req('GET', '/users/with-memberships', undefined, runAs(editorToken).headers)).json();
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