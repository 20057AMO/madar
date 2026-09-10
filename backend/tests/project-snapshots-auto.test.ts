import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import jwt from 'jsonwebtoken';
import { uniqueId, req, reqAuth, initTestAuth, JWT_SECRET, authHeaders, API_URL } from './helpers.ts';

/**
 * Snapshot automation: server-side scheduled backups with per-project config
 * (enabled / intervalMin / keep), "capture now", list, download, delete and
 * restore-into-a-new-project. Also covers the pure scheduling logic
 * (computeDueSnapshots), access control, retention pruning and validation.
 */

const createdSlugs: string[] = [];
const AUTO_PORT = 8775;
const FILE_RE = /^madar-[a-z0-9][a-z0-9._-]{0,63}-\d{17}\.tar\.gz$/;

function outsiderAuth() {
  const token = jwt.sign({ id: 'auto-outsider-user', username: 'auto-outsider', role: 'viewer', tv: 0 }, JWT_SECRET, { expiresIn: '24h' });
  return { headers: { ...authHeaders(), Authorization: `Bearer ${token}` } };
}

async function cleanupAll(): Promise<void> {
  for (const slug of createdSlugs) {
    try { await reqAuth('DELETE', `/projects/${slug}`); } catch { /* best effort */ }
  }
}

async function capture(slug: string, auth: any = authHeaders()) {
  const res = await fetch(`${API_URL}/projects/${slug}/snapshots`, { method: 'POST', headers: auth });
  let data: any = {};
  try { data = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json: data };
}

async function list(slug: string, auth: any = authHeaders()) {
  const res = await fetch(`${API_URL}/projects/${slug}/snapshots`, { headers: auth });
  let data: any = {};
  try { data = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json: data };
}

async function cfgGet(slug: string, auth: any = authHeaders()) {
  const res = await fetch(`${API_URL}/projects/${slug}/snapshots/config`, { headers: auth });
  let data: any = {};
  try { data = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json: data };
}

