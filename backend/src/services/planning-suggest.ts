/**
 * planning-suggest.ts
 * Madar — Planning-suggestion orchestration.
 *
 * The pure rules (the six rules, stable content keys, dismissal filtering) live
 * in planning-suggest-core.ts; the durable store (dismissed keys ONLY) lives in
 * planning-suggest-store.ts. This module wires them to the real canvas/notes
 * stores so a suggestion can be computed read-only, dismissed, or ACCEPTED — an
 * accept lands the server-computed payload into the project (a note via the
 * notes store, a card via the canvas store, so the WSD_CANVAS.md mirror still
 * runs) and then dismisses its key so it never re-suggests.
 *
 * The list itself is NEVER persisted: it is a pure function of the live
 * canvas + notes, recomputed on every read. Only dismissals are durable, so a
 * "refresh" has nothing to save and no route exists for it.
 *
 * Security: an accept names ONLY a `key`. The text that gets written is the
 * server-computed suggestion's payload — or, for `empty_board`, the text read
 * from the notes STORE — never client-supplied content — so an editor cannot
 * use this route to inject arbitrary notes/cards.
 *
 * Resilience: a missing/corrupt canvas or notes store reads as empty (the real
 * stores already swallow that); every function folds the slug once via
 * `canonicalProjectSlug` and answers 404 for a value that can never be a slug.
 */
import { canonicalProjectSlug, HttpError } from './project-slug-core';
import { withFileLock } from './write-queue';
import {
  computeSuggestions,
  applyDismissals,
  type Suggestion,
} from './planning-suggest-core';
import { loadSuggestions, addDismissedKey } from './planning-suggest-store';
import { loadCanvas, saveCanvas, type CanvasEdge, type CanvasNode, type ProjectCanvas } from './project-canvas';
import { loadNotes, saveNotes, type NoteItem } from './project-notes';
import { recordActivity } from './project-activity';

export interface SuggestionList {
  items: Suggestion[];
  total: number;
}

export interface LandedSuggestion {
  target: 'note' | 'canvas';
  id: string;
}

/** Cap on the cards an accepted `empty_board` seeds (one per open note). */
export const EMPTY_BOARD_SEED_MAX = 20;

/** Missing/corrupt canvas → an empty board (never a throw). */
function safeLoadCanvas(clean: string): ProjectCanvas {
  try {
    return loadCanvas(clean);
  } catch {
    return { version: 1, nodes: [], edges: [], updatedAt: null };
  }
}

/** Missing/corrupt notes → no items (never a throw). */
function safeLoadNotes(clean: string): NoteItem[] {
  try {
    return loadNotes(clean).items;
  } catch {
    return [];
  }
}

/** Stored dismissal keys; a missing/corrupt store reads as none (never throws). */
function safeDismissedKeys(clean: string): string[] {
  try {
    return loadSuggestions(clean).dismissedKeys;
  } catch {
    return [];
  }
}

/** Compute the CURRENT suggestions, then drop every dismissed key. */
function computeFor(clean: string): Suggestion[] {
  const list = computeSuggestions(safeLoadCanvas(clean), { items: safeLoadNotes(clean) });
  return applyDismissals(list, safeDismissedKeys(clean));
}

/**
 * Read-only view of a project's current suggestions. Nothing is persisted: the
 * list is recomputed from the live canvas/notes on every call and the stored
 * dismissal list is applied on top.
 */
export function getSuggestions(slug: unknown): SuggestionList {
  const clean = canonicalProjectSlug(slug);
  if (!clean) return { items: [], total: 0 };
  const items = computeFor(clean);
  return { items, total: items.length };
}

/**
 * Remember a dismissed key so an unchanged subject never re-suggests. The key
 * must match a CURRENT suggestion (the same fresh recompute accept uses, with
 * dismissals applied) — an unknown key is a 404, mirroring accept. That also
 * makes re-dismissing an already-dismissed subject a 404: it is no longer
 * current. A junk slug/key is a 404/400 and records nothing.
 */
export function dismissSuggestion(slug: unknown, key: unknown): { ok: true } {
  const clean = canonicalProjectSlug(slug);
  if (!clean) throw new HttpError(404, 'Project not found');
  const k = typeof key === 'string' ? key.trim() : '';
  if (!k) throw new HttpError(400, 'key is required');
  if (!computeFor(clean).some((s) => s.key === k)) throw new HttpError(404, 'Suggestion not found');
  addDismissedKey(clean, k);
  return { ok: true };
}

/** A fresh card node at (0, y) — id scheme mirrors the note/canvas stores. */
function newCard(text: string, y: number): CanvasNode {
  return {
    id: `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    type: 'card',
    text,
    x: 0,
    y,
    w: 220,
    h: 120,
    color: 'yellow',
    done: false,
  };
}

/** A fresh chain edge between two seeded cards (the CanvasEdge {id,from,to}
 *  shape project-canvas normalizes). */
function newEdge(from: string, to: string): CanvasEdge {
  return {
    id: `e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    from,
    to,
  };
}

/** Persist the existing board plus `cards` (+ optional chain edges) in ONE
 *  write (mirror runs once); returns the saved, normalized document. */
function saveCards(
  clean: string,
  doc: ProjectCanvas,
  cards: CanvasNode[],
  extraEdges: CanvasEdge[] = [],
): ProjectCanvas {
  return saveCanvas(clean, {
    nodes: [...doc.nodes, ...cards],
    edges: [...doc.edges, ...extraEdges],
    ...(doc.sections ? { sections: doc.sections } : {}),
  });
}

