/**
 * chat-team-routes.ts
 * Madar — Team chat REST surface. Registered from index.ts AFTER the auth
 * middleware, so every handler has req.user. Message SENDING is the single
 * authoritative write path (validation + persistence + WS broadcast); the
 * WebSocket handler only pushes live frames.
 */
import { Router } from 'express';
import multer from 'multer';
import fs from 'fs';

import { readMeta } from './projects-meta';
import { canonicalProjectSlug } from './project-slug-core';

import {
  listUsers,
} from './user-store';
import { checkUserWrite } from './user-write-limiter';
import {
  isChannelId,
  isMessageId,
  sanitizeCanSend,
  normalizeMessage,
  normalizeEditMessage,
  normalizeReaction,
  canEditMessage,
  canDeleteMessage,
  formatMessage,
  searchMessages,
  searchMessagesRecent,
  rankGlobalSearch,
  channelSortKey,
  channelLabel,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_CHANNEL_ATTACHMENT_BYTES,
  channelAttachmentBytes,
  isChannelAdmin,
  type CanSendMode,
  type ChannelMember,
  type ChatAttachment,
  type SearchMatch,
  type TeamChannel,
  type TeamMessage,
} from './chat-team-core';
import { recordAudit } from './audit-store';
import {
  listChannels,
  getChannel,
  createChannel,
  ensureDirectChannel,
  deleteChannel,
  appendMessage,
  getMessages,
  getAllMessages,
  pinUnpinMessage,
  markMessagesAsRead,
  getUnreadByChannel,
  saveAttachment,
  attachmentPath,
  attachmentHead,
  getAttachmentMeta,
  genId,
  getLastMessage,
  setPinnedMessage,
  setChannelCanSend,
  editMessage,
  deleteMessage,
  toggleMessageReaction,
} from './chat-team-store';
import { canAccessChannel, canSendInChannel, type ChatUser } from './chat-team-access';
import {
  attachmentFileName,
  contentDispositionHeader,
  detectAttachmentFacts,
  detectAttachmentKind,
  sanitizeAttachmentName,
  ATTACHMENT_HEAD_BYTES,
} from './chat-attachment-kind';
import {
  broadcastChatMessage,
  broadcastChatBump,
  broadcastMessageUpdated,
  broadcastMessageDeleted,
  broadcastPinChange,
  broadcastPinnedUpdate,
  broadcastChannelUpdate,
  broadcastChannelDeleted,
  getChatTeamPresence,
} from '../ws/ws-chat-team';
import { teamChatBot } from './chat-team-bot';

// memoryStorage only: nothing is written to disk here, so a request rejected
// in the handler below (bad channel, no access, admins-only) leaves no orphan
// bytes behind — the buffer is simply garbage-collected. The channel gate used
// to live in a multer `fileFilter`, which had to fail closed while streaming:
// a client that sends the file part BEFORE the channelId field got a bogus
// 400. Authorization now runs in the handler, after multer has parsed the
// whole multipart body, so field order no longer matters.
const chatUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
});

/**
 * `chatUpload.single('file')` with one addition: multer aborts on
 * LIMIT_FILE_SIZE but never reports WHICH limit it hit, so the global handler
 * could only answer a bare "File too large". Tag the real cap (10 MB, from
 * MAX_ATTACHMENT_BYTES — never a retyped number) so the 413 can name it.
 */
function chatUploadSingle(req: any, res: any, next: any): void {
  chatUpload.single('file')(req, res, (err: any) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') err.limitBytes = MAX_ATTACHMENT_BYTES;
    next(err);
  });
}

/**
 * Per-user write budget for chat sends/uploads — chat is bursty, so give real
 * conversations headroom (240/min) while still capping runaway/agent loops.
 * Integration tests get a higher ceiling so the serial stress suite can run.
 */
function chatWriteLimiter(req: any, res: any, next: any): void {
  const max = process.env.WSD_TESTING === '1' ? 4000 : 240;
  const retryAfter = checkUserWrite(req?.user?.id, req?.ip, 60_000, max);
  if (retryAfter > 0) {
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'Too many chat requests. Try again later.' });
  }
  next();
}

