/**
 * ws-canvas.ts
 * Madar — Live canvas room per project: differential sync + live cursors.
 *
 * The board document is a full-document PUT (not a CRDT), so the sync
 * contract is deliberately simple:
 *   - Whole-doc writers (agents, imports) nudge the room; clients refetch.
 *   - Differential writers (POST /canvas/ops) broadcast the exact op batch;
 *     remote boards merge it locally without a refetch.
 *   - Every connected client also gets a presence roster and relays throttled
 *     cursor frames, so open boards see each other's pointers live.
 *
 * Frames (server → client, JSON):
 *   { type: 'canvas-roster', users: [{ id, username, displayName?, avatarExt? }] }
 *   { type: 'cursor', by, x, y }                       ← relayed, sender excluded
 *   { type: 'canvas-ops', ops: [...], by, at }
 *   { type: 'canvas-updated', updatedAt, by, nodes, edges }
 *
 * Frames (client → server, JSON):
 *   { type: 'cursor', x, y }   ← world coords, throttled client-side
 */
import { WebSocket } from 'ws';
import { getUserInfo } from '../services/user-store';

interface PeerInfo {
  id: string;
  username: string;
  displayName?: string;
  avatarExt?: string;
}

interface CanvasRoom {
  /** socket → peer (presence roster + cursor routing). */
  peers: Map<WebSocket, PeerInfo>;
}

const rooms = new Map<string, CanvasRoom>();

const WORLD_LIMIT = 100_000;

function sendTo(ws: WebSocket, obj: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
}

/** One roster entry per user id — multi-tab joins collapse to the latest. */
function broadcastRoster(slug: string): void {
  const r = rooms.get(slug);
  if (!r) return;
  const byId = new Map<string, PeerInfo>();
  for (const p of r.peers.values()) byId.set(p.id, p);
  const users = [...byId.values()];
  for (const [ws] of r.peers) sendTo(ws, { type: 'canvas-roster', users });
}

/**
 * Subscribe an (already access-gated) socket to the canvas room: join the
 * roster, relay cursor frames to peers, and broadcast departures.
 * Signature matches the other ws-* handlers so ws-server routing stays uniform.
 */
export function handleCanvasSocket(
  ws: WebSocket,
  slug: string,
  user: { id: string; username: string } | null,
  onRelease: () => void
): void {
  let closed = false;

  if (!user) {
    ws.close(1008, 'invalid token');
    onRelease();
    return;
  }

  // Enrich with the editable profile (display name + avatar) like ws-presence.
  let displayName: string | undefined;
  let avatarExt: string | undefined;
  try {
    const profile = getUserInfo(user.id);
    displayName = profile?.profile?.displayName;
    avatarExt = profile?.profile?.avatarExt;
  } catch { /* presence falls back to the username */ }

  const peer: PeerInfo = { id: user.id, username: user.username, displayName, avatarExt };

  let r = rooms.get(slug);
  if (!r) {
    r = { peers: new Map() };
    rooms.set(slug, r);
  }
  r.peers.set(ws, peer);
  // Full roster to everyone (the newcomer included) — one code path for join.
  broadcastRoster(slug);

  // Client → server: only cursor frames are accepted. Everything else is
  // ignored — the room carries no other client-originated state.
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg?.type === 'cursor' && Number.isFinite(msg.x) && Number.isFinite(msg.y)) {
        const x = Math.max(-WORLD_LIMIT, Math.min(WORLD_LIMIT, msg.x));
        const y = Math.max(-WORLD_LIMIT, Math.min(WORLD_LIMIT, msg.y));
        for (const [other] of r!.peers) {
          if (other !== ws) sendTo(other, { type: 'cursor', by: user.id, x, y });
        }
      }
    } catch { /* ignore malformed */ }
  });

  const cleanup = () => {
    if (closed) return;
    closed = true;
    r!.peers.delete(ws);
    if (r!.peers.size === 0) rooms.delete(slug);
    else broadcastRoster(slug);
    if (ws.readyState === WebSocket.OPEN) ws.close();
    onRelease();
  };

  ws.on('close', cleanup);
  ws.on('error', cleanup);
}

/**
 * Fire-and-forget differential broadcast from POST /canvas/ops: the exact op
 * batch that was applied, so remote boards merge without refetching.
 * Safe on unknown slugs / no subscribers / mid-close sockets.
 */
export function notifyCanvasOps(slug: string, ops: unknown[], by?: string): void {
  const r = rooms.get(slug);
  if (!r || r.peers.size === 0) return;
  const msg = { type: 'canvas-ops', ops, by, at: new Date().toISOString() };
  for (const [ws] of r.peers) sendTo(ws, msg);
}

/**
 * Fire-and-forget broadcast from the canvas PUT route (and any backend writer
 * that wants clients to refetch — agent aggregation, snapshots, imports).
 * Safe on unknown slugs / no subscribers / mid-close sockets.
 */
export function notifyCanvasUpdate(
  slug: string,
  info: { updatedAt: string | null; by?: string; nodes?: number; edges?: number } = { updatedAt: null }
): void {
  const r = rooms.get(slug);
  if (!r || r.peers.size === 0) return;
  // Pass the OBJECT — sendTo stringifies. (Pre-stringifying here would
  // double-encode: clients would parse a quoted string instead of a frame.)
  const msg = { type: 'canvas-updated', ...info };
  for (const [ws] of r.peers) sendTo(ws, msg);
}
