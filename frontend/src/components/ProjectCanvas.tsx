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
} from 'lucide-preact';
import {
  getProjectCanvas,
  saveProjectCanvas,
  getProjectNotes,
} from '../api';
import type { CanvasNode, CanvasColor, ProjectCanvas, CanvasNodeType } from '../api';

/**
 * ProjectCanvas — an infinite pan/zoom whiteboard for planning one project.
 *
 * The document itself is camera-free: nodes live at absolute world
 * coordinates and the client view (pan/zoom) is purely local. Edits mutate a
 * local mirror, autosave debounces ~900ms, and Ctrl+Z/Y walk a snapshot
 * history. Viewers (readOnly) can pan/zoom but not edit.
 */

const HISTORY_DEPTH = 60;
const MAX_NODES = 200;
const MAX_EDGES = 400;
const MIN_Z = 0.2;
const MAX_Z = 3;

const COLORS: CanvasColor[] = ['yellow', 'blue', 'red', 'green'];

interface ViewState {
  x: number;
  y: number;
  z: number;
}

function freshId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function ProjectCanvas({ slug, readOnly }: { slug: string; readOnly?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<ProjectCanvas | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'dirty' | 'saving' | 'saved'>('saved');
  const [savedAt, setSavedAt] = useState('');

  const [selNodes, setSelNodes] = useState<string[]>([]);
  const [selEdge, setSelEdge] = useState<string | null>(null);
  // Primary (first) selected node — most UI reads only the head of the set.
  const selNode = selNodes[0] ?? null;
  const [editing, setEditing] = useState<string | null>(null);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [spaceHeld, setSpaceHeld] = useState(false);

  const [view, setView] = useState<ViewState>({ x: 40, y: 40, z: 1 });
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const docRef = useRef<ProjectCanvas | null>(null);
  const viewRef = useRef<ViewState>(view);
  const slugRef = useRef<string>(slug);
  const saveTimer = useRef<number | null>(null);
  const dirtyRef = useRef(false);
  const dragRef = useRef<null | {
    kind: 'node' | 'pan';
    ids?: string[];
    /** World positions of every dragged node at drag start. */
    startPos?: Record<string, { x: number; y: number }>;
    cX: number;
    cY: number;
    startX: number;
    startY: number;
    /** True once a real movement (beyond the click threshold) happened. */
    moved?: boolean;
    /** Pre-drag document snapshot — only appended to history if we moved. */
    pre?: string;
  }>(null);

  // ── load ─────────────────────────────────────────────────────
  useEffect(() => {
    slugRef.current = slug;
    let cancelled = false;
    (async () => {
      try {
        const d = await getProjectCanvas(slug);
        if (cancelled) return;
        docRef.current = d;
        setDoc(d);
        setLoadError(null);
      } catch (err: any) {
        if (!cancelled) setLoadError(err.message || 'Failed to load canvas');
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  // ── autosave ─────────────────────────────────────────────────
  const flushSave = () => {
    saveTimer.current = null;
    const d = docRef.current;
    if (!d || !dirtyRef.current) return;
    dirtyRef.current = false;
    setSaveState('saving');
    saveProjectCanvas(slugRef.current, d)
      .then(() => {
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
      });
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
  const histRef = useRef<string[]>([]);
  const redoRef = useRef<string[]>([]);

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

  const copyRef = useRef<CanvasNode[] | null>(null);
  const pasteCountRef = useRef(0);

  const duplicateSelected = () => {
    if (!selNodes.length || readOnly) return;
    const d = docRef.current;
    if (!d) return;
    const maxNew = MAX_NODES - d.nodes.length;
    if (maxNew <= 0) { setNotice(`Canvas limit reached (${MAX_NODES} nodes)`); return; }
    const budget = Math.min(selNodes.length, maxNew);
    const src = selNodes.slice(0, budget).map((id) => d.nodes.find((n) => n.id === id)).filter(Boolean) as CanvasNode[];
    if (!src.length) return;
    const ids: string[] = [];
    const nodes: CanvasNode[] = src.map((s) => {
      const id = freshId('n');
      ids.push(id);
      return { ...s, id, x: s.x + 24, y: s.y + 24 };
    });
    mutate((prev) => ({ ...prev, nodes: [...prev.nodes, ...nodes] }));
    setSelNodes(ids);
    pasteCountRef.current = 0;
  };

  const copySelected = () => {
    if (!selNodes.length) return;
    const d = docRef.current;
    if (!d) return;
    const nodes = selNodes.map((id) => d.nodes.find((n) => n.id === id)).filter(Boolean) as CanvasNode[];
    copyRef.current = nodes;
    try { navigator.clipboard.writeText(JSON.stringify(nodes)); } catch { /* best-effort */ }
    pasteCountRef.current = 0;
    setNotice(`Copied ${nodes.length} node(s)`);
  };

  const pasteFromClipboard = () => {
    const nodes = copyRef.current;
    if (!nodes || !nodes.length) return;
    if (readOnly) return;
    const d = docRef.current;
    if (!d) return;
    const maxNew = MAX_NODES - d.nodes.length;
    if (maxNew <= 0) { setNotice(`Canvas limit reached (${MAX_NODES} nodes)`); return; }
    const budget = Math.min(nodes.length, maxNew);
    if (budget < nodes.length) setNotice(`Canvas limit — pasted ${budget} of ${nodes.length}`);
    const off = 24 + pasteCountRef.current * 20;
    pasteCountRef.current += 1;
    const newIds: string[] = [];
    const newNodes: CanvasNode[] = nodes.slice(0, budget).map((n) => {
      const id = freshId('n');
      newIds.push(id);
      return { ...n, id, x: n.x + off, y: n.y + off };
    });
    mutate((prev) => ({ ...prev, nodes: [...prev.nodes, ...newNodes] }));
    setSelNodes(newIds);
  };

  const patchNode = (id: string, patch: Partial<CanvasNode>, withHistory = true) => {
    mutate(
      (d) => ({ ...d, nodes: d.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) }),
      withHistory
    );
  };

  const setColor = (nodeId: string, color: CanvasColor) => patchNode(nodeId, { color });

  const addNode = (type: CanvasNodeType) => {
    if (docRef.current && docRef.current.nodes.length >= MAX_NODES) {
      setNotice(`Canvas limit reached (${MAX_NODES} nodes)`);
      return;
    }
    const el = containerRef.current;
    const r = el?.getBoundingClientRect();
    const cx = r ? (r.width / 2 - viewRef.current.x) / viewRef.current.z : 60;
    const cy = r ? (r.height / 2 - viewRef.current.y) / viewRef.current.z : 60;
    const id = freshId('n');
    const node: CanvasNode = {
      id,
      type,
      text: '',
      x: cx - 110,
      y: cy - 50,
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
    if (d && d.edges.length >= MAX_EDGES) {
      setNotice(`Edge limit reached (${MAX_EDGES} edges)`);
      return;
    }
    mutate((d) => ({ ...d, edges: [...d.edges, { id: freshId('e'), from, to }] }));
  };

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

  // ── seed from project notes ──────────────────────────────────
  const seedFromNotes = async () => {
    try {
      const { items } = await getProjectNotes(slug);
      const budget = MAX_NODES - (docRef.current?.nodes.length || 0);
      if (budget <= 0) {
        setNotice(`Canvas limit reached (${MAX_NODES} nodes)`);
        return;
      }
      const open = items.filter((n) => !n.done).slice(0, Math.min(12, budget));
      if (!open.length) {
        setNotice('No open notes to import');
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
      setNotice(`Imported ${nodes.length} note(s) from the Notes tab`);
    } catch (err: any) {
      setNotice(err.message || 'Could not import notes');
    }
  };

  // ── view helpers ─────────────────────────────────────────────
  const setViewState = (v: ViewState) => {
    viewRef.current = v;
    setView(v);
  };

  const zoomBy = (factor: number, anchor?: { sx: number; sy: number }) => {
    const v = viewRef.current;
    const nz = clamp(v.z * factor, MIN_Z, MAX_Z);
    const r = containerRef.current?.getBoundingClientRect();
    const sx = anchor?.sx ?? (r ? r.width / 2 : 0);
    const sy = anchor?.sy ?? (r ? r.height / 2 : 0);
    setViewState({
      z: nz,
      x: sx - ((sx - v.x) * nz) / v.z,
      y: sy - ((sy - v.y) * nz) / v.z,
    });
  };

  const fitView = () => {
    const d = docRef.current;
    const r = containerRef.current?.getBoundingClientRect();
    if (!d || !d.nodes.length) {
      setViewState({ x: 40, y: 40, z: 1 });
      return;
    }
    const minX = Math.min(...d.nodes.map((n) => n.x));
    const minY = Math.min(...d.nodes.map((n) => n.y));
    const maxX = Math.max(...d.nodes.map((n) => n.x + n.w));
    const maxY = Math.max(...d.nodes.map((n) => n.y + n.h));
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

  // ── wheel zoom (non-passive so we can preventDefault) ───────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest?.('textarea')) return;
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, { sx: e.clientX, sy: e.clientY });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // ── global keyboard (undo/redo/delete/shortcuts) ────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const meta = e.ctrlKey || e.metaKey;
      if (meta && (e.key === 'z' || e.key === 'Z' || e.key === 'y' || e.key === 'Y')) {
        e.preventDefault();
        if ((e.key === 'y' || e.key === 'Y') || e.shiftKey) redo();
        else undo();
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
      if (readOnly) return;
      if (e.key === ' ') {
        e.preventDefault();
        setSpaceHeld(true);
        return;
      }
      if (e.key === 'n' || e.key === 'N') addNode('note');
      else if (e.key === 'c' || e.key === 'C') addNode('card');
      else if (e.key === 'l' || e.key === 'L') {
        if (selNode) setConnectFrom(selNode);
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
  }, [readOnly, selNodes, selEdge, editing, connectFrom]);

  // ── pointer interactions (delegated to the canvas root) ─────
  const onPointerDown = (e: any) => {
    const el = containerRef.current;
    if (!el) return;
    const target = e.target as HTMLElement;
    const nodeEl = (target as Element).closest?.('.cn-node');
    const edgeEl = (target as Element).closest?.('.cn-edge');

    if (e.button === 2) return;

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
        if (connectFrom !== id) addEdge(connectFrom, id);
        setConnectFrom(null);
        return;
      }
      if (readOnly) {
        setSelNodes([id]);
        setSelEdge(null);
        return;
      }
      setSelNodes([id]);
      setSelEdge(null);
      if (e.button === 0) {
        // Don't push history on pointer-down: a plain click (no movement)
        // must not leave an empty undo entry. Stage the pre-drag snapshot
        // instead; endDrag appends it only when the node actually moved.
        dragRef.current = {
          kind: 'node',
          ids: [id],
          startPos: { [id]: { x: node.x, y: node.y } },
          cX: e.clientX,
          cY: e.clientY,
          startX: node.x,
          startY: node.y,
          moved: false,
          pre: JSON.stringify(docRef.current),
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
    if (e.button === 0 || e.button === 1 || spaceHeld) {
      dragRef.current = {
        kind: 'pan',
        cX: e.clientX,
        cY: e.clientY,
        startX: viewRef.current.x,
        startY: viewRef.current.y,
      };
      el.setPointerCapture(e.pointerId);
    }
    if (e.button === 0) {
      setSelNodes([]);
      setSelEdge(null);
      setMenuOpen(false);
    }
  };

  const onPointerMove = (e: any) => {
    const dr = dragRef.current;
    if (!dr) return;
    const dx = e.clientX - dr.cX;
    const dy = e.clientY - dr.cY;
    if (dr.kind === 'pan') {
      setViewState({ ...viewRef.current, x: dr.startX + dx, y: dr.startY + dy });
    } else if (dr.ids && dr.ids.length) {
      if (!dr.moved && Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
      const z = viewRef.current.z;
      dr.moved = true;
      // Patch every dragged node's DOM element directly — no full-board
      // re-render (setDoc) on pointermove. Edges catch up on release.
      for (const id of dr.ids) {
        const sp = dr.startPos?.[id];
        const node = docRef.current?.nodes.find((n) => n.id === id);
        if (!sp || !node) continue;
        const nx = sp.x + dx / z;
        const ny = sp.y + dy / z;
        node.x = nx;
        node.y = ny;
        const el = containerRef.current?.querySelector<HTMLElement>(`.cn-node[data-id="${id}"]`);
        if (el) {
          el.style.left = `${nx}px`;
          el.style.top = `${ny}px`;
        }
      }
    }
  };

  const endDrag = (e: any) => {
    const dr = dragRef.current;
    dragRef.current = null;
    try {
      (e.target as Element).closest?.('.canvas-root')?.releasePointerCapture?.(e.pointerId);
    } catch {
      /* already released */
    }
    if (!dr || dr.kind !== 'node' || !dr.ids?.length || !dr.moved) return;
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
    const next = { ...cur, nodes: cur.nodes.map((n) => n) };
    docRef.current = next;
    setDoc(next);
    scheduleSave();
  };

  // ── editing (inline textarea) ───────────────────────────────
  const startEdit = (id: string) => {
    if (readOnly) return;
    pushHistory(); // snapshot once, THEN stream keystrokes without history spam
    setEditing(id);
  };
  const commitEdit = () => {
    setEditing(null);
  };
  const onEditorKey = (e: any) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      (e.currentTarget as HTMLTextAreaElement).blur();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      (e.currentTarget as HTMLTextAreaElement).blur();
    }
  };

  const toggleDone = (id: string, done: boolean) => patchNode(id, { done });

  if (loadError) {
    return (
      <div class="panel" style="margin-top: 8px">
        <div class="empty-state">
          <div style="color: var(--danger); margin-bottom: 8px">Could not load canvas</div>
          <div class="dim">{loadError}</div>
          <button class="btn-ghost sm" style="margin-top: 12px" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }

  const selected = selNode ? (doc?.nodes.find((n) => n.id === selNode) ?? null) : null;
  const nodeById = (id: string) => doc?.nodes.find((n) => n.id === id);

  const renderEdges = () => {
    if (!doc || !doc.edges.length) return null;
    return (
      <svg class="cn-svg" aria-hidden="true">
        <defs>
          <marker id={`arrow-${slug}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--text-3)" />
          </marker>
        </defs>
        {doc.edges.map((edge) => {
          const a = nodeById(edge.from);
          const b = nodeById(edge.to);
          if (!a || !b) return null;
          const x1 = a.x + a.w / 2;
          const y1 = a.y + a.h / 2;
          const x2 = b.x + b.w / 2;
          const y2 = b.y + b.h / 2;
          const selectedLine = selEdge === edge.id;
          return (
            <g key={edge.id}>
              <line
                class="cn-edge"
                data-id={edge.id}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke="transparent"
                stroke-width="16"
                style="pointer-events: stroke; cursor: pointer"
                onPointerDown={(e: any) => {
                  e.stopPropagation();
                  if (readOnly) return;
                  setSelEdge(edge.id);
                  setSelNodes([]);
                }}
              />
              <line
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke={selectedLine ? 'var(--accent)' : 'var(--text-3)'}
                stroke-width={selectedLine ? 2.5 : 1.5}
                marker-end={`url(#arrow-${slug})`}
                style="pointer-events: none"
              />
            </g>
          );
        })}
      </svg>
    );
  };

  return (
    <div class="canvas-wrap">
      <h2 class="panel-title" style="display:flex;align-items:center;gap:6px">
        Planning canvas
        {!readOnly && <span class="dim" style="font-weight:400;font-size:0.7rem">— drag nodes, double-click to edit, Ctrl+Z to undo</span>}
      </h2>
      {/* Top toolbar: view controls + mode + save status */}
      <div class="cn-toolbar">
        <div class="cn-tb-group">
          <button class="cn-tb-btn" title="Zoom out (scroll to zoom)" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.2)}>
            <ZoomOut width={15} height={15} />
          </button>
          <button class="cn-tb-btn" title="Zoom in" aria-label="Zoom in" onClick={() => zoomBy(1.2)}>
            <ZoomIn width={15} height={15} />
          </button>
          <button class="cn-tb-btn" title="Fit all nodes" aria-label="Fit all nodes" onClick={fitView}>
            <Maximize width={14} height={14} />
          </button>
        </div>
        <div class="cn-tb-group">
          <button class="cn-tb-btn" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!canUndo} onClick={undo}>
            <Undo2 width={14} height={14} />
          </button>
          <button class="cn-tb-btn" title="Redo (Ctrl+Shift+Z)" aria-label="Redo" disabled={!canRedo} onClick={redo}>
            <Redo2 width={14} height={14} />
          </button>
        </div>
        <div class="cn-tb-group">
          <button class={`cn-tb-btn ${connectFrom ? 'cn-active' : ''}`} title="Connect nodes (select source, then target)" aria-label="Connect nodes" aria-pressed={!!connectFrom} disabled={readOnly || !selNode} onClick={() => setConnectFrom(connectFrom ? null : selNode)}>
            <Link2 width={15} height={15} />
            {connectFrom ? <span class="cn-tb-hint">pick target</span> : null}
          </button>
          {readOnly && (
            <span class="cn-ro-chip" title="Your role can only view this canvas" role="status">
              <Lock width={11} height={11} /> Read-only
            </span>
          )}
        </div>
        <div class="cn-tb-spacer" />
        <div class="cn-save-state" role="status">
          {saveState === 'saving' && <span class="dim">Saving…</span>}
          {saveState === 'dirty' && <span class="dim">Unsaved changes</span>}
          {saveState === 'saved' && savedAt && <span class="dim">Saved {savedAt}</span>}
          {saveError ? <span class="cn-save-err">{saveError}</span> : null}
        </div>
      </div>

      {/* Selection toolbar (active while a node is selected) */}
      {selected && !readOnly && (
        <div class="cn-selbar">
          {COLORS.map((c) => (
            <button
              key={c}
              class={`cn-dot c-${c} ${selected.color === c ? 'cn-dot-active' : ''}`}
              title={`${c} color`}
              aria-label={`${c} color`}
              aria-pressed={selected.color === c}
              onClick={() => setColor(selected.id, c)}
            />
          ))}
          <span class="cn-sel-sep" />
          <button class="cn-tb-btn" title="Duplicate (Ctrl+D)" aria-label="Duplicate selected" onClick={duplicateSelected}>
            <CopyPlus width={14} height={14} />
          </button>
          <button class="cn-tb-btn" title="Copy (Ctrl+C)" aria-label="Copy selected" onClick={copySelected}>
            <Copy width={14} height={14} />
          </button>
          <button class="cn-tb-btn" title="Delete (Del)" aria-label="Delete selected" onClick={removeSelected}>
            <Trash2 width={14} height={14} />
          </button>
        </div>
      )}
      {connectFrom && (
        <div class="cn-connecting" role="status">
          <MousePointer2 width={12} height={12} /> Click the target node to connect
        </div>
      )}

      {/* Add menu */}
      {!readOnly && (
        <div class="cn-add-wrap">
          <div class={`cn-add-menu ${menuOpen ? 'open' : ''}`}>
            <button class="cn-add-item" aria-label="Add sticky note" onClick={() => addNode('note')}>
              <StickyNote width={15} height={15} /> Sticky note <span class="dim">N</span>
            </button>
            <button class="cn-add-item" aria-label="Add task card" onClick={() => addNode('card')}>
              <CheckSquare width={15} height={15} /> Task card <span class="dim">C</span>
            </button>
            <button class="cn-add-item" aria-label="Add arrow" onClick={() => { if (selNode) { setConnectFrom(selNode); setMenuOpen(false); } else setMenuOpen(false); }}>
              <Link2 width={15} height={15} /> Arrow <span class="dim">L</span>
            </button>
            <button class="cn-add-item" aria-label="Seed canvas from notes" onClick={() => { seedFromNotes(); setMenuOpen(false); }}>
              <Sparkles width={15} height={15} /> Seed from notes
            </button>
          </div>
          <button class="cn-add-fab" title="Add to canvas" aria-label="Add to canvas" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}>
            <Plus width={18} height={18} />
          </button>
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
        onContextMenu={(e: any) => e.preventDefault()}
      >
        <div
          class="cn-world"
          style={`transform: translate3d(${view.x}px, ${view.y}px, 0) scale(${view.z}); transform-origin: 0 0;`}
        >
          {renderEdges()}
          {doc?.nodes.map((n) => {
            const isSel = selNodes.includes(n.id);
            const isEditing = editing === n.id;
            return (
              <div
                key={n.id}
                class={`cn-node ${n.type} c-${n.color} ${isSel ? 'cn-selected' : ''} ${connectFrom === n.id ? 'cn-connect-src' : ''} ${connectFrom && connectFrom !== n.id ? 'cn-connectable' : ''}`}
                data-id={n.id}
                style={`left: ${n.x}px; top: ${n.y}px; width: ${n.w}px; height: ${n.h}px;`}
                onDblClick={() => { if (!readOnly) startEdit(n.id); }}
              >
                {n.type === 'card' && !isEditing && (
                  <button
                    class={`cn-check ${n.done ? 'done' : ''}`}
                    type="button"
                    title={n.done ? 'Mark not done' : 'Mark done'}
                    aria-label={n.done ? 'Mark not done' : 'Mark done'}
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
                    value={n.text}
                    autofocus
                    placeholder={n.type === 'card' ? 'Task description…' : 'Type your note…'}
                    onInput={(e: any) => patchNode(n.id, { text: e.currentTarget.value }, false)}
                    onBlur={commitEdit}
                    onKeyDown={onEditorKey}
                    onClick={(e: any) => e.stopPropagation()}
                    onPointerDown={(e: any) => e.stopPropagation()}
                  />
                ) : (
                  <div class="cn-text">{n.text || <span class="cn-placeholder">Double-click to edit</span>}</div>
                )}
                {!isEditing && !readOnly && (
                  <div class="cn-node-colors">
                    {COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        class={`cn-dot s c-${c} ${n.color === c ? 'cn-dot-active' : ''}`}
                        aria-label={`Set ${c} color`}
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
              </div>
            );
          })}
        </div>

        {loaded && doc && doc.nodes.length === 0 && (
          <div
            class="cn-empty"
            role="button"
            tabIndex={0}
            aria-label="Add to canvas"
            onClick={() => setMenuOpen(true)}
            onKeyDown={(e: KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setMenuOpen(true);
              }
            }}
          >
            <div class="cn-empty-icon">✸</div>
            <div class="cn-empty-title">An empty board for your big ideas</div>
            <div class="cn-empty-sub">
              Drop sticky notes, task cards, or link them with arrows. Press Enter to add your first item — or use <b>N</b> / <b>C</b> to create a note or card.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}