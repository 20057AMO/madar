/**
 * ws-chat-team.ts
 * Madar — Live team-chat WebSocket.
 * One connection per client; the client subscribes to any number of channels
 * with `subscribe`/`unsubscribe` frames. Message SENDING happens over REST
 * (rate-limited, validated, one authoritative path) — this socket only pushes
 * the resulting broadcasts, plus typing / read / presence frames.
 *
 * Protocol (client → server, JSON):
 *   { type: "subscribe", channelId }
 *   { type: "unsubscribe", channelId }
 *   { type: "typing", channelId }           → debounced 3s per socket+channel
 *   { type: "read", channelId, msgId }      → mark read position
 *   { type: "presence" }                    → request current online list
 *
 * Protocol (server → client, JSON):
 *   { type: "subscribed", channelId, messages }   → replay (latest ≤100) on join
 *   { type: "message", channel, message }         → live broadcast
 *   { type: "typing", channelId, user }           → typing indicator
 *   { type: "read", channelId, userId, msgId }
 *   { type: "pin", channelId, msgId, pinned }
 *   { type: "unsubscribed", channelId }
 *   { type: "presence", users: PresUser[] }       → online team-chat users
 *   { type: "error", message }
 */
import { WebSocket } from 'ws';
import type { UserRole } from '../services/user-store';
import { getUserInfo } from '../services/user-store';
import {
  getChannel,
  getMessages,
  setReadPosition,
  markMessageAsDelivered,
  markMessagesAsRead,
} from '../services/chat-team-store';
import { canAccessChannel, type ChatUser } from '../services/chat-team-access';
import type { TeamChannel } from '../services/chat-team-core';

const PRESENCE_TYPING_MS = 3000;

interface PresUser {
  id: string;
  username: string;
  role: UserRole;
  displayName?: string;
  avatarExt?: string;
}

type Client = {
  ws: WebSocket;
  user: ChatUser;
  channels: Set<string>;
  typingAt: Map<string, number>;
};

const clients = new Map<WebSocket, Client>();
const channelSubscribers = new Map<string, Set<WebSocket>>();
// Ref-counted presence: one user with N open sockets (tabs) stays listed until
// the LAST socket closes — otherwise tab churn flickers the online roster.
const presence = new Map<string, { entry: PresUser; count: number }>();

