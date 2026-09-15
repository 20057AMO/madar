/**
 * chat-team-bot.test.ts
 * Offline ORCHESTRATOR integration — drives the import-free state machine
 * (chat-team-bot-core.ts maybeInvokeBot) with a fully fake BotRuntime, the
 * exact shape the adapter (chat-team-bot.ts) supplies in production. No server,
 * no Docker, no store — only injectable seams, so every behavior is asserted
 * deterministically with awaited invocations.
 *
 * Contract under test:
 *  - delta+done → exactly one persisted reply (correct text, reply stamped),
 *  - an immediate stream failure posts ONE 'unavailable' notice; a re-mention
 *    inside the notice window re-runs the generation but adds NOTHING visible,
 *  - no usable provider → 'unavailable' notice withOUT touching the stream,
 *  - a hung generation holds the channel lock (second mention never reaches
 *    the stream — callCount stays 1),
 *  - replies longer than 4000 chars are truncated with a '…' marker,
 *  - a bot-authored message containing '@madar' never re-invokes (loop guard),
 *  - the 10s reply cooldown silently rejects an immediate re-mention,
 *  - typing starts once and always stops again.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  BOT_USER_ID,
  maybeInvokeBot,
  createInvocationState,
  buildBotNotice,
  sanitizeBotReply,
} from '../src/services/chat-team-bot-core.ts';
import {
  formatMessage,
  parseMentions,
} from '../src/services/chat-team-core.ts';
import type { BotRuntime, MessageLike, ChannelLike } from '../src/services/chat-team-bot-core.ts';

/** Fully fake runtime. Every field is overridable per test. */
function fakeRuntime(overrides: Partial<BotRuntime> = {}): {
  runtime: BotRuntime;
  persisted: { text: string; reply: boolean }[];
  streamCalls: number;
  seenContexts: any[][];
  typing: { on: boolean }[];
  store: Map<string, MessageLike[]>;
} {
  const persisted: { text: string; reply: boolean }[] = [];
  const streamCalls = 0;
  const seenContexts: any[][] = [];
  const typing: { on: boolean }[] = [];
  const store = new Map<string, MessageLike[]>();

  const base: BotRuntime = {
    hasUsableProvider: () => true,
    userOwnsBotName: () => false,
    getMessages: (channelId) => store.get(channelId) ?? [],
    buildSystemPrompt: async () => 'test system',
    typing: (channelId, on) => {
      void channelId;
      typing.push({ on });
    },
    persistAndBroadcast: async (channelId, text, opts) => {
      void channelId;
      persisted.push({ text, reply: !!opts?.reply });
    },
    stream: async (context, system, onDelta) => {
      void system;
      seenContexts.push(context);
      onDelta?.('hello ');
      onDelta?.('madar');
      return { full: 'hello madar' };
    },
  };

  return {
    runtime: { ...base, ...overrides },
    persisted,
    streamCalls,
    seenContexts,
    typing,
    store,
  };
}

/** A human message that really mentions @madar (extracted by parseMentions). */
function mention(text: string): MessageLike {
  return formatMessage('m-u-1', 'user-test', 'alice', {
    text,
    mentions: parseMentions(text),
  });
}

const CHANNEL: ChannelLike = { id: 'ch-bot-1', kind: 'channel' };

