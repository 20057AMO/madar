/**
 * chat-team-core.ts
 * Pure rules for team chat — NO service imports so it can be unit-tested
 * directly under node --test (same pattern as janitor-core/snapshots-schedule).
 * All access decisions that touch project membership live in the caller
 * (routes/ws get the channel + user and pass a project-access result in).
 */

export type ChatChannelKind = 'channel' | 'project' | 'direct';

/** Who may SEND in a manual channel — 'everyone' (editors+) | 'admins' only. */
export type CanSendMode = 'everyone' | 'admins';

export interface ChatAttachment {
  /** Saved upload id (file lives at data/chat-team/uploads/<id>). */
  id: string;
  /** Original client filename (display only — never used for path math). */
  name: string;
  kind: 'image' | 'file';
  size: number;
}

export interface TeamMessage {
  id: string;
  userId: string;
  username: string;
  text: string;
  replyTo?: string;
  /** Usernames @mentioned in the text (extracted at normalize time). */
  mentions?: string[];
  attachments?: ChatAttachment[];
  pinned?: boolean;
  createdAt: string;
  /** ISO timestamp set when the text is edited after sending (absent otherwise). */
  editedAt?: string;
  /** Lifecycle status. */
  status: 'sent' | 'delivered' | 'read';
  /** Users who have read this message. */
  readBy: string[];
  /** Emoji reactions: whitelisted emoji → user ids who reacted (absent when none). */
  reactions?: Record<string, string[]>;
}

export interface ChannelMember {
  userId: string;
  role: 'admin' | 'editor' | 'viewer';
}

export interface TeamChannel {
  id: string;
  kind: ChatChannelKind;
  /** Manual display name — channels only (never trusted for paths). */
  name?: string;
  /** Present on 'project' channels — the owning project slug. */
  projectSlug?: string;
  /** Manual channels only: who may send/upload/pin ('everyone' when absent). */
  canSend?: CanSendMode;
  /** 'direct' = exactly the two participants. */
  members: ChannelMember[];
  createdBy?: string;
  createdAt: string;
  lastMessageAt?: string;
  pinnedMessageId?: string | null;
}

/** Reserved identity of the @madar team-chat bot. */
export const BOT_USER_ID = 'bot-madar';
export const BOT_USERNAME = 'madar';
/** Usernames human accounts may never claim (the @madar bot owns this one). */
export const RESERVED_USERNAMES = ['madar'];

/** Case-insensitive reserved-username check (immune to trim/padding tricks). */
export function isReservedUsername(name: string): boolean {
  const clean = String(name ?? '').trim().toLowerCase();
  return RESERVED_USERNAMES.includes(clean);
}

/** True when a message was written by the @madar bot itself (loop guard). */
export function isBotMessage(msg: { userId?: string }): boolean {
  return !!msg && msg.userId === BOT_USER_ID;
}

export const MAX_TEXT_CHARS = 5000;
export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Cap of stored messages per channel — oldest pruned beyond this. */
export const DEFAULT_MSG_CAP = 500;
/** Cumulative attachment storage ceiling per channel (disk-exhaustion guard). */
export const MAX_CHANNEL_ATTACHMENT_BYTES = 500 * 1024 * 1024; // 500 MB per channel

/** The ONLY emoji users may react with — enforced at the normalize boundary. */
export const ALLOWED_REACTIONS = [
  '👍',
  '❤️',
  '😂',
  '🎉',
  '👀',
  '✅',
  '🔥',
  '🙏',
  '👎',
  '😮',
  '💯',
  '🚀',
] as const;

export type ReactionEmoji = (typeof ALLOWED_REACTIONS)[number];

/** Distinct reaction types a single message may carry (structural guard —
 * the whitelist above is narrower today, the cap protects the data shape). */
export const MAX_REACTION_TYPES = 20;
/** Restrictive chat id — used in every fs/ws/route key. */
export const CHANNEL_ID_RE = /^[a-z0-9._:-]{1,72}$/;
export const MESSAGE_ID_RE = /^m-[a-z0-9-]{1,48}$/;

