/**
 * project-canvas.ts
 * Madar — Per-project visual planning canvas stored as JSON under
 * WSD_DATA_DIR/projects/<slug>/canvas.json, next to notes.json.
 *
 * The document is intentionally dumb and portable:
 *   nodes: sticky notes ("note") and task cards ("card") at absolute
 *          world coordinates, plus edges: arrows between node ids.
 * The frontend renders pan/zoom/drag on top of this "camera-free" document,
 * so the whole canvas ships as a plain JSON payload (no transforms saved).
 */
import fs from 'fs';
import path from 'path';

import { withFileLock } from './write-queue';
import { invalidateProjectContext } from './project-context';
import { assertSafeStoreSlug } from './project-slug-core';
import { resolveContainedPath, writeContainedFile } from './workspace-paths-core';

const DATA_DIR = process.env.WSD_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const META_DIR = path.join(DATA_DIR, 'projects');
const WORKSPACES_ROOT = process.env.WSD_PROJECTS_DIR || '/workspaces';

/** Derived flat-text board kept in the project workspace so IDE + opencode
 *  agents can read the planning canvas (like WSD_PROJECT.md). A FIXED basename:
 *  no client-supplied name reaches the filesystem through it. */
const CANVAS_MIRROR_FILE = 'WSD_CANVAS.md';

export type CanvasNodeType = 'note' | 'card';
export type CanvasColor = 'yellow' | 'blue' | 'red' | 'green';

export interface CanvasNode {
  id: string;
  type: CanvasNodeType;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color: CanvasColor;
  done?: boolean;
  /** Optional swimlane/section id this node belongs to. */
  section?: string;
}

export interface CanvasEdge {
  id: string;
  from: string;
  to: string;
}

export interface CanvasSection {
  id: string;
  name: string;
  /** Swatch color for the section header/lane. */
  color: CanvasColor;
}

export interface ProjectCanvas {
  version: 1;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /** Optional horizontal swimlanes grouping nodes. */
  sections?: CanvasSection[];
  updatedAt: string | null;
}

export const MAX_NODES = 200;
export const MAX_EDGES = 400;
export const MAX_TEXT = 2000;
export const MAX_SECTIONS = 12;
/** Max ops per live-sync batch (≈ one drag, a marquee delete or a paste). */
export const MAX_OPS = 40;

// ── Live-sync differential ops ─────────────────────────────────
// Small per-action operations applied atomically to the stored document and
// broadcast to the canvas room, instead of re-uploading the whole board.
export interface CanvasNodePatch {
  text?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  color?: CanvasColor;
  done?: boolean;
  /** null clears the section; a string assigns it. */
  section?: string | null;
}

export type CanvasOp =
  | { op: 'node-add'; node: CanvasNode }
  | { op: 'node-patch'; id: string; patch: CanvasNodePatch }
  | { op: 'node-del'; id: string }
  | { op: 'edge-add'; edge: CanvasEdge }
  | { op: 'edge-del'; id: string }
  | { op: 'sec-add'; section: CanvasSection }
  | { op: 'sec-del'; id: string };

const COLORS: CanvasColor[] = ['yellow', 'blue', 'red', 'green'];

function canvasFile(slug: unknown): string {
  return path.join(META_DIR, storeKey(slug), 'canvas.json');
}

/**
 * The store key for `<META_DIR>/<key>/canvas.json`.
 *
 * This used to be a bare `replace(/[^a-z0-9._-]+/gi, '')` filter, which KEEPS
 * dots — so `..` survived it untouched and `path.join` then walked one level
 * straight out of `data/projects`. Routes make that unreachable today, because
 * `requireProjectAccess` folds `req.params.slug` before the handler runs, but
 * that is an accident of ROUTING, not containment: one route that forgets the
 * middleware, or any internal caller, turns it into an arbitrary write inside
 * the data dir. `assertSafeStoreSlug` refuses `.`/`..`/separators AND re-proves
 * that the resolved key is strictly inside the store root.
 */
function storeKey(slug: unknown): string {
  return assertSafeStoreSlug(slug, META_DIR);
}

function clampNum(v: unknown, floor: number, ceil: number, dflt: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : dflt;
  return Math.max(floor, Math.min(ceil, n));
}

