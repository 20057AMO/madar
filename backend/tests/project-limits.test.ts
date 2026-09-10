import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import zlib from 'node:zlib';
import jwt from 'jsonwebtoken';
import { execFileSync } from 'node:child_process';
import { uniqueId, req, reqAuth, initTestAuth, JWT_SECRET, authHeaders, API_URL } from './helpers.ts';

/**
 * Project resource limits (CPU / memory):
 *  - PUT /api/projects/:slug/limits persists a validated set into meta
 *    immediately; the live container catches up on the next explicit
 *    "Recreate" (Docker cannot change cgroup limits live) — `needsRecreate`
 *    reports honestly.
 *  - Creation-time limits and duplicate-source limits apply right away.
 *  - Snapshot manifests deliberately do NOT carry limits (a restore on a
 *    fresh machine starts unconstrained).
 *  - Access matrix: non-member viewer 403, viewer member 403, editor member 200.
 *
 * p1 starts UNLIMITED and is mutated sequentially: edit cpu+memory → recreate →
 * re-persist (clean) → partial edit (memory only, cpu survives) → remove cpu →
 * remove both. Order-dependent by design (single shared real container).
 */

const createdSlugs: string[] = [];
const createdUserIds: string[] = [];

const P1_PORT = 8921;
const P2_PORT = 8922;

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

async function putLimits(slug: string, body: unknown): Promise<any> {
  const r = await reqAuth('PUT', `/projects/${slug}/limits`, body);
  return { status: r.status, json: await r.json() };
}

