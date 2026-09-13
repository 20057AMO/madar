/**
 * chat-team-core.test.ts
 * Offline unit coverage for the import-free team-chat pure rules
 * (chat-team-core.ts) — no server, no Docker.
 *
 * Contract:
 *  - normalizeMessage validates text length/control chars, replyTo format,
 *    @mention extraction (unique, case-insensitive).
 *  - formatMessage shapes a full record; dangling replyTo refs are dropped.
 *  - searchMessages is case-insensitive.
 *  - pruneToCap keeps only the newest window; pinnedMessages newest-first.
 *  - channel ids are restricted to the safe charset (fs/ws/route keys).
 *  - Deterministic project/direct channel ids never collide with manual ids.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  MAX_TEXT_CHARS,
  MAX_CHANNEL_ATTACHMENT_BYTES,
  buildProjectChannelId,
  buildDirectChannelId,
  sanitizePlain,
  sanitizeCanSend,
  isChannelAdmin,
  parseMentions,
  normalizeMessage,
  formatMessage,
  searchMessages,
  pruneToCap,
  pinnedMessages,
  channelAttachmentBytes,
  wouldExceedAttachmentQuota,
  isChannelId,
  isMessageId,
  CHANNEL_ID_RE,
  channelSortKey,
  channelLabel,
  type TeamChannel,
  type TeamMessage,
} from '../src/services/chat-team-core.ts';

describe('sanitizePlain', () => {
  test('trims and strips control chars', () => {
    assert.strictEqual(sanitizePlain('  hello world\n ' as any, 20), 'hello world');
    assert.strictEqual(sanitizePlain('a\u0000b\u0007c' as any, 20), 'abc');
  });
  test('rejects non-strings, empty, and over-long', () => {
    assert.strictEqual(sanitizePlain(42, 20), null);
    assert.strictEqual(sanitizePlain('   ', 20), null);
    assert.strictEqual(sanitizePlain('x'.repeat(21), 20), null);
  });
});

describe('parseMentions', () => {
  test('extracts @username targets uniquely + lowercase', () => {
    assert.deepStrictEqual(parseMentions('hey @AhmedAli foo @ahmedali again'), ['ahmedali']);
    assert.deepStrictEqual(parseMentions('no target'), []);
    assert.deepStrictEqual(parseMentions('@a-b.x_y hi'), ['a-b.x_y']);
  });
  test('does not treat emails as mentions', () => {
    assert.deepStrictEqual(parseMentions('mail me at a@b.com'), []);
  });
  test('M5: extracts Arabic usernames (Unicode-aware \p{L}\p{N})', () => {
    assert.deepStrictEqual(parseMentions('راسل @أحمد لإتمام المهمة'), ['أحمد']);
    assert.deepStrictEqual(parseMentions('شكراً @محمد_علي!'), ['محمد_علي']);
    assert.deepStrictEqual(parseMentions('hi @user.name and @أحمد'), ['user.name', 'أحمد']);
  });
  test('M5: mention length respects the 50-char username cap', () => {
    // A >50-char run is capped at 50 by the greedy quantifier (never longer —
    // user-store rejects usernames over 50, so a longer extract is a bug).
    assert.strictEqual(parseMentions('@' + 'a'.repeat(51) + ' ')[0].length, 50);
    assert.strictEqual(parseMentions('@' + 'أ'.repeat(51))[0].length, 50);
    assert.strictEqual(parseMentions('@' + 'x'.repeat(50))[0].length, 50);
    // Below the 2-char minimum nothing is extracted.
    assert.deepStrictEqual(parseMentions('@a ok'), []);
  });
});

describe('normalizeMessage', () => {
  const valid = { text: 'hello team', replyTo: 'm-abc123' };
  test('accepts valid text', () => {
    const out = normalizeMessage(valid);
    assert.ok(out);
    assert.strictEqual(out!.text, 'hello team');
    assert.strictEqual(out!.replyTo, 'm-abc123');
    assert.deepStrictEqual(out!.mentions, []);
  });
  test('rejects junk bodies', () => {
    assert.strictEqual(normalizeMessage(null), null);
    assert.strictEqual(normalizeMessage('nope'), null);
    assert.strictEqual(normalizeMessage({}), null);
    assert.strictEqual(normalizeMessage({ text: '   ' }), null);
    assert.strictEqual(normalizeMessage({ text: 'x'.repeat(MAX_TEXT_CHARS + 1) }), null);
  });
  test('rejects non-message-id replyTo', () => {
    assert.strictEqual(normalizeMessage({ text: 'x', replyTo: '../etc/passwd' }), null);
    assert.strictEqual(normalizeMessage({ text: 'x', replyTo: 'att-abc' }), null);
  });
  test('empty replyTo is treated as absent', () => {
    const out = normalizeMessage({ text: 'x', replyTo: '' });
    assert.ok(out);
    assert.strictEqual(out!.replyTo, undefined);
  });
});

describe('formatMessage', () => {
  test('drops dangling replyTo without replyToExists', () => {
    const msg = formatMessage('m-1', 'u-1', 'alice', { text: 'hi', replyTo: 'm-9', mentions: [] }, { replyToExists: false });
    assert.strictEqual(msg.replyTo, undefined);
  });
  test('keeps replyTo when target exists', () => {
    const msg = formatMessage('m-2', 'u-1', 'alice', { text: 'hi', replyTo: 'm-9', mentions: [] }, { replyToExists: true });
    assert.strictEqual(msg.replyTo, 'm-9');
  });
  test('pins + caps attachments and keeps mentions', () => {
    const atts = Array.from({ length: 50 }, (_, i) => ({ id: `att-${i}`, name: `f${i}`, kind: 'file' as const, size: 1 }));
    const msg = formatMessage('m-3', 'u-2', 'bob', { text: '@alice hi', mentions: ['alice'] }, { pinned: true, attachments: atts });
    assert.strictEqual(msg.attachments!.length, 5);
    assert.strictEqual(msg.pinned, true);
    assert.deepStrictEqual(msg.mentions, ['alice']);
  });
});

describe('searchMessages', () => {
  const msgs: TeamMessage[] = [
    { id: 'm-1', userId: 'u', username: 'a', text: 'Deploy to Production', createdAt: 't' },
    { id: 'm-2', userId: 'u', username: 'b', text: 'where is the config?', createdAt: 't' },
  ];
  test('case-insensitive substring match', () => {
    assert.deepStrictEqual(searchMessages(msgs, 'PRODUCTION').map((m) => m.id), ['m-1']);
    assert.deepStrictEqual(searchMessages(msgs, 'zzz'), []);
  });
  test('empty query returns nothing', () => {
    assert.deepStrictEqual(searchMessages(msgs, '  '), []);
  });
});

describe('pruneToCap', () => {
  const make = (n: number): TeamMessage[] =>
    Array.from({ length: n }, (_, i) => ({ id: `m-${i}`, userId: 'u', username: 'a', text: String(i), createdAt: `t${i}` }));
  test('keeps newest window below cap', () => {
    const kept = pruneToCap(make(520), 500);
    assert.strictEqual(kept.length, 500);
    assert.strictEqual(kept[0].id, 'm-20');
  });
  test('under cap unchanged', () => {
    const msgs = make(10);
    assert.strictEqual(pruneToCap(msgs, 500), msgs);
  });
  test('custom cap respected', () => {
    assert.strictEqual(pruneToCap(make(30), 20).length, 20);
  });
});

describe('channelAttachmentBytes', () => {
  test('messages without attachments → 0', () => {
    assert.strictEqual(channelAttachmentBytes([{ id: 'm-1' }, { id: 'm-2' }]), 0);
  });
  test('sums sizes across a message with two attachments', () => {
    const msgs = [{ id: 'm-1', attachments: [{ id: 'att-a', size: 10 }, { id: 'att-b', size: 20 }] }];
    assert.strictEqual(channelAttachmentBytes(msgs), 30);
  });
  test('aggregates across multiple messages', () => {
    const msgs = [
      { id: 'm-1', attachments: [{ id: 'att-a', size: 10 }] },
      { id: 'm-2', attachments: [{ id: 'att-b', size: 20 }, { id: 'att-c', size: 30 }] },
      { id: 'm-3' },
    ];
    assert.strictEqual(channelAttachmentBytes(msgs), 60);
  });
  test('attachments without size are ignored (0)', () => {
    const msgs = [{ id: 'm-1', attachments: [{ id: 'att-a' }, { id: 'att-b', size: 5 }] }];
    assert.strictEqual(channelAttachmentBytes(msgs), 5);
  });
  test('empty message list → 0', () => {
    assert.strictEqual(channelAttachmentBytes([]), 0);
  });
});

describe('wouldExceedAttachmentQuota', () => {
  test('below the ceiling → false', () => {
    assert.strictEqual(wouldExceedAttachmentQuota(0, MAX_CHANNEL_ATTACHMENT_BYTES - 1), false);
    assert.strictEqual(wouldExceedAttachmentQuota(100, MAX_CHANNEL_ATTACHMENT_BYTES - 101), false);
  });
  test('exactly at the ceiling → false', () => {
    assert.strictEqual(wouldExceedAttachmentQuota(0, MAX_CHANNEL_ATTACHMENT_BYTES), false);
    assert.strictEqual(wouldExceedAttachmentQuota(250 * 1024 * 1024, 250 * 1024 * 1024), false);
    assert.strictEqual(wouldExceedAttachmentQuota(MAX_CHANNEL_ATTACHMENT_BYTES, 0), false);
  });
  test('over the ceiling → true', () => {
    assert.strictEqual(wouldExceedAttachmentQuota(0, MAX_CHANNEL_ATTACHMENT_BYTES + 1), true);
    assert.strictEqual(wouldExceedAttachmentQuota(MAX_CHANNEL_ATTACHMENT_BYTES, 1), true);
  });
  test('zero + zero → false', () => {
    assert.strictEqual(wouldExceedAttachmentQuota(0, 0), false);
  });
});

describe('pinnedMessages', () => {
  test('pinned only, newest first', () => {
    const msgs: TeamMessage[] = [
      { id: 'm-1', userId: 'u', username: 'a', text: 'a', createdAt: '1' },
      { id: 'm-2', userId: 'u', username: 'a', text: 'b', createdAt: '2', pinned: true },
      { id: 'm-3', userId: 'u', username: 'a', text: 'c', createdAt: '3', pinned: true },
    ];
    assert.deepStrictEqual(pinnedMessages(msgs).map((m) => m.id), ['m-3', 'm-2']);
  });
});

describe('channel id discipline', () => {
  test('safe charset enforced for ids', () => {
    assert.ok(isChannelId('project:my-slug'));
    assert.ok(isChannelId('dm:user-1:user-2'));
    assert.ok(isChannelId('ch-abc123'));
    assert.ok(!isChannelId('../etc'));
    assert.ok(!isChannelId('a b'));
    assert.ok(!isChannelId('x'.repeat(90)));
  });
  // L3: the safe charset would otherwise accept '.' / '..' as full ids —
  // both regex-pass and rejected today so a future path-join can never
  // accidentally walk a parent with an id alone.
  test('L3: dot-only ids rejected (passes regex, blocked explicitly)', () => {
    assert.ok(CHANNEL_ID_RE.test('.'));
    assert.ok(CHANNEL_ID_RE.test('..'));
    assert.strictEqual(isChannelId('.'), false);
    assert.strictEqual(isChannelId('..'), false);
    assert.strictEqual(isChannelId('.'), false);
    assert.strictEqual(isChannelId(undefined), false);
  });
  test('message id format', () => {
    assert.ok(isMessageId('m-abc123'));
    assert.ok(!isMessageId('abc'));
    assert.ok(!isMessageId('m-'));
  });
  test('deterministic + collision-free id builders', () => {
    assert.strictEqual(buildProjectChannelId('foo'), 'project:foo');
    assert.strictEqual(buildDirectChannelId('user-b', 'user-a'), 'dm:user-a:user-b');
    assert.notStrictEqual(buildProjectChannelId('x').startsWith('ch-'), true);
  });
});

describe('channelSortKey + channelLabel', () => {
  const users = (id: string) => (id === 'u-1' ? 'Alice' : 'Bob');
  test('sort key uses lastMessageAt fallback createdAt', () => {
    const ch: TeamChannel = {
      id: 'project:x', kind: 'project', members: [], createdAt: '2026-01-01T00:00:00Z', lastMessageAt: '2026-02-01T00:00:00Z',
    };
    const ch2: TeamChannel = { id: 'project:y', kind: 'project', members: [], createdAt: '2026-03-01T00:00:00Z' };
    assert.ok(channelSortKey(ch) > channelSortKey(ch2) === false);
  });
  test('direct label resolves the other participant', () => {
    const ch: TeamChannel = {
      id: 'dm:u-1:u-2', kind: 'direct',
      members: [{ userId: 'u-1', role: 'editor' }, { userId: 'u-2', role: 'viewer' }],
      createdAt: 't',
    };
    assert.strictEqual(channelLabel(ch, 'u-1', users), 'Bob');
    assert.strictEqual(channelLabel(ch, 'u-2', users), 'Alice');
  });
  test('project label uses slug, manual uses name', () => {
    const p: TeamChannel = { id: 'project:x', kind: 'project', projectSlug: 'web', members: [], createdAt: 't' };
    const m: TeamChannel = { id: 'ch-1', kind: 'channel', name: 'Design', members: [], createdAt: 't' };
    assert.strictEqual(channelLabel(p, 'u-1', users), '#web');
    assert.strictEqual(channelLabel(m, 'u-1', users), 'Design');
  });
});

describe('sanitizeCanSend', () => {
  test('accepts the two valid modes as-is', () => {
    assert.strictEqual(sanitizeCanSend('everyone'), 'everyone');
    assert.strictEqual(sanitizeCanSend('admins'), 'admins');
  });
  test('rejects junk / absent / non-string values', () => {
    assert.strictEqual(sanitizeCanSend(null), null);
    assert.strictEqual(sanitizeCanSend(undefined), null);
    assert.strictEqual(sanitizeCanSend(42), null);
    assert.strictEqual(sanitizeCanSend(''), null);
    assert.strictEqual(sanitizeCanSend('all'), null);
    assert.strictEqual(sanitizeCanSend('EVERYONE'), null);
    assert.strictEqual(sanitizeCanSend({}), null);
  });
});

describe('isChannelAdmin', () => {
  const channel = {
    createdBy: 'u-owner',
    members: [
      { userId: 'u-admin', role: 'admin' },
      { userId: 'u-editor', role: 'editor' },
      { userId: 'u-viewer', role: 'viewer' },
    ],
  };
  test('creator → true', () => {
    assert.strictEqual(isChannelAdmin(channel, 'u-owner'), true);
  });
  test('explicit admin member → true', () => {
    assert.strictEqual(isChannelAdmin(channel, 'u-admin'), true);
  });
  test('editor member → false', () => {
    assert.strictEqual(isChannelAdmin(channel, 'u-editor'), false);
  });
  test('viewer member → false', () => {
    assert.strictEqual(isChannelAdmin(channel, 'u-viewer'), false);
  });
  test('non-member → false', () => {
    assert.strictEqual(isChannelAdmin(channel, 'u-stranger'), false);
  });
  test('missing createdBy → a listed admin member still passes', () => {
    assert.strictEqual(isChannelAdmin({ members: [{ userId: 'x', role: 'admin' }] }, 'x'), true);
  });
  test('empty/absent members + no createdBy → false', () => {
    assert.strictEqual(isChannelAdmin({}, 'u-owner'), false);
    assert.strictEqual(isChannelAdmin({ members: [] }, 'u-owner'), false);
  });
  // G1: the reviewer-specified fixture — an explicit admin member who is NOT
  // the channel creator must still be an admin (createdBy alone decides
  // nothing for a third user).
  test('G1: explicit admin member on a channel created by someone else → true', () => {
    assert.strictEqual(isChannelAdmin({ members: [{ userId: 'u1', role: 'admin' }], createdBy: 'u2' }, 'u1'), true);
  });
  test('G1: an editor member on the same shape → false', () => {
    assert.strictEqual(isChannelAdmin({ members: [{ userId: 'u1', role: 'editor' }], createdBy: 'u2' }, 'u1'), false);
  });
  test('G1: creator without any membership row → true (createdBy is the admin authority)', () => {
    assert.strictEqual(isChannelAdmin({ members: [], createdBy: 'u0' }, 'u0'), true);
    assert.strictEqual(isChannelAdmin({ createdBy: 'u0' }, 'u0'), true);
  });
  // NOTE: the G1 "system admin" bullet (role 'admin' bypasses the admins-lock
  // without creation/membership) lives in canSendInChannel (chat-team-access),
  // which imports middleware/auth — NOT import-free, so it cannot load under
  // node --test here. It is covered in the real-API suite (G1 test in
  // chat-team-api.test.ts + maySend assertions in CS1/CS3/CS5/CS6v).
});