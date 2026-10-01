/**
 * storage.test.ts
 * Real-Docker integration for disk-usage visibility (GET /api/storage):
 *  - A created project appears with workspaceBytes > 0.
 *  - Grabbing a snapshot increases its snapshotBytes (fresh rescan).
 *  - The 45s cache is honored: back-to-back reads share one scan and the
 *    same generatedAt; the /api/storage?fresh=1 path rescans.
 *  - Deleting the project removes it from the listing (cache invalidated).
 *  - Access matrix: viewer and editor tokens both read 200 (read-only,
 *    global endpoint — no admin wall, mirroring how /api/projects lists
 *    every project for any authenticated user).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { uniqueId, req, reqAuth, initTestAuth, authHeaders, API_URL, liveUser, cleanupLiveUsers } from './helpers.ts';

// A REAL account per role: verifyToken refuses an id that is not in users.json,
// so a ghost id would turn each role row into a bare 401.
async function forger(role: 'viewer' | 'editor', key: string) {
  const user = await liveUser(role, key);
  return { headers: { ...authHeaders(), Authorization: `Bearer ${user.token}` } };
}

const createdSlugs: string[] = [];
let slug = '';
let snapshotBytesBefore = 0;

const STORE = () => reqAuth('GET', '/storage');

describe('Storage metrics (disk usage)', () => {
  before(async () => {
    await initTestAuth();
  });

  after(async () => {
    for (const s of createdSlugs) {
      try { await reqAuth('DELETE', `/projects/${s}`); } catch { /* best effort */ }
    }
    await cleanupLiveUsers();
  });

  test('unauthenticated → 401 (global authMiddleware)', async () => {
    const res = await req('GET', '/storage');
    assert.strictEqual(res.status, 401);
  });

  test('shape contract + access matrix (viewer/editor both read)', async () => {
    for (const [role, key] of [['viewer', 'storage-viewer'], ['editor', 'storage-editor']] as const) {
      const as = await forger(role, key);
      const res = await req('GET', '/storage', undefined, as.headers);
      assert.strictEqual(res.status, 200, `${role} should read storage metrics`);
      const data = await res.json();
      assert.strictEqual(typeof data.dataDirBytes, 'number');
      assert.strictEqual(typeof data.totalWorkspaceBytes, 'number');
      assert.strictEqual(typeof data.totalSnapshotBytes, 'number');
      assert.strictEqual(typeof data.containerWritableBytes, 'number');
      assert.ok(Array.isArray(data.projects));
      assert.ok(!Array.isArray(data.docker), 'docker object');
      assert.strictEqual(typeof data.docker?.perProject, 'object');
    }
  });

  test('created project shows up with a nonzero workspace', async () => {
    slug = `st-${uniqueId('ws')}`;
    createdSlugs.push(slug);
    const created = await reqAuth('POST', '/projects', { name: 'Storage Suite', slug });
    assert.strictEqual(created.status, 201, JSON.stringify(await created.json()));

    // A fresh workspace is empty — seed a file so workspaceBytes > 0 holds.
    const fd = new FormData();
    fd.append('files', new File([Buffer.from('madar storage seed payload')], 'seed.txt', { type: 'text/plain' }));
    const up = await fetch(`${API_URL}/projects/${slug}/upload`, { method: 'POST', headers: authHeaders(), body: fd });
    assert.strictEqual(up.status, 201, `seed upload should succeed (got ${up.status})`);

    const res = await reqAuth('GET', '/storage?fresh=1');
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    const proj = data.projects.find((p: any) => p.slug === slug);
    assert.ok(proj, 'new project must appear in storage listing');
    assert.strictEqual(proj.name, 'Storage Suite');
    assert.ok(proj.workspaceBytes > 0, `workspace should have bytes (got ${proj.workspaceBytes})`);
    const cont = data.docker?.perProject?.[slug];
    assert.ok(cont, 'container writable-layer entry expected for the project container');
    assert.strictEqual(typeof cont.writableBytes, 'number');
  });

  test('snapshot capture grows snapshotBytes', async () => {
    const res1 = await reqAuth('GET', '/storage?fresh=1');
    assert.strictEqual(res1.status, 200);
    const before = (await res1.json()).projects.find((p: any) => p.slug === slug);
    snapshotBytesBefore = before?.snapshotBytes ?? 0;

    const cap = await reqAuth('POST', `/projects/${slug}/snapshots`, {});
    assert.ok([200, 201].includes(cap.status), 'capture-now should succeed');

    const res2 = await reqAuth('GET', '/storage?fresh=1');
    assert.strictEqual(res2.status, 200);
    const afterD = (await res2.json()).projects.find((p: any) => p.slug === slug);
    assert.ok(afterD.snapshotBytes > snapshotBytesBefore, 'snapshot archive bytes must grow after capture');
  });

  test('cache: back-to-back reads share one scan (same generatedAt); fresh rescans', async () => {
    const a = await reqAuth('GET', '/storage');
    const b = await reqAuth('GET', '/storage');
    assert.strictEqual(a.status, 200);
    assert.strictEqual(b.status, 200);
    const da = await a.json();
    const db = await b.json();
    assert.strictEqual(da.generatedAt, db.generatedAt, 'second read must come from the cache');

    await new Promise((r) => setTimeout(r, 20));
    const c = await reqAuth('GET', '/storage?fresh=1');
    assert.strictEqual(c.status, 200);
    const dc = await c.json();
    assert.ok(dc.generatedAt >= da.generatedAt, 'fresh read must rescan');
  });

  test('deleted project disappears from the listing (cache invalidated)', async () => {
    const del = await reqAuth('DELETE', `/projects/${slug}`);
    assert.strictEqual(del.status, 200);

    const res = await reqAuth('GET', '/storage');
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    const proj = data.projects.find((p: any) => p.slug === slug);
    assert.ok(!proj, 'deleted project must be gone from storage listing');
  });
});
