/**
 * chat-team-core.ts
 * Pure rules for team chat — NO service imports so it can be unit-tested
 * directly under node --test (same pattern as janitor-core/snapshots-schedule).
 * All access decisions that touch project membership live in the caller
 * (routes/ws get the channel + user and pass a project-access result in).
 */

export type ChatChannelKind = 'channel' | 'project' | 'direct';

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
  /** 'direct' = exactly the two participants. */
  members: ChannelMember[];
  createdBy?: string;
  createdAt: string;
  lastMessageAt?: string;
}

export const MAX_TEXT_CHARS = 5000;
export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Cap of stored messages per channel — oldest pruned beyond this. */
export const DEFAULT_MSG_CAP = 500;
/** Restrictive chat id — used in every fs/ws/route key. */
export const CHANNEL_ID_RE = /^[a-z0-9._:-]{1,72}$/;
export const MESSAGE_ID_RE = /^m-[a-z0-9-]{1,48}$/;

/** Team-member usernames are the only mention targets (2-50 chars, no @). */
const MENTION_RE = /(?:^|\s)@([A-Za-z0-9][A-Za-z0-9._-]{1,49})/g;

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
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!cleaned) return null;
  if (cleaned.length > max) return null;
  return cleaned;
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

/** Drop oldest messages beyond cap (pure — returns the kept window). */
export function pruneToCap(messages: TeamMessage[], cap = DEFAULT_MSG_CAP): TeamMessage[] {
  if (messages.length <= cap) return messages;
  return messages.slice(messages.length - cap);
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
  return typeof id === 'string' && CHANNEL_ID_RE.test(id);
}

export function isMessageId(id: unknown): id is string {
  return typeof id === 'string' && MESSAGE_ID_RE.test(id);
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