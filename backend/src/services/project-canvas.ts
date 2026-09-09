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

const DATA_DIR = process.env.WSD_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const META_DIR = path.join(DATA_DIR, 'projects');
const WORKSPACES_ROOT = process.env.WSD_PROJECTS_DIR || '/workspaces';

/** Derived flat-text board kept in the project workspace so IDE + opencode
 *  agents can read the planning canvas (like WSD_PROJECT.md). */
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
  textX?: number;
  textY?: number;
  textSize?: number;
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

const COLORS: CanvasColor[] = ['yellow', 'blue', 'red', 'green'];

class CanvasConflictError extends Error {
  statusCode = 409;

  constructor() {
    super('Canvas changed elsewhere; reload before saving');
    this.name = 'CanvasConflictError';
  }
}

function canvasFile(slug: unknown): string {
  return path.join(META_DIR, cleanSlug(slug), 'canvas.json');
}

function cleanSlug(slug: unknown): string {
  const clean = String(slug ?? '').replace(/[^a-z0-9._-]+/gi, '').slice(0, 64);
  if (!clean) throw new Error('Invalid project slug');
  return clean;
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
  const w = clampNum(r.w, 60, 900, 220);
  const h = clampNum(r.h, 40, 900, type === 'card' ? 120 : 100);
  return {
    id: nodeId(r.id, freshId('n')),
    type,
    text: typeof r.text === 'string' ? r.text.slice(0, MAX_TEXT) : '',
    x: clampNum(r.x, -100_000, 100_000, 0),
    y: clampNum(r.y, -100_000, 100_000, 0),
    w,
    h,
    textX: clampNum(r.textX, 0, Math.max(0, w - 20), 10),
    textY: clampNum(r.textY, 0, Math.max(0, h - 20), 10),
    textSize: clampNum(r.textSize, 10, 48, 14),
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
    const nodeIds = new Set<string>();
    for (const n of rawNodes) {
      if (nodes.length >= MAX_NODES) break;
      const node = normalizeNode(n);
      if (node) {
        while (nodeIds.has(node.id)) node.id = freshId('n');
        nodeIds.add(node.id);
        nodes.push(node);
      }
    }
    const ids = nodeIds;
    const rawSections = Array.isArray(raw?.sections) ? (raw.sections as unknown[]) : [];
    const sections: CanvasSection[] = [];
    const sectionIds = new Set<string>();
    for (const s of rawSections) {
      if (sections.length >= MAX_SECTIONS) break;
      const section = normalizeSection(s);
      if (section) {
        while (sectionIds.has(section.id)) section.id = freshId('s');
        sectionIds.add(section.id);
        sections.push(section);
      }
    }
    // Drop section refs whose section is missing (lean + never dangling).
    for (const n of nodes) if (n.section && !sectionIds.has(n.section)) delete n.section;
    const edges: CanvasEdge[] = [];
    const edgeIds = new Set<string>();
    for (const e of rawEdges) {
      if (edges.length >= MAX_EDGES) break;
      const edge = normalizeEdge(e, ids);
      if (edge) {
        while (edgeIds.has(edge.id)) edge.id = freshId('e');
        edgeIds.add(edge.id);
        edges.push(edge);
      }
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
  const clean = cleanSlug(slug);
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
    const current = loadCanvas(clean);
    if (typeof r.updatedAt === 'string' && r.updatedAt !== current.updatedAt) {
      throw new CanvasConflictError();
    }
    if (rawNodes.length > MAX_NODES) throw new Error(`Too many canvas nodes (max ${MAX_NODES})`);
    if (rawEdges.length > MAX_EDGES) throw new Error(`Too many canvas edges (max ${MAX_EDGES})`);
    if (rawSections.length > MAX_SECTIONS) throw new Error(`Too many canvas sections (max ${MAX_SECTIONS})`);
    const nodes: CanvasNode[] = [];
    const nodeIds = new Set<string>();
    for (const raw of rawNodes) {
      const n = normalizeNode(raw);
      if (n) {
        while (nodeIds.has(n.id)) n.id = freshId('n');
        nodeIds.add(n.id);
        nodes.push(n);
      }
    }
    const ids = nodeIds;
    const sections: CanvasSection[] = [];
    const sectionIds = new Set<string>();
    for (const raw of rawSections) {
      const s = normalizeSection(raw);
      if (s) {
        while (sectionIds.has(s.id)) s.id = freshId('s');
        sectionIds.add(s.id);
        sections.push(s);
      }
    }
    for (const n of nodes) if (n.section && !sectionIds.has(n.section)) delete n.section;
    const edges: CanvasEdge[] = [];
    const edgeIds = new Set<string>();
    for (const raw of rawEdges) {
      const e = normalizeEdge(raw, ids);
      if (e) {
        while (edgeIds.has(e.id)) e.id = freshId('e');
        edgeIds.add(e.id);
        edges.push(e);
      }
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
 * Keep a flat-text copy of the planning board in the project workspace
 * (WSD_CANVAS.md, next to WSD_PROJECT.md) so the IDE and opencode agents
 * see the canvas. Best-effort: an empty board removes the stale mirror, a
 * missing workspace leaves nothing behind, and failures never break a save.
 */
export function refreshCanvasMirror(slug: unknown): void {
  try {
    const clean = cleanSlug(slug);
    const target = path.join(WORKSPACES_ROOT, clean, CANVAS_MIRROR_FILE);
    const dir = path.dirname(target);
    if (!fs.existsSync(dir)) return;
    const text = formatCanvasForContext(clean, 500_000); // no practical limit for the mirror file
    if (!text) {
      if (fs.existsSync(target)) fs.unlinkSync(target);
      return;
    }
    const header =
      `# WSD Project Canvas\n\n` +
      `> Planning-board snapshot (canvas.json). Auto-overwritten by Madar on every board save.\n\n` +
      text;
    fs.writeFileSync(target, header, 'utf8');
  } catch {
    /* mirror is best-effort — never fail a board save over it */
  }
}

/** Cheap change-detector for the context cache: mtime+size of canvas.json. */
export function canvasSignature(slug: unknown): string {
  const file = canvasFile(String(slug ?? '').replace(/[^a-z0-9._-]+/gi, '').slice(0, 64));
  try {
    const st = fs.statSync(file);
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
  if (!withText.length && !sections?.length) return '';
  const secName = (id?: string) => sections?.find((s) => s.id === id)?.name;
  const lines = withText.map((n) => {
    const sec = n.section && secName(n.section) ? ` [${secName(n.section)}]` : '';
    return `- [${n.type === 'card' ? (n.done ? 'done' : 'task') : 'note'}]${sec} ${n.text.trim()}`;
  });
  if (sections?.length) {
    for (const section of sections) {
      if (!lines.some((line) => line.includes(`[${section.name}]`))) {
        lines.push(`- [section] ${section.name}`);
      }
    }
  }
  const doneCount = nodes.filter((n) => n.type === 'card' && n.done).length;
  let text = `[Planning canvas]\n${lines.join('\n')}`;
  if (doneCount > 0) text += `\n(${doneCount} completed card(s))`;
  text = text.slice(0, maxChars).trimEnd();
  return `${text}\n`;
}