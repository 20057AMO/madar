import { useState, useEffect, useCallback } from 'preact/hooks';
import { History, RefreshCw, Loader2, Inbox, Bot } from 'lucide-preact';
import { getProjectActivity, avatarUrl, type ProjectActivityEntry } from '../api';
import { relTime } from '../lib/time';
import { activityMeta, setActivityTranslator } from '../lib/activity-meta';
import { useI18n } from '../i18n';
import { Avatar } from './Avatar';

const PAGE = 50;

function mergeUnique(prev: ProjectActivityEntry[], page: ProjectActivityEntry[]): ProjectActivityEntry[] {
  const seen = new Set(prev.map((e) => e.id));
  return [...prev, ...page.filter((e) => !seen.has(e.id))];
}

/** One feed row: colored icon + label + actor badge + relative time + detail line. */
function ActivityRow({ e }: { e: ProjectActivityEntry }) {
  const { t } = useI18n();
  const meta = activityMeta(e.action);
  const Ic = meta.Icon;
  const actor = e.actorDisplayName || e.actorName;
  const abs = new Date(e.at).toLocaleString();
  const detail = e.details ? meta.fmtDetail(e.details) : '';
  return (
    <li class="activity-row">
      <span class={`activity-ico ${meta.dotClass}`} aria-hidden="true">
        <Ic width={15} height={15} />
      </span>
      <div class="activity-main">
        <div class="activity-line">
          <span class="activity-act">{meta.labelKey ? t(meta.labelKey) : e.action}</span>
          {actor ? (
            <span class="activity-actor" title={actor}>
              <Avatar
                name={actor}
                avatar={e.userId && e.actorAvatarExt ? avatarUrl(e.userId, e.actorAvatarExt) : null}
                size={18}
                decorative
              />
              <span class="activity-actor-name">{actor}</span>
            </span>
          ) : (
            <span class="activity-actor system" title={t('act.automated')}>
              <Bot width={12} height={12} class="icon" />
              <span>{t('act.system')}</span>
            </span>
          )}
          <time class="activity-at" datetime={e.at} title={abs} aria-label={abs}>{relTime(e.at)}</time>
        </div>
        {detail && <div class="activity-detail mono">{detail}</div>}
      </div>
    </li>
  );
}

/**
 * Project activity feed — newest first with pagination.
 * Fetches on tab open and via the Refresh button; no live streaming.
 */
export function ActivityPanel({ slug, readOnly }: { slug: string; readOnly?: boolean }) {
  void readOnly; // the feed is read-only for every role by design
  const { t } = useI18n();
  // activity-meta is a plain lib module — inject the live translator so its
  // labels follow the current language (re-bound on every language change).
  setActivityTranslator(t);
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

  const refresh = () => {
    if (loading) return;
    fetchPage(0, true);
  };
  const loadMore = () => {
    if (loadingMore || offset >= total) return;
    fetchPage(offset, false);
  };

  return (
    <div style="max-width:760px;margin:0 auto;padding:14px 16px;display:flex;flex-direction:column;gap:12px">
      <div class="activity-head">
        <h2 class="panel-title" style="display:flex;align-items:center;gap:6px;margin:0">
          <History width={13} height={13} class="icon" /> {t('misc.activityTitle')}
          <span style="flex:1" />
          {total > 0 && !loading && !loadingMore && (
            <span class="activity-count" role="status">{t('act.events', { n: total })}</span>
          )}
          <button class="btn-ghost sm" onClick={refresh} aria-disabled={loading} title={t('act.refreshTitle')} aria-label={t('act.refreshTitle')}>
            <RefreshCw width={13} height={13} class={`icon${loading ? ' spin' : ''}`} /> {t('act.refresh')}
          </button>
        </h2>
      </div>

      {error && (
        <div class="login-error" role="alert" style="margin:0">
          {error}
          <button class="btn-ghost sm" style="margin-left:8px" onClick={refresh}>{t('act.retry')}</button>
        </div>
      )}

      {loading ? (
        <ul class="activity-list activity-load" role="status" aria-busy="true" aria-label={t('act.loadingActivity')}>
          {Array.from({ length: 6 }).map((_, i) => (
            <li class="activity-row" key={i}>
              <span class="activity-ico-skel" />
              <span style="flex:1;min-width:0">
                <div class="skel-line w60" style="margin-bottom:6px" />
                <div class="skel-line w40" style="margin-bottom:0" />
              </span>
            </li>
          ))}
        </ul>
      ) : entries.length === 0 ? (
        <div class="empty-state" style="text-align:center;padding:28px 0" role="status">
          <div class="big-icon"><Inbox width={30} height={30} class="icon" /></div>
          <p style="color:var(--text-3);font-size:0.78rem;margin:8px 0 0">
            {t('act.emptyFeed')}
          </p>
        </div>
      ) : (
        <ul class="activity-list" aria-busy={loadingMore}>
          {entries.map((e) => (
            <ActivityRow key={e.id} e={e} />
          ))}
          {entries.length < total && (
            <li style="text-align:center;padding:10px 0 2px;list-style:none">
              <button class="btn-ghost sm" onClick={loadMore} aria-disabled={loadingMore} title={t('act.loadingMore')}>
                {loadingMore ? (
                  <>
                    <Loader2 width={13} height={13} class="icon spin" /> {t('act.loadingMore')}
                  </>
                ) : (
                  t('act.loadMore', { have: entries.length, total })
                )}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}