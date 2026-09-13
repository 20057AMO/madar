/**
 * project-activity.ts
 * Madar — Per-project activity feed store.
 *
 * Every project keeps a compact JSONL-style history at
 * WSD_DATA_DIR/projects/<slug>/activity.json (mode 0600) answering
 * "من قام بماذا ومتى". Entries are appended oldest→newest and capped at
 * ACTIVITY_MAX_ENTRIES so `project.activity[activity.length-1]` stays the
 * newest event (consumers like frontend lib/time.ts's lastTouched depend on
 * that ordering).
 *
 * The file is per-slug write-locked (`activity:<slug>`); legacy projects that
 * only ever wrote meta.activity get LAZY backfilled into activity.json on the
 * first read — originating from meta.json read directly (never via
 * projects-meta, avoiding an import cycle) with a best-effort persist so the
 * migration happens exactly once.
 *
 * System events (crash detection, serve auto-restarts, scheduled snapshots)
 * record with no userId → actorName 'System'.
 */

import fs from 'fs';
import path from 'path';

import { withFileLock } from './write-queue';
import { getUserInfo, listUsers } from './user-store';
import {
  ACTIVITY_ACTIONS,
  ACTIVITY_MAX_ENTRIES,
  ACTIVITY_MAX_LIMIT,
  entryId,
  backfillFromLegacy,
  capActivity,
  isActivityAction,
  sanitizeDetails,
  sliceActivity,
  type ActivityEntry,
} from './activity-core';

const DATA_DIR = process.env.WSD_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const PROJECTS_DIR = path.join(DATA_DIR, 'projects');

export { ACTIVITY_ACTIONS, ACTIVITY_MAX_ENTRIES, ACTIVITY_MAX_LIMIT, capActivity, sliceActivity };
export type { ActivityEntry };

function cleanSlug(slug: unknown): string {
  const clean = String(slug ?? '').replace(/[^a-z0-9._-]+/gi, '').slice(0, 64);
  // A fully-dot value would resolve OUTSIDE projects/ — refuse it outright.
  return (clean === '.' || clean === '..') ? '' : clean;
}

function activityFile(clean: string): string {
  return path.join(PROJECTS_DIR, clean, 'activity.json');
}

function isValidDate(v: unknown): v is string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

/** Validate + normalize one stored row. Junk rows are dropped. */
function normalizeEntry(raw: unknown): ActivityEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isActivityAction(r.action)) return null;
  const id = typeof r.id === 'string' && /^[a-zA-Z0-9-]{4,60}$/.test(r.id) ? r.id : entryId();
  const at = isValidDate(r.at) ? (r.at as string) : new Date().toISOString();
  const userId = typeof r.userId === 'string' && r.userId ? r.userId : undefined;
  const actorName = typeof r.actorName === 'string' && r.actorName ? r.actorName : undefined;
  const details = sanitizeDetails(r.details);
  return {
    id,
    action: r.action as string,
    at,
    ...(userId ? { userId } : {}),
    ...(actorName ? { actorName } : {}),
    ...(details ? { details } : {}),
  };
}

/** Resolve the actor label: stored name > live username > System. */
function resolveActorName(userId: string | undefined, storedActorName: string | undefined): string | undefined {
  if (storedActorName) return storedActorName;
  if (userId) return getUserInfo(userId)?.username;
  return 'System';
}

/** Read meta.json's legacy activity array DIRECTLY (no projects-meta import). */
function readMetaActivity(clean: string): unknown[] {
  const metaFile = path.join(PROJECTS_DIR, clean, 'meta.json');
  try {
    if (!fs.existsSync(metaFile)) return [];
    const parsed = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    return Array.isArray(parsed?.activity) ? (parsed.activity as unknown[]) : [];
  } catch {
    return [];
  }
}

/**
 * Lazy migration: the project predates activity.json — backfill from
 * meta.activity (if any), resolve actor names, persist best-effort so the
 * next read is cheap, and return the backfilled list.
 */
