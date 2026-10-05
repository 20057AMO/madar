/**
 * meta-store-locking.test.ts — the per-slug meta write lock must actually
 * serialize the PROJECT LIFECYCLE writes, and the crash pre-stop flag must never
 * block a stop on metadata the server cannot read.
 *
 *   A. LOST UPDATE ACROSS THE CREATE WINDOW. `createProject` read the store with
 *      `loadMeta`, then awaited the container creation, then wrote the merged
 *      document back with `saveMeta` — outside any lock. Any writer that held a
 *      document across an await (the shape `updateProjectLimits` /
 *      `updateMetaAsync` use) could interleave: the recreate's write landed
 *      first and the concurrent writer then persisted its STALE copy, silently
 *      reverting the fresh container's createdAt / ports / image. The fix routes
 *      the create/recreate write through `updateMetaAsync`, so both writers
 *      serialize on the same per-slug queue and each loads the other's result.
 *   B. STOP vs CORRUPT STORE. `markRequestedStop` used to throw on an unreadable
 *      meta.json, which failed the whole stop (500, container left running) over
 *      a bookkeeping flag. A corrupt store must be left untouched and the stop
 *      must still happen.
 *
 * REAL DOCKER, IN-PROCESS: the interleaving under test is between two writers
 * inside ONE process holding the SAME queue, so it can only be pinned by driving
 * the real `createProject`/`recreateProject`/`stopProject` while a test holds the
 * real lock — a live-HTTP hammer cannot order two requests against a queue.
 * Self-skips when the daemon is unreachable (mirrors the other live suites).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';

register(new URL('./ts-ext-resolve.mjs', import.meta.url).href);

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsd-metarace-'));
const workspacesDir = path.join(dataDir, 'workspaces');
// The mount audit is a server boot concern; pointing the host dir at the same
// temp workspace keeps the gate in 'ok' so createProject is not refused.
process.env.WSD_DATA_DIR = dataDir;
process.env.WSD_PROJECTS_DIR = workspacesDir;
process.env.WSD_WORKSPACES_HOST_DIR = workspacesDir;
fs.mkdirSync(path.join(dataDir, 'projects'), { recursive: true });
fs.mkdirSync(workspacesDir, { recursive: true });

const store = await import('../src/services/projects-meta.ts');
const dm = await import('../src/services/docker-manager.ts');

const metaFile = (slug: string) => path.join(dataDir, 'projects', slug, 'meta.json');
const SLUG_STOP = 'meta-race-stop';
const SLUG_LOCK = 'meta-race-lock';
const SLUG_LIMITS = 'meta-race-limits';

let dockerUp = false;
try {
  const Docker = (await import('dockerode')).default;
  await new Docker().listContainers({ all: false });
  dockerUp = true;
} catch {
  dockerUp = false;
}
const skip = dockerUp ? false : 'docker daemon unreachable — the meta-write race needs real containers';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(ok: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await ok()) return true;
    await sleep(40);
  }
  return false;
}

after(async () => {
  for (const slug of [SLUG_STOP, SLUG_LOCK, SLUG_LIMITS]) {
    try { await dm.removeProject(slug); } catch { /* best-effort */ }
  }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('stopProject — an unreadable meta store must not fail the stop', { skip }, () => {
  test('stop succeeds, the container is stopped, and the corrupt file is untouched', async () => {
    const created = await dm.createProject({ name: 'Meta Race Stop', slug: SLUG_STOP, ports: [await freePort()] });
    const torn = '{"name": "torn';
    fs.writeFileSync(metaFile(SLUG_STOP), torn, 'utf8');

    const info = await dm.stopProject(SLUG_STOP);
    assert.strictEqual(info.status, 'stopped', 'an explicit stop must not depend on readable metadata');
    assert.notStrictEqual(info.id, created.id);

    const live = await dm.getProject(SLUG_STOP);
    assert.strictEqual(live?.status, 'stopped');
    assert.strictEqual(
      fs.readFileSync(metaFile(SLUG_STOP), 'utf8'),
      torn,
      'the damaged store is the only copy of the project metadata — never overwrite it',
    );
  });
});

