/**
 * project-reviews.ts
 * Madar — Per-project file reviews store.
 *
 * Review threads pinned to workspace file paths live at
 * WSD_DATA_DIR/projects/<slug>/reviews.json (mode 0600), next to notes.json
 * and canvas.json — so they die with the project (deleteMeta removes the whole
 * dir) and travel with snapshots.
 *
 * The store follows the project-notes/activity pattern:
 *   - every mutation is a read-modify-write under withFileLock('reviews:<slug>')
 *   - the actor is resolved via getUserInfo (live username snapshot stored at
 *     write time — forged sessions keep their token claim)
 *   - recordActivity is called on every mutation and NEVER throws, so a feed
 *     failure can't break a review write
 *   - the read path enriches threads with live people data (actorDisplayName /
 *     avatarExt) and a workspace fileExists probe (listActivity pattern plus
 *     the canvas mirror's statSync approach)
 *
 * ⚠️ SYNC-CONCURRENCY CONTRACT — do not break this:
 * withFileLock is a per-slug async queue, but this store's mutations are ALL
 * fully synchronous: each read-modify-write runs end-to-end with ZERO `await`
 * between the read and the write (see writeReviews' tmp+rename). That is what
 * keeps the serialization atomic — `readThreads` → mutate → `writeReviews`
 * happens as one uninterrupted synchronous block. If you ever introduce an
 * `await` inside one of these mutation closures, the write is no longer atomic
 * (another concurrent mutation can interleave between the read and the write
 * and its result will be silently overwritten). Any code that NEEDS to await
 * inside a mutation must switch that closure to withFileLockAsync instead.
 */
import fs from 'fs';
import path from 'path';

import { withFileLock } from './write-queue';
import { getUserInfo, listUsers } from './user-store';
import { recordActivity } from './project-activity';
import {
  MAX_REVIEW_PATH,
  MAX_REVIEW_TEXT,
  MAX_THREADS,
  MAX_COMMENTS,
  CONTROL_RE,
  normalizeReviewPath,
  validateThreads,
  resolveThread,
  reopenThread,
  addComment as coreAddComment,
  deleteComment as coreDeleteComment,
  reviewCounts,
  threadSummary,
  reviewId,
  commentId,
  type ReviewThread,
  type ReviewComment,
} from './reviews-core';

const DATA_DIR = process.env.WSD_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const PROJECTS_DIR = path.join(DATA_DIR, 'projects');
const WORKSPACES_ROOT = process.env.WSD_PROJECTS_DIR || '/workspaces';

export { MAX_REVIEW_PATH, MAX_REVIEW_TEXT, MAX_THREADS, MAX_COMMENTS, reviewCounts };
export type { ReviewThread, ReviewComment };

/** Local HTTP-shaped error so routes can map 400/403/404 directly. */
export class ReviewsError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'ReviewsError';
    this.statusCode = statusCode;
  }
}

function cleanSlug(slug: unknown): string {
  const clean = String(slug ?? '').replace(/[^a-z0-9._-]+/gi, '').slice(0, 64);
  if (!clean || clean === '.' || clean === '..') throw new ReviewsError(400, 'Invalid project slug');
  return clean;
}

function reviewsFile(clean: string): string {
  return path.join(PROJECTS_DIR, clean, 'reviews.json');
}

/** Live username for a user id — falls back to the token claim for forged sessions. */
function actorNameFor(user: { id: string; username: string }): string {
  return getUserInfo(user.id)?.username || user.username || 'Unknown';
}

function readThreads(clean: string): ReviewThread[] {
  const file = reviewsFile(clean);
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return validateThreads(Array.isArray(parsed) ? parsed : []);
  } catch {
    return [];
  }
}

