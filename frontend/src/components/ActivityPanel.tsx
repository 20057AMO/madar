import { useState, useEffect, useCallback } from 'preact/hooks';
import { History, RefreshCw, Loader2, Inbox, Bot } from 'lucide-preact';
import { getProjectActivity, avatarUrl, type ProjectActivityEntry } from '../api';
import { relTime } from '../lib/time';
import { activityMeta } from '../lib/activity-meta';
import { Avatar } from './Avatar';

const PAGE = 50;

function mergeUnique(prev: ProjectActivityEntry[], page: ProjectActivityEntry[]): ProjectActivityEntry[] {
  const seen = new Set(prev.map((e) => e.id));
  return [...prev, ...page.filter((e) => !seen.has(e.id))];
}

/** One feed row: colored icon + label + actor badge + relative time + detail line. */
function ActivityRow({ e }: { e: ProjectActivityEntry }) {
  const meta = activityMeta(e.action);
  const Ic = meta.Icon;
  const actor = e.actorDisplayName || e.actorName;
  const abs = new Date(e.at).toLocaleString();
  const detail = e.details ? meta.fmtDetail(e.details) : '';
  return (
    <div class="activity-row">
      <span class={`activity-ico ${meta.dotClass}`} aria-hidden="true">
        <Ic width={15} height={15} />
      </span>
      <div class="activity-main">
        <div class="activity-line">
          <span class="activity-act">{meta.label}</span>
          {actor ? (
            <span class="activity-actor" title={actor}>
              <Avatar
                name={actor}
                avatar={e.userId && e.actorAvatarExt ? avatarUrl(e.userId, e.actorAvatarExt) : null}
                size={18}
              />
              <span class="activity-actor-name">{actor}</span>
            </span>
          ) : (
            <span class="activity-actor system" title="Automated event">
              <Bot width={12} height={12} class="icon" />
              <span>System</span>
            </span>
          )}
          <span class="activity-at" title={`${abs}${actor ? ` — ${actor}` : ''}`}>{relTime(e.at)}</span>
        </div>
        {detail && <div class="activity-detail mono">{detail}</div>}
      </div>
    </div>
  );
}

/**
 * Project activity feed — newest first with pagination.
 * Fetches on tab open and via the Refresh button; no live streaming.
 */
export function ActivityPanel({ slug, readOnly }: { slug: string; readOnly?: boolean }) {
  void readOnly; // the feed is read-only for every role by design
  const [entries, setEntries] = useState<ProjectActivityEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPage = useCallback(
    async (start: number, replace: boolean) => {
      if (replace) setLoading(true);
      else setLoadingMore(true);
      setError(null);
      try {
        const { entries: page, total: t } = await getProjectActivity(slug, PAGE, start);
        setEntries((prev) => (replace ? page : mergeUnique(prev, page)));
        setTotal(t);
        setOffset(start + page.length);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [slug]
  );

  useEffect(() => {
    fetchPage(0, true);
  }, [fetchPage]);

  const refresh = () => fetchPage(0, true);
  const loadMore = () => {
    if (loadingMore || offset >= total) return;
    fetchPage(offset, false);
  };

  return (
    <div style="max-width:760px;margin:0 auto;padding:14px 16px;display:flex;flex-direction:column;gap:12px">
      <div class="activity-head">
        <h2 class="panel-title" style="display:flex;align-items:center;gap:6px;margin:0">
          <History width={13} height={13} class="icon" /> Activity
          <span style="flex:1" />
          {total > 0 && !loading && (
            <span class="activity-count" role="status">{total} {total === 1 ? 'event' : 'events'}</span>
          )}
          <button class="btn-ghost sm" onClick={refresh} disabled={loading} title="Refresh activity" aria-label="Refresh activity">
            <RefreshCw width={13} height={13} class={`icon${loading ? ' spin' : ''}`} /> Refresh
          </button>
        </h2>
      </div>

      {error && (
        <div class="login-error" role="alert" style="margin:0">
          {error}
          <button class="btn-ghost sm" style="margin-left:8px" onClick={refresh}>Retry</button>
        </div>
      )}

      {loading ? (
        <div class="activity-load" role="status" aria-busy="true" aria-label="Loading activity">
          {Array.from({ length: 6 }).map((_, i) => (
            <div class="activity-row" key={i}>
              <span class="activity-ico-skel" />
              <span style="flex:1;min-width:0">
                <div class="skel-line w60" style="margin-bottom:6px" />
                <div class="skel-line w40" style="margin-bottom:0" />
              </span>
            </div>
          ))}
        </div>
      ) : entries.length === 0 ? (
        <div class="empty-state" style="text-align:center;padding:28px 0" role="status">
          <div class="big-icon"><Inbox width={30} height={30} class="icon" /></div>
          <p style="color:var(--text-3);font-size:0.78rem;margin:8px 0 0">
            No activity yet — changes to this project will appear here.
          </p>
        </div>
      ) : (
        <div class="activity-list">
          {entries.map((e) => (
            <ActivityRow key={e.id} e={e} />
          ))}
          {entries.length < total && (
            <div style="text-align:center;padding:10px 0 2px">
              <button class="btn-ghost sm" onClick={loadMore} disabled={loadingMore} title="Load older activity">
                {loadingMore ? (
                  <>
                    <Loader2 width={13} height={13} class="icon spin" /> Loading…
                  </>
                ) : (
                  `Load more (${entries.length}/${total})`
                )}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}