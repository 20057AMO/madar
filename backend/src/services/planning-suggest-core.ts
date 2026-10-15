/**
 * planning-suggest-core.ts
 * Madar — Pure rules for the planning-suggestion engine. Import-free on
 * purpose (node --test loads it directly, mirroring digest-core.ts /
 * serve-core.ts / alerts-core.ts): no fs/path/docker imports, just plain types
 * + pure functions, so the goal/idea/stale/orphan/duplicate/empty-board
 * decisions are deterministically unit-testable offline.
 *
 * The engine is RULE-BASED and deliberately distinct from the shipped digest:
 * a digest is a time-driven narrative summary, a suggestion is a concrete
 * accept/reject row derived only from the project's canvas.json + notes.json
 * ("this open goal has no task cards", "this bug is 20 days old"). Dismissals
 * are keyed by contentKey(kind, text), so an unchanged subject never
 * re-suggests after the user rejected it, while an edited one does.
 *
 * Matching bias: `goal_without_task` / `untracked_idea` use equality-or-
 * containment (either direction) on normalized text — a goal covered by a
 * broader card is silently tracked, because a false negative costs one missed
 * suggestion while a false positive would nag about work already planned.
 *
 * TODO(AI follow-up — NOT implemented in this chunk): buildSuggestPrompt /
 * parseSuggestOutput / safeSuggestErrorLabel, the optional LLM refinement
 * pass (same shape as digest-core's trio). SUGGEST_PROMPT_MAX /
 * SUGGEST_OUTPUT_MAX / MAX_SUGGEST_ITEMS are already reserved for it.
 */

/** Hard ceiling on stored/computed suggestions per project. */
export const MAX_SUGGESTIONS = 50;

/** An open bug older than this many days is stale. */
export const STALE_BUG_DAYS = 14;

/** Hard ceiling on the per-project dismissed-key list. */
export const DISMISSED_MAX = 200;

/** Reserved for the AI follow-up: hard ceiling on an assembled prompt (chars). */
export const SUGGEST_PROMPT_MAX = 20_000;

/** Reserved for the AI follow-up: hard ceiling on parsed model text (chars). */
export const SUGGEST_OUTPUT_MAX = 8_000;

/** Reserved for the AI follow-up: hard ceiling on parsed item rows. */
export const MAX_SUGGEST_ITEMS = 8;

export type SuggestKind =
  | 'goal_without_task'
  | 'untracked_idea'
  | 'stale_bug'
  | 'orphan_card'
  | 'duplicate_item'
  | 'empty_board';

export type SuggestSeverity = 'high' | 'med' | 'low';

export interface Suggestion {
  id: string;
  key: string;
  kind: SuggestKind;
  severity: SuggestSeverity;
  title: string;
  rationale: string;
  source: 'rule' | 'ai';
  target: 'note' | 'canvas';
  payload: { text: string; kind?: 'idea' | 'bug' | 'goal' };
  refs: string[];
  createdAt: string;
}

export interface SuggestOptions {
  /** Epoch ms used for staleness + createdAt (defaults Date.now()). */
  now?: number;
}

/** Every rule kind, in canonical order. */
export const SUGGEST_KINDS: SuggestKind[] = [
  'goal_without_task',
  'untracked_idea',
  'stale_bug',
  'orphan_card',
  'duplicate_item',
  'empty_board',
];

/** Canonical severity per kind — rules read it here, the store uses it as the
 *  fallback for a corrupted row. */
export const SUGGEST_SEVERITY: Record<SuggestKind, SuggestSeverity> = {
  goal_without_task: 'high',
  untracked_idea: 'med',
  stale_bug: 'high',
  orphan_card: 'low',
  duplicate_item: 'med',
  empty_board: 'med',
};

const SEVERITY_ORDER: Record<SuggestSeverity, number> = { high: 0, med: 1, low: 2 };

