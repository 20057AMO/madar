/**
 * project-digest-store.ts
 * Madar — Per-project intelligence-digest history at
 * WSD_DATA_DIR/projects/<slug>/digests.json (mode 0600), capped at
 * MAX_DIGESTS (20). Written under a per-slug file lock (`digest:<slug>`) like
 * notes/activity/delegations; reads always sanitize and never throw — a
 * corrupt/missing store reads as empty.
 *
 * Mirrors opencode-delegate-store.ts deliberately (same shape, no shared
 * import): running → done/failed rows, a boot reconcile that flips an orphaned
 * `running` row left by a crash, and an oldest→newest file whose last row is
 * the newest digest. The API listing reverses to newest-first with an honest
 * total.
 */
import fs from 'fs';
import path from 'path';

import { withFileLock } from './write-queue';
import { assertSafeStoreSlug, isStrictlyInside, HttpError } from './project-slug-core';
import {
  MAX_DIGESTS,
  DIGEST_OUTPUT_MAX,
  MAX_DIGEST_ITEMS,
  capDigests,
  digestEntryId,
} from './digest-core';

const DATA_DIR = process.env.WSD_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const META_DIR = path.join(DATA_DIR, 'projects');

/** Per-list cap for the digest API (mirrors listActivity's ACTIVITY_MAX_LIMIT). */
export const DIGEST_MAX_LIMIT = 100;

export type DigestTrigger = 'schedule' | 'manual';
export type DigestStatus = 'running' | 'done' | 'failed';

export interface DigestEntry {
  id: string;
  createdAt: string;
  finishedAt?: string;
  durationMs?: number;
  trigger: DigestTrigger;
  status: DigestStatus;
  summary: string;
  blockers: string[];
  nextSteps: string[];
  error?: string;
  provider?: string;
  model?: string;
  tokens?: number | null;
  cost?: number | null;
  sourceSignature?: string;
  userId?: string;
  actorName?: string;
}

const TRIGGERS: DigestTrigger[] = ['schedule', 'manual'];
const STATUSES: DigestStatus[] = ['running', 'done', 'failed'];

function cleanSlug(slug: unknown): string {
  const clean = String(slug ?? '').replace(/[^a-z0-9._-]+/gi, '').slice(0, 64);
  return clean === '.' || clean === '..' ? '' : clean;
}

/**
 * Resolve the digests.json path for a store slug.
 *
 * `cleanSlug` above is a character filter only — it deliberately keeps dots, so
 * `.` / `..` would survive a regression in that filter. Mirror projects-meta:
 * every read/write pairs the filter with `assertSafeStoreSlug` (which refuses
 * `.`/`..`/separators and proves the key resolves strictly inside META_DIR) plus
 * an explicit `isStrictlyInside` assertion on the FILE, so a future filter
 * regression can never become traversal. Callers already guard the empty fold,
 * and their try/catch keeps the never-throw contract for a rejected key.
 */
function digestsFile(clean: string): string {
  const safe = assertSafeStoreSlug(clean, META_DIR);
  const file = path.join(META_DIR, safe, 'digests.json');
  if (!isStrictlyInside(path.resolve(META_DIR), path.resolve(file))) {
    throw new HttpError(400, 'Project slug is invalid');
  }
  return file;
}

function isValidDate(v: unknown): v is string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

function normalizeStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const text = v.trim().slice(0, 400);
    if (text) out.push(text);
    if (out.length >= MAX_DIGEST_ITEMS) break;
  }
  return out;
}

/** Validate + normalize one stored row — junk rows are dropped. */
function normalizeEntry(raw: unknown): DigestEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const id = typeof r.id === 'string' && /^g-[a-z0-9]{6}-[a-z0-9]{6}$/.test(r.id) ? r.id : digestEntryId();
  const trigger: DigestTrigger = TRIGGERS.includes(r.trigger as DigestTrigger)
    ? (r.trigger as DigestTrigger)
    : 'manual';
  const status: DigestStatus = STATUSES.includes(r.status as DigestStatus)
    ? (r.status as DigestStatus)
    : 'failed';

  const entry: DigestEntry = {
    id,
    createdAt: isValidDate(r.createdAt) ? r.createdAt : new Date().toISOString(),
    trigger,
    status,
    summary: typeof r.summary === 'string' ? r.summary.slice(0, DIGEST_OUTPUT_MAX) : '',
    blockers: normalizeStringList(r.blockers),
    nextSteps: normalizeStringList(r.nextSteps),
  };
  if (isValidDate(r.finishedAt)) entry.finishedAt = r.finishedAt;
  if (typeof r.durationMs === 'number' && Number.isFinite(r.durationMs)) entry.durationMs = r.durationMs;
  if (typeof r.error === 'string') entry.error = r.error.slice(0, 1000);
  if (typeof r.provider === 'string' && r.provider) entry.provider = r.provider.slice(0, 200);
  if (typeof r.model === 'string' && r.model) entry.model = r.model.slice(0, 200);
  if (typeof r.sourceSignature === 'string' && r.sourceSignature) entry.sourceSignature = r.sourceSignature.slice(0, 2000);
  if (typeof r.userId === 'string' && r.userId) entry.userId = r.userId;
  if (typeof r.actorName === 'string' && r.actorName) entry.actorName = r.actorName;
  if (typeof r.tokens === 'number' && Number.isFinite(r.tokens)) entry.tokens = r.tokens;
  else if (r.tokens === null) entry.tokens = null;
  if (typeof r.cost === 'number' && Number.isFinite(r.cost)) entry.cost = r.cost;
  else if (r.cost === null) entry.cost = null;
  return entry;
}

