/**
 * storage-core.test.ts
 * Pure unit coverage for the import-free storage scanning helpers
 * (storage-core.ts) — no server, no Docker, temp dirs only.
 *
 * Contract:
 *  - Missing dirs → 0 bytes, not truncated.
 *  - Nested trees sum file bytes; symlinks count their link entry only
 *    (a symlink to a big file must NOT pull in the target's bytes).
 *  - A soft budget stops the walk early and reports truncated=true.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dirSize } from '../src/services/storage-core.ts';

const roots: string[] = [];

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'madar-storage-'));
  roots.push(dir);
  return dir;
}

function writeAbs(file: string, bytes: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes, 1));
}

after(() => {
  for (const r of roots) {
    try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* ignored */ }
  }
});

describe('dirSize', () => {
  test('missing dir → 0, never truncated', () => {
    assert.deepStrictEqual(dirSize(path.join(tmp(), 'nope')), { size: 0, truncated: false });
  });

  test('empty dir → 0', () => {
    assert.deepStrictEqual(dirSize(tmp()), { size: 0, truncated: false });
  });

  test('nested tree sums file bytes', () => {
    const root = tmp();
    writeAbs(path.join(root, 'a.txt'), 10);
    writeAbs(path.join(root, 'sub', 'b.txt'), 20);
    writeAbs(path.join(root, 'sub', 'deep', 'c.bin'), 44);
    writeAbs(path.join(root, 'sub', 'deep', 'd.bin'), 6);
    assert.deepStrictEqual(dirSize(root), { size: 80, truncated: false });
  });

  test('empty nested dirs contribute nothing', () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, 'empty', 'deeper'), { recursive: true });
    writeAbs(path.join(root, 'f.txt'), 7);
    assert.deepStrictEqual(dirSize(root), { size: 7, truncated: false });
  });

  test('symlink counts its link entry, never the target bytes', () => {
    const root = tmp();
    const target = path.join(root, 'target.bin');
    writeAbs(target, 64 * 1024);
    const tree = path.join(root, 'linkme');
    fs.mkdirSync(tree);
    try {
      fs.symlinkSync(target, path.join(tree, 'link.bin'));
    } catch {
      return; // no symlink support (Windows without admin/Dev Mode) — trait skipped
    }

    // The link ON ITS OWN must be tiny: the 64KB target must NOT be pulled in
    // (otherwise we'd see >= 64KB just for the link dir).
    const linkOnly = dirSize(tree);
    assert.ok(
      linkOnly.size < 64 * 1024,
      `target bytes leaked through the symlink (got ${linkOnly.size})`,
    );

    // Whole-root total is target size + tiny link overhead (~path length),
    // NOT target counted twice (target + followed link). No double-counting.
    const { size } = dirSize(root);
    assert.ok(
      size < 64 * 1024 + 1024,
      `target bytes must not be double-counted (got ${size})`,
    );
  });

  test('soft budget stops early and reports truncated', () => {
    const root = tmp();
    writeAbs(path.join(root, 'x1'), 100);
    writeAbs(path.join(root, 'x2'), 200);

    // Fake clock that is already past the budget on the first walk call.
    const now = (): number => 1000;
    const res = dirSize(root, { budgetMs: 0, now });
    assert.strictEqual(res.truncated, true);
    assert.strictEqual(res.size, 0);

    // Same fake clock but a generous budget → full result, not truncated.
    const full = dirSize(root, { budgetMs: 60_000, now });
    assert.deepStrictEqual(full, { size: 300, truncated: false });
  });
});