const NOTE_KINDS = ['idea', 'bug', 'goal'] as const;
type NoteKind = (typeof NOTE_KINDS)[number];

/** Private input-shape guards (junk-tolerant readers below fill these). */
const MAX_INPUT_ROWS = 500;
const MAX_INPUT_EDGES = 1000;
const MAX_TEXT = 2000;
const MAX_REFS = 20;
const MAX_KEY_CHARS = 4096;
const DAY_MS = 86_400_000;

interface NoteRow {
  id: string;
  text: string;
  kind: NoteKind;
  done: boolean;
  createdAt: string;
}

interface NodeRow {
  id: string;
  type: 'note' | 'card';
  text: string;
  done: boolean;
}

interface EdgeRow {
  from: string;
  to: string;
}

/**
 * Trim, collapse internal whitespace runs to one space, lowercase — the one
 * comparison form used by every rule. Non-strings normalize to '' (never
 * throws), so junk input rows simply never match.
 */
export function normalizeText(s: unknown): string {
  if (typeof s !== 'string') return '';
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Stable dismissal/dedup key: kind + normalized text. Same subject text under
 * the same kind always yields the same key (whitespace/case-insensitive); a
 * different kind yields a different key.
 */
export function contentKey(kind: SuggestKind | string, text: unknown): string {
  return `${String(kind ?? '')}::${normalizeText(text)}`;
}

/** Stable-ish unique suggestion id — `s-<6>-<6>` base36 (mirrors digestEntryId). */
export function suggestEntryId(): string {
  return `s-${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}-${Math.random()
    .toString(36)
    .slice(2, 8)
    .padEnd(6, '0')}`;
}

function isNoteKind(v: unknown): v is NoteKind {
  return typeof v === 'string' && (NOTE_KINDS as readonly string[]).includes(v);
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}...` : s;
}

function clock(opts?: SuggestOptions): { nowMs: number; nowIso: string } {
  const raw = opts?.now;
  // Range-guarded: Date#toISOString throws outside ±8.64e15 ms, and this
  // module must never throw on a junk clock.
  const nowMs =
    typeof raw === 'number' && Number.isFinite(raw) && Math.abs(raw) <= 8.64e15 ? raw : Date.now();
  return { nowMs, nowIso: new Date(nowMs).toISOString() };
}

/**
 * Minimum length for a CONTAINMENT match (either direction). Below this only
 * exact equality counts: a three-character subject ("api", "ui") is a substring
 * of countless unrelated longer texts, so containment there would silently
 * silence real suggestions instead of merely avoiding a false positive.
 */
export const MIN_CONTAINMENT_LEN = 4;

/** Equality-or-containment on two NORMALIZED, non-empty strings. */
function matchesText(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (Math.min(a.length, b.length) < MIN_CONTAINMENT_LEN) return false;
  return a.includes(b) || b.includes(a);
}

function readNotes(raw: unknown): NoteRow[] {
  const items = raw && typeof raw === 'object' ? (raw as { items?: unknown }).items : undefined;
  if (!Array.isArray(items)) return [];
  const out: NoteRow[] = [];
  for (const it of items) {
    if (out.length >= MAX_INPUT_ROWS) break;
    if (!it || typeof it !== 'object') continue;
    const r = it as Record<string, unknown>;
    const text = typeof r.text === 'string' ? r.text.trim().slice(0, MAX_TEXT) : '';
    const id = typeof r.id === 'string' ? r.id.trim().slice(0, 64) : '';
    if (!text || !id) continue;
    // Invalid kind defaults to 'idea' — mirrors project-notes.normalizeItem,
    // whose loadNotes output is what the wiring passes in.
    const kind: NoteKind = isNoteKind(r.kind) ? r.kind : 'idea';
    const createdAt =
      typeof r.createdAt === 'string' && !Number.isNaN(Date.parse(r.createdAt)) ? r.createdAt : '';
    out.push({ id, text, kind, done: r.done === true, createdAt });
  }
  return out;
}

function readCanvas(raw: unknown): { nodes: NodeRow[]; edges: EdgeRow[] } {
  if (!raw || typeof raw !== 'object') return { nodes: [], edges: [] };
  const o = raw as Record<string, unknown>;
  const nodes: NodeRow[] = [];
  if (Array.isArray(o.nodes)) {
    for (const it of o.nodes) {
      if (nodes.length >= MAX_INPUT_ROWS) break;
      if (!it || typeof it !== 'object') continue;
      const r = it as Record<string, unknown>;
      const id = typeof r.id === 'string' ? r.id.trim().slice(0, 64) : '';
      // A row without a real id cannot be referenced by an edge (or by refs).
      if (!id) continue;
      const text = typeof r.text === 'string' ? r.text.trim().slice(0, MAX_TEXT) : '';
      nodes.push({ id, type: r.type === 'card' ? 'card' : 'note', text, done: r.done === true });
    }
  }
  const edges: EdgeRow[] = [];
  if (Array.isArray(o.edges)) {
    for (const it of o.edges) {
      if (edges.length >= MAX_INPUT_EDGES) break;
      if (!it || typeof it !== 'object') continue;
      const r = it as Record<string, unknown>;
      const from = typeof r.from === 'string' ? r.from : '';
      const to = typeof r.to === 'string' ? r.to : '';
      if (!from || !to) continue;
      edges.push({ from, to });
    }
  }
  return { nodes, edges };
}

function makeSuggestion(input: {
  kind: SuggestKind;
  title: string;
  rationale: string;
  target: 'note' | 'canvas';
  payload: Suggestion['payload'];
  refs: string[];
  nowIso: string;
}): Suggestion {
  return {
    id: suggestEntryId(),
    key: contentKey(input.kind, input.payload.text),
    kind: input.kind,
    severity: SUGGEST_SEVERITY[input.kind],
    title: input.title,
    rationale: input.rationale,
    source: 'rule',
    target: input.target,
    payload: input.payload,
    refs: input.refs.slice(0, MAX_REFS),
    createdAt: input.nowIso,
  };
}

/** An OPEN goal note with no matching canvas CARD → add task cards (high). */
export function ruleGoalWithoutTask(
  canvas: unknown,
  notes: unknown,
  opts?: SuggestOptions,
): Suggestion[] {
  const { nowIso } = clock(opts);
  const cards = readCanvas(canvas).nodes.filter((n) => n.type === 'card');
  const out: Suggestion[] = [];
  for (const note of readNotes(notes)) {
    if (note.kind !== 'goal' || note.done) continue;
    const target = normalizeText(note.text);
    if (!target) continue;
    if (cards.some((card) => matchesText(normalizeText(card.text), target))) continue;
    out.push(
      makeSuggestion({
        kind: 'goal_without_task',
        title: 'Goal without task cards',
        rationale: `Open goal "${clip(note.text, 120)}" has no matching task card on the board — break it down into cards.`,
        target: 'canvas',
        payload: { text: note.text, kind: 'goal' },
        refs: [note.id],
        nowIso,
      }),
    );
  }
  return out;
}

/** An OPEN idea note not present on the canvas (any node type) → promote it (med). */
export function ruleUntrackedIdea(
  canvas: unknown,
  notes: unknown,
  opts?: SuggestOptions,
): Suggestion[] {
  const { nowIso } = clock(opts);
  const nodeTexts = readCanvas(canvas)
    .nodes.map((n) => normalizeText(n.text))
    .filter((t) => t);
  const out: Suggestion[] = [];
  for (const note of readNotes(notes)) {
    if (note.kind !== 'idea' || note.done) continue;
    const target = normalizeText(note.text);
    if (!target) continue;
    if (nodeTexts.some((t) => matchesText(t, target))) continue;
    out.push(
      makeSuggestion({
        kind: 'untracked_idea',
        title: 'Idea not on the board',
        rationale: `Open idea "${clip(note.text, 120)}" is not on the planning canvas — promote it to a sticky or card.`,
        target: 'canvas',
        payload: { text: note.text, kind: 'idea' },
        refs: [note.id],
        nowIso,
      }),
    );
  }
  return out;
}

/** An OPEN bug older than STALE_BUG_DAYS → prioritize or close it (high).
 *  An unparseable createdAt cannot be proven old, so it never fires. */
export function ruleStaleBug(
  canvas: unknown,
  notes: unknown,
  opts?: SuggestOptions,
): Suggestion[] {
  const { nowMs, nowIso } = clock(opts);
  const out: Suggestion[] = [];
  for (const note of readNotes(notes)) {
    if (note.kind !== 'bug' || note.done || !note.createdAt) continue;
    const age = nowMs - Date.parse(note.createdAt);
    if (!(age > STALE_BUG_DAYS * DAY_MS)) continue;
    out.push(
      makeSuggestion({
        kind: 'stale_bug',
        title: 'Stale open bug',
        rationale: `Bug "${clip(note.text, 120)}" has been open since ${note.createdAt.slice(0, 10)} — prioritize a fix or close it.`,
        target: 'note',
        payload: { text: note.text, kind: 'bug' },
        refs: [note.id],
        nowIso,
      }),
    );
  }
  return out;
}

/** A canvas CARD with no edge touching it → link or remove it (low). Sticky
 *  notes are not flagged (spec: dangling CARDS); a done card still counts. */
export function ruleOrphanCard(
  canvas: unknown,
  notes: unknown,
  opts?: SuggestOptions,
): Suggestion[] {
  const { nowIso } = clock(opts);
  const { nodes, edges } = readCanvas(canvas);
  const referenced = new Set<string>();
  for (const e of edges) {
    referenced.add(e.from);
    referenced.add(e.to);
  }
  const out: Suggestion[] = [];
  for (const node of nodes) {
    if (node.type !== 'card' || !node.text) continue;
    if (referenced.has(node.id)) continue;
    out.push(
      makeSuggestion({
        kind: 'orphan_card',
        title: 'Orphan card',
        rationale: `Card "${clip(node.text, 120)}" has no links to the rest of the board — connect it or remove it.`,
        target: 'canvas',
        payload: { text: node.text },
        refs: [node.id],
        nowIso,
      }),
    );
  }
  return out;
}

/** Two notes — or a note and a card — with equal normalized text → surface
 *  the copies (med). Card↔card pairs are out of scope. "Collect, don't merge"
 *  is deliberate: the rationale names the manual clean-up the user performs;
 *  the accept path files the hint (the generic land) rather than mutating the
 *  existing rows, so the text must never promise a merge the product won't do. */
export function ruleDuplicateItem(
  canvas: unknown,
  notes: unknown,
  opts?: SuggestOptions,
): Suggestion[] {
  const { nowIso } = clock(opts);
  const cards = readCanvas(canvas).nodes.filter((n) => n.type === 'card' && n.text);
  const noteRows = readNotes(notes).filter((n) => normalizeText(n.text));
  const out: Suggestion[] = [];

  // Precompute both lookups once (normalizeText is not free): notes grouped by
  // normalized text, cards indexed by it (first card wins, mirroring the old
  // positional .find). Keeps the card↔note pass O(notes + cards), not
  // O(notes × cards).
  const byText = new Map<string, NoteRow[]>();
  const cardByText = new Map<string, NodeRow>();
  for (const card of cards) {
    const k = normalizeText(card.text);
    if (k && !cardByText.has(k)) cardByText.set(k, card);
  }
  for (const note of noteRows) {
    const k = normalizeText(note.text);
    const group = byText.get(k);
    if (group) group.push(note);
    else byText.set(k, [note]);
  }
  for (const group of byText.values()) {
    if (group.length < 2) continue;
    out.push(
      makeSuggestion({
        kind: 'duplicate_item',
        title: 'Duplicate item',
        rationale: `"${clip(group[0].text, 120)}" appears more than once — collect the copies under one entry and delete the rest.`,
        target: 'note',
        payload: { text: group[0].text, kind: group[0].kind },
        refs: group.map((n) => n.id),
        nowIso,
      }),
    );
  }

  for (const note of noteRows) {
    const k = normalizeText(note.text);
    const hit = cardByText.get(k);
    if (!hit) continue;
    out.push(
      makeSuggestion({
        kind: 'duplicate_item',
        title: 'Duplicate item',
        rationale: `"${clip(note.text, 120)}" exists as both a note and a board card — keep one and remove the other.`,
        target: 'canvas',
        payload: { text: note.text, kind: note.kind },
        refs: [note.id, hit.id],
        nowIso,
      }),
    );
  }
  return out;
}

/** Notes exist but the canvas has zero nodes → seed the board (med). */
export function ruleEmptyBoard(
  canvas: unknown,
  notes: unknown,
  opts?: SuggestOptions,
): Suggestion[] {
  const { nowIso } = clock(opts);
  const noteRows = readNotes(notes);
  if (!noteRows.length) return [];
  if (readCanvas(canvas).nodes.length > 0) return [];
  return [
    makeSuggestion({
      kind: 'empty_board',
      title: 'Empty board',
      rationale: `The project has ${noteRows.length} note(s) but no canvas nodes — seed the board from the notes.`,
      target: 'canvas',
      payload: { text: '' },
      refs: noteRows.map((n) => n.id),
      nowIso,
    }),
  ];
}

/**
 * Run all six rules, dedupe by `key` (first rule wins), sort by severity
 * (high→med→low, stable so rule order breaks ties), cap at MAX_SUGGESTIONS and
 * stamp a fresh id + one shared batch `createdAt`. NEVER throws: junk/null
 * canvas, notes or clock all degrade to `[]` / sane defaults.
 */
export function computeSuggestions(
  canvas: unknown,
  notes: unknown,
  opts?: SuggestOptions,
): Suggestion[] {
  try {
    const { nowIso } = clock(opts);
    const raw: Suggestion[] = [
      ...ruleGoalWithoutTask(canvas, notes, opts),
      ...ruleUntrackedIdea(canvas, notes, opts),
      ...ruleStaleBug(canvas, notes, opts),
      ...ruleOrphanCard(canvas, notes, opts),
      ...ruleDuplicateItem(canvas, notes, opts),
      ...ruleEmptyBoard(canvas, notes, opts),
    ];
    const seen = new Set<string>();
    const deduped = raw.filter((s) => {
      if (seen.has(s.key)) return false;
      seen.add(s.key);
      return true;
    });
    deduped.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
    return deduped.slice(0, MAX_SUGGESTIONS).map((s) => ({ ...s, id: suggestEntryId(), createdAt: nowIso }));
  } catch {
    return [];
  }
}

/** Keep only non-empty strings, trimmed, deduped, capped at DISMISSED_MAX.
 *  Junk/non-array input yields []. */
export function sanitizeDismissed(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const k = v.trim().slice(0, MAX_KEY_CHARS);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
    if (out.length >= DISMISSED_MAX) break;
  }
  return out;
}

/** Drop every suggestion whose `key` is in the dismissed list. Non-suggestion
 *  rows are dropped too; junk inputs never throw. */
export function applyDismissals(
  list: Suggestion[] | null | undefined,
  dismissedKeys: unknown,
): Suggestion[] {
  const items = Array.isArray(list) ? list : [];
  const keys = new Set(sanitizeDismissed(dismissedKeys));
  return items.filter(
    (s): s is Suggestion =>
      !!s && typeof s === 'object' && typeof (s as Suggestion).key === 'string' && !keys.has((s as Suggestion).key),
  );
}
