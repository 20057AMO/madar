import type { NoteItem, NoteKind, CanvasNode, CanvasColor, ProjectCanvas, DelegateCapability } from '../api';

/**
 * delegate-plans.ts
 * Madar — pure helpers for the Agent-run panel ("Run an opencode subagent on
 * this project"):
 *   1. capability classification from live agent frontmatter (mirrors
 *      backend opencode-delegate-core.ts, safe-by-default),
 *   2. the per-agent default task template (the same keyword rules the
 *      backend uses in buildDelegatePrompt),
 *   3. converting a finished agent result into project Notes items or Canvas
 *      sticky nodes so a run's plan lands directly in the planning surfaces.
 * All functions are import-free pure logic (unit-testable like limits.ts).
 */

/** Hard ceiling on one delegation prompt (chars) — mirrors the backend cap. */
export const DELEGATE_PROMPT_MAX = 20_000;

export const CAP_READERS = 'readonly';
export const CAP_WRITERS = 'write';

/**
 * Classify an agent's capability from its live frontmatter. Safe by default:
 * ONLY an explicit `edit: deny` under the `permission:` block grants
 * 'readonly' — everything else is treated as a WRITER so a permission-less
 * agent can never sneak past the editor gate (port of agentCapability).
 */
export function delegateAgentCapability(frontmatter: string): DelegateCapability {
  const fm = String(frontmatter ?? '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(fm);
  const body = m ? m[1] : fm;
  const editDenied = /^edit:[ \t]*(deny|false|no)(?:[ \t]*#.*)?$/;
  const lines = body.split('\n');
  let inPermission = false;
  for (const rawLine of lines) {
    if (!inPermission) {
      if (/^permission:[ \t]*\{[^}]*edit:[ \t]*(deny|false|no)[^}]*\}[ \t]*$/i.test(rawLine.trim())) {
        return 'readonly';
      }
      if (/^permission:[ \t]*$/.test(rawLine)) {
        inPermission = true;
      }
      continue;
    }
    // An unindented non-empty line ends the permission block.
    if (/^\S/.test(rawLine) && rawLine.trim()) {
      inPermission = false;
      continue;
    }
    if (editDenied.test(rawLine.trim())) return 'readonly';
    if (/^edit:[ \t]*(allow|true|yes)\b/.test(rawLine.trim())) {
      inPermission = false;
    }
  }
  return 'write';
}

/**
 * Default working-mode template selected by agent-name keyword — the same
 * rule the backend applies inside buildDelegatePrompt. The user's typed task
 * replaces this template in the editor (it is a starting point, not a filler).
 */
export function defaultDelegatePrompt(agent: string): string {
  const a = String(agent ?? '').toLowerCase();
  if (/(review|auditor|audit)/.test(a)) {
    return 'Working mode: audit the relevant code, then report concrete findings (severity + file:line references). Prefer suggestions over applying changes.';
  }
  if (a.includes('test')) {
    return "Working mode: cover the behavior with tests where they are missing. Follow the repository's existing test conventions; verify your work runs before finishing.";
  }
  if (a.includes('debug')) {
    return 'Working mode: diagnose the reported problem first (root cause before fix), reproduce if possible, then apply the minimal fix and re-verify.';
  }
  if (/(architect|plan)/.test(a)) {
    return "Working mode: produce a concrete, file-level plan (steps, order, risks) grounded in the repository's actual structure — do not name files that do not exist.";
  }
  return "Working mode: complete the task in the repository's established conventions. Verify your work (type-check/build/tests) where applicable before reporting.";
}

/** One parsed chunk of a result: an optional heading + its content lines. */
export interface PlanSection {
  title: string | null;
  kind: NoteKind;
  lines: string[];
}

const HEADING_RE = /^#{1,6}\s+(.+)$/;
const BOLD_HEADING_RE = /^\*{1,2}(.+)\*{1,2}:?\s*$/;

