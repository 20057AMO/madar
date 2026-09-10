import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import zlib from 'node:zlib';
import jwt from 'jsonwebtoken';
import { uniqueId, req, reqAuth, initTestAuth, JWT_SECRET, authHeaders, API_URL } from './helpers.ts';

/**
 * Project snapshots: export a project (workspace + notes + meta) as a tar.gz
 * and restore it into a brand-new project. Covers the real-Docker roundtrip
 * (files / notes / env / meta fidelity, port re-allocation when manifest ports
 * are taken), access control, and archive-abuse guards (garbage, no file,
 * path traversal).
 */

const createdSlugs: string[] = [];
const SNAP_PORT = 8774;
let snapshotGzip: Buffer;

function viewerAuth() {
  const token = jwt.sign({ id: 'snap-viewer-user', username: 'snap-viewer', role: 'viewer', tv: 0 }, JWT_SECRET, { expiresIn: '24h' });
  return { headers: { ...authHeaders(), Authorization: `Bearer ${token}` } };
}

async function cleanupAll(): Promise<void> {
  for (const slug of createdSlugs) {
    try { await reqAuth('DELETE', `/projects/${slug}`); } catch { /* best effort */ }
  }
}

/** GET a project's exported snapshot; asserts gzip magic + headers. */
async function exportBytes(slug: string): Promise<Buffer> {
  const res = await fetch(`${API_URL}/projects/${slug}/export`, { headers: authHeaders() });
  assert.strictEqual(res.status, 200, `export status: ${res.status}`);
  assert.strictEqual(res.headers.get('content-type'), 'application/gzip');
  assert.match(res.headers.get('content-disposition') || '', /filename="madar-.*\.tar\.gz"/, 'attachment filename');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.ok(buf.length > 4, 'non-empty body');
  assert.strictEqual(buf[0], 0x1f, 'gzip magic 1');
  assert.strictEqual(buf[1], 0x8b, 'gzip magic 2');
  return buf;
}

/** POST a snapshot gzip as multipart upload; returns response + parsed json. */
async function restore(gzip: Buffer): Promise<{ status: number; json: any }> {
  const fd = new FormData();
  fd.append('file', new Blob([gzip]), 'snap.tar.gz');
  const res = await fetch(`${API_URL}/projects/import`, {
    method: 'POST',
    headers: authHeaders(),
    body: fd,
  });
  let data: any = {};
  try { data = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json: data };
}

