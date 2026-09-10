import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import zlib from 'node:zlib';
import jwt from 'jsonwebtoken';
import { execSync } from 'child_process';
import { uniqueId, req, reqAuth, initTestAuth, JWT_SECRET, authHeaders, API_URL } from './helpers.ts';

/**
 * Project published-ports editing: PUT /api/projects/:slug/ports persists a
 * validated, conflict-checked port set into meta (applied on the next explicit
 * recreate — Docker cannot rebind live containers). Covers the real-Docker
 * create → edit → recreate → rebind roundtrip, self-exclusion collision rules
 * (including OTHER projects' STALE LIVE bindings — a port mid-rebind still
 * physically belongs to the old container), stopped-project reservation,
 * snapshot manifest fidelity, and the access matrix (non-member viewer 403,
 * viewer member 403, editor member allowed).
 *
 * p1 is mutated sequentially through the editable set: 8901 → 8902 → 8910 →
 * 8905 (recreate) → 8906 (recreate) → unpublish → 8911. Tests are order-
 * dependent by design (single shared real container).
 */

const createdSlugs: string[] = [];
const createdUserIds: string[] = [];

// Distinct high range unlikely to collide with other suites or the live
// environment (the `test` project holds 8090).
const P1_INITIAL = 8901;
const P1_EDITED = 8902;
const P2_CLAIM = 8903;
const P1_REBIND = 8905;
const P1_STOP_EDIT = 8906;
const P1_DEDUP = 8910;
const EDITOR_EDIT = 8911;
const P3_LIVE = 8912;
const P3_EDITED = 8913;
const P2_EDIT_AWAY = 8915;

function memberAuth(id: string, username: string, role: string) {
  const token = jwt.sign({ id, username, role, tv: 0 }, JWT_SECRET, { expiresIn: '24h' });
  return { headers: { ...authHeaders(), Authorization: `Bearer ${token}` } };
}

async function getProjectJson(slug: string): Promise<any> {
  const res = await reqAuth('GET', `/projects/${slug}`);
  assert.strictEqual(res.status, 200, `get ${slug}: ${res.status}`);
  return (await res.json()).project;
}

/** Extract a named entry from a snapshot tar.gz; returns null when absent. */
async function tarEntry(gzip: Buffer, name: string): Promise<Buffer | null> {
  const tar = zlib.gunzipSync(gzip);
  let off = 0;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    const entryName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    if (!entryName) break;
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0/g, '').trim() || '0', 8) || 0;
    off += 512;
    if (entryName === name) return tar.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
  }
  return null;
}