type SafeUserRow = { id: string; username: string; displayName?: string; avatarExt?: string };

type EnrichedChannel = TeamChannel & {
  members: {
    userId: string;
    role: ChannelMember['role'];
    username: string;
    displayName?: string;
    avatarExt?: string;
  }[];
  /** Persisted send mode, surfaced with the legacy default. */
  canSend: CanSendMode;
  /** May THIS requesting user send/upload/pin right now (canSendInChannel)? */
  maySend: boolean;
};

/** id → { username, displayName, avatarExt } for channel/message enrichment. */
function userIndex(): Map<string, SafeUserRow> {
  const out = new Map<string, SafeUserRow>();
  for (const u of listUsers()) {
    out.set(u.id, {
      id: u.id,
      username: u.username,
      displayName: u.profile?.displayName,
      avatarExt: u.profile?.avatarExt,
    });
  }
  return out;
}

/** Channels the user can SEE (direct: participants, project: read access, manual: all). */
function visibleChannels(user: ChatUser, idx: Map<string, SafeUserRow>): TeamChannel[] {
  return listChannels()
    .filter((c) => canAccessChannel(user, c) !== 'none')
    .map((c) => enrichChannel(c, idx, user))
    .sort((a, b) => channelSortKey(b) - channelSortKey(a));
}

function enrichChannel(c: TeamChannel, idx: Map<string, SafeUserRow>, user: ChatUser): EnrichedChannel {
  const members = c.members.map((m) => {
    const row = idx.get(m.userId);
    return {
      userId: m.userId,
      role: m.role,
      username: row?.username || m.userId,
      displayName: row?.displayName,
      avatarExt: row?.avatarExt,
    };
  });
  const level = canAccessChannel(user, c);
  return {
    ...c,
    members,
    canSend: c.canSend || 'everyone',
    maySend: canSendInChannel(user, c, level === 'write' ? 'write' : 'read'),
  } as EnrichedChannel;
}

