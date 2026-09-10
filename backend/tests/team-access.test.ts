import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import jwt from 'jsonwebtoken';
import { uniqueId, req, reqAuth, initTestAuth, JWT_SECRET, authHeaders } from './helpers.ts';

/**
 * Project ownership + membership + access control (the "Team" scenario).
 * Mirrors a real-life collaboration flow:
 *   admin creates a project → creates an editor & a viewer → adds them as
 *   members → asserts the granular permission matrix (read/write/stop/start)
 *   → tests member listing, removal rules and ownership transfer → cleans up.
 *
 * Requires a live container (Docker) — like projects.lifecycle.test.ts.
 */

// Sign a session-looking JWT for a user (must match the store for real users:
// role is loaded from the store and tv must equal the user's tokenVersion (0)).
function signUser(id: string, username: string, role: string): string {
  return jwt.sign({ id, username, role, tv: 0 }, JWT_SECRET, { expiresIn: '24h' });
}

function runAs(token: string) {
  return {
    headers: { ...authHeaders(), Authorization: `Bearer ${token}` },
  };
}

/**
 * Delete with retry/backoff so cleanup survives transient rate-limit (429)
 * responses during busy full-suite runs — otherwise temp users/projects leak.
 */
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

describe('Project team & access control (real Docker container)', () => {
  before(async () => { await initTestAuth(); });

  const slug = uniqueId('team');
  const editorName = `te_${Date.now().toString(36)}`;
  const viewerName = `tv_${Date.now().toString(36)}`;
  const pw = 'team-pass-123';

  let editorId = '';
  let viewerId = '';
  let editorToken = '';
  let viewerToken = '';
  let created = false;

  after(async () => {
    if (created) {
      await deleteRobust(`/projects/${slug}`);
    }
    // Remove the temporary users so the environment stays clean.
    await deleteRobust(`/users/${viewerId}`);
    await deleteRobust(`/users/${editorId}`);
  });

  test('create the project (owner = admin)', async () => {
    const res = await reqAuth('POST', '/projects', {
      name: 'Team Access Test',
      slug,
      description: 'Temporary project for team/access testing',
    });
    assert.strictEqual(res.status, 201, `create failed: ${res.status}`);
    const data = await res.json();
    assert.strictEqual(data.project.slug, slug);
    created = true;
  });

  test('create an editor and a viewer user', async () => {
    const e = await reqAuth('POST', '/users', { username: editorName, password: pw, role: 'editor' });
    assert.strictEqual(e.status, 201, `create editor failed: ${e.status}`);
    const ed = await e.json();
    editorId = ed.id;

    const v = await reqAuth('POST', '/users', { username: viewerName, password: pw, role: 'viewer' });
    assert.strictEqual(v.status, 201, `create viewer failed: ${v.status}`);
    const vd = await v.json();
    viewerId = vd.id;

    editorToken = signUser(editorId, editorName, 'editor');
    viewerToken = signUser(viewerId, viewerName, 'viewer');
  });

  test('add both users as project members', async () => {
    const r1 = await reqAuth('POST', `/projects/${slug}/members`, { userId: editorId, role: 'editor' });
    assert.strictEqual(r1.status, 200, `add editor: ${r1.status} -> ${JSON.stringify(await r1.json())}`);

    const r2 = await reqAuth('POST', `/projects/${slug}/members`, { userId: viewerId, role: 'viewer' });
    assert.strictEqual(r2.status, 200, `add viewer: ${r2.status} -> ${JSON.stringify(await r2.json())}`);
  });

  test('member list is enriched with usernames', async () => {
    const res = await reqAuth('GET', `/projects/${slug}/members`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.members));
    const usernames = data.members.map((m: any) => m.username);
    assert.ok(usernames.includes(editorName), 'editor should be listed');
    assert.ok(usernames.includes(viewerName), 'viewer should be listed');
    const viewerRec = data.members.find((m: any) => m.userId === viewerId);
    assert.strictEqual(viewerRec.role, 'viewer');
  });

  // ── Viewer: read-only by design ─────────────────────────────
  test('viewer can read the project (200)', async () => {
    const res = await req('GET', `/projects/${slug}`, undefined, runAs(viewerToken).headers);
    assert.strictEqual(res.status, 200);
  });

  test('viewer can read file listing (200)', async () => {
    const res = await req('GET', `/projects/${slug}/files`, undefined, runAs(viewerToken).headers);
    assert.strictEqual(res.status, 200);
  });

  test('viewer can read presence (200)', async () => {
    const res = await req('GET', `/projects/${slug}/presence`, undefined, runAs(viewerToken).headers);
    assert.strictEqual(res.status, 200);
  });

  test('viewer CANNOT write files (403)', async () => {
    const res = await req('PUT', `/projects/${slug}/file?path=forbidden.txt`, { content: 'nope' }, runAs(viewerToken).headers);
    assert.strictEqual(res.status, 403);
  });

  test('viewer CANNOT stop the project (403)', async () => {
    const res = await req('POST', `/projects/${slug}/stop`, undefined, runAs(viewerToken).headers);
    assert.strictEqual(res.status, 403);
  });

  test('viewer CANNOT start the project (403)', async () => {
    const res = await req('POST', `/projects/${slug}/start`, undefined, runAs(viewerToken).headers);
    assert.strictEqual(res.status, 403);
  });

  test('viewer CANNOT add members (403)', async () => {
    const res = await req('POST', `/projects/${slug}/members`, { userId: viewerId, role: 'viewer' }, runAs(viewerToken).headers);
    assert.strictEqual(res.status, 403);
  });

  test('viewer CANNOT duplicate the project (403 — read-only cannot forge a writable copy)', async () => {
    const res = await req('POST', `/projects/${slug}/duplicate`, { name: 'viewer-dup' }, runAs(viewerToken).headers);
    assert.strictEqual(res.status, 403, `viewer duplicate should be denied: ${res.status}`);
  });

  test('viewer CANNOT edit project metadata (403 — PATCH is a write)', async () => {
    const res = await req('PATCH', `/projects/${slug}`, { name: 'renamed-by-viewer' }, runAs(viewerToken).headers);
    assert.strictEqual(res.status, 403, `viewer PATCH should be denied: ${res.status}`);
  });

  // ── Newly-guarded read routes must still work for members (not over-blocked)
  test('viewer can read the member list (200)', async () => {
    const res = await req('GET', `/projects/${slug}/members`, undefined, runAs(viewerToken).headers);
    assert.strictEqual(res.status, 200, `viewer members GET: ${res.status}`);
  });

  test('viewer can read npm scripts (200)', async () => {
    const res = await req('GET', `/projects/${slug}/scripts`, undefined, runAs(viewerToken).headers);
    assert.strictEqual(res.status, 200, `viewer scripts GET: ${res.status}`);
  });

  test('viewer can read subdir info (200)', async () => {
    const res = await req('GET', `/projects/${slug}/subdir`, undefined, runAs(viewerToken).headers);
    assert.strictEqual(res.status, 200, `viewer subdir GET: ${res.status}`);
  });

  // ── Editor: read + write ────────────────────────────────────
  test('editor can read the project (200)', async () => {
    const res = await req('GET', `/projects/${slug}`, undefined, runAs(editorToken).headers);
    assert.strictEqual(res.status, 200);
  });

  test('editor can write a file (200)', async () => {
    const res = await req('PUT', `/projects/${slug}/file?path=todo.txt`, { content: 'team test' }, runAs(editorToken).headers);
    assert.strictEqual(res.status, 200, `editor write: ${res.status}`);
  });

  test('editor can edit project metadata (200 — PATCH still works for writers)', async () => {
    const res = await req('PATCH', `/projects/${slug}`, { name: 'Team Access Test', description: 'Temporary project for team/access testing' }, runAs(editorToken).headers);
    assert.strictEqual(res.status, 200, `editor PATCH: ${res.status} -> ${JSON.stringify(await res.json())}`);
  });

  test('editor can stop the project (200 -> stopped)', async () => {
    const res = await req('POST', `/projects/${slug}/stop`, undefined, runAs(editorToken).headers);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.project.status, 'stopped');
  });

  test('editor can start the project (200 -> running)', async () => {
    const res = await req('POST', `/projects/${slug}/start`, undefined, runAs(editorToken).headers);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.project.status, 'running');
  });

  test('editor CANNOT add members (403 — not a project admin)', async () => {
    const res = await req('POST', `/projects/${slug}/members`, { userId: viewerId, role: 'viewer' }, runAs(editorToken).headers);
    assert.strictEqual(res.status, 403);
  });

  // ── Membership rules ────────────────────────────────────────
  test('viewer CANNOT remove another member (403)', async () => {
    const res = await req('DELETE', `/projects/${slug}/members/${editorId}`, undefined, runAs(viewerToken).headers);
    assert.strictEqual(res.status, 403);
  });

  test('non-member is denied read access (403)', async () => {
    // Forge a token for an unknown user who is not a member and not admin.
    const outsider = jwt.sign({ id: 'outsider-user', username: 'outsider', role: 'viewer', tv: 0 }, JWT_SECRET, { expiresIn: '24h' });
    const res = await req('GET', `/projects/${slug}`, undefined, runAs(outsider).headers);
    assert.strictEqual(res.status, 403);
  });

  test('non-member cannot list members of another project (403)', async () => {
    const outsider = jwt.sign({ id: 'outsider-user-2', username: 'outsider2', role: 'viewer', tv: 0 }, JWT_SECRET, { expiresIn: '24h' });
    const res = await req('GET', `/projects/${slug}/members`, undefined, runAs(outsider).headers);
    assert.strictEqual(res.status, 403, `outsider members GET: ${res.status}`);
  });

  test('non-member cannot read scripts of another project (403)', async () => {
    const outsider = jwt.sign({ id: 'outsider-user-3', username: 'outsider3', role: 'viewer', tv: 0 }, JWT_SECRET, { expiresIn: '24h' });
    const res = await req('GET', `/projects/${slug}/scripts`, undefined, runAs(outsider).headers);
    assert.strictEqual(res.status, 403, `outsider scripts GET: ${res.status}`);
  });

  test('non-member cannot read subdir info of another project (403)', async () => {
    const outsider = jwt.sign({ id: 'outsider-user-4', username: 'outsider4', role: 'viewer', tv: 0 }, JWT_SECRET, { expiresIn: '24h' });
    const res = await req('GET', `/projects/${slug}/subdir`, undefined, runAs(outsider).headers);
    assert.strictEqual(res.status, 403, `outsider subdir GET: ${res.status}`);
  });

  test('non-member cannot edit project metadata (403)', async () => {
    const outsider = jwt.sign({ id: 'outsider-user-5', username: 'outsider5', role: 'viewer', tv: 0 }, JWT_SECRET, { expiresIn: '24h' });
    const res = await req('PATCH', `/projects/${slug}`, { name: 'outsider-rename' }, runAs(outsider).headers);
    assert.strictEqual(res.status, 403, `outsider PATCH: ${res.status}`);
  });

  // ── Global editor: system editors reach every project ─────────
  test('global editor (no membership) can read any project (200)', async () => {
    const ge = jwt.sign({ id: 'global-editor-user', username: 'global-editor', role: 'editor', tv: 0 }, JWT_SECRET, { expiresIn: '24h' });
    const res = await req('GET', `/projects/${slug}`, undefined, runAs(ge).headers);
    assert.strictEqual(res.status, 200, `global editor read: ${res.status}`);
  });

  test('global editor can write a file without membership (200)', async () => {
    const ge = jwt.sign({ id: 'global-editor-user', username: 'global-editor', role: 'editor', tv: 0 }, JWT_SECRET, { expiresIn: '24h' });
    const res = await req('PUT', `/projects/${slug}/file?path=global-editor.txt`, { content: 'global editor write' }, runAs(ge).headers);
    assert.strictEqual(res.status, 200, `global editor write: ${res.status}`);
  });

  test('global editor can edit project metadata (200)', async () => {
    const ge = jwt.sign({ id: 'global-editor-user', username: 'global-editor', role: 'editor', tv: 0 }, JWT_SECRET, { expiresIn: '24h' });
    const res = await req('PATCH', `/projects/${slug}`, { name: 'Team Access Test', description: 'Temporary project for team/access testing' }, runAs(ge).headers);
    assert.strictEqual(res.status, 200, `global editor PATCH: ${res.status}`);
  });

  test('global editor CANNOT add members (403 — project-admin op)', async () => {
    const ge = jwt.sign({ id: 'global-editor-user', username: 'global-editor', role: 'editor', tv: 0 }, JWT_SECRET, { expiresIn: '24h' });
    const res = await req('POST', `/projects/${slug}/members`, { userId: viewerId, role: 'viewer' }, runAs(ge).headers);
    assert.strictEqual(res.status, 403, `global editor add member: ${res.status}`);
  });

  test('global editor CANNOT transfer ownership (403 — owner/admin only)', async () => {
    const ge = jwt.sign({ id: 'global-editor-user', username: 'global-editor', role: 'editor', tv: 0 }, JWT_SECRET, { expiresIn: '24h' });
    const res = await req('POST', `/projects/${slug}/transfer-owner`, { userId: viewerId }, runAs(ge).headers);
    assert.strictEqual(res.status, 403, `global editor transfer-owner: ${res.status}`);
  });

  test('global editor CANNOT delete the project (403 — admin-level op)', async () => {
    const ge = jwt.sign({ id: 'global-editor-user', username: 'global-editor', role: 'editor', tv: 0 }, JWT_SECRET, { expiresIn: '24h' });
    const res = await req('DELETE', `/projects/${slug}`, undefined, runAs(ge).headers);
    assert.strictEqual(res.status, 403, `global editor delete: ${res.status}`);
  });

  test('owner can remove the editor member (200)', async () => {
    const res = await reqAuth('DELETE', `/projects/${slug}/members/${editorId}`);
    assert.strictEqual(res.status, 200);
  });

  // ── Ownership transfer ──────────────────────────────────────
  test('owner transfers ownership to the editor', async () => {
    const res = await reqAuth('POST', `/projects/${slug}/transfer-owner`, { userId: editorId });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.ok, true);
    assert.strictEqual(data.ownerId, editorId);
  });

  test('new owner has admin rights on the project', async () => {
    // Re-add editor as a member so we can confirm project-admin powers.
    await reqAuth('POST', `/projects/${slug}/members`, { userId: editorId, role: 'admin' });
    const res = await req('POST', `/projects/${slug}/members`, { userId: viewerId, role: 'viewer' }, runAs(editorToken).headers);
    // As owner the editor is a project admin now → can add members.
    assert.strictEqual(res.status, 200);
  });

  test('delete removes the project (cleanup marker)', async () => {
    const res = await reqAuth('DELETE', `/projects/${slug}`);
    assert.strictEqual(res.status, 200);
    created = false;
  });
});
