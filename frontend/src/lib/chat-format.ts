/**
 * chat-format.ts
 * Madar — pure formatting/grouping helpers for team-chat message threads.
 * No imports, fully unit-testable (mirrors the import-free *-core.ts style).
 */

export type DayKey = 'today' | 'yesterday' | string;

/** Local YYYY-MM-DD for an ISO timestamp. */
function isoDay(ts: number): string {
  const d = new Date(ts);
  const yy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/**
 * Bucket an ISO timestamp into a day-separator key: `'today'`, `'yesterday'`,
 * or a `YYYY-MM-DD` string for older days. `now` is injectable for tests.
 */
export function daySeparatorKey(iso: string, now: number | Date = Date.now()): DayKey {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown';
  const ref = now instanceof Date ? now.getTime() : now;
  const refDay = new Date(ref);
  const refStart = new Date(refDay.getFullYear(), refDay.getMonth(), refDay.getDate()).getTime();
  const msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.round((refStart - msgDay) / 86400000);
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  return isoDay(d.getTime());
}

/** Human-readable label for a day key (`formatDayLabel(daySeparatorKey(iso))`). */
export function formatDayLabel(key: DayKey): string {
  if (key === 'today') return 'Today';
  if (key === 'yesterday') return 'Yesterday';
  if (key === 'unknown') return 'Unknown';
  const [y, m, dd] = key.split('-').map(Number);
  if (!y || !m || !dd) return key;
  return new Date(y, m - 1, dd).toLocaleDateString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Should `cur` visually group under consecutive `prev` (avatar/author hidden)?
 * Same sender AND a gap ≤ `maxGapMs` (default 10 min).
 */
export function shouldGroup(prevIso: string, curIso: string, maxGapMs = 600_000, sameUser: boolean): boolean {
  if (!sameUser) return false;
  const gap = new Date(curIso).getTime() - new Date(prevIso).getTime();
  return Number.isFinite(gap) && gap >= 0 && gap <= maxGapMs;
}