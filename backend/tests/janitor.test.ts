/**
 * workspace-janitor.test.ts
 * Unit coverage for the automatic orphaned-workspace cleanup:
 *  - orphan dirs (no project meta) are archived out of the workspaces root
 *  - live projects are never touched
 *  - dot-dirs are ignored (they hide runtime state)
 *  - expired archive entries are purged (WSD_ARCHIVE_DAYS=0 ⇒ immediate)
 *
 * Runs fully offline against a temp dir — no server, no Docker.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { register } from 'node:module';

register(new URL('./ts-ext-resolve.mjs', import.meta.url).href);

describe('Workspace janitor', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsd-janitor-'));
  const wsRoot = path.join(tmp, 'workspaces');
  const dataDir = path.join(tmp, 'data');

  // Env is read at module-import time, so set it before the dynamic import.
  process.env.WSD_DATA_DIR = dataDir; // audits (transitively imported) stay in temp
  process.env.WSD_PROJECTS_DIR = wsRoot;
  process.env.WSD_ARCHIVE_DAYS = '0';

  let runSweep!: () => Promise<{ archived: string[]; purged: string[] }>;
  let withFileLockAsync!: (key: string, fn: () => Promise<void>) => Promise<void>;
  let lifecycleLock!: string;

  const ready = (async () => {
    const { WORKSPACE_LIFECYCLE_LOCK } = await import('../src/services/janitor-core.ts');
    const { runSweep: serviceRunSweep } = await import('../src/services/workspace-janitor.ts');
    const { withFileLockAsync: lock } = await import('../src/services/write-queue.ts');
    lifecycleLock = WORKSPACE_LIFECYCLE_LOCK;
    withFileLockAsync = lock;
    runSweep = serviceRunSweep;

    // Fixtures: two orphans, one live project, one runtime dot-dir.
    fs.mkdirSync(path.join(wsRoot, 'orphan-a', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(wsRoot, 'orphan-a', 'file.txt'), 'x');
    fs.writeFileSync(path.join(wsRoot, 'orphan-a', 'nested', 'deep.txt'), 'y');
    fs.mkdirSync(path.join(wsRoot, 'orphan-b'), { recursive: true });
    fs.writeFileSync(path.join(wsRoot, 'orphan-b', 'f'), 'z');
    fs.mkdirSync(path.join(wsRoot, 'live-proj'), { recursive: true });
    fs.writeFileSync(path.join(wsRoot, 'live-proj', 'keep.txt'), 'keep');
    fs.mkdirSync(path.join(dataDir, 'projects', 'live-proj'), { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, 'projects', 'live-proj', 'meta.json'),
      JSON.stringify({ activity: [] }),
    );
    fs.mkdirSync(path.join(wsRoot, '.runtime-cache'), { recursive: true });
    fs.writeFileSync(path.join(wsRoot, '.runtime-cache', 'junk'), 'j');
  })();

  test('first sweep archives orphans, keeps live projects and dot-dirs', async () => {
    await ready;
    const r = await runSweep();
    assert.ok(r.archived.includes('orphan-a'), `orphan-a not archived: ${r.archived}`);
    assert.ok(r.archived.includes('orphan-b'), `orphan-b not archived: ${r.archived}`);
    assert.ok(!r.archived.includes('live-proj'), 'live project must never be archived');
    assert.strictEqual(
      fs.existsSync(path.join(wsRoot, 'live-proj', 'keep.txt')),
      true,
      'live project files must stay put',
    );
    assert.strictEqual(fs.existsSync(path.join(wsRoot, 'orphan-a')), false);
    const archive = path.join(wsRoot, '.archive');
    const movedA = fs.readdirSync(archive).find((n) => n.endsWith('-orphan-a'));
    assert.ok(movedA, 'archived copy must exist under .archive');
    assert.strictEqual(
      fs.existsSync(path.join(archive, String(movedA), 'nested', 'deep.txt')),
      true,
      'archived tree must be complete',
    );
    assert.strictEqual(fs.existsSync(path.join(wsRoot, '.runtime-cache')), true, 'dot-dirs must be ignored');
  });

  test('second sweep purges expired archive entries (ARCHIVE_DAYS=0)', async () => {
    await ready;
    const r = await runSweep();
    assert.ok(r.purged.length >= 2, `expected purged entries, got ${r.purged.length}`);
    const remaining = fs.existsSync(path.join(wsRoot, '.archive'))
      ? fs.readdirSync(path.join(wsRoot, '.archive'))
      : [];
    assert.strictEqual(remaining.filter((n) => n.endsWith('-orphan-a') || n.endsWith('-orphan-b')).length, 0);
    assert.ok(!r.archived.includes('live-proj'));
  });

  test('sweep over an empty root is a clean no-op', async () => {
    await ready;
    const r = await runSweep();
    assert.deepStrictEqual(r, { archived: [], purged: [] });
  });

  test('live project created AFTER fixtures still survives sweeps', async () => {
    await ready;
    fs.mkdirSync(path.join(dataDir, 'projects', 'late-live'), { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, 'projects', 'late-live', 'meta.json'),
      JSON.stringify({ activity: [] }),
    );
    fs.mkdirSync(path.join(wsRoot, 'late-live'), { recursive: true });
    fs.writeFileSync(path.join(wsRoot, 'late-live', 'data.txt'), 'd');
    await runSweep();
    assert.strictEqual(fs.existsSync(path.join(wsRoot, 'late-live', 'data.txt')), true);
  });

  test('a sweep waits for a held lifecycle lock instead of archiving mid-create', async () => {
    await ready;
    const slug = 'locked-orphan';
    const dir = path.join(wsRoot, slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'canary.txt'), 'safe');

    let acquired!: () => void;
    let release!: () => void;
    const acquiredPromise = new Promise<void>((resolve) => { acquired = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const hold = withFileLockAsync(lifecycleLock, async () => {
      acquired();
      await gate;
    });
    await acquiredPromise;

    const sweep = runSweep();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.strictEqual(fs.existsSync(path.join(dir, 'canary.txt')), true);
    release();
    await hold;
    const r = await sweep;
    assert.ok(r.archived.includes(slug), `held-lock sweep must archive after release: ${r.archived}`);
    assert.strictEqual(fs.existsSync(dir), false);
  });
});
