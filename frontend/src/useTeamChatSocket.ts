/**
 * useTeamChatSocket.ts
 * Madar — Live team-chat WebSocket hook (view-level convenience).
 * One socket, subscribes to the active channel(s); delivers live messages,
 * typing, read, pin and presence frames. Message SENDING is REST-only
 * (the server's one authoritative write path) — this hook only consumes.
 */
import { useEffect, useRef, useCallback, useState } from 'preact/hooks';
import { wsUrl } from './api';
import type { ChatChannel, TeamChatMessage } from './api';

export type ChatSocketEvent =
  | { type: 'message'; channel: ChatChannel; message: TeamChatMessage }
  | { type: 'typing'; channelId: string; user: { id: string; username: string } }
  | { type: 'typing_stop'; channelId: string; user: { id: string; username: string } }
  | { type: 'read'; channelId: string; userId: string; msgId: string }
  | { type: 'pin'; channelId: string; msgId: string; pinned: boolean }
  | { type: 'presence'; users: { id: string; username: string; role: string; displayName?: string; avatarExt?: 'png' | 'jpg' | 'webp' }[] }
  | { type: 'subscribed'; channelId: string; messages: TeamChatMessage[]; level: 'read' | 'write' }
  | { type: 'status_update'; messageId: string; newStatus: TeamChatMessage['status'] };

export interface TeamChatSocket {
  /** Subscribe a channel (fetch its recent history through the socket). */
  subscribe: (channelId: string) => void;
  unsubscribe: (channelId: string) => void;
  /** Signal typing in the active channel (server debounces). */
  sendTyping: (channelId: string) => void;
  /** Report read position for a channel (drives unread badges elsewhere). */
  sendRead: (channelId: string, msgId: string) => void;
  /** True when the socket is connected (or reconnecting). */
  connected: boolean;
}

/**
 * Live event + subscription hook for team chat. Events are pushed through a
 * single callback so the view can decide what to do (blend into its messages
 * list, update a typing row, etc.).
 */
export function useTeamChatSocket(onEvent: (ev: ChatSocketEvent) => void): TeamChatSocket {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const subscribed = useRef<Set<string>>(new Set());
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const send = useCallback((obj: unknown) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }, []);

  const resubscribe = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    for (const channelId of subscribed.current) {
      ws.send(JSON.stringify({ type: 'subscribe', channelId }));
    }
  }, []);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let alive = true;

    const connect = () => {
      if (!alive) return;
      try {
        ws = new WebSocket(wsUrl('/ws/chat-team'));
      } catch {
        reconnectTimer = setTimeout(connect, 3000);
        return;
      }
      wsRef.current = ws;

      ws.onopen = () => {
        if (!alive) return;
        setConnected(true);
        resubscribe();
      };

      ws.onmessage = (ev) => {
        let msg: any;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        switch (msg.type) {
          case 'subscribed':
            onEventRef.current({ type: 'subscribed', channelId: msg.channelId, messages: msg.messages ?? [], level: msg.level });
            break;
          case 'message':
            onEventRef.current({ type: 'message', channel: msg.channel, message: msg.message });
            break;
          case 'typing_start':
            onEventRef.current({ type: 'typing', channelId: msg.channelId, user: msg.user });
            break;
          case 'typing_stop':
            onEventRef.current({ type: 'typing_stop', channelId: msg.channelId, user: msg.user });
            break;
          case 'read':
            onEventRef.current({ type: 'read', channelId: msg.channelId, userId: msg.userId, msgId: msg.msgId });
            break;
          case 'pin':
            onEventRef.current({ type: 'pin', channelId: msg.channelId, msgId: msg.msgId, pinned: msg.pinned });
            break;
          case 'presence':
            onEventRef.current({ type: 'presence', users: msg.users ?? [] });
            break;
          case 'status_update':
            for (const u of (msg.updates ?? [])) {
              onEventRef.current({ type: 'status_update', messageId: u.id, newStatus: u.status });
            }
            break;
          default:
            break;
        }
      };

      ws.onclose = () => {
        if (!alive) return;
        setConnected(false);
        reconnectTimer = setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        ws?.close();
      };
    };

    connect();

    return () => {
      alive = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) {
        ws.onclose = null;
        ws.onerror = null;
        ws.close();
      }
      wsRef.current = null;
      subscribed.current.clear();
    };
  }, [resubscribe]);

  const subscribe = useCallback(
    (channelId: string) => {
      subscribed.current.add(channelId);
      send({ type: 'subscribe', channelId });
    },
    [send]
  );

  const unsubscribe = useCallback(
    (channelId: string) => {
      subscribed.current.delete(channelId);
      send({ type: 'unsubscribe', channelId });
    },
    [send]
  );

  const sendTyping = useCallback(
    (channelId: string) => {
      send({ type: 'typing_start', channelId });
    },
    [send]
  );

  const sendRead = useCallback(
    (channelId: string, msgId: string) => {
      send({ type: 'read', channelId, msgId });
    },
    [send]
  );

  return { subscribe, unsubscribe, sendTyping, sendRead, connected };
}