export function registerChatTeamRoutes(app: any): void {
  const r = Router();
  app.use('/api/chat-team', r);

  // ── Conversation rail ────────────────────────────────────────
  r.get('/channels', (req: any, res) => {
    const user: ChatUser = { id: req.user.id, username: req.user.username, role: req.user.role };
    const idx = userIndex();
    const channels = visibleChannels(user, idx);
    const unread = getUnreadByChannel(user.id, channels);
    res.json({
      channels: channels.map((c) => {
        const lastMsg = getLastMessage(c.id);
        return {
          ...c,
          unread: unread[c.id]?.count || 0,
          firstUnreadId: unread[c.id]?.firstUnreadId,
          // Compact preview: an attachment-only message (image / voice note)
          // has empty text, so the rail needs the attachment kinds to render
          // "[Photo]" instead of a blank line. Additive — older clients ignore it.
          lastMessage: lastMsg
            ? {
                text: lastMsg.text,
                timestamp: lastMsg.createdAt,
                ...(lastMsg.attachments?.length
                  ? { attachments: lastMsg.attachments.map((a) => ({ id: a.id, name: a.name, kind: a.kind })) }
                  : {}),
              }
            : null,
        };
      }),
    });
  });

  // Create a manual team-wide channel (editor+).
  r.post('/channels', chatWriteLimiter, async (req: any, res) => {
    const user: ChatUser = { id: req.user.id, username: req.user.username, role: req.user.role };
    if (user.role === 'viewer') {
      return res.status(403).json({ error: 'Editors and admins can create channels' });
    }
    const name = typeof req.body?.name === 'string' ? req.body.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60) : '';
    if (!name) return res.status(400).json({ error: 'Channel name is required' });
    // Case-insensitive name uniqueness among manual channels (design/planning
    // rooms must not silently fork; "General" vs "general" collides → 409).
    if (listChannels().some((c) => c.kind === 'channel' && (c.name || '').toLowerCase() === name.toLowerCase())) {
      return res.status(409).json({ error: 'A channel with that name already exists' });
    }
    // Explicit canSend must be valid — junk fails closed (400) exactly like
    // PUT /settings; it is never silently widened to the open 'everyone'.
    if (req.body?.canSend !== undefined && !sanitizeCanSend(req.body.canSend)) {
      return res.status(400).json({ error: 'Invalid canSend value' });
    }
    const channel: TeamChannel = {
      id: genId('ch'),
      kind: 'channel',
      name,
      members: [],
      createdBy: user.id,
      createdAt: new Date().toISOString(),
      // Optional send mode — absent defaults to the open 'everyone'.
      canSend: sanitizeCanSend(req.body?.canSend) ?? 'everyone',
    };
    try {
      const { created, channel: ch } = await createChannel(channel);
      if (!created) return res.status(409).json({ error: 'Channel already exists' });
      const idx = userIndex();
      res.status(201).json({ channel: enrichChannel(ch, idx, user) });
    } catch (err) {
      res.status(500).json({ error: 'Failed to create channel' });
    }
  });

  // Direct conversation with another user (idempotent).
  r.post('/direct', chatWriteLimiter, async (req: any, res) => {
    const user: ChatUser = { id: req.user.id, username: req.user.username, role: req.user.role };
    const otherUserId = typeof req.body?.with === 'string' ? req.body.with : '';
    if (!otherUserId) return res.status(400).json({ error: '`with` is required' });
    if (otherUserId === user.id) return res.status(400).json({ error: 'Cannot chat with yourself' });
    const exists = listUsers().some((u) => u.id === otherUserId);
    if (!exists) return res.status(404).json({ error: 'User not found' });
    const roleOf = (id: string): ChannelMember['role'] => {
      const u = listUsers().find((x) => x.id === id);
      return u?.role === 'viewer' ? 'viewer' : 'editor';
    };
    const channel = await ensureDirectChannel(user.id, otherUserId, roleOf);
    const idx = userIndex();
    res.status(201).json({ channel: enrichChannel(channel, idx, user) });
  });

  // Channel detail (read access required).
  r.get('/channels/:channelId', (req: any, res) => {
    if (!isChannelId(req.params.channelId)) return res.status(400).json({ error: 'Invalid channel id' });
    const user: ChatUser = { id: req.user.id, username: req.user.username, role: req.user.role };
    const channel = getChannel(req.params.channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    const level = canAccessChannel(user, channel);
    if (level === 'none') {
      return res.status(403).json({ error: 'Access denied' });
    }
    const idx = userIndex();
    res.json({ channel: enrichChannel(channel, idx, user), level });
  });

  // Delete a manual channel or a project channel (system admin only).
  r.delete('/channels/:channelId', chatWriteLimiter, async (req: any, res) => {
    const cid = req.params.channelId;
    if (!isChannelId(cid)) return res.status(400).json({ error: 'Invalid channel id' });
    const user: ChatUser = { id: req.user.id, username: req.user.username, role: req.user.role };
    const channel = getChannel(cid);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    if (channel.kind === 'project') {
      if (user.role !== 'admin') {
        return res.status(403).json({ error: 'Only a system admin can delete a project channel' });
      }
      const slug = channel.projectSlug || '';
      if (canonicalProjectSlug(slug) !== slug || cid !== `project:${slug}`) {
        return res.status(400).json({ error: 'Invalid project channel' });
      }
      await deleteChannel(cid, { preserveProjectChannel: readMeta(slug).state !== 'absent' });
    } else if (channel.kind === 'channel') {
      const isCreator = channel.createdBy === user.id;
      if (user.role !== 'admin' && !(user.role === 'editor' && isCreator)) {
        return res.status(403).json({ error: 'Only the creator or an admin can delete this channel' });
      }
      await deleteChannel(cid);
    } else {
      return res.status(400).json({ error: 'Direct message channels cannot be deleted' });
    }
    broadcastChannelDeleted(cid);
    res.json({ ok: true });
  });

  // Pin a specific message as the channel's primary pinned message (editor+).
  r.put('/channels/:id/pin', chatWriteLimiter, async (req: any, res) => {
    const cid = req.params.id;
    if (!isChannelId(cid)) return res.status(400).json({ error: 'Invalid channel id' });
    
    const user: ChatUser = { id: req.user.id, username: req.user.username, role: req.user.role };
    const channel = getChannel(cid);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    
    const level = canAccessChannel(user, channel);
    if (level !== 'write') return res.status(403).json({ error: 'Write access required to pin' });
    if (!canSendInChannel(user, channel, level)) {
      return res.status(403).json({ error: 'Only admins can send in this channel' });
    }

    const messageId = typeof req.body?.messageId === 'string' ? req.body.messageId : null;
    if (messageId !== null && !isMessageId(messageId)) return res.status(400).json({ error: 'Invalid message id' });

    if (!(await setPinnedMessage(cid, messageId))) {
      return res.status(404).json({ error: getChannel(cid) ? 'Message not found' : 'Channel not found' });
    }
    const updatedChannel = getChannel(cid) || channel;

    broadcastPinnedUpdate(cid, updatedChannel.pinnedMessageId || null);
    // Same enriched shape as every other channel-returning route (member
    // usernames/avatars, canSend default, maySend) — a raw row here would make
    // the client's channel state regress on the response of this call.
    const idx = userIndex();
    res.json({ channel: enrichChannel(updatedChannel, idx, user) });
  });

  // Channel send-mode settings (creator / explicit channel admin / system admin).
  r.put('/channels/:channelId/settings', chatWriteLimiter, async (req: any, res) => {
    const cid = req.params.channelId;
    if (!isChannelId(cid)) return res.status(400).json({ error: 'Invalid channel id' });
    const canSend = sanitizeCanSend(req.body?.canSend);
    if (!canSend) return res.status(400).json({ error: 'Invalid canSend value' });
    const user: ChatUser = { id: req.user.id, username: req.user.username, role: req.user.role };
    const channel = getChannel(cid);
    if (!channel) {
      recordAudit('chat-channel-settings-failed', false, req.ip, user.id);
      return res.status(404).json({ error: 'Channel not found' });
    }
    if (channel.kind !== 'channel') {
      recordAudit('chat-channel-settings-failed', false, req.ip, user.id);
      return res.status(400).json({ error: 'Only manual channels have send settings' });
    }
    const level = canAccessChannel(user, channel);
    if (level !== 'write' || (user.role !== 'admin' && !isChannelAdmin(channel, user.id))) {
      recordAudit('chat-channel-settings-failed', false, req.ip, user.id);
      return res.status(403).json({ error: 'Only the creator or a channel admin can change send settings' });
    }
    const updated = await setChannelCanSend(cid, canSend);
    if (!updated) {
      recordAudit('chat-channel-settings-failed', false, req.ip, user.id);
      return res.status(404).json({ error: 'Channel not found' });
    }
    broadcastChannelUpdate(cid, canSend);
    recordAudit('chat-channel-settings', true, req.ip, user.id);
    const idx = userIndex();
    res.json({ channel: enrichChannel(updated, idx, user) });
  });

  // ── Messages ─────────────────────────────────────────────────
  r.get('/channels/:channelId/messages', (req: any, res) => {
    const cid = req.params.channelId;
    if (!isChannelId(cid)) return res.status(400).json({ error: 'Invalid channel id' });
    const user: ChatUser = { id: req.user.id, username: req.user.username, role: req.user.role };
    const channel = getChannel(cid);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    if (canAccessChannel(user, channel) === 'none') return res.status(403).json({ error: 'Access denied' });
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const before = typeof req.query.before === 'string' && req.query.before ? req.query.before : undefined;
    res.json({ messages: getMessages(cid, { limit, before }) });
  });

  r.get('/channels/:channelId/search', (req: any, res) => {
    const cid = req.params.channelId;
    if (!isChannelId(cid)) return res.status(400).json({ error: 'Invalid channel id' });
    const user: ChatUser = { id: req.user.id, username: req.user.username, role: req.user.role };
    const channel = getChannel(cid);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    if (canAccessChannel(user, channel) === 'none') {
      return res.status(403).json({ error: 'Access denied' });
    }
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    if (!q) return res.json({ messages: [] });
    res.json({ messages: searchMessages(getAllMessages(cid), q).slice(-50) });
  });

  // ── Global search across all accessible channels ─────────────
  r.get('/search', chatWriteLimiter, (req: any, res) => {
    const user: ChatUser = { id: req.user.id, username: req.user.username, role: req.user.role };
    const q = String(req.query.q ?? '').trim();
    if (q.length < 2 || q.length > 200) return res.status(400).json({ error: 'Query must be 2-200 characters' });
    const perChannel = Math.min(Math.max(Number(req.query.perChannel) || 10, 1), 20);
    const total = Math.min(Math.max(Number(req.query.total) || 50, 1), 100);

    const idx = userIndex();
    const userNameOf = (id: string) => idx.get(id)?.username;
    const accessible = listChannels().filter((c) => canAccessChannel(user, c) !== 'none');

    let flat: SearchMatch[] = [];
    for (const c of accessible) {
      const hits = searchMessagesRecent(getAllMessages(c.id), q, perChannel);
      for (const msg of hits) flat.push({ channelId: c.id, message: msg });
    }

    const ranked = rankGlobalSearch(flat, total);

    // Group by channelId, preserving the order of first appearance.
    const grouped = new Map<string, SearchMatch[]>();
    for (const m of ranked) {
      const arr = grouped.get(m.channelId);
      if (arr) arr.push(m);
      else grouped.set(m.channelId, [m]);
    }

    const results: { channelId: string; channelKind: string; channelName: string; messages: TeamMessage[] }[] = [];
    for (const [channelId, matches] of grouped) {
      const ch = getChannel(channelId);
      if (!ch) continue;
      results.push({
        channelId,
        channelKind: ch.kind,
        channelName: channelLabel(ch, user.id, userNameOf),
        messages: matches.map((m) => m.message),
      });
    }

    res.json({ query: q, results });
  });

  // Send a message — the authoritative write path (rate-limited, validated).
  r.post('/messages', chatWriteLimiter, async (req: any, res) => {
    const user: ChatUser = { id: req.user.id, username: req.user.username, role: req.user.role };
    const channelId = typeof req.body?.channelId === 'string' ? req.body.channelId : '';
    if (!isChannelId(channelId)) return res.status(400).json({ error: 'Invalid channel id' });
    const channel = getChannel(channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    const level = canAccessChannel(user, channel);
    if (level !== 'write') {
      if (level === 'read') return res.status(403).json({ error: 'Read-only channel' });
      return res.status(403).json({ error: 'Access denied' });
    }
    if (!canSendInChannel(user, channel, level)) {
      return res.status(403).json({ error: 'Only admins can send in this channel' });
    }

    // Attachments are pre-uploaded ids the client attaches by reference.
    // Resolved BEFORE the text: an attachment-only message has no caption, so
    // the text gate below must know whether anything valid was attached.
    let attachments: ChatAttachment[] | undefined;
    const rawAtt = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
    if (rawAtt.length > 0) {
      if (rawAtt.length > MAX_ATTACHMENTS) return res.status(400).json({ error: 'Too many attachments' });
      let total = 0;
      const out: ChatAttachment[] = [];
      for (const a of rawAtt) {
        const id = typeof a?.id === 'string' ? a.id : '';
        if (!/^att-[a-z0-9-]+$/.test(id)) return res.status(400).json({ error: 'Invalid attachment' });
        const attPath = attachmentPath(id);
        if (!attPath) return res.status(400).json({ error: 'Attachment not found' });
        const meta = getAttachmentMeta(id);
        if (!meta || meta.channelId !== channelId) {
          return res.status(400).json({ error: 'Attachment was uploaded to a different channel' });
        }
        let size = 0;
        try {
          size = fs.statSync(attPath).size;
        } catch {
          return res.status(400).json({ error: 'Attachment not found' });
        }
        total += size;
        if (total > MAX_ATTACHMENT_BYTES) return res.status(400).json({ error: 'Attachments too large' });
        // Display name: the client may re-label it per message, otherwise the
        // name persisted at upload wins. Both are sanitized — a header/path-
        // breaking name can never reach Content-Disposition.
        const name = sanitizeAttachmentName(
          typeof a?.name === 'string' && a.name ? a.name : meta.name,
          'file'
        );
        // Kind is re-derived from the stored bytes (client-claimed kind is
        // never trusted) — only the first 64 bytes are read, so a 10 MB voice
        // note is never slurped to learn its type.
        const kind = detectAttachmentKind(attachmentHead(id, ATTACHMENT_HEAD_BYTES));
        out.push({ id, name, kind, size });
      }
      attachments = out;
      const existingBytes = channelAttachmentBytes(getAllMessages(channelId));
      const newBytes = attachments.reduce((s, a) => s + (a.size || 0), 0);
      if (existingBytes + newBytes > MAX_CHANNEL_ATTACHMENT_BYTES) {
        return res.status(400).json({ error: 'Channel attachment storage limit exceeded (500 MB)' });
      }
    }

    const normalized = normalizeMessage(req.body, { allowEmptyText: (attachments?.length || 0) > 0 });
    if (!normalized) return res.status(400).json({ error: 'Message is required (max 5000 chars)' });

    // Reply target must actually exist in THIS channel.
    let replyToExists = false;
    if (normalized.replyTo) {
      replyToExists = getAllMessages(channelId).some((m) => m.id === normalized.replyTo);
      if (!replyToExists) return res.status(400).json({ error: 'Reply target not found' });
    }

    const message: TeamMessage = formatMessage(
      genId('m'),
      user.id,
      user.username,
      normalized,
      { replyToExists, attachments }
    );

    const appended = await appendMessage(channelId, message);
    if (!appended) return res.status(404).json({ error: 'Channel not found' });
    const freshChannel = getChannel(channelId) || channel;
    broadcastChatMessage(freshChannel, message);
    // Side-by-side mini-broadcast: subscribers get the full `message` frame
    // above; EVERY other accessible socket gets a compact `chat_bump` so a
    // channel that isn't open still updates live (unread badges never freeze).
    broadcastChatBump(user, freshChannel, message);
    // Fire-and-forget @madar bot (dispatchWebhook pattern): a mention in a
    // channel/project room schedules a background reply — the 201 is never
    // slowed down by LLM latency, and a bot failure never breaks the send.
    void teamChatBot.maybeInvokeBot(channelId, message, freshChannel);
    res.status(201).json({ message });
  });

  // Pin / unpin a message (write access).
  r.put('/channels/:channelId/messages/:msgId/pin', chatWriteLimiter, async (req: any, res) => {
    const cid = req.params.channelId;
    const msgId = req.params.msgId;
    if (!isChannelId(cid) || !isMessageId(msgId)) return res.status(400).json({ error: 'Invalid ids' });
    const user: ChatUser = { id: req.user.id, username: req.user.username, role: req.user.role };
    const channel = getChannel(cid);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    const level = canAccessChannel(user, channel);
    if (level !== 'write') return res.status(403).json({ error: 'Write access required to pin' });
    if (!canSendInChannel(user, channel, level)) {
      return res.status(403).json({ error: 'Only admins can send in this channel' });
    }
    const pinned = req.body?.pinned === true;
    const updated = await pinUnpinMessage(cid, msgId, pinned);
    if (!updated) return res.status(404).json({ error: 'Message not found' });
    broadcastPinChange(cid, msgId, pinned);
    res.json({ message: updated });
  });

  // Edit a message — the AUTHOR only (text + mentions rewritten; attachments
  // and replyTo are immutable once sent). Same write budget as sending.
  r.put('/channels/:channelId/messages/:msgId', chatWriteLimiter, async (req: any, res) => {
    const cid = req.params.channelId;
    const msgId = req.params.msgId;
    if (!isChannelId(cid) || !isMessageId(msgId)) return res.status(400).json({ error: 'Invalid ids' });
    const user: ChatUser = { id: req.user.id, username: req.user.username, role: req.user.role };
    const channel = getChannel(cid);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    const level = canAccessChannel(user, channel);
    if (level !== 'write') {
      if (level === 'read') return res.status(403).json({ error: 'Read-only channel' });
      return res.status(403).json({ error: 'Access denied' });
    }
    // canSend gate: in an admins-locked channel, only admins may edit messages
    // (even their own pre-lock messages) — mirrors the pin/send enforcement.
    if (!canSendInChannel(user, channel, level)) {
      return res.status(403).json({ error: 'Only admins can modify messages in this channel' });
    }
    const existing = getAllMessages(cid).find((m) => m.id === msgId);
    if (!existing) return res.status(404).json({ error: 'Message not found' });
    // Edit is author-only — a channel admin's write level never widens it.
    if (!canEditMessage(existing, user.id)) {
      return res.status(403).json({ error: 'Only the author can edit this message' });
    }
    const normalized = normalizeEditMessage(req.body, {
      allowEmptyText: (existing.attachments?.length || 0) > 0,
    });
    if (!normalized) return res.status(400).json({ error: 'Message is required (max 5000 chars)' });
    const updated = await editMessage(cid, msgId, normalized.text, normalized.mentions);
    if (!updated) return res.status(404).json({ error: 'Message not found' });
    broadcastMessageUpdated(cid, updated);
    res.json({ message: updated });
  });

  // Toggle a reaction on a message. ANY reader may react — a viewer passes
  // with read access (access !== 'none'); canSend never gates reactions (in an
  // admins-locked channel a non-admin reader still reacts). The emoji must be
  // whitelisted, the message must exist, and the toggle is atomic under the
  // msgs lock with a live broadcast to the room.
  r.post('/channels/:channelId/messages/:msgId/reactions', chatWriteLimiter, async (req: any, res) => {
    const cid = req.params.channelId;
    const msgId = req.params.msgId;
    if (!isChannelId(cid) || !isMessageId(msgId)) return res.status(400).json({ error: 'Invalid ids' });
    const user: ChatUser = { id: req.user.id, username: req.user.username, role: req.user.role };
    const channel = getChannel(cid);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    if (canAccessChannel(user, channel) === 'none') return res.status(403).json({ error: 'Access denied' });
    const emoji = normalizeReaction(req.body?.emoji);
    if (!emoji) return res.status(400).json({ error: 'Invalid emoji' });
    const updated = await toggleMessageReaction(cid, msgId, emoji, user.id);
    if (!updated) return res.status(404).json({ error: 'Message not found' });
    broadcastMessageUpdated(cid, updated);
    res.json({ message: updated });
  });

  // Delete a message — the author, a channel admin (creator/explicit admin
  // member), or a system admin. Attachments are gc'd inside the store lock.
  r.delete('/channels/:channelId/messages/:msgId', chatWriteLimiter, async (req: any, res) => {
    const cid = req.params.channelId;
    const msgId = req.params.msgId;
    if (!isChannelId(cid) || !isMessageId(msgId)) return res.status(400).json({ error: 'Invalid ids' });
    const user: ChatUser = { id: req.user.id, username: req.user.username, role: req.user.role };
    const channel = getChannel(cid);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    const level = canAccessChannel(user, channel);
    if (level === 'none') return res.status(403).json({ error: 'Access denied' });
    // canSend gate: in an admins-locked channel, only admins may delete
    // messages — mirrors the pin/send enforcement.
    if (!canSendInChannel(user, channel, level)) {
      return res.status(403).json({ error: 'Only admins can modify messages in this channel' });
    }
    const existing = getAllMessages(cid).find((m) => m.id === msgId);
    if (!existing) return res.status(404).json({ error: 'Message not found' });
    const allowed = canDeleteMessage(existing, user.id, {
      isChannelAdmin: isChannelAdmin(channel, user.id),
      isSystemAdmin: user.role === 'admin',
      // A bot message has no human author — any write-level user may clean it
      // up (viewer members keep read-only).
      writeLevel: level === 'write',
    });
    if (!allowed) {
      return res.status(403).json({ error: 'Only the author, a channel admin, or a system admin can delete this message' });
    }
    const result = await deleteMessage(cid, msgId);
    if (!result) return res.status(404).json({ error: 'Message not found' });
    broadcastMessageDeleted(cid, msgId);
    res.json({ ok: true });
  });

  // Mark read (any access level that can see the channel).
  r.post('/channels/:channelId/read', chatWriteLimiter, async (req: any, res) => {
    const cid = req.params.channelId;
    if (!isChannelId(cid)) return res.status(400).json({ error: 'Invalid channel id' });
    const user: ChatUser = { id: req.user.id, username: req.user.username, role: req.user.role };
    const channel = getChannel(cid);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    if (canAccessChannel(user, channel) === 'none') return res.status(403).json({ error: 'Access denied' });
    const msgId = typeof req.body?.msgId === 'string' ? req.body.msgId : '';
    if (!isMessageId(msgId)) return res.status(400).json({ error: 'Invalid message id' });
    const changed = await markMessagesAsRead(cid, user.id, msgId);
    if (changed === null) return res.status(404).json({ error: 'Message not found' });
    res.json({ ok: true });
  });

  // ── Attachments ──────────────────────────────────────────────
  // The route is scoped to a channel so access is checked before the bytes are
  // persisted (multer already buffered them in memory; nothing touches disk
  // until saveAttachment runs, so every refusal below is orphan-free).
  r.post('/upload', chatWriteLimiter, chatUploadSingle, async (req: any, res) => {
    const user: ChatUser = { id: req.user.id, username: req.user.username, role: req.user.role };
    const channelId = typeof req.body?.channelId === 'string' ? req.body.channelId : '';
    if (!isChannelId(channelId)) return res.status(400).json({ error: 'Invalid channel id' });
    const channel = getChannel(channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    if (canAccessChannel(user, channel) !== 'write') {
      return res.status(403).json({ error: 'Write access required to upload' });
    }
    if (!canSendInChannel(user, channel, 'write')) {
      return res.status(403).json({ error: 'Only admins can send in this channel' });
    }
    if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
      return res.status(400).json({ error: 'No file provided' });
    }
    const buf = req.file.buffer;
    if (buf.length > MAX_ATTACHMENT_BYTES) {
      return res.status(400).json({ error: 'File too large (max 10 MB)' });
    }
    // Bytes decide the kind (never the extension or a client claim). SVG/HTML/
    // HEIC/TIFF stay 'file' on purpose — see chat-attachment-kind.ts.
    const kind = detectAttachmentKind(buf);
    const name = sanitizeAttachmentName(req.file.originalname, 'file');
    const saved = await saveAttachment(buf, channelId, user.id, { name, kind });
    if (saved === 'channel-not-found') return res.status(404).json({ error: 'Channel not found' });
    if (saved === 'quota') {
      return res.status(400).json({ error: 'Channel attachment storage limit exceeded (500 MB)' });
    }
    const { id, size } = saved;
    res.status(201).json({ attachment: { id, name, kind, size } });
  });

  // Serve attachment bytes — authenticated (a token is never embedded in URLs).
  r.get('/uploads/:attachmentId', (req: any, res) => {
    const attachmentId = req.params.attachmentId;
    if (!/^att-[a-z0-9-]+$/.test(attachmentId)) return res.status(404).json({ error: 'Not found' });
    const p = attachmentPath(attachmentId);
    if (!p) return res.status(404).json({ error: 'Not found' });
    const user: ChatUser = { id: req.user.id, username: req.user.username, role: req.user.role };
    const meta = getAttachmentMeta(attachmentId);
    if (!meta) return res.status(404).json({ error: 'Not found' });
    const channel = getChannel(meta.channelId);
    if (!channel || canAccessChannel(user, channel) === 'none') {
      return res.status(403).json({ error: 'Access denied' });
    }
    // Re-derive type and name from the stored bytes rather than trusting the
    // meta record: only a real raster image is served `image/*` + inline, so
    // an uploaded SVG/HTML can never execute as markup on our own origin.
    const facts = detectAttachmentFacts(attachmentHead(attachmentId, ATTACHMENT_HEAD_BYTES));
    res.setHeader('Content-Type', facts.mime);
    res.setHeader(
      'Content-Disposition',
      contentDispositionHeader(attachmentFileName(meta.name, facts), facts.kind)
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(p);
  });

  // Presence: current online team-chat users (read-only introspection).
  r.get('/presence', (_req: any, res) => {
    res.json({ users: getChatTeamPresence() });
  });
}