function readEntries(clean: string): DigestEntry[] {
  try {
    const file = digestsFile(clean);
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list: unknown[] = Array.isArray(parsed) ? parsed : [];
    return capDigests(
      list.map(normalizeEntry).filter((e): e is DigestEntry => e !== null),
      MAX_DIGESTS,
    );
  } catch {
    return [];
  }
}

function persist(clean: string, entries: DigestEntry[], mode: number = 0o600): void {
  const file = digestsFile(clean);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(entries, null, 2), { encoding: 'utf8', mode });
}

/**
 * API listing — newest first, paginated with an honest total (BEFORE paging).
 * Missing/corrupt stores and junk slugs yield `{ entries: [], total: 0 }`.
 */
export function listDigests(
  slug: unknown,
  opts: { limit?: number; offset?: number } = {},
): { entries: DigestEntry[]; total: number } {
  const clean = cleanSlug(slug);
  if (!clean) return { entries: [], total: 0 };
  const all = readEntries(clean);
  const limit = Math.min(
    Math.max(Math.trunc(Number.isFinite(opts.limit) ? (opts.limit as number) : 50), 1),
    DIGEST_MAX_LIMIT,
  );
  const offset = Math.max(Math.trunc(Number.isFinite(opts.offset) ? (opts.offset as number) : 0), 0);
  const reversed = [...all].reverse();
  return { entries: reversed.slice(offset, offset + limit), total: all.length };
}

/** One entry by id — undefined when unknown. */
export function getDigest(slug: unknown, id: unknown): DigestEntry | undefined {
  const clean = cleanSlug(slug);
  if (!clean || typeof id !== 'string' || !id) return undefined;
  return readEntries(clean).find((e) => e.id === id);
}

/**
 * Append one entry (oldest→newest) and prune to MAX_DIGESTS. Never throws —
 * a failed write must not break a digest run.
 */
export function appendDigest(slug: unknown, entry: DigestEntry): DigestEntry | null {
  const clean = cleanSlug(slug);
  const normalized = normalizeEntry(entry);
  if (!clean || !normalized) return null;
  withFileLock(`digest:${clean}`, () => {
    try {
      const next = capDigests([...readEntries(clean), normalized], MAX_DIGESTS);
      persist(clean, next);
    } catch {
      /* digest history must never break the flow */
    }
  });
  return normalized;
}

/**
 * Update one existing entry in place (the running row flips to done/failed and
 * gains its summary/error/duration). Returns the updated entry or undefined
 * when the id is unknown. Never throws.
 */
export function updateDigest(
  slug: unknown,
  id: string,
  patch: Partial<Omit<DigestEntry, 'id'>>,
): DigestEntry | undefined {
  const clean = cleanSlug(slug);
  if (!clean || !/^g-[a-z0-9]{6}-[a-z0-9]{6}$/.test(id)) return undefined;
  let updated: DigestEntry | undefined;
  withFileLock(`digest:${clean}`, () => {
    try {
      const entries = readEntries(clean);
      const idx = entries.findIndex((e) => e.id === id);
      if (idx < 0) return;
      const merged = { ...entries[idx], ...patch, id };
      const normalized = normalizeEntry(merged);
      if (!normalized) return;
      entries[idx] = normalized;
      updated = normalized;
      persist(clean, capDigests(entries, MAX_DIGESTS));
    } catch {
      /* best effort */
    }
  });
  return updated;
}

/** Delete one entry; true when it existed. Never throws. */
export function deleteDigest(slug: unknown, id: unknown): boolean {
  const clean = cleanSlug(slug);
  if (!clean || typeof id !== 'string' || !id) return false;
  let removed = false;
  withFileLock(`digest:${clean}`, () => {
    try {
      const entries = readEntries(clean);
      const next = entries.filter((e) => e.id !== id);
      if (next.length === entries.length) return;
      removed = true;
      persist(clean, next);
    } catch {
      /* best effort */
    }
  });
  return removed;
}

/**
 * Reconcile entries left `running` by a crashed server: flip them to `failed`
 * with a server-restart marker so the history never shows a permanently-pending
 * digest. Called at boot.
 */
export function reconcileRunningDigests(): void {
  let slugs: string[] = [];
  try {
    slugs = fs.existsSync(META_DIR) ? fs.readdirSync(META_DIR) : [];
  } catch {
    return;
  }
  for (const slug of slugs) {
    if (!cleanSlug(slug)) continue;
    const running = readEntries(slug).filter((e) => e.status === 'running');
    if (!running.length) continue;
    withFileLock(`digest:${slug}`, () => {
      try {
        const entries = readEntries(slug).map((e) =>
          e.status === 'running'
            ? {
                ...e,
                status: 'failed' as const,
                finishedAt: new Date().toISOString(),
                error: 'Interrupted by server restart',
              }
            : e,
        );
        persist(slug, entries);
      } catch {
        /* best effort */
      }
    });
  }
}

export { MAX_DIGESTS };
