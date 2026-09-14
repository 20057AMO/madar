import { useState, useEffect, useMemo, useRef } from 'preact/hooks';
import { MessageSquare, Plus, Check, RotateCcw, Trash2, TriangleAlert, ChevronRight, ChevronDown, Send, Loader2 } from 'lucide-preact';
import {
  getProjectReviews,
  createReviewThread,
  addReviewComment,
  setReviewStatus,
  deleteReviewThread,
  deleteReviewComment,
  avatarUrl,
  type ReviewThread,
  type ReviewComment,
  type ReviewStatus,
} from '../api';
import type { Project } from '../api';
import { relTime } from '../lib/time';
import { Avatar } from './Avatar';
import { ConfirmModal } from './ConfirmModal';
import { useAuth } from '../auth';

type Filter = 'all' | ReviewStatus;

type DeleteTarget =
  | { kind: 'thread'; id: string; path: string; by: string }
  | { kind: 'comment'; threadId: string; commentId: string; by: string };

/** Latest activity of a thread = newest of its creation, comments, and resolve time. */
function lastActivity(t: ReviewThread): string {
  let best = t.createdAt;
  for (const c of t.comments || []) {
    if (c.createdAt > best) best = c.createdAt;
  }
  if (t.resolvedAt && t.resolvedAt > best) best = t.resolvedAt;
  return best;
}

/**
 * File reviews — per-file code-review threads with a comment chain.
 * Read-only for viewers; editors open threads, reply, resolve/reopen and delete
 * (their own comments, and threads they authored or admin-level members own).
 * No WebSocket — every mutation refetches the whole list, chained on a promise
 * queue so rapid successive actions can never lose an update (NotesPanel pattern).
 */
