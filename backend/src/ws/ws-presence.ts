/**
 * ws-presence.ts
 * Madar — Real-time presence tracking per project.
 * Broadcasts the list of online users to all connected clients in a project room.
 * Protocol (server → client, JSON):
 *   { type: "presence", users: [{ id, username, role, displayName?, avatarExt? }] }
 */
import { WebSocket } from 'ws';
import { verifyToken, getUserInfo } from '../services/user-store';

interface PresenceUser {
  id: string;
  username: string;
  role: string;
  displayName?: string;
  avatarExt?: string;
}

/** slug → userId → { ws, user } */
const rooms = new Map<string, Map<string, { ws: WebSocket; user: PresenceUser }>>();

/** userId → slug (reverse lookup for cleanup) */
const userRooms = new Map<string, string>();

function broadcast(slug: string): void {
  const room = rooms.get(slug);
  if (!room) return;
  const users: PresenceUser[] = [];
  for (const entry of room.values()) {
    users.push(entry.user);
  }
  const payload = JSON.stringify({ type: 'presence', users });
  for (const entry of room.values()) {
    if (entry.ws.readyState === WebSocket.OPEN) {
      entry.ws.send(payload);
    }
  }
}

function removeUser(slug: string, userId: string): void {
  const room = rooms.get(slug);
  if (room) {
    room.delete(userId);
    if (room.size === 0) rooms.delete(slug);
  }
  userRooms.delete(userId);
}

export function handlePresenceSocket(
  ws: WebSocket,
  slug: string,
  token: string,
  onRelease: () => void
): void {
  let closed = false;

  const decoded = verifyToken(token);
  if (!decoded) {
    ws.close(1008, 'invalid token');
    onRelease();
    return;
  }

  const profile = getUserInfo(decoded.id);
  const user: PresenceUser = {
    id: decoded.id,
    username: decoded.username,
    role: decoded.role,
    displayName: profile?.profile?.displayName,
    avatarExt: profile?.profile?.avatarExt,
  };

  // If user already connected from another tab/connection, remove old entry
  const prevSlug = userRooms.get(user.id);
  if (prevSlug) {
    removeUser(prevSlug, user.id);
    broadcast(prevSlug);
  }

  // Add to room
  if (!rooms.has(slug)) rooms.set(slug, new Map());
  rooms.get(slug)!.set(user.id, { ws, user });
  userRooms.set(user.id, slug);

  // Send current presence list to the new connection (include self)
  const existingUsers: PresenceUser[] = [];
  for (const entry of rooms.get(slug)!.values()) {
    if (entry.user.id !== user.id) {
      existingUsers.push(entry.user);
    }
  }
  existingUsers.push(user);
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'presence', users: existingUsers }));
  }

  // Broadcast updated list to everyone else
  broadcast(slug);

  const cleanup = () => {
    if (closed) return;
    closed = true;
    removeUser(slug, user.id);
    broadcast(slug);
    if (ws.readyState === WebSocket.OPEN) ws.close();
    onRelease();
  };

  ws.on('close', cleanup);
  ws.on('error', cleanup);
}

/** Get current online users for a project (used by API or tests). */
export function getPresence(slug: string): PresenceUser[] {
  const room = rooms.get(slug);
  if (!room) return [];
  return Array.from(room.values()).map(e => e.user);
}
