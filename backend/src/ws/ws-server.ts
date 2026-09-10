/**
 * ws-server.ts
 * Madar — WebSocket hub.
 * Manual upgrade routing (noServer) so nested paths work:
 *   /ws/chat/:slug/:chatId  → chatbot scoped to a project (slug = project or 'global')
 *   /ws/chat/:chatId        → legacy alias for slug = 'global'
 * Auth: JWT token via ?token= query param on upgrade.
 */
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { handleChatSocket } from './ws-chat';
import { handleTerminalSocket } from './ws-terminal';
import { handleProjectLogsSocket } from './ws-project-logs';
import { handleAgentSocket } from './ws-agent';
import { handleProjectStatusSocket, shutdownProjectStatusBroadcasters } from './ws-project-status';
import { handleProjectsStatusSocket, shutdownProjectsStatusBroadcaster } from './ws-projects-status';
import { handlePresenceSocket } from './ws-presence';
import { handleChatTeamSocket } from './ws-chat-team';
import { verifyToken } from '../services/user-store';

/** Interactive rooms (chat/terminal/logs/agent/presence) stay at 8. */
const MAX_CONNECTIONS_PER_ROOM = 8;
/** Status broadcast rooms may have many viewers — no interactive state. */
const STATUS_ROOM_MAX = 200;
const roomConnections = new Map<string, number>();
const PING_INTERVAL_MS = 30_000;

function isSafeChatId(value: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}$/.test(value);
}