export function ReviewsPanel({
  slug,
  readOnly,
  initialPath = '',
  project,
  pathInputRef,
}: {
  slug: string;
  readOnly?: boolean;
  initialPath?: string;
  project?: Project | null;
  pathInputRef?: { current: HTMLInputElement | null };
}) {
  const { user } = useAuth();
  const [threads, setThreads] = useState<ReviewThread[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  // Composer (editor only)
  const [pathDraft, setPathDraft] = useState(initialPath);
  const [textDraft, setTextDraft] = useState('');
  const [creating, setCreating] = useState(false);

  // Expansion + per-thread actions
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [sendingReply, setSendingReply] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<DeleteTarget | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Source of truth for rapid successive mutations: every mutation reads the
  // latest list only via the ref and enqueues its refetch on the chain, so a
  // last-arriving response can never clobber a newer state (P0-2).
  const threadsRef = useRef<ReviewThread[]>([]);
  const chainRef = useRef<Promise<unknown>>(Promise.resolve());
  // Last deletion target — focus is restored to a surviving thread head after
  // the modal closes and the removed trigger is gone (WCAG 2.4.3).
  const deletedRef = useRef<DeleteTarget | null>(null);

  useEffect(() => {
    setLoading(true);
    setError('');
    getProjectReviews(slug)
      .then((r) => {
        threadsRef.current = r.threads || [];
        setThreads(threadsRef.current);
      })
      .catch((e: any) => setError(e.message))
      .finally(() => setLoading(false));
  }, [slug]);

  const refresh = async () => {
    try {
      const r = await getProjectReviews(slug);
      threadsRef.current = r.threads || [];
      setThreads(threadsRef.current);
      setError('');
    } catch (e: any) {
      setError(e.message);
    }
  };

  /** Enqueue one mutation + refetch; resolves with the mutation's payload. */
  const mutate = <T,>(op: () => Promise<T>): Promise<T | undefined> => {
    let result: T | undefined;
    const run = chainRef.current
      .catch(() => {})
      .then(async () => {
        try {
          result = await op();
          await refresh();
        } catch (e: any) {
          setError(e.message);
        }
      });
    chainRef.current = run;
    return run.then(() => result);
  };

  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submitThread = () => {
    const path = pathDraft.trim();
    const text = textDraft.trim();
    if (!path || !text || creating || readOnly) return;
    setCreating(true);
    mutate(async () => {
      const r = await createReviewThread(slug, { path, text });
      setPathDraft('');
      setTextDraft('');
      return r;
    })
      .then((r) => {
        if (r?.thread) setExpanded((prev) => new Set(prev).add(r.thread.id));
      })
      .finally(() => setCreating(false));
  };

  const setReplyDraft = (threadId: string, text: string) =>
    setReplyDrafts((d) => ({ ...d, [threadId]: text }));

  const sendReply = (threadId: string) => {
    const text = (replyDrafts[threadId] || '').trim();
    if (!text || sendingReply || readOnly) return;
    setSendingReply(threadId);
    mutate(async () => {
      await addReviewComment(slug, threadId, text);
      setReplyDraft(threadId, '');
    }).finally(() => setSendingReply(null));
  };

  const toggleStatus = (t: ReviewThread) => {
    if (toggling || readOnly) return;
    const next: ReviewStatus = t.status === 'open' ? 'resolved' : 'open';
    setToggling(t.id);
    mutate(async () => {
      await setReviewStatus(slug, t.id, next);
    }).finally(() => setToggling(null));
  };

  const runDelete = async () => {
    const t = confirmDelete;
    if (!t) return;
    setDeleting(true);
    await mutate(async () => {
      if (t.kind === 'thread') await deleteReviewThread(slug, t.id);
      else await deleteReviewComment(slug, t.threadId, t.commentId);
    });
    setDeleting(false);
    deletedRef.current = t;
    setConfirmDelete(null);
  };

  // ConfirmModal restores focus to its opening trigger, but a thread/comment
  // delete removes that trigger before the modal closes — re-home focus on a
  // surviving thread head (same thread for a comment delete, else the first)
  // or the panel title once the refetched list has committed (WCAG 2.4.3).
  useEffect(() => {
    const t = deletedRef.current;
    if (!t) return;
    deletedRef.current = null;
    const heads = Array.from(document.querySelectorAll<HTMLElement>('[data-review-head]'));
    let target: HTMLElement | undefined;
    if (t.kind === 'thread') {
      const idx = heads.findIndex((h) => h.dataset.threadId === t.id);
      target = heads[idx + 1] || heads[idx - 1] || heads[0];
    } else {
      target = heads.find((h) => h.dataset.threadId === t.threadId);
    }
    if (target) target.focus();
    else document.querySelector<HTMLElement>('.reviews-title')?.focus();
  }, [confirmDelete]);

  // Delete visibility mirrors the API contract: thread deletion for the
  // author or an admin-level member/owner; comment deletion for its author
  // or an admin. System admins always pass.
  const isAdminUser = !!user && (() => {
    if (user.role === 'admin') return true;
    if (project?.ownerId === user.id) return true;
    return !!project?.members?.some((m) => m.userId === user.id && m.role === 'admin');
  })();
  const canDeleteThread = (t: ReviewThread) => !readOnly && (t.createdBy === user?.id || isAdminUser);
  const canDeleteComment = (c: ReviewComment) => !readOnly && (c.userId === user?.id || isAdminUser);

  const sorted = useMemo(() => [...threads].sort((a, b) => (lastActivity(b) < lastActivity(a) ? -1 : 1)), [threads]);
  const visible = useMemo(
    () => (filter === 'all' ? sorted : sorted.filter((t) => t.status === filter)),
    [sorted, filter],
  );
  const openCount = threads.filter((t) => t.status === 'open').length;
  const resolvedCount = threads.length - openCount;

  const counterChip = (label: string, value: number, color: string) => (
    <span
      style={`font-size:0.62rem;font-weight:600;border-radius:999px;padding:2px 8px;color:${color};background:color-mix(in srgb, ${color} 12%, transparent)`}
    >
      {value} {label}
    </span>
  );

  const badgeStyle = (isOpen: boolean) =>
    isOpen
      ? 'color:var(--blue);background:color-mix(in srgb, var(--blue) 12%, transparent)'
      : 'color:var(--green);background:color-mix(in srgb, var(--green) 12%, transparent)';

  const absTime = (iso: string) => new Date(iso).toLocaleString();

  return (
    <div style="max-width:760px;margin:0 auto;padding:14px 16px;display:flex;flex-direction:column;gap:12px">
      {/* Header + counters */}
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <h2 class="panel-title reviews-title" style="margin-bottom:0" tabIndex={-1}>Reviews</h2>
        <span style="flex:1" />
        {!loading && threads.length > 0 && (
          <span role="status" aria-label="Review summary" style="display:inline-flex;align-items:center;gap:6px">
            {counterChip('open', openCount, 'var(--blue)')}
            {counterChip('resolved', resolvedCount, 'var(--green)')}
            {counterChip('total', threads.length, 'var(--text-2)')}
          </span>
        )}
      </div>

      {readOnly ? (
        <div class="panel-muted" role="status">
          You have viewer access — reviews are read-only. Owners and editors can comment and resolve.
        </div>
      ) : (
        /* Composer */
        <div style="display:flex;flex-direction:column;gap:8px;background:rgba(255,255,255,.03);border:1px solid var(--border,#333);border-radius:12px;padding:10px">
          <input
            ref={pathInputRef}
            class="modern-input mono"
            style="width:100%;box-sizing:border-box"
            placeholder="File path, e.g. src/app.ts"
            aria-label="Review file path"
            name="review-path"
            value={pathDraft}
            onInput={(e: any) => setPathDraft(e.target.value)}
          />
          <textarea
            class="modern-input"
            style="width:100%;min-height:56px;resize:vertical;font-size:0.82rem;line-height:1.5;box-sizing:border-box"
            aria-label="Review note"
            name="review-note"
            placeholder="What should change in this file? Be specific — line numbers help."
            value={textDraft}
            onInput={(e: any) => setTextDraft(e.target.value)}
            onKeyDown={(e: KeyboardEvent) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') submitThread();
            }}
          />
          <div style="display:flex;align-items:center;gap:6px">
            <span style="font-size:0.66rem;color:var(--text-3)">Ctrl+Enter to add</span>
            <span style="flex:1" />
            <button
              class="btn-primary sm"
              onClick={submitThread}
              disabled={!pathDraft.trim() || !textDraft.trim() || creating}
              title="Add review thread"
              aria-label="Add review thread"
            >
              {creating ? (
                <Loader2 width={13} height={13} class="icon spin" />
              ) : (
                <Plus width={13} height={13} class="icon" />
              )}{' '}
              Add review thread
            </button>
          </div>
          {error && (
            <div style="font-size:0.72rem;color:#fecaca;background:#7f1d1d;border-radius:8px;padding:6px 10px" role="alert">
              {error}
            </div>
          )}
        </div>
      )}

      {/* Filters */}
      {!loading && threads.length > 0 && (
        <div role="group" aria-label="Filter reviews" style="display:flex;align-items:center;gap:6px;font-size:0.75rem;color:var(--text-3)">
          {(['all', 'open', 'resolved'] as Filter[]).map((f) => (
            <button
              key={f}
              class={`btn-ghost sm${filter === f ? ' active' : ''}`}
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
            >
              {f === 'all' ? `All (${threads.length})` : f === 'open' ? `Open (${openCount})` : `Resolved (${resolvedCount})`}
            </button>
          ))}
        </div>
      )}

      {/* List */}
      <div aria-busy={loading || undefined} aria-label="Review list" style="display:flex;flex-direction:column;gap:12px">
        {loading ? (
          <div role="status" aria-label="Loading reviews" style="display:flex;flex-direction:column;gap:10px">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} style="background:rgba(255,255,255,.03);border:1px solid var(--border,#333);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:10px">
                <div style="display:flex;align-items:center;gap:10px">
                  <div class="skel-line w60" style="margin-bottom:0;width:60%!important" />
                  <div class="skel-chip" style="margin-left:auto" />
                </div>
                <div style="display:flex;align-items:center;gap:10px">
                  <div style="width:18px;height:18px;border-radius:50%;flex-shrink:0;background:linear-gradient(90deg,var(--border) 25%,var(--border-2) 50%,var(--border) 75%);background-size:200% 100%;animation:skel-shimmer 1.4s ease infinite" />
                  <div class="skel-line w40" style="margin-bottom:0;width:40%!important" />
                </div>
              </div>
            ))}
          </div>
        ) : visible.length === 0 ? (
          <div class="empty-state" style="text-align:center;padding:28px 0" role="status">
            <div class="big-icon"><MessageSquare width={30} height={30} class="icon" /></div>
            <p style="color:var(--text-3);font-size:0.78rem;margin:8px 0 0">
              {threads.length === 0
                ? 'No reviews yet — start one from the Files tab.'
                : filter === 'open'
                  ? 'No open reviews right now — everything is resolved.'
                  : 'No resolved reviews yet.'}
            </p>
          </div>
        ) : (
          <ul style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:12px">
            {visible.map((t) => {
              const isOpen = t.status === 'open';
              const open = expanded.has(t.id);
              const name = t.actorDisplayName || t.createdByName;
              return (
                <li key={t.id}>
                  <div style="background:rgba(255,255,255,.03);border:1px solid var(--border,#333);border-radius:12px;overflow:hidden">
                    <button
                      data-review-head="true"
                      data-thread-id={t.id}
                      aria-expanded={open}
                      aria-controls={`review-${t.id}`}
                      onClick={() => toggleExpand(t.id)}
                      title={open ? 'Collapse review' : 'Expand review'}
                      style="display:flex;flex-direction:column;gap:8px;width:100%;text-align:left;padding:10px 12px;cursor:pointer"
                    >
                      <span style="display:flex;align-items:center;gap:8px;min-width:0">
                        {open ? (
                          <ChevronDown width={14} height={14} class="icon" style="flex:none;color:var(--text-3)" />
                        ) : (
                          <ChevronRight width={14} height={14} class="icon" style="flex:none;color:var(--text-3)" />
                        )}
                        <span
                          class="mono"
                          style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:0.78rem"
                          title={t.path}
                        >
                          {t.path}
                        </span>
                        {!t.fileExists && (
                          <span
                            style="display:inline-flex;align-items:center;gap:4px;flex:none;font-size:0.62rem;color:var(--yellow);background:color-mix(in srgb, var(--yellow) 12%, transparent);border-radius:999px;padding:2px 8px"
                            title="This file does not exist in the workspace anymore"
                          >
                            <TriangleAlert width={10} height={10} /> file not found
                          </span>
                        )}
                        <span style={`flex:none;font-size:0.62rem;font-weight:600;border-radius:999px;padding:2px 8px;${badgeStyle(isOpen)}`}>
                          {isOpen ? 'open' : 'resolved'}
                        </span>
                      </span>
                      <span style="display:flex;align-items:center;gap:6px;min-width:0">
                        <Avatar
                          name={name}
                          avatar={t.actorAvatarExt ? avatarUrl(t.createdBy, t.actorAvatarExt) : null}
                          size={18}
                          decorative
                        />
                        <span style="font-size:0.68rem;color:var(--text-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                          {name}
                        </span>
                        <time
                          style="font-size:0.62rem;color:var(--text-3)"
                          datetime={t.createdAt}
                          title={absTime(t.createdAt)}
                          aria-label={absTime(t.createdAt)}
                        >
                          · {relTime(t.createdAt)}
                        </time>
                        <span style="flex:1" />
                        <span style="font-size:0.62rem;color:var(--text-3)">
                          {t.comments.length} {t.comments.length === 1 ? 'comment' : 'comments'}
                        </span>
                      </span>
                    </button>

                    {open && (
                      <div
                        id={`review-${t.id}`}
                        style="border-top:1px solid var(--border,#333);padding:10px 12px;display:flex;flex-direction:column;gap:10px"
                      >
                        {t.comments.length === 0 ? (
                          <p style="font-size:0.72rem;color:var(--text-3)">No comments yet — start the discussion below.</p>
                        ) : (
                          t.comments.map((c) => {
                            const cName = c.actorDisplayName || c.username;
                            return (
                              <div key={c.id} style="display:flex;gap:8px;align-items:flex-start">
                                <Avatar
                                  name={cName}
                                  avatar={c.actorAvatarExt ? avatarUrl(c.userId, c.actorAvatarExt) : null}
                                  size={22}
                                  decorative
                                />
                                <div style="flex:1;min-width:0">
                                  <div style="display:flex;align-items:baseline;gap:6px">
                                    <span style="font-size:0.7rem;font-weight:600">{cName}</span>
                                    <time
                                      style="font-size:0.6rem;color:var(--text-3)"
                                      datetime={c.createdAt}
                                      title={absTime(c.createdAt)}
                                      aria-label={absTime(c.createdAt)}
                                    >
                                      {relTime(c.createdAt)}
                                    </time>
                                  </div>
                                  <div style="font-size:0.76rem;line-height:1.5;white-space:pre-wrap;word-break:break-word;margin-top:2px">
                                    {c.text}
                                  </div>
                                </div>
                                {canDeleteComment(c) && (
                                  <button
                                    class="btn-ghost sm icon-only"
                                    title="Delete comment"
                                    aria-label={`Delete comment by ${cName}`}
                                    onClick={() => setConfirmDelete({ kind: 'comment', threadId: t.id, commentId: c.id, by: cName })}
                                    style="flex:none;padding:4px;opacity:.55"
                                  >
                                    <Trash2 width={13} height={13} class="icon" />
                                  </button>
                                )}
                              </div>
                            );
                          })
                        )}

                        {!readOnly && (
                          <div style="display:flex;gap:8px;align-items:flex-end">
                            <textarea
                              class="modern-input"
                              style="flex:1;min-width:0;min-height:38px;max-height:120px;resize:vertical;font-size:0.76rem;line-height:1.45;box-sizing:border-box"
                              aria-label={`Reply to review on ${t.path}`}
                              name="review-reply"
                              placeholder="Reply…"
                              value={replyDrafts[t.id] || ''}
                              onInput={(e: any) => setReplyDraft(t.id, e.target.value)}
                              onKeyDown={(e: KeyboardEvent) => {
                                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') sendReply(t.id);
                              }}
                            />
                            <button
                              class="btn-primary sm"
                              onClick={() => sendReply(t.id)}
                              disabled={sendingReply === t.id || !(replyDrafts[t.id] || '').trim()}
                              aria-label="Send reply"
                            >
                              {sendingReply === t.id ? (
                                <Loader2 width={12} height={12} class="icon spin" />
                              ) : (
                                <Send width={12} height={12} class="icon" />
                              )}{' '}
                              Reply
                            </button>
                          </div>
                        )}

                        {!readOnly && (
                          <div style="display:flex;align-items:center;gap:6px;padding-top:4px;border-top:1px solid var(--border,#333)">
                            <button
                              class={isOpen ? 'btn-primary sm' : 'btn-ghost sm'}
                              onClick={() => toggleStatus(t)}
                              disabled={toggling === t.id}
                              title={isOpen ? 'Mark this review as resolved' : 'Reopen this review'}
                              aria-label={isOpen ? 'Resolve review' : 'Reopen review'}
                            >
                              {toggling === t.id ? (
                                <Loader2 width={12} height={12} class="icon spin" />
                              ) : isOpen ? (
                                <Check width={12} height={12} class="icon" />
                              ) : (
                                <RotateCcw width={12} height={12} class="icon" />
                              )}{' '}
                              {isOpen ? 'Resolve' : 'Reopen'}
                            </button>
                            {canDeleteThread(t) && (
                              <button
                                class="btn-danger sm"
                                onClick={() => setConfirmDelete({ kind: 'thread', id: t.id, path: t.path, by: name })}
                                title="Delete this thread"
                                aria-label="Delete thread"
                              >
                                <Trash2 width={12} height={12} class="icon" /> Delete thread
                              </button>
                            )}
                            <span style="flex:1" />
                            {!isOpen && t.resolvedBy && (
                              <span style="font-size:0.62rem;color:var(--text-3)">
                                resolved {relTime(t.resolvedAt)} by {t.resolvedByName || (t.resolvedBy === user?.id ? 'you' : t.resolvedBy)}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {error && readOnly && !loading && (
        <div class="login-error" role="alert" style="margin:0">
          {error}
        </div>
      )}

      <ConfirmModal
        open={!!confirmDelete}
        danger
        title={confirmDelete?.kind === 'thread' ? 'Delete this thread?' : 'Delete this comment?'}
        message={
          confirmDelete?.kind === 'thread'
            ? `Review on ${confirmDelete.path} by ${confirmDelete.by} and all its comments are removed permanently.`
            : `Comment by ${confirmDelete?.by} is removed from the review thread permanently.`
        }
        confirmLabel="Delete"
        loading={deleting}
        onConfirm={runDelete}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}