function send(ws: WebSocket, obj: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function broadcastToChannel(channelId: string, payload: unknown): void {
  const set = channelSubscribers.get(channelId);
  if (!set) return;
  for (const ws of set) send(ws, payload);
}

/** Push a new chat message to every socket subscribed to the channel. */
export function broadcastChatMessage(channel: TeamChannel, message: unknown): void {
  broadcastToChannel(channel.id, { type: 'message', channel, message });
}

/** Push a pin/unpin change to the channel. */
export function broadcastPinChange(channelId: string, msgId: string, pinned: boolean): void {
  broadcastToChannel(channelId, { type: 'pin', channelId, msgId, pinned });
}

/** Push a pinned message update (change of the channel's primary pinned message). */
export function broadcastPinnedUpdate(channelId: string, pinnedMessageId: string | null): void {
  broadcastToChannel(channelId, { type: 'pinned_update', channelId, pinnedMessageId });
}

function sendPresence(ws: WebSocket): void {
  send(ws, { type: 'presence', users: Array.from(presence.values()).map((v) => v.entry) });
}

function broadcastPresence(): void {
  const payload = { type: 'presence', users: Array.from(presence.values()).map((v) => v.entry) };
  for (const client of clients.values()) send(client.ws, payload);
}

function removeClient(ws: WebSocket, client: Client): void {
  for (const channelId of client.channels) {
    channelSubscribers.get(channelId)?.delete(ws);
    if (!channelSubscribers.get(channelId)?.size) channelSubscribers.delete(channelId);
  }
  const row = presence.get(client.user.id);
  if (row) {
    row.count -= 1;
    if (row.count <= 0) presence.delete(client.user.id);
  }
  clients.delete(ws);
  broadcastPresence();
}

function addPresence(user: ChatUser): PresUser {
  const profile = getUserInfo(user.id);
  const entry: PresUser = {
    id: user.id,
    username: user.username,
    role: user.role,
    displayName: profile?.profile?.displayName,
    avatarExt: profile?.profile?.avatarExt,
  };
  const row = presence.get(user.id);
  if (row) {
    row.count += 1;
    row.entry = entry;
  } else {
    presence.set(user.id, { entry, count: 1 });
  }
  return entry;
}

export function handleChatTeamSocket(
  ws: WebSocket,
  authUser: ChatUser,
  onRelease: () => void
): void {
  let released = false;
  const client: Client = { ws, user: authUser, channels: new Set(), typingAt: new Map() };
  clients.set(ws, client);
  addPresence(authUser);
  // New connection gets the current presence list immediately.
  sendPresence(ws);

  const release = () => {
    if (released) return;
    released = true;
    removeClient(ws, client);
    onRelease();
  };

    ws.on('message', async (data) => {
      let msg: any;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        send(ws, { type: 'error', message: 'Invalid JSON payload' });
        return;
      }


    const channelId = typeof msg.channelId === 'string' ? msg.channelId : '';

    switch (msg.type) {
      case 'subscribe': {
        if (!channelId || !/^[a-z0-9._:-]{1,72}$/.test(channelId)) {
          send(ws, { type: 'error', message: 'Invalid channel id' });
          return;
        }
        const channel = getChannel(channelId);
        if (!channel) {
          send(ws, { type: 'error', message: 'Channel not found' });
          return;
        }
        const level = canAccessChannel(client.user, channel);
        if (level === 'none') {
          send(ws, { type: 'error', message: 'Access denied' });
          return;
        }
        if (!client.channels.has(channelId)) {
          client.channels.add(channelId);
          if (!channelSubscribers.has(channelId)) channelSubscribers.set(channelId, new Set());
          channelSubscribers.get(channelId)!.add(ws);
        }
        send(ws, { type: 'subscribed', channelId, messages: getMessages(channelId, { limit: 100 }), level });
        return;
      }
      case 'unsubscribe': {
        client.channels.delete(channelId);
        channelSubscribers.get(channelId)?.delete(ws);
        if (!channelSubscribers.get(channelId)?.size) channelSubscribers.delete(channelId);
        send(ws, { type: 'unsubscribed', channelId });
        return;
      }
      case 'message_delivered': {
        if (!client.channels.has(channelId)) return;
        if (typeof msg.msgId !== 'string' || !/^m-[a-z0-9-]+$/.test(msg.msgId)) {
          send(ws, { type: 'error', message: 'Invalid message id' });
          return;
        }
        const updated = await markMessageAsDelivered(channelId, msg.msgId);
        if (updated) {
          broadcastToChannel(channelId, {
            type: 'status_update',
            channelId,
            updates: [{ id: updated.id, status: updated.status }],
          });
        }
        return;
      }
      case 'typing_start': {
        if (!client.channels.has(channelId)) return;
        // Debounced 3s per socket+channel: while a user types continuously the
        // client re-sends typing_start on every keypress — broadcast at most
        // once per PRESENCE_TYPING_MS so the channel isn't flooded with frames.
        const now = Date.now();
        if (now - (client.typingAt.get(channelId) || 0) < PRESENCE_TYPING_MS) return;
        client.typingAt.set(channelId, now);
        broadcastToChannel(channelId, {
          type: 'typing_start',
          channelId,
          user: { id: client.user.id, username: client.user.username },
        });
        return;
      }
      case 'typing_stop': {
        if (!client.channels.has(channelId)) return;
        // Broadcast immediately on arrival; clear the throttle so a NEW typing
        // burst starts fresh (only repeats within an ongoing burst are capped).
        client.typingAt.delete(channelId);
        broadcastToChannel(channelId, {
          type: 'typing_stop',
          channelId,
          user: { id: client.user.id, username: client.user.username },
        });
        return;
      }
      case 'read': {
        if (!client.channels.has(channelId)) return;
        if (typeof msg.msgId !== 'string' || !/^m-[a-z0-9-]+$/.test(msg.msgId)) {
          send(ws, { type: 'error', message: 'Invalid message id' });
          return;
        }
        // The anchor must genuinely exist in the channel: markMessagesAsRead
        // returns null (and changes nothing) for a nonexistent msgId — no
        // readBy/status mutation, no read position, no broadcast to the room.
        const changed = await markMessagesAsRead(channelId, client.user.id, msg.msgId);
        if (changed === null) {
          send(ws, { type: 'error', message: 'Message not found' });
          return;
        }
        void setReadPosition(channelId, client.user.id, msg.msgId);
        if (changed.length > 0) {
          broadcastToChannel(channelId, {
            type: 'status_update',
            channelId,
            updates: changed,
          });
        }
        broadcastToChannel(channelId, {
          type: 'read',
          channelId,
          userId: client.user.id,
          msgId: msg.msgId,
        });
        return;
      }
      case 'presence': {
        sendPresence(ws);
        return;
      }
      default:
        send(ws, { type: 'error', message: 'Unknown frame type' });
    }
  });

  ws.on('close', release);
  ws.on('error', release);
}

/** Online team-chat users (for REST introspection/tests). */
export function getChatTeamPresence(): PresUser[] {
  return Array.from(presence.values()).map((v) => v.entry);
}