function nodeId(raw: unknown, fallback: string): string {
  return typeof raw === 'string' && /^[a-zA-Z0-9_-]{1,48}$/.test(raw) ? raw : fallback;
}

function freshId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeSection(raw: unknown): CanvasSection | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  return {
    id: nodeId(r.id, freshId('s')),
    name: typeof r.name === 'string' ? r.name.slice(0, 80) : 'Section',
    color: COLORS.includes(r.color as CanvasColor) ? (r.color as CanvasColor) : 'yellow',
  };
}

function normalizeNode(raw: unknown): CanvasNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const type: CanvasNodeType = r.type === 'card' ? 'card' : 'note';
  const section = typeof r.section === 'string' && /^[a-zA-Z0-9_-]{1,48}$/.test(r.section) ? r.section : undefined;
  return {
    id: nodeId(r.id, freshId('n')),
    type,
    text: typeof r.text === 'string' ? r.text.slice(0, MAX_TEXT) : '',
    x: clampNum(r.x, -100_000, 100_000, 0),
    y: clampNum(r.y, -100_000, 100_000, 0),
    w: clampNum(r.w, 60, 900, 220),
    h: clampNum(r.h, 40, 900, type === 'card' ? 120 : 100),
    color: COLORS.includes(r.color as CanvasColor) ? (r.color as CanvasColor) : 'yellow',
    done: r.done === true,
    section,
  };
}

function normalizeEdge(raw: unknown, ids: Set<string>): CanvasEdge | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const from = typeof r.from === 'string' ? r.from : '';
  const to = typeof r.to === 'string' ? r.to : '';
  if (!ids.has(from) || !ids.has(to) || from === to) return null;
  return { id: nodeId(r.id, freshId('e')), from, to };
}

function emptyCanvas(): ProjectCanvas {
  return { version: 1, nodes: [], edges: [], updatedAt: null };
}