export function attachWebSockets(server: http.Server): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 5 * 1024 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (!url.pathname.startsWith('/ws/')) {
      socket.destroy();
      return;
    }
    const token = url.searchParams.get('token');
    if (!token || !verifyToken(token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws: WebSocket, req) => {
    (ws as any)._isAlive = true;
    ws.on('pong', () => { (ws as any)._isAlive = true; });

    const url = new URL(req.url || '/', 'http://localhost');
    const token = url.searchParams.get('token') || '';
    const authUser = token ? verifyToken(token) : null;

    const chatMatch = url.pathname.match(/^\/ws\/chat\/([^/]+)\/([^/]+)$/);
    if (chatMatch) {
      const slug = decodeURIComponent(chatMatch[1]);
      const chatId = decodeURIComponent(chatMatch[2]);
      if (!isSafeChatId(slug) || !isSafeChatId(chatId)) {
        ws.close(1008, 'invalid chat id');
        return;
      }
      const room = `chat:${slug}:${chatId}`;
      if (!acquireRoom(room)) {
        ws.close(1013, 'too many connections for chat');
        return;
      }
      handleChatSocket(ws, slug, chatId, authUser, releaseRoom(room));
      return;
    }

    const termMatch = url.pathname.match(/^\/ws\/projects\/([^/]+)\/terminal$/);
    if (termMatch) {
      const slug = decodeURIComponent(termMatch[1]);
      if (!isSafeChatId(slug)) {
        ws.close(1008, 'invalid slug');
        return;
      }
      const mode = url.searchParams.get('mode') === 'control' ? 'control' : 'project';
      const room = `term:${slug}:${mode}`;
      if (!acquireRoom(room)) {
        ws.close(1013, 'too many connections for terminal');
        return;
      }
      handleTerminalSocket(ws, slug, mode, releaseRoom(room));
      return;
    }

    const logsMatch = url.pathname.match(/^\/ws\/projects\/([^/]+)\/logs$/);
    if (logsMatch) {
      const slug = decodeURIComponent(logsMatch[1]);
      if (!isSafeChatId(slug)) {
        ws.close(1008, 'invalid slug');
        return;
      }
      const room = `logs:${slug}`;
      if (!acquireRoom(room)) {
        ws.close(1013, 'too many connections for logs');
        return;
      }
      handleProjectLogsSocket(ws, slug, releaseRoom(room));
      return;
    }

    const projectsStatusMatch = url.pathname.match(/^\/ws\/projects\/status$/);
    if (projectsStatusMatch) {
      const room = 'projects:status';
      if (!acquireRoom(room, STATUS_ROOM_MAX)) {
        ws.close(1013, 'too many connections for projects status');
        return;
      }
      handleProjectsStatusSocket(ws, releaseRoom(room));
      return;
    }

    const statusMatch = url.pathname.match(/^\/ws\/projects\/([^/]+)\/status$/);
    if (statusMatch) {
      const slug = decodeURIComponent(statusMatch[1]);
      if (!isSafeChatId(slug)) {
        ws.close(1008, 'invalid slug');
        return;
      }
      const room = `status:${slug}`;
      if (!acquireRoom(room, STATUS_ROOM_MAX)) {
        ws.close(1013, 'too many connections for status');
        return;
      }
      handleProjectStatusSocket(ws, slug, releaseRoom(room));
      return;
    }

    const legacyChatMatch = url.pathname.match(/^\/ws\/chat\/([^/]+)$/);
    if (legacyChatMatch) {
      const chatId = decodeURIComponent(legacyChatMatch[1]);
      if (!isSafeChatId(chatId)) {
        ws.close(1008, 'invalid chat id');
        return;
      }
      const room = `chat:global:${chatId}`;
      if (!acquireRoom(room)) {
        ws.close(1013, 'too many connections for chat');
        return;
      }
      handleChatSocket(ws, 'global', chatId, authUser, releaseRoom(room));
      return;
    }

    const agentMatch = url.pathname.match(/^\/ws\/agent\/([^/]+)\/([^/]+)$/);
    if (agentMatch) {
      const agentId = decodeURIComponent(agentMatch[1]);
      const chatId = decodeURIComponent(agentMatch[2]);
      if (!isSafeChatId(agentId) || !isSafeChatId(chatId)) {
        ws.close(1008, 'invalid agent id');
        return;
      }
      const room = `agent:${agentId}:${chatId}`;
      if (!acquireRoom(room)) {
        ws.close(1013, 'too many connections for agent');
        return;
      }
      handleAgentSocket(ws, agentId, chatId, authUser, releaseRoom(room));
      return;
    }

    const presenceMatch = url.pathname.match(/^\/ws\/presence\/([^/]+)$/);
    if (presenceMatch) {
      const slug = decodeURIComponent(presenceMatch[1]);
      if (!isSafeChatId(slug)) {
        ws.close(1008, 'invalid slug');
        return;
      }
      const room = `presence:${slug}`;
      if (!acquireRoom(room)) {
        ws.close(1013, 'too many connections for presence');
        return;
      }
      handlePresenceSocket(ws, slug, token, releaseRoom(room));
      return;
    }

    const chatTeamMatch = url.pathname.match(/^\/ws\/chat-team$/);
    if (chatTeamMatch) {
      if (!authUser) {
        ws.close(1008, 'invalid token');
        return;
      }
      const room = 'chat-team:global';
      if (!acquireRoom(room, 200)) {
        ws.close(1013, 'too many connections for team chat');
        return;
      }
      handleChatTeamSocket(ws, authUser, releaseRoom(room));
      return;
    }

    ws.close(4004, 'unknown socket path');
  });

  wss.on('error', (err) => {
    console.error('[Madar] WebSocket server error:', err.message);
  });

  const pingTimer = setInterval(() => {
    wss.clients.forEach((ws) => {
      if ((ws as any)._isAlive === false) return ws.terminate();
      (ws as any)._isAlive = false;
      ws.ping();
    });
  }, PING_INTERVAL_MS);
  wss.on('close', () => clearInterval(pingTimer));
}

function acquireRoom(room: string, max = MAX_CONNECTIONS_PER_ROOM): boolean {
  const count = roomConnections.get(room) || 0;
  if (count >= max) return false;
  roomConnections.set(room, count + 1);
  return true;
}

function releaseRoom(room: string): () => void {
  return () => {
    const current = roomConnections.get(room) || 1;
    if (current <= 1) roomConnections.delete(room);
    else roomConnections.set(room, current - 1);
  };
}

/** Clear all broadcaster timers and close their sockets — call on shutdown. */
export function shutdownWebSocketBroadcasters(): void {
  shutdownProjectStatusBroadcasters();
  shutdownProjectsStatusBroadcaster();
}