/**
 * Land an accepted `empty_board` by SEEDING one card per OPEN note (capped at
 * EMPTY_BOARD_SEED_MAX) — the rule carries no text of its own
 * (`payload.text === ''`), so the generic landing would write an invisible
 * blank card and the board would still be empty. Each card's text comes from
 * the notes STORE (server-side), never from the caller. Falls back to every
 * note (done included) when no note is open, so the accept still seeds a board
 * (ruleEmptyBoard counts done notes too). Returns the FIRST seeded card's id.
 *
 * Seed hygiene (both parts, inside the caller's `suggest:<slug>` lock, so the
 * accept never floods the panel with rows about the board it just created):
 * (a) the seeded cards are CHAINED (`card[i] → card[i+1]`), so the very next
 *     recompute cannot fire `orphan_card` ×N on zero-edge cards — a LONE
 *     seeded card stays an orphan by design, there is nothing to chain it to;
 * (b) the `duplicate_item` keys the seeding itself creates are auto-dismissed
 *     via a fresh recompute — a key qualifies only when a ref touches one of
 *     the NEW cards AND every ref is a seeded note id or a new card id, so a
 *     pre-existing unrelated key (note↔note, or a pair involving an older
 *     card) is never dismissed. Nested `addDismissedKey` under the caller's
 *     lock is safe only while `withFileLock` is the sync passthrough (see
 *     write-queue.ts / the store's doc comment).
 */
function landEmptyBoard(clean: string): LandedSuggestion {
  const notes = safeLoadNotes(clean);
  if (!notes.length) throw new HttpError(404, 'Suggestion not found');
  const open = notes.filter((n) => !n.done);
  const seed = (open.length ? open : notes).slice(0, EMPTY_BOARD_SEED_MAX);
  const cards = seed.map((n, i) => newCard(n.text, i * 140));
  const chain = cards.slice(0, -1).map((c, i) => newEdge(c.id, cards[i + 1].id));
  const saved = saveCards(clean, safeLoadCanvas(clean), cards, chain);

  // (b) Auto-dismiss ONLY the duplicate_item keys the seeding itself created
  // (each seeded note's text now equals its own new card's text, so the next
  // recompute would otherwise fire duplicate_item ×N about this very accept).
  const seededNoteIds = new Set(seed.map((n) => n.id));
  const newCardIds = new Set(cards.map((c) => c.id));
  for (const s of computeSuggestions(saved, { items: notes })) {
    if (s.kind !== 'duplicate_item') continue;
    if (!s.refs.some((r) => newCardIds.has(r))) continue;
    if (!s.refs.every((r) => seededNoteIds.has(r) || newCardIds.has(r))) continue;
    addDismissedKey(clean, s.key);
  }
  return { target: 'canvas', id: cards[0].id };
}

/**
 * Land an accepted suggestion into the project. The payload text is the
 * SERVER-computed suggestion's — the client only named a key — so nothing
 * client-supplied reaches the store. A note lands through the notes store; a
 * card lands through the canvas store (keeping the WSD_CANVAS.md mirror). An
 * `empty_board` accept seeds the board from the notes instead (see above).
 */
function land(clean: string, suggestion: Suggestion): LandedSuggestion {
  if (suggestion.kind === 'empty_board') return landEmptyBoard(clean);
  if (suggestion.target === 'note') {
    const id = `n-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const item: NoteItem = {
      id,
      text: suggestion.payload.text,
      kind: suggestion.payload.kind ?? 'idea',
      done: false,
      createdAt: new Date().toISOString(),
    };
    saveNotes(clean, { items: [...safeLoadNotes(clean), item] });
    return { target: 'note', id };
  }
  const doc = safeLoadCanvas(clean);
  const card = newCard(suggestion.payload.text, 0);
  saveCards(clean, doc, [card]);
  return { target: 'canvas', id: card.id };
}

/**
 * Accept a suggestion by key: recompute, find the matching suggestion (a key
 * that matches no CURRENT suggestion is a 404), land its payload, then dismiss
 * the key so it never re-appears. Records the `suggestion_accepted` activity
 * event (userId when present, else System).
 */
export function acceptSuggestion(
  slug: unknown,
  key: unknown,
  userId?: string,
): { ok: true; landed: LandedSuggestion } {
  const clean = canonicalProjectSlug(slug);
  if (!clean) throw new HttpError(404, 'Project not found');
  if (typeof key !== 'string' || !key.trim()) throw new HttpError(400, 'key is required');
  const k = key.trim();
  const hit = computeFor(clean).find((s) => s.key === k);
  if (!hit) throw new HttpError(404, 'Suggestion not found');

  // Re-check the dismissal inside the per-slug lock, then land + dismiss as one
  // step. Residual, stated honestly: `withFileLock` is the SYNCHRONOUS
  // passthrough in write-queue.ts, so by itself it does not serialize. What
  // keeps a double-land out here is that this whole path is synchronous — Node
  // runs it to completion before another request's handler starts, so a second
  // accept of the same key recomputes AFTER the dismissal and 404s. The check
  // below is the belt-and-braces guard for a future async refactor (or a
  // multi-process split), where the sync lock stops being enough.
  const landed = withFileLock(`suggest:${clean}`, (): LandedSuggestion => {
    if (safeDismissedKeys(clean).includes(k)) throw new HttpError(404, 'Suggestion not found');
    const result = land(clean, hit);
    addDismissedKey(clean, k);
    return result;
  });

  recordActivity(clean, 'suggestion_accepted', { userId, details: { kind: hit.kind, target: hit.target } });
  return { ok: true, landed };
}
