/**
 * reviews-core.ts
 * Madar — Pure rules for per-project file reviews — NO service imports so it
 * can be unit-tested directly under node --test (same pattern as activity-core:
 * ESM type-stripping requires explicit relative extensions, which production
 * CJS forbids).
 *
 * A review thread is a comment conversation pinned to a file path inside the
 * project workspace:
 *
 *   { id, path, status: 'open'|'resolved',
 *     createdAt, createdBy, createdByName,        // username snapshot at write
 *     resolvedAt?, resolvedBy?, resolvedByName?,  // only while resolved
 *     comments: [ { id, text, userId, username, createdAt } ] }
 *
 * The opening statement IS the first comment; replies append to `comments`.
 * All ceilings are enforced here (path ≤1024, text ≤2000, 200 threads/project,
 * 100 comments/thread) so callers get one canonical rule set.
 */

export const MAX_REVIEW_PATH = 1024;
export const MAX_REVIEW_TEXT = 2000;
export const MAX_THREADS = 200;
export const MAX_COMMENTS = 100;

export type ReviewStatus = 'open' | 'resolved';

export interface ReviewComment {
  id: string;
  text: string;
  userId: string;
  username: string;
  createdAt: string;
}

export interface ReviewThread {
  id: string;
  path: string;
  status: ReviewStatus;
  createdAt: string;
  createdBy: string;
  createdByName: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolvedByName?: string;
  comments: ReviewComment[];
}

const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
export const CONTROL_RE = /[\u0000-\u001f\u007f]/;

function isValidId(v: unknown): string | null {
  return typeof v === 'string' && ID_RE.test(v) ? v : null;
}

function isValidDate(v: unknown): string | null {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null;
}

/** Stable-ish unique row ids — mirror the activity feed's entryId pattern. */
export function reviewId(): string {
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function commentId(): string {
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Normalize a review path to a safe, posix, project-relative string, or:
 *  - ''  for absent/empty input (caller decides whether that is acceptable)
 *  - null for anything malicious: traversal ('../'), absolute, drive-letter,
 *        backslash, control characters, or longer than MAX_REVIEW_PATH.
 * Paths that stay inside the project are normalized ('a/./b' → 'a/b'), so the
 * stored key is exactly what the workspace lookup will stat.
 */
export function normalizeReviewPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const p = raw.trim();
  if (!p) return '';
  if (p.length > MAX_REVIEW_PATH) return null;
  if (CONTROL_RE.test(p)) return null;
  if (p.includes('\\')) return null;
  if (p.startsWith('/')) return null;
  if (/^[a-zA-Z]:/.test(p)) return null;

  // Stack-based posix normalization (no path module needed — import-free).
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!out.length) return null; // escapes above the project root
      out.pop();
      continue;
    }
    out.push(part);
  }
  const norm = out.join('/');
  if (!norm) return '';
  return norm.length > MAX_REVIEW_PATH ? null : norm;
}

/** Trim + hard ceiling for any comment/opening text (2000 chars). */
export function sanitizeCommentText(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().slice(0, MAX_REVIEW_TEXT) : '';
}

function normalizeComment(raw: unknown, now: string): ReviewComment | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const text = sanitizeCommentText(r.text);
  if (!text) return null;
  return {
    id: isValidId(r.id) ?? commentId(),
    text,
    userId: typeof r.userId === 'string' && r.userId ? r.userId : '',
    username: typeof r.username === 'string' && r.username ? r.username : '',
    createdAt: isValidDate(r.createdAt) ?? now,
  };
}

/**
 * Validate + normalize a stored threads array. Junk rows (non-objects,
 * malicious/missing paths) are dropped; salvageable rows get missing fields
 * rooted (id/createdAt generated, unknown status → 'open', stale resolution
 * fields stripped from open threads). Output is capped to MAX_THREADS.
 */
