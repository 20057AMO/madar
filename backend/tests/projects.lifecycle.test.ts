import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import net from 'net';
import { execFileSync } from 'child_process';
import { uniqueId, reqAuth, initTestAuth } from './helpers.ts';

const HEAVY_SKIP = process.env.WSD_TEST_DOCKER_HEAVY === '1' && process.env.WSD_TEST_DOCKER === '1' ? false : 'requires WSD_TEST_DOCKER_HEAVY=1 + WSD_TEST_DOCKER=1';

const CONTAINER = process.env.WSD_TEST_CONTAINER || 'wsd-pro';
const PORTS_IN_USE = 'One or more requested ports are already in use by another project or service.';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function holdPort(requestedPort = 0): Promise<{ port: number; release: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(requestedPort, '0.0.0.0', () => {
      const port = (srv.address() as net.AddressInfo).port;
      resolve({
        port,
        release: () => new Promise((done, fail) => {
          srv.close((err) => (err ? fail(err) : done()));
        }),
      });
    });
  });
}

function readMetaRaw(slug: string): string {
  const hostPath = path.resolve(import.meta.dirname!, '..', '..', 'data', 'projects', slug, 'meta.json');
  if (fs.existsSync(hostPath)) return fs.readFileSync(hostPath, 'utf8');
  return execFileSync(
    'docker',
    ['exec', CONTAINER, 'cat', `/app/data/projects/${slug}/meta.json`],
    { encoding: 'utf8', timeout: 15000 },
  );
}

function hostWorkspaceDir(slug: string): string {
  return path.resolve(import.meta.dirname!, '..', '..', 'workspaces', slug);
}

function cleanupTestProject(slug: string): void {
  if (!slug) return;
  try {
    execFileSync('docker', ['rm', '-f', `wsd-${slug}`], { stdio: 'ignore', timeout: 15000 });
  } catch { /* best effort */ }
  try {
    execFileSync('docker', ['exec', CONTAINER, 'rm', '-rf', `/app/data/projects/${slug}`], {
      stdio: 'ignore',
      timeout: 15000,
    });
  } catch { /* best effort */ }
  try {
    fs.rmSync(hostWorkspaceDir(slug), { recursive: true, force: true });
  } catch { /* best effort */ }
}

describe('Project lifecycle (real Docker container)', { skip: HEAVY_SKIP }, () => {
  before(async () => { await initTestAuth(); });

  const slug = uniqueId('lc-test');
  let created = false;

  after(async () => {
    if (!created) return;
    try { await reqAuth('DELETE', `/projects/${slug}`); } catch { /* best effort */ }
  });

  test('create → 201 with a running container', async () => {
    const res = await reqAuth('POST', '/projects', {
      name: 'Lifecycle Test Project',
      slug,
      description: 'Temporary project for lifecycle testing',
    });
    assert.strictEqual(res.status, 201, `create failed: ${res.status}`);
    const data = await res.json();
    assert.strictEqual(data.project.slug, slug);
    assert.strictEqual(data.project.status, 'running');
    created = true;
  });

  test('get by slug returns the project', async () => {
    const res = await reqAuth('GET', `/projects/${slug}`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.project.slug, slug);
  });

  test('env update persists a variable', async () => {
    const res = await reqAuth('PUT', `/projects/${slug}/env`, { env: { WSD_TEST_VAR: 'lifecycle' } });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    const env = data.project?.env || data.env || {};
    assert.strictEqual(env.WSD_TEST_VAR, 'lifecycle');
  });

  test('files listing responds with structured entries', async () => {
    const put = await reqAuth('PUT', `/projects/${slug}/file?path=marker.txt`, { content: 'lifecycle' });
    assert.strictEqual(put.status, 200, `write file: ${put.status}`);
    const res = await reqAuth('GET', `/projects/${slug}/files`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.entries), 'files listing must expose an entries array');
    assert.ok(
      data.entries.every((e: any) => typeof e?.path === 'string' && ['file', 'dir', 'link'].includes(e?.type)),
      'every entry must expose { path, type }',
    );
    const marker = data.entries.find((e: any) => e.path === 'marker.txt');
    assert.ok(marker, 'the seeded marker must appear in the listing');
    assert.strictEqual(marker.type, 'file');
  });

  test('scripts listing returns an object', async () => {
    const res = await reqAuth('GET', `/projects/${slug}/scripts`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(typeof data.scripts === 'object');
  });

  test('logs respond with a string body', async () => {
    const res = await reqAuth('GET', `/projects/${slug}/logs?tail=20`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(typeof data.logs, 'string');
  });

  test('stats respond', async () => {
    const res = await reqAuth('GET', `/projects/${slug}/stats`);
    assert.ok([200, 404].includes(res.status), `unexpected stats status ${res.status}`);
  });

  test('ports check responds with checks array', async () => {
    const res = await reqAuth('GET', `/projects/${slug}/ports/check`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.checks));
  });

  test('stop → status becomes stopped', async () => {
    const res = await reqAuth('POST', `/projects/${slug}/stop`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.project.status, 'stopped');
  });

  test('start → status becomes running again', async () => {
    const res = await reqAuth('POST', `/projects/${slug}/start`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.project.status, 'running');
  });

  test('delete removes the project', async () => {
    const res = await reqAuth('DELETE', `/projects/${slug}`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.ok, true);
    created = false;
  });

  test('deleted project is gone (404)', async () => {
    const res = await reqAuth('GET', `/projects/${slug}`);
    assert.strictEqual(res.status, 404);
  });

  // The container bind-mounts ./workspaces, so the host-side path must be
  // gone too after deletion (files are no longer kept by design).
  test('workspace files are removed from disk', async () => {
    const hostDir = path.resolve(import.meta.dirname!, '..', '..', 'workspaces', slug);
    assert.strictEqual(
      fs.existsSync(hostDir),
      false,
      `expected workspace dir to be deleted: ${hostDir}`,
    );
  });

});