describe('Project resource limits (CPU/memory)', () => {
  let p1 = '';
  let p2 = '';
  let viewerUser: any;
  let editorUser: any;

  before(async () => {
    await initTestAuth();

    p1 = uniqueId('lim-a');
    createdSlugs.push(p1);
    const c1 = await reqAuth('POST', '/projects', { name: 'Limits A', slug: p1, ports: [P1_PORT] });
    assert.strictEqual(c1.status, 201, 'p1 create');
    const p1j = await c1.json();
    assert.strictEqual(p1j.project.limits, undefined, 'fresh project starts unconstrained');

    p2 = uniqueId('lim-b');
    createdSlugs.push(p2);
    const c2 = await reqAuth('POST', '/projects', {
      name: 'Limits B',
      slug: p2,
      ports: [P2_PORT],
      limits: { cpu: '500m', memory: '128Mi' },
    });
    assert.strictEqual(c2.status, 201, 'p2 create');
    const p2j = await c2.json();
    assert.deepStrictEqual(p2j.project.limits, { cpu: '500m', memory: '128Mi' }, 'creation-time limits stored');
    assert.deepStrictEqual(p2j.project.liveLimits, p2j.project.limits, 'creation-time limits apply immediately');

    const vu = await reqAuth('POST', '/users', { username: uniqueId('lim-view'), password: 'Pw-123456!', role: 'viewer' });
    assert.strictEqual(vu.status, 201, 'viewer user create');
    viewerUser = await vu.json();
    createdUserIds.push(viewerUser.id);
    const eu = await reqAuth('POST', '/users', { username: uniqueId('lim-edit'), password: 'Pw-123456!', role: 'editor' });
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

  test('edit persists into meta immediately while the live container stays unlimited', async () => {
    const { status, json } = await putLimits(p1, { cpu: '1', memory: '256Mi' });
    assert.strictEqual(status, 200, `put limits: ${status} ${json.error || ''}`);
    assert.deepStrictEqual(json.limits, { cpu: '1', memory: '256Mi' }, 'response echoes the saved set (canonical)');
    assert.strictEqual(json.needsRecreate, true, 'live cgroup differs → recreate needed');

    const project = await getProjectJson(p1);
    assert.deepStrictEqual(project.limits, { cpu: '1', memory: '256Mi' }, 'meta reflects the edit before any recreate');
    assert.strictEqual(project.liveLimits, undefined, 'live container still runs unlimited');
  });

  test('validation matrix: junk, floor, ceiling', async () => {
    const cases: Array<[any, number, RegExp]> = [
      [{ cpu: 'many' }, 400, /Invalid cpu format/i],
      [{ memory: 'lotz' }, 400, /Invalid memory format/i],
      [{ cpu: '0' }, 400, /CPU must be a positive number/i],
      [{ cpu: '50m' }, 400, /minimum 0\.1/i],
      [{ memory: '16Mi' }, 400, /minimum 32/i],
      [{ cpu: '999999' }, 400, /exceeds host capacity/i],
      [{ memory: '999999Gi' }, 400, /exceeds host capacity/i],
    ];
    for (const [body, exp, re] of cases) {
      const { status, json } = await putLimits(p1, body);
      assert.strictEqual(status, exp, `body ${JSON.stringify(body)} → ${status}`);
      assert.match(json.error || '', re);
    }
    const project = await getProjectJson(p1);
    assert.deepStrictEqual(project.limits, { cpu: '1', memory: '256Mi' }, 'rejected edits leave meta untouched');
  });

  test('creation-time limits bodies are validated too', async () => {
    const pBad = uniqueId('lim-bad');
    const bad = await reqAuth('POST', '/projects', {
      name: 'Limits bad',
      slug: pBad,
      limits: { memory: '16Mi' },
    });
    assert.strictEqual(bad.status, 400, 'over-floor create body rejected');
    assert.match((await bad.json()).error || '', /minimum 32/i);

    const pNull = uniqueId('lim-null');
    const nul = await reqAuth('POST', '/projects', {
      name: 'Limits null',
      slug: pNull,
      limits: { cpu: null, memory: null },
    });
    assert.strictEqual(nul.status, 201, 'null-only body is not a request → falls back to defaults');
    const nulJ = await nul.json();
    createdSlugs.push(pNull);
    assert.strictEqual(nulJ.project.limits, undefined, 'no defaults configured → unconstrained project');
  });

  test('partial update preserves untouched fields', async () => {
    const { status, json } = await putLimits(p1, { memory: '512Mi' });
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(json.limits, { cpu: '1', memory: '512Mi' }, 'cpu survives the memory-only patch');
    assert.strictEqual(json.needsRecreate, true);
  });

  test('snapshot manifest does NOT carry limits (restore = fresh machine)', async () => {
    const manifest = await tarEntry(await exportGzip(p1), 'manifest.json');
    assert.ok(manifest, 'manifest present');
    const parsed = JSON.parse(manifest.toString('utf8'));
    assert.strictEqual(parsed.project.limits, undefined, 'limits are deliberately excluded from snapshots');
  });

  test('recreate applies the limits to the live container; re-persisting reads clean', async () => {
    const rc = await reqAuth('POST', `/projects/${p1}/recreate`);
    assert.strictEqual(rc.status, 200, `recreate: ${rc.status} ${(await rc.json()).error || ''}`);

    const project = await getProjectJson(p1);
    assert.strictEqual(project.status, 'running');
    assert.deepStrictEqual(project.liveLimits, { cpu: '1', memory: '512Mi' }, 'HostConfig applies the edited limits');
    assert.deepStrictEqual(project.limits, project.liveLimits, 'meta and live aligned after recreate');

    const again = await putLimits(p1, { cpu: '1', memory: '512Mi' });
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.json.needsRecreate, false, 're-persisting the post-recreate set needs no recreate');
  });

  test('stopping and starting keeps the applied limits', async () => {
    const st = await reqAuth('POST', `/projects/${p1}/stop`);
    assert.strictEqual(st.status, 200, 'stop p1');
    const stopped = await getProjectJson(p1);
    assert.deepStrictEqual(stopped.liveLimits, { cpu: '1', memory: '512Mi' }, 'baked HostConfig survives stop');

    const start = await reqAuth('POST', `/projects/${p1}/start`);
    assert.strictEqual(start.status, 200, 'start p1');
    const started = await getProjectJson(p1);
    assert.deepStrictEqual(started.liveLimits, { cpu: '1', memory: '512Mi' }, 'limits persist across restart');
  });

  test('non-canonical inputs normalize to the inspected form and read clean after recreate', async () => {
    // 2500m stays milli (not a whole CPU); 1G (1e9 bytes) becomes 954Mi —
    // exact forms the live inspector reports, so meta ↔ live always match.
    const { status, json } = await putLimits(p1, { cpu: '2500m', memory: '1G' });
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(json.limits, { cpu: '2500m', memory: '954Mi' }, 'canonicalized at write time');
    assert.strictEqual(json.needsRecreate, true, 'live still on the previous set');

    const rc = await reqAuth('POST', `/projects/${p1}/recreate`);
    assert.strictEqual(rc.status, 200, 'recreate');
    const project = await getProjectJson(p1);
    assert.deepStrictEqual(project.liveLimits, { cpu: '2500m', memory: '954Mi' }, 'HostConfig matches canonical meta');

    // Swap must be pinned to the memory total (memory+swap), which disables
    // swap so the container is OOM-killed at the cap — NOT -1 (unlimited swap).
    const hc = JSON.parse(
      execFileSync('docker', ['inspect', `wsd-${p1}`, '--format', '{{json .HostConfig}}'], { encoding: 'utf8' }),
    );
    assert.ok(hc.Memory > 0, 'Memory limit applied');
    assert.strictEqual(hc.MemorySwap, hc.Memory, 'MemorySwap == memory disables swap (never -1)');

    const again = await putLimits(p1, { cpu: '2500m', memory: '1G' });
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.json.needsRecreate, false, 'no endless recreate loop for these forms');
  });

  test('null removes a limit; removing both clears the set entirely', async () => {
    let { status, json } = await putLimits(p1, { cpu: null });
    assert.strictEqual(status, 200);
    assert.deepStrictEqual(json.limits, { memory: '954Mi' }, 'cpu cleared, memory survives');
    assert.strictEqual(json.needsRecreate, true, 'dropping a constraint still requires recreate');

    ({ status, json } = await putLimits(p1, { cpu: null, memory: null }));
    assert.strictEqual(status, 200);
    assert.strictEqual(json.needsRecreate, true, 'removal pending while the container is still capped');
    const project = await getProjectJson(p1);
    assert.strictEqual(project.limits, undefined, 'meta carries no limit set after full removal');
  });

  test('duplicate carries the source limits into a brand-new container', async () => {
    // p2 was created with limits baked in (cpu 500m / mem 128Mi).
    await putLimits(p2, { cpu: '500m', memory: '128Mi' }); // idempotent re-persist (already live)

    const dup = await reqAuth('POST', `/projects/${p2}/duplicate`, { name: 'Limits B dup' });
    assert.strictEqual(dup.status, 201, 'duplicate create');
    const dupJ = await dup.json();
    const dupSlug = dupJ.project.slug;
    createdSlugs.push(dupSlug);

    const dupProj = await getProjectJson(dupSlug);
    assert.deepStrictEqual(dupProj.limits, { cpu: '500m', memory: '128Mi' }, 'duplicate inherits source limits');
    assert.deepStrictEqual(dupProj.liveLimits, dupProj.limits, 'duplicate applies them at creation');
  });

  test('access matrix: non-member viewer 403, viewer member 403, editor member 200', async () => {
    const outsider = memberAuth('lim-outsider-user', 'lim-outsider', 'viewer');
    const out = await req('PUT', `/projects/${p1}/limits`, { cpu: '1' }, outsider.headers);
    assert.strictEqual(out.status, 403, 'non-member viewer must be denied');

    const viewer = memberAuth(viewerUser.id, viewerUser.username, 'viewer');
    const v = await req('PUT', `/projects/${p1}/limits`, { cpu: '1' }, viewer.headers);
    assert.strictEqual(v.status, 403, 'viewer member must be denied');

    const editor = memberAuth(editorUser.id, editorUser.username, 'editor');
    const e = await req('PUT', `/projects/${p1}/limits`, { cpu: '1' }, editor.headers);
    assert.strictEqual(e.status, 200, 'editor member may edit limits');
    assert.deepStrictEqual((await e.json()).limits, { cpu: '1' }, 'editor patch canonicalized');
  });

  test('unknown project → 404', async () => {
    const r = await reqAuth('PUT', `/projects/${uniqueId('lim-nope')}/limits`, { cpu: '1' });
    assert.strictEqual(r.status, 404, `unknown project limits PUT → 404, got ${r.status}`);
  });
});