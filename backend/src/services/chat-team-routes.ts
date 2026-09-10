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

import {
  listUsers,
} from './user-store';
import { checkUserWrite } from './user-write-limiter';
import {
  isChannelId,
  isMessageId,
  normalizeMessage,
  formatMessage,
  searchMessages,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  type ChannelMember,
  type ChatAttachment,
  type TeamChannel,
  type TeamMessage,
} from './chat-team-core';
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
  setReadPosition,
  getUnreadByChannel,
  saveAttachment,
  attachmentPath,
  genId,
} from './chat-team-store';
import { canAccessChannel, type ChatUser } from './chat-team-access';
import { detectImageExt } from './avatar-store';
import { broadcastChatMessage, broadcastPinChange, getChatTeamPresence } from '../ws/ws-chat-team';

const chatUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 1 },
});

/**
 * Per-user write budget for chat sends/uploads — chat is bursty, so give real
 * conversations headroom (240/min) while still capping runaway/agent loops.
 */
function chatWriteLimiter(req: any, res: any, next: any): void {
  const retryAfter = checkUserWrite(req?.user?.id, req?.ip, 60_000, 240);
  if (retryAfter > 0) {
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'Too many chat requests. Try again later.' });
  }
  next();
}

type SafeUserRow = { id: string; username: string; displayName?: string; avatarExt?: string };

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
    .map((c) => enrichChannel(c, idx, user));
}