function writeReviews(clean: string, threads: ReviewThread[]): void {
  fs.mkdirSync(path.dirname(reviewsFile(clean)), { recursive: true });
  // Atomic: tmp + rename in the same dir — a concurrent reader can never
  // observe a truncated/partial reviews.json (SYNC-CONCURRENCY CONTRACT).
  const final = reviewsFile(clean);
  const tmp = `${final}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(threads, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, final);
}

/** Raw, sanitized threads in file order. Missing/corrupt stores → empty. */
export function loadReviews(slug: string): ReviewThread[] {
  return readThreads(cleanSlug(slug));
}

/** Full-document restore (snapshot import): normalize + persist best-effort. */
export function saveReviews(slug: string, input: unknown): ReviewThread[] {
  const clean = cleanSlug(slug);
  return withFileLock(`reviews:${clean}`, () => {
    const threads = validateThreads(input);
    writeReviews(clean, threads);
    return threads;
  });
}

/** Single-thread lookup for the delete routes' ownership gate. */
export function getThread(slug: string, threadId: string): ReviewThread | null {
  try {
    return readThreads(cleanSlug(slug)).find((t) => t.id === threadId) || null;
  } catch {
    return null;
  }
}

/** Strict API-side text validation: required after trim, explicit 400 over the cap. */
function assertCommentText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const text = raw.trim();
  if (!text) return '';
    if (CONTROL_RE.test(text)) {
    throw new ReviewsError(400, 'Comment cannot contain control characters');
  }
if (text.length > MAX_REVIEW_TEXT) {
    throw new ReviewsError(400, `Comment text exceeds ${MAX_REVIEW_TEXT} characters`);
  }
  return text;
}

/** Create a new review thread (opening statement = comments[0]). */
export function createThread(
  slug: string,
  input: { path?: unknown; text?: unknown },
  user: { id: string; username: string },
): ReviewThread {
  const clean = cleanSlug(slug);
  return withFileLock(`reviews:${clean}`, () => {
    const pathNorm = normalizeReviewPath(input?.path);
    if (pathNorm === null) throw new ReviewsError(400, 'Invalid review path');
    if (!pathNorm) throw new ReviewsError(400, 'Review path is required');
    const text = assertCommentText(input?.text);
    if (!text) throw new ReviewsError(400, 'Comment text is required');
    const threads = readThreads(clean);
    if (threads.length >= MAX_THREADS) {
      throw new ReviewsError(400, `Too many review threads (max ${MAX_THREADS})`);
    }
    const now = new Date().toISOString();
    const username = actorNameFor(user);
    const thread: ReviewThread = {
      id: reviewId(),
      path: pathNorm,
      status: 'open',
      createdAt: now,
      createdBy: user.id,
      createdByName: username,
      comments: [{ id: commentId(), text, userId: user.id, username, createdAt: now }],
    };
    writeReviews(clean, [...threads, thread]);
    recordActivity(clean, 'review_opened', { userId: user.id, details: { path: pathNorm } });
    return thread;
  });
}

/** Append one reply to a thread (MAX_COMMENTS ceiling enforced). */
export function addComment(
  slug: string,
  threadId: string,
  input: { text?: unknown },
  user: { id: string; username: string },
): ReviewThread {
  const clean = cleanSlug(slug);
  return withFileLock(`reviews:${clean}`, () => {
    const text = assertCommentText(input?.text);
    if (!text) throw new ReviewsError(400, 'Comment text is required');
    const threads = readThreads(clean);
    const idx = threads.findIndex((t) => t.id === threadId);
    if (idx < 0) throw new ReviewsError(404, 'Review thread not found');
    const thread = threads[idx];
    if (thread.comments.length >= MAX_COMMENTS) {
      throw new ReviewsError(400, `Too many comments per thread (max ${MAX_COMMENTS})`);
    }
    const now = new Date().toISOString();
    const next = coreAddComment(thread, {
      id: commentId(),
      text,
      userId: user.id,
      username: actorNameFor(user),
      createdAt: now,
    });
    const nextThreads = [...threads];
    nextThreads[idx] = next;
    writeReviews(clean, nextThreads);
    recordActivity(clean, 'review_commented', { userId: user.id, details: { path: thread.path } });
    return next;
  });
}

/**
 * resolve/reopen a thread. Only the open → resolved → open path is allowed;
 * an already-resolved PATCH 'resolved' (or already-open 'open') is a no-op
 * that still returns the current thread.
 */
export function setThreadStatus(
  slug: string,
  threadId: string,
  status: unknown,
  user: { id: string; username: string },
): ReviewThread {
  const clean = cleanSlug(slug);
  return withFileLock(`reviews:${clean}`, () => {
    if (status !== 'open' && status !== 'resolved') {
      throw new ReviewsError(400, "Status must be 'open' or 'resolved'");
    }
    const threads = readThreads(clean);
    const idx = threads.findIndex((t) => t.id === threadId);
    if (idx < 0) throw new ReviewsError(404, 'Review thread not found');
    const thread = threads[idx];
    let next = thread;
    if (status === 'resolved' && thread.status === 'open') {
      next = resolveThread(thread, user.id, actorNameFor(user));
      recordActivity(clean, 'review_resolved', { userId: user.id, details: { path: thread.path } });
      const nextThreads = [...threads];
      nextThreads[idx] = next;
      writeReviews(clean, nextThreads);
    } else if (status === 'open' && thread.status === 'resolved') {
      next = reopenThread(thread);
      recordActivity(clean, 'review_reopened', { userId: user.id, details: { path: thread.path } });
      const nextThreads = [...threads];
      nextThreads[idx] = next;
      writeReviews(clean, nextThreads);
    }
    return next;
  });
}

/** Delete one comment (never the last one — delete the thread instead). */
export function deleteComment(
  slug: string,
  threadId: string,
  commentToDelete: string,
  user: { id: string; username: string },
): ReviewThread {
  const clean = cleanSlug(slug);
  return withFileLock(`reviews:${clean}`, () => {
    const threads = readThreads(clean);
    const idx = threads.findIndex((t) => t.id === threadId);
    if (idx < 0) throw new ReviewsError(404, 'Review thread not found');
    const thread = threads[idx];
    const res = coreDeleteComment(thread, commentToDelete);
    if (!res.thread) {
      if (res.error === 'not-found') throw new ReviewsError(404, 'Comment not found');
      throw new ReviewsError(400, 'A review thread must keep at least one comment — delete the thread instead');
    }
    const nextThreads = [...threads];
    nextThreads[idx] = res.thread;
    writeReviews(clean, nextThreads);
    recordActivity(clean, 'review_deleted', { userId: user.id, details: { path: thread.path } });
    return res.thread;
  });
}

/** Delete a whole thread (permission gated by the route via canDeleteReview). */
export function deleteThread(slug: string, threadId: string, user: { id: string; username: string }): void {
  const clean = cleanSlug(slug);
  withFileLock(`reviews:${clean}`, () => {
    const threads = readThreads(clean);
    const idx = threads.findIndex((t) => t.id === threadId);
    if (idx < 0) throw new ReviewsError(404, 'Review thread not found');
    const [removed] = threads.splice(idx, 1);
    writeReviews(clean, threads);
    recordActivity(clean, 'review_deleted', { userId: user.id, details: { path: removed.path } });
  });
}

/**
 * Deletion rule shared by the thread + comment delete routes. Mirrors the
 * ownership-transfer gate (owner / system admin / explicit admin member may
 * delete anything) rather than checkProjectAccess('admin'), whose global-editor
 * short-circuit returns false for system-editor users WITHOUT consulting their
 * project membership. A global editor without a project-admin membership is
 * therefore NOT a project admin and may only delete their own rows.
 *
 * The meta store is read directly via fs (project-activity pattern) so this
 * service stays import-free of projects-meta (which pulls docker-manager in).
 */
export function canDeleteReview(user: { id: string; role: string }, actorUserId: string, slug: string): boolean {
  if (user.role === 'admin') return true;
  try {
    const file = path.join(PROJECTS_DIR, cleanSlug(slug), 'meta.json');
    if (fs.existsSync(file)) {
      const meta = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        ownerId?: string;
        members?: { userId: string; role: string }[];
      };
      if (meta.ownerId === user.id) return true;
      if (Array.isArray(meta.members) && meta.members.some((m) => m.userId === user.id && m.role === 'admin')) {
        return true;
      }
    }
  } catch {
    /* unreadable meta → fall through to the author check */
  }
  return Boolean(actorUserId) && user.id === actorUserId;
}

// ── Read path (enriched) ──────────────────────────────────────────────────

export interface EnrichedReviewComment extends ReviewComment {
  actorDisplayName?: string;
  actorAvatarExt?: string;
}

export interface EnrichedReviewThread extends ReviewThread {
  /** True when the pinned path resolves to a real file in the workspace. */
  fileExists: boolean;
  actorDisplayName?: string;
  actorAvatarExt?: string;
  summary: { commentCount: number; lastActivityAt: string };
  comments: EnrichedReviewComment[];
}

function workspaceFileExists(clean: string, relPath: string): boolean {
  try {
    const base = path.resolve(WORKSPACES_ROOT, clean);
    const target = path.resolve(base, relPath);
    if (target !== base && !target.startsWith(base + path.sep)) return false;
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/**
 * Full listing: enriched threads sorted newest-activity-first + honest counts.
 * Missing/corrupt stores → empty. Enrichment always succeeds (listUsers may be
 * empty) — the read path must never throw.
 */
export function listReviews(
  slug: string,
): { threads: EnrichedReviewThread[]; counts: { open: number; resolved: number; total: number } } {
  const clean = cleanSlug(slug);
  const threads = readThreads(clean);
  const users = listUsers();
  const byId = new Map(users.map((u) => [u.id, u]));
  const byName = new Map(users.map((u) => [u.username, u]));
  const enrichUser = (userId: string, storedName: string) => {
    const row = (userId ? byId.get(userId) : null) || (storedName ? byName.get(storedName) : null) || null;
    return {
      username: storedName || row?.username || '(deleted user)',
      ...(row?.profile?.displayName ? { actorDisplayName: row.profile.displayName } : {}),
      ...(row?.profile?.avatarExt ? { actorAvatarExt: row.profile.avatarExt } : {}),
    };
  };
  const enriched: EnrichedReviewThread[] = threads.map((t) => {
    const creator = enrichUser(t.createdBy, t.createdByName);
    return {
      ...t,
      createdByName: creator.username,
      ...(creator.actorDisplayName ? { actorDisplayName: creator.actorDisplayName } : {}),
      ...(creator.actorAvatarExt ? { actorAvatarExt: creator.actorAvatarExt } : {}),
      comments: t.comments.map((c) => ({ ...c, ...enrichUser(c.userId, c.username) })),
      fileExists: workspaceFileExists(clean, t.path),
      summary: threadSummary(t),
    };
  });
  enriched.sort((a, b) => Date.parse(b.summary.lastActivityAt) - Date.parse(a.summary.lastActivityAt));
  return { threads: enriched, counts: reviewCounts(threads) };
}