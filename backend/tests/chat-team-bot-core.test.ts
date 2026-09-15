/**
 * chat-team-bot-core.test.ts
 * Offline unit coverage for the import-free @madar bot rules
 * (chat-team-bot-core.ts + the bot bits of chat-team-core). No server, no
 * Docker, no LLM — pure decisions only.
 *
 * Contract:
 *  - the 'madar' username is reserved (case/padding-insensitive);
 *  - shouldInvokeBot fires only on a real @madar mention in channel/project
 *    rooms — never on bot messages, never in DMs;
 *  - buildBotContext maps stored rows to user/assistant lines with [📎 name]
 *    attachment tags, honors the window, trims from the OLDEST side, and keeps
 *    the mention-bearing head of an oversized newest message;
 *  - sanitizeBotReply strips control chars, trims, and truncates with a '…'
 *    marker; empty/junk input → null;
 *  - shouldSendNotice is a pure injected-clock cooldown gate;
 *  - canDeleteMessage opens write-level deletion for BOT messages only.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  BOT_USER_ID,
  BOT_USERNAME,
  RESERVED_USERNAMES,
  isReservedUsername,
  isBotMessage,
  canDeleteMessage,
  formatMessage,
  type TeamMessage,
} from '../src/services/chat-team-core.ts';
import {
  shouldInvokeBot,
  buildBotContext,
  sanitizeBotReply,
  buildBotNotice,
  shouldSendNotice,
  type BotNoticeCause,
} from '../src/services/chat-team-bot-core.ts';

function msg(over: Partial<TeamMessage> & { text: string }): TeamMessage {
  return formatMessage(
    `m-${over.text.length}-${Math.random().toString(36).slice(2, 6)}`,
    over.userId ?? 'u-user',
    over.username ?? 'user',
    { text: over.text, ...(over.mentions ? { mentions: over.mentions } : { mentions: [] }) },
    over.attachments ? { attachments: over.attachments } : undefined
  ) as TeamMessage;
}

describe('isReservedUsername', () => {
  test('exact reserved name → true', () => {
    for (const name of RESERVED_USERNAMES) {
      assert.strictEqual(isReservedUsername(name), true);
    }
    assert.strictEqual(isReservedUsername(BOT_USERNAME), true);
  });
  test('case-insensitive', () => {
    assert.strictEqual(isReservedUsername('Madar'), true);
    assert.strictEqual(isReservedUsername('MADAR'), true);
    assert.strictEqual(isReservedUsername('mAdAr'), true);
  });
  test('whitespace padding is ignored', () => {
    assert.strictEqual(isReservedUsername('  madar '), true);
    assert.strictEqual(isReservedUsername('madar\n'), true);
  });
  test('near-misses and junk are NOT reserved', () => {
    assert.strictEqual(isReservedUsername('madar2'), false);
    assert.strictEqual(isReservedUsername('madaro'), false);
    assert.strictEqual(isReservedUsername(''), false);
    assert.strictEqual(isReservedUsername('alice'), false);
  });
});

describe('isBotMessage', () => {
  test('bot-written messages are identified (loop guard)', () => {
    assert.strictEqual(isBotMessage({ userId: BOT_USER_ID }), true);
    assert.strictEqual(isBotMessage({ userId: 'user-1' }), false);
    assert.strictEqual(isBotMessage({}), false);
  });
});

describe('shouldInvokeBot', () => {
  test('@madar mention in a channel room → invoke', () => {
    assert.strictEqual(shouldInvokeBot({ userId: 'u-1', mentions: ['madar'] }, 'channel'), true);
  });
  test('@madar mention in a project room → invoke', () => {
    assert.strictEqual(shouldInvokeBot({ userId: 'u-1', mentions: ['madar'] }, 'project'), true);
  });
  test('no mention → never invokes (plain chat is context, not a command)', () => {
    assert.strictEqual(shouldInvokeBot({ userId: 'u-1', mentions: [] }, 'channel'), false);
    assert.strictEqual(shouldInvokeBot({ userId: 'u-1', mentions: ['alice'] }, 'channel'), false);
    assert.strictEqual(shouldInvokeBot({ userId: 'u-1' }, 'channel'), false);
  });
  test('a BOT message containing @madar → never invokes (loop guard first)', () => {
    assert.strictEqual(shouldInvokeBot({ userId: BOT_USER_ID, mentions: ['madar'] }, 'channel'), false);
  });
  test('direct chats → never invokes', () => {
    assert.strictEqual(shouldInvokeBot({ userId: 'u-1', mentions: ['madar'] }, 'direct'), false);
  });
  test('junk channel kinds → never invokes', () => {
    assert.strictEqual(shouldInvokeBot({ userId: 'u-1', mentions: ['madar'] }, ''),
      false);
    assert.strictEqual(shouldInvokeBot({ userId: 'u-1', mentions: ['madar'] }, 'dm:u-1:u-2'), false);
  });
});

describe('buildBotContext', () => {
  const base: TeamMessage[] = [
    msg({ text: 'hello', userId: 'u-1', username: 'alice' }),
    msg({ text: 'hi @madar', userId: 'u-2', username: 'bob', mentions: ['madar'] }),
  ];

  test('maps users → user, bot replies → assistant, newest last', () => {
    const botReply = formatMessage('m-bot', BOT_USER_ID, BOT_USERNAME, { text: 'hey bob', mentions: [] });
    const ctx = buildBotContext([...base, botReply as TeamMessage]);
    assert.deepStrictEqual(
      ctx.map((m) => m.role),
      ['user', 'user', 'assistant']
    );
    assert.strictEqual(ctx[ctx.length - 1].content, 'hey bob');
  });

  test('attachments render as [📎 name] tags', () => {
    const withAtt = msg({
      text: 'see this @madar',
      userId: 'u-1',
      username: 'alice',
      mentions: ['madar'],
      attachments: [{ id: 'att-1', name: 'spec.pdf', kind: 'file', size: 10 }],
    });
    const ctx = buildBotContext([withAtt]);
    assert.strictEqual(ctx[0].content, 'see this @madar [📎 spec.pdf]');
  });

  test('window keeps only the newest N', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      msg({ text: `m${i}`, userId: 'u-1', username: 'alice' })
    );
    const ctx = buildBotContext(many, { window: 5 });
    assert.strictEqual(ctx.length, 5);
    assert.strictEqual(ctx[0].content, 'm15');
    assert.strictEqual(ctx[4].content, 'm19');
  });

  test('char cap trims from the OLDEST side while more than one remains', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      msg({ text: `msg-${i}-${'x'.repeat(100)}`, userId: 'u-1', username: 'alice' })
    );
    const ctx = buildBotContext(many, { window: 10, maxChars: 300 });
    const total = ctx.reduce((s, m) => s + m.content.length, 0);
    assert.ok(total <= 300, `total ${total} exceeded cap`);
    // The newest message survives (mention-bearing head preserved).
    assert.strictEqual(ctx[ctx.length - 1].content, many[9].text);
  });

  test('a single oversized newest message keeps its HEAD (the mention area)', () => {
    const huge = msg({ text: '@madar ' + 'x'.repeat(500), userId: 'u-1', mentions: ['madar'] });
    const ctx = buildBotContext([huge], { window: 12, maxChars: 100 });
    assert.strictEqual(ctx.length, 1);
    assert.strictEqual(ctx[0].content.length, 100);
    assert.ok(ctx[0].content.startsWith('@madar '), 'mention head must survive');
  });
});

describe('sanitizeBotReply', () => {
  test('strips control chars + trims', () => {
    assert.strictEqual(sanitizeBotReply('  hi\u0000\u0007there  '), 'hithere');
    assert.strictEqual(sanitizeBotReply('line1\r\nline2\rline3'), 'line1\nline2\nline3');
  });
  test('null for non-string / empty / whitespace-only', () => {
    assert.strictEqual(sanitizeBotReply(42), null);
    assert.strictEqual(sanitizeBotReply(''), null);
    assert.strictEqual(sanitizeBotReply('   \n  '), null);
    assert.strictEqual(sanitizeBotReply(null), null);
  });
  test('long replies are truncated with a … marker at the exact cap', () => {
    const long = 'y'.repeat(5000);
    const out = sanitizeBotReply(long, 4000);
    assert.strictEqual(out?.length, 4000);
    assert.ok(out!.endsWith('…'));
  });
  test('under-cap replies pass through untouched', () => {
    assert.strictEqual(sanitizeBotReply('short reply', 4000), 'short reply');
  });
});

describe('buildBotNotice', () => {
  test('every cause has a short English message', () => {
    for (const cause of ['unavailable', 'timeout', 'generation_error', 'empty_reply'] as BotNoticeCause[]) {
      const text = buildBotNotice(cause);
      assert.strictEqual(typeof text, 'string');
      assert.ok(text.length > 0 && text.length < 200, `${cause} notice too long`);
    }
  });
});

describe('shouldSendNotice', () => {
  const now = 1_000_000;
  test('no previous notice → always send', () => {
    assert.strictEqual(shouldSendNotice(null, now, 1000), true);
    assert.strictEqual(shouldSendNotice(undefined, now, 1000), true);
    assert.strictEqual(shouldSendNotice(0, now, 1000), true);
  });
  test('older than the cooldown → send again', () => {
    assert.strictEqual(shouldSendNotice(now - 5000, now, 1000), true);
    assert.strictEqual(shouldSendNotice(now - 1000, now, 1000), true);
  });
  test('inside the cooldown window → hold', () => {
    assert.strictEqual(shouldSendNotice(now - 999, now, 1000), false);
    assert.strictEqual(shouldSendNotice(now, now, 1000), false);
    assert.strictEqual(shouldSendNotice(now + 500, now, 1000), false);
  });
});

describe('canDeleteMessage (bot write-level extension)', () => {
  const botMsg = { userId: BOT_USER_ID };
  test('a write-level user may delete a BOT message', () => {
    assert.strictEqual(
      canDeleteMessage(botMsg, 'u-editor', { isChannelAdmin: false, isSystemAdmin: false, writeLevel: true }),
      true
    );
  });
  test('a viewer (no write level) may NOT delete a bot message', () => {
    assert.strictEqual(
      canDeleteMessage(botMsg, 'u-viewer', { isChannelAdmin: false, isSystemAdmin: false, writeLevel: false }),
      false
    );
  });
  test('writeLevel never widens deletion of HUMAN messages', () => {
    const human = { userId: 'u-author' };
    assert.strictEqual(
      canDeleteMessage(human, 'u-other', { isChannelAdmin: false, isSystemAdmin: false, writeLevel: true }),
      false
    );
  });
  test('bot messages stay deletable by the legacy paths (author/admin/system)', () => {
    assert.strictEqual(
      canDeleteMessage(botMsg, BOT_USER_ID, { isChannelAdmin: false, isSystemAdmin: false }),
      true // the "author" is the bot — its own identity passes the author check
    );
    assert.strictEqual(
      canDeleteMessage(botMsg, 'u-admin', { isChannelAdmin: true, isSystemAdmin: false }),
      true
    );
    assert.strictEqual(
      canDeleteMessage(botMsg, 'u-sys', { isChannelAdmin: false, isSystemAdmin: true }),
      true
    );
  });
});