async function exportGzip(slug: string): Promise<Buffer> {
  const res = await fetch(`${API_URL}/projects/${slug}/export`, { headers: authHeaders() });
  assert.strictEqual(res.status, 200, `export ${slug}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

describe('Project published-ports editing', () => {
  let p1 = '';
  let p2 = '';
  let p3 = '';
  let viewerUser: any;
  let editorUser: any;

  before(async () => {
    // Clear any orphaned wsd.managed containers from crashed runs so a stale
    // live binding can never poison a port-claim assertion. `2>NUL` silences
    // the "no such container" noise on Windows; use `2>/dev/null` on Linux.
    try {
      execSync('docker rm -f $(docker ps -aq --filter label=wsd.managed=true) 2>NUL', {
        timeout: 15000,
        stdio: 'pipe',
      });
    } catch { /* no orphan containers */ }
    await initTestAuth();

    p1 = uniqueId('ports-a');
    createdSlugs.push(p1);
    const c1 = await reqAuth('POST', '/projects', {
      name: 'Ports Edit A',
      slug: p1,
      ports: [P1_INITIAL],
    });
    assert.strictEqual(c1.status, 201, `p1 create (${P1_INITIAL}): ${c1.status} ${(await c1.json()).error || ''}`);

    p2 = uniqueId('ports-b');
    createdSlugs.push(p2);
    const c2 = await reqAuth('POST', '/projects', {
      name: 'Ports Edit B',
      slug: p2,
      ports: [P2_CLAIM],
    });
    assert.strictEqual(c2.status, 201, `p2 create (${P2_CLAIM}): ${c2.status}`);

    // A temp viewer + editor member (admin-provisioned) for the access matrix.
    const vu = await reqAuth('POST', '/users', { username: uniqueId('ports-view'), password: 'Pw-123456!', role: 'viewer' });
    assert.strictEqual(vu.status, 201, 'viewer user create');
    viewerUser = await vu.json();
    createdUserIds.push(viewerUser.id);
    const eu = await reqAuth('POST', '/users', { username: uniqueId('ports-edit'), password: 'Pw-123456!', role: 'editor' });
    assert.strictEqual(eu.status, 201, 'editor user create');
    editorUser = await eu.json();
    createdUserIds.push(editorUser.id);

    const mv = await reqAuth('POST', `/projects/${p1}/members`, { userId: viewerUser.id, role: 'viewer' });
    assert.strictEqual(mv.status, 200, 'add viewer member');
    const me = await reqAuth('POST', `/projects/${p1}/members`, { userId: editorUser.id, role: 'editor' });
    assert.strictEqual(me.status, 200, 'add editor member');
  });

  after(async () => {
    for (const slug of createdSlugs) {
      try { await reqAuth('DELETE', `/projects/${slug}`); } catch { /* best effort */ }
    }
    for (const id of createdUserIds) {
      try { await reqAuth('DELETE', `/users/${id}`); } catch { /* best effort */ }
    }
  });

  test('edit persists into meta immediately while the live binding stays stale', async () => {
    const r = await reqAuth('PUT', `/projects/${p1}/ports`, { ports: [P1_EDITED] });
    assert.strictEqual(r.status, 200, `put ports: ${r.status}`);
    const j = await r.json();
    assert.deepStrictEqual(j.ports, [P1_EDITED], 'response echoes the saved set');
    assert.strictEqual(j.needsRecreate, true, 'live binding differs → needs recreate');

    const project = await getProjectJson(p1);
    assert.deepStrictEqual(project.ports, [P1_EDITED], 'meta reflects the edit before any recreate');
    assert.ok(project.hostPorts?.[String(P1_EDITED)] === undefined, 'live binding still shows the old port');
  });

  test('snapshot manifest serializes the EDITED meta (stale live binding)', async () => {
    const project = await getProjectJson(p1);
    assert.ok(project.hostPorts?.[String(P1_EDITED)] === undefined, 'precondition: live still stale (meta ≠ live)');
    const manifest = await tarEntry(await exportGzip(p1), 'manifest.json');
    assert.ok(manifest, 'manifest.json present in the snapshot');
    const parsed = JSON.parse(manifest.toString('utf8'));
    assert.deepStrictEqual(parsed.project.ports, [P1_EDITED], 'manifest ports carry the edited intent, not the stale binding');
  });

  test('saving the identical live set reports needsRecreate=false', async () => {
    const res = await reqAuth('PUT', `/projects/${p2}/ports`, { ports: [P2_CLAIM] });
    assert.strictEqual(res.status, 200);
    const j = await res.json();
    assert.deepStrictEqual(j.ports, [P2_CLAIM]);
    assert.strictEqual(j.needsRecreate, false, 'own current set already bound → no recreate needed');
  });

  test('conflict check: another project’s claimed port → 409 with taken list', async () => {
    const r = await reqAuth('PUT', `/projects/${p1}/ports`, { ports: [P2_CLAIM] });
    assert.strictEqual(r.status, 409, `expected 409, got ${r.status}`);
    const j = await r.json();
    assert.match(j.error, new RegExp(`Ports already in use: ${P2_CLAIM}`));
    assert.deepStrictEqual(j.taken, [P2_CLAIM]);
  });

  test('validation matrix: reserved, privileged, junk, cap', async () => {
    const cases: Array<[any, number, RegExp]> = [
      [{ ports: [3000] }, 400, /reserved for the Madar dashboard/i],
      [{ ports: [8100] }, 400, /reserved/i],
      [{ ports: [4096] }, 400, /reserved/i],
      [{ ports: [80] }, 400, /privileged system port/i],
      [{ ports: ['abc'] }, 400, /Invalid port/i],
      [{ ports: [0] }, 400, /Invalid port/],
      [{ ports: [70000] }, 400, /Invalid port/],
      [{}, 400, /array of integers/],
    ];
    for (const [body, status, re] of cases) {
      const r = await reqAuth('PUT', `/projects/${p1}/ports`, body);
      assert.strictEqual(r.status, status, `body ${JSON.stringify(body)} → ${r.status}`);
      assert.match((await r.json()).error || '', re);
    }

    const dup = await reqAuth('PUT', `/projects/${p1}/ports`, { ports: [P1_DEDUP, P1_DEDUP] });
    assert.strictEqual(dup.status, 200, `dedup edit: ${dup.status}`);
    assert.deepStrictEqual((await dup.json()).ports, [P1_DEDUP], 'duplicates collapse');

    const many = Array.from({ length: 51 }, (_, i) => 3000 + i + 1);
    const cap = await reqAuth('PUT', `/projects/${p1}/ports`, { ports: many });
    assert.strictEqual(cap.status, 400, `51 ports → 400, got ${cap.status}`);
    assert.match((await cap.json()).error || '', /Too many ports/);
  });

  test('stale LIVE binding from an edited sibling is still a conflict', async () => {
    p3 = uniqueId('ports-c');
    createdSlugs.push(p3);
    const c3 = await reqAuth('POST', '/projects', { name: 'Ports Edit C', slug: p3, ports: [P3_LIVE] });
    assert.strictEqual(c3.status, 201, `p3 create (${P3_LIVE}): ${c3.status} ${(await c3.json()).error || ''}`);

    // p3 edits its ports off P3_LIVE but does NOT recreate: meta moves, the
    // container stays physically bound to P3_LIVE. currentUsedPorts must count
    // that stale live binding so nothing else can claim it.
    const e = await reqAuth('PUT', `/projects/${p3}/ports`, { ports: [P3_EDITED] });
    assert.strictEqual(e.status, 200);
    assert.strictEqual((await e.json()).needsRecreate, true, 'p3 edit is pending a recreate');
    const p3proj = await getProjectJson(p3);
    assert.strictEqual(p3proj.hostPorts?.[String(P3_LIVE)], String(P3_LIVE), 'precondition: p3 still bound to the old port');

    const r = await reqAuth('PUT', `/projects/${p1}/ports`, { ports: [P3_LIVE] });
    assert.strictEqual(r.status, 409, 'orphaned live binding must block the claim');
    const j = await r.json();
    assert.match(j.error, new RegExp(`Ports already in use: ${P3_LIVE}`));
    assert.deepStrictEqual(j.taken, [P3_LIVE]);
  });

  test('recreate rebinds the live container (running) and the same set then reads clean', async () => {
    const r = await reqAuth('PUT', `/projects/${p1}/ports`, { ports: [P1_REBIND] });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await r.json()).needsRecreate, true);

    const rc = await reqAuth('POST', `/projects/${p1}/recreate`);
    assert.strictEqual(rc.status, 200, `recreate: ${rc.status} ${(await rc.json()).error || ''}`);

    const project = await getProjectJson(p1);
    assert.strictEqual(project.status, 'running');
    assert.strictEqual(project.hostPorts?.[String(P1_REBIND)], String(P1_REBIND), 'live binding rebinds to the edited port');

    const again = await reqAuth('PUT', `/projects/${p1}/ports`, { ports: [P1_REBIND] });
    assert.strictEqual(again.status, 200);
    assert.strictEqual((await again.json()).needsRecreate, false, 're-persisting the post-recreate set needs no recreate');
  });

  test('stopped project still reserves its baked port (live binding blocks even without meta), then recreation rebinds', async () => {
    const st2 = await reqAuth('POST', `/projects/${p2}/stop`);
    assert.strictEqual(st2.status, 200, 'stop p2');

    // p2 edits its ports elsewhere (no recreate while stopped, so nothing
    // changes live): meta moves off P2_CLAIM but the stopped container keeps
    // the physical binding — which must still block other claims.
    const e2 = await reqAuth('PUT', `/projects/${p2}/ports`, { ports: [P2_EDIT_AWAY] });
    assert.strictEqual(e2.status, 200);
    assert.strictEqual((await e2.json()).needsRecreate, true, 'p2 pending recreate while stopped');
    const p2proj = await getProjectJson(p2);
    assert.deepStrictEqual(p2proj.ports, [P2_EDIT_AWAY], 'p2 meta moved off the claim');
    assert.strictEqual(p2proj.hostPorts?.[String(P2_CLAIM)], String(P2_CLAIM), 'precondition: stopped container still owns the binding');

    const blocked = await reqAuth('PUT', `/projects/${p1}/ports`, { ports: [P2_CLAIM] });
    assert.strictEqual(blocked.status, 409, 'baked binding (not meta) must still block the claim');
    assert.match((await blocked.json()).error || '', new RegExp(`Ports already in use: ${P2_CLAIM}`));

    const st = await reqAuth('POST', `/projects/${p1}/stop`);
    assert.strictEqual(st.status, 200, 'stop p1');

    const r = await reqAuth('PUT', `/projects/${p1}/ports`, { ports: [P1_STOP_EDIT] });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await r.json()).needsRecreate, true, 'stopped binding is baked → recreate required');

    const start = await reqAuth('POST', `/projects/${p1}/start`);
    assert.strictEqual(start.status, 200, 'start p1');
    let project = await getProjectJson(p1);
    assert.strictEqual(project.hostPorts?.[String(P1_REBIND)], String(P1_REBIND), 'start did not rebind (stale binding remains)');
    assert.deepStrictEqual(project.ports, [P1_STOP_EDIT], 'meta holds the edited intent meanwhile');

    const rc = await reqAuth('POST', `/projects/${p1}/recreate`);
    assert.strictEqual(rc.status, 200);
    project = await getProjectJson(p1);
    assert.strictEqual(project.hostPorts?.[String(P1_STOP_EDIT)], String(P1_STOP_EDIT), 'recreate applies the stopped-edit ports');
  });

  test('unpublish all: empty set → 200, meta clears, still marks recreate', async () => {
    const r = await reqAuth('PUT', `/projects/${p1}/ports`, { ports: [] });
    assert.strictEqual(r.status, 200);
    const j = await r.json();
    assert.deepStrictEqual(j.ports, []);
    assert.strictEqual(j.needsRecreate, true, 'unpublished while live still bound → recreate pending');
    const project = await getProjectJson(p1);
    assert.deepStrictEqual(project.ports, []);
  });

  test('access matrix: non-member viewer 403, viewer member 403, editor member 200', async () => {
    const outsider = memberAuth('ports-outsider-user', 'ports-outsider', 'viewer');
    const out = await req('PUT', `/projects/${p1}/ports`, { ports: [EDITOR_EDIT] }, outsider.headers);
    assert.strictEqual(out.status, 403, 'non-member viewer must be denied');

    const viewer = memberAuth(viewerUser.id, viewerUser.username, 'viewer');
    const v = await req('PUT', `/projects/${p1}/ports`, { ports: [EDITOR_EDIT] }, viewer.headers);
    assert.strictEqual(v.status, 403, 'viewer member must be denied');

    const editor = memberAuth(editorUser.id, editorUser.username, 'editor');
    const e = await req('PUT', `/projects/${p1}/ports`, { ports: [EDITOR_EDIT] }, editor.headers);
    assert.strictEqual(e.status, 200, 'editor member may edit ports');
    assert.deepStrictEqual((await e.json()).ports, [EDITOR_EDIT]);
  });

  test('unknown project → 404', async () => {
    const r = await reqAuth('PUT', `/projects/${uniqueId('ports-nope')}/ports`, { ports: [EDITOR_EDIT] });
    assert.strictEqual(r.status, 404, `unknown project ports PUT → 404, got ${r.status}`);
  });
});