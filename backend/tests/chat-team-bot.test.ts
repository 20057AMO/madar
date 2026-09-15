/**
 * chat-team-bot.test.ts
 * Offline ORCHESTRATOR tests — drives the import-free state machine
 * (chat-team-bot-core.ts maybeInvokeBot) with a fully fake BotRuntime.
 * No server, no Docker, no LLM — only injectable seams, so every behavior is
 * asserted deterministically with awaited invocations.
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
 *  - typing starts once and always stops again,
 *  - timeout → exactly ONE message (never two: the old fire-and-forget notice
 *    AND a follow-up are collapsed into a single post-decision),
 *  - partial ≥40 chars on mid-stream failure is published with a stop marker,
 *  - stream returns null → 'empty_reply' notice,
 *  - global cap 3 concurrent across channels,
 *  - a runtime that silently drops persists (the adapter's deleted-channel
 *    guard) never breaks the orchestrator — exactly one attempt, locks and
 *    typing released,
 *  - buildSystemPrompt throw → 'unavailable' notice (never silent),
 *  - per-user generation budget (5 per 60s window) blocks excess attempts,
 *  - BOT_USER_ID / BOT_USERNAME match between chat-team-core and
 *    chat-team-bot-core (prevents ring-guard drift).
 *
 * Adapter-level behaviors (the real store, real provider store, real ws) are
 * intentionally NOT importable here — src/ compiles with extensionless
 * imports that `node --test` cannot resolve, so this file stays strictly on
 * the import-free cores. Those behaviors live in chat-team-bot-e2e.test.ts
 * against the running container.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { mock } from 'node:test';
import {
  BOT_USER_ID,
  BOT_USERNAME,
  maybeInvokeBot,
  createInvocationState,
  buildBotNotice,
  sanitizeBotReply,
  BOT_TIMEOUT_MS,
  BOT_MIN_PARTIAL_CHARS,
  BOT_USER_BUDGET_MAX,
  BOT_USER_BUDGET_WINDOW_MS,
} from '../src/services/chat-team-bot-core.ts';
import {
  BOT_USER_ID as _CORE_BOT_USER_ID,
  BOT_USERNAME as _CORE_BOT_USERNAME,
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

  // ── (أ) timeout + abort → exactly ONE message (no duplicate) ──────────
  test('timeout + abort → exactly ONE message, never two', async () => {
    try {
      mock.timers.enable({ apis: ['setTimeout'] });
      let abortCalled = false;
      let calls = 0;
      const { runtime, persisted } = fakeRuntime({
        stream: async (_ctx, _sys, onDelta, control) => {
          calls += 1;
          onDelta('A'.repeat(BOT_MIN_PARTIAL_CHARS + 5));
          control.abort = () => { abortCalled = true; };
          // Like the real engines: poll whether the orchestrator cancelled us
          // (the timer only marks + aborts; it must never post itself).
          while (!control.cancelled) {
            await new Promise((r) => setTimeout(r, 1000));
          }
          throw new Error('AbortError');
        },
      });
      const state = createInvocationState();
      const channel = { ...CHANNEL, id: 'ch-timeout' };

      const done = maybeInvokeBot(runtime, channel.id, mention('@madar hang forever'), channel, state);
      for (let i = 0; i < 10; i++) await Promise.resolve(); // let the invocation reach the stream
      assert.strictEqual(calls, 1, 'the generation started');
      assert.strictEqual(persisted.length, 0, 'nothing posted before the timeout');

      // Fire every due timer: the orchestrator's 60s timeout + the poll loop.
      // The poll sees cancelled → rejects like a real engine abort → finishError
      // with timedOut=true → exactly ONE timeout notice (never partial + notice).
      mock.timers.tick(BOT_TIMEOUT_MS + 2000);
      await done;

      assert.ok(abortCalled, 'timeout invoked abort');
      assert.strictEqual(persisted.length, 1, 'exactly ONE message after a timeout — no duplicate');
      assert.strictEqual(persisted[0].text, buildBotNotice('timeout'), 'the single message is the timeout notice');
      assert.ok(!persisted[0].text.includes('A'.repeat(5)), 'no partial body leaked into the timeout notice');
    } finally {
      mock.timers.reset();
    }
  });

  // ── (ب) partial ≥40 chars on mid-stream failure ──────────────────────
  test('mid-stream failure with ≥40-char partial → published with stop marker', async () => {
    const partialText = 'x'.repeat(BOT_MIN_PARTIAL_CHARS + 10);
    let calls = 0;
    const { runtime, persisted } = fakeRuntime({
      stream: async (_ctx, _sys, onDelta) => {
        calls += 1;
        onDelta(partialText);
        throw new Error('stream died');
      },
    });
    const state = createInvocationState();
    const channel = { ...CHANNEL, id: 'ch-partial' };

    await maybeInvokeBot(runtime, channel.id, mention('@madar tell me a story'), channel, state);
    assert.strictEqual(calls, 1);
    assert.strictEqual(persisted.length, 1);
    const out = persisted[0];
    assert.ok(out.text.includes(partialText), 'published partial text is present');
    assert.ok(out.text.endsWith('― generation stopped'), 'stop marker appended');
    assert.strictEqual(out.reply, true, 'partial salvage is stamped as a reply');
  });

  // ── (ج) stream returns null (empty reply) → empty_reply notice ───────
  test('stream returns null (empty reply) → empty_reply notice posted', async () => {
    const { runtime, persisted } = fakeRuntime({
      stream: async () => null,
    });
    const state = createInvocationState();
    const channel = { ...CHANNEL, id: 'ch-empty' };

    await maybeInvokeBot(runtime, channel.id, mention('@madar say nothing'), channel, state);
    assert.strictEqual(persisted.length, 1);
    assert.strictEqual(persisted[0].text, buildBotNotice('empty_reply'));
    assert.strictEqual(persisted[0].reply, false, 'empty_reply is a notice');
  });

  // ── (د) global cap 3 concurrent across channels ──────────────────────
  test('global cap of 3 concurrent generations — fourth mention rejected', async () => {
    let calls = 0;
    const gates: (() => void)[] = [];
    const { runtime, persisted } = fakeRuntime({
      stream: async () => {
        calls += 1;
        await new Promise<void>((r) => { gates.push(r); });
        return { full: 'done' };
      },
    });
    const state = createInvocationState();

    // Fire 3 hung generations across different channels, different users.
    for (let i = 0; i < 3; i++) {
      const cid = `ch-cap-${i}`;
      const uid = `user-cap-${i}`;
      const m = formatMessage(`m-cap-${i}`, uid, `alice${i}`, {
        text: `@madar channel ${i}`,
        mentions: ['madar'],
      });
      void maybeInvokeBot(runtime, cid, m, { ...CHANNEL, id: cid }, state);
      await new Promise((r) => setTimeout(r, 5)); // let the lock settle.
    }

    assert.strictEqual(calls, 3, 'three generations are active');
    assert.strictEqual(state.active, 3, 'active counter reflects 3');
    assert.strictEqual(persisted.length, 0, 'nothing persisted yet');

    // Fourth mention on a brand-new channel, different user — blocked by the
    // global cap alone (per-user budget is not the gate here).
    const fourthM = formatMessage('m-cap-4', 'user-cap-fourth', 'alice4', {
      text: '@madar fourth channel',
      mentions: ['madar'],
    });
    await maybeInvokeBot(runtime, 'ch-cap-3', fourthM, { ...CHANNEL, id: 'ch-cap-3' }, state);
    assert.strictEqual(calls, 3, 'fourth generation never started — global cap holds');

    // Release all hung streams.
    for (const g of gates) g();
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(persisted.length, 3, 'all three replies persisted');
    assert.strictEqual(state.active, 0, 'active counter back to 0');
  });

  // ── (هـ) a persist that silently drops — the adapter's deleted-channel
  //         guard re-checks getChannel before writing and skips → the
  //         orchestrator must settle cleanly and never corrupt state ─────
  test('a silently-dropped persist (channel deleted mid-generation) settles cleanly', async () => {
    let persistCalls = 0;
    const { runtime, persisted, typing } = fakeRuntime({
      // Mirrors chat-team-bot.ts persistAndBroadcast: getChannel returns null
      // (channel deleted while the generation hung) → the write is skipped.
      persistAndBroadcast: async () => {
        persistCalls += 1;
        // Channel gone — nothing to write (the base fake pushes to `persisted`;
        // this override intentionally skips it, proving nothing reaches the store).
      },
      stream: async (_ctx, _sys, onDelta) => {
        onDelta?.('full reply that must never be saved');
        return { full: 'full reply that must never be saved' };
      },
    });
    const state = createInvocationState();
    const channel = { ...CHANNEL, id: 'ch-deleted' };

    await maybeInvokeBot(runtime, channel.id, mention('@madar delete mid-flight'), channel, state);

    assert.strictEqual(persistCalls, 1, 'persist was attempted exactly once (the guard decides)');
    assert.strictEqual(persisted.length, 0, 'NOTHING reached the store — the deleted channel is never resurrected');
    assert.strictEqual(typing.length, 2, 'typing toggled on then off');
    assert.strictEqual(typing[typing.length - 1].on, false, 'typing stopped after the dropped persist');
    assert.ok(!state.channelLocks.has(channel.id), 'channel lock released');
    assert.strictEqual(state.active, 0, 'active counter back to 0');
    // NB lastReplyAt IS stamped: the orchestrator is write-agnostic — the
    // getChannel guard lives in the runtime, not the state machine.
  });

  // ── (و) buildSystemPrompt throw (pre-stream) → unavailable notice ────
  test('throw from buildSystemPrompt (pre-stream) → unavailable notice, never silent', async () => {
    let calls = 0;
    const { runtime, persisted } = fakeRuntime({
      buildSystemPrompt: async () => {
        throw new Error('deformed provider config');
      },
      stream: async () => {
        calls += 1;
        return { full: 'should never be reached' };
      },
    });
    const state = createInvocationState();
    const channel = { ...CHANNEL, id: 'ch-syserr' };

    await maybeInvokeBot(runtime, channel.id, mention('@madar throw please'), channel, state);
    assert.strictEqual(calls, 0, 'the stream is never reached when the prompt build fails');
    assert.strictEqual(persisted.length, 1, 'exactly one notice, never silence');
    assert.strictEqual(persisted[0].text, buildBotNotice('unavailable'));
  });

  // ── (5) per-user generation budget (5 attempts per 60s) ─────────────
  test('per-user budget (5/60s) blocks the 6th attempt; other users unaffected', async () => {
    let calls = 0;
    const { runtime, persisted } = fakeRuntime({
      stream: async () => {
        calls += 1;
        return { full: 'budget reply' };
      },
    });
    const state = createInvocationState();

    // 5 attempts from the same user, each on a fresh channel (the 10s reply
    // cooldown is per-channel, so the budget is what we isolate here).
    for (let i = 0; i < BOT_USER_BUDGET_MAX; i++) {
      const cid = `ch-budget-${i}`;
      const m = formatMessage(`m-budget-${i}`, 'user-budget', 'budget-user', {
        text: `@madar attempt ${i}`,
        mentions: ['madar'],
      });
      await maybeInvokeBot(runtime, cid, m, { ...CHANNEL, id: cid }, state);
    }
    assert.strictEqual(calls, BOT_USER_BUDGET_MAX, 'all 5 budget slots consumed');
    assert.strictEqual(persisted.length, BOT_USER_BUDGET_MAX, 'five replies landed');

    // 6th attempt from the same user (fresh channel) → rejected by the budget.
    const m6 = formatMessage('m-budget-5', 'user-budget', 'budget-user', {
      text: '@madar attempt 6',
      mentions: ['madar'],
    });
    await maybeInvokeBot(runtime, 'ch-budget-99', m6, { ...CHANNEL, id: 'ch-budget-99' }, state);
    assert.strictEqual(calls, BOT_USER_BUDGET_MAX, '6th attempt blocked — budget exhausted');
    assert.strictEqual(persisted.length, BOT_USER_BUDGET_MAX, 'nothing extra persisted');

    // A DIFFERENT user is unaffected by user-budget's exhaustion.
    const mOther = formatMessage('m-budget-other', 'user-other', 'other', {
      text: '@madar different user',
      mentions: ['madar'],
    });
    await maybeInvokeBot(runtime, 'ch-budget-98', mOther, { ...CHANNEL, id: 'ch-budget-98' }, state);
    assert.strictEqual(calls, BOT_USER_BUDGET_MAX + 1, 'different user allowed through');
  });

  // ── (ز) BOT_USER_ID / BOT_USERNAME parity ───────────────────────────
  test('BOT_USER_ID / BOT_USERNAME are identical between chat-team-core and chat-team-bot-core', () => {
    assert.strictEqual(BOT_USER_ID, _CORE_BOT_USER_ID,
      'BOT_USER_ID mismatch — loop guard in core vs adapter would break');
    assert.strictEqual(BOT_USERNAME, _CORE_BOT_USERNAME,
      'BOT_USERNAME mismatch — @madar detection in core vs adapter would break');
    assert.strictEqual(BOT_USER_ID, 'bot-madar');
    assert.strictEqual(BOT_USERNAME, 'madar');
  });
});