describe('@madar orchestrator (offline, injected runtime)', () => {
  test('delta + done → exactly one persisted reply, reply cooldown stamped, typing stops', async () => {
    const { runtime, persisted, typing } = fakeRuntime();
    const state = createInvocationState();
    const channel = { ...CHANNEL, id: 'ch-a' };

    await maybeInvokeBot(runtime, channel.id, mention('@madar hello'), channel, state);
    await maybeInvokeBot(runtime, channel.id, mention('@madar again'), channel, state);

    assert.strictEqual(persisted.length, 1, 'one reply despite the re-mention');
    assert.strictEqual(persisted[0].text, 'hello madar');
    assert.strictEqual(persisted[0].reply, true, 'successful reply stamps the reply cooldown');
    assert.ok(state.lastReplyAt.has(channel.id), 'lastReplyAt recorded');
    assert.strictEqual(typing.length, 2, 'typing on + off');
    assert.strictEqual(typing[0].on, true);
    assert.strictEqual(typing[1].on, false);
  });

  test('immediate stream failure → one unavailable notice; re-mention inside the notice window adds nothing visible', async () => {
    let calls = 0;
    const { runtime, persisted } = fakeRuntime({
      stream: async (_ctx, _sys, _onDelta) => {
        calls += 1;
        throw new Error('request failed (HTTP 500)');
      },
    });
    const state = createInvocationState();
    const channel = { ...CHANNEL, id: 'ch-b' };

    await maybeInvokeBot(runtime, channel.id, mention('@madar first'), channel, state);
    assert.strictEqual(persisted.length, 1);
    assert.strictEqual(persisted[0].text, buildBotNotice('unavailable'));
    assert.strictEqual(persisted[0].reply, false, 'notices do not stamp the reply cooldown');

    // Second mention inside the 5-min notice window: the generation re-runs
    // (stream attempted again) but the cooldown suppresses a second notice.
    await maybeInvokeBot(runtime, channel.id, mention('@madar again'), channel, state);
    assert.strictEqual(calls, 2, 'the second mention re-attempts the generation');
    assert.strictEqual(persisted.length, 1, 'notice cooldown keeps history at one message');
  });

  test('no usable provider → unavailable notice without ever touching the stream', async () => {
    let calls = 0;
    const { runtime, persisted } = fakeRuntime({
      hasUsableProvider: () => false,
      stream: async () => {
        calls += 1;
        return { full: 'never' };
      },
    });
    const state = createInvocationState();
    const channel = { ...CHANNEL, id: 'ch-c' };

    await maybeInvokeBot(runtime, channel.id, mention('@madar hi'), channel, state);
    assert.strictEqual(calls, 0, 'no stream call without a usable provider');
    assert.strictEqual(persisted.length, 1);
    assert.strictEqual(persisted[0].text, buildBotNotice('unavailable'));
  });

  test('a hung generation holds the channel lock (second mention → no second stream call)', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    let onDeltaRef!: (t: string) => void;
    const { runtime, persisted } = fakeRuntime({
      stream: async (_ctx, _sys, onDelta) => {
        calls += 1;
        onDeltaRef = onDelta;
        await gate;
        onDeltaRef('finally ');
        return { full: 'finally done' };
      },
    });
    const state = createInvocationState();
    const channel = { ...CHANNEL, id: 'ch-d' };

    const first = maybeInvokeBot(runtime, channel.id, mention('@madar go'), channel, state);
    // Let the lock settle.
    await new Promise((r) => setTimeout(r, 20));
    await maybeInvokeBot(runtime, channel.id, mention('@madar again?'), channel, state);
    assert.strictEqual(calls, 1, 'channel lock rejects the second invocation');
    assert.strictEqual(persisted.length, 0, 'nothing persisted while hung');

    release();
    await first;
    assert.strictEqual(persisted.length, 1);
    assert.strictEqual(persisted[0].text, 'finally done');
  });

  test('a reply longer than 4000 chars is truncated with the … marker', async () => {
    const long = 'y'.repeat(5000);
    const { runtime, persisted } = fakeRuntime({
      stream: async () => ({ full: long }),
    });
    const state = createInvocationState();
    const channel = { ...CHANNEL, id: 'ch-e' };

    await maybeInvokeBot(runtime, channel.id, mention('@madar write a novel'), channel, state);
    const text = persisted[0].text;
    assert.strictEqual(text.length, 4000);
    assert.ok(text.endsWith('…'));
    assert.strictEqual(text, sanitizeBotReply(long, 4000));
  });

  test('a bot-authored message containing "@madar" never re-invokes (loop guard)', async () => {
    let calls = 0;
    const { runtime, persisted, store } = fakeRuntime({
      stream: async () => {
        calls += 1;
        return { full: 'x' };
      },
    });
    const state = createInvocationState();
    const channel = { ...CHANNEL, id: 'ch-f' };

    const botMsg = formatMessage('m-bot-1', BOT_USER_ID, 'madar', {
      text: '@madar ignore this echo',
      mentions: ['madar'],
    });
    store.set(channel.id, [botMsg]);

    await maybeInvokeBot(runtime, channel.id, botMsg, channel, state);
    assert.strictEqual(calls, 0, 'bot messages never trigger another generation');
    assert.strictEqual(persisted.length, 0);
  });

  test('reply cooldown (10s) silently rejects an immediate second mention', async () => {
    let calls = 0;
    let onDeltaRef!: (t: string) => void;
    const { runtime, persisted } = fakeRuntime({
      stream: async (_ctx, _sys, onDelta) => {
        calls += 1;
        onDeltaRef = onDelta;
        onDeltaRef('cooldown ');
        return { full: 'cooldown reply' };
      },
    });
    const state = createInvocationState();
    const channel = { ...CHANNEL, id: 'ch-g' };

    await maybeInvokeBot(runtime, channel.id, mention('@madar first'), channel, state);
    assert.strictEqual(calls, 1);
    assert.strictEqual(persisted.length, 1);

    await maybeInvokeBot(runtime, channel.id, mention('@madar second'), channel, state);
    assert.strictEqual(calls, 1, 'reply cooldown holds the second generation back');
    assert.strictEqual(persisted.length, 1);
  });
});