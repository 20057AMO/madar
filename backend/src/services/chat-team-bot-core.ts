/**
 * chat-team-bot-core.ts
 * Pure rules + the injected-dependency ORCHESTRATOR for the @madar team-chat
 * bot. IMPORT-FREE (janitor-core pattern) so node --test can load it directly;
 * everything that touches fs/network/store/ws is injected through BotRuntime
 * by the adapter (chat-team-bot.ts). The state machine itself — per-channel
 * lock, global cap, reply/notice cooldowns, timeout+abort, partial-reply
 * salvage, degraded notices — lives here and is fully offline-testable.
 */
export type BotNoticeCause = 'unavailable' | 'timeout' | 'generation_error' | 'empty_reply';

/** Bot identity — MUST mirror chat-team-core's canonical BOT_USER_ID /
 *  BOT_USERNAME. Kept local because this module must stay import-free. */
export const BOT_USER_ID = 'bot-madar';
export const BOT_USERNAME = 'madar';

/** True when the message was written by the @madar bot itself (loop guard). */
export function isBotMessage(msg: { userId?: string } | undefined | null): boolean {
  return !!msg && msg.userId === BOT_USER_ID;
}

/** Min gap between two bot REPLIES in the same channel. */
const BOT_REPLY_COOLDOWN_MS = 10_000;
/** Min gap between two bot NOTICES in the same channel. */
const BOT_NOTICE_COOLDOWN_MS = 5 * 60_000;
/** A generation that outlives this is aborted and reported as a timeout. */
const BOT_TIMEOUT_MS = 60_000;
/** Cap an LLM reply. */
const BOT_MAX_REPLY_CHARS = 4000;
/** Partial text this short+ errored is never worth publishing. */
const BOT_MIN_PARTIAL_CHARS = 40;
/** Marker appended when an errored partial reply is published anyway. */
const BOT_STOP_MARKER = '\n\n― generation stopped';
/** Global concurrent generations across ALL channels. */
const BOT_MAX_CONCURRENT = 3;

/** Bot replies only in team rooms — never in direct 1:1 chats. */
const BOT_CHANNEL_KINDS = new Set(['channel', 'project']);

export interface MessageLike {
  id?: string;
  userId?: string;
  username?: string;
  text?: string;
  mentions?: string[];
  attachments?: { name?: string }[];
}

export interface ChannelLike {
  id?: string;
  kind?: string;
  projectSlug?: string;
}

export interface BotContextMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Cancellation/abort handle the streaming engine honours. */
export interface BotControl {
  cancelled: boolean;
  abort: (() => void) | null;
}

/**
 * The runtime an adapter must supply. The orchestrator is fully framework-free;
 * every stateful or I/O action goes through these, so tests can drive the whole
 * state machine without a server.
 */
export interface BotRuntime {
  /** Any enabled provider with a key — or a keyless local ollama — exists. */
  hasUsableProvider(): boolean;
  /** A REAL human account owns the reserved 'madar' username (legacy setups)
   *  → the bot must permanently disable itself instead of impersonating. */
  userOwnsBotName(): boolean;
  /** Fresh channel message history (oldest → newest). */
  getMessages(channelId: string): MessageLike[];
  /** Compose the full system prompt (provider baseline + bot ground rules +
   *  best-effort project context). */
  buildSystemPrompt(channel: ChannelLike): Promise<string>;
  /** Start/stop the bot's typing indicator. */
  typing(channelId: string, on: boolean): void;
  /** Persist + broadcast one bot line. `reply` stamps the reply cooldown. */
  persistAndBroadcast(channelId: string, text: string, opts?: { reply?: boolean }): Promise<void>;
  /**
   * Run the LLM stream. `onDelta` receives partial text. Resolves with
   * `{ full }` when the engine delivered a full reply, or null when the engine
   * returned without completing. Throws on error (the engine reports it via
   * onDelta-ish state in the adapter when available).
   */
  stream(
    context: BotContextMessage[],
    system: string,
    onDelta: (text: string) => void,
    control: BotControl
  ): Promise<{ full: string } | null>;
}

/**
 * Should the bot take over this newly-sent message?
 *  - loop guard first: a bot-written message never re-invokes itself,
 *  - then the actual mention (@madar, lowercased by parseMentions),
 *  - and only in 'channel'/'project' rooms (a user DMing the bot is noise).
 */
export function shouldInvokeBot(
  message: { userId?: string; mentions?: string[] },
  channelKind: string
): boolean {
  if (isBotMessage(message)) return false;
  if (!BOT_CHANNEL_KINDS.has(channelKind)) return false;
  return Array.isArray(message.mentions) && message.mentions.includes(BOT_USERNAME);
}

