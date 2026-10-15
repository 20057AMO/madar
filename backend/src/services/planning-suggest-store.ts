/**
 * planning-suggest-store.ts
 * Madar — Per-project planning-suggestion DISMISSAL store at
 * WSD_DATA_DIR/projects/<slug>/suggestions.json (mode 0600), holding only a
 * DISMISSED_MAX (200) key list. Written under a per-slug file lock
 * (`suggest:<slug>`) like notes/digests; reads always sanitize and never throw
 * — a corrupt/missing store reads as empty.
 *
 * There is deliberately NO persisted `items` list. The suggestion list is a
 * pure function of the live canvas + notes (planning-suggest.ts recomputes it
 * on every GET), so persisting a computed copy would be a stale duplicate that
 * a "refresh" has to keep in sync — and nothing ever read it back. What must
 * survive between reads is exactly one thing: the `dismissedKeys` values (the
 * contentKey(kind, text) subjects the user rejected), so an unchanged subject
 * never re-suggests after a dismissal.
 *
 * Mirrors project-digest-store.ts deliberately (same slug handling, lock and
 * never-throw contract).
 */
import fs from 'fs';
import path from 'path';

import { withFileLock } from './write-queue';
import { assertSafeStoreSlug, isStrictlyInside, HttpError } from './project-slug-core';
import { DISMISSED_MAX, sanitizeDismissed } from './planning-suggest-core';

const DATA_DIR = process.env.WSD_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const META_DIR = path.join(DATA_DIR, 'projects');

export interface SuggestionsDoc {
  dismissedKeys: string[];
}

const MAX_KEY_CHARS = 4096;

function cleanSlug(slug: unknown): string {
  const clean = String(slug ?? '').replace(/[^a-z0-9._-]+/gi, '').slice(0, 64);
  return clean === '.' || clean === '..' ? '' : clean;
}

/**
 * Resolve the suggestions.json path for a store slug.
 *
 * `cleanSlug` above is a character filter only — it deliberately keeps dots, so
 * `.` / `..` would survive a regression in that filter. Mirror project-digest-
 * store: every read/write pairs the filter with `assertSafeStoreSlug` (which
 * refuses `.`/`..`/separators and proves the key resolves strictly inside
 * META_DIR) plus an explicit `isStrictlyInside` assertion on the FILE, so a
 * future filter regression can never become traversal.
 */
function suggestionsFile(clean: string): string {
  const safe = assertSafeStoreSlug(clean, META_DIR);
  const file = path.join(META_DIR, safe, 'suggestions.json');
  if (!isStrictlyInside(path.resolve(META_DIR), path.resolve(file))) {
    throw new HttpError(400, 'Project slug is invalid');
  }
  return file;
}

/**
 * Read the store. A legacy file that still carries an `items` array is read for
 * its `dismissedKeys` alone — the computed list is never trusted (it is
 * recomputed) and the stale `items` field is dropped on the next write.
 */
function readDoc(clean: string): SuggestionsDoc {
  try {
    const file = suggestionsFile(clean);
    if (!fs.existsSync(file)) return { dismissedKeys: [] };
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { dismissedKeys: [] };
    return { dismissedKeys: sanitizeDismissed((parsed as Record<string, unknown>).dismissedKeys) };
  } catch {
    return { dismissedKeys: [] };
  }
}

function persist(clean: string, doc: SuggestionsDoc): void {
  const file = suggestionsFile(clean);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc, null, 2), { encoding: 'utf8', mode: 0o600 });
}

/** Sanitized dismissals — missing/corrupt stores and junk slugs read empty. */
export function loadSuggestions(slug: unknown): SuggestionsDoc {
  const clean = cleanSlug(slug);
  if (!clean) return { dismissedKeys: [] };
  return readDoc(clean);
}

/**
 * Remember a dismissed `key` (idempotent, capped at DISMISSED_MAX — the
 * OLDEST key falls off the front). True when the key is persisted (or already
 * present); false for a junk slug/key or a failed write. Never throws.
 * Callers already holding `suggest:<slug>` may call this — safe only while
 * `withFileLock` is a sync passthrough (see write-queue.ts).
 */
export function addDismissedKey(slug: unknown, key: unknown): boolean {
  const clean = cleanSlug(slug);
  const k = typeof key === 'string' ? key.trim().slice(0, MAX_KEY_CHARS) : '';
  if (!clean || !k) return false;
  let ok = false;
  withFileLock(`suggest:${clean}`, () => {
    try {
      const doc = readDoc(clean);
      const dismissedKeys = [...doc.dismissedKeys.filter((x) => x !== k), k].slice(-DISMISSED_MAX);
      persist(clean, { dismissedKeys });
      ok = true;
    } catch {
      /* best effort */
    }
  });
  return ok;
}