describe('Project snapshot automation (scheduled server-side backups)', () => {
  let slug = '';

  before(async () => {
    await initTestAuth();
    slug = uniqueId('auto-snap');
    createdSlugs.push(slug);
    const created = await reqAuth('POST', '/projects', {
      name: 'Automation Source',
      slug,
      description: 'auto-snapshot test project',
      ports: [AUTO_PORT],
    });
    assert.strictEqual(created.status, 201, `source create: ${created.status}`);
  });

  after(async () => {
    await cleanupAll();
  });

  test('fresh project has a default disabled schedule and no stored snapshots', async () => {
    const listRes = await list(slug);
    assert.strictEqual(listRes.status, 200);
    assert.deepStrictEqual(listRes.json.snapshots, []);

    const cfg = await cfgGet(slug);
    assert.strictEqual(cfg.status, 200);
    assert.strictEqual(cfg.json.enabled, false);
    assert.strictEqual(cfg.json.intervalMin, 1440);
    assert.strictEqual(cfg.json.keep, 5);
    assert.strictEqual(cfg.json.lastSnapshotAt, null);
  });

  test('invalid schedule values are normalized, valid ones persist partially', async () => {
    const put = async (body: any) => {
      const res = await fetch(`${API_URL}/projects/${slug}/snapshots/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(body),
      });
      let data: any = {};
      try { data = await res.json(); } catch { /* non-JSON */ }
      return { status: res.status, json: data };
    };

    // Unknown interval / out-of-range keep fall back to sensible values.
    let r = await put({ intervalMin: 90, keep: 0 });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.intervalMin, 1440, 'unknown interval → default');
    assert.strictEqual(r.json.keep, 5, 'keep below 1 → default');

    // Partial update: only keep changes, enabled/interval survive.
    r = await put({ enabled: true, intervalMin: 360 });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.enabled, true);
    assert.strictEqual(r.json.intervalMin, 360);

    r = await put({ keep: 2 });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.keep, 2, 'explicit field replaces');
    assert.strictEqual(r.json.enabled, true, 'omitted fields survive');
    assert.strictEqual(r.json.intervalMin, 360);
  });

  test('capture now stores a valid archive and stamps lastSnapshotAt', async () => {
    const { status, json } = await capture(slug);
    assert.strictEqual(status, 201, `capture: ${status} — ${json.error || ''}`);
    const entry = json.snapshot;
    assert.match(entry.file, FILE_RE, 'stored filename shape');
    assert.ok(entry.size > 0, 'archive is non-empty');
    assert.ok(entry.at, 'has timestamp');

    const listRes = await list(slug);
    assert.strictEqual(listRes.status, 200);
    assert.strictEqual(listRes.json.snapshots.length, 1);
    assert.strictEqual(listRes.json.snapshots[0].file, entry.file);
    assert.strictEqual(listRes.json.snapshots[0].size, entry.size);

    const cfg = await cfgGet(slug);
    assert.ok(cfg.json.lastSnapshotAt, 'lastSnapshotAt recorded');
  });

  test('retention prunes oldest copies to the configured keep', async () => {
    await reqAuth('PUT', `/projects/${slug}/snapshots/config`, { keep: 1, enabled: true, intervalMin: 60 });
    for (let i = 0; i < 3; i++) {
      const { status } = await capture(slug);
      assert.strictEqual(status, 201);
      await new Promise((r) => setTimeout(r, 10)); // distinct ms stamps
    }
    const listRes = await list(slug);
    assert.strictEqual(listRes.json.snapshots.length, 1, `retention keeps only 'keep' newest (got ${listRes.json.snapshots.length})`);
    assert.ok(listRes.json.snapshots[0].size > 0);
  });

  test('download a stored snapshot (gzip magic + filename), delete it (gone, then 404)', async () => {
    // Keep one known copy.
    const { json } = await capture(slug);
    const file = json.snapshot.file;

    const res = await fetch(`${API_URL}/projects/${slug}/snapshots/${encodeURIComponent(file)}`, { headers: authHeaders() });
    assert.strictEqual(res.status, 200, `download: ${res.status}`);
    assert.strictEqual(res.headers.get('content-type'), 'application/gzip');
    assert.match(res.headers.get('content-disposition') || '', new RegExp(`filename="${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
    const buf = Buffer.from(await res.arrayBuffer());
    assert.strictEqual(buf[0], 0x1f);
    assert.strictEqual(buf[1], 0x8b);
    assert.strictEqual(buf.length, json.snapshot.size, 'downloaded bytes match stored size');

    const del = await reqAuth('DELETE', `/projects/${slug}/snapshots/${encodeURIComponent(file)}`);
    assert.strictEqual(del.status, 200, `delete: ${del.status}`);

    const after = await list(slug);
    assert.ok(!after.json.snapshots.some((s: any) => s.file === file), 'deleted file gone from list');

    const gone = await fetch(`${API_URL}/projects/${slug}/snapshots/${encodeURIComponent(file)}`, { headers: authHeaders() });
    assert.strictEqual(gone.status, 404, 'deleted file no longer downloadable');

    // Traversal-shaped filename is rejected, not resolved.
    const evil = await reqAuth('DELETE', `/projects/${slug}/snapshots/${encodeURIComponent('../evil.tar.gz')}`);
    assert.strictEqual(evil.status, 400, 'traversal filename rejected');
  });

  test('restore a stored snapshot into a brand-new project (files + notes + description)', async () => {
    const source = uniqueId('auto-restore');
    createdSlugs.push(source);
    const created = await reqAuth('POST', '/projects', {
      name: 'Restore Me',
      slug: source,
      description: 'description must survive',
    });
    assert.strictEqual(created.status, 201);
    await reqAuth('PUT', `/projects/${source}/file?path=src/service.ts`, { content: 'export const ping = () => 42;' });
    await reqAuth('PUT', `/projects/${source}/notes`, {
      items: [{ id: 'r1', text: 'restore context note', kind: 'goal', done: false, createdAt: new Date().toISOString() }],
    });
    await reqAuth('PUT', `/projects/${source}/canvas`, {
      version: 1,
      nodes: [
        { id: 'rc1', type: 'note', text: 'Auto-backup roadmap', x: 5, y: 5, w: 220, h: 100, color: 'blue', done: false },
        { id: 'rc2', type: 'card', text: 'Survive capture-now', x: 260, y: 30, w: 240, h: 120, color: 'red', done: false },
      ],
      edges: [{ id: 're1', from: 'rc1', to: 'rc2' }],
      updatedAt: null,
    });

    const { status, json } = await capture(source);
    assert.strictEqual(status, 201);
    const file = json.snapshot.file;

    const rest = await reqAuth('POST', `/projects/${source}/snapshots/${encodeURIComponent(file)}/restore`);
    assert.strictEqual(rest.status, 201, `restore: ${rest.status}` + (rest.status !== 201 ? ` — ${(await rest.json().catch(() => ({}))).error || ''}` : ''));
    const project = (await rest.json()).project;
    // Track before asserting so even a failed run can clean up.
    createdSlugs.push(project.slug);
    assert.notStrictEqual(project.slug, source, 'restored copy gets a fresh slug');

    assert.strictEqual(project.name, 'Restore Me');
    assert.strictEqual(project.description, 'description must survive');

    const fileRes = await reqAuth('GET', `/projects/${project.slug}/file?path=src/service.ts`);
    assert.strictEqual(fileRes.status, 200, 'restored nested file readable');
    assert.match((await fileRes.json()).content, /ping = \(\) => 42/);

    const notesRes = await reqAuth('GET', `/projects/${project.slug}/notes`);
    const notes = (await notesRes.json()).items || [];
    assert.strictEqual(notes.length, 1);
    assert.strictEqual(notes[0].text, 'restore context note');

    const canvasRes = await reqAuth('GET', `/projects/${project.slug}/canvas`);
    const canvas = await canvasRes.json();
    assert.strictEqual(canvas.nodes.length, 2, 'stored snapshot restores the canvas board');
    assert.strictEqual(canvas.edges.length, 1);
    assert.strictEqual(canvas.edges[0].id, 're1');
    assert.strictEqual((canvas.nodes.find((nd: any) => nd.id === 'rc2') ?? {}).text, 'Survive capture-now');
  });

  test('access control: member viewer can list/config but not capture/restore; outsider denied', async () => {
    const out = outsiderAuth(); // viewer that is NOT a member

    // Create a real viewer user (required as a project member) and clean up.
    const viewerName = uniqueId('auto-viewer');
    const pw = 'viewer-test-pw-2026';
    const v = await reqAuth('POST', '/users', { username: viewerName, password: pw, role: 'viewer' });
    assert.strictEqual(v.status, 201, `create viewer user: ${v.status}`);
    const viewerId = (await v.json()).id;
    const viewerToken = jwt.sign(
      { id: viewerId, username: viewerName, role: 'viewer', tv: 0 },
      JWT_SECRET,
      { expiresIn: '24h' },
    );
    const viewer = { headers: { ...authHeaders(), Authorization: `Bearer ${viewerToken}` } };

    // Make the viewer a member so the read-only paths are reachable.
    const add = await reqAuth('POST', `/projects/${slug}/members`, {
      userId: viewerId,
      role: 'viewer',
    });
    assert.strictEqual(add.status, 200, `add viewer member: ${add.status} — ${JSON.stringify(await add.json())}`);

    const viewerList = await list(slug, viewer.headers);
    assert.strictEqual(viewerList.status, 200, 'viewer may list stored snapshots');
    const viewerCfg = await cfgGet(slug, viewer.headers);
    assert.strictEqual(viewerCfg.status, 200, 'viewer may read the schedule');

    const viewerCap = await capture(slug, viewer.headers);
    assert.strictEqual(viewerCap.status, 403, 'viewer cannot capture a snapshot');

    const { json: listJson } = await list(slug);
    if (listJson.snapshots.length > 0) {
      const viewerRest = await reqAuth('POST', `/projects/${slug}/snapshots/${encodeURIComponent(listJson.snapshots[0].file)}/restore`, {});
      assert.strictEqual(viewerRest.status, 403, 'viewer cannot restore a snapshot');
    }

    const outCfg = await cfgGet(slug, out.headers);
    assert.strictEqual(outCfg.status, 403, 'non-member denied reading schedule');

    // Non-member viewer cannot capture either.
    const outCap = await capture(slug, out.headers);
    assert.strictEqual(outCap.status, 403, 'non-member viewer cannot capture');

    // Clean up the temp viewer user.
    try { await reqAuth('DELETE', `/users/${viewerId}`); } catch { /* best effort */ }
  });

  test('pure scheduling: computeDueSnapshots respects enabled / interval / last snapshot', async () => {
    const { computeDueSnapshots } = await import('../src/services/snapshots-schedule.ts');
    const now = Date.now();
    const set = {
      a: { slug: 'a', schedule: { enabled: true, intervalMin: 60, keep: 5 }, lastSnapshotAt: new Date(now - 70 * 60_000).toISOString() },
      b: { slug: 'b', schedule: { enabled: true, intervalMin: 60, keep: 5 }, lastSnapshotAt: new Date(now - 10 * 60_000).toISOString() },
      c: { slug: 'c', schedule: { enabled: false, intervalMin: 60, keep: 5 }, lastSnapshotAt: new Date(now - 9999 * 60_000).toISOString() },
      d: { slug: 'd', schedule: { enabled: true, intervalMin: 60, keep: 5 }, lastSnapshotAt: null },
    };
    const due = computeDueSnapshots([set.a, set.b, set.c, set.d], now);
    assert.deepStrictEqual(due.sort(), ['a', 'd'], 'only within-gap enabled projects are due');
  });
});