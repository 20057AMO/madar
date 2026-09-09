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
  X,
  Pencil,
  ClipboardPaste,
  Maximize2,
  Minimize2,
} from 'lucide-preact';
import {
  getProjectCanvas,
  saveProjectCanvas,
  getProjectNotes,
} from '../api';
import type { CanvasNode, CanvasColor, ProjectCanvas, CanvasNodeType, CanvasEdge, CanvasSection } from '../api';
import { ConfirmModal } from './ConfirmModal';

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
  const wrapRef = useRef<HTMLDivElement>(null as HTMLDivElement | null);
  const [doc, setDoc] = useState<ProjectCanvas | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<'dirty' | 'saving' | 'saved'>('saved');
  const [savedAt, setSavedAt] = useState('');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; nodeId?: string; edgeId?: string } | null>(null);

  const [selNodes, setSelNodes] = useState<string[]>([]);
  const [selEdge, setSelEdge] = useState<string | null>(null);
  // Primary (first) selected node — most UI reads only the head of the set.
  const selNode = selNodes[0] ?? null;
  const [editing, setEditing] = useState<string | null>(null);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const [addSectionOpen, setAddSectionOpen] = useState(false);
  const [confirmDelSection, setConfirmDelSection] = useState<string | null>(null);
  /** Cascade counter so rapid adds never stack new nodes on the viewport center. */
  const addSeqRef = useRef(0);
  const nodeElsRef = useRef(new Map<string, HTMLElement>());
  const panFrameRef = useRef<number | null>(null);
  const pendingPanRef = useRef<{ x: number; y: number } | null>(null);

  const [view, setView] = useState<ViewState>({ x: 40, y: 40, z: 1 });
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const docRef = useRef<ProjectCanvas | null>(null);
  const viewRef = useRef<ViewState>(view);
  const slugRef = useRef<string>(slug);
  const saveTimer = useRef<number | null>(null);
  const dirtyRef = useRef(false);
  const revisionRef = useRef(0);
  const dragRef = useRef<null | {
    kind: 'node' | 'pan' | 'resize' | 'marquee';
    ids?: string[];
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
    /** True once a real movement (beyond the click threshold) happened. */
    moved?: boolean;
    /** Pre-drag document snapshot — only appended to history if we moved. */
    pre?: string;
  }>(null);

  // ── load ─────────────────────────────────────────────────────
  useEffect(() => {
    if (saveTimer.current !== null) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    slugRef.current = slug;
    docRef.current = null;
    setDoc(null);
    setLoaded(false);
    setLoadError(null);
    setSaveError(null);
    setSaveState('saved');
    setSavedAt('');
    setSelNodes([]);
    setSelEdge(null);
    setEditing(null);
    setConnectFrom(null);
    setMenuOpen(false);
    dragRef.current = null;
    addSeqRef.current = 0;
    histRef.current = [];
    redoRef.current = [];
    setCanUndo(false);
    setCanRedo(false);
    dirtyRef.current = false;
    revisionRef.current += 1;
    viewRef.current = { x: 40, y: 40, z: 1 };
    setView(viewRef.current);
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
    const saveRevision = revisionRef.current;
    const saveSlug = slugRef.current;
    const payload = JSON.parse(JSON.stringify(d)) as ProjectCanvas;
    dirtyRef.current = false;
    setSaveState('saving');
    saveProjectCanvas(saveSlug, payload)
      .then((saved) => {
        if (slugRef.current === saveSlug && revisionRef.current === saveRevision && docRef.current === d) {
          docRef.current = saved;
          setDoc(saved);
          setSaveState('saved');
          setSavedAt(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
          setSaveError(null);
        }
      })
      .catch((err: any) => {
        if (slugRef.current === saveSlug && revisionRef.current === saveRevision) {
          dirtyRef.current = true;
          setSaveState('dirty');
          setSaveError(err.message || 'Save failed');
        }
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
    revisionRef.current += 1;
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
    if (maxNew <= 0) { setNotice(`Canvas limit reached (${MAX_NODES} nodes)`); return; }
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
    void navigator.clipboard.writeText(JSON.stringify({ nodes, edges })).catch(() => {
      /* in-memory copy remains available */
    });
    pasteCountRef.current = 0;
    setNotice(`Copied ${nodes.length} node(s)`);
  };

  /** Core paste logic — shared by the keyboard shortcut and context menu. */
  const doPaste = (payload: { nodes: CanvasNode[]; edges: CanvasEdge[] }) => {
    if (readOnly) return;
    const d = docRef.current;
    if (!d) return;
    const { nodes, edges } = payload;
    if (!nodes.length) return;
    const maxNew = MAX_NODES - d.nodes.length;
    if (maxNew <= 0) { setNotice(`Canvas limit reached (${MAX_NODES} nodes)`); return; }
    const budget = Math.min(nodes.length, maxNew);
    if (budget < nodes.length) setNotice(`Canvas limit — pasted ${budget} of ${nodes.length}`);
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
        // Accept both the new {nodes, edges} shape and the legacy nodes-only array.
        if (Array.isArray(parsed)) {
          doPaste({ nodes: parsed as CanvasNode[], edges: [] });
          return;
        }
        if (Array.isArray(parsed?.nodes)) {
          doPaste({ nodes: parsed.nodes, edges: parsed.edges ?? [] });
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

  const addNode = (type: CanvasNodeType) => {
    if (docRef.current && docRef.current.nodes.length >= MAX_NODES) {
      setNotice(`Canvas limit reached (${MAX_NODES} nodes)`);
      return;
    }
    const el = containerRef.current;
    const r = el?.getBoundingClientRect();
    const cx = r ? (r.width / 2 - viewRef.current.x) / viewRef.current.z : 60;
    const cy = r ? (r.height / 2 - viewRef.current.y) / viewRef.current.z : 60;
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
      textX: 10,
      textY: 10,
      textSize: 14,
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

  // ── sections (swimlanes) ────────────────────────────────────
  const MAX_SECTIONS = 12;
  const addSection = (name: string) => {
    const cur = docRef.current;
    if (cur && (cur.sections?.length ?? 0) >= MAX_SECTIONS) {
      setNotice(`Limit reached (${MAX_SECTIONS} sections)`);
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
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  useEffect(() => () => {
    if (panFrameRef.current !== null) cancelAnimationFrame(panFrameRef.current);
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
      resize: { id, w: node.w, h: node.h, pre: JSON.stringify(docRef.current) },
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

  const flushPendingPan = () => {
    if (panFrameRef.current !== null) {
      cancelAnimationFrame(panFrameRef.current);
      panFrameRef.current = null;
    }
    const pending = pendingPanRef.current;
    pendingPanRef.current = null;
    if (pending) setViewState({ ...viewRef.current, x: pending.x, y: pending.y });
  };

  const resetZoom = () => {
    const v = viewRef.current;
    setViewState({ ...v, z: 1 });
  };

  const resetView = () => {
    setViewState({ x: 40, y: 40, z: 1 });
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
      const r = containerRef.current?.getBoundingClientRect();
      zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, {
        sx: e.clientX - (r?.left ?? 0),
        sy: e.clientY - (r?.top ?? 0),
      });
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

    // Commit the open text editor on any pointer-down outside the node being
    // edited — clicking another node, the background or a section must close it.
    if (editing && nodeEl?.getAttribute('data-id') !== editing) {
      setEditing(null);
    }

    if (e.button === 2) return;

    // ── Fix: Space held → always pan, even if clicking over a node ──────────
    if (e.button === 0 && spaceHeld) {
      dragRef.current = {
        kind: 'pan',
        cX: e.clientX,
        cY: e.clientY,
        startX: viewRef.current.x,
        startY: viewRef.current.y,
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
        if (connectFrom !== id) addEdge(connectFrom, id);
        setConnectFrom(null);
        return;
      }
      if (readOnly) {
        setSelNodes([id]);
        setSelEdge(null);
        return;
      }

      // ── Fix: Multi-selection drag ──────────────────────────────────────────
      // If the clicked node is already in the current selection keep all of
      // them selected so the drag moves the whole group. Otherwise reset to
      // just the clicked node (normal single-click behaviour).
      const isInSel = selNodes.includes(id);
      const dragIds = isInSel && selNodes.length > 1 ? selNodes : [id];

      if (!isInSel) setSelNodes([id]);
      setSelEdge(null);

      if (e.button === 0) {
        // Build startPos for every node that will be dragged.
        const startPos: Record<string, { x: number; y: number }> = {};
        for (const nid of dragIds) {
          const n = docRef.current?.nodes.find((nn) => nn.id === nid);
          if (n) startPos[nid] = { x: n.x, y: n.y };
        }
        dragRef.current = {
          kind: 'node',
          ids: dragIds,
          startPos,
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
    if (e.button === 1 || e.button === 2) {
      dragRef.current = {
        kind: 'pan',
        cX: e.clientX,
        cY: e.clientY,
        startX: viewRef.current.x,
        startY: viewRef.current.y,
      };
      el.setPointerCapture(e.pointerId);
    } else if (e.button === 0) {
      // Drag the empty canvas to pan. Hold Shift for marquee selection.
      const { x, y, z } = viewRef.current;
      const rr = containerRef.current?.getBoundingClientRect();
      const ox = rr ? rr.left : 0;
      const oy = rr ? rr.top : 0;
      const sx = (e.clientX - ox - x) / z;
      const sy = (e.clientY - oy - y) / z;
      dragRef.current = e.shiftKey
        ? {
            kind: 'marquee',
            cX: e.clientX,
            cY: e.clientY,
            startX: sx,
            startY: sy,
            endX: sx,
            endY: sy,
            moved: false,
            pre: JSON.stringify(docRef.current),
          }
        : {
            kind: 'pan',
            cX: e.clientX,
            cY: e.clientY,
            startX: viewRef.current.x,
            startY: viewRef.current.y,
          };
      el.setPointerCapture(e.pointerId);
      if (e.shiftKey) {
        setSelNodes([]);
        setSelEdge(null);
      }
      setMenuOpen(false);
    }
  };

  const onPointerMove = (e: any) => {
    const dr = dragRef.current;
    if (!dr) return;
    const dx = e.clientX - dr.cX;
    const dy = e.clientY - dr.cY;
    if (dr.kind === 'pan') {
      pendingPanRef.current = { x: dr.startX + dx, y: dr.startY + dy };
      if (panFrameRef.current === null) {
        panFrameRef.current = requestAnimationFrame(() => {
          panFrameRef.current = null;
          const pending = pendingPanRef.current;
          pendingPanRef.current = null;
          if (!pending) return;
          setViewState({ ...viewRef.current, x: pending.x, y: pending.y });
        });
      }
    } else if (dr.kind === 'marquee') {
      const { x, y, z } = viewRef.current;
      const rr = containerRef.current?.getBoundingClientRect();
      const ox = rr ? rr.left : 0;
      const oy = rr ? rr.top : 0;
      const ex = (e.clientX - ox - x) / z;
      const ey = (e.clientY - oy - y) / z;
      if (!dr.moved && Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
      dr.moved = true;
      dr.endX = ex;
      dr.endY = ey;
      const marq = document.querySelector('.cn-marquee');
      if (marq) {
        const sx = Math.min(dr.startX, ex);
        const sy = Math.min(dr.startY, ey);
        const sw = Math.abs(ex - dr.startX);
        const sh = Math.abs(ey - dr.startY);
        marq.setAttribute('x', String(sx));
        marq.setAttribute('y', String(sy));
        marq.setAttribute('width', String(sw));
        marq.setAttribute('height', String(sh));
      }
    } else if (dr.kind === 'resize' && dr.resize) {
      if (!dr.moved && Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
      const z = viewRef.current.z;
      dr.moved = true;
      const nw = clamp(dr.startX + dx / z, 60, 900);
      const nh = clamp(dr.startY + dy / z, 40, 900);
      const node = docRef.current?.nodes.find((n) => n.id === dr.resize!.id);
      if (!node) return;
      node.w = nw;
      node.h = nh;
      const el = nodeElsRef.current.get(dr.resize.id);
      if (el) {
        el.style.width = `${nw}px`;
        el.style.height = `${nh}px`;
      }
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
        const el = nodeElsRef.current.get(id);
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
    if (!dr) return;
    if (dr.kind === 'pan') flushPendingPan();
    if (dr.kind === 'marquee') {
      const marq = document.querySelector('.cn-marquee');
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
        revisionRef.current += 1;
        scheduleSave();
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
    const next = {
      ...cur,
      nodes: cur.nodes.map((n) =>
        dr!.ids!.includes(n.id)
          ? { ...n, x: snapCoord(n.x), y: snapCoord(n.y) }
          : n
      ),
    };
    docRef.current = next;
    setDoc(next);
    revisionRef.current += 1;
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
    // Hide edges touching a collapsed section.
    const hidden = new Set(
      doc.nodes.filter((n) => n.section && collapsedSections.has(n.section)).map((n) => n.id)
    );
    const visible = doc.edges.filter((e) => !hidden.has(e.from) && !hidden.has(e.to));
    if (!visible.length) return null;
    // Pre-compute a world→SVG path for every edge between live nodes.
    const edgePath = (edge: CanvasEdge): string | null => {
      const a = nodeById(edge.from);
      const b = nodeById(edge.to);
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
        <rect class="cn-marquee" x="0" y="0" width="0" height="0" display="none" />
      </svg>
    );
  };

  return (
    <div class={`canvas-wrap ${isFullscreen ? 'cn-fullscreen' : ''}`} ref={wrapRef}>
      <div class="cn-heading">
        <div>
          <h2 class="panel-title">Planning canvas</h2>
          <p class="cn-heading-help">
            {!readOnly
              ? 'Drag to pan · Shift+drag to select · Double-click to edit'
              : 'View-only canvas · Drag to pan and scroll to zoom'}
          </p>
        </div>
        <div class="cn-heading-meta">
          <span class="cn-board-stat">{doc?.nodes.length ?? 0} {doc?.nodes.length === 1 ? 'item' : 'items'}</span>
          {isFullscreen && <span class="cn-fullscreen-label">Focus mode</span>}
        </div>
      </div>
      {/* Top toolbar: view controls + mode + save status */}
      <div class={`cn-toolbar ${isFullscreen ? 'cn-toolbar-floating' : ''}`}>
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
          <button class="cn-tb-btn cn-zoom-btn" title={`Zoom: ${Math.round(view.z * 100)}% — click to reset to 100%`} aria-label={`Zoom ${Math.round(view.z * 100)}%`} onClick={resetZoom}>
            {Math.round(view.z * 100)}%
          </button>
          <button class="cn-tb-btn" title="Reset view (Home)" aria-label="Reset view" onClick={resetView}>
            <Home width={14} height={14} />
          </button>
          <button class="cn-tb-btn" title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'} aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'} onClick={toggleFullscreen}>
            {isFullscreen ? <Minimize2 width={15} height={15} /> : <Maximize2 width={15} height={15} />}
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
          {!readOnly && (
            <button class="cn-tb-btn" title="Add a horizontal section (swimlane)" aria-label="Add section" onClick={() => setAddSectionOpen(true)}>
              <Rows3 width={15} height={15} />
              {addSectionOpen ? <span class="cn-tb-hint">name</span> : null}
            </button>
          )}
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

      {/* Sections (swimlanes) bar */}
      {(doc?.sections?.length || addSectionOpen) && (
        <div class="cn-sections-bar">
          {doc?.sections?.map((s) => {
            const collapsed = collapsedSections.has(s.id);
            const count = doc.nodes.filter((n) => n.section === s.id).length;
            return (
              <span key={s.id} class={`cn-section-chip c-${s.color}`}>
                <button class="cn-section-toggle" aria-label={collapsed ? 'Expand section' : 'Collapse section'} onClick={() => toggleSection(s.id)}>
                  {collapsed ? <ChevronRight width={12} height={12} /> : <ChevronDown width={12} height={12} />}
                </button>
                <span class="cn-section-name">{s.name}</span>
                <span class="cn-section-count">{count}</span>
                {!readOnly && (
                  <button class="cn-section-del" aria-label={`Delete section ${s.name}`} onClick={() => setConfirmDelSection(s.id)}>
                    <X width={12} height={12} />
                  </button>
                )}
              </span>
            );
          })}
          {addSectionOpen && (
            <span class="cn-section-add">
              <input
                autoFocus
                class="cn-section-input"
                placeholder="Section name"
                aria-label="New section name"
                onKeyDown={(e: any) => {
                  if (e.key === 'Enter') addSection(e.currentTarget.value);
                  if (e.key === 'Escape') setAddSectionOpen(false);
                }}
                onBlur={() => setAddSectionOpen(false)}
              />
              <button class="cn-section-ok" aria-label="Create section" onClick={(e) => {
                const inp = (e.currentTarget.parentElement as HTMLElement).querySelector('.cn-section-input') as HTMLInputElement;
                if (inp) addSection(inp.value);
              }}>
                <Plus width={14} height={14} />
              </button>
            </span>
          )}
        </div>
      )}

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
          <label class="cn-text-control">
            <span>Size</span>
            <input
              type="number"
              min="10"
              max="48"
              step="1"
              value={selected.textSize ?? 14}
              aria-label="Text size"
              onPointerDown={(e: any) => e.stopPropagation()}
              onChange={(e: any) => patchNode(selected.id, { textSize: clamp(Number(e.currentTarget.value) || 14, 10, 48) })}
            />
          </label>
          <label class="cn-text-control">
            <span>X</span>
            <input
              type="number"
              min="0"
              max={Math.max(0, selected.w - 20)}
              step="1"
              value={Math.round(selected.textX ?? 10)}
              aria-label="Text horizontal position"
              onPointerDown={(e: any) => e.stopPropagation()}
              onChange={(e: any) => patchNode(selected.id, { textX: clamp(Number(e.currentTarget.value) || 0, 0, Math.max(0, selected.w - 20)) })}
            />
          </label>
          <label class="cn-text-control">
            <span>Y</span>
            <input
              type="number"
              min="0"
              max={Math.max(0, selected.h - 20)}
              step="1"
              value={Math.round(selected.textY ?? 10)}
              aria-label="Text vertical position"
              onPointerDown={(e: any) => e.stopPropagation()}
              onChange={(e: any) => patchNode(selected.id, { textY: clamp(Number(e.currentTarget.value) || 0, 0, Math.max(0, selected.h - 20)) })}
            />
          </label>
          {doc?.sections?.length ? (
            <select
              class="cn-section-select"
              title="Move node to section"
              aria-label="Move selected node to section"
              value={selected.section ?? ''}
              onPointerDown={(e: any) => e.stopPropagation()}
              onClick={(e: any) => e.stopPropagation()}
              onChange={(e: any) => {
                e.stopPropagation();
                setNodeSection(selected.id, e.currentTarget.value || undefined);
              }}
            >
              <option value="">No section</option>
              {doc.sections.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          ) : null}
          <span class="cn-sel-sep" />
          <button class="cn-tb-btn" title="Bring to front" aria-label="Bring selected to front" onClick={bringToFront}>
            <BringToFront width={14} height={14} />
          </button>
          <button class="cn-tb-btn" title="Send to back" aria-label="Send selected to back" onClick={sendToBack}>
            <SendToBack width={14} height={14} />
          </button>
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
      {selEdge && !readOnly && (
        <div class="cn-selbar cn-selbar-edge">
          <span class="cn-sel-label">Selected arrow</span>
          <span class="cn-sel-sep" />
          <button class="cn-tb-btn" title="Delete arrow (Del)" aria-label="Delete selected arrow" onClick={removeSelected}>
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

      {/* Right-click context menu */}
      {ctxMenu && (
        <div
          class="cn-ctx"
          role="menu"
          aria-label="Canvas menu"
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
                  <Pencil width={14} height={14} /> Edit
                </button>
              )}
              {!readOnly && (
                <button class="cn-ctx-item" role="menuitem" onClick={() => { setSelNodes([ctxMenu.nodeId!]); duplicateSelected(); closeCtxMenu(); }}>
                  <CopyPlus width={14} height={14} /> Duplicate <span class="dim">Ctrl+D</span>
                </button>
              )}
              {!readOnly && (
                <>
                  <button class="cn-ctx-item" role="menuitem" onClick={() => { setSelNodes([ctxMenu.nodeId!]); copySelected(); closeCtxMenu(); }}>
                    <Copy width={14} height={14} /> Copy <span class="dim">Ctrl+C</span>
                  </button>
                  <span class="cn-ctx-sep" />
                  <button class="cn-ctx-item" role="menuitem" onClick={() => { setSelNodes([ctxMenu.nodeId!]); bringToFront(); closeCtxMenu(); }}>
                    <BringToFront width={14} height={14} /> Bring to front
                  </button>
                  <button class="cn-ctx-item" role="menuitem" onClick={() => { setSelNodes([ctxMenu.nodeId!]); sendToBack(); closeCtxMenu(); }}>
                    <SendToBack width={14} height={14} /> Send to back
                  </button>
                  <span class="cn-ctx-sep" />
                  <span class="cn-ctx-label">Color</span>
                  <span class="cn-ctx-colors">
                    {COLORS.map((c) => (
                      <button key={c} type="button" class={`cn-dot c-${c} ${doc?.nodes.find((n) => n.id === ctxMenu.nodeId)?.color === c ? 'cn-dot-active' : ''}`} aria-label={`${c} color`} onClick={() => { setColor(ctxMenu.nodeId!, c); closeCtxMenu(); }} />
                    ))}
                  </span>
                  {doc?.sections?.length ? (
                    <>
                      <span class="cn-ctx-label">Section</span>
                      <select class="cn-section-select cn-ctx-select" value={doc.nodes.find((n) => n.id === ctxMenu.nodeId)?.section ?? ''} onClick={(e: any) => e.stopPropagation()} onChange={(e: any) => { setNodeSection(ctxMenu.nodeId!, e.currentTarget.value || undefined); closeCtxMenu(); }}>
                        <option value="">No section</option>
                        {doc.sections.map((s) => (
                          <option key={s.id} value={s.id}>{s.name}</option>
                        ))}
                      </select>
                    </>
                  ) : null}
                  <span class="cn-ctx-sep" />
                  <button class="cn-ctx-item cn-ctx-danger" role="menuitem" onClick={() => { removeNode(ctxMenu.nodeId!); closeCtxMenu(); }}>
                    <Trash2 width={14} height={14} /> Delete
                  </button>
                </>
              )}
            </>
          ) : ctxMenu.edgeId ? (
            <>
              {!readOnly && (
                <button class="cn-ctx-item cn-ctx-danger" role="menuitem" onClick={() => { removeEdge(ctxMenu.edgeId!); closeCtxMenu(); }}>
                  <Trash2 width={14} height={14} /> Delete arrow
                </button>
              )}
            </>
          ) : (
            <>
              {!readOnly && (
                <button class="cn-ctx-item" role="menuitem" onClick={() => { addNode('note'); closeCtxMenu(); }}>
                  <StickyNote width={14} height={14} /> Sticky note <span class="dim">N</span>
                </button>
              )}
              {!readOnly && (
                <button class="cn-ctx-item" role="menuitem" onClick={() => { addNode('card'); closeCtxMenu(); }}>
                  <CheckSquare width={14} height={14} /> Task card <span class="dim">C</span>
                </button>
              )}
              {!readOnly && copyRef.current?.nodes.length ? (
                <button class="cn-ctx-item" role="menuitem" onClick={() => { pasteFromClipboard(); closeCtxMenu(); }}>
                  <ClipboardPaste width={14} height={14} /> Paste <span class="dim">Ctrl+V</span>
                </button>
              ) : null}
              <button class="cn-ctx-item" role="menuitem" onClick={() => { fitView(); closeCtxMenu(); }}>
                <Maximize width={14} height={14} /> Fit all nodes
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
        onPointerCancel={endDrag}
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
            const isSel = selNodes.includes(n.id);
            const isEditing = editing === n.id;
            return (
              <div
                key={n.id}
                class={`cn-node ${n.type} c-${n.color} ${isSel ? 'cn-selected' : ''} ${connectFrom === n.id ? 'cn-connect-src' : ''} ${connectFrom && connectFrom !== n.id ? 'cn-connectable' : ''}`}
                data-id={n.id}
                ref={(el: HTMLElement | null) => {
                  if (el) nodeElsRef.current.set(n.id, el);
                  else nodeElsRef.current.delete(n.id);
                }}
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
                    style={`left: ${n.textX ?? 10}px; top: ${n.textY ?? 10}px; width: calc(100% - ${(n.textX ?? 10) + 10}px); height: calc(100% - ${(n.textY ?? 10) + 10}px); font-size: ${n.textSize ?? 14}px;`}
                    onClick={(e: any) => e.stopPropagation()}
                    onPointerDown={(e: any) => e.stopPropagation()}
                  />
                ) : (
                  <div
                    class="cn-text"
                    style={`left: ${n.textX ?? 10}px; top: ${n.textY ?? 10}px; right: 10px; bottom: 10px; font-size: ${n.textSize ?? 14}px;`}
                  >
                    {n.text || <span class="cn-placeholder">Double-click to edit</span>}
                  </div>
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
                {isSel && !readOnly && (
                  <div
                    class="cn-resize-handle"
                    aria-hidden="true"
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
                    title="Drag to another node to connect"
                    aria-hidden="true"
                    onPointerDown={(e: any) => {
                      e.stopPropagation();
                      if (readOnly) return;
                      setConnectFrom(n.id);
                    }}
                  />
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
              Drag the board to pan, or hold <b>Shift</b> while dragging to select several items. Drop sticky notes, task cards, or link them with arrows. Press Enter to add your first item — or use <b>N</b> / <b>C</b> to create a note or card.
            </div>
          </div>
        )}
      </div>

      <ConfirmModal
        open={!!confirmDelSection}
        title={`Delete section '${doc?.sections?.find((s) => s.id === confirmDelSection)?.name ?? ''}'?`}
        message="Nodes inside it stay on the board but lose their section."
        confirmLabel="Delete section"
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