/** One stored message → the LLM context line (attachments as [📎 name] tags). */
function formatMessageForContext(m: MessageLike): string {
  let content = String(m.text ?? '').trim();
  if (m.attachments?.length) {
    const refs = m.attachments.map((a) => `[📎 ${String(a.name ?? 'file').trim()}]`).join(' ');
    content = content ? `${content} ${refs}` : refs;
  }
  return content;
}

/**
 * Build the LLM context from a channel's recent history.
 *  - the last `window` messages, stored order = oldest first → newest last,
 *  - bot replies become `assistant`, everything else `user`,
 *  - attachments render as `[📎 name]` tags,
 *  - the window is trimmed from the FRONT (oldest) to fit `maxChars`; a single
 *    oversized newest message is truncated at the TAIL so the @mention-bearing
 *    head survives.
 */
export function buildBotContext(
  messages: MessageLike[],
  opts?: { window?: number; maxChars?: number }
): BotContextMessage[] {
  const window = Math.max(1, opts?.window ?? 12);
  const maxChars = Math.max(1, opts?.maxChars ?? 3000);
  const recent = messages.slice(-window);
  const mapped: BotContextMessage[] = recent.map((m) => ({
    role: isBotMessage(m) ? 'assistant' : 'user',
    content: formatMessageForContext(m),
  }));
  let total = mapped.reduce((s, m) => s + m.content.length, 0);
  while (mapped.length > 1 && total > maxChars) {
    const dropped = mapped.shift()!;
    total -= dropped.content.length;
  }
  if (mapped.length === 1 && mapped[0].content.length > maxChars) {
    mapped[0] = { ...mapped[0], content: mapped[0].content.slice(0, maxChars) };
  }
  return mapped;
}

/**
 * Clean + cap an LLM reply before it becomes a chat message.
 * Returns null when nothing usable remains (the caller then sends an
 * `empty_reply` notice). Truncation appends a visible `…` marker.
 */
export function sanitizeBotReply(raw: unknown, max = BOT_MAX_REPLY_CHARS): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!cleaned) return null;
  if (cleaned.length <= max) return cleaned;
  return cleaned.slice(0, max - 1) + '…';
}

/** Short English notice the bot posts when it cannot produce a reply. */
export function buildBotNotice(cause: BotNoticeCause): string {
  switch (cause) {
    case 'unavailable':
      return 'Madar AI is currently unavailable — no LLM provider is reachable. Try again later.';
    case 'timeout':
      return 'Madar AI took too long to respond. Try again.';
    case 'generation_error':
      return 'Madar AI hit an error while generating a reply. Try again.';
    case 'empty_reply':
      return 'Madar AI produced no reply. Try again.';
    default:
      return 'Madar AI could not reply right now. Try again.';
  }
}

/** Pure cooldown decision: true when the last event is old enough (or absent). */
export function shouldSendNotice(lastAt: number | null | undefined, now: number, cooldownMs: number): boolean {
  if (!lastAt) return true;
  return now - lastAt >= Math.max(0, cooldownMs);
}

/** One fire-and-forget invocation lifecycle. NEVER throws into the caller. */
export async function maybeInvokeBot(
  runtime: BotRuntime,
  channelId: string,
  message: MessageLike,
  channel: ChannelLike,
  state: InvocationState
): Promise<void> {
  try {
    if (!shouldInvokeBot(message, channel?.kind ?? '')) return;
    if (state.disabled) return;

    // A legacy human account owns 'madar' → disable permanently, log once.
    if (runtime.userOwnsBotName()) {
      state.disabled = true;
      return;
    }

    // Per-channel lock + global cap + reply cooldown → silent reject.
    if (state.channelLocks.has(channelId) || state.active >= BOT_MAX_CONCURRENT) return;
    const lastReply = state.lastReplyAt.get(channelId) ?? null;
    if (lastReply !== null && Date.now() - lastReply < BOT_REPLY_COOLDOWN_MS) return;

    state.channelLocks.add(channelId);
    state.active += 1;
    try {
      await runGeneration(runtime, channelId, channel, state);
    } finally {
      state.channelLocks.delete(channelId);
      state.active = Math.max(0, state.active - 1);
    }
  } catch {
    // The bot must never throw into the message-send path.
  }
}

/** Per-invoker mutable state (kept out of the function signature noise). */
export interface InvocationState {
  disabled: boolean;
  channelLocks: Set<string>;
  lastReplyAt: Map<string, number>;
  lastNoticeAt: Map<string, number>;
  active: number;
}

