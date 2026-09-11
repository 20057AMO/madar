/**
 * chat-team-store.ts
 * Persistent store for team chat. Two JSON files per domain, following the
 * notes/users pattern (JSON on disk + withFileLockAsync serialization):
 *   data/chat-team/channels.json          → { channels: TeamChannel[] }
 *   data/chat-team/messages/<channelId>.json → TeamMessage[]
 *   data/chat-team/read.json              → { [channelId]: { [userId]: lastReadId } }
 *   data/chat-team/uploads/<id>           → attachment bytes
 * Channel access decisions (project membership, viewer/editor) live in the
 * caller/routes — the store is pure persistence.
 */
import fs from 'fs';
import path from 'path';

import { withFileLockAsync } from './write-queue';
import {
  DEFAULT_MSG_CAP,
  isChannelId,
  isMessageId,
  pruneToCap,
  type ChatAttachment,
  type ChannelMember,
  type TeamChannel,
  type TeamMessage,
} from './chat-team-core';

const DATA_DIR = process.env.WSD_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const CHAT_DIR = path.join(DATA_DIR, 'chat-team');
const CHANNELS_FILE = path.join(CHAT_DIR, 'channels.json');
const READ_FILE = path.join(CHAT_DIR, 'read.json');
const MESSAGES_DIR = path.join(CHAT_DIR, 'messages');
const UPLOADS_DIR = path.join(CHAT_DIR, 'uploads');

function channelsFileEmpty(): string {
  return JSON.stringify({ channels: [] }, null, 2);
}

export function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function messagesFile(channelId: string): string {
  return path.join(MESSAGES_DIR, `${channelId}.json`);
}

function readChannelsRaw(): { channels: TeamChannel[] } {
  try {
    if (!fs.existsSync(CHANNELS_FILE)) return { channels: [] };
    const raw = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf8'));
    if (raw && Array.isArray(raw.channels)) return raw;
  } catch {
    /* corrupt — treated as empty */
  }
  return { channels: [] };
}

