/**
 * attachment-gc-core.test.ts
 * Offline unit coverage for the pure attachment-GC rules (attachment-gc.ts):
 *  - collectReferencedIds: union of every attachment id referenced by any
 *    message file; corrupt/missing files silently skipped.
 *  - findUnreferencedUploads: on-disk uploads minus the referenced set, aged
 *    by mtime against maxAgeMs.
 *  - pruneUnreferenced: deletes only old + unreferenced files, returns count.
 *
 * Runs fully offline against a temp dir — no server, no Docker
 * (same pattern as janitor-core / archive-core).
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  collectReferencedIds,
  findUnreferencedUploads,
  pruneUnreferenced,
} from '../src/services/attachment-gc.ts';

const HOUR_MS = 60 * 60 * 1000;

describe('Attachment GC (orphaned uploads)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-'));
  const messagesDir = path.join(tmp, 'messages');
  const uploadsDir = path.join(tmp, 'uploads');

  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** Fresh fixture dirs per test — no cross-test state. */
  function resetDirs(): void {
    fs.rmSync(messagesDir, { recursive: true, force: true });
    fs.rmSync(uploadsDir, { recursive: true, force: true });
    fs.mkdirSync(messagesDir, { recursive: true });
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  function writeMessages(channelId: string, messages: unknown[]): void {
    fs.writeFileSync(path.join(messagesDir, `${channelId}.json`), JSON.stringify(messages), 'utf8');
  }

  function writeUpload(id: string, mtime: Date = new Date()): void {
    fs.writeFileSync(path.join(uploadsDir, id), 'bytes', 'utf8');
    fs.utimesSync(path.join(uploadsDir, id), mtime, mtime);
  }

  const old = () => new Date(Date.now() - 2 * HOUR_MS);

  describe('collectReferencedIds', () => {
    test('missing messages dir → empty set', () => {
      resetDirs();
      fs.rmSync(messagesDir, { recursive: true, force: true });
      assert.deepStrictEqual([...collectReferencedIds(messagesDir)], []);
    });
    test('messages without attachments → empty set', () => {
      resetDirs();
      writeMessages('ch-1', [{ id: 'm-1', text: 'no atts' }, { id: 'm-2', text: 'still none' }]);
      assert.deepStrictEqual([...collectReferencedIds(messagesDir)], []);
    });
    test('a message with two attachments yields both ids', () => {
      resetDirs();
      writeMessages('ch-1', [
        { id: 'm-1', attachments: [{ id: 'att-1', name: 'a' }, { id: 'att-2', name: 'b' }] },
        { id: 'm-2', attachments: [{ id: 'att-1', name: 'again' }] },
      ]);
      const ids = [...collectReferencedIds(messagesDir)].sort();
      assert.deepStrictEqual(ids, ['att-1', 'att-2']);
    });
    test('references across multiple channel files are unioned', () => {
      resetDirs();
      writeMessages('ch-1', [{ id: 'm-1', attachments: [{ id: 'att-x' }] }]);
      writeMessages('ch-2', [{ id: 'm-2', attachments: [{ id: 'att-y' }] }]);
      const ids = [...collectReferencedIds(messagesDir)].sort();
      assert.deepStrictEqual(ids, ['att-x', 'att-y']);
    });
    test('corrupt json and non-array payloads are silently skipped', () => {
      resetDirs();
      writeMessages('ch-1', [{ id: 'm-1', attachments: [{ id: 'att-k' }] }]);
      fs.writeFileSync(path.join(messagesDir, 'ch-bad.json'), '{ not json', 'utf8');
      fs.writeFileSync(path.join(messagesDir, 'ch-obj.json'), JSON.stringify({ nope: true }), 'utf8');
      assert.deepStrictEqual([...collectReferencedIds(messagesDir)], ['att-k']);
    });
    test('non-.json entries in the messages dir are ignored', () => {
      resetDirs();
      writeMessages('ch-1', [{ id: 'm-1', attachments: [{ id: 'att-j' }] }]);
      fs.writeFileSync(path.join(messagesDir, 'readme.txt'), 'hi', 'utf8');
      assert.deepStrictEqual([...collectReferencedIds(messagesDir)], ['att-j']);
    });
  });

  describe('findUnreferencedUploads', () => {
    test('referenced files are never candidates regardless of age', () => {
      resetDirs();
      writeMessages('ch-1', [{ id: 'm-1', attachments: [{ id: 'att-old-ref' }] }]);
      writeUpload('att-old-ref', old());
      writeUpload('att-stale', old());
      const stale = findUnreferencedUploads(uploadsDir, collectReferencedIds(messagesDir), 60_000);
      assert.deepStrictEqual(stale, ['att-stale']);
    });
    test('unreferenced but fresh files (mtime now) stay under maxAge', () => {
      resetDirs();
      writeUpload('att-fresh', new Date());
      const stale = findUnreferencedUploads(uploadsDir, new Set(), HOUR_MS);
      assert.deepStrictEqual(stale, []);
    });
    test('unreferenced files older than maxAge are reported', () => {
      resetDirs();
      writeUpload('att-fresh', new Date());
      writeUpload('att-old', old());
      const stale = findUnreferencedUploads(uploadsDir, new Set(), HOUR_MS);
      assert.deepStrictEqual(stale, ['att-old']);
    });
    test('missing uploads dir → empty list', () => {
      resetDirs();
      fs.rmSync(uploadsDir, { recursive: true, force: true });
      assert.deepStrictEqual(findUnreferencedUploads(uploadsDir, new Set(), HOUR_MS), []);
    });
    test('meta.json files are never candidates (pattern mismatch)', () => {
      resetDirs();
      writeUpload('att-abc.meta.json', old());
      writeUpload('att-abc', old());
      const stale = findUnreferencedUploads(uploadsDir, new Set(), HOUR_MS);
      assert.deepStrictEqual(stale, ['att-abc'], 'the att- file is stale but the .meta.json is not');
    });
    test('non-att- files in uploads dir are ignored', () => {
      resetDirs();
      writeUpload('random.txt', old());
      writeUpload('temp.log', old());
      const stale = findUnreferencedUploads(uploadsDir, new Set(), HOUR_MS);
      assert.deepStrictEqual(stale, []);
    });
  });

  describe('pruneUnreferenced', () => {
    test('deletes only old + unreferenced uploads and returns the count', () => {
      resetDirs();
      writeMessages('ch-1', [{ id: 'm-1', attachments: [{ id: 'att-kept' }] }]);
      writeUpload('att-kept', old()); // referenced — must survive even when old
      writeUpload('att-gone', old()); // old + unreferenced — pruned
      writeUpload('att-new', new Date()); // fresh — kept
      const pruned = pruneUnreferenced(messagesDir, uploadsDir, HOUR_MS);
      assert.strictEqual(pruned, 1);
      assert.strictEqual(fs.existsSync(path.join(uploadsDir, 'att-kept')), true);
      assert.strictEqual(fs.existsSync(path.join(uploadsDir, 'att-new')), true);
      assert.strictEqual(fs.existsSync(path.join(uploadsDir, 'att-gone')), false);
    });
    test('nothing to prune when every upload is referenced → 0', () => {
      resetDirs();
      writeMessages('ch-1', [{ id: 'm-1', attachments: [{ id: 'att-a' }, { id: 'att-b' }] }]);
      writeUpload('att-a', old());
      writeUpload('att-b', old());
      assert.strictEqual(pruneUnreferenced(messagesDir, uploadsDir, HOUR_MS), 0);
      assert.strictEqual(fs.existsSync(path.join(uploadsDir, 'att-a')), true);
      assert.strictEqual(fs.existsSync(path.join(uploadsDir, 'att-b')), true);
    });
    test('empty dirs → 0 without throwing', () => {
      resetDirs();
      assert.strictEqual(pruneUnreferenced(messagesDir, uploadsDir, HOUR_MS), 0);
    });
    test('referenced att + its .meta.json both survive prune', () => {
      resetDirs();
      writeMessages('ch-1', [{ id: 'm-1', attachments: [{ id: 'att-abc' }] }]);
      writeUpload('att-abc', old());
      fs.writeFileSync(path.join(uploadsDir, 'att-abc.meta.json'), JSON.stringify({ channelId: 'ch-1' }), 'utf8');
      const pruned = pruneUnreferenced(messagesDir, uploadsDir, HOUR_MS);
      assert.strictEqual(pruned, 0);
      assert.strictEqual(fs.existsSync(path.join(uploadsDir, 'att-abc')), true);
      assert.strictEqual(fs.existsSync(path.join(uploadsDir, 'att-abc.meta.json')), true);
    });
    test('orphan att + its .meta.json both deleted on prune', () => {
      resetDirs();
      writeUpload('att-orphan', old());
      fs.writeFileSync(path.join(uploadsDir, 'att-orphan.meta.json'), JSON.stringify({ channelId: 'ch-old' }), 'utf8');
      const pruned = pruneUnreferenced(messagesDir, uploadsDir, HOUR_MS);
      assert.strictEqual(pruned, 1);
      assert.strictEqual(fs.existsSync(path.join(uploadsDir, 'att-orphan')), false);
      assert.strictEqual(fs.existsSync(path.join(uploadsDir, 'att-orphan.meta.json')), false);
    });
    test('non-att- files are never pruned even when old', () => {
      resetDirs();
      fs.writeFileSync(path.join(uploadsDir, 'random.txt'), 'junk', 'utf8');
      fs.utimesSync(path.join(uploadsDir, 'random.txt'), old(), old());
      fs.writeFileSync(path.join(uploadsDir, 'temp.log'), 'junk', 'utf8');
      fs.utimesSync(path.join(uploadsDir, 'temp.log'), old(), old());
      const pruned = pruneUnreferenced(messagesDir, uploadsDir, HOUR_MS);
      assert.strictEqual(pruned, 0);
      assert.strictEqual(fs.existsSync(path.join(uploadsDir, 'random.txt')), true);
      assert.strictEqual(fs.existsSync(path.join(uploadsDir, 'temp.log')), true);
    });
  });
});