describe('Project lifecycle rollback (real Docker container)', { skip: HEAVY_SKIP }, () => {
  before(async () => { await initTestAuth(); });

  const rollbackSlug = uniqueId('lc-rollback');
  let rollbackCreated = false;
  let failedCreateSlug = '';
  let failedCreateCreated = false;

  after(async () => {
    if (rollbackCreated) { try { await reqAuth('DELETE', `/projects/${rollbackSlug}`); } catch { /* best effort */ } }
    if (failedCreateCreated) { try { await reqAuth('DELETE', `/projects/${failedCreateSlug}`); } catch { /* best effort */ } }
    cleanupTestProject(rollbackSlug);
    cleanupTestProject(failedCreateSlug);
  });

  test('failed create rolls back the container, meta and workspace', async () => {
    failedCreateSlug = uniqueId('lc-failed-create');
    const held = await holdPort();
    try {
      const res = await reqAuth('POST', '/projects', {
        name: 'Failed create rollback',
        slug: failedCreateSlug,
        ports: [held.port],
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 201) failedCreateCreated = true;
      assert.strictEqual(res.status, 409, `create should fail: ${res.status} ${JSON.stringify(data)}`);
      assert.strictEqual(data.error, PORTS_IN_USE);

      const detail = await reqAuth('GET', `/projects/${failedCreateSlug}`);
      assert.strictEqual(detail.status, 404, 'failed create must not leave a project');
      assert.strictEqual(fs.existsSync(hostWorkspaceDir(failedCreateSlug)), false, 'failed create must remove its workspace');
      assert.throws(() => readMetaRaw(failedCreateSlug), 'failed create must not persist meta');
      const containers = execFileSync('docker', ['ps', '-a', '--filter', `name=^/wsd-${failedCreateSlug}$`, '--format', '{{.Names}}'], { encoding: 'utf8' });
      assert.ok(!containers.includes(`wsd-${failedCreateSlug}`), 'failed create must not leave a container');
    } finally {
      await held.release();
    }
  });

  test('a failed recreate preserves the workspace and meta but leaves no container', async () => {
    const port = await freePort();
    const created = await reqAuth('POST', '/projects', {
      name: 'Recreate rollback',
      slug: rollbackSlug,
      description: 'temporary rollback test',
      ports: [port],
    });
    const createdData = await created.json().catch(() => ({}));
    assert.strictEqual(created.status, 201, `create failed: ${created.status} ${JSON.stringify(createdData)}`);
    rollbackCreated = true;

    const put = await reqAuth('PUT', `/projects/${rollbackSlug}/file?path=rollback-marker.txt`, { content: 'keep-me' });
    assert.strictEqual(put.status, 200, `write marker: ${put.status}`);

    const stopped = await reqAuth('POST', `/projects/${rollbackSlug}/stop`);
    assert.strictEqual(stopped.status, 200, `stop failed: ${stopped.status}`);

    const held = await holdPort(port);
    try {
      const recreated = await reqAuth('POST', `/projects/${rollbackSlug}/recreate`);
      const data = await recreated.json().catch(() => ({}));
      assert.strictEqual(recreated.status, 409, `recreate should fail: ${recreated.status} ${JSON.stringify(data)}`);
      assert.strictEqual(data.error, PORTS_IN_USE);
    } finally {
      await held.release();
    }

    const detail = await reqAuth('GET', `/projects/${rollbackSlug}`);
    assert.strictEqual(detail.status, 404, 'failed recreate must not leave a container');
    const marker = path.join(hostWorkspaceDir(rollbackSlug), 'rollback-marker.txt');
    assert.strictEqual(fs.existsSync(marker), true, 'failed recreate must keep workspace files');
    assert.strictEqual(fs.readFileSync(marker, 'utf8').trim(), 'keep-me');
    const meta = JSON.parse(readMetaRaw(rollbackSlug));
    assert.strictEqual(meta.name, 'Recreate rollback');
    assert.deepStrictEqual(meta.ports, [port]);

    rollbackCreated = false;
  });
});

describe('Project duplicate (real Docker container)', { skip: HEAVY_SKIP }, () => {
  const srcSlug = uniqueId('dup-src');
  const copySlug = uniqueId('dup-copy');
  let srcCreated = false;
  let copyCreated = false;
  let srcPort = 0;
  let copyPort = 0;

  before(async () => {
    await initTestAuth();
    srcPort = await freePort();
    copyPort = await freePort();
  });

  after(async () => {
    if (copyCreated) { try { await reqAuth('DELETE', `/projects/${copySlug}`); } catch { /* best effort */ } }
    if (srcCreated) { try { await reqAuth('DELETE', `/projects/${srcSlug}`); } catch { /* best effort */ } }
    cleanupTestProject(srcSlug);
    cleanupTestProject(copySlug);
  });

  test('create the source project (201)', async () => {
    const res = await reqAuth('POST', '/projects', {
      name: 'Duplicate Source',
      slug: srcSlug,
      description: 'source for duplicate tests',
      ports: [srcPort],
    });
    assert.strictEqual(res.status, 201, `create source failed: ${res.status}`);
    srcCreated = true;
  });

  test('seed a workspace file, a developer note and a canvas on the source', async () => {
    const wf = await reqAuth('PUT', `/projects/${srcSlug}/file?path=marker.txt`, { content: 'duplicate-me' });
    assert.strictEqual(wf.status, 200, `write file: ${wf.status}`);
    const notes = await reqAuth('PUT', `/projects/${srcSlug}/notes`, {
      items: [{ id: 'd1', text: 'carry this goal', kind: 'goal', done: false, createdAt: new Date().toISOString() }],
    });
    assert.strictEqual(notes.status, 200, `save notes: ${notes.status}`);
    const canvas = await reqAuth('PUT', `/projects/${srcSlug}/canvas`, {
      version: 1,
      nodes: [
        { id: 'dc1', type: 'note', text: 'Copy this idea', x: 10, y: 20, w: 220, h: 100, color: 'blue', done: false },
        { id: 'dc2', type: 'card', text: 'And this task', x: 300, y: 40, w: 240, h: 120, color: 'green', done: false },
      ],
      edges: [{ id: 'de1', from: 'dc1', to: 'dc2' }],
      updatedAt: null,
    });
    assert.strictEqual(canvas.status, 200, `save canvas: ${canvas.status}`);
  });

  test('duplicate creates a new project (201)', async () => {
    const res = await reqAuth('POST', `/projects/${srcSlug}/duplicate`, {
      name: 'Copied Project',
      slug: copySlug,
      description: 'a copy',
      ports: [copyPort],
    });
    const data = await res.json();
    assert.strictEqual(res.status, 201, `duplicate failed: ${res.status} -> ${JSON.stringify(data)}`);
    assert.strictEqual(data.project.slug, copySlug);
    assert.strictEqual(data.project.status, 'running');
    copyCreated = true;
  });

  test('duplicate applies the provided fresh ports', async () => {
    const res = await reqAuth('GET', `/projects/${copySlug}`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(data.project.ports.includes(copyPort), 'the provided ports should be applied');
  });

  test('duplicate copies the workspace file', async () => {
    const res = await reqAuth('GET', `/projects/${copySlug}/file?path=marker.txt`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(String(data.content ?? data.text ?? data).trim(), 'duplicate-me');
  });

  test('duplicate copies the developer note', async () => {
    const res = await reqAuth('GET', `/projects/${copySlug}/notes`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    const texts = data.items.map((n: any) => n.text);
    assert.ok(texts.includes('carry this goal'), 'note should be copied to the duplicate');
  });

  test('duplicate copies the planning canvas', async () => {
    const res = await reqAuth('GET', `/projects/${copySlug}/canvas`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.nodes.length, 2, 'canvas nodes should be copied to the duplicate');
    assert.strictEqual(data.edges.length, 1);
    assert.ok(data.nodes.find((n: any) => n.id === 'dc1' && n.text === 'Copy this idea'), 'canvas node carried over');
  });

  test('the source project is left untouched', async () => {
    const src = await reqAuth('GET', `/projects/${srcSlug}`);
    const srcData = await src.json();
    assert.strictEqual(srcData.project.slug, srcSlug);
    const files = await reqAuth('GET', `/projects/${srcSlug}/file?path=marker.txt`);
    const fd = await files.json();
    assert.strictEqual(String(fd.content ?? fd.text ?? fd).trim(), 'duplicate-me');
  });

  test('duplicating a nonexistent project returns 404', async () => {
    const res = await reqAuth('POST', `/projects/nope-missing-project/duplicate`, { name: 'x', ports: [8099] });
    assert.strictEqual(res.status, 404);
  });

  test('delete removes both projects', async () => {
    const c = await reqAuth('DELETE', `/projects/${copySlug}`);
    assert.strictEqual(c.status, 200);
    copyCreated = false;
    const s = await reqAuth('DELETE', `/projects/${srcSlug}`);
    assert.strictEqual(s.status, 200);
    srcCreated = false;
  });
});
