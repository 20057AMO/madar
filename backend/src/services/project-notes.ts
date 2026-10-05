/**
 * project-notes.ts
 * Madar — Per-project developer notes (ideas / bugs / goals) stored as JSON
 * under WSD_DATA_DIR/projects/<slug>/notes.json, next to meta.json.
 *
 * Notes are surfaced in two places:
 *   1. The project page "Notes" tab (NotesPanel).
 *   2. The AI context block — buildFullContext() formats open bugs / active
 *      goals / ideas into the system prompt so chat & agents act on them.
 */
import fs from 'fs';
import path from 'path';

import { withFileLock } from './write-queue';
import { invalidateProjectContext } from './project-context';
import { assertSafeStoreSlug } from './project-slug-core';

const DATA_DIR = process.env.WSD_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const META_DIR = path.join(DATA_DIR, 'projects');

export type NoteKind = 'idea' | 'bug' | 'goal';

export interface NoteItem {
  id: string;
  text: string;
  kind: NoteKind;
  done: boolean;
  createdAt: string;
}

export interface ProjectNotes {
  items: NoteItem[];
}

const KINDS: NoteKind[] = ['idea', 'bug', 'goal'];
export const MAX_ITEMS = 300;
export const MAX_TEXT = 2000;

function notesFile(slug: string): string {
  return path.join(META_DIR, storeKey(slug), 'notes.json');
}

/**
 * The store key for `<META_DIR>/<key>/notes.json`. Same reasoning as the canvas
 * store: the old `[a-z0-9._-]` filter KEEPS dots, so `..` survived it and
 * `path.join` walked out of `data/projects`. Only the route middleware's slug
 * canonicalization stands between that and a write outside the store, and that
 * is routing, not containment. `assertSafeStoreSlug` refuses `.`/`..`/
 * separators and re-proves the key is strictly inside the store root.
 */
function storeKey(slug: unknown): string {
  return assertSafeStoreSlug(slug, META_DIR);
}

function normalizeItem(raw: unknown): NoteItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const text = typeof r.text === 'string' ? r.text.trim().slice(0, MAX_TEXT) : '';
  if (!text) return null;
  const kind = KINDS.includes(r.kind as NoteKind) ? (r.kind as NoteKind) : 'idea';
  const id =
    typeof r.id === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(r.id)
      ? r.id
      : `n-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const createdAt =
    typeof r.createdAt === 'string' && !Number.isNaN(Date.parse(r.createdAt))
      ? r.createdAt
      : new Date().toISOString();
  return { id, text, kind, done: r.done === true, createdAt };
}

export function loadNotes(slug: string): ProjectNotes {
  const file = notesFile(storeKey(slug));
  if (!fs.existsSync(file)) return { items: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list: unknown[] = Array.isArray(raw?.items) ? raw.items : [];
    return { items: list.map(normalizeItem).filter((n): n is NoteItem => n !== null).slice(0, MAX_ITEMS) };
  } catch {
    /* corrupt notes — treat as empty */
    return { items: [] };
  }
}

export function saveNotes(slug: string, input: unknown): ProjectNotes {
  const clean = storeKey(slug);
  return withFileLock(`notes:${clean}`, () => {
    if (!input || typeof input !== 'object' || !Array.isArray((input as Record<string, unknown>).items)) {
      throw new Error('Body must be { items: [...] }');
    }
    const rawItems = (input as Record<string, unknown>).items as unknown[];
    if (rawItems.length > MAX_ITEMS) throw new Error(`Too many notes (max ${MAX_ITEMS})`);
    const items: NoteItem[] = [];
    for (const raw of rawItems) {
      const item = normalizeItem(raw);
      if (item) items.push(item);
    }
    fs.mkdirSync(path.dirname(notesFile(clean)), { recursive: true });
    fs.writeFileSync(notesFile(clean), JSON.stringify({ items }, null, 2), 'utf8');
    invalidateProjectContext(clean);
    return { items };
  });
}

/**
 * Cheap change-detector for the context cache: mtime+size of notes.json,
 * or '' when the project has no notes yet.
 */
export function notesSignature(slug: string): string {
  const file = notesFile(String(slug ?? '').replace(/[^a-z0-9._-]+/gi, '').slice(0, 64));
  try {
    const st = fs.statSync(file);
    return `${Math.round(st.mtimeMs)}:${st.size}`;
  } catch {
    return '';
  }
}

/** Open-bug / active-goal counts for one project (used by the brief context). */export function noteCounts(slug: string): { bugs: number; goals: number } | null {
  const file = notesFile(String(slug ?? '').replace(/[^a-z0-9._-]+/gi, '').slice(0, 64));
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(raw?.items) ? (raw.items as NoteItem[]) : [];
    return {
      bugs: list.filter((n) => n.kind === 'bug' && !n.done).length,
      goals: list.filter((n) => n.kind === 'goal' && !n.done).length,
    };
  } catch {
    return null;
  }
}

/**
 * Formatted notes section for the AI system-prompt context block.
 * Priority order inside the section mirrors user intent: open bugs first,
 * then active goals, then ideas. Done items are summarized by count only.
 */
export function formatNotesForContext(slug: string, maxChars: number = 2500): string {
  const { items } = loadNotes(slug);
  if (items.length === 0) return '';
  const pick = (kind: NoteKind) =>
    items.filter((n) => n.kind === kind && !n.done).map((n) => `- ${n.text}`);
  const sections: string[] = [];
  const bugs = pick('bug');
  if (bugs.length) sections.push(`### Known issues (open)\n${bugs.join('\n')}`);
  const goals = pick('goal');
  if (goals.length) sections.push(`### Active goals\n${goals.join('\n')}`);
  const ideas = pick('idea');
  if (ideas.length) sections.push(`### Ideas\n${ideas.join('\n')}`);
  const doneCount = items.filter((n) => n.done).length;
  let text = `[Developer notes]\n${sections.join('\n\n')}`;
  if (doneCount > 0) text += `\n(${doneCount} completed note(s) omitted)`;
  text = text.slice(0, maxChars);
  return sections.length ? `${text}\n` : '';
}