function headingOf(line: string): string | null {
  const t = line.trim();
  let m = HEADING_RE.exec(t);
  if (!m) m = BOLD_HEADING_RE.exec(t);
  if (!m || !m[1]) return null;
  const h = m[1].replace(/[#*_`]/g, '').trim();
  return h || null;
}

/** Classify a heading/chunk by its words — goal/action vs bug/risk vs idea. */
function kindOf(text: string): NoteKind {
  const s = String(text ?? '').toLowerCase();
  if (/(bug|issue|risk|problem|concern|error|warning|blocker|fail|vulnerab|inconsisten|dead[\s-]*link)/.test(s)) {
    return 'bug';
  }
  if (
    /(\bgoal\b|\btask\b|\baction\b|todo|next[\s-]*steps?|\bplan\b|proposal|implement|\bcreate\b|\badd\b|\bfix\b|improve|recommend|checklist|acceptance|milestone|assignee|must|should)/.test(s)
  ) {
    return 'goal';
  }
  return 'idea';
}

function stripBullet(line: string): string | null {
  const t = line.trim();
  if (!t) return null;
  const m =
    /^[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(t) ||
    /^[-*+]\s+(.*)$/.exec(t) ||
    /^\d{1,3}[.)]\s+(.*)$/.exec(t);
  if (!m || !m[1]) return null;
  const text = m[1].replace(/^[*_`]+|[*_`]+$/g, '').trim();
  return text || null;
}

/**
 * Flatten a raw agent result into sections (heading → chunk). Bullets lose
 * their markers, standalone lines become their own chunk items, headings /
 * horizontal rules never produce items.
 */
export function parsePlan(text: string): PlanSection[] {
  const sections: PlanSection[] = [];
  let cur: PlanSection = { title: null, kind: 'idea', lines: [] };
  const flush = () => {
    if (cur.lines.length) sections.push(cur);
    cur = { title: null, kind: 'idea', lines: [] };
  };
  for (const rawLine of String(text ?? '').split('\n')) {
    const line = rawLine.trimEnd();
    const t = line.trim();
    if (!t) continue;
    if (/^[-*_]{3,}$/.test(t)) continue; // horizontal rule
    const h = headingOf(line);
    if (h) {
      flush();
      cur.title = h;
      cur.kind = kindOf(h);
      continue;
    }
    const bullet = stripBullet(line);
    const item = (bullet || t).replace(/\s+/g, ' ').trim();
    if (!item) continue;
    cur.lines.push(item.slice(0, 2000));
  }
  flush();
  return sections;
}

function freshNoteId(): string {
  return `n-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const NOTES_MAX_ITEMS = 300;
export const CANVAS_MAX_NODES = 200;

/** Result sections → Notes items, all stamped with the caller-chosen kind. */
export function resultToNotes(text: string, kind: NoteKind, max = NOTES_MAX_ITEMS): NoteItem[] {
  const sections = parsePlan(text);
  const items: NoteItem[] = [];
  for (const sec of sections) {
    for (const line of sec.lines) {
      if (items.length >= max) break;
      items.push({
        id: freshNoteId(),
        text: line.slice(0, 2000),
        kind,
        done: false,
        createdAt: new Date().toISOString(),
      });
    }
    if (items.length >= max) break;
  }
  return items;
}

function kindColor(kind: NoteKind): CanvasColor {
  return kind === 'bug' ? 'red' : kind === 'goal' ? 'blue' : 'yellow';
}

export interface CanvasAggregate {
  doc: ProjectCanvas;
  added: number;
}

/**
 * Result sections → sticky notes appended to a copy of the current board,
 * laid out in a fresh column to the right of all existing content. Never
 * exceeds CANVAS_MAX_NODES; edges/sections of the existing board are kept.
 */
export function buildCanvasFromResult(doc: ProjectCanvas, text: string, max = CANVAS_MAX_NODES): CanvasAggregate {
  const sections = parsePlan(text);
  const nodes: CanvasNode[] = [...(doc?.nodes || [])];
  let x = 40;
  for (const n of nodes) x = Math.max(x, n.x + n.w + 40);
  let y = 40;
  let added = 0;
  for (const sec of sections) {
    for (const line of sec.lines) {
      if (nodes.length >= max) break;
      nodes.push({
        id: `d-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        type: 'note',
        text: line.slice(0, 2000),
        x,
        y,
        w: 220,
        h: 100,
        color: kindColor(sec.kind),
        done: false,
      });
      y += 118;
      added++;
    }
    if (nodes.length >= max) break;
  }
  const next: ProjectCanvas = {
    version: 1,
    nodes,
    edges: doc?.edges || [],
    ...(doc?.sections?.length ? { sections: doc.sections } : {}),
    updatedAt: new Date().toISOString(),
  };
  return { doc: next, added };
}