export function validateThreads(raw: unknown, now?: string): ReviewThread[] {
  if (!Array.isArray(raw)) return [];
  const ts = now ?? new Date().toISOString();
  const out: ReviewThread[] = [];
  const seenThreadIds = new Set<string>();
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue;
    const r = t as Record<string, unknown>;
    const path = normalizeReviewPath(r.path);
    if (!path) continue; // null (malicious) or '' (rootless) — drop
    // Resolve the thread id — generated fallback ids are never deduped.
    const rawThreadId = isValidId(r.id);
    if (rawThreadId && seenThreadIds.has(rawThreadId)) continue; // duplicate thread id → drop
    if (rawThreadId) seenThreadIds.add(rawThreadId);
    // Dedup comments: track input ids that normalizeComment would accept.
    const commentsRaw: unknown[] = Array.isArray(r.comments) ? r.comments : [];
    const seenCommentIds = new Set<string>();
    const comments: ReviewComment[] = [];
    for (const c of commentsRaw) {
      const nc = normalizeComment(c, ts);
      if (!nc) continue;
      // If the raw input carried a valid id, it counts as a potential duplicate.
      const rawCid = c && typeof c === 'object' ? isValidId((c as Record<string, unknown>).id) : null;
      if (rawCid) {
        if (seenCommentIds.has(rawCid)) continue; // duplicate comment id → drop
        seenCommentIds.add(rawCid);
      }
      comments.push(nc);
      if (comments.length >= MAX_COMMENTS) break;
    }
    const thread: ReviewThread = {
      id: rawThreadId ?? reviewId(),
      path,
      status: r.status === 'resolved' ? 'resolved' : 'open',
      createdAt: isValidDate(r.createdAt) ?? ts,
      createdBy: typeof r.createdBy === 'string' ? r.createdBy : '',
      createdByName: typeof r.createdByName === 'string' ? r.createdByName : '',
      comments,
    };
    if (thread.status === 'resolved') {
      thread.resolvedAt = isValidDate(r.resolvedAt) ?? ts;
      thread.resolvedBy = typeof r.resolvedBy === 'string' ? r.resolvedBy : '';
      thread.resolvedByName = typeof r.resolvedByName === 'string' ? r.resolvedByName : '';
    }
    out.push(thread);
  }
  return out.slice(0, MAX_THREADS);
}

/**
 * Pure state transitions — the ONLY allowed path is open → resolved → open.
 * Calling resolve on an already-resolved (or reopen on an already-open) thread
 * is a no-op that returns the thread unchanged.
 */
export function resolveThread(t: ReviewThread, userId: string, username: string, now?: string): ReviewThread {
  if (t.status === 'resolved') return t;
  return {
    ...t,
    status: 'resolved',
    resolvedAt: now ?? new Date().toISOString(),
    resolvedBy: userId,
    resolvedByName: username,
  };
}

export function reopenThread(t: ReviewThread): ReviewThread {
  if (t.status === 'open') return t;
  const next: ReviewThread = { ...t, status: 'open', comments: t.comments };
  delete next.resolvedAt;
  delete next.resolvedBy;
  delete next.resolvedByName;
  return next;
}

/** Append one comment (the store enforces the MAX_COMMENTS ceiling). */
export function addComment(t: ReviewThread, comment: ReviewComment): ReviewThread {
  return { ...t, comments: [...t.comments, comment] };
}

export type DeleteCommentResult =
  | { thread: ReviewThread; error: null }
  | { thread: null; error: 'not-found' | 'last-comment' };

/**
 * Remove a comment. Refuses 'last-comment' (a thread must keep its opening
 * statement — delete the thread instead) and signals 'not-found' for a junk id.
 */
export function deleteComment(t: ReviewThread, commentIdToDelete: string): DeleteCommentResult {
  if (t.comments.length <= 1) return { thread: null, error: 'last-comment' };
  const next = t.comments.filter((c) => c.id !== commentIdToDelete);
  if (next.length === t.comments.length) return { thread: null, error: 'not-found' };
  return { thread: { ...t, comments: next }, error: null };
}

/** {open, resolved, total} counts over a thread list. */
export function reviewCounts(threads: ReviewThread[]): { open: number; resolved: number; total: number } {
  const list = Array.isArray(threads) ? threads : [];
  const open = list.filter((t) => t.status === 'open').length;
  return { open, resolved: list.length - open, total: list.length };
}

/**
 * Lightweight per-thread summary: comment count plus the latest activity
 * timestamp (newest of thread/comments/resolution) — the sorting key for the
 * "by latest activity" list ordering.
 */
export function threadSummary(t: ReviewThread): { commentCount: number; lastActivityAt: string } {
  const candidates = [t.createdAt, ...t.comments.map((c) => c.createdAt), ...(t.resolvedAt ? [t.resolvedAt] : [])].filter(
    (v): v is string => !Number.isNaN(Date.parse(v)),
  );
  const last = candidates.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a), candidates[0] ?? new Date().toISOString());
  return { commentCount: t.comments.length, lastActivityAt: last };
}