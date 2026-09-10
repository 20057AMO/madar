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
const presence = new Map<string, PresUser>();

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

function sendPresence(ws: WebSocket): void {
  send(ws, { type: 'presence', users: Array.from(presence.values()) });
}

function broadcastPresence(): void {
  const payload = { type: 'presence', users: Array.from(presence.values()) };
  for (const client of clients.values()) send(client.ws, payload);
}

function removeClient(ws: WebSocket, client: Client): void {
  for (const channelId of client.channels) {
    channelSubscribers.get(channelId)?.delete(ws);
    if (!channelSubscribers.get(channelId)?.size) channelSubscribers.delete(channelId);
  }
  presence.delete(client.user.id);
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
  presence.set(user.id, entry);
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

  ws.on('message', (data) => {
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
      case 'typing': {
        if (!client.channels.has(channelId)) return;
        const last = client.typingAt.get(channelId) || 0;
        const now = Date.now();
        if (now - last < PRESENCE_TYPING_MS) return;
        client.typingAt.set(channelId, now);
        broadcastToChannel(channelId, {
          type: 'typing',
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
        void setReadPosition(channelId, client.user.id, msg.msgId);
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
  return Array.from(presence.values());
}