describe('Project snapshots (export / restore)', () => {
  let srcSlug = '';

  before(async () => {
    await initTestAuth();
    srcSlug = uniqueId('snap-src');
    createdSlugs.push(srcSlug);
    const created = await reqAuth('POST', '/projects', {
      name: 'Snapshot Source',
      slug: srcSlug,
      description: 'the original source project',
      ports: [SNAP_PORT],
      env: { SNAP_VAR: 'roundtrip-value', NODE_ENV: 'test' },
    });
    assert.strictEqual(created.status, 201, `source create: ${created.status}`);
    // Workspace files: a nested source file + the project goals file.
    const file = await reqAuth('PUT', `/projects/${srcSlug}/file?path=app/main.py`, {
      content: 'print("madar snapshot roundtrip")',
    });
    assert.strictEqual(file.status, 200, `file write: ${file.status}`);
    const goals = await reqAuth('PUT', `/projects/${srcSlug}/file?path=WSD_PROJECT.md`, {
      content: '# Goals\n\n- ship snapshots 2026-08',
    });
    assert.strictEqual(goals.status, 200, `goals write: ${goals.status}`);
    // A developer note to prove notes travel with the snapshot.
    const note = await reqAuth('PUT', `/projects/${srcSlug}/notes`, {
      items: [{ id: 'n1', text: 'remember the polar bears', kind: 'bug', done: false, createdAt: new Date().toISOString() }],
    });
    assert.strictEqual(note.status, 200, `notes write: ${note.status}`);
    // A planning canvas so the whiteboard travels with the snapshot too.
    const canvas = await reqAuth('PUT', `/projects/${srcSlug}/canvas`, {
      version: 1,
      nodes: [
        { id: 'sn', type: 'note', text: 'Idea: snapshot the board', x: 12, y: 24, w: 220, h: 100, color: 'yellow', done: false },
        { id: 'sc', type: 'card', text: 'Make it survive restores', x: 300, y: 40, w: 240, h: 120, color: 'green', done: true },
      ],
      edges: [{ id: 'se', from: 'sn', to: 'sc' }],
      updatedAt: null,
    });
    assert.strictEqual(canvas.status, 200, `canvas write: ${canvas.status}`);
  });

  after(async () => {
    await cleanupAll();
  });

  test('export a nonexistent project (404)', async () => {
    const res = await fetch(`${API_URL}/projects/does-not-exist/export`, { headers: authHeaders() });
    assert.strictEqual(res.status, 404);
  });

  test('access control: non-member viewer cannot export (403), viewer cannot import (403)', async () => {
    const exp = await req('GET', `/projects/${srcSlug}/export`, undefined, viewerAuth().headers);
    assert.strictEqual(exp.status, 403, 'non-member viewer must be denied export');

    const fd = new FormData();
    fd.append('file', new Blob([Buffer.from('x')]), 'x.tar.gz');
    const imp = await fetch(`${API_URL}/projects/import`, {
      method: 'POST',
      headers: viewerAuth().headers,
      body: fd,
    });
    assert.strictEqual(imp.status, 403, 'viewer must be denied import');
  });

  test('roundtrip: restore preserves files, notes, env and meta with fresh ports', async () => {
    snapshotGzip = await exportBytes(srcSlug);
    const { status, json } = await restore(snapshotGzip);
    assert.strictEqual(status, 201, `restore status: ${status} — ${json.error || ''}`);
    const project = json.project;
    createdSlugs.push(project.slug);

    assert.strictEqual(project.name, 'Snapshot Source');
    assert.strictEqual(project.description, 'the original source project');
    assert.strictEqual(project.status, 'running');
    assert.strictEqual(project.env.SNAP_VAR, 'roundtrip-value', 'env vars restored');
    assert.strictEqual(project.env.NODE_ENV, 'test');
    assert.ok(!project.ports.includes(SNAP_PORT), `manifest port taken by the source → fresh port (${project.ports})`);

    const file = await reqAuth('GET', `/projects/${project.slug}/file?path=app/main.py`);
    assert.strictEqual(file.status, 200, 'restored file readable');
    assert.strictEqual((await file.json()).content, 'print("madar snapshot roundtrip")');

    const goals = await reqAuth('GET', `/projects/${project.slug}/file?path=WSD_PROJECT.md`);
    assert.strictEqual(goals.status, 200, 'restored goals file readable');
    assert.match((await goals.json()).content, /ship snapshots/);

    const notesRes = await reqAuth('GET', `/projects/${project.slug}/notes`);
    const notes = (await notesRes.json()).items || [];
    assert.strictEqual(notes.length, 1, 'developer note restored');
    assert.strictEqual(notes[0].text, 'remember the polar bears');

    const canvasRes = await reqAuth('GET', `/projects/${project.slug}/canvas`);
    const canvas = await canvasRes.json();
    assert.strictEqual(canvas.nodes.length, 2, 'canvas nodes restored');
    assert.strictEqual(canvas.edges.length, 1, 'canvas edges restored');
    const card = canvas.nodes.find((nd: any) => nd.id === 'sc') ?? {};
    assert.strictEqual(card.type, 'card');
    assert.strictEqual(card.text, 'Make it survive restores');
    assert.strictEqual(card.color, 'green');
    assert.strictEqual(card.done, true, 'done flag restored');
    assert.strictEqual(canvas.edges[0].id, 'se', 'edge ids preserved through the roundtrip');
  });

  test('restore after the source is gone reuses the manifest ports', async () => {
    await reqAuth('DELETE', `/projects/${srcSlug}`);
    createdSlugs.splice(createdSlugs.indexOf(srcSlug), 1);

    const { status, json } = await restore(snapshotGzip);
    assert.strictEqual(status, 201, `re-restore status: ${status} — ${json.error || ''}`);
    const project = json.project;
    createdSlugs.push(project.slug);
    assert.ok(project.ports.includes(SNAP_PORT), `port freed by deleted source → reused (${project.ports})`);
  });

  test('import garbage that is not a gzip archive (400)', async () => {
    const { status, json } = await restore(Buffer.from('definitely not a snapshot'));
    assert.strictEqual(status, 400, `garbage import: ${status}`);
    assert.match(json.error || '', /tar\.gz|snapshot|Corrupt/i);
  });

  test('import without a file (400)', async () => {
    const res = await fetch(`${API_URL}/projects/import`, {
      method: 'POST',
      headers: authHeaders(),
    });
    // Multer with no file → our explicit 400.
    assert.strictEqual(res.status, 400);
  });

  test('import a tar.gz with a path-traversal entry (400)', async () => {
    // Hand-crafted tar with one entry whose name escapes the workspace.
    const hdr = Buffer.alloc(512);
    hdr.write('../evil.txt', 0, 100, 'ascii');
    hdr.write('0000644\0', 100, 8, 'ascii');
    hdr.write('00000000004\0', 124, 12, 'ascii'); // size 4 (octal)
    hdr[156] = 0x30; // typeflag '0'
    hdr.write('ustar', 257, 5, 'ascii');
    hdr[262] = 0;
    const evilTar = zlib.gzipSync(Buffer.concat([hdr, Buffer.from('evil')]));

    const { status, json } = await restore(evilTar);
    assert.strictEqual(status, 400, `traversal import: ${status}`);
    assert.match(json.error || '', /unsafe path/i);
  });
});