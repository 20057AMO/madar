/**
 * activity-core.ts
 * Madar — Pure rules for the per-project activity feed — NO service imports so
 * it can be unit-tested directly under node --test (ESM type-stripping requires
 * explicit relative extensions, which production CJS forbids).
 *
 * The activity feed answers "من قام بماذا ومتى" per project. Entries are
 * appended oldest→newest in the store file (so `activity[activity.length-1]`
 * stays the newest for consumers like lib/time.ts's lastTouched), and the
 * API-facing list reverses to newest-first via sliceActivity.
 */

/** The complete, canonical action vocabulary (28 events). */
export const ACTIVITY_ACTIONS = [
  // Lifecycle (9)
  'created',
  'recreated',
  'duplicated',
  'imported',
  'restored',
  'deleted',
  'started',
  'stopped',
  'cloned',
  // Configuration (5)
  'updated',
  'env_updated',
  'tags_updated',
  'ports_updated',
  'limits_updated',
  // Content (2)
  'notes_saved',
  'canvas_saved',
  // Team (4)
  'member_added',
  'member_removed',
  'member_role_changed',
  'ownership_transferred',
  // Snapshots (4)
  'snapshot_captured',
  'snapshot_deleted',
  'snapshot_config',
  'exported',
  // Static serving (2)
  'serve_started',
  'serve_stopped',
  // Crashes (2)
  'crashed',
  'crash_cleared',
] as const;

/** Per-list cap for the activity API (mirrors listAudit's MAX_ENTRIES). */
export const ACTIVITY_MAX_LIMIT = 100;

/** Hard ceiling on stored entries per project (append + slice(-max)). */
export const ACTIVITY_MAX_ENTRIES = 200;

export interface ActivityEntry {
  /** Stable, unique row id (a-<rand6>-<rand6>). */
  id: string;
  action: string;
  at: string;
  /** The user who performed the action — absent for system events. */
  userId?: string;
  /** Username snapshot taken at record time — 'System' for no-actor events. */
  actorName?: string;
  /** Sanitized, small, structured payload (numbers/strings/string arrays). */
  details?: Record<string, unknown>;
}

export function isActivityAction(v: unknown): boolean {
  return typeof v === 'string' && (ACTIVITY_ACTIONS as readonly string[]).includes(v);
}

/**
 * Collapse an arbitrary details object into the safe subset the feed records:
 * finite numbers, strings and arrays of strings only. Anything else (objects,
 * booleans, null, nested arrays, functions…) is dropped per key. The final
 * object is capped at 400 serialized characters — keys that would overflow are
 * skipped in insertion order, so a junk payload can never bloat a project file.
 */
export function sanitizeDetails(d: unknown): Record<string, unknown> | undefined {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return undefined;
  const candidates: Array<[string, unknown]> = [];
  for (const [key, v] of Object.entries(d)) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      candidates.push([key, v]);
    } else if (typeof v === 'string') {
      candidates.push([key, v.slice(0, 200)]);
    } else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
      candidates.push([key, v.slice(0, 20).map((x) => String(x).slice(0, 100))]);
    }
    /* anything else — dropped */
  }
  const out: Record<string, unknown> = {};
  for (const [key, v] of candidates) {
    const probe = { ...out, [key]: v };
    if (JSON.stringify(probe).length > 400) continue;
    out[key] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Append one entry and keep only the `max` newest (oldest→newest order kept). */
export function appendActivity(entries: ActivityEntry[], entry: ActivityEntry | null | undefined, max: number): ActivityEntry[] {
  return capActivity([...(Array.isArray(entries) ? entries : []), ...(entry ? [entry] : [])], max);
}

/** Trim a list to its `max` newest entries (in place — returns a new array). */
export function capActivity(entries: ActivityEntry[], max: number): ActivityEntry[] {
  const list = Array.isArray(entries) ? entries : [];
  const cap = Math.trunc(Number.isFinite(max) ? max : ACTIVITY_MAX_ENTRIES);
  if (cap <= 0) return [];
  // slice(-cap) keeps the cap newest; when cap ≥ length it returns the whole list.
  return list.slice(-Math.min(cap, list.length));
}

/**
 * API pagination — newest-first + total (honest count BEFORE paging, so a
 * client can render “N events” even mid-page). Negative/junk limits normalize
 * to safe floors.
 */
export function sliceActivity(entries: ActivityEntry[], limit: number, offset: number): { entries: ActivityEntry[]; total: number } {
  const list = Array.isArray(entries) ? entries : [];
  const lim = Math.max(0, Math.trunc(Number.isFinite(limit) ? limit : 50));
  const off = Math.max(0, Math.trunc(Number.isFinite(offset) ? offset : 0));
  const reversed = [...list].reverse();
  return { entries: reversed.slice(off, off + lim), total: list.length };
}

/**
 * Legacy meta.activity action strings → the canonical activity action names.
 * Most legacy rows already used the canonical forms ('created', 'started',
 * 'ports_updated', 'crashed'…); kebab-case rows ('ownership-transferred') are
 * translated. Unknown actions are skipped during backfill.
 */
export const LEGACY_ACTION_MAP: Record<string, string> = {
  'ownership-transferred': 'ownership_transferred',
  'member-added': 'member_added',
  'member-removed': 'member_removed',
  'member-role-changed': 'member_role_changed',
  'ports-updated': 'ports_updated',
  'limits-updated': 'limits_updated',
  'env-updated': 'env_updated',
  'tags-updated': 'tags_updated',
  'notes-saved': 'notes_saved',
  'canvas-saved': 'canvas_saved',
  'snapshot-captured': 'snapshot_captured',
  'snapshot-deleted': 'snapshot_deleted',
  'snapshot-config': 'snapshot_config',
  'serve-started': 'serve_started',
  'serve-stopped': 'serve_stopped',
};

function isValidDate(v: unknown): v is string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

/**
 * Migrate a meta.json `activity` array into canonical feed entries. Order is
 * preserved (oldest→newest); rows with unknown actions are skipped, missing
 * timestamps default to `now`, and legacy `at`/userId fields are carried over.
 * Stored `actorName` is resolved by the store (this module stays pure).
 */
export function backfillFromLegacy(metaActivity: unknown, now: string): ActivityEntry[] {
  if (!Array.isArray(metaActivity)) return [];
  const out: ActivityEntry[] = [];
  for (const raw of metaActivity) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const rawAction = typeof r.action === 'string' ? r.action.trim() : '';
    const action = LEGACY_ACTION_MAP[rawAction] ?? rawAction;
    if (!isActivityAction(action)) continue;
    const at = isValidDate(r.at) ? r.at : now;
    const userId = typeof r.userId === 'string' && r.userId ? r.userId : undefined;
    const details = sanitizeDetails(r.details);
    out.push({
      id: entryId(),
      action,
      at,
      ...(userId ? { userId } : {}),
      ...(details ? { details } : {}),
    });
  }
  return out;
}

/** Stable-ish unique entry id — `a-<rand6>-<rand6>` (mirrors legacy event ids). */
export function entryId(): string {
  return `a-${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}-${Math.random()
    .toString(36)
    .slice(2, 8)
    .padEnd(6, '0')}`;
}