function enrichChannel(c: TeamChannel, idx: Map<string, SafeUserRow>, user: ChatUser): TeamChannel {
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
  return { ...c, members } as TeamChannel;
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
      channels: channels.map((c) => ({
        ...c,
        unread: unread[c.id]?.count || 0,
        firstUnreadId: unread[c.id]?.firstUnreadId,
      })),
    });
  });

  // Create a manual team-wide channel (editor+).
  r.post('/channels', chatWriteLimiter, (req: any, res) => {
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
    const channel: TeamChannel = {
      id: genId('ch'),
      kind: 'channel',
      name,
      members: [],
      createdBy: user.id,
      createdAt: new Date().toISOString(),
    };
    void createChannel(channel).then(({ created, channel: ch }) => {
      if (!created) return res.status(409).json({ error: 'Channel already exists' });
      res.status(201).json({ channel: ch });
    });
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
    if (canAccessChannel(user, channel) === 'none') {
      return res.status(403).json({ error: 'Access denied' });
    }
    const idx = userIndex();
    res.json({ channel: enrichChannel(channel, idx, user) });
  });

  // Delete a manual channel (creator or admin; editor+ level overall).
  r.delete('/channels/:channelId', chatWriteLimiter, async (req: any, res) => {
    const cid = req.params.channelId;
    if (!isChannelId(cid)) return res.status(400).json({ error: 'Invalid channel id' });
    const user: ChatUser = { id: req.user.id, username: req.user.username, role: req.user.role };
    const channel = getChannel(cid);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    if (channel.kind !== 'channel') return res.status(400).json({ error: 'Only manual channels can be deleted' });
    const isCreator = channel.createdBy === user.id;
    if (user.role !== 'admin' && !(user.role === 'editor' && isCreator)) {
      return res.status(403).json({ error: 'Only the creator or an admin can delete this channel' });
    }
    await deleteChannel(cid);
    res.json({ ok: true });
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
    if (canAccessChannel(user, getChannel(cid) as TeamChannel) === 'none') {
      return res.status(403).json({ error: 'Access denied' });
    }
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    if (!q) return res.json({ messages: [] });
    res.json({ messages: searchMessages(getAllMessages(cid), q).slice(-50) });
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

    const normalized = normalizeMessage(req.body);
    if (!normalized) return res.status(400).json({ error: 'Message is required (max 5000 chars)' });

    // Reply target must actually exist in THIS channel.
    let replyToExists = false;
    if (normalized.replyTo) {
      replyToExists = getAllMessages(channelId).some((m) => m.id === normalized.replyTo);
      if (!replyToExists) return res.status(400).json({ error: 'Reply target not found' });
    }

    // Attachments are pre-uploaded ids the client attaches by reference.
    let attachments: ChatAttachment[] | undefined;
    const rawAtt = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
    if (rawAtt.length > 0) {
      if (rawAtt.length > MAX_ATTACHMENTS) return res.status(400).json({ error: 'Too many attachments' });
      let total = 0;
      const out: ChatAttachment[] = [];
      for (const a of rawAtt) {
        const id = typeof a?.id === 'string' ? a.id : '';
        if (!/^att-[a-z0-9-]+$/.test(id)) return res.status(400).json({ error: 'Invalid attachment' });
        const path = attachmentPath(id);
        if (!path) return res.status(400).json({ error: 'Attachment not found' });
        let size = 0;
        try {
          size = fs.statSync(path).size;
        } catch {
          return res.status(400).json({ error: 'Attachment not found' });
        }
        total += size;
        if (total > MAX_ATTACHMENT_BYTES) return res.status(400).json({ error: 'Attachments too large' });
        const name = typeof a?.name === 'string' ? a.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255) : 'file';
        // Kind is re-derived from the stored bytes (client-claimed kind is
        // never trusted) — a re-uploaded fake won't be labeled an image.
        let kind: 'image' | 'file' = 'file';
        try {
          kind = detectImageExt(fs.readFileSync(path)) ? 'image' : 'file';
        } catch {
          return res.status(400).json({ error: 'Attachment not found' });
        }
        out.push({ id, name: name || 'file', kind, size });
      }
      attachments = out;
    }

    const message: TeamMessage = formatMessage(
      genId('m'),
      user.id,
      user.username,
      normalized,
      { replyToExists, attachments }
    );

    await appendMessage(channelId, message);
    const freshChannel = getChannel(channelId) || channel;
    broadcastChatMessage(freshChannel, message);
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
    const pinned = req.body?.pinned === true;
    const updated = await pinUnpinMessage(cid, msgId, pinned);
    if (!updated) return res.status(404).json({ error: 'Message not found' });
    broadcastPinChange(cid, msgId, pinned);
    res.json({ message: updated });
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
    await setReadPosition(cid, user.id, msgId);
    res.json({ ok: true });
  });

  // ── Attachments ──────────────────────────────────────────────
  // Upload is scoped to a channel so access is checked before bytes land.
  r.post('/upload', chatWriteLimiter, chatUpload.single('file'), (req: any, res) => {
    const user: ChatUser = { id: req.user.id, username: req.user.username, role: req.user.role };
    const channelId = typeof req.body?.channelId === 'string' ? req.body.channelId : '';
    if (!isChannelId(channelId)) return res.status(400).json({ error: 'Invalid channel id' });
    const channel = getChannel(channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    if (canAccessChannel(user, channel) !== 'write') {
      return res.status(403).json({ error: 'Write access required to upload' });
    }
    if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
      return res.status(400).json({ error: 'No file provided' });
    }
    const buf = req.file.buffer;
    if (buf.length > MAX_ATTACHMENT_BYTES) {
      return res.status(400).json({ error: 'File too large (max 10 MB)' });
    }
    const kind = detectImageExt(buf) ? 'image' : 'file';
    const { id, size } = saveAttachment(buf);
    const name = String(req.file.originalname || 'file').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255) || 'file';
    res.status(201).json({ attachment: { id, name, kind, size } });
  });

  // Serve attachment bytes — authenticated (a token is never embedded in URLs).
  r.get('/uploads/:attachmentId', (req: any, res) => {
    const attachmentId = req.params.attachmentId;
    if (!/^att-[a-z0-9-]+$/.test(attachmentId)) return res.status(404).json({ error: 'Not found' });
    const p = attachmentPath(attachmentId);
    if (!p) return res.status(404).json({ error: 'Not found' });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(p);
  });

  // Presence: current online team-chat users (read-only introspection).
  r.get('/presence', (_req: any, res) => {
    res.json({ users: getChatTeamPresence() });
  });
}