describe('createProject — the create window must not lose a concurrent meta write', { skip }, () => {
  test('a parked async mutator is refused (nothing persisted) and a sync writer survives the recreate', async () => {
    const created = await dm.createProject({ name: 'Meta Race Lock', slug: SLUG_LOCK, ports: [await freePort()] });
    const originalCreatedAt = store.readMeta(SLUG_LOCK).meta?.createdAt;
    assert.ok(originalCreatedAt, 'the fresh project must carry a createdAt');

    // The lost-update window used to be an `await mutator(meta)` INSIDE the
    // load→save section: the document was loaded, the mutator suspended, an
    // interleaved sync writer persisted a newer document, and the resumed write
    // then saved its STALE copy over it. That window is now closed by
    // construction, and the loud refusal is the proof — a thenable mutator
    // must never be silently awaited again.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const parked = store.updateMetaAsync(SLUG_LOCK, (async (meta) => {
      meta.tags = ['written-during-recreate'];
      await gate;
      // Cast past the `(meta) => void` signature deliberately: an async mutator
      // is a compile error now, so the runtime refusal needs an escape hatch.
    }) as any);
    await assert.rejects(
      parked,
      (e: any) => /synchronous mutator/i.test(String(e?.message || '')),
      'updateMetaAsync must refuse a thenable mutator instead of opening a lost-update window',
    );
    release();
    await parked.catch(() => { /* already rejected above */ });
    assert.strictEqual(
      store.readMeta(SLUG_LOCK).meta?.tags,
      undefined,
      'a refused mutator must not persist a partial document',
    );

    // A real writer (synchronous, like every production caller) still lands.
    store.updateMeta(SLUG_LOCK, (meta) => {
      meta.tags = ['written-during-recreate'];
      meta.description = 'written during the recreate';
    });

    const rebuild = dm.recreateProject(SLUG_LOCK);
    const rebuilt = await waitFor(async () => {
      const info = await dm.getProject(SLUG_LOCK);
      return !!info && info.id !== created.id;
    }, 60000);
    assert.ok(rebuilt, 'the recreate must have built a new container');
    const recreated = await rebuild;

    assert.notStrictEqual(recreated.id, created.id);
    const final = store.readMeta(SLUG_LOCK).meta || {};
    assert.deepStrictEqual(final.tags, ['written-during-recreate'], 'the concurrent write must survive the create window');
    assert.deepStrictEqual(final.ports, created.ports, 'the recreated container’s published ports must survive');
    assert.notStrictEqual(
      store.readMeta(SLUG_LOCK).meta?.createdAt,
      undefined,
      'the document must still be a complete one',
    );
  });
});

describe('updateProjectLimits — the limits write must validate inside a SYNC lock', { skip }, () => {
  test('it never queues behind an in-flight async meta write, and neither write is lost', async () => {
    await dm.createProject({ name: 'Meta Race Limits', slug: SLUG_LIMITS, ports: [await freePort()] });

    // An updateMetaAsync call is in flight (its mutator is synchronous now, so
    // it resolves on a microtask and never parks the queue mid-section). The
    // sync critical section inside updateProjectLimits must not wait for it,
    // and — the reason the section exists — both documents must survive.
    const inFlight = store.updateMetaAsync(SLUG_LIMITS, (meta) => {
      meta.description = 'async writer';
    });

    const limits = dm.updateProjectLimits(SLUG_LIMITS, { cpu: '1' });
    const outcome = await Promise.race([
      limits.then(() => 'ok' as const),
      sleep(1500).then(() => 'timeout' as const),
    ]);
    await inFlight;

    assert.strictEqual(outcome, 'ok', 'updateProjectLimits blocked on the async meta queue — it must validate synchronously');
    const final = store.readMeta(SLUG_LIMITS).meta || {};
    assert.strictEqual(final.limits?.cpu, '1', 'the limits write must land');
    assert.strictEqual(final.description, 'async writer', 'the async write must not be clobbered by the limits section');
  });
});