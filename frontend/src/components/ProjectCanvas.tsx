import { useEffect, useRef, useState } from 'preact/hooks';
import {
  Plus,
  StickyNote,
  CheckSquare,
  Link2,
  MousePointer2,
  ZoomIn,
  ZoomOut,
  Maximize,
  Undo2,
  Redo2,
  Trash2,
  Sparkles,
  Lock,
  Copy,
  CopyPlus,
  BringToFront,
  SendToBack,
  Home,
  Rows3,
  ChevronRight,
  ChevronDown,
  ChevronLeft,
  X,
  Pencil,
  ClipboardPaste,
  Maximize2,
  Minimize2,
  ImageDown,
  ClipboardList,
  Globe,
  Search,
  Keyboard,
} from 'lucide-preact';
import {
  getProjectCanvas,
  saveProjectCanvas,
  sendProjectCanvasOps,
  getProjectNotes,
  saveProjectNotes,
  avatarUrl,
} from '../api';
import type { CanvasNode, CanvasColor, ProjectCanvas, CanvasNodeType, CanvasEdge, CanvasSection, NoteItem, CanvasOp } from '../api';
import { useI18n } from '../i18n';
import { ConfirmModal } from './ConfirmModal';
import { useCanvasCursors, peerColor } from '../useCanvasCursors';

/**
 * ProjectCanvas — an infinite pan/zoom whiteboard for planning one project.
 *
 * The document itself is camera-free: nodes live at absolute world
 * coordinates and the client view (pan/zoom) is purely local. Edits mutate a
 * local mirror, autosave debounces ~900ms (with a slow auto-retry when the
 * save fails), and Ctrl+Z/Y walk a snapshot history. Viewers (readOnly) can
 * pan/zoom but not edit.
 *
 * Pro interactions: shift+click multi-select, marquee select, arrow-key
 * nudge, Ctrl+A select-all, Ctrl+S force-save, double-click empty space to
 * create, drag-to-connect with a live rubber line, trackpad pinch zoom and a
 * per-project persisted camera (survives reloads).
 */

const HISTORY_DEPTH = 60;
const MAX_NODES = 200;
const MAX_EDGES = 400;
const MAX_TEXT = 2000;
const MIN_Z = 0.2;
const MAX_Z = 3;
const CANVAS_OPS_BATCH_SIZE = 40;
/** Coarse step for arrow-key nudging (fine = 4px, with Shift = 20px). */
const NUDGE_FINE = 4;
const NUDGE_COARSE = 20;

const COLORS: CanvasColor[] = ['yellow', 'blue', 'red', 'green'];

/** PNG export ink palette (fixed hex — CSS vars can't be read offscreen). */
const EXPORT_COLORS: Record<CanvasColor, string> = {
  yellow: '#3a3122',
  blue: '#1f2b44',
  red: '#42232a',
  green: '#1c3327',
};
/**
 * Measure a text line's real pixel width via canvas — Arabic (and any
 * non-Latin script) has almost no relation between character count and
 * width, so the char-count wrap produced wildly overflowing exports.
 */
let measureCtx: CanvasRenderingContext2D | null = null;
function textWidth(text: string, font: string): number {
  try {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    if (!measureCtx) return text.length * 7.2;
    measureCtx.font = font;
    return measureCtx.measureText(text).width;
  } catch {
    return text.length * 7.2;
  }
}

/** Pixel-width word wrap (accurate for Arabic/RTL and emoji too). */
function wrapExportTextPx(text: string, maxPx: number, font: string): string[] {
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (!paragraph) { out.push(''); continue; }
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && textWidth(candidate, font) > maxPx) { out.push(line); line = word; }
      else line = candidate;
    }
    if (line) out.push(line);
  }
  return out.slice(0, 20);
}

/**
 * Diff two board documents into a minimal op batch (node-patch per changed
 * field, node-add/del, edge-add/del, sec-add/del). Order matters: additions
 * first (so ops that reference new nodes land after they exist), then
 * patches, then removals. Sections are never patched — only add/remove.
 */
function diffDocs(prev: ProjectCanvas, next: ProjectCanvas): CanvasOp[] {
  const ops: CanvasOp[] = [];
  const prevNodes = new Map(prev.nodes.map((n) => [n.id, n]));
  const nextNodes = new Map(next.nodes.map((n) => [n.id, n]));
  const prevSections = new Map((prev.sections ?? []).map((s) => [s.id, s]));
  const nextSections = new Map((next.sections ?? []).map((s) => [s.id, s]));

  for (const s of next.sections ?? []) {
    if (!prevSections.has(s.id)) ops.push({ op: 'sec-add', section: { id: s.id, name: s.name, color: s.color } });
  }
  for (const n of next.nodes) {
    const before = prevNodes.get(n.id);
    if (!before) { ops.push({ op: 'node-add', node: n }); continue; }
    const patch: CanvasOp['patch'] = {};
    if (before.text !== n.text) patch.text = n.text;
    if (before.x !== n.x) patch.x = n.x;
    if (before.y !== n.y) patch.y = n.y;
    if (before.w !== n.w) patch.w = n.w;
    if (before.h !== n.h) patch.h = n.h;
    if (before.color !== n.color) patch.color = n.color;
    if (before.done !== n.done) patch.done = n.done;
    if (before.section !== n.section) patch.section = n.section ?? null;
    if (Object.keys(patch).length) ops.push({ op: 'node-patch', id: n.id, patch });
  }
  for (const e of next.edges) {
    const before = prev.edges.find((x) => x.from === e.from && x.to === e.to);
    if (!before) ops.push({ op: 'edge-add', edge: { id: e.id, from: e.from, to: e.to } });
  }
  for (const e of prev.edges) {
    if (!next.edges.some((x) => x.from === e.from && x.to === e.to)) ops.push({ op: 'edge-del', id: e.id });
  }
  for (const n of prev.nodes) {
    if (!nextNodes.has(n.id)) ops.push({ op: 'node-del', id: n.id });
  }
  for (const s of prev.sections ?? []) {
    if (!nextSections.has(s.id)) ops.push({ op: 'sec-del', id: s.id });
  }
  return ops;
}

/**
 * Merge a remote op batch into the local document. Idempotent semantics
 * mirror the server (node-add on an existing id and unknown-id patches are
 * no-ops), so an echoed or replayed batch never corrupts the board.
 */
function applyRemoteOps(doc: ProjectCanvas, ops: CanvasOp[]): ProjectCanvas {
  let nodes = [...doc.nodes];
  let edges = [...doc.edges];
  let sections = [...(doc.sections ?? [])];
  for (const rawOp of ops) {
    if (!rawOp || typeof rawOp !== 'object') continue;
    switch (rawOp.op) {
      case 'node-add': {
        const n = rawOp.node;
        if (n && !nodes.some((x) => x.id === n.id)) nodes.push(n);
        break;
      }
      case 'node-patch': {
        if (!rawOp.id || !rawOp.patch) break;
        nodes = nodes.map((n) => {
          if (n.id !== rawOp.id) return n;
          const merged: any = { ...n, ...rawOp.patch };
          // `section: null` means "cleared" — the field must disappear, not
          // survive as a null that the renderer/diff would trip on.
          if (merged.section == null) delete merged.section;
          return merged as CanvasNode;
        });
        break;
      }
      case 'node-del': {
        if (!rawOp.id) break;
        nodes = nodes.filter((n) => n.id !== rawOp.id);
        edges = edges.filter((e) => e.from !== rawOp.id && e.to !== rawOp.id);
        break;
      }
      case 'edge-add': {
        const e = rawOp.edge;
        if (e && !edges.some((x) => x.id === e.id) && !edges.some((x) => x.from === e.from && x.to === e.to)) edges.push(e);
        break;
      }
      case 'edge-del': {
        if (!rawOp.id) break;
        edges = edges.filter((e) => e.id !== rawOp.id);
        break;
      }
      case 'sec-add': {
        const s = rawOp.section;
        if (s && !sections.some((x) => x.id === s.id)) sections.push(s);
        break;
      }
      case 'sec-del': {
        if (!rawOp.id) break;
        sections = sections.filter((s) => s.id !== rawOp.id);
        nodes = nodes.map((n) => (n.section === rawOp.id ? { ...n, section: undefined } : n));
        break;
      }
      default:
        break; // unknown op kinds are skipped forward-compatibly
    }
  }
  return { ...doc, nodes, edges, ...(sections.length ? { sections } : {}) };
}

interface ViewState {
  x: number;
  y: number;
  z: number;
}

function freshId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** Current user id from the stored JWT (payload claim) — used to identify
 *  our own op echoes on the live-sync socket. Empty when undecodable. */
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

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Defensive shape for anything parsed out of a system clipboard. */
function sanitizeClipboardPayload(nodes: unknown, edges: unknown): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const clean: CanvasNode[] = [];
  const rawNodes = Array.isArray(nodes) ? nodes.slice(0, MAX_NODES) : [];
  for (const raw of rawNodes) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const type: CanvasNodeType = r.type === 'card' ? 'card' : 'note';
    const num = (v: unknown, dflt: number) => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);
    clean.push({
      id: typeof r.id === 'string' && r.id ? r.id : freshId('n'),
      type,
      text: typeof r.text === 'string' ? r.text.slice(0, MAX_TEXT) : '',
      x: clamp(num(r.x, 0), -100_000, 100_000),
      y: clamp(num(r.y, 0), -100_000, 100_000),
      w: clamp(num(r.w, 220), 60, 900),
      h: clamp(num(r.h, type === 'card' ? 120 : 100), 40, 900),
      color: COLORS.includes(r.color as CanvasColor) ? (r.color as CanvasColor) : 'yellow',
      done: r.done === true,
      ...(typeof r.section === 'string' && /^[a-zA-Z0-9_-]{1,48}$/.test(r.section) ? { section: r.section } : {}),
    });
  }
  const ids = new Set(clean.map((n) => n.id));
  const cleanEdges: CanvasEdge[] = [];
  const rawEdges = Array.isArray(edges) ? edges.slice(0, MAX_EDGES) : [];
  for (const raw of rawEdges) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.from !== 'string' || typeof r.to !== 'string') continue;
    if (!ids.has(r.from) || !ids.has(r.to) || r.from === r.to) continue;
    cleanEdges.push({ id: freshId('e'), from: r.from, to: r.to });
  }
  return { nodes: clean, edges: cleanEdges };
}

