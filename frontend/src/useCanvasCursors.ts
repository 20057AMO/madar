/**
 * useCanvasCursors.ts
 * Madar — Live collaborator presence + cursors for the planning canvas.
 *
 * One socket per open board: the canvas room (/ws/projects/:slug/canvas).
 * Inbound it carries the presence roster ({ type:'canvas-roster', users }),
 * peer cursor frames ({ type:'cursor', by, x, y }) and the sync frames
 * ({ type:'canvas-ops' | 'canvas-updated' }) which are forwarded to the
 * board's handlers. Outbound we only ever send throttled world-coordinate
 * cursor frames — the server drops everything else.
 *
 * Returns the (deduped) online peers plus a per-user latest cursor map, and
 * a throttled sendCursor(x, y) in world coordinates.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { wsUrl } from './api';

export interface CanvasPeer {
  id: string;
  username: string;
  displayName?: string;
  avatarExt?: string;
}

export interface PeerCursor {
  x: number;
  y: number;
  /** Bumped on every move so the CSS ping animation can re-trigger. */
  n: number;
  /** Internal: last-heard timestamp for stale-cursor pruning. */
  at: number;
}

/** Render-ready cursor: merged with the roster for name + stable color. */
export interface PeerCursorView {
  id: string;
  name: string;
  color: string;
  x: number;
  y: number;
}

/** Distinct, high-contrast pointer colors — assignment is stable per user id. */
const PEER_COLORS = [
  '#f97316', '#0ea5e9', '#22c55e', '#a855f7',
  '#ef4444', '#eab308', '#14b8a6', '#ec4899',
];

export function peerColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return PEER_COLORS[Math.abs(h) % PEER_COLORS.length];
}

/** Own JWT user id — used to keep SELF out of the peer maps. */
function jwtUserId(token: string | null): string {
  if (!token) return '';
  try {
    const b64 = (token.split('.')[1] || '').replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(b64));
    return typeof payload?.id === 'string' ? payload.id : '';
  } catch {
    return '';
  }
}

const CURSOR_SEND_INTERVAL_MS = 50;
const CURSOR_STALE_MS = 12_000;

export function useCanvasCursors(
  slug: string,
  handlers: {
    onOps?: (ops: any[], by?: string) => void;
    onNudge?: (info: { updatedAt?: string | null; nodes?: number; edges?: number }) => void;
  }
): { peers: CanvasPeer[]; cursors: PeerCursorView[]; sendCursor: (x: number, y: number) => void } {
  const [peers, setPeers] = useState<CanvasPeer[]>([]);
  const [cursors, setCursors] = useState<PeerCursorView[]>([]);

  // Handlers are read through a ref so callers can pass inline closures
  // without re-running the socket effect on every render.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const wsRef = useRef<WebSocket | null>(null);
  const lastSentRef = useRef(0);

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: number | null = null;
    let pruneTimer: number | null = null;

    const cursorsRef = new Map<string, PeerCursor>();
    /** Latest roster (id → peer) so cursors can carry name + identity. */
    const rosterRef = new Map<string, CanvasPeer>();
    const publishCursors = () => {
      const next: PeerCursorView[] = [];
      for (const [id, c] of cursorsRef) {
        const p = rosterRef.get(id);
        next.push({
          id,
          name: p?.displayName || p?.username || '?',
          color: peerColor(id),
          x: c.x,
          y: c.y,
        });
      }
      setCursors(next);
    };

    // Drop cursors of peers that stopped moving / disconnected (the roster
    // removal covers clean exits; this covers tab-kill mid-move).
    pruneTimer = window.setInterval(() => {
      let changed = false;
      const now = Date.now();
      for (const [id, c] of cursorsRef) {
        if (now - c.at > CURSOR_STALE_MS) {
          cursorsRef.delete(id);
          changed = true;
        }
      }
      if (changed) publishCursors();
    }, 5000);

    const connect = () => {
      if (disposed) return;
      try {
        wsRef.current = new WebSocket(wsUrl(`/ws/projects/${encodeURIComponent(slug)}/canvas`));
      } catch {
        reconnectTimer = window.setTimeout(connect, 3000);
        return;
      }
      const ws = wsRef.current;
      ws.onmessage = (ev: any) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg?.type === 'canvas-roster' && Array.isArray(msg.users)) {
            const self = jwtUserId(localStorage.getItem('wsd.token'));
            const users: CanvasPeer[] = msg.users.filter((u: CanvasPeer) => u && u.id && u.id !== self);
            setPeers(users);
            rosterRef.clear();
            for (const u of users) rosterRef.set(u.id, u);
            // A departed peer's frozen cursor must go with them.
            const ids = new Set(users.map((u) => u.id));
            let pruned = false;
            for (const id of [...cursorsRef.keys()]) {
              if (!ids.has(id)) { cursorsRef.delete(id); pruned = true; }
            }
            if (pruned) publishCursors();
            return;
          }
          if (msg?.type === 'cursor' && typeof msg.by === 'string' && Number.isFinite(msg.x) && Number.isFinite(msg.y)) {
            const prev = cursorsRef.get(msg.by);
            cursorsRef.set(msg.by, { x: msg.x, y: msg.y, n: (prev?.n ?? 0) + 1, at: Date.now() });
            publishCursors();
            return;
          }
          if (msg?.type === 'canvas-ops' && Array.isArray(msg.ops)) {
            handlersRef.current.onOps?.(msg.ops, msg.by);
            return;
          }
          if (msg?.type === 'canvas-updated') {
            handlersRef.current.onNudge?.({ updatedAt: msg.updatedAt, nodes: msg.nodes, edges: msg.edges });
          }
        } catch { /* ignore malformed */ }
      };
      ws.onclose = () => {
        wsRef.current = null;
        if (!disposed) reconnectTimer = window.setTimeout(connect, 3000);
      };
      ws.onerror = () => {
        try { ws?.close(); } catch { /* noop */ }
      };
    };

    connect();

    return () => {
      disposed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      if (pruneTimer !== null) window.clearInterval(pruneTimer);
      const ws = wsRef.current;
      if (ws) {
        ws.onclose = null;
        ws.close();
        wsRef.current = null;
      }
      setPeers([]);
      setCursors([]);
    };
  }, [slug]);

  return {
    peers,
    cursors,
    /** Throttled world-coordinate cursor send (no-op until the socket is open). */
    sendCursor: (x: number, y: number) => {
      const now = Date.now();
      if (now - lastSentRef.current < CURSOR_SEND_INTERVAL_MS) return;
      lastSentRef.current = now;
      try { wsRef.current?.send(JSON.stringify({ type: 'cursor', x, y })); } catch { /* noop */ }
    },
  };
}
