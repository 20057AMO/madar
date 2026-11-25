import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';

register(new URL('./ts-ext-resolve.mjs', import.meta.url).href);

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wsd-chatread-'));
const dataDir = path.join(base, 'data');
const previousDataDir = process.env.WSD_DATA_DIR;
process.env.WSD_DATA_DIR = dataDir;
fs.mkdirSync(dataDir, { recursive: true });

const store = await import('../src/services/chat-team-store.ts');

after(() => {
  if (previousDataDir === undefined) delete process.env.WSD_DATA_DIR;
  else process.env.WSD_DATA_DIR = previousDataDir;
  fs.rmSync(base, { recursive: true, force: true });
});

const readerId = 'reader';
const senderId = 'sender';

async function seed(channelId: string): Promise<{ m1: string; m2: string }> {
  const created = await store.createChannel({
    id: channelId,
    kind: 'channel',
    name: channelId,
    members: [],
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  assert.strictEqual(created.created, true);

  const m1 = await store.appendMessage(channelId, {
    id: `m-${channelId}-1`,
    userId: senderId,
    username: 'sender',
    text: 'first',
    createdAt: '2026-01-01T00:00:01.000Z',
    status: 'sent',
    readBy: [],
  });
  const m2 = await store.appendMessage(channelId, {
    id: `m-${channelId}-2`,
    userId: senderId,
    username: 'sender',
    text: 'second',
    createdAt: '2026-01-01T00:00:02.000Z',
    status: 'sent',
    readBy: [],
  });
  assert.ok(m1, 'first message seeded');
  assert.ok(m2, 'second message seeded');
  return { m1: m1.id, m2: m2.id };
}

describe('chat-team read receipts · exactly-once advance', () => {
  test('only one concurrent same-anchor mark advances the persisted read position', async () => {
    const channelId = 'read-concurrent';
    const { m2 } = await seed(channelId);

    const [first, second] = await Promise.all([
      store.markMessagesAsRead(channelId, readerId, m2),
      store.markMessagesAsRead(channelId, readerId, m2),
    ]);
    assert.ok(first, 'first concurrent mark resolved');
    assert.ok(second, 'second concurrent mark resolved');

    assert.strictEqual(Number(first.advanced) + Number(second.advanced), 1, 'exactly one call advanced');
    assert.strictEqual(
      Number(first.changed.length > 0) + Number(second.changed.length > 0),
      1,
      'exactly one call reported changed messages'
    );
    assert.strictEqual(store.getReadPosition(channelId, readerId), m2);
  });

  test('an equal anchor is a no-op after the position advanced', async () => {
    const channelId = 'read-equal';
    const { m2 } = await seed(channelId);
    const initial = await store.markMessagesAsRead(channelId, readerId, m2);
    assert.strictEqual(initial?.advanced, true);

    const repeated = await store.markMessagesAsRead(channelId, readerId, m2);
    assert.deepStrictEqual(repeated?.changed, []);
    assert.strictEqual(repeated?.advanced, false);
    assert.strictEqual(store.getReadPosition(channelId, readerId), m2);
  });

  test('a backwards anchor is a no-op and never rewinds the position', async () => {
    const channelId = 'read-backwards';
    const { m1, m2 } = await seed(channelId);
    const initial = await store.markMessagesAsRead(channelId, readerId, m2);
    assert.strictEqual(initial?.advanced, true);

    const backwards = await store.markMessagesAsRead(channelId, readerId, m1);
    assert.deepStrictEqual(backwards?.changed, []);
    assert.strictEqual(backwards?.advanced, false);
    assert.strictEqual(store.getReadPosition(channelId, readerId), m2);
  });

  test('an unknown anchor is refused without touching the read position', async () => {
    const channelId = 'read-unknown';
    await seed(channelId);

    const result = await store.markMessagesAsRead(channelId, readerId, 'm-unknown-anchor');
    assert.strictEqual(result, null);
    assert.strictEqual(store.getReadPosition(channelId, readerId), null);
  });
});
