import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import jwt from 'jsonwebtoken';
import { uniqueId, req, reqAuth, initTestAuth, JWT_SECRET, authHeaders, API_URL, liveUser, cleanupLiveUsers } from './helpers.ts';

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

// The two actors that must NOT be project members: a non-member viewer
// outsider and a system-role editor ("global editor"). Both are REAL accounts —
// verifyToken refuses an id that is not in users.json, so a ghost id would turn
// every authorization row below into a 401 that proves nothing.
let outsiderToken = '';
let globalEditorToken = '';

function runAs(token: string) {
  return {
    headers: { ...authHeaders(), Authorization: `Bearer ${token}` },
  };
}

async function postWithBackoff(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    if (res.status !== 429 || attempt >= 8) return res;
    const secs = Math.max(1, parseInt(String(res.headers.get('Retry-After') || '2'), 10));
    await new Promise((r) => setTimeout(r, secs * 1000 + 250));
  }
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
  before(async () => {
    outsiderToken = (await liveUser('viewer', 'team-outsider')).token;
    globalEditorToken = (await liveUser('editor', 'team-global-editor')).token;
  });

  const slug = uniqueId('team');
  const editorName = `te_${Date.now().toString(36)}`;
  const viewerName = `tv_${Date.now().toString(36)}`;
  const pw = 'team-pass-123';

  let editorId = '';
  let viewerId = '';
  let editorToken = '';
  let viewerToken = '';
  let created = false;
  let ownerTransferred = false;
  const editorProjectSlug = uniqueId('team-editor-create');
  let editorProjectCreated = false;
  // Dedicated throwaway project for the ownership-escalation rows: the viewer
  // account is an EDITOR MEMBER here, so only a system-role gate can refuse it
  // (the membership check alone would let it through).
  const escalationSlug = uniqueId('team-escalation');
  let escalationCreated = false;
  const dupSlug = uniqueId('team-dup');
  let dupProjectSlug = '';

  after(async () => {
    if (created) {
      await deleteRobust(`/projects/${slug}`);
    }
    if (editorProjectCreated) {
      await deleteRobust(`/projects/${editorProjectSlug}`);
    }
    if (escalationCreated) {
      await deleteRobust(`/projects/${escalationSlug}`);
    }
    if (dupProjectSlug) {
      await deleteRobust(`/projects/${dupProjectSlug}`);
    }
    // Remove the temporary users so the environment stays clean.
    await deleteRobust(`/users/${viewerId}`);
    await deleteRobust(`/users/${editorId}`);
    await cleanupLiveUsers();
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

  // ── Creating a project is editor+ (privilege-escalation gate) ──
  // POST /api/projects writes the caller as `ownerId` + an admin member, and
  // decideControlAccess admits the owner to `mode=control` — a root PTY in the
  // app container, which mounts /var/run/docker.sock. Ungated, a viewer could
  // self-appoint as owner and escalate to host RCE, so the route is gated.
  test('viewer CANNOT create a project (403 — no self-appointed owner ⇒ no control PTY)', async () => {
    const attemptedSlug = uniqueId('team-viewer-create');
    const res = await postWithBackoff('/projects', {
      name: 'Viewer Project Attempt',
      slug: attemptedSlug,
    }, runAs(viewerToken).headers);
    const data = await res.json();
    assert.strictEqual(res.status, 403, `viewer create should be denied: ${res.status} -> ${JSON.stringify(data)}`);

    const list = await reqAuth('GET', '/projects');
    assert.strictEqual(list.status, 200, `project list: ${list.status}`);
    const listData = await list.json();
    const slugs = (listData.projects as any[]).map((p: any) => p.slug);
    assert.ok(!slugs.includes(attemptedSlug), `a refused create must persist nothing, but ${attemptedSlug} exists`);
  });

  test('editor CAN create a project (201 — min-role gate admits editor+)', async () => {
    const res = await postWithBackoff('/projects', {
      name: 'Editor Created Project',
      slug: editorProjectSlug,
    }, runAs(editorToken).headers);
    const data = await res.json();
    assert.strictEqual(res.status, 201, `editor create should be allowed: ${res.status} -> ${JSON.stringify(data)}`);
    editorProjectCreated = true;
    assert.strictEqual(data.project.slug, editorProjectSlug);
  });

  // ── Ownership-granting routes are editor+ (the second escalation path) ──
  // Boot the dedicated project here: the viewer account is deliberately an
  // `editor` MEMBER of it, so `requireProjectAccess('editor')` is satisfied and
  // only the `requireRole('editor')` system gate stands between that viewer and
  // project ownership (⇒ `mode=control` root PTY beside the docker socket).
  test('set up an escalation project where the viewer is an editor member', async () => {
    const res = await postWithBackoff('/projects', {
      name: 'Escalation Probe',
      slug: escalationSlug,
      description: 'Throwaway project for the ownership-escalation rows',
    }, authHeaders());
    const data = await res.json();
    assert.strictEqual(res.status, 201, `escalation project create: ${res.status} -> ${JSON.stringify(data)}`);
    escalationCreated = true;

    const add = await postWithBackoff(`/projects/${escalationSlug}/members`, { userId: viewerId, role: 'editor' }, authHeaders());
    const addData = await add.json();
    assert.strictEqual(add.status, 200, `add viewer as editor member: ${add.status} -> ${JSON.stringify(addData)}`);
  });

  test('viewer member with editor rights CANNOT duplicate (403 — no self-appointed owner)', async (t) => {
    if (!escalationCreated) return t.skip('escalation project could not be created');
    const res = await postWithBackoff(`/projects/${escalationSlug}/duplicate`, {
      name: 'viewer-escalation-dup',
      slug: dupSlug,
    }, runAs(viewerToken).headers);
    const data = await res.json();
    assert.strictEqual(
      res.status,
      403,
      `an editor MEMBER whose system role is viewer must not duplicate: ${res.status} -> ${JSON.stringify(data)}`
    );
    // A refused duplicate must leave nothing behind — the copy would have made
    // the caller its owner (⇒ root control PTY).
    const list = await reqAuth('GET', '/projects');
    assert.strictEqual(list.status, 200, `project list: ${list.status}`);
    const listData = await list.json();
    const slugs = (listData.projects as any[]).map((p: any) => p.slug);
    // duplicateProject dedupes by suffixing -1, -2, … so the ghost copy would not
    // be named exactly `dupSlug`; refuse ANY slug derived from it.
    assert.ok(
      !slugs.some((s: any) => s === dupSlug || String(s).startsWith(dupSlug + '-')),
      `a refused duplicate must persist nothing, but a copy of ${dupSlug} exists`
    );
  });

  test('viewer member with editor rights CANNOT restore a snapshot as a new project (403)', async (t) => {
    if (!escalationCreated) return t.skip('escalation project could not be created');
    // The gate runs before any archive lookup, so the filename need only match
    // the strict stored-snapshot shape — no capture is required for this row.
    const file = `madar-${escalationSlug}-00000000000000000.tar.gz`;
    const res = await postWithBackoff(`/projects/${escalationSlug}/snapshots/${file}/restore`, {}, runAs(viewerToken).headers);
    const data = await res.json();
    assert.strictEqual(
      res.status,
      403,
      `an editor MEMBER whose system role is viewer must not restore: ${res.status} -> ${JSON.stringify(data)}`
    );
  });

  // ── Agent delegation: agent execution is a SYSTEM-role capability ──
  // EVERY delegated agent runs edit/bash/task tools inside the app container
  // (docker.sock mounted rw + data/jwt.secret, no file jail — even a denied
  // agent can read the secret or another project's files), so project
  // membership alone must not reach it, whatever the agent's capability label:
  // the same bar POST /api/embed/session applies.
  test('viewer member with project-editor role CANNOT launch a write agent (403 — agent execution needs a system editor)', async (t) => {
    if (!escalationCreated) return t.skip('escalation project could not be created');
    // Deterministic even when opencode is offline: the role bar and the access
    // gate run BEFORE the server probe, so this is a 403 in every environment.
    const res = await postWithBackoff(
      '/opencode/delegate/' + escalationSlug,
      { agent: 'backend-developer', prompt: 'touch /tmp/x' },
      runAs(viewerToken).headers
    );
    const data = await res.json();
    assert.strictEqual(
      res.status,
      403,
      `an editor MEMBER whose system role is viewer must not launch a write agent: ${res.status} -> ${JSON.stringify(data)}`
    );
    assert.strictEqual(data.error, 'Access denied to this project');
  });

  test('viewer member with project-editor role CANNOT launch a READONLY agent either (403 — the bar is the SYSTEM role, not the capability)', async (t) => {
    if (!escalationCreated) return t.skip('escalation project could not be created');
    // 'readonly' is no longer an access tier. It used to be reachable by a
    // viewer+, which was wrong: with no file jail a denied-tools agent can
    // still read /app/data/jwt.secret (or another project's workspace) and
    // return the text, so every delegation is the same privilege class.
    // Deterministic even when opencode is offline: the system-role bar runs
    // BEFORE the access gate and the server probe, so this is a 403 in every
    // environment.
    const res = await postWithBackoff(
      '/opencode/delegate/' + escalationSlug,
      { agent: 'code-reviewer', prompt: 'review' },
      runAs(viewerToken).headers
    );
    const data = await res.json();
    assert.strictEqual(
      res.status,
      403,
      `an editor MEMBER whose system role is viewer must not launch a readonly agent: ${res.status} -> ${JSON.stringify(data)}`
    );
    assert.strictEqual(data.error, 'Access denied to this project');
  });

  test('admin CAN duplicate the escalation project (201 — the gate is min-role, not anti-duplicate)', async (t) => {
    if (!escalationCreated) return t.skip('escalation project could not be created');
    const res = await postWithBackoff(`/projects/${escalationSlug}/duplicate`, {
      name: 'Escalation Duplicate',
      slug: dupSlug,
    }, authHeaders());
    const data = await res.json();
    assert.strictEqual(res.status, 201, `admin duplicate should be allowed: ${res.status} -> ${JSON.stringify(data)}`);
    dupProjectSlug = String(data.project.slug || '');
    assert.ok(dupProjectSlug, 'the response must name the new project slug');
    assert.notStrictEqual(dupProjectSlug, escalationSlug, 'a duplicate is a NEW project, never the source');
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
    const outsider = outsiderToken;
    const res = await req('GET', `/projects/${slug}`, undefined, runAs(outsider).headers);
    assert.strictEqual(res.status, 403);
  });

  test('non-member cannot list members of another project (403)', async () => {
    const outsider = outsiderToken;
    const res = await req('GET', `/projects/${slug}/members`, undefined, runAs(outsider).headers);
    assert.strictEqual(res.status, 403, `outsider members GET: ${res.status}`);
  });

  test('non-member cannot read scripts of another project (403)', async () => {
    const outsider = outsiderToken;
    const res = await req('GET', `/projects/${slug}/scripts`, undefined, runAs(outsider).headers);
    assert.strictEqual(res.status, 403, `outsider scripts GET: ${res.status}`);
  });

  test('non-member cannot read subdir info of another project (403)', async () => {
    const outsider = outsiderToken;
    const res = await req('GET', `/projects/${slug}/subdir`, undefined, runAs(outsider).headers);
    assert.strictEqual(res.status, 403, `outsider subdir GET: ${res.status}`);
  });

  test('non-member cannot edit project metadata (403)', async () => {
    const outsider = outsiderToken;
    const res = await req('PATCH', `/projects/${slug}`, { name: 'outsider-rename' }, runAs(outsider).headers);
    assert.strictEqual(res.status, 403, `outsider PATCH: ${res.status}`);
  });

  // ── Global editor: system editors reach every project ─────────
  test('global editor (no membership) can read any project (200)', async () => {
    const ge = globalEditorToken;
    const res = await req('GET', `/projects/${slug}`, undefined, runAs(ge).headers);
    assert.strictEqual(res.status, 200, `global editor read: ${res.status}`);
  });

  test('global editor can write a file without membership (200)', async () => {
    const ge = globalEditorToken;
    const res = await req('PUT', `/projects/${slug}/file?path=global-editor.txt`, { content: 'global editor write' }, runAs(ge).headers);
    assert.strictEqual(res.status, 200, `global editor write: ${res.status}`);
  });

  test('global editor can edit project metadata (200)', async () => {
    const ge = globalEditorToken;
    const res = await req('PATCH', `/projects/${slug}`, { name: 'Team Access Test', description: 'Temporary project for team/access testing' }, runAs(ge).headers);
    assert.strictEqual(res.status, 200, `global editor PATCH: ${res.status}`);
  });

  test('global editor CANNOT add members (403 — project-admin op)', async () => {
    const ge = globalEditorToken;
    const res = await req('POST', `/projects/${slug}/members`, { userId: viewerId, role: 'viewer' }, runAs(ge).headers);
    assert.strictEqual(res.status, 403, `global editor add member: ${res.status}`);
  });

  test('global editor CANNOT transfer ownership (403 — owner/admin only)', async () => {
    const ge = globalEditorToken;
    const res = await req('POST', `/projects/${slug}/transfer-owner`, { userId: viewerId }, runAs(ge).headers);
    assert.strictEqual(res.status, 403, `global editor transfer-owner: ${res.status}`);
  });

  test('global editor CANNOT delete the project (403 — admin-level op)', async () => {
    const ge = globalEditorToken;
    const res = await req('DELETE', `/projects/${slug}`, undefined, runAs(ge).headers);
    assert.strictEqual(res.status, 403, `global editor delete: ${res.status}`);
  });

  test('owner can remove the editor member (200)', async () => {
    const res = await reqAuth('DELETE', `/projects/${slug}/members/${editorId}`);
    assert.strictEqual(res.status, 200);
  });

  // ── Ownership transfer (sudo op) ────────────────────────────
  test('transfer-owner requires the account password (400)', async () => {
    const res = await postWithBackoff(
      `/projects/${slug}/transfer-owner`,
      { userId: editorId },
      authHeaders()
    );
    assert.strictEqual(res.status, 400, `transfer without password: ${res.status}`);
    const body = await res.json();
    assert.match(String(body.error || ''), /password/i);
  });

  test('transfer-owner rejects a wrong account password (401)', async () => {
    const res = await postWithBackoff(`/projects/${slug}/transfer-owner`, {
      userId: editorId,
      accountPassword: 'definitely-not-the-password',
    }, authHeaders());
    assert.strictEqual(res.status, 401, `transfer wrong password: ${res.status}`);
    const body = await res.json();
    assert.match(String(body.error || ''), /incorrect/i);
  });

  test('an admin member passes the transfer gate (sudo still demanded → 401 on a forged session)', async () => {
    // Project-admins manage membership, so the transfer gate must open for an
    // admin member too (not just owner/system-admin) — then STILL demand the
    // acting user's real password. A viewer member, by contrast, stays 403.
    const up = await reqAuth('POST', `/projects/${slug}/members`, { userId: editorId, role: 'admin' });
    assert.strictEqual(up.status, 200, `upgrade editor to admin member: ${up.status}`);

    const res = await postWithBackoff(`/projects/${slug}/transfer-owner`, { userId: viewerId, accountPassword: 'x' }, runAs(editorToken).headers);
    assert.strictEqual(res.status, 401, `admin-member transfer gate: expected 401 (sudo), got ${res.status}`);
    const body = await res.json();
    assert.match(String(body.error || ''), /incorrect/i);
  });

  test('owner transfers ownership to the editor (sudo; real admin login, self-skips)', async (t) => {
    // Transfer is now a sudo op: verifyAccountPassword validates the ACTING
    // owner's own password, so we need a real session (forged tokens resolve to
    // an unknown id). Mirror the role-change test pattern.
    const pw = process.env.WSD_TEST_ACCOUNT_PASSWORD || 'test-password-123';
    const loginRes = await req('POST', '/auth/login', { username: 'test-admin', password: pw });
    const loginData = await loginRes.json();
    if (!loginData.token) return t.skip('no real admin login available (set WSD_TEST_ACCOUNT_PASSWORD)');
    const realAdmin = { headers: { ...authHeaders(), Authorization: `Bearer ${loginData.token}` } };

    const res = await postWithBackoff(`/projects/${slug}/transfer-owner`, { userId: editorId, accountPassword: pw }, realAdmin.headers);
    assert.strictEqual(res.status, 200, `transfer with correct password: ${res.status}`);
    const data = await res.json();
    assert.strictEqual(data.ok, true);
    assert.strictEqual(data.ownerId, editorId);
    ownerTransferred = true;

    // Deterministic ownership: the new owner is an explicit admin member AND
    // the former owner stays an explicit admin member — a legacy project with
    // no members row for the old owner must never lose silent access.
    const members = await (await req('GET', `/projects/${slug}/members`, undefined, realAdmin.headers)).json();
    const editorRow = (members.members as any[]).find((m: any) => m.userId === editorId);
    assert.strictEqual(editorRow.role, 'admin', 'new owner is an admin member');
    assert.ok(
      (members.members as any[]).some((m: any) => m.userId !== editorId && m.userId !== viewerId && m.role === 'admin'),
      'former owner remains an explicit admin member'
    );
  });

  test('transferring to the current owner is refused (400)', async (t) => {
    if (!ownerTransferred) return t.skip('requires the sudo transfer above (WSD_TEST_ACCOUNT_PASSWORD)');
    const res = await postWithBackoff(
      `/projects/${slug}/transfer-owner`,
      { userId: editorId },
      authHeaders()
    );
    assert.strictEqual(res.status, 400, `self-transfer: ${res.status}`);
    const body = await res.json();
    assert.match(String(body.error || ''), /already the project owner/i);
  });

  test('new owner has admin rights on the project', async () => {
    // Re-add editor as an explicit admin member so we can confirm project-admin
    // powers regardless of whether the sudo transfer above ran.
    await reqAuth('POST', `/projects/${slug}/members`, { userId: editorId, role: 'admin' });
    const res = await req('POST', `/projects/${slug}/members`, { userId: viewerId, role: 'viewer' }, runAs(editorToken).headers);
    // As owner (or admin member) the editor is a project admin → can add members.
    assert.strictEqual(res.status, 200);
  });

  test('deleting a user who owns a project is refused (400)', async (t) => {
    // The owner-delete guard: while the editor owns the project, admin DELETE
    // /users/:id must refuse with the project name instead of orphaning it.
    if (!ownerTransferred) return t.skip('requires the sudo transfer above (WSD_TEST_ACCOUNT_PASSWORD)');
    const res = await reqAuth('DELETE', `/users/${editorId}`);
    assert.strictEqual(res.status, 400, `owner delete: ${res.status}`);
    const body = await res.json();
    assert.match(String(body.error || ''), /own projects/i);
  });

  test('delete removes the project (cleanup marker)', async () => {
    const res = await reqAuth('DELETE', `/projects/${slug}`);
    assert.strictEqual(res.status, 200);
    created = false;
  });
});