function lazyBackfill(clean: string): ActivityEntry[] {
  const now = new Date().toISOString();
  const backfilled = backfillFromLegacy(readMetaActivity(clean), now).map((e) => {
    const actor = resolveActorName(e.userId, undefined);
    return { ...e, ...(actor ? { actorName: actor } : {}) };
  });
  const entries = capActivity(backfilled, ACTIVITY_MAX_ENTRIES);
  try {
    fs.mkdirSync(path.dirname(activityFile(clean)), { recursive: true });
    fs.writeFileSync(activityFile(clean), JSON.stringify(entries, null, 2), { encoding: 'utf8', mode: 0o600 });
  } catch {
    /* backfill persistence is best-effort — the migration re-runs next read */
  }
  return entries;
}

/** Raw, sanitized, capped history in file order (oldest→newest). */
function readEntries(clean: string): ActivityEntry[] {
  try {
    const file = activityFile(clean);
    if (!fs.existsSync(file)) return lazyBackfill(clean);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list: unknown[] = Array.isArray(parsed) ? parsed : [];
    return capActivity(
      list.map(normalizeEntry).filter((e): e is ActivityEntry => e !== null),
      ACTIVITY_MAX_ENTRIES,
    );
  } catch {
    return [];
  }
}

/**
 * Read a project's full activity history (oldest→newest). Missing/corrupt
 * stores yield an empty list — the feed must never break a read path.
 */
export function loadActivity(slug: string): ActivityEntry[] {
  return readEntries(cleanSlug(slug));
}

/**
 * Record one event. Resolves the actor via getUserInfo when no actorName is
 * given; no user at all → 'System'. Never throws — a failed activity write
 * must not break a container lifecycle op (same philosophy as recordAudit).
 */
export function recordActivity(
  slug: string,
  action: string,
  opts: { userId?: string; actorName?: string; details?: unknown; at?: string } = {},
): ActivityEntry | null {
  const clean = cleanSlug(slug);
  if (!clean || !isActivityAction(action)) return null;
  const at = isValidDate(opts.at) ? (opts.at as string) : new Date().toISOString();
  const actorName = resolveActorName(opts.userId, opts.actorName);
  const details = sanitizeDetails(opts.details);
  const entry: ActivityEntry = {
    id: entryId(),
    action,
    at,
    ...(opts.userId ? { userId: opts.userId } : {}),
    ...(actorName ? { actorName } : {}),
    ...(details ? { details } : {}),
  };
  withFileLock(`activity:${clean}`, () => {
    try {
      const next = capActivity([...readEntries(clean), entry], ACTIVITY_MAX_ENTRIES);
      fs.mkdirSync(path.dirname(activityFile(clean)), { recursive: true });
      fs.writeFileSync(activityFile(clean), JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
    } catch {
      /* activity recording must never break the request/lifecycle flow */
    }
  });
  return entry;
}

/**
 * API listing — newest first, paginated with an honest total, and each entry
 * enriched with live people data (actorDisplayName / actorAvatarExt) resolved
 * from listUsers() exactly once per call.
 */
export function listActivity(
  slug: string,
  opts: { limit?: number; offset?: number } = {},
): { entries: ActivityEntry[]; total: number } {
  const limit = Math.min(Math.max(Math.trunc(Number.isFinite(opts.limit) ? (opts.limit as number) : 50), 1), ACTIVITY_MAX_LIMIT);
  const offset = Math.max(Math.trunc(Number.isFinite(opts.offset) ? (opts.offset as number) : 0), 0);
  const all = readEntries(cleanSlug(slug));

  const users = listUsers();
  const byId = new Map(users.map((u) => [u.id, u]));
  const byName = new Map(users.map((u) => [u.username, u]));
  const enriched: ActivityEntry[] = all.map((e) => {
    const row = (e.userId ? byId.get(e.userId) : null) || (e.actorName ? byName.get(e.actorName) : null) || null;
    const actorName = e.actorName || row?.username || '(deleted user)';
    return {
      ...e,
      actorName,
      ...(row?.profile?.displayName ? { actorDisplayName: row.profile.displayName } : {}),
      ...(row?.profile?.avatarExt ? { actorAvatarExt: row.profile.avatarExt } : {}),
    };
  });

  return sliceActivity(enriched, limit, offset);
}