export function loadCanvas(slug: unknown): ProjectCanvas {
  const file = canvasFile(slug);
  if (!fs.existsSync(file)) return emptyCanvas();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rawNodes = Array.isArray(raw?.nodes) ? (raw.nodes as unknown[]) : [];
    const rawEdges = Array.isArray(raw?.edges) ? (raw.edges as unknown[]) : [];
    const nodes: CanvasNode[] = [];
    for (const n of rawNodes) {
      if (nodes.length >= MAX_NODES) break;
      const node = normalizeNode(n);
      if (node) nodes.push(node);
    }
    const ids = new Set(nodes.map((n) => n.id));
    const rawSections = Array.isArray(raw?.sections) ? (raw.sections as unknown[]) : [];
    const sections: CanvasSection[] = [];
    for (const s of rawSections) {
      if (sections.length >= MAX_SECTIONS) break;
      const section = normalizeSection(s);
      if (section) sections.push(section);
    }
    const sectionIds = new Set(sections.map((s) => s.id));
    // Drop section refs whose section is missing (lean + never dangling).
    for (const n of nodes) if (n.section && !sectionIds.has(n.section)) delete n.section;
    const edges: CanvasEdge[] = [];
    const seenEdges = new Set<string>();
    for (const e of rawEdges) {
      if (edges.length >= MAX_EDGES) break;
      const edge = normalizeEdge(e, ids);
      if (!edge) continue;
      // Dedupe (same rule as save): legacy docs may hold a repeated pair.
      const key = `${edge.from}>${edge.to}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      edges.push(edge);
    }
    return {
      version: 1,
      nodes,
      edges,
      ...(sections.length ? { sections } : {}),
      updatedAt: typeof raw?.updatedAt === 'string' ? raw.updatedAt : null,
    };
  } catch {
    /* corrupt canvas — treat as empty */
    return emptyCanvas();
  }
}

export function saveCanvas(slug: unknown, input: unknown): ProjectCanvas {
  const clean = storeKey(slug);
  return withFileLock(`canvas:${clean}`, () => {
    if (!input || typeof input !== 'object') {
      throw new Error('Body must be { nodes: [...], edges: [...] }');
    }
    const r = input as Record<string, unknown>;
    if (!Array.isArray(r.nodes) || !Array.isArray(r.edges)) {
      throw new Error('Body must be { nodes: [...], edges: [...] }');
    }
    const rawNodes = r.nodes as unknown[];
    const rawEdges = r.edges as unknown[];
    const rawSections = Array.isArray(r.sections) ? (r.sections as unknown[]) : [];
    if (rawNodes.length > MAX_NODES) throw new Error(`Too many canvas nodes (max ${MAX_NODES})`);
    if (rawEdges.length > MAX_EDGES) throw new Error(`Too many canvas edges (max ${MAX_EDGES})`);
    if (rawSections.length > MAX_SECTIONS) throw new Error(`Too many canvas sections (max ${MAX_SECTIONS})`);
    const nodes: CanvasNode[] = [];
    for (const raw of rawNodes) {
      const n = normalizeNode(raw);
      if (n) nodes.push(n);
    }
    const ids = new Set(nodes.map((n) => n.id));
    const sections: CanvasSection[] = [];
    for (const raw of rawSections) {
      const s = normalizeSection(raw);
      if (s) sections.push(s);
    }
    const sectionIds = new Set(sections.map((s) => s.id));
    for (const n of nodes) if (n.section && !sectionIds.has(n.section)) delete n.section;
    const edges: CanvasEdge[] = [];
    const seenEdges = new Set<string>();
    for (const raw of rawEdges) {
      const e = normalizeEdge(raw, ids);
      if (!e) continue;
      // Dedupe: one arrow per direction — the same from→to pair twice is an
      // invisible double edge that renders identical hit-testing twice.
      const key = `${e.from}>${e.to}`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      edges.push(e);
    }
    const doc: ProjectCanvas = {
      version: 1,
      nodes,
      edges,
      ...(sections.length ? { sections } : {}),
      updatedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(canvasFile(clean)), { recursive: true });
    fs.writeFileSync(canvasFile(clean), JSON.stringify(doc, null, 2), 'utf8');
    refreshCanvasMirror(clean);
    invalidateProjectContext(clean);
    return doc;
  });
}

/**
 * Apply a batch of live-sync ops to the stored board atomically (same file
 * lock as saveCanvas) and return the resulting document. Normalization is
 * the single source of truth: every op is coerced through normalizeNode /
 * normalizeEdge / normalizeSection, so an op stream can never store a shape
 * that a full save couldn't. Rules:
 *   - node-add on an existing id (or edge-add edge-del on a dead id) is a
 *     no-op — resends stay idempotent.
 *   - empty batches throw (the route turns that into a 400).
 *   - unknown op kinds throw (fail loud, never guess).
 */
export function applyCanvasOps(slug: unknown, rawOps: unknown): ProjectCanvas {
  const clean = storeKey(slug);
  if (!Array.isArray(rawOps) || rawOps.length === 0) {
    throw new Error('Body must be { ops: [...] } with at least one op');
  }
  if (rawOps.length > MAX_OPS) throw new Error(`Too many ops (max ${MAX_OPS})`);

  return withFileLock(`canvas:${clean}`, () => {
    const doc = loadCanvas(clean);
    const sections: CanvasSection[] = [...(doc.sections ?? [])];
    const sectionIds = new Set(sections.map((s) => s.id));

    for (const raw of rawOps) {
      if (!raw || typeof raw !== 'object') throw new Error('Every op must be an object');
      const kind = (raw as Record<string, unknown>).op;
      switch (kind) {
        case 'node-add': {
          if (doc.nodes.length >= MAX_NODES) throw new Error(`Too many canvas nodes (max ${MAX_NODES})`);
          const n = normalizeNode((raw as Record<string, unknown>).node);
          if (!n) throw new Error('node-add: invalid node');
          if (n.section && !sectionIds.has(n.section)) delete n.section;
          if (doc.nodes.some((x) => x.id === n.id)) continue; // idempotent resend
          doc.nodes.push(n);
          break;
        }
        case 'node-patch': {
          const r = raw as Record<string, unknown>;
          const id = nodeId(r.id, '');
          if (!id) throw new Error('node-patch: missing id');
          const target = doc.nodes.find((n) => n.id === id);
          if (!target) continue; // node already gone — patch is a no-op
          const p = (r.patch && typeof r.patch === 'object' ? r.patch : {}) as Record<string, unknown>;
          if (p.text !== undefined) target.text = typeof p.text === 'string' ? p.text.slice(0, MAX_TEXT) : '';
          if (p.x !== undefined) target.x = clampNum(p.x, -100_000, 100_000, target.x);
          if (p.y !== undefined) target.y = clampNum(p.y, -100_000, 100_000, target.y);
          if (p.w !== undefined) target.w = clampNum(p.w, 60, 900, target.w);
          if (p.h !== undefined) target.h = clampNum(p.h, 40, 900, target.h);
          if (p.color !== undefined && COLORS.includes(p.color as CanvasColor)) target.color = p.color as CanvasColor;
          if (p.done !== undefined) target.done = p.done === true;
          if (p.section !== undefined) {
            if (p.section === null) {
              delete target.section;
            } else if (typeof p.section === 'string' && sectionIds.has(p.section) && /^[a-zA-Z0-9_-]{1,48}$/.test(p.section)) {
              target.section = p.section;
            } else {
              delete target.section;
            }
          }
          break;
        }
        case 'node-del': {
          const id = nodeId((raw as Record<string, unknown>).id, '');
          if (!id) throw new Error('node-del: missing id');
          const before = doc.nodes.length;
          doc.nodes = doc.nodes.filter((n) => n.id !== id);
          if (doc.nodes.length !== before) {
            // Cascade: edges died with their node (same contract as PUT).
            doc.edges = doc.edges.filter((e) => e.from !== id && e.to !== id);
          }
          break;
        }
        case 'edge-add': {
          if (doc.edges.length >= MAX_EDGES) throw new Error(`Too many canvas edges (max ${MAX_EDGES})`);
          const e = normalizeEdge((raw as Record<string, unknown>).edge, new Set(doc.nodes.map((n) => n.id)));
          if (!e) throw new Error('edge-add: invalid edge (missing endpoints?)');
          if (doc.edges.some((x) => x.from === e.from && x.to === e.to)) continue; // dedupe
          doc.edges.push(e);
          break;
        }
        case 'edge-del': {
          const id = nodeId((raw as Record<string, unknown>).id, '');
          if (!id) throw new Error('edge-del: missing id');
          doc.edges = doc.edges.filter((e) => e.id !== id);
          break;
        }
        case 'sec-add': {
          if (sections.length >= MAX_SECTIONS) throw new Error(`Too many canvas sections (max ${MAX_SECTIONS})`);
          const s = normalizeSection((raw as Record<string, unknown>).section);
          if (!s) throw new Error('sec-add: invalid section');
          if (sectionIds.has(s.id)) continue; // idempotent resend
          sections.push(s);
          sectionIds.add(s.id);
          break;
        }
        case 'sec-del': {
          const id = nodeId((raw as Record<string, unknown>).id, '');
          if (!id) throw new Error('sec-del: missing id');
          if (sectionIds.delete(id)) {
            for (let i = sections.length - 1; i >= 0; i -= 1) {
              if (sections[i].id === id) sections.splice(i, 1);
            }
            for (const n of doc.nodes) {
              if (n.section === id) delete n.section;
            }
          }
          break;
        }
        default:
          throw new Error(`Unknown canvas op: ${String(kind)}`);
      }
    }

    const next: ProjectCanvas = {
      version: 1,
      nodes: doc.nodes,
      edges: doc.edges,
      ...(sections.length ? { sections } : {}),
      updatedAt: new Date().toISOString(),
    };
    fs.mkdirSync(path.dirname(canvasFile(clean)), { recursive: true });
    fs.writeFileSync(canvasFile(clean), JSON.stringify(next, null, 2), 'utf8');
    refreshCanvasMirror(clean);
    invalidateProjectContext(clean);
    return next;
  });
}

/**
 * Keep a flat-text copy of the planning board in the project workspace
 * (WSD_CANVAS.md, next to WSD_PROJECT.md) so the IDE and opencode agents
 * see the canvas. Best-effort: an empty board removes the stale mirror, a
 * missing workspace leaves nothing behind, and failures never break a save.
 *
 * SECURITY — this is a WRITE into the project workspace, and the earlier
 * `path.join(WORKSPACES_ROOT, clean, CANVAS_MIRROR_FILE)` + `writeFileSync`
 * was a deterministic arbitrary write for any editor. The name is a FIXED
 * basename (no client input reaches it, and that part is still true), but a
 * fixed name is a name an attacker can OCCUPY: an editor has root inside their
 * own project container with the workspace bind-mounted, so `ln -s
 * /app/data/jwt.secret WSD_CANVAS.md` makes every board save overwrite that
 * file THROUGH the link. Chain to host RCE: overwrite the signing secret,
 * restart, forge any admin JWT, `POST /api/embed/session`, and get root code
 * execution beside `/var/run/docker.sock`.
 *
 * So the mirror is written through the shared primitive's LINK-FREE open
 * (kernel `O_NOFOLLOW` + a descriptor), not through a path-following write.
 * The empty-board `unlink` needs no such guard: it removes the link ITSELF and
 * never traverses it, which is the same rule delete follows everywhere else.
 */
export function refreshCanvasMirror(slug: unknown): void {
  try {
    const clean = storeKey(slug);
    // Prove the workspace dir itself is real and inside the root before any
    // mirror work; a missing workspace simply means there is nothing to mirror.
    resolveContainedPath(WORKSPACES_ROOT, clean, '', { mustExist: true });
    const text = formatCanvasForContext(clean, 500_000); // no practical limit for the mirror file
    if (!text) {
      try {
        const stale = resolveContainedPath(WORKSPACES_ROOT, clean, CANVAS_MIRROR_FILE, {
          mustExist: false,
          allowLinkLeaf: true,
        });
        fs.unlinkSync(stale);
      } catch {
        /* nothing mirrored yet */
      }
      return;
    }
    const header =
      `# WSD Project Canvas\n\n` +
      `> Planning-board snapshot (canvas.json). Auto-overwritten by Madar on every board save.\n\n` +
      text;
    writeContainedFile(WORKSPACES_ROOT, clean, CANVAS_MIRROR_FILE, header, {
      mode: 'upsert',
      invalidMessage: 'Invalid canvas mirror path',
    });
  } catch (err: any) {
    // Best-effort by contract, but never SILENT: one observed mirror-less save
    // (200 on the PUT, 404 on the mirror read) was undiagnosable without the
    // reason. Log it server-side; the save still succeeds either way.
    console.warn(`[canvas] mirror refresh failed for '${String(slug)}':`, err?.code || err?.message || err);
  }
}

