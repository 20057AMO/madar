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
  test('a writer holding the lock across an await survives the recreate, and the recreate survives it', async () => {
    const created = await dm.createProject({ name: 'Meta Race Lock', slug: SLUG_LOCK, ports: [await freePort()] });
    const originalCreatedAt = store.readMeta(SLUG_LOCK).meta?.createdAt;
    assert.ok(originalCreatedAt, 'the fresh project must carry a createdAt');

    // A concurrent writer exactly like updateProjectLimits: it takes the lock,
    // loads the document, then AWAITS before persisting — so it holds a stale
    // copy of the document for the whole recreate window.
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const insideMutator = new Promise<void>((resolve) => { entered = resolve; });
    const concurrent = store.updateMetaAsync(SLUG_LOCK, async (meta) => {
      meta.tags = ['written-during-recreate'];
      meta.description = 'written during the recreate';
      entered();
      await held;
    });
    await insideMutator;

    // Recreate in the background: it tears the container down and creates a
    // fresh one, which is the window the meta write used to escape the lock.
    const recreate = dm.recreateProject(SLUG_LOCK);
    const rebuilt = await waitFor(async () => {
      const info = await dm.getProject(SLUG_LOCK);
      return !!info && info.id !== created.id;
    }, 60000);
    assert.ok(rebuilt, 'the recreate must have built a new container');

// Order the two writes deterministically instead of hoping: hold the
    // concurrent writer until the recreate has PERSISTED its document. Whether
    // the recreate gets that far before the release is exactly what is under
    // test — with the create write inside the per-slug queue it is queued
    // behind the writer we are holding, so the wait times out (the proof that
    // the interleaving is now impossible); without the queue the recreate's
    // write lands inside the grace and the release below is deliberately TOO
    // LATE. The grace is generous because a recreate's own container work
    // (stop + remove + start) runs before the meta write, and it is bounded by
    // neither side: a stuck recreate must not hang the suite.
    await Promise.race([
      recreate.then(() => 'recreated'),
      waitFor(async () => {
        const meta = store.readMeta(SLUG_LOCK).meta;
        return !!meta && meta.createdAt !== originalCreatedAt;
      }, 30000).then(() => 'create-window-persisted'),
    ]);

    release();
    await concurrent;
    const recreated = await recreate;
    assert.notStrictEqual(recreated.id, created.id);

    const final = store.readMeta(SLUG_LOCK).meta || {};
    assert.deepStrictEqual(final.tags, ['written-during-recreate'], 'the concurrent write must survive the create window');
    assert.notStrictEqual(
      final.createdAt,
      originalCreatedAt,
      'the recreate write must not be clobbered by the concurrent writer’s stale document',
    );
    assert.deepStrictEqual(final.ports, created.ports, 'the recreated container’s published ports must survive');
  });
});

describe('updateProjectLimits — the limits write must validate inside a SYNC lock', { skip }, () => {
  test('it never queues behind a held async meta lock (host check resolved before the lock)', async () => {
    await dm.createProject({ name: 'Meta Race Limits', slug: SLUG_LIMITS, ports: [await freePort()] });

    // Deliberately occupy the per-slug queue with an async holder. This violates
    // the "async holder never awaits" invariant ON PURPOSE — it is the exact
    // shape the old updateProjectLimits had (mutator suspended mid-lock), and it
    // is the only deterministic way to tell the fixed code from the old one.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = store.updateMetaAsync(SLUG_LIMITS, async (meta) => {
      meta.description = 'held async writer';
      await gate;
    });
    await sleep(50); // let the holder acquire the lock and load the document

    const limits = dm.updateProjectLimits(SLUG_LIMITS, { cpu: '1' });
    const outcome = await Promise.race([
      limits.then(() => 'ok' as const),
      sleep(1500).then(() => 'timeout' as const),
    ]);
    // Read BEFORE releasing the holder: an async-queued write could not have
    // persisted yet, so a visible '1' proves the write ran synchronously.
    const cpuWhileHeld = store.readMeta(SLUG_LIMITS).meta?.limits?.cpu;

    release();
    await holder.catch(() => { /* the stale holder write is irrelevant here */ });
    await limits.catch(() => { /* asserted above via `outcome` */ });

    assert.strictEqual(outcome, 'ok', 'updateProjectLimits blocked on an async-held meta lock — it must validate synchronously');
    assert.strictEqual(cpuWhileHeld, '1', 'the limits write must be visible immediately, not queued behind the held async lock');
  });
});