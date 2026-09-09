/**
 * usePresence.ts
 * Madar — Real-time presence hook for a project room.
 * Returns the list of online users in a project.
 */
import { useState, useEffect, useRef } from 'preact/hooks';
import { wsUrl } from './api';

export interface PresenceUser {
  id: string;
  username: string;
  role: string;
  displayName?: string;
  avatarExt?: 'png' | 'jpg' | 'webp';
}

export function usePresence(slug: string | null): PresenceUser[] {
  const [users, setUsers] = useState<PresenceUser[]>([]);
  const disposed = useRef(false);

  useEffect(() => {
    if (!slug) return;
    disposed.current = false;

    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (disposed.current) return;

      try {
        ws = new WebSocket(wsUrl(`/ws/presence/${encodeURIComponent(slug)}`));
      } catch {
        scheduleReconnect();
        return;
      }

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'presence' && Array.isArray(msg.users)) {
            setUsers(msg.users);
          }
        } catch { /* ignore malformed */ }
      };

      ws.onclose = () => {
        if (!disposed.current) scheduleReconnect();
      };

      ws.onerror = () => {
        ws?.close();
      };
    };

    const scheduleReconnect = () => {
      if (disposed.current) return;
      reconnectTimer = setTimeout(connect, 3000);
    };

    connect();

    return () => {
      disposed.current = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    };
  }, [slug]);

  return users;
}