export function createInvocationState(): InvocationState {
  return {
    disabled: false,
    channelLocks: new Set(),
    lastReplyAt: new Map(),
    lastNoticeAt: new Map(),
    active: 0,
  };
}

/** The whole generation lifecycle for one invocation. Never throws. */
async function runGeneration(
  runtime: BotRuntime,
  channelId: string,
  channel: ChannelLike,
  state: InvocationState
): Promise<void> {
  runtime.typing(channelId, true);
  let partial = '';
  let posted = false;
  let timedOut = false;
  let donePromise: Promise<void> | null = null;
  let errorPromise: Promise<void> | null = null;
  const control: BotControl = { cancelled: false, abort: null };
  let timer: NodeJS.Timeout | null = null;

  const finishDone = async (full: string): Promise<void> => {
    if (posted) return;
    const reply = sanitizeBotReply(full, BOT_MAX_REPLY_CHARS);
    if (!reply) {
      await sendBotNotice(runtime, channelId, 'empty_reply', state, channel);
      posted = true;
      return;
    }
    await postBotMessage(runtime, channelId, reply, state, { reply: true });
    posted = true;
  };

  const finishError = async (): Promise<void> => {
    if (posted) return;
    const partialText = partial.trim();
    if (partialText.length >= BOT_MIN_PARTIAL_CHARS) {
      // Enough already generated — publish it with an honest stop marker.
      const text = sanitizeBotReply(partial + BOT_STOP_MARKER, BOT_MAX_REPLY_CHARS);
      if (text) {
        await postBotMessage(runtime, channelId, text, state, { reply: true });
        posted = true;
        return;
      }
    }
    // Nothing worth publishing: explain, choosing the cause by how far the
    // generation got — no deltas = the provider never answered (unavailable),
    // some deltas = the model degraded mid-stream (generation_error).
    await sendBotNotice(runtime, channelId, partial.length > 0 ? 'generation_error' : 'unavailable', state, channel);
    posted = true;
  };

  try {
    if (!runtime.hasUsableProvider()) {
      await sendBotNotice(runtime, channelId, 'unavailable', state, channel);
      return;
    }
    const context = buildBotContext(runtime.getMessages(channelId));
    const system = await runtime.buildSystemPrompt(channel);
    const onDelta = (text: string): void => {
      if (partial.length < BOT_MAX_REPLY_CHARS) partial += text;
    };
    timer = setTimeout(() => {
      timedOut = true;
      control.cancelled = true;
      try {
        control.abort?.();
      } catch {
        /* best-effort abort */
      }
      void sendBotNotice(runtime, channelId, 'timeout', state, channel).catch(() => {});
    }, BOT_TIMEOUT_MS);

    const result = await runtime
      .stream(context, system, onDelta, control)
      .then(
        (res) => {
          if (res) donePromise = finishDone(res.full);
          return res;
        },
        () => {
          errorPromise = finishError();
          return null;
        }
      )
      .then(async () => {
        if (donePromise) await donePromise;
        if (errorPromise) await errorPromise;
        if (!posted && !timedOut) {
          // Engine returned without onDone and never threw — empty reply.
          await sendBotNotice(runtime, channelId, 'empty_reply', state, channel);
        }
      });
    void result;
  } catch {
    // Belt & suspenders — nothing here may reach the message-send path.
  } finally {
    if (timer) { clearTimeout(timer); timer = null; }
    runtime.typing(channelId, false);
  }
}

/** Persist + broadcast one bot line (reply cooldown stamped for replies). */
async function postBotMessage(
  runtime: BotRuntime,
  channelId: string,
  text: string,
  state: InvocationState,
  opts?: { reply?: boolean }
): Promise<void> {
  await runtime.persistAndBroadcast(channelId, text, opts);
  if (opts?.reply) state.lastReplyAt.set(channelId, Date.now());
}

/** Post a friendly failure notice, honoring the per-channel notice cooldown. */
async function sendBotNotice(
  runtime: BotRuntime,
  channelId: string,
  cause: BotNoticeCause,
  state: InvocationState,
  _channel: ChannelLike
): Promise<void> {
  const now = Date.now();
  if (!shouldSendNotice(state.lastNoticeAt.get(channelId) ?? null, now, BOT_NOTICE_COOLDOWN_MS)) return;
  state.lastNoticeAt.set(channelId, now);
  await postBotMessage(runtime, channelId, buildBotNotice(cause), state);
}