function writeChannelsRaw(data: { channels: TeamChannel[] }): void {
  fs.mkdirSync(CHAT_DIR, { recursive: true });
  fs.writeFileSync(CHANNELS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function readMessagesRaw(channelId: string): TeamMessage[] {
  if (!isChannelId(channelId)) return [];
  try {
    if (!fs.existsSync(messagesFile(channelId))) return [];
    const raw = JSON.parse(fs.readFileSync(messagesFile(channelId), 'utf8'));
    if (Array.isArray(raw)) return raw;
  } catch {
    /* corrupt channel file */
  }
  return [];
}

function writeMessagesRaw(channelId: string, messages: TeamMessage[]): void {
  if (!isChannelId(channelId)) return;
  fs.mkdirSync(MESSAGES_DIR, { recursive: true });
  fs.writeFileSync(messagesFile(channelId), JSON.stringify(messages, null, 2), 'utf8');
}

type ReadMap = Record<string, Record<string, string>>;

function readReadMap(): ReadMap {
  try {
    if (!fs.existsSync(READ_FILE)) return {};
    const raw = JSON.parse(fs.readFileSync(READ_FILE, 'utf8'));
    if (raw && typeof raw === 'object') return raw as ReadMap;
  } catch {
    /* corrupt */
  }
  return {};
}

function writeReadMap(map: ReadMap): void {
  fs.mkdirSync(CHAT_DIR, { recursive: true });
  fs.writeFileSync(READ_FILE, JSON.stringify(map), 'utf8');
}

/** All channels (raw — access filtering happens in the caller). */
export function listChannels(): TeamChannel[] {
  return readChannelsRaw().channels;
}

/** All channels the user is a participant of (direct dm: only participant). */
export function listDirectChannelsFor(userId: string): TeamChannel[] {
  return listChannels().filter((c) => c.kind === 'direct' && c.members.some((m) => m.userId === userId));
}

export function getChannel(channelId: string): TeamChannel | null {
  if (!isChannelId(channelId)) return null;
  return listChannels().find((c) => c.id === channelId) || null;
}

async function saveChannelsLocked(channels: TeamChannel[]): Promise<void> {
  await withFileLockAsync('chat-channels', async () => {
    writeChannelsRaw({ channels });
  });
}

/** Create (idempotently) a channel. Duplicate id returns the existing row. */
export async function createChannel(
  channel: TeamChannel
): Promise<{ created: boolean; channel: TeamChannel }> {
  let created = false;
  const result = await withFileLockAsync(`channel:${channel.id}`, async () => {
    const existing = getChannel(channel.id);
    if (existing) return { created: false, channel: existing };
    const all = readChannelsRaw().channels;
    all.push(channel);
    writeChannelsRaw({ channels: all });
    return { created: true, channel };
  });
  created = result.created;
  return result;
}

/** Direct 1:1 channel — participants only, deterministic id. */
export async function ensureDirectChannel(
  a: string,
  b: string,
  roleOf: (userId: string) => ChannelMember['role']
): Promise<TeamChannel> {
  const id = `dm:${[a, b].sort().join(':')}`;
  const existing = getChannel(id);
  if (existing) return existing;
  const members: ChannelMember[] = [
    { userId: a, role: roleOf(a) },
    { userId: b, role: roleOf(b) },
  ];
  const channel: TeamChannel = {
    id,
    kind: 'direct',
    members,
    createdAt: new Date().toISOString(),
  };
  await createChannel(channel);
  return channel;
}

/** Project auto-channel (idempotent) — tied to the project lifecycle. */
export async function ensureProjectChannel(
  slug: string,
  name?: string,
  ownerId?: string
): Promise<TeamChannel> {
  const id = `project:${slug}`;
  const existing = getChannel(id);
  if (existing) {
    if (ownerId && !existing.members.some((m) => m.userId === ownerId)) {
      await addChannelMember(id, ownerId, 'admin');
    }
    return existing;
  }
  const channel: TeamChannel = {
    id,
    kind: 'project',
    projectSlug: slug,
    name,
    members: ownerId ? [{ userId: ownerId, role: 'admin' }] : [],
    createdBy: ownerId,
    createdAt: new Date().toISOString(),
  };
  await createChannel(channel);
  return channel;
}

/** Add a member to a channel (project channels list members for UX only). */
export async function addChannelMember(channelId: string, userId: string, role: ChannelMember['role']): Promise<void> {
  await withFileLockAsync(`channel:${channelId}`, async () => {
    const all = readChannelsRaw().channels;
    const ch = all.find((c) => c.id === channelId);
    if (!ch) return;
    const before = ch.members.length;
    if (!ch.members.some((m) => m.userId === userId)) {
      ch.members.push({ userId, role });
    }
    if (ch.members.length !== before) writeChannelsRaw({ channels: all });
  });
}

/** Remove a member from a channel (project channels list members for UX only). */
export async function removeChannelMember(channelId: string, userId: string): Promise<void> {
  await withFileLockAsync(`channel:${channelId}`, async () => {
    const all = readChannelsRaw().channels;
    const ch = all.find((c) => c.id === channelId);
    if (!ch) return;
    const before = ch.members.length;
    ch.members = ch.members.filter((m) => m.userId !== userId);
    if (ch.members.length !== before) writeChannelsRaw({ channels: all });
  });
}

/** Update an existing member's role, or add them (data-only — access derives
 * live from checkProjectAccess). Used on ownership transfer to keep the old
 * owner's listed role honest. */
export async function setChannelMemberRole(channelId: string, userId: string, role: ChannelMember['role']): Promise<void> {
  await withFileLockAsync(`channel:${channelId}`, async () => {
    const all = readChannelsRaw().channels;
    const ch = all.find((c) => c.id === channelId);
    if (!ch) return;
    const member = ch.members.find((m) => m.userId === userId);
    if (member) member.role = role;
    else ch.members.push({ userId, role });
    writeChannelsRaw({ channels: all });
  });
}

/** Remove a deleted project's auto-channel + its messages + uploads. */
export async function deleteChannel(channelId: string): Promise<void> {
  const cid = isChannelId(channelId) ? channelId : '';
  let attIds: string[] = [];
  await withFileLockAsync(`channel:${cid || 'x'}`, async () => {
    const all = readChannelsRaw().channels;
    const filtered = all.filter((c) => c.id !== cid);
    if (filtered.length !== all.length) writeChannelsRaw({ channels: filtered });
    if (cid) {
      attIds = readMessagesRaw(cid).flatMap((m) => m.attachments?.map((a) => a.id) ?? []);
      try {
        fs.rmSync(messagesFile(cid), { force: true });
      } catch { /* missing */ }
    }
    // Remove read positions for the channel.
    const read = readReadMap();
    if (read[cid]) {
      delete read[cid];
      writeReadMap(read);
    }
  });
  if (attIds.length > 0) deleteAttachments(attIds);
}

/** Append a message (persisted, pruning oldest beyond cap). */
export async function appendMessage(channelId: string, message: TeamMessage): Promise<TeamMessage> {
  await withFileLockAsync(`msgs:${channelId}`, async () => {
    const messages = readMessagesRaw(channelId);
    if (!messages.some((m) => m.id === message.id)) {
      messages.push(message);
    } else {
      // Idempotent re-append (dup) — replace in place.
      const idx = messages.findIndex((m) => m.id === message.id);
      if (idx !== -1) messages[idx] = message;
    }
    const trimmed = pruneToCap(messages, DEFAULT_MSG_CAP);
    // Only rewrite when pruning actually dropped something (write amplification).
    if (trimmed.length !== messages.length) {
      writeMessagesRaw(channelId, trimmed);
    } else {
      writeMessagesRaw(channelId, messages);
    }
    // Reflect lastMessageAt on the channel row.
    const channels = readChannelsRaw().channels;
    const ch = channels.find((c) => c.id === channelId);
    if (ch && ch.lastMessageAt !== message.createdAt) {
      ch.lastMessageAt = message.createdAt;
      writeChannelsRaw({ channels });
    }
  });
  return message;
}

/** Paged read — newest first by default, page backwards with `before`. */
export function getMessages(
  channelId: string,
  opts?: { limit?: number; before?: string }
): TeamMessage[] {
  const messages = readMessagesRaw(channelId);
  const limit = Math.min(Math.max(Number(opts?.limit) || 50, 1), 200);
  let window = messages;
  if (opts?.before && isMessageId(opts.before)) {
    const idx = messages.findIndex((m) => m.id === opts.before);
    if (idx !== -1) window = messages.slice(0, idx);
  }
  return window.slice(-limit);
}

export function getAllMessages(channelId: string): TeamMessage[] {
  return readMessagesRaw(channelId);
}

export async function pinUnpinMessage(channelId: string, msgId: string, pinned: boolean): Promise<TeamMessage | null> {
  let updated: TeamMessage | null = null;
  await withFileLockAsync(`msgs:${channelId}`, async () => {
    const messages = readMessagesRaw(channelId);
    const idx = messages.findIndex((m) => m.id === msgId);
    if (idx === -1) return;
    if (pinned) messages[idx] = { ...messages[idx], pinned: true };
    else {
      const { pinned: _drop, ...rest } = messages[idx];
      messages[idx] = rest as TeamMessage;
    }
    writeMessagesRaw(channelId, messages);
    updated = messages[idx];
  });
  return updated;
}

/** Record the last read message id for a user in a channel. */
export async function setReadPosition(channelId: string, userId: string, msgId: string): Promise<void> {
  if (!isChannelId(channelId) || !isMessageId(msgId)) return;
  await withFileLockAsync('chat-read', async () => {
    const map = readReadMap();
    if (!map[channelId]) map[channelId] = {};
    if (map[channelId][userId] === msgId) return;
    map[channelId][userId] = msgId;
    writeReadMap(map);
  });
}

export function getReadPosition(channelId: string, userId: string): string | null {
  return readReadMap()[channelId]?.[userId] || null;
}

/** Unread message id per channel for a user (id of the first unread). */
export function getUnreadByChannel(userId: string, channels: TeamChannel[]): Record<string, { count: number; firstUnreadId?: string }> {
  const read = readReadMap();
  const out: Record<string, { count: number; firstUnreadId?: string }> = {};
  for (const ch of channels) {
    const messages = readMessagesRaw(ch.id);
    if (messages.length === 0) continue;
    const lastRead = read[ch.id]?.[userId];
    let startIdx = 0;
    if (lastRead) {
      const idx = messages.findIndex((m) => m.id === lastRead);
      if (idx !== -1) startIdx = idx + 1;
    }
    const unread = messages.slice(startIdx);
    if (unread.length > 0) {
      out[ch.id] = { count: unread.length, firstUnreadId: unread[0].id };
    }
  }
  return out;
}

// ── Attachments (uploads) ─────────────────────────────────────

export function uploadDir(): string {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  return UPLOADS_DIR;
}

/** Save an attachment's bytes under a fresh random id, plus a small meta file
 * (channelId/uploadedBy) so cross-channel reuse can be rejected later. */
export function saveAttachment(buffer: Buffer, channelId: string, userId: string): { id: string; size: number } {
  const id = genId('att');
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  fs.writeFileSync(path.join(UPLOADS_DIR, id), buffer, { mode: 0o600 });
  try {
    fs.writeFileSync(
      path.join(UPLOADS_DIR, `${id}.meta.json`),
      JSON.stringify({ channelId, uploadedBy: userId, uploadedAt: new Date().toISOString(), size: buffer.length }),
      { mode: 0o600 }
    );
  } catch { /* best-effort — without meta the download route 404s (fail-closed) */ }
  return { id, size: buffer.length };
}

/** Ownership metadata for an uploaded attachment — null when absent (legacy). */
export function getAttachmentMeta(attachmentId: string): { channelId: string; uploadedBy: string; uploadedAt: string } | null {
  if (!/^att-[a-z0-9-]+$/.test(attachmentId)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(UPLOADS_DIR, `${attachmentId}.meta.json`), 'utf8'));
    if (raw && typeof raw.channelId === 'string' && typeof raw.uploadedBy === 'string') {
      return { channelId: raw.channelId, uploadedBy: raw.uploadedBy, uploadedAt: String(raw.uploadedAt || '') };
    }
  } catch { /* missing or corrupt */ }
  return null;
}