/** Cheap change-detector for the context cache: mtime+size of canvas.json. */
export function canvasSignature(slug: unknown): string {
  try {
    const st = fs.statSync(canvasFile(slug));
    return `${Math.round(st.mtimeMs)}:${st.size}`;
  } catch {
    return '';
  }
}

/** Node-count for the 'all' project brief (no canvas / empty board → 0). */
export function canvasNodeCount(slug: unknown): number {
  try {
    return loadCanvas(slug).nodes.length;
  } catch {
    return 0;
  }
}

/**
 * Compact planning-canvas summary for the AI context block — flat text of
 * every sticky note + task card, done cards counted. Empty canvases return ''.
 */
export function formatCanvasForContext(slug: unknown, maxChars: number = 1500): string {
  const { nodes, sections } = loadCanvas(slug);
  const withText = nodes.filter((n) => n.text.trim());
  if (!withText.length) return '';
  const secName = (id?: string) => sections?.find((s) => s.id === id)?.name;
  const lines = withText.map((n) => {
    const sec = n.section && secName(n.section) ? ` [${secName(n.section)}]` : '';
    return `- [${n.type === 'card' ? (n.done ? 'done' : 'task') : 'note'}]${sec} ${n.text.trim()}`;
  });
  const doneCount = nodes.filter((n) => n.type === 'card' && n.done).length;
  let text = `[Planning canvas]\n${lines.join('\n')}`;
  if (doneCount > 0) text += `\n(${doneCount} completed card(s))`;
  text = text.slice(0, maxChars).trimEnd();
  return `${text}\n`;
}