export function ProjectCanvas({ slug, readOnly }: { slug: string; readOnly?: boolean }) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null as HTMLDivElement | null);
  const [doc, setDoc] = useState<ProjectCanvas | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'dirty' | 'saving' | 'saved'>('saved');
  const [savedAt, setSavedAt] = useState('');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const fullscreenSavedViewRef = useRef<ViewState | null>(null);
  const fullscreenFitViewRef = useRef<ViewState | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; nodeId?: string; edgeId?: string } | null>(null);
  const [remoteUpdated, setRemoteUpdated] = useState(false);
  const [pushingNotes, setPushingNotes] = useState(false);

  const [selNodes, setSelNodes] = useState<string[]>([]);
  const [selEdge, setSelEdge] = useState<string | null>(null);
  // Primary (first) selected node — most UI reads only the head of the set.
  const selNode = selNodes[0] ?? null;
  const [editing, setEditing] = useState<string | null>(null);
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const [addSectionOpen, setAddSectionOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchIndex, setSearchIndex] = useState(0);
  const [confirmDelSection, setConfirmDelSection] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  /** Cascade counter so rapid adds never stack new nodes on the viewport center. */
  const addSeqRef = useRef(0);

  const [view, setView] = useState<ViewState>({ x: 40, y: 40, z: 1 });
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const docRef = useRef<ProjectCanvas | null>(null);
  const viewRef = useRef<ViewState>(view);
  const slugRef = useRef<string>(slug);
  const saveTimer = useRef<number | null>(null);
  const dirtyRef = useRef(false);
  /** Monotonic id of the last canvas document we saved ourselves — echoes of
   *  our own PUT through the sync room must not trigger a refetch. */
  const lastLocalSaveRef = useRef<{ key: string; at: number } | null>(null);
  /** Debounce timer for remote-change refetches. */
  const remoteFetchTimer = useRef<number | null>(null);
  /** The exact doc snapshot (stringified) our last commit was diffed against.
   *  Never cleared — undo/redo/drag commits re-diff from it, so concurrent
   *  remote ops that only touch OTHER nodes are still carried along. */
  const baseDocRef = useRef<string | null>(null);
  /** Pending ops queue + in-flight flag (serialized POSTs, order preserved). */
  const opsQueueRef = useRef<CanvasOp[]>([]);
  const opsSendingRef = useRef(false);
  const opsRetryTimer = useRef<number | null>(null);
  /** Set while applying a remote batch — suppresses the local diff for it. */
  const applyingRemoteRef = useRef(false);
  /** True while the board view is mounted — guards post-unmount refetches. */
  const syncAliveRef = useRef(false);
  /** Our own user id (JWT claim) — drops self-echoed op batches. */
  const authUserIdRef = useRef<string>('');
  /** Live-sync: true once a server document is available as the differential base.
   *  Kept as a ref (not state) so drag/undo handlers always read the CURRENT
   *  transport instead of a stale closure value. */
  const liveOpsRef = useRef(false);
  const viewSaveTimer = useRef<number | null>(null);
  const histRef = useRef<string[]>([]);
  const redoRef = useRef<string[]>([]);
  /** Pre-edit snapshot so Escape cancels instead of committing. */
  const editPreRef = useRef<{ id: string; text: string } | null>(null);
  /** Typing streams without history spam: one snapshot on the first keystroke. */
  const editHistPushedRef = useRef(false);
  /** Last arrow-nudge timestamp — a burst of nudges collapses into one undo step. */
  const nudgeAtRef = useRef(0);
  /** Live end-point of the connect rubber line (world coords). */
  const connectEndRef = useRef<{ x: number; y: number } | null>(null);
  const pointerFrameRef = useRef<number | null>(null);
  const pendingPointerRef = useRef<{ clientX: number; clientY: number } | null>(null);
  const wheelFrameRef = useRef<number | null>(null);
  const wheelCommitTimerRef = useRef<number | null>(null);
  const pendingWheelRef = useRef<{
    mode: 'pan' | 'zoom';
    deltaX: number;
    deltaY: number;
    clientX: number;
    clientY: number;
    sensitivity: number;
  } | null>(null);
  const dragRef = useRef<null | {
    kind: 'node' | 'pan' | 'resize' | 'marquee';
    ids?: string[];
    elements?: HTMLElement[];
    /** World positions of every dragged node at drag start. */
    startPos?: Record<string, { x: number; y: number }>;
    resize?: { id: string; w: number; h: number; pre: string };
    /** Marquee rubber-band end point (world coords). */
    endX?: number;
    endY?: number;
    cX: number;
    cY: number;
    startX: number;
    startY: number;
    /** Container rect cached ONCE at drag start — per-move getBoundingClientRect
     *  forces layout and desyncs against zoom-induced reflows. */
    rect?: { left: number; top: number };
    /** Pressed on a node while connect mode was armed: if the pointer moves
     *  this becomes a normal node drag; a click still completes the edge. */
    connectDown?: boolean;
    /** True once a real movement (beyond the click threshold) happened. */
    moved?: boolean;
    /** Pre-drag document snapshot — only appended to history if we moved. */
    pre?: string;
  }>(null);

  useEffect(() => () => {
    if (pointerFrameRef.current !== null) cancelAnimationFrame(pointerFrameRef.current);
  }, []);

  // ── load ─────────────────────────────────────────────────────
  useEffect(() => {
    slugRef.current = slug;
    let cancelled = false;
    (async () => {
      try {
        const d = await getProjectCanvas(slug);
        if (cancelled) return;
        docRef.current = d;
        baseDocRef.current = JSON.stringify(d);
        liveOpsRef.current = true;
        setDoc(d);
        setLoadError(null);
      } catch (err: any) {
        if (!cancelled) setLoadError(err.message || 'Failed to load canvas');
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    // Restore the persisted camera for THIS project (per-slug key).
    try {
      const raw = localStorage.getItem(`wsd.canvas.view.${slug}`);
      if (raw) {
        const v = JSON.parse(raw) as Partial<ViewState>;
        if (v && typeof v.x === 'number' && typeof v.y === 'number' && typeof v.z === 'number') {
          const next: ViewState = {
            x: clamp(v.x, -100_000, 100_000),
            y: clamp(v.y, -100_000, 100_000),
            z: clamp(v.z, MIN_Z, MAX_Z),
          };
          viewRef.current = next;
          setView(next);
        }
      }
    } catch { /* junk view — keep default */ }
    return () => {
      cancelled = true;
    };
  }, [slug]);

  // ── live sync (WebSocket) ────────────────────────────────
  // Differential protocol: every local commit is diffed against baseDocRef
  // and POSTed as a small op batch; the server applies it atomically and
  // mirrors the ops to the room, and remote batches merge locally without a
  // refetch. Whole-doc PUTs (agents, imports) still fall back to the refetch
  // nudge — surfaced as a banner when a local edit is pending. Our own op
  // echoes are dropped via the socket's `by` user id. The same room also
  // carries the presence roster and peer cursors (useCanvasCursors).
  syncAliveRef.current = true;

  const refetchRemote = () => {
    if (!syncAliveRef.current) return;
    if (dirtyRef.current) { setRemoteUpdated(true); return; }
    getProjectCanvas(slugRef.current)
      .then((d) => {
        if (!syncAliveRef.current) return;
        if (dirtyRef.current) { setRemoteUpdated(true); return; }
        docRef.current = d;
        setDoc(d);
        baseDocRef.current = JSON.stringify(d);
        setLoadError(null);
        setRemoteUpdated(false);
      })
      .catch(() => { /* transient — the next nudge retries */ });
  };

    const scheduleRefetch = () => {
      if (remoteFetchTimer.current !== null) window.clearTimeout(remoteFetchTimer.current);
      remoteFetchTimer.current = window.setTimeout(() => {
        remoteFetchTimer.current = null;
        refetchRemote();
      }, 500);
    };

  // Identify ourselves so self-echoed op batches can be dropped.
  try { authUserIdRef.current = jwtUserId(localStorage.getItem('wsd.token')); } catch { /* noop */ }

  const ingestRemoteOps = (ops: any[], by?: string) => {
    if (by && authUserIdRef.current && by === authUserIdRef.current) return; // own echo
    const cur = docRef.current;
    if (!cur) return;
    applyingRemoteRef.current = true;
    try {
      const merged = applyRemoteOps(cur, ops);
      docRef.current = merged;
      const base = baseDocRef.current ? (JSON.parse(baseDocRef.current) as ProjectCanvas) : cur;
      baseDocRef.current = JSON.stringify(applyRemoteOps(base, ops));
      setDoc(merged);
      setRemoteUpdated(false);
    } finally {
      applyingRemoteRef.current = false;
    }
  };

  // Presence + cursors ride the same canvas room socket; the callbacks above
  // are forwarded verbatim, so sync and presence share one connection.
  const { peers, cursors, sendCursor } = useCanvasCursors(slug, {
    onOps: ingestRemoteOps,
    onNudge: (info) => {
      // Whole-doc fallback (agent aggregation, snapshot import) → refetch,
      // after dropping our own PUT echo by its save key.
      const key = `${slug}|${info.updatedAt ?? ''}`;
      if (lastLocalSaveRef.current && lastLocalSaveRef.current.key === key) {
        lastLocalSaveRef.current = null;
        return;
      }
      scheduleRefetch();
    },
  });

  useEffect(() => {
    return () => {
      syncAliveRef.current = false;
      if (remoteFetchTimer.current !== null) {
        window.clearTimeout(remoteFetchTimer.current);
        remoteFetchTimer.current = null;
      }
      if (opsRetryTimer.current !== null) {
        window.clearTimeout(opsRetryTimer.current);
        opsRetryTimer.current = null;
      }
    };
  }, []);

  // ── autosave ─────────────────────────────────────────────────
  /** Serialize POST /canvas/ops: one batch in flight, order preserved. */
  const flushOps = () => {
    if (opsSendingRef.current) return;
    const batch = opsQueueRef.current.splice(0, CANVAS_OPS_BATCH_SIZE);
    if (!batch.length) return;
    opsSendingRef.current = true;
    sendProjectCanvasOps(slugRef.current, batch)
      .then(() => {
        opsSendingRef.current = false;
        setSaveError(null);
        // Edits made while this batch was in flight go out next.
        if (opsQueueRef.current.length) flushOps();
        else if (!dirtyRef.current) setSaveState('saved');
      })
      .catch(() => {
        opsSendingRef.current = false;
        // Re-queue at the FRONT: the batch never landed server-side, so it
        // must stay ahead of anything queued after it (order preservation).
        opsQueueRef.current = [...batch, ...opsQueueRef.current];
        setSaveError(t('canvas.opsSendFailed'));
        if (opsRetryTimer.current === null) {
          opsRetryTimer.current = window.setTimeout(() => {
            opsRetryTimer.current = null;
            flushOps();
          }, 8000);
        }
      });
  };

  /** Diff the current doc against the last-sent base and queue the delta. */
  const queueOps = () => {
    const cur = docRef.current;
    if (!cur) return;
    const base = baseDocRef.current ? (JSON.parse(baseDocRef.current) as ProjectCanvas) : { version: 1 as const, nodes: [], edges: [], updatedAt: null };
    const ops = diffDocs(base, cur);
    baseDocRef.current = JSON.stringify(cur);
    if (ops.length) {
      opsQueueRef.current = [...opsQueueRef.current, ...ops];
    }
  };

  const flushSave = () => {
    saveTimer.current = null;
    const d = docRef.current;
    if (!d || !dirtyRef.current) return;
    dirtyRef.current = false;
    setSaveState('saving');
    if (!liveOpsRef.current) {
      // Legacy whole-document path (also the first-save snapshot upload).
      saveProjectCanvas(slugRef.current, d)
        .then((saved) => {
          // Remember this save so the sync-room echo of our own PUT is ignored
          // (the response carries the authoritative server-side updatedAt).
          lastLocalSaveRef.current = { key: `${slugRef.current}|${saved?.updatedAt ?? ''}`, at: Date.now() };
          baseDocRef.current = JSON.stringify(d);
          if (docRef.current === d) {
            setSaveState('saved');
            setSavedAt(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
            setSaveError(null);
          }
        })
        .catch((err: any) => {
          dirtyRef.current = true;
          setSaveState('dirty');
          setSaveError(err.message || 'Save failed');
          // Slow auto-retry so a hiccup (laptop sleep, blip) self-heals even
          // if the user never touches the board again.
          if (saveTimer.current === null) saveTimer.current = window.setTimeout(flushSave, 8000);
        });
      return;
    }
    queueOps();
    flushOps();
    // Optimistic UI: the op batch is authoritative now (failure re-queues it).
    setSaveState('saved');
    setSavedAt(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  };

  const scheduleSave = () => {
    if (readOnly) return;
    dirtyRef.current = true;
    setSaveState('dirty');
    if (saveTimer.current === null) saveTimer.current = window.setTimeout(flushSave, 900);
  };

  // Flush a pending save on unmount (tab switches) — re-registered on slug
  // changes so a switch between projects always writes to the right store.
  useEffect(() => {
    return () => {
      if (saveTimer.current !== null) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        flushSave();
      }
    };
  }, [slug]);

  // ── notices auto-dismiss ─────────────────────────────────────
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 3200);
    return () => window.clearTimeout(t);
  }, [notice]);

  // ── mutations ────────────────────────────────────────────────
  const pushHistory = () => {
    const d = docRef.current;
    if (!d) return;
    histRef.current = [...histRef.current.slice(-(HISTORY_DEPTH - 1)), JSON.stringify(d)];
    setCanUndo(true);
  };

  const mutate = (fn: (d: ProjectCanvas) => ProjectCanvas, withHistory = true) => {
    const d = docRef.current;
    if (!d || readOnly) return;
    if (withHistory) pushHistory();
    if (redoRef.current.length) {
      redoRef.current = [];
      setCanRedo(false);
    }
    const next = fn(d);
    docRef.current = next;
    setDoc(next);
    scheduleSave();
  };

  const undo = () => {
    const prev = histRef.current.pop();
    if (prev === undefined) return;
    const cur = docRef.current;
    if (cur) redoRef.current = [...redoRef.current, JSON.stringify(cur)];
    setCanUndo(histRef.current.length > 0);
    setCanRedo(true);
    if (cur) {
      const next = JSON.parse(prev) as ProjectCanvas;
      docRef.current = next;
      setDoc(next);
      dirtyRef.current = true;
      scheduleSave();
    }
  };

  const redo = () => {
    const nxt = redoRef.current.pop();
    if (nxt === undefined) return;
    const cur = docRef.current;
    if (cur) histRef.current = [...histRef.current, JSON.stringify(cur)];
    setCanUndo(true);
    setCanRedo(redoRef.current.length > 0);
    if (cur) {
      const next = JSON.parse(nxt) as ProjectCanvas;
      docRef.current = next;
      setDoc(next);
      dirtyRef.current = true;
      scheduleSave();
    }
  };

  /** In-memory clipboard: nodes + internal edges between them. */
  const copyRef = useRef<{ nodes: CanvasNode[]; edges: CanvasEdge[] } | null>(null);
  const pasteCountRef = useRef(0);

  /** Return only the edges whose both endpoints are in `nodeIds`. */
  const internalEdges = (nodeIds: string[]): CanvasEdge[] => {
    const d = docRef.current;
    if (!d) return [];
    const set = new Set(nodeIds);
    return d.edges.filter((e) => set.has(e.from) && set.has(e.to));
  };

  const duplicateSelected = () => {
    if (!selNodes.length || readOnly) return;
    const d = docRef.current;
    if (!d) return;
    const maxNew = MAX_NODES - d.nodes.length;
    if (maxNew <= 0) { setNotice(t('canvas.noticeLimitNodes', { max: MAX_NODES })); return; }
    const budget = Math.min(selNodes.length, maxNew);
    const src = selNodes.slice(0, budget).map((id) => d.nodes.find((n) => n.id === id)).filter(Boolean) as CanvasNode[];
    if (!src.length) return;
    // Map old id → new id so internal edges can be re-wired.
    const idMap: Record<string, string> = {};
    const nodes: CanvasNode[] = src.map((s) => {
      const id = freshId('n');
      idMap[s.id] = id;
      return { ...s, id, x: s.x + 24, y: s.y + 24 };
    });
    // Duplicate any internal edges between the selected nodes.
    const srcIds = src.map((n) => n.id);
    const newEdges: CanvasEdge[] = internalEdges(srcIds).map((e) => ({
      id: freshId('e'),
      from: idMap[e.from],
      to: idMap[e.to],
    }));
    const newIds = nodes.map((n) => n.id);
    mutate((prev) => ({
      ...prev,
      nodes: [...prev.nodes, ...nodes],
      edges: [...prev.edges, ...newEdges],
    }));
    setSelNodes(newIds);
    pasteCountRef.current = 0;
  };

  const copySelected = () => {
    if (!selNodes.length) return;
    const d = docRef.current;
    if (!d) return;
    const nodes = selNodes.map((id) => d.nodes.find((n) => n.id === id)).filter(Boolean) as CanvasNode[];
    const edges = internalEdges(selNodes);
    copyRef.current = { nodes, edges };
    // Write a portable JSON to the system clipboard so the user can paste
    // across tabs or after a page refresh.
    try {
      navigator.clipboard.writeText(JSON.stringify({ nodes, edges }));
    } catch { /* best-effort — in-memory ref still works */ }
    pasteCountRef.current = 0;
    setNotice(t('canvas.noticeCopied', { n: nodes.length }));
  };

  /** Core paste logic — shared by the keyboard shortcut and context menu. */
  const doPaste = (payload: { nodes: CanvasNode[]; edges: CanvasEdge[] }) => {
    if (readOnly) return;
    const d = docRef.current;
    if (!d) return;
    const { nodes, edges } = payload;
    if (!nodes.length) return;
    const maxNew = MAX_NODES - d.nodes.length;
    if (maxNew <= 0) { setNotice(t('canvas.noticeLimitNodes', { max: MAX_NODES })); return; }
    const budget = Math.min(nodes.length, maxNew);
    if (budget < nodes.length) setNotice(t('canvas.noticePasteCapped', { n: budget, total: nodes.length }));
    const off = 24 + pasteCountRef.current * 20;
    pasteCountRef.current += 1;
    const idMap: Record<string, string> = {};
    const newNodes: CanvasNode[] = nodes.slice(0, budget).map((n) => {
      const id = freshId('n');
      idMap[n.id] = id;
      return { ...n, id, x: n.x + off, y: n.y + off };
    });
    // Re-wire edges whose both endpoints were pasted.
    const newEdges: CanvasEdge[] = edges
      .filter((e) => idMap[e.from] && idMap[e.to])
      .map((e) => ({ id: freshId('e'), from: idMap[e.from], to: idMap[e.to] }));
    mutate((prev) => ({
      ...prev,
      nodes: [...prev.nodes, ...newNodes],
      edges: [...prev.edges, ...newEdges],
    }));
    setSelNodes(newNodes.map((n) => n.id));
  };

  const pasteFromClipboard = async () => {
    if (readOnly) return;
    // Try the system clipboard first so paste works across tabs / after refresh.
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        const parsed = JSON.parse(text);
        // Accept both the new {nodes, edges} shape and the legacy nodes-only
        // array — ALWAYS through the sanitizer: clipboard content is untrusted
        // input (wrong sizes/text lengths would poison the local doc).
        if (Array.isArray(parsed)) {
          doPaste(sanitizeClipboardPayload(parsed, []));
          return;
        }
        if (Array.isArray(parsed?.nodes)) {
          doPaste(sanitizeClipboardPayload(parsed.nodes, parsed.edges ?? []));
          return;
        }
      }
    } catch { /* fall through to in-memory ref */ }
    // Fallback: use the in-memory ref (same tab, still valid).
    if (copyRef.current) doPaste(copyRef.current);
  };

  const patchNode = (id: string, patch: Partial<CanvasNode>, withHistory = true) => {
    mutate(
      (d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) }),
      withHistory
    );
  };

  const setColor = (nodeId: string, color: CanvasColor) => patchNode(nodeId, { color });

  const addNode = (type: CanvasNodeType, atWorld?: { x: number; y: number }) => {
    if (docRef.current && docRef.current.nodes.length >= MAX_NODES) {
      setNotice(t('canvas.noticeLimitNodes', { max: MAX_NODES }));
      return;
    }
    const el = containerRef.current;
    const r = el?.getBoundingClientRect();
    const cx = atWorld ? atWorld.x : r ? (r.width / 2 - viewRef.current.x) / viewRef.current.z : 60;
    const cy = atWorld ? atWorld.y : r ? (r.height / 2 - viewRef.current.y) / viewRef.current.z : 60;
    // Cascade successive adds in a visible fan (large steps relative to the
    // 220×100 node) so rapid FAB/N/C creates never stack at the exact center.
    const seq = addSeqRef.current++;
    const offX = (seq % 4) * 90;
    const offY = Math.floor(seq / 4) * 90;
    const id = freshId('n');
    const node: CanvasNode = {
      id,
      type,
      text: '',
      x: cx - 110 + offX,
      y: cy - 50 + offY,
      w: 220,
      h: type === 'card' ? 120 : 100,
      color: type === 'card' ? 'blue' : 'yellow',
      done: false,
    };
    mutate((d) => ({ ...d, nodes: [...d.nodes, node] }));
    setSelNodes([id]);
    setSelEdge(null);
    setEditing(id); // type straight into the new node
    setMenuOpen(false);
  };

  const addEdge = (from: string, to: string) => {
    const d = docRef.current;
    if (!d) return;
    if (d.edges.length >= MAX_EDGES) {
      setNotice(t('canvas.noticeLimitEdges', { max: MAX_EDGES }));
      return;
    }
    // One arrow per direction — a duplicate connect attempt is a no-op with
    // feedback instead of a stacked invisible edge.
    if (d.edges.some((e) => e.from === from && e.to === to)) {
      setNotice(t('canvas.noticeEdgeExists'));
      return;
    }
    mutate((d) => ({ ...d, edges: [...d.edges, { id: freshId('e'), from, to }] }));
  };

  // ── sections (swimlanes) ────────────────────────────────────
  const MAX_SECTIONS = 12;
  const addSection = (name: string) => {
    const cur = docRef.current;
    if (cur && (cur.sections?.length ?? 0) >= MAX_SECTIONS) {
      setNotice(t('canvas.noticeLimitSections', { max: MAX_SECTIONS }));
      return;
    }
    const sec: CanvasSection = { id: freshId('s'), name: name.slice(0, 80) || 'Section', color: 'blue' };
    mutate((d) => ({ ...d, sections: [...(d.sections ?? []), sec] }));
    setAddSectionOpen(false);
  };
  const removeSection = (id: string) => {
    mutate((d) => ({
      ...d,
      sections: (d.sections ?? []).filter((s) => s.id !== id),
      nodes: d.nodes.map((n) => (n.section === id ? { ...n, section: undefined } : n)),
    }));
  };
  const toggleSection = (id: string) =>
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const setNodeSection = (nodeId: string, section: string | undefined) =>
    patchNode(nodeId, { section });

  // ── fullscreen ──────────────────────────────────────────────
  const toggleFullscreen = () => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      wrap.requestFullscreen().catch(() => {});
    }
  };

  // ── right-click context menu ────────────────────────────────
  const openCtxMenu = (e: any) => {
    const t = e.target as Element;
    const nodeEl = t.closest?.('.cn-node') as HTMLElement | null;
    const edgeEl = t.closest?.('.cn-edge') as HTMLElement | null;
    if (nodeEl) {
      const id = nodeEl.dataset.id ?? '';
      setSelNodes((prev) => (prev.includes(id) ? prev : [id]));
      setSelEdge(null);
    }
    setCtxMenu({ x: e.clientX, y: e.clientY, nodeId: nodeEl?.dataset.id ?? undefined, edgeId: edgeEl?.dataset.id ?? undefined });
  };
  const closeCtxMenu = () => setCtxMenu(null);

  useEffect(() => {
    const onFs = () => {
      const entering = !!document.fullscreenElement;
      setIsFullscreen(entering);
      if (entering) {
        fullscreenSavedViewRef.current = viewRef.current;
        requestAnimationFrame(() => {
          if (!document.fullscreenElement) return;
          fitView();
          fullscreenFitViewRef.current = viewRef.current;
        });
        return;
      }
      const saved = fullscreenSavedViewRef.current;
      const fitted = fullscreenFitViewRef.current;
      const current = viewRef.current;
      if (saved && fitted && current.x === fitted.x && current.y === fitted.y && current.z === fitted.z) {
        setViewState(saved);
      }
      fullscreenSavedViewRef.current = null;
      fullscreenFitViewRef.current = null;
    };
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  useEffect(() => {
    if (!ctxMenu) return;
    const onDown = (e: any) => {
      if ((e.target as Element).closest?.('.cn-ctx')) return;
      closeCtxMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeCtxMenu();
    };
    const onScroll = () => closeCtxMenu();
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('blur', onScroll);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [ctxMenu]);

  // A window blur can swallow the Space keyup — never leave pan mode stuck on.
  useEffect(() => {
    const onBlur = () => {
      setSpaceHeld(false);
      // Also drop an in-flight pan so the camera doesn't keep following a
      // phantom drag after alt-tab.
      const dr = dragRef.current;
      if (dr?.kind === 'pan') dragRef.current = null;
    };
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, []);

  const removeSelected = () => {
    if (selEdge) {
      mutate((d) => ({ ...d, edges: d.edges.filter((e) => e.id !== selEdge) }));
      setSelEdge(null);
    } else if (selNodes.length) {
      mutate((d) => {
        const keep = d.nodes.filter((n) => !selNodes.includes(n.id));
        return {
          ...d,
          nodes: keep,
          edges: d.edges.filter(
            (e) => keep.some((n) => n.id === e.from) && keep.some((n) => n.id === e.to)
          ),
        };
      });
      setSelNodes([]);
    }
  };

  const removeNode = (id: string) => {
    mutate((d) => {
      const keep = d.nodes.filter((n) => n.id !== id);
      return {
        ...d,
        nodes: keep,
        edges: d.edges.filter((e) => e.from !== id && e.to !== id),
      };
    });
    setSelNodes((prev) => prev.filter((x) => x !== id));
    setSelEdge(null);
  };

  const removeEdge = (id: string) => {
    mutate((d) => ({ ...d, edges: d.edges.filter((e) => e.id !== id) }));
    setSelEdge(null);
  };

  const bringToFront = () => {
    if (!selNodes.length || readOnly) return;
    mutate((d) => {
      const moved = d.nodes.filter((n) => selNodes.includes(n.id));
      const rest = d.nodes.filter((n) => !selNodes.includes(n.id));
      return { ...d, nodes: [...rest, ...moved] };
    });
  };

  const sendToBack = () => {
    if (!selNodes.length || readOnly) return;
    mutate((d) => {
      const moved = d.nodes.filter((n) => selNodes.includes(n.id));
      const rest = d.nodes.filter((n) => !selNodes.includes(n.id));
      return { ...d, nodes: [...moved, ...rest] };
    });
  };

  const startResize = (id: string, e: any) => {
    const node = docRef.current?.nodes.find((n) => n.id === id);
    if (!node) return;
    // Re-assert selection so the resize handle belongs to the primary node.
    setSelNodes([id]);
    setSelEdge(null);
    dragRef.current = {
      kind: 'resize',
      resize: { id, w: node.w, h: node.h, pre: '' },
      cX: e.clientX,
      cY: e.clientY,
      startX: node.w,
      startY: node.h,
      moved: false,
    };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  // ── seed from project notes ──────────────────────────────────
  const seedFromNotes = async () => {
    try {
      const { items } = await getProjectNotes(slug);
      const budget = MAX_NODES - (docRef.current?.nodes.length || 0);
      if (budget <= 0) {
        setNotice(t('canvas.noticeLimitNodes', { max: MAX_NODES }));
        return;
      }
      const open = items.filter((n) => !n.done).slice(0, Math.min(12, budget));
      if (!open.length) {
        setNotice(t('canvas.noticeNoNotes'));
        return;
      }
      const colorByKind: Record<string, CanvasColor> = { idea: 'yellow', bug: 'red', goal: 'blue' };
      let sy = viewRef.current.y + 20;
      const nodes: CanvasNode[] = open.map((n, i) => {
        const x = viewRef.current.x + 40 + (i % 3) * 260;
        if (i % 3 === 0 && i > 0) sy += 150;
        return {
          id: freshId('n'),
          type: 'note' as const,
          text: n.text,
          x,
          y: sy,
          w: 240,
          h: 130,
          color: colorByKind[n.kind] || 'yellow',
        };
      });
      mutate((d) => ({ ...d, nodes: [...d.nodes, ...nodes] }));
      setNotice(t('canvas.noticeImported', { n: nodes.length }));
    } catch (err: any) {
      setNotice(t('canvas.noticeImportFailed', { error: err.message || '' }));
    }
  };

  // ── view helpers ─────────────────────────────────────────────
  const persistView = () => {
    if (viewSaveTimer.current !== null) return;
    viewSaveTimer.current = window.setTimeout(() => {
      viewSaveTimer.current = null;
      try {
        localStorage.setItem(`wsd.canvas.view.${slugRef.current}`, JSON.stringify(viewRef.current));
      } catch { /* private mode */ }
    }, 400);
  };

  const setViewState = (v: ViewState) => {
    viewRef.current = v;
    writeCameraTransform(v);
    setView(v);
    persistView();
  };

  const writeCameraTransform = (v: ViewState) => {
    const world = containerRef.current?.querySelector<HTMLElement>('.cn-world');
    if (world) world.style.transform = `translate3d(${v.x}px, ${v.y}px, 0) scale(${v.z})`;
  };

  const resetZoom = () => {
    const v = viewRef.current;
    setViewState({ ...v, z: 1 });
  };

  const resetView = () => {
    setViewState({ x: 40, y: 40, z: 1 });
  };

  /** Screen (client) coords → world coords under the current camera. When a
   *  drag supplies its cached container rect, no live layout read happens
   *  (rect stays valid: pointer capture pins events to the same element). */
  const worldFromClient = (clientX: number, clientY: number, rect?: { left: number; top: number }) => {
    const r = rect ?? containerRef.current?.getBoundingClientRect();
    const { x, y, z } = viewRef.current;
    return { x: (clientX - (r?.left ?? 0) - x) / z, y: (clientY - (r?.top ?? 0) - y) / z };
  };

  // Soft grid snap applied only on release so live dragging stays free and the
  // "no full re-render during move" contract holds.
  const SNAP = 12;
  const snapCoord = (n: number) => {
    const rem = ((n % SNAP) + SNAP) % SNAP;
    return rem < SNAP / 2 ? n - rem : n + (SNAP - rem);
  };

  const zoomBy = (factor: number, anchor?: { sx: number; sy: number }) => {
    const v = viewRef.current;
    const nz = clamp(v.z * factor, MIN_Z, MAX_Z);
    const r = containerRef.current?.getBoundingClientRect();
    const sx = anchor && r ? anchor.sx - r.left : r ? r.width / 2 : 0;
    const sy = anchor && r ? anchor.sy - r.top : r ? r.height / 2 : 0;
    setViewState({
      z: nz,
      x: sx - ((sx - v.x) * nz) / v.z,
      y: sy - ((sy - v.y) * nz) / v.z,
    });
  };

  /** Fit either the whole board or (when ids given) just those nodes. */
  const fitView = (ids?: string[]) => {
    const d = docRef.current;
    const r = containerRef.current?.getBoundingClientRect();
    const list = ids?.length && d ? d.nodes.filter((n) => ids.includes(n.id)) : d?.nodes;
    if (!list || !list.length) {
      setViewState({ x: 40, y: 40, z: 1 });
      return;
    }
    const minX = Math.min(...list.map((n) => n.x));
    const minY = Math.min(...list.map((n) => n.y));
    const maxX = Math.max(...list.map((n) => n.x + n.w));
    const maxY = Math.max(...list.map((n) => n.y + n.h));
    const pad = 60;
    const w = maxX - minX + pad * 2;
    const h = maxY - minY + pad * 2;
    const z = r ? clamp(Math.min((r.width - 40) / Math.max(w, 1), (r.height - 40) / Math.max(h, 1)), MIN_Z, MAX_Z) : 1;
    setViewState({
      z,
      x: r ? (r.width / 2) - (minX + (maxX - minX) / 2) * z : 40,
      y: r ? (r.height / 2) - (minY + (maxY - minY) / 2) * z : 40,
    });
  };

  /** Enter connect mode from any trigger (toolbar / shortcut / port drag). */
  const beginConnect = (id: string) => {
    const a = docRef.current?.nodes.find((n) => n.id === id);
    connectEndRef.current = a ? { x: a.x + a.w / 2, y: a.y + a.h / 2 } : null;
    setConnectFrom(id);
  };

  // ── wheel pan / zoom (non-passive so we can preventDefault) ──
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const flushWheel = () => {
      const pending = pendingWheelRef.current;
      if (!pending) return;
      pendingWheelRef.current = null;
      if (pending.mode === 'pan') {
        const next = {
          ...viewRef.current,
          x: viewRef.current.x - pending.deltaX,
          y: viewRef.current.y - pending.deltaY,
        };
        viewRef.current = next;
        writeCameraTransform(next);
      } else {
        const v = viewRef.current;
        const rect = el.getBoundingClientRect();
        const sx = pending.clientX - rect.left;
        const sy = pending.clientY - rect.top;
        const nz = clamp(v.z * Math.exp(-pending.deltaY * pending.sensitivity), MIN_Z, MAX_Z);
        const next = {
          z: nz,
          x: sx - ((sx - v.x) * nz) / v.z,
          y: sy - ((sy - v.y) * nz) / v.z,
        };
        viewRef.current = next;
        writeCameraTransform(next);
      }
      if (wheelCommitTimerRef.current !== null) window.clearTimeout(wheelCommitTimerRef.current);
      wheelCommitTimerRef.current = window.setTimeout(() => {
        wheelCommitTimerRef.current = null;
        setView(viewRef.current);
        persistView();
      }, 140);
    };
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest?.('textarea')) return;
      e.preventDefault();
      // Trackpad pinch sets ctrlKey. Pixel-only discrete notches cover browsers
      // that report a traditional mouse wheel in pixels instead of lines.
      const pixelMouseNotch = e.deltaX === 0
        && Math.abs(e.deltaY) >= 100
        && (Math.abs(e.deltaY) % 100 === 0 || Math.abs(e.deltaY) % 120 === 0);
      const mode = e.ctrlKey || e.deltaMode !== WheelEvent.DOM_DELTA_PIXEL || pixelMouseNotch ? 'zoom' : 'pan';
      const sensitivity = e.ctrlKey ? 0.01 : 0.001;
      const deltaScale = e.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 40
        : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? el.clientHeight : 1;
      let pending = pendingWheelRef.current;
      if (pending && pending.mode !== mode) {
        flushWheel();
        pending = null;
      }
      if (!pending) {
        pending = {
          mode,
          deltaX: 0,
          deltaY: 0,
          clientX: e.clientX,
          clientY: e.clientY,
          sensitivity,
        };
        pendingWheelRef.current = pending;
      }
      pending.deltaX += e.deltaX * deltaScale;
      pending.deltaY += e.deltaY * deltaScale;
      pending.clientX = e.clientX;
      pending.clientY = e.clientY;
      if (wheelFrameRef.current === null) {
        wheelFrameRef.current = requestAnimationFrame(() => {
          wheelFrameRef.current = null;
          flushWheel();
        });
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      if (wheelFrameRef.current !== null) cancelAnimationFrame(wheelFrameRef.current);
      if (wheelCommitTimerRef.current !== null) window.clearTimeout(wheelCommitTimerRef.current);
      wheelFrameRef.current = null;
      wheelCommitTimerRef.current = null;
      pendingWheelRef.current = null;
    };
  }, []);

  // ── global keyboard (undo/redo/delete/shortcuts) ────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const tag = target?.tagName;
      if (document.querySelector('.modal-overlay')) return;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const meta = e.ctrlKey || e.metaKey;
      if (meta && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }
      if (meta && (e.key === 'z' || e.key === 'Z' || e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        if ((e.key === 'y' || e.key === 'Y') || e.shiftKey) redo();
        else undo();
        return;
      }
      if (meta && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        if (dirtyRef.current) flushSave();
        return;
      }
      if (meta && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        const ids = (docRef.current?.nodes ?? [])
          .filter((n) => !(n.section && collapsedSections.has(n.section)))
          .map((n) => n.id);
        setSelNodes(ids);
        setSelEdge(null);
        return;
      }
      if (meta && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); duplicateSelected(); return; }
      if (meta && (e.key === 'x' || e.key === 'X')) { e.preventDefault(); copySelected(); removeSelected(); return; }
      if (meta && (e.key === 'v' || e.key === 'V')) { e.preventDefault(); pasteFromClipboard(); return; }
      if (e.key === 'Escape') {
        setConnectFrom(null);
        setSelNodes([]);
        setSelEdge(null);
        setMenuOpen(false);
        if (editing) setEditing(null);
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && (selNodes.length || selEdge)) {
        e.preventDefault();
        removeSelected();
        return;
      }
      // Arrow-key nudge of the selection (fine 4px, Shift = coarse 20px).
      // A rapid burst collapses into one undo entry (800ms quiet window).
      if (e.key.startsWith('Arrow') && selNodes.length && !readOnly) {
        e.preventDefault();
        const step = e.shiftKey ? NUDGE_COARSE : NUDGE_FINE;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        const now = Date.now();
        const withHistory = now - nudgeAtRef.current > 800;
        nudgeAtRef.current = now;
        mutate(
          (d) => ({
            ...d,
            nodes: d.nodes.map((n) => (selNodes.includes(n.id) ? { ...n, x: n.x + dx, y: n.y + dy } : n)),
          }),
          withHistory
        );
        return;
      }
      if (readOnly) return;
      if (e.key === ' ') {
        e.preventDefault();
        setSpaceHeld(true);
        return;
      }
      if (e.key === 'n' || e.key === 'N') addNode('note');
      else if (e.key === 'c' || e.key === 'C') addNode('card');
      else if (e.key === 'l' || e.key === 'L') {
        if (selNode) beginConnect(selNode);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') setSpaceHeld(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [readOnly, selNodes, selEdge, editing, connectFrom, collapsedSections]);

  // ── pointer interactions (delegated to the canvas root) ─────
  const onPointerDown = (e: any) => {
    const el = containerRef.current;
    if (!el) return;
    const target = e.target as HTMLElement;
    const nodeEl = (target as Element).closest?.('.cn-node');
    const edgeEl = (target as Element).closest?.('.cn-edge');

    // Interactive controls INSIDE a node must never start a node drag —
    // the press belongs to them. (Without this, mousedown on the checkbox /
    // color dot / port drags the whole node under the pointer.)
    if (nodeEl && target.closest?.('.cn-check, .cn-node-colors, .cn-resize-handle, .cn-port')) return;

    // Commit the open text editor on any pointer-down outside the node being
    // edited — clicking another node, the background or a section must close it.
    if (editing && nodeEl?.getAttribute('data-id') !== editing) {
      setEditing(null);
    }

    // Cache the container rect ONCE per gesture. Re-reading it on every
    // pointermove forces layout per frame and can desync mid-gesture.
    const rect = el.getBoundingClientRect();
    const cachedRect = { left: rect.left, top: rect.top };

    if (e.button === 1) {
      // Middle button always pans, over anything.
      dragRef.current = {
        kind: 'pan',
        cX: e.clientX,
        cY: e.clientY,
        startX: viewRef.current.x,
        startY: viewRef.current.y,
        rect: cachedRect,
      };
      el.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button === 2) return; // right button → context menu only

    // Space held → always pan, even if clicking over a node.
    if (e.button === 0 && spaceHeld) {
      dragRef.current = {
        kind: 'pan',
        cX: e.clientX,
        cY: e.clientY,
        startX: viewRef.current.x,
        startY: viewRef.current.y,
        rect: cachedRect,
      };
      el.setPointerCapture(e.pointerId);
      return;
    }

    if (edgeEl && !readOnly) {
      const id = (edgeEl as HTMLElement).dataset.id!;
      setSelEdge(id);
      setSelNodes([]);
      return;
    }

    if (nodeEl) {
      const id = (nodeEl as HTMLElement).dataset.id!;
      const node = docRef.current?.nodes.find((n) => n.id === id);
      if (!node) return;
      e.stopPropagation();

      if (connectFrom) {
        // Armed connect mode: DON'T complete the edge on pointerdown. Keep the
        // press live so dragging out of the node moves it normally; if this is
        // just a click (no drag beyond the threshold) endDrag completes the
        // edge — a press that "grabs nothing" used to be swallowed here.
        dragRef.current = {
          kind: 'node',
          ids: [id],
          elements: [nodeEl as HTMLElement],
          startPos: { [id]: { x: node.x, y: node.y } },
          cX: e.clientX,
          cY: e.clientY,
          startX: node.x,
          startY: node.y,
          moved: false,
          connectDown: true,
          rect: cachedRect,
        };
        el.setPointerCapture(e.pointerId);
        return;
      }
      if (readOnly) {
        setSelNodes([id]);
        setSelEdge(null);
        return;
      }

      // Shift+click toggles the node in/out of the multi-selection.
      if (e.shiftKey) {
        setSelNodes((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
        setSelEdge(null);
        return;
      }

      // Multi-selection drag: if the clicked node is already in the current
      // selection keep all of them selected so the drag moves the whole group.
      // Otherwise reset to just the clicked node (normal single-click).
      const isInSel = selNodes.includes(id);
      const dragIds = isInSel && selNodes.length > 1 ? selNodes : [id];

      if (!isInSel) setSelNodes([id]);
      setSelEdge(null);

      if (e.button === 0) {
        // Build startPos for every node that will be dragged.
        const startPos: Record<string, { x: number; y: number }> = {};
        const dragIdSet = new Set(dragIds);
        const nodesById = new Map((docRef.current?.nodes ?? []).map((item) => [item.id, item] as const));
        const elements: HTMLElement[] = [];
        for (const element of el.querySelectorAll<HTMLElement>('.cn-node')) {
          const elementId = element.dataset.id;
          if (elementId && dragIdSet.has(elementId)) elements.push(element);
        }
        for (const nid of dragIds) {
          const n = nodesById.get(nid);
          if (n) startPos[nid] = { x: n.x, y: n.y };
        }
        dragRef.current = {
          kind: 'node',
          ids: dragIds,
          elements,
          startPos,
          cX: e.clientX,
          cY: e.clientY,
          startX: node.x,
          startY: node.y,
          moved: false,
          rect: cachedRect,
        };
        el.setPointerCapture(e.pointerId);
      }
      return;
    }

    // Background
    if (connectFrom) {
      setConnectFrom(null);
      return;
    }
    if (e.button === 0) {
      // Left-drag on empty canvas → marquee selection (rubber band).
      const w = worldFromClient(e.clientX, e.clientY);
      dragRef.current = {
        kind: 'marquee',
        cX: e.clientX,
        cY: e.clientY,
        startX: w.x,
        startY: w.y,
        endX: w.x,
        endY: w.y,
        moved: false,
        pre: JSON.stringify(docRef.current),
        rect: cachedRect,
      };
      el.setPointerCapture(e.pointerId);
      setSelNodes([]);
      setSelEdge(null);
      setMenuOpen(false);
    }
  };

  const processPointerMove = (clientX: number, clientY: number) => {
    const dr = dragRef.current;
    if (!readOnly) {
      const w = worldFromClient(clientX, clientY, dr?.rect);
      sendCursor(w.x, w.y);
    }
    if (connectFrom) {
      const w = worldFromClient(clientX, clientY);
      connectEndRef.current = w;
      const line = containerRef.current?.querySelector<SVGLineElement>('.cn-connect-line');
      if (line) {
        line.setAttribute('x2', String(w.x));
        line.setAttribute('y2', String(w.y));
      }
    }
    if (!dr) return;
    const dx = clientX - dr.cX;
    const dy = clientY - dr.cY;
    if (dr.kind === 'pan') {
      const next = { ...viewRef.current, x: dr.startX + dx, y: dr.startY + dy };
      viewRef.current = next;
      // Avoid a component render per frame; endDrag commits this camera state.
      writeCameraTransform(next);
    } else if (dr.kind === 'marquee') {
      const w = worldFromClient(clientX, clientY, dr.rect);
      if (!dr.moved && Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
      dr.moved = true;
      dr.endX = w.x;
      dr.endY = w.y;
      const marq = containerRef.current?.querySelector('.cn-marquee');
      if (marq) {
        marq.setAttribute('display', 'inline');
        marq.setAttribute('x', String(Math.min(dr.startX, w.x)));
        marq.setAttribute('y', String(Math.min(dr.startY, w.y)));
        marq.setAttribute('width', String(Math.abs(w.x - dr.startX)));
        marq.setAttribute('height', String(Math.abs(w.y - dr.startY)));
      }
    } else if (dr.kind === 'resize' && dr.resize) {
      if (!dr.moved && Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
      const z = viewRef.current.z;
      dr.moved = true;
      dr.resize.pre ||= JSON.stringify(docRef.current);
      const nw = clamp(dr.startX + dx / z, 60, 900);
      const nh = clamp(dr.startY + dy / z, 40, 900);
      const node = docRef.current?.nodes.find((n) => n.id === dr.resize!.id);
      if (!node) return;
      node.w = nw;
      node.h = nh;
      const el = containerRef.current?.querySelector<HTMLElement>(`.cn-node[data-id="${dr.resize.id}"]`);
      if (el) {
        el.style.width = `${nw}px`;
        el.style.height = `${nh}px`;
      }
    } else if (dr.ids && dr.ids.length) {
      if (!dr.moved && Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
      const z = viewRef.current.z;
      const firstMove = !dr.moved;
      dr.moved = true;
      dr.pre ||= JSON.stringify(docRef.current);
      for (const element of dr.elements ?? []) {
        if (firstMove) element.style.willChange = 'transform';
        element.style.transform = `translate3d(${dx / z}px, ${dy / z}px, 0)`;
      }
    }
  };

  // Coalesce pointer work to a visual frame; release flushes the final coordinates.
  const flushPointerMove = () => {
    const point = pendingPointerRef.current;
    if (!point) return;
    pendingPointerRef.current = null;
    if (pointerFrameRef.current !== null) {
      cancelAnimationFrame(pointerFrameRef.current);
      pointerFrameRef.current = null;
    }
    processPointerMove(point.clientX, point.clientY);
  };

  const onPointerMove = (e: any) => {
    pendingPointerRef.current = { clientX: e.clientX, clientY: e.clientY };
    if (pointerFrameRef.current === null) {
      pointerFrameRef.current = requestAnimationFrame(() => {
        pointerFrameRef.current = null;
        flushPointerMove();
      });
    }
  };

  const endDrag = (e: any, cancelled = false) => {
    flushPointerMove();
    const dr = dragRef.current;
    dragRef.current = null;
    for (const element of dr?.elements ?? []) {
      element.style.transform = '';
      element.style.willChange = '';
    }
    // Release from the element the capture was SET on (the canvas root), not
    // from wherever the pointer ended up — and only if WE own this pointer id.
    try {
      const root = containerRef.current;
      if (root && root.hasPointerCapture?.(e.pointerId)) root.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    if (!dr) return;
    if (dr.kind === 'pan') {
      setViewState(viewRef.current);
      return;
    }
    // Armed connect mode: a SIMPLE click (no drag) completes the edge.
    if (!cancelled && dr.kind === 'node' && dr.connectDown && !dr.moved) {
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.cn-node') as HTMLElement | null;
      const targetId = target?.dataset?.id;
      if (targetId && connectFrom && targetId !== connectFrom) addEdge(connectFrom, targetId);
      setConnectFrom(null);
      return;
    }
    // A connect-mode press that DRAGGED AWAY falls through to the normal
    // node-drag commit below (history + save) — connect mode stays armed so
    // the user can still click the target next.
    if (dr.kind === 'marquee') {
      const marq = containerRef.current?.querySelector('.cn-marquee');
      if (marq) marq.setAttribute('display', 'none');
      if (dr.moved) {
        const cur = docRef.current;
        const ex = dr.endX ?? dr.startX;
        const ey = dr.endY ?? dr.startY;
        const sx = Math.min(dr.startX, ex);
        const sy = Math.min(dr.startY, ey);
        const sw = Math.abs(ex - dr.startX);
        const sh = Math.abs(ey - dr.startY);
        const hit = (cur?.nodes ?? []).filter(
          (n) =>
            n.x < sx + sw && n.x + n.w > sx && n.y < sy + sh && n.y + n.h > sy
        );
        if (hit.length) setSelNodes(hit.map((n) => n.id));
      }
      return;
    }
    if (dr.kind === 'resize' && dr.resize && dr.moved) {
      const cur = docRef.current;
      if (cur && dr.resize.pre) {
        histRef.current = [...histRef.current.slice(-(HISTORY_DEPTH - 1)), dr.resize.pre];
        setCanUndo(true);
      }
      redoRef.current = [];
      setCanRedo(false);
      if (cur) {
        docRef.current = { ...cur, nodes: cur.nodes.map((n) => n) };
        setDoc(docRef.current);
        if (liveOpsRef.current) { queueOps(); flushOps(); setSaveState('saved'); }
        else scheduleSave();
      }
      return;
    }
    if (dr.kind !== 'node' || !dr.ids?.length || !dr.moved) return;
    const cur = docRef.current;
    if (!cur) return;
    // A real drag: commit exactly ONE undo entry from the pre-drag snapshot,
    // then one re-render with the final positions. Plain clicks (moved=false)
    // never touch history or write anything.
    if (dr.pre) {
      histRef.current = [...histRef.current.slice(-(HISTORY_DEPTH - 1)), dr.pre];
      setCanUndo(true);
    }
    redoRef.current = [];
    setCanRedo(false);
    const dx = (e.clientX - dr.cX) / viewRef.current.z;
    const dy = (e.clientY - dr.cY) / viewRef.current.z;
    const next = {
      ...cur,
      nodes: cur.nodes.map((n) =>
        dr!.startPos?.[n.id]
          ? {
              ...n,
              x: snapCoord(dr!.startPos![n.id].x + dx),
              y: snapCoord(dr!.startPos![n.id].y + dy),
            }
          : n
      ),
    };

    docRef.current = next;
    setDoc(next);
    if (liveOpsRef.current) { queueOps(); flushOps(); setSaveState('saved'); }
    else scheduleSave();
  };

  // ── editing (inline textarea) ─────────────────────────────────
  // The textarea is inserted on the same tick editing starts, and an autofocus
  // attribute is inert on a dynamically created element — so "double-click to
  // edit" used to leave the keyboard on the canvas, unable to type and unable
  // to ever see the editor's focus ring.
  useEffect(() => {
    if (editing) editorRef.current?.focus();
  }, [editing]);
  const startEdit = (id: string) => {
    if (readOnly) return;
    const node = docRef.current?.nodes.find((n) => n.id === id);
    editPreRef.current = node ? { id, text: node.text } : null;
    editHistPushedRef.current = false;
    setEditing(id);
  };
  const commitEdit = () => {
    editPreRef.current = null;
    setEditing(null);
  };
  /** Escape while editing = cancel: restore the pre-edit text, no save diff. */
  const cancelEdit = () => {
    const pre = editPreRef.current;
    if (pre && docRef.current) {
      const node = docRef.current.nodes.find((n) => n.id === pre.id);
      if (node && node.text !== pre.text) {
        mutate((d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === pre.id ? { ...n, text: pre.text } : n)) }), false);
      }
    }
    editPreRef.current = null;
    setEditing(null);
  };
  const onEditorInput = (id: string, e: any) => {
    // One history snapshot per editing session (on the first keystroke),
    // never one per character.
    if (!editHistPushedRef.current) {
      pushHistory();
      editHistPushedRef.current = true;
    }
    patchNode(id, { text: e.currentTarget.value }, false);
  };
  const onEditorKey = (e: any) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      (e.currentTarget as HTMLTextAreaElement).blur();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelEdit();
    }
  };

  // ── push selected cards → project notes ─────────────────
  const pushSelectionToNotes = async () => {
    if (!selNodes.length || readOnly || pushingNotes) return;
    const d = docRef.current;
    if (!d) return;
    const picked = selNodes
      .map((id) => d.nodes.find((n) => n.id === id))
      .filter(Boolean) as CanvasNode[];
    if (!picked.length) return;
    const fresh: NoteItem[] = picked.map((n) => ({
      id: freshId('n').slice(0, 40),
      text: n.text.trim(),
      kind: n.type === 'card' ? ('goal' as const) : ('idea' as const),
      done: n.type === 'card' && n.done === true,
      createdAt: new Date().toISOString(),
    })).filter((n) => n.text);
    if (!fresh.length) {
      setNotice(t('canvas.noticePushEmpty'));
      return;
    }
    setPushingNotes(true);
    try {
      const existing = await getProjectNotes(slugRef.current);
      const existingTexts = new Set((existing.items || []).map((n) => n.text.trim()));
      const freshOnly = fresh.filter((n) => !existingTexts.has(n.text));
      if (!freshOnly.length) {
        setNotice(t('canvas.noticePushDuplicates'));
        return;
      }
      // Client-side cap mirrors the backend MAX_ITEMS=300 so a near-full list
      // fails fast with clear feedback instead of a 400 from the server.
      const room = 300 - (existing.items?.length ?? 0);
      if (room <= 0) {
        setNotice(t('canvas.noticePushLimit', { max: 300 }));
        return;
      }
      const merged = [...freshOnly.slice(0, room), ...(existing.items || [])].slice(0, 300);
      await saveProjectNotes(slugRef.current, merged);
      setNotice(t('canvas.noticePushed', { n: Math.min(freshOnly.length, room) }));
    } catch (err: any) {
      setNotice(t('canvas.noticePushFailed', { error: err.message || '' }));
    } finally {
      setPushingNotes(false);
    }
  };

  // ── PNG export (2D re-render of the board) ───────────────
  const exportPng = () => {
    const d = docRef.current;
    if (!d || !d.nodes.length) {
      setNotice(t('canvas.noticeExportEmpty'));
      return;
    }
    const PAD = 32;
    const minX = Math.min(...d.nodes.map((n) => n.x)) - PAD;
    const minY = Math.min(...d.nodes.map((n) => n.y)) - PAD;
    const maxX = Math.max(...d.nodes.map((n) => n.x + n.w)) + PAD;
    const maxY = Math.max(...d.nodes.map((n) => n.y + n.h)) + PAD;
    const width = Math.min(Math.max(maxX - minX, 1), 8000);
    const height = Math.min(Math.max(maxY - minY, 1), 8000);
    const scale = Math.min(2, Math.max(0.1, 8000 / Math.max(width, height)));

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(scale, scale);

    // Backdrop — same panel tone as the on-screen board.
    ctx.fillStyle = '#17181d';
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = '#23252b';
    ctx.lineWidth = 1;
    for (let gx = -((minX % 24) + 24) % 24; gx < width; gx += 24) {
      ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, height); ctx.stroke();
    }
    for (let gy = -((minY % 24) + 24) % 24; gy < height; gy += 24) {
      ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(width, gy); ctx.stroke();
    }

    const byId = new Map(d.nodes.map((n) => [n.id, n]));
    const ox = -minX;
    const oy = -minY;

    // Edges — the same quadratic curve as the on-screen renderer.
    for (const edge of d.edges) {
      const a = byId.get(edge.from);
      const b = byId.get(edge.to);
      if (!a || !b) continue;
      const x1 = a.x + a.w / 2 + ox;
      const y1 = a.y + a.h / 2 + oy;
      const x2 = b.x + b.w / 2 + ox;
      const y2 = b.y + b.h / 2 + oy;
      const dxa = Math.abs(x2 - x1);
      const dya = Math.abs(y2 - y1);
      const cx = dxa >= dya ? (x1 + x2) / 2 : x1;
      const cy = dxa >= dya ? y1 : (y1 + y2) / 2;
      ctx.strokeStyle = '#7d8289';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.quadraticCurveTo(cx, cy, x2, y2);
      ctx.stroke();
      // Arrowhead oriented along the arrival tangent.
      const ang = Math.atan2(y2 - cy, x2 - cx);
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - 8 * Math.cos(ang - 0.4), y2 - 8 * Math.sin(ang - 0.4));
      ctx.lineTo(x2 - 8 * Math.cos(ang + 0.4), y2 - 8 * Math.sin(ang + 0.4));
      ctx.closePath();
      ctx.fillStyle = '#7d8289';
      ctx.fill();
    }

    // Nodes — rounded rect, color swatch, wrapped text, ✓ for done cards.
    const R = 10;
    for (const n of d.nodes) {
      const x = n.x + ox;
      const y = n.y + oy;
      ctx.beginPath();
      ctx.moveTo(x + R, y);
      ctx.arcTo(x + n.w, y, x + n.w, y + n.h, R);
      ctx.arcTo(x + n.w, y + n.h, x, y + n.h, R);
      ctx.arcTo(x, y + n.h, x, y, R);
      ctx.arcTo(x, y, x + n.w, y, R);
      ctx.closePath();
      ctx.fillStyle = EXPORT_COLORS[n.color] ?? EXPORT_COLORS.yellow;
      ctx.fill();

      ctx.fillStyle = '#e8e9ea';
      const FONT = '13px "Inter", system-ui, sans-serif';
      ctx.font = FONT;
      const maxPx = n.w - 20;
      const lines = wrapExportTextPx(n.text || '', maxPx, FONT);
      const lineH = 17;
      const startY = y + 14;
      lines.forEach((line, li) => {
        const ty = startY + li * lineH;
        if (ty > y + n.h - 4) return;
        if (n.type === 'card' && li === 0 && n.done) {
          ctx.fillStyle = '#3fb950';
          ctx.fillText('✓', x + 10, ty);
          ctx.fillStyle = '#e8e9ea';
          ctx.fillText(line, x + 26, ty);
        } else {
          ctx.fillText(line, x + 10, ty);
        }
      });
      if (!lines.length) {
        ctx.fillStyle = 'rgba(232, 233, 234, 0.4)';
        ctx.fillText('…', x + 10, startY);
      }
    }

    canvas.toBlob((blob) => {
      if (!blob) { setNotice(t('canvas.noticeExportFailed')); return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `canvas-${slug}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 4000);
    }, 'image/png');
  };

  // Double-click on empty canvas creates a note right under the cursor.
  const onRootDblClick = (e: any) => {
    if (readOnly) return;
    const eventTarget = e.target as Element;
    const target = document.elementFromPoint(e.clientX, e.clientY) ?? eventTarget;
    const node = target.closest?.('.cn-node') as HTMLElement | null;
    if (node) {
      const id = node.dataset.id;
      if (id) startEdit(id);
      return;
    }
    if (target.closest?.('.cn-edge') || eventTarget.closest?.('.cn-edge')) return;
    addNode('note', worldFromClient(e.clientX, e.clientY));
  };

  const toggleDone = (id: string, done: boolean) => patchNode(id, { done });

  if (loadError) {
    return (
      <div class="panel" style="margin-top: 8px">
        <div class="empty-state">
          <div style="color: var(--danger); margin-bottom: 8px">{t('canvas.loadError')}</div>
          <div class="dim">{loadError}</div>
          <button class="btn-ghost sm" style="margin-top: 12px" onClick={() => window.location.reload()}>
            {t('canvas.reload')}
          </button>
        </div>
      </div>
    );
  }

  const selected = selNode ? (doc?.nodes.find((n) => n.id === selNode) ?? null) : null;
  const selectedNodeIds = new Set(selNodes);

  const renderEdges = () => {
    if (!doc) return null;
    const nodesById = new Map(doc.nodes.map((node) => [node.id, node] as const));
    // Hide edges touching a collapsed section.
    const hidden = new Set(
      doc.nodes.filter((n) => n.section && collapsedSections.has(n.section)).map((n) => n.id)
    );
    const visible = doc.edges.filter((e) => !hidden.has(e.from) && !hidden.has(e.to));
    const src = connectFrom ? nodesById.get(connectFrom) ?? null : null;
    if (!visible.length && !src) return null;
    // Pre-compute a world→SVG path for every edge between live nodes.
    const edgePath = (edge: CanvasEdge): string | null => {
      const a = nodesById.get(edge.from);
      const b = nodesById.get(edge.to);
      if (!a || !b) return null;
      const x1 = a.x + a.w / 2;
      const y1 = a.y + a.h / 2;
      const x2 = b.x + b.w / 2;
      const y2 = b.y + b.h / 2;
      // Control point biased by the dominant axis so curves read naturally.
      const dx = Math.abs(x2 - x1);
      const dy = Math.abs(y2 - y1);
      const cx = dx >= dy ? (x1 + x2) / 2 : x1;
      const cy = dx >= dy ? y1 : (y1 + y2) / 2;
      return `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`;
    };
    return (
      <svg class="cn-svg" aria-hidden="true">
        <defs>
          <marker id={`arrow-${slug}`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto-start-reverse">
            <path d="M 0.5 0.5 L 8.5 5 L 0.5 9.5 z" fill="var(--text-3)" />
          </marker>
        </defs>
        {visible.map((edge) => {
          const d = edgePath(edge);
          if (!d) return null;
          const selectedLine = selEdge === edge.id;
          return (
            <g key={edge.id}>
              <path
                class="cn-edge"
                data-id={edge.id}
                d={d}
                stroke="transparent"
                stroke-width="16"
                fill="none"
                style="pointer-events: stroke; cursor: pointer"
                onPointerDown={(e: any) => {
                  e.stopPropagation();
                  if (readOnly) return;
                  setSelEdge(edge.id);
                  setSelNodes([]);
                }}
              />
              <path
                d={d}
                stroke={selectedLine ? 'var(--accent)' : 'var(--text-3)'}
                stroke-width={selectedLine ? 2.5 : 1.5}
                fill="none"
                marker-end={`url(#arrow-${slug})`}
                style="pointer-events: none"
              />
            </g>
          );
        })}
        {src && (
          <line
            class="cn-connect-line"
            x1={src.x + src.w / 2}
            y1={src.y + src.h / 2}
            x2={connectEndRef.current?.x ?? src.x + src.w / 2}
            y2={connectEndRef.current?.y ?? src.y + src.h / 2}
          />
        )}
        <rect class="cn-marquee" x="0" y="0" width="0" height="0" display="none" />
      </svg>
    );
  };

  const sectionCounts = new Map<string, number>();
  const sectionIds = new Set((doc?.sections ?? []).map((section) => section.id));
  let unassignedCount = 0;
  for (const node of doc?.nodes ?? []) {
    if (node.section && sectionIds.has(node.section)) {
      sectionCounts.set(node.section, (sectionCounts.get(node.section) ?? 0) + 1);
    } else {
      unassignedCount++;
    }
  }
  const normalizedSearch = searchQuery.trim().toLocaleLowerCase();
  const searchResults = normalizedSearch
    ? (doc?.nodes ?? []).filter((node) => node.text.toLocaleLowerCase().includes(normalizedSearch))
    : [];
  const activeSearchIndex = searchResults.length && searchIndex >= 0 ? searchIndex % searchResults.length : -1;
  const activeSearchId = activeSearchIndex >= 0 ? searchResults[activeSearchIndex]?.id ?? null : null;
  const searchMatchIds = new Set(searchResults.map((node) => node.id));
  const navigateSearch = (direction: number) => {
    if (!searchResults.length) return;
    const nextIndex = activeSearchIndex < 0
      ? direction > 0 ? 0 : searchResults.length - 1
      : (activeSearchIndex + direction + searchResults.length) % searchResults.length;
    const node = searchResults[nextIndex];
    if (node.section) {
      setCollapsedSections((previous) => {
        if (!previous.has(node.section!)) return previous;
        const next = new Set(previous);
        next.delete(node.section!);
        return next;
      });
    }
    setSearchIndex(nextIndex);
    setSelNodes([node.id]);
    setSelEdge(null);
    fitView([node.id]);
  };

  return (
    <div class={`canvas-wrap ${isFullscreen ? 'cn-fullscreen' : ''}`} ref={wrapRef}>
      <h2 class="panel-title" style="display:flex;align-items:center;gap:6px">
        {t('canvas.title')}
        {!readOnly && <span class="dim" style="font-weight:400;font-size:0.7rem">{t('canvas.titleHint')}</span>}
      </h2>
      {/* Top toolbar: view controls + mode + save status */}
      <div class="cn-toolbar">
        <div class="cn-tb-group">
          <button class="cn-tb-btn" title={t('canvas.zoomOut')} aria-label={t('canvas.zoomOut')} onClick={() => zoomBy(1 / 1.2)}>
            <ZoomOut width={15} height={15} />
          </button>
          <button class="cn-tb-btn" title={t('canvas.zoomIn')} aria-label={t('canvas.zoomIn')} onClick={() => zoomBy(1.2)}>
            <ZoomIn width={15} height={15} />
          </button>
          <button class="cn-tb-btn" title={t('canvas.fitAll')} aria-label={t('canvas.fitAll')} onClick={() => fitView()}>
            <Maximize width={14} height={14} />
          </button>
          {selNodes.length > 0 && (
            <button class="cn-tb-btn" title={t('canvas.fitSelection')} aria-label={t('canvas.fitSelection')} onClick={() => fitView(selNodes)}>
              <Maximize width={14} height={14} />
            </button>
          )}
          <button class="cn-tb-btn cn-zoom-btn" title={t('canvas.resetZoom', { pct: Math.round(view.z * 100) })} aria-label={t('canvas.resetZoom', { pct: Math.round(view.z * 100) })} onClick={resetZoom}>
            {Math.round(view.z * 100)}%
          </button>
          <button class="cn-tb-btn" title={t('canvas.resetView')} aria-label={t('canvas.resetView')} onClick={resetView}>
            <Home width={14} height={14} />
          </button>
          <button class="cn-tb-btn" title={isFullscreen ? t('canvas.exitFullscreen') : t('canvas.fullscreen')} aria-label={isFullscreen ? t('canvas.exitFullscreen') : t('canvas.fullscreen')} onClick={toggleFullscreen}>
            {isFullscreen ? <Minimize2 width={15} height={15} /> : <Maximize2 width={15} height={15} />}
          </button>
          <button class="cn-tb-btn" title={t('canvas.exportPng')} aria-label={t('canvas.exportPng')} onClick={exportPng}>
            <ImageDown width={15} height={15} />
          </button>
          {peers.length > 0 && (
            <span class="cn-presence" title={peers.map((p) => p.displayName || p.username).join(', ')}>
              {peers.slice(0, 5).map((p, i) => {
                const label = p.displayName || p.username;
                const url = avatarUrl(p.id, (p.avatarExt as any) ?? null);
                return url ? (
                  <img key={p.id} class="cn-presence-avatar" src={url} style={{ '--pi': i } as any} alt={label} width={18} height={18} />
                ) : (
                  <span key={p.id} class="cn-presence-avatar cn-presence-initial" style={{ '--pi': i, '--pc': peerColor(p.id) } as any} aria-label={label}>
                    {(label || '?').slice(0, 1).toUpperCase()}
                  </span>
                );
              })}
              {peers.length > 5 && <span class="cn-presence-more">+{peers.length - 5}</span>}
              <span class="cn-presence-dot" aria-hidden="true" />
            </span>
          )}
        </div>
        <div class="cn-tb-group">
          <button class="cn-tb-btn" title={t('canvas.undo')} aria-label={t('canvas.undo')} disabled={!canUndo} onClick={undo}>
            <Undo2 width={14} height={14} />
          </button>
          <button class="cn-tb-btn" title={t('canvas.redo')} aria-label={t('canvas.redo')} disabled={!canRedo} onClick={redo}>
            <Redo2 width={14} height={14} />
          </button>
        </div>
        <div class="cn-tb-group">
          {!readOnly && (
            <button class="cn-tb-btn" title={t('canvas.addSection')} aria-label={t('canvas.addSection')} onClick={() => setAddSectionOpen(true)}>
              <Rows3 width={15} height={15} />
            </button>
          )}
          <button class={`cn-tb-btn ${connectFrom ? 'cn-active' : ''}`} title={t('canvas.connect')} aria-label={t('canvas.connect')} aria-pressed={!!connectFrom} disabled={readOnly || !selNode} onClick={() => (connectFrom ? setConnectFrom(null) : selNode && beginConnect(selNode))}>
            <Link2 width={15} height={15} />
            {connectFrom ? <span class="cn-tb-hint">{t('canvas.connectPickTarget')}</span> : null}
          </button>
          <span class="cn-stats-chip" title={t('canvas.stats', { nodes: doc?.nodes.length ?? 0, edges: doc?.edges.length ?? 0 })}>
            {t('canvas.stats', { nodes: doc?.nodes.length ?? 0, edges: doc?.edges.length ?? 0 })}
          </span>
          {readOnly && (
            <span class="cn-ro-chip" title={t('canvas.readOnlyChipTitle')} role="status">
              <Lock width={11} height={11} /> {t('canvas.readOnlyChip')}
            </span>
          )}
        </div>
        <details class="cn-shortcuts">
          <summary role="button" class="cn-tb-btn" title={t('canvas.shortcuts')} aria-label={t('canvas.shortcuts')}>
            <Keyboard width={15} height={15} />
          </summary>
          <div class="cn-shortcuts-popover" role="group" aria-label={t('canvas.shortcuts')}>
            <strong>{t('canvas.shortcuts')}</strong>
            <dl>
              <div><dt><kbd dir="ltr">Ctrl / ⌘ + F</kbd></dt><dd>{t('canvas.shortcutSearch')}</dd></div>
              {!readOnly && (
                <>
                  <div><dt><kbd dir="ltr">Ctrl / ⌘ + Z</kbd></dt><dd>{t('canvas.shortcutUndo')}</dd></div>
                  <div><dt><kbd dir="ltr">Ctrl / ⌘ + Shift + Z</kbd></dt><dd>{t('canvas.shortcutRedo')}</dd></div>
                  <div><dt><kbd dir="ltr">Ctrl / ⌘ + S</kbd></dt><dd>{t('canvas.shortcutSave')}</dd></div>
                  <div><dt><kbd dir="ltr">Ctrl / ⌘ + A</kbd></dt><dd>{t('canvas.shortcutSelectAll')}</dd></div>
                  <div><dt><kbd dir="ltr">N</kbd></dt><dd>{t('canvas.shortcutNewNote')}</dd></div>
                  <div><dt><kbd dir="ltr">C</kbd></dt><dd>{t('canvas.shortcutNewCard')}</dd></div>
                  <div><dt><kbd dir="ltr">L</kbd></dt><dd>{t('canvas.shortcutConnect')}</dd></div>
                  <div><dt><kbd dir="ltr">← ↑ → ↓</kbd></dt><dd>{t('canvas.shortcutMove')}</dd></div>
                  <div><dt><kbd dir="ltr">Shift + Arrow</kbd></dt><dd>{t('canvas.shortcutMoveFast')}</dd></div>
                </>
              )}
            </dl>
          </div>
        </details>
        <div class="cn-tb-spacer" />
        <div class="cn-save-state" role="status">
          {remoteUpdated && (
            <span class="cn-remote-banner">
              <Globe width={12} height={12} />
              {t('canvas.remoteUpdated')}
              <button class="cn-remote-load" onClick={() => {
                setRemoteUpdated(false);
                getProjectCanvas(slugRef.current)
                  .then((d) => {
                    docRef.current = d; setDoc(d);
                    baseDocRef.current = JSON.stringify(d);
                  })
                  .catch(() => { /* next nudge retries */ });
              }}>
                {t('canvas.remoteLoad')}
              </button>
              <button class="cn-remote-dismiss" aria-label={t('canvas.remoteDismiss')} onClick={() => setRemoteUpdated(false)}>
                <X width={11} height={11} />
              </button>
            </span>
          )}
          {saveState === 'saving' && <span class="dim">{t('canvas.saving')}</span>}
          {saveState === 'dirty' && <span class="dim">{t('canvas.unsaved')}</span>}
          {saveState === 'saved' && savedAt && <span class="dim">{t('canvas.savedAt', { time: savedAt })}</span>}
          {saveError ? (
            <>
              <span class="cn-save-err">{t('canvas.saveFailed', { error: saveError })}</span>
              <button class="cn-tb-btn" onClick={flushSave}>{t('canvas.saveRetry')}</button>
            </>
          ) : null}
        </div>
      </div>

      {doc && (
        <div class="cn-sections-bar" role="group" aria-label={t('canvas.sections')}>
          <div class="cn-sections-heading">
            <span class="cn-sections-title"><Rows3 width={14} height={14} />{t('canvas.sections')}</span>
            <span class="cn-sections-total">{t('canvas.sectionsCount', { count: doc.sections?.length ?? 0 })}</span>
          </div>
          <div class="cn-sections-list">
            {doc.sections?.map((s) => {
              const collapsed = collapsedSections.has(s.id);
              const count = sectionCounts.get(s.id) ?? 0;
              return (
                <span key={s.id} class={`cn-section-chip c-${s.color}`} title={t('canvas.sectionSummary', { name: s.name, count })}>
                  <button class="cn-section-toggle" aria-label={collapsed ? t('canvas.sectionExpand') : t('canvas.sectionCollapse')} onClick={() => toggleSection(s.id)}>
                    {collapsed ? <ChevronRight width={12} height={12} /> : <ChevronDown width={12} height={12} />}
                  </button>
                  <span class="cn-section-name">{s.name}</span>
                  <span class="cn-section-count">{count}</span>
                  {!readOnly && (
                    <button class="cn-section-del" aria-label={t('canvas.sectionDelete', { name: s.name })} onClick={() => setConfirmDelSection(s.id)}>
                      <X width={12} height={12} />
                    </button>
                  )}
                </span>
              );
            })}
            {unassignedCount > 0 && (
              <span class="cn-unassigned-chip">{t('canvas.unassignedCount', { count: unassignedCount })}</span>
            )}
            {!doc.sections?.length && !addSectionOpen && (
              readOnly
                ? <span class="cn-sections-empty">{t('canvas.sectionsEmpty')}</span>
                : (
                  <button class="cn-section-empty-action" onClick={() => setAddSectionOpen(true)}>
                    <Plus width={14} height={14} />{t('canvas.sectionAddFirst')}
                  </button>
                )
            )}
            {addSectionOpen && (
              <span class="cn-section-add">
                <input
                  autoFocus
                  class="cn-section-input"
                  placeholder={t('canvas.sectionNamePlaceholder')}
                  aria-label={t('canvas.sectionNameAria')}
                  onKeyDown={(e: any) => {
                    if (e.key === 'Enter') addSection(e.currentTarget.value);
                    if (e.key === 'Escape') setAddSectionOpen(false);
                  }}
                  onBlur={(e: any) => {
                    if (!e.currentTarget.parentElement?.contains(e.relatedTarget)) setAddSectionOpen(false);
                  }}
                />
                <button class="cn-section-ok" aria-label={t('canvas.sectionCreate')} onClick={(e) => {
                  const inp = (e.currentTarget.parentElement as HTMLElement).querySelector('.cn-section-input') as HTMLInputElement;
                  if (inp) addSection(inp.value);
                }}>
                  <Plus width={14} height={14} />
                </button>
              </span>
            )}
          </div>
          <div class="cn-board-search" role="group" aria-label={t('canvas.searchNodes')}>
            <Search width={14} height={14} aria-hidden="true" />
            <input
              ref={searchInputRef}
              class="cn-board-search-input"
              type="search"
              dir="auto"
              value={searchQuery}
              placeholder={t('canvas.searchPlaceholder')}
              aria-label={t('canvas.searchNodes')}
              onInput={(event: any) => {
                setSearchQuery(event.currentTarget.value);
                setSearchIndex(-1);
              }}
              onKeyDown={(event: any) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  navigateSearch(event.shiftKey ? -1 : 1);
                } else if (event.key === 'Escape' && searchQuery) {
                  event.preventDefault();
                  setSearchQuery('');
                  setSearchIndex(-1);
                }
              }}
            />
            {searchQuery && (
              <>
                <span class="cn-search-count" aria-live="polite">
                  {searchResults.length
                    ? activeSearchIndex < 0
                      ? t('canvas.searchResultCount', { count: searchResults.length })
                      : t('canvas.searchPosition', { current: activeSearchIndex + 1, total: searchResults.length })
                    : t('canvas.searchNoResults')}
                </span>
                <button class="cn-search-nav" type="button" aria-label={t('canvas.searchPrevious')} title={t('canvas.searchPrevious')} disabled={!searchResults.length} onClick={() => navigateSearch(-1)}>
                  <ChevronLeft width={14} height={14} />
                </button>
                <button class="cn-search-nav" type="button" aria-label={t('canvas.searchNext')} title={t('canvas.searchNext')} disabled={!searchResults.length} onClick={() => navigateSearch(1)}>
                  <ChevronRight width={14} height={14} />
                </button>
                <button class="cn-search-clear" type="button" aria-label={t('canvas.searchClear')} title={t('canvas.searchClear')} onClick={() => { setSearchQuery(''); setSearchIndex(-1); }}>
                  <X width={13} height={13} />
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Selection toolbar (active while a node is selected) */}
      {selected && !readOnly && (
        <div class="cn-selbar">
          {COLORS.map((c) => (
            <button
              key={c}
              class={`cn-dot c-${c} ${selected.color === c ? 'cn-dot-active' : ''}`}
              title={t('canvas.colorAria', { color: c })}
              aria-label={t('canvas.colorAria', { color: c })}
              aria-pressed={selected.color === c}
              onClick={() => setColor(selected.id, c)}
            />
          ))}
          {doc?.sections?.length ? (
            <select
              class="cn-section-select"
              title={t('canvas.moveToSection')}
              aria-label={t('canvas.moveToSectionAria')}
              value={selected.section ?? ''}
              onPointerDown={(e: any) => e.stopPropagation()}
              onClick={(e: any) => e.stopPropagation()}
              onChange={(e: any) => {
                e.stopPropagation();
                setNodeSection(selected.id, e.currentTarget.value || undefined);
              }}
            >
              <option value="">{t('canvas.noSection')}</option>
              {doc.sections.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          ) : null}
          <span class="cn-sel-sep" />
          <button class="cn-tb-btn" title={t('canvas.bringToFront')} aria-label={t('canvas.bringToFront')} onClick={bringToFront}>
            <BringToFront width={14} height={14} />
          </button>
          <button class="cn-tb-btn" title={t('canvas.sendToBack')} aria-label={t('canvas.sendToBack')} onClick={sendToBack}>
            <SendToBack width={14} height={14} />
          </button>
          <button class="cn-tb-btn" title={t('canvas.duplicate')} aria-label={t('canvas.duplicateAria')} onClick={duplicateSelected}>
            <CopyPlus width={14} height={14} />
          </button>
          <button class="cn-tb-btn" title={t('canvas.copy')} aria-label={t('canvas.copyAria')} onClick={copySelected}>
            <Copy width={14} height={14} />
          </button>
          <button
            class="cn-tb-btn"
            title={t('canvas.pushToNotes')}
            aria-label={t('canvas.pushToNotesAria')}
            disabled={pushingNotes}
            onClick={pushSelectionToNotes}
          >
            <ClipboardList width={14} height={14} />
          </button>
          <button class="cn-tb-btn" title={t('canvas.deleteSelected')} aria-label={t('canvas.deleteSelectedAria')} onClick={removeSelected}>
            <Trash2 width={14} height={14} />
          </button>
        </div>
      )}
      {selEdge && !readOnly && (
        <div class="cn-selbar cn-selbar-edge">
          <span class="cn-sel-label">{t('canvas.selectedArrow')}</span>
          <span class="cn-sel-sep" />
          <button class="cn-tb-btn" title={t('canvas.deleteArrow')} aria-label={t('canvas.deleteArrowAria')} onClick={removeSelected}>
            <Trash2 width={14} height={14} />
          </button>
        </div>
      )}
      {connectFrom && (
        <div class="cn-connecting" role="status">
          <MousePointer2 width={12} height={12} /> {t('canvas.connecting')}
        </div>
      )}

      {/* Add menu */}
      {!readOnly && (
        <div class="cn-add-wrap">
          <div class={`cn-add-menu ${menuOpen ? 'open' : ''}`}>
            <button class="cn-add-item" aria-label={t('canvas.addNote')} onClick={() => addNode('note')}>
              <StickyNote width={15} height={15} /> {t('canvas.addNote')} <span class="dim">N</span>
            </button>
            <button class="cn-add-item" aria-label={t('canvas.addCard')} onClick={() => addNode('card')}>
              <CheckSquare width={15} height={15} /> {t('canvas.addCard')} <span class="dim">C</span>
            </button>
            <button class="cn-add-item" aria-label={t('canvas.addArrow')} onClick={() => { if (selNode) { beginConnect(selNode); setMenuOpen(false); } else setMenuOpen(false); }}>
              <Link2 width={15} height={15} /> {t('canvas.addArrow')} <span class="dim">L</span>
            </button>
            <button class="cn-add-item" aria-label={t('canvas.seedFromNotes')} onClick={() => { seedFromNotes(); setMenuOpen(false); }}>
              <Sparkles width={15} height={15} /> {t('canvas.seedFromNotes')}
            </button>
          </div>
          <button class="cn-add-fab" title={t('canvas.addAria')} aria-label={t('canvas.addAria')} aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}>
            <Plus width={18} height={18} />
          </button>
        </div>
      )}

      {/* Right-click context menu */}
      {ctxMenu && (
        <div
          class="cn-ctx"
          role="menu"
          aria-label={t('canvas.ctxMenuAria')}
          style={{ left: Math.min(ctxMenu.x, window.innerWidth - 230), top: Math.min(ctxMenu.y, window.innerHeight - 320) }}
          onContextMenu={(e: any) => {
            e.preventDefault();
            e.stopPropagation();
            closeCtxMenu();
          }}
        >
          {ctxMenu.nodeId ? (
            <>
              {!readOnly && (
                <button class="cn-ctx-item" role="menuitem" onClick={() => { startEdit(ctxMenu.nodeId!); closeCtxMenu(); }}>
                  <Pencil width={14} height={14} /> {t('canvas.ctxEdit')}
                </button>
              )}
              {!readOnly && (
                <button class="cn-ctx-item" role="menuitem" onClick={() => { setSelNodes([ctxMenu.nodeId!]); duplicateSelected(); closeCtxMenu(); }}>
                  <CopyPlus width={14} height={14} /> {t('canvas.duplicate')} <span class="dim">Ctrl+D</span>
                </button>
              )}
              {!readOnly && (
                <>
                  <button class="cn-ctx-item" role="menuitem" onClick={() => { setSelNodes([ctxMenu.nodeId!]); copySelected(); closeCtxMenu(); }}>
                    <Copy width={14} height={14} /> {t('canvas.copy')} <span class="dim">Ctrl+C</span>
                  </button>
                  <span class="cn-ctx-sep" />
                  <button class="cn-ctx-item" role="menuitem" onClick={() => { setSelNodes([ctxMenu.nodeId!]); bringToFront(); closeCtxMenu(); }}>
                    <BringToFront width={14} height={14} /> {t('canvas.bringToFront')}
                  </button>
                  <button class="cn-ctx-item" role="menuitem" onClick={() => { setSelNodes([ctxMenu.nodeId!]); sendToBack(); closeCtxMenu(); }}>
                    <SendToBack width={14} height={14} /> {t('canvas.sendToBack')}
                  </button>
                  <span class="cn-ctx-sep" />
                  <span class="cn-ctx-label">{t('canvas.ctxColor')}</span>
                  <span class="cn-ctx-colors">
                    {COLORS.map((c) => (
                      <button key={c} type="button" class={`cn-dot c-${c} ${doc?.nodes.find((n) => n.id === ctxMenu.nodeId)?.color === c ? 'cn-dot-active' : ''}`} aria-label={t('canvas.colorAria', { color: c })} onClick={() => { setColor(ctxMenu.nodeId!, c); closeCtxMenu(); }} />
                    ))}
                  </span>
                  {doc?.sections?.length ? (
                    <>
                      <span class="cn-ctx-label">{t('canvas.ctxSection')}</span>
                      <select class="cn-section-select cn-ctx-select" value={doc.nodes.find((n) => n.id === ctxMenu.nodeId)?.section ?? ''} onClick={(e: any) => e.stopPropagation()} onChange={(e: any) => { setNodeSection(ctxMenu.nodeId!, e.currentTarget.value || undefined); closeCtxMenu(); }}>
                        <option value="">{t('canvas.noSection')}</option>
                        {doc.sections.map((s) => (
                          <option key={s.id} value={s.id}>{s.name}</option>
                        ))}
                      </select>
                    </>
                  ) : null}
                  <span class="cn-ctx-sep" />
                  <button class="cn-ctx-item cn-ctx-danger" role="menuitem" onClick={() => { removeNode(ctxMenu.nodeId!); closeCtxMenu(); }}>
                    <Trash2 width={14} height={14} /> {t('canvas.ctxDeleteNode')}
                  </button>
                </>
              )}
            </>
          ) : ctxMenu.edgeId ? (
            <>
              {!readOnly && (
                <button class="cn-ctx-item cn-ctx-danger" role="menuitem" onClick={() => { removeEdge(ctxMenu.edgeId!); closeCtxMenu(); }}>
                  <Trash2 width={14} height={14} /> {t('canvas.ctxDeleteArrow')}
                </button>
              )}
            </>
          ) : (
            <>
              {!readOnly && (
                <button class="cn-ctx-item" role="menuitem" onClick={() => { addNode('note'); closeCtxMenu(); }}>
                  <StickyNote width={14} height={14} /> {t('canvas.addNote')} <span class="dim">N</span>
                </button>
              )}
              {!readOnly && (
                <button class="cn-ctx-item" role="menuitem" onClick={() => { addNode('card'); closeCtxMenu(); }}>
                  <CheckSquare width={14} height={14} /> {t('canvas.addCard')} <span class="dim">C</span>
                </button>
              )}
              {!readOnly && copyRef.current?.nodes.length ? (
                <button class="cn-ctx-item" role="menuitem" onClick={() => { pasteFromClipboard(); closeCtxMenu(); }}>
                  <ClipboardPaste width={14} height={14} /> {t('canvas.paste')} <span class="dim">Ctrl+V</span>
                </button>
              ) : null}
              <button class="cn-ctx-item" role="menuitem" onClick={() => { fitView(); closeCtxMenu(); }}>
                <Maximize width={14} height={14} /> {t('canvas.fitAll')}
              </button>
            </>
          )}
        </div>
      )}

      {/* Notice toast */}
      {notice && <div class="cn-notice" role="status">{notice}</div>}

      {/* The canvas */}
      <div
        ref={containerRef}
        class={`canvas-root ${spaceHeld ? 'cn-panning' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={(e: any) => endDrag(e, true)}
        onDblClick={onRootDblClick}
        onContextMenu={(e: any) => {
          e.preventDefault();
          e.stopPropagation();
          openCtxMenu(e);
        }}
      >
        <div
          class="cn-world"
          style={`transform: translate3d(${view.x}px, ${view.y}px, 0) scale(${view.z}); transform-origin: 0 0;`}
        >
          {renderEdges()}
          {doc?.nodes.map((n) => {
            if (n.section && collapsedSections.has(n.section)) return null;
            const isSel = selectedNodeIds.has(n.id);
            const isEditing = editing === n.id;
            return (
              <div
                key={n.id}
                class={`cn-node ${n.type} c-${n.color} ${isSel ? 'cn-selected' : ''} ${searchMatchIds.has(n.id) ? 'cn-search-match' : ''} ${activeSearchId === n.id ? 'cn-search-current' : ''} ${connectFrom === n.id ? 'cn-connect-src' : ''} ${connectFrom && connectFrom !== n.id ? 'cn-connectable' : ''}`}
                data-id={n.id}
                style={`left: ${n.x}px; top: ${n.y}px; width: ${n.w}px; height: ${n.h}px;`}
              >
                {n.type === 'card' && !isEditing && (
                  <button
                    class={`cn-check ${n.done ? 'done' : ''}`}
                    type="button"
                    title={n.done ? t('canvas.nodeCheckDone') : t('canvas.nodeCheckTodo')}
                    aria-label={n.done ? t('canvas.nodeCheckDone') : t('canvas.nodeCheckTodo')}
                    aria-pressed={n.done}
                    onPointerDown={(e: any) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!readOnly) toggleDone(n.id, !n.done);
                    }}
                  >
                    {n.done ? '✓' : ''}
                  </button>
                )}
                {isEditing ? (
                  <textarea
                    class="cn-editor"
                    data-id={n.id}
                    ref={editorRef}
                    value={n.text}
                    placeholder={n.type === 'card' ? t('canvas.cardPlaceholder') : t('canvas.notePlaceholder')}
                    onInput={(e: any) => onEditorInput(n.id, e)}
                    onBlur={commitEdit}
                    onKeyDown={onEditorKey}
                    onClick={(e: any) => e.stopPropagation()}
                    onPointerDown={(e: any) => e.stopPropagation()}
                  />
                ) : (
                  <div class="cn-text">{n.text || <span class="cn-placeholder">{t('canvas.placeholderClickToEdit')}</span>}</div>
                )}
                {!isEditing && !readOnly && (
                  <div class="cn-node-colors">
                    {COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        class={`cn-dot s c-${c} ${n.color === c ? 'cn-dot-active' : ''}`}
                        aria-label={t('canvas.colorAria', { color: c })}
                        aria-pressed={n.color === c}
                        onPointerDown={(e: any) => e.stopPropagation()}
                        onClick={(e) => {
                          e.stopPropagation();
                          setColor(n.id, c);
                        }}
                      />
                    ))}
                  </div>
                )}
                {isSel && !readOnly && (
                  <div
                    class="cn-resize-handle"
                    aria-label={t('canvas.resizeAria')}
                    onPointerDown={(e: any) => {
                      e.stopPropagation();
                      if (readOnly) return;
                      startResize(n.id, e);
                    }}
                  />
                )}
                {isSel && !readOnly && (
                  <div
                    class="cn-port"
                    title={t('canvas.connectPort')}
                    onPointerDown={(e: any) => {
                      e.stopPropagation();
                      if (readOnly) return;
                      beginConnect(n.id);
                    }}
                  />
                )}
              </div>
            );
          })}

        {/* live collaborator cursors (world coords) */}
        {cursors.map((c) => (
          <div
            key={c.id}
            class="cn-peer-cursor"
            style={{ left: c.x, top: c.y, '--pc': c.color } as any}
          >
            <svg width="15" height="19" viewBox="0 0 15 19" aria-hidden="true">
              <path
                d="M1.5 1l11.5 11.5H6.2L3.8 18 1.5 1z"
                fill={c.color}
                stroke="#fff"
                stroke-width="1.2"
              />
            </svg>
            <span class="cn-peer-cursor-name">{c.name}</span>
          </div>
        ))}
        </div>

        {loaded && doc && doc.nodes.length === 0 && (
          <div
            class="cn-empty"
            role="button"
            tabIndex={0}
            aria-label={t('canvas.addAria')}
            onClick={() => setMenuOpen(true)}
            onKeyDown={(e: KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                if (!readOnly) addNode('note');
              }
            }}
          >
            <div class="cn-empty-icon" aria-hidden="true">✸</div>
            <div class="cn-empty-title">{t('canvas.emptyTitle')}</div>
            <div class="cn-empty-sub">{t('canvas.emptySub')}</div>
          </div>
        )}
      </div>

      <ConfirmModal
        open={!!confirmDelSection}
        title={t('canvas.deleteSectionTitle', { name: doc?.sections?.find((s) => s.id === confirmDelSection)?.name ?? '' })}
        message={t('canvas.deleteSectionMessage')}
        confirmLabel={t('canvas.deleteSectionConfirm')}
        danger
        onCancel={() => setConfirmDelSection(null)}
        onConfirm={() => {
          if (confirmDelSection) removeSection(confirmDelSection);
          setConfirmDelSection(null);
        }}
      />
    </div>
  );
}