export function attachmentPath(attachmentId: string): string | null {
  if (!/^att-[a-z0-9-]+$/.test(attachmentId)) return null;
  const full = path.join(UPLOADS_DIR, attachmentId);
  try {
    if (fs.existsSync(full)) return full;
  } catch { /* fallthrough */ }
  return null;
}

export function deleteAttachment(attachmentId: string): void {
  const full = attachmentPath(attachmentId);
  if (full) {
    try {
      fs.rmSync(full, { force: true });
    } catch { /* best-effort */ }
  }
  try {
    fs.rmSync(path.join(UPLOADS_DIR, `${attachmentId}.meta.json`), { force: true });
  } catch { /* best-effort */ }
}

/** Drop a channel's uploads (project delete reclaims disk). */
export function deleteAttachments(attachmentIds: string[]): void {
  for (const id of attachmentIds) deleteAttachment(id);
}

/**
 * Remove a deleted user's traces: every DIRECT channel they participated in
 * is dropped with its messages/read-positions/uploaded bytes (a DM without
 * one of its two parties is a ghost). Team-wide manual channels stay — they
 * are collective, not owned. Called from the user-delete route.
 */
export async function removeUserChannels(userId: string): Promise<number> {
  if (!userId) return 0;
  const victims = listChannels().filter(
    (c) => c.kind === 'direct' && c.members.some((m) => m.userId === userId)
  );
  for (const channel of victims) {
    await deleteChannel(channel.id);
  }
  return victims.length;
}