/** Team-member usernames are the only mention targets (2-50 chars, no @). */
const MENTION_RE = /(?:^|\s)@([\p{L}\p{N}][\p{L}\p{N}._-]{1,49})/gu;

/** Deterministic project auto-channel id — never collides with manual ids. */
export function buildProjectChannelId(slug: string): string {
  return `project:${slug}`;
}

/**
 * Deterministic direct-chat id: participant ids sorted, colon-joined.
 * Ordering is irrelevant — two users always resolve to the same conversation.
 */
export function buildDirectChannelId(a: string, b: string): string {
  return `dm:${[a, b].sort().join(':')}`;
}

/** Strip control chars + trim, then cap — returns null when empty/over-long. */
export function sanitizePlain(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const sanitized = raw
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!sanitized) return null;
  if (sanitized.length > max) return null;
  return sanitized;
}

/** Extract unique @username targets from message text. */
export function parseMentions(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(text)) !== null) {
    const name = m[1].toLowerCase();
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/**
 * Normalize an inbound message. Accepts { text, replyTo? } (attachments come
 * through the upload route and are attached before append). Returns null on
 * invalid text/replyTo so the caller can 400/error-frame.
 */
export function normalizeMessage(raw: unknown): { text: string; replyTo?: string; mentions: string[] } | null {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as Record<string, unknown>;
  const text = sanitizePlain(body.text, MAX_TEXT_CHARS);
  if (!text) return null;
  let replyTo: string | undefined;
  if (body.replyTo !== undefined && body.replyTo !== null && body.replyTo !== '') {
    if (typeof body.replyTo !== 'string' || !MESSAGE_ID_RE.test(body.replyTo)) return null;
    replyTo = body.replyTo;
  }
  return { text, ...(replyTo ? { replyTo } : {}), mentions: parseMentions(text) };
}

/**
 * Normalize an inbound message EDIT. Same text ceiling as sending
 * (sanitizePlain with MAX_TEXT_CHARS) — empty/over-long/junk return null so
 * the caller can 400. `replyTo` is NEVER accepted here: a reply's target is
 * immutable once sent, and re-targeting an edited message would corrupt the
 * conversation history.
 */
export function normalizeEditMessage(raw: unknown): { text: string; mentions: string[] } | null {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as Record<string, unknown>;
  const text = sanitizePlain(body.text, MAX_TEXT_CHARS);
  if (!text) return null;
  return { text, mentions: parseMentions(text) };
}

/** Whitelist-gate an inbound reaction emoji — anything not in
 * ALLOWED_REACTIONS (non-string, junk, unknown emoji) → null so the caller
 * can 400. This is the ONLY point the whitelist is enforced. */
export function normalizeReaction(emoji: unknown): ReactionEmoji | null {
  if (typeof emoji !== 'string') return null;
  return (ALLOWED_REACTIONS as readonly string[]).includes(emoji) ? (emoji as ReactionEmoji) : null;
}

/**
 * Pure reaction toggle — NEVER mutates the input. Returns:
 *  - a NEW map with `userId` added to / removed from the emoji's user list
 *    (empty keys are dropped as they form, insertion order preserved),
 *  - undefined when the map became completely empty (the caller should then
 *    drop the reactions field entirely — an empty map is the absence of data),
 *  - the SAME reference when the toggle is refused (MAX_REACTION_TYPES distinct
 *    types already present and the emoji is a NEW type) — nothing changed and
 *    nothing needs persisting.
 */
export function toggleReaction(
  reactions: Record<string, string[]> | undefined,
  emoji: ReactionEmoji,
  userId: string
): Record<string, string[]> | undefined {
  const current = reactions || {};
  const existing = current[emoji];
  if (Array.isArray(existing)) {
    if (existing.includes(userId)) {
      // Toggle-off: rebuild in insertion order, dropping the key when empty.
      const users = existing.filter((u) => u !== userId);
      const next: Record<string, string[]> = {};
      for (const [key, list] of Object.entries(current)) {
        if (key === emoji) {
          if (users.length > 0) next[key] = users;
        } else {
          next[key] = list;
        }
      }
      return Object.keys(next).length > 0 ? next : undefined;
    }
    // Key exists but user is absent — add them (no cap check: not a new type).
    const next: Record<string, string[]> = {};
    for (const [key, list] of Object.entries(current)) next[key] = list;
    next[emoji] = [...existing, userId];
    return next;
  }
  // Cap: a NEW type is refused once the distinct-type ceiling is reached —
  // existing types keep toggling (removals are always allowed).
  if (Object.keys(current).length >= MAX_REACTION_TYPES) return current;
  const next: Record<string, string[]> = {};
  for (const [key, list] of Object.entries(current)) next[key] = list;
  next[emoji] = [userId];
  return next;
}

/** One ranked reaction row for display. */
export interface ReactionCount {
  emoji: ReactionEmoji;
  count: number;
  users: string[];
}

/**
 * Rank reactions for the UI: highest count first, ties in insertion order
 * (Array#sort is stable, so Object.entries order — which toggleReaction keeps
 * as first-appearance order — survives). Defensive: non-whitelisted keys and
 * non-array user lists are skipped; user arrays are copied, never shared.
 */
export function sortReactions(reactions: Record<string, string[]> | undefined): ReactionCount[] {
  if (!reactions) return [];
  const out: ReactionCount[] = [];
  for (const [emoji, users] of Object.entries(reactions)) {
    const norm = normalizeReaction(emoji);
    if (!norm || !Array.isArray(users)) continue;
    out.push({ emoji: norm, count: users.length, users: users.slice() });
  }
  return out.sort((a, b) => b.count - a.count);
}

/** Edit permission — message authors only (channel roles never widen this). */
export function canEditMessage(msg: { userId: string }, requestingUserId: string): boolean {
  return msg.userId === requestingUserId;
}

/** Delete permission — the author, a write-level member on a bot message,
 *  the channel admin, or a system admin. A bot message has no human author —
 *  `writeLevel` (the user may send in this channel) is enough to clean up a
 *  bad bot reply without narrowing that right. */
export function canDeleteMessage(
  msg: { userId: string },
  requestingUserId: string,
  opts: { isChannelAdmin: boolean; isSystemAdmin: boolean; writeLevel?: boolean }
): boolean {
  if (isBotMessage(msg) && opts.writeLevel) return true;
  if (msg.userId === requestingUserId) return true;
  if (opts.isChannelAdmin) return true;
  if (opts.isSystemAdmin) return true;
  return false;
}

/**
 * Build a fully-shaped message record. `replyToExists` is checked by the caller
 * so the pure layer stays fs-free — a dangling replyTo is dropped here.
 */
export function formatMessage(
  id: string,
  userId: string,
  username: string,
  normalized: { text: string; replyTo?: string; mentions: string[] },
  opts?: { replyToExists?: boolean; attachments?: ChatAttachment[]; pinned?: boolean },
  createdAt = new Date().toISOString()
): TeamMessage {
  const replyTo = normalized.replyTo && opts?.replyToExists ? normalized.replyTo : undefined;
  const attachments = opts?.attachments?.length ? opts.attachments.slice(0, MAX_ATTACHMENTS) : undefined;
  const msg: TeamMessage = {
    id,
    userId,
    username,
    text: normalized.text,
    createdAt,
    status: 'sent',
    readBy: [],
    ...(replyTo ? { replyTo } : {}),
    ...(normalized.mentions.length ? { mentions: normalized.mentions } : {}),
    ...(attachments?.length ? { attachments } : {}),
    ...(opts?.pinned ? { pinned: true } : {}),
  };
  return msg;
}

/** Case-insensitive text search across a message window. */
export function searchMessages(messages: TeamMessage[], query: string): TeamMessage[] {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return [];
  return messages.filter((m) => (m.text || '').toLowerCase().includes(q));
}

/** A single global-search hit: the channel it was found in + the matching message. */
export interface SearchMatch {
  channelId: string;
  message: TeamMessage;
}

/**
 * Search a single channel's messages from the END (newest) toward the start,
 * stopping as soon as `limit` hits accumulate — the opposite direction of
 * `searchMessages` (which is NOT touched). Case-insensitive.
 */
export function searchMessagesRecent(messages: TeamMessage[], query: string, limit: number): TeamMessage[] {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return [];
  const out: TeamMessage[] = [];
  for (let i = messages.length - 1; i >= 0 && out.length < limit; i--) {
    const m = messages[i];
    if ((m.text || '').toLowerCase().includes(q)) {
      out.push(m);
    }
  }
  return out;
}

/**
 * Merge + rank cross-channel hits: newest `createdAt` first, trimmed to `total`.
 * Pure — does not group; the caller groups by channelId after this.
 */
export function rankGlobalSearch(matches: SearchMatch[], total: number): SearchMatch[] {
  return matches
    .slice()
    .sort((a, b) => new Date(b.message.createdAt).getTime() - new Date(a.message.createdAt).getTime())
    .slice(0, total);
}

/** Drop oldest messages beyond cap (pure — returns the kept window). */
export function pruneToCap(messages: TeamMessage[], cap = DEFAULT_MSG_CAP): TeamMessage[] {
  if (messages.length <= cap) return messages;
  return messages.slice(messages.length - cap);
}

/** Total attachment bytes referenced across the given messages. */
export function channelAttachmentBytes(messages: { attachments?: { size?: number }[] }[]): number {
  return messages.reduce((sum, m) => sum + (m.attachments?.reduce((s, a) => s + (a.size || 0), 0) ?? 0), 0);
}

/** True when adding `addedBytes` to stored `existingBytes` crosses the per-channel ceiling. */
export function wouldExceedAttachmentQuota(existingBytes: number, addedBytes: number): boolean {
  return existingBytes + addedBytes > MAX_CHANNEL_ATTACHMENT_BYTES;
}

/** How many messages accumulated beyond the cap (for the prune batch). */
export function excessCount(messages: TeamMessage[], cap = DEFAULT_MSG_CAP): number {
  return Math.max(0, messages.length - cap);
}

/** Unique pinned messages (newest first) — pin order never lies. */
export function pinnedMessages(messages: TeamMessage[]): TeamMessage[] {
  return messages.filter((m) => m.pinned).reverse();
}

export function isChannelId(id: unknown): id is string {
  // L3: the safe charset regex alone would accept '.' / '..' as full ids —
  // harmless today (ids are never used for raw path math) but a future-proof
  // guard against any path-joining that skips its own normalization.
  if (id === '.' || id === '..') return false;
  return typeof id === 'string' && CHANNEL_ID_RE.test(id);
}

export function isMessageId(id: unknown): id is string {
  return typeof id === 'string' && MESSAGE_ID_RE.test(id);
}

/** Validate an inbound canSend mode — junk/absent → null (caller defaults). */
export function sanitizeCanSend(raw: unknown): CanSendMode | null {
  if (raw === 'everyone' || raw === 'admins') return raw;
  return null;
}

/** True for the channel creator or an explicit admin member on the channel. */
export function isChannelAdmin(
  channel: { createdBy?: string; members?: { userId: string; role: string }[] },
  userId: string
): boolean {
  return channel.createdBy === userId || (channel.members || []).some((m) => m.userId === userId && m.role === 'admin');
}

/** Sort key for the conversation rail — most recent activity first. */
export function channelSortKey(ch: TeamChannel): number {
  return new Date(ch.lastMessageAt || ch.createdAt).getTime();
}

/** Human label for a direct channel (the other participant) or manual name. */
export function channelLabel(ch: TeamChannel, selfId: string, userNameOf: (id: string) => string | undefined): string {
  if (ch.kind === 'direct') {
    const other = ch.members.find((m) => m.userId !== selfId);
    return other ? userNameOf(other.userId) || other.userId : 'Direct';
  }
  return ch.kind === 'project' ? `#${ch.projectSlug}` : ch.name || ch.id;
}