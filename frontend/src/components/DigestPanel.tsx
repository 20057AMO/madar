import { useState, useEffect, useRef } from 'preact/hooks';
import { useHashLocation } from 'wouter/use-hash-location';
import {
  Sparkles,
  Loader2,
  CircleAlert,
  Check,
  Trash2,
  Clock,
  History,
  Ban,
  ArrowRight,
  Settings2,
} from 'lucide-preact';
import {
  getDigestConfig,
  setDigestConfig,
  listDigests,
  generateDigest,
  deleteDigest,
  type DigestEntry,
  type DigestConfig,
  type DigestStatus,
} from '../api';
import { ConfirmModal } from './ConfirmModal';
import { relTime } from '../lib/time';
import { useI18n } from '../i18n';

const POLL_MS = 1500;
const INTERVALS = [60, 360, 720, 1440, 10080] as const;

const INTERVAL_KEYS: Record<number, string> = {
  60: 'digest.interval1h',
  360: 'digest.interval6h',
  720: 'digest.interval12h',
  1440: 'digest.interval24h',
  10080: 'digest.interval7d',
};

function fmtDuration(durationMs?: number): string {
  if (durationMs == null) return '';
  const s = Math.round(durationMs / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function StatusChip({ status, label }: { status: DigestStatus; label: string }) {
  const tone =
    status === 'done'
      ? 'background:rgba(74,222,128,.13);color:#86efac'
      : status === 'failed'
        ? 'background:rgba(248,81,73,.14);color:#fca5a5'
        : 'background:rgba(255,255,255,.08);color:var(--text-2)';
  return (
    <span
      style={`display:inline-flex;align-items:center;min-height:24px;font-size:0.72rem;padding:0 8px;border-radius:999px;${tone}`}
    >
      {label}
    </span>
  );
}

/**
 * Project-intelligence digest panel. Editor+ controls the schedule and can
 * generate/delete; a viewer member gets the read-only list. The digest text is
 * model output derived from untrusted workspace content, so it is rendered as
 * PLAIN TEXT nodes here (never through innerHTML).
 */
export function DigestPanel({ slug, readOnly }: { slug: string; readOnly?: boolean }) {
  const [, setLocation] = useHashLocation();
  const { t } = useI18n();

  const [entries, setEntries] = useState<DigestEntry[]>([]);
  const [config, setConfig] = useState<DigestConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [intervalDraft, setIntervalDraft] = useState<number | null>(null);
  const [savingCfg, setSavingCfg] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState('');
  const [providerMissing, setProviderMissing] = useState(false);
  const [notice, setNotice] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<DigestEntry | null>(null);
  const [deleting, setDeleting] = useState(false);

  const pollRef = useRef<number | null>(null);
  const waitIdRef = useRef<string | null>(null);
  const slugRef = useRef(slug);
  slugRef.current = slug;

  const stopPolling = () => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const refreshList = async (): Promise<DigestEntry[]> => {
    const r = await listDigests(slugRef.current);
    const items = r.entries || [];
    setEntries(items);
    return items;
  };

  // An aria-live region only announces content that CHANGED, so two identical
  // consecutive outcomes (done → done) set the same string and Preact bails out
  // with zero DOM mutations → nothing is announced. Clear first, then set the
  // text on the next macrotask: two renders, two announcements. setTimeout, not
  // queueMicrotask (Preact batches those into one render) and not rAF (it never
  // fires in a background tab).
  const announceTimerRef = useRef<number | null>(null);
  const announce = (text: string) => {
    if (announceTimerRef.current !== null) window.clearTimeout(announceTimerRef.current);
    setAnnouncement('');
    announceTimerRef.current = window.setTimeout(() => {
      announceTimerRef.current = null;
      setAnnouncement(text);
    }, 60);
  };

  const pollTick = async () => {
    const id = waitIdRef.current;
    try {
      const items = await refreshList();
      const target = id ? items.find((e) => e.id === id) : items[0];
      if (target && target.status === 'running') return;
      stopPolling();
      waitIdRef.current = null;
      if (target?.status === 'done') announce(t('digest.announceDone'));
      else if (target?.status === 'failed') announce(t('digest.announceFailed'));
      else announce(t('digest.announceSettled'));
    } catch (e: any) {
      // Project gone / no access — stop polling. Transient noise keeps polling.
      if (e?.status === 404 || e?.status === 403 || e?.status === 401) {
        stopPolling();
        waitIdRef.current = null;
      }
    }
  };

  const startPolling = (id?: string) => {
    if (id) waitIdRef.current = id;
    if (pollRef.current !== null) clearInterval(pollRef.current);
    pollRef.current = window.setInterval(pollTick, POLL_MS);
  };

  // Boot: config + history, and resume a run still in flight server-side.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setEntries([]);
    setConfig(null);
    setIntervalDraft(null);
    setError('');
    setProviderMissing(false);
    setNotice('');
    setAnnouncement('');
    waitIdRef.current = null;
    (async () => {
      try {
        const [cfg, list] = await Promise.all([
          getDigestConfig(slug),
          listDigests(slug).catch(() => ({ entries: [], total: 0 })),
        ]);
        if (cancelled) return;
        setConfig(cfg);
        setIntervalDraft(cfg.intervalMin);
        const items = list.entries || [];
        setEntries(items);
        const first = items[0];
        if (first?.status === 'running') {
          waitIdRef.current = first.id;
          startPolling(first.id);
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message || t('errors.generic'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      if (pollRef.current !== null) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      if (announceTimerRef.current !== null) {
        window.clearTimeout(announceTimerRef.current);
        announceTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  // Transient notices auto-dismiss.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const toggleEnabled = async (enabled: boolean) => {
    if (readOnly || savingCfg) return;
    setSavingCfg(true);
    setError('');
    setProviderMissing(false);
    try {
      const cfg = await setDigestConfig(slug, { enabled });
      setConfig(cfg);
      setIntervalDraft(cfg.intervalMin);
      setNotice(enabled ? t('digest.enabledNotice') : t('digest.disabledNotice'));
    } catch (e: any) {
      setError(e?.message || t('errors.generic'));
    } finally {
      setSavingCfg(false);
    }
  };

  const saveInterval = async () => {
    if (readOnly || savingCfg || !config || intervalDraft == null) return;
    if (intervalDraft === config.intervalMin) {
      setNotice(t('digest.noChange'));
      return;
    }
    setSavingCfg(true);
    setError('');
    setProviderMissing(false);
    try {
      const cfg = await setDigestConfig(slug, { intervalMin: intervalDraft });
      setConfig(cfg);
      setIntervalDraft(cfg.intervalMin);
      setNotice(t('digest.scheduleSaved'));
    } catch (e: any) {
      setError(e?.message || t('errors.generic'));
    } finally {
      setSavingCfg(false);
    }
  };

  const generateNow = async () => {
    if (readOnly || generating) return;
    setGenerating(true);
    setError('');
    setProviderMissing(false);
    try {
      const r = await generateDigest(slug);
      waitIdRef.current = r.digest.id;
      await refreshList();
      startPolling(r.digest.id);
      announce(t('digest.announceStarted'));
    } catch (e: any) {
      if (e?.status === 503 || e?.code === 'provider_unavailable') setProviderMissing(true);
      else if (e?.status === 409) setError(t('digest.errAlreadyRunning'));
      else if (e?.status === 429) setError(t('digest.errTooMany'));
      else setError(e?.message || t('errors.generic'));
    } finally {
      setGenerating(false);
    }
  };

  const doDelete = async () => {
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      await deleteDigest(slug, confirmDelete.id);
      setEntries((list) => list.filter((e) => e.id !== confirmDelete.id));
      setConfirmDelete(null);
      setNotice(t('digest.deletedNotice'));
    } catch (e: any) {
      setError(e?.message || t('errors.generic'));
      setConfirmDelete(null);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div style="max-width:720px;margin:0 auto;padding:14px 16px;display:flex;flex-direction:column;gap:12px">
      {/* Status transitions (running→done / running→failed) are announced here. */}
      <div role="status" aria-live="polite" class="sr-only">
        {announcement}
      </div>

      <div style="display:flex;flex-direction:column;gap:2px">
        <h2 class="panel-title" style="display:flex;align-items:center;gap:6px;margin:0">
          <Sparkles width={14} height={14} class="icon" /> {t('digest.title')}
        </h2>
        <p class="settings-hint" style="margin:0">
          {t('digest.description')}
        </p>
      </div>

      {readOnly ? (
        <div class="panel-muted" role="status">
          {t('digest.viewerNote')}
        </div>
      ) : (
        <div style="background:rgba(255,255,255,.03);border:1px solid var(--border,#333);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:10px">
          <label class="agent-settings-toggle" style="cursor:pointer">
            <input
              type="checkbox"
              checked={!!config?.enabled}
              disabled={savingCfg || loading}
              onChange={(e: any) => toggleEnabled(e.target.checked)}
            />
            <span class="agent-settings-toggle-text">
              <span class="agent-settings-toggle-label">{t('digest.enable')}</span>
              <span class="agent-settings-toggle-desc">{t('digest.enableDesc')}</span>
            </span>
          </label>

          <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
            <label style="display:flex;flex-direction:column;gap:4px;font-size:0.7rem;color:var(--text-3)">
              {t('digest.interval')}
              <select
                class="modern-input"
                style="min-width:140px"
                value={intervalDraft ?? config?.intervalMin ?? 1440}
                disabled={!config?.enabled || savingCfg}
                onChange={(e: any) => setIntervalDraft(Number(e.target.value))}
              >
                {INTERVALS.map((v) => (
                  <option key={v} value={v}>
                    {t(INTERVAL_KEYS[v])}
                  </option>
                ))}
              </select>
            </label>
            {config?.lastDigestAt && (
              <span style="min-width:120px;font-size:0.7rem;color:var(--text-3);padding-bottom:4px">
                {t('digest.lastDigest', { time: new Date(config.lastDigestAt).toLocaleString() })}
              </span>
            )}
            <button
              class="btn-ghost sm"
              style="margin-inline-start:auto"
              onClick={saveInterval}
              disabled={!config?.enabled || savingCfg || intervalDraft == null || intervalDraft === config.intervalMin}
            >
              {savingCfg ? t('digest.saving') : t('digest.save')}
            </button>
          </div>

          <button
            class="btn-primary sm"
            style="align-self:flex-start"
            onClick={generateNow}
            disabled={generating}
          >
            {generating ? (
              <Loader2 width={13} height={13} class="icon spin" />
            ) : (
              <Sparkles width={13} height={13} class="icon" />
            )}
            {generating ? t('digest.generating') : t('digest.generateNow')}
          </button>
        </div>
      )}

      {providerMissing && (
        <div
          class="panel"
          role="status"
          style="margin:0;padding:14px;border-inline-start:3px solid var(--red);background:rgba(248,81,73,0.06)"
        >
          <div style="display:flex;align-items:center;gap:8px;font-weight:600;font-size:0.8rem">
            <CircleAlert width={15} height={15} class="icon" style="color:var(--red)" />
            <span>{t('digest.errNoProvider')}</span>
          </div>
          <p class="settings-hint" style="margin:6px 0 0">
            {t('digest.errNoProviderHint')}
          </p>
          <div style="display:flex;gap:8px;margin-top:10px">
            <button class="btn-ghost sm" onClick={() => setLocation('/providers')}>
              <Settings2 width={12} height={12} class="icon" /> {t('digest.openProviders')}
            </button>
            <button class="btn-ghost sm" onClick={() => setProviderMissing(false)}>
              <Check width={12} height={12} class="icon" /> {t('common.close')}
            </button>
          </div>
        </div>
      )}

      {!providerMissing && error && (
        <div
          style="font-size:0.74rem;color:#fecaca;background:#7f1d1d;border-radius:8px;padding:7px 10px"
          role="alert"
        >
          {error}
        </div>
      )}
      {notice && (
        <div
          style="font-size:0.74rem;color:#bbf7d0;background:#14532d;border-radius:8px;padding:7px 10px"
          role="status"
        >
          <Check width={11} height={11} class="icon" style="vertical-align:-1px" /> {notice}
        </div>
      )}

      <h3
        style="display:flex;align-items:center;gap:6px;font-size:0.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--text-2);margin:0"
      >
        <History width={13} height={13} class="icon" /> {t('digest.history')}
        <span style="color:var(--text-3);font-weight:400;text-transform:none">({entries.length})</span>
      </h3>

      {loading ? (
        <p style="color:var(--text-3);font-size:0.78rem" role="status">
          {t('digest.loading')}
        </p>
      ) : entries.length === 0 ? (
        <div class="empty-state" style="text-align:center;padding:28px 0" role="status">
          <div class="big-icon">
            <Sparkles width={30} height={30} class="icon" />
          </div>
          <p style="color:var(--text-3);font-size:0.78rem;margin:8px 0 0">{t('digest.empty')}</p>
        </div>
      ) : (
        entries.map((e) => (
          <article
            key={e.id}
            style="background:rgba(255,255,255,.03);border:1px solid var(--border,#333);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:8px"
          >
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:0.72rem">
              <StatusChip
                status={e.status}
                label={
                  e.status === 'done'
                    ? t('digest.statusDone')
                    : e.status === 'failed'
                      ? t('digest.statusFailed')
                      : t('digest.statusRunning')
                }
              />
              <span style="color:var(--text-3)">
                {e.trigger === 'manual' ? t('digest.triggerManual') : t('digest.triggerSchedule')}
              </span>
              {e.status === 'running' && (
                <span
                  role="status"
                  style="display:inline-flex;align-items:center;gap:4px;color:var(--text-3)"
                >
                  <Loader2 width={11} height={11} class="icon spin" /> {t('digest.runningShort')}
                </span>
              )}
              <span style="flex:1" />
              <span style="display:inline-flex;align-items:center;gap:4px;color:var(--text-3)">
                <Clock width={11} height={11} class="icon" /> {relTime(e.createdAt)}
              </span>
              {e.durationMs != null && (
                <span style="color:var(--text-3)">{fmtDuration(e.durationMs)}</span>
              )}
              {e.actorName && <span style="color:var(--text-3)">{e.actorName}</span>}
              {!readOnly && (
                <button
                  class="btn-ghost sm icon-only"
                  style="min-height:24px;min-width:24px"
                  title={t('digest.deleteTitle')}
                  aria-label={t('digest.deleteAria', { time: relTime(e.createdAt) })}
                  onClick={() => setConfirmDelete(e)}
                >
                  <Trash2 width={13} height={13} class="icon" />
                </button>
              )}
            </div>

            {e.summary ? (
              <p
                style="margin:0;font-size:0.78rem;line-height:1.6;white-space:pre-wrap;word-break:break-word;color:var(--text-2)"
              >
                {e.summary}
              </p>
            ) : e.status === 'running' ? (
              <p style="margin:0;font-size:0.74rem;color:var(--text-3)">
                {t('digest.summaryPending')}
              </p>
            ) : null}

            {e.blockers && e.blockers.length > 0 && (
              <div style="display:flex;flex-direction:column;gap:4px">
                <span
                  style="display:inline-flex;align-items:center;gap:5px;font-size:0.66rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-3)"
                >
                  <Ban width={11} height={11} class="icon" /> {t('digest.blockers')}
                </span>
                <ul
                  style="margin:0;padding-inline-start:18px;display:flex;flex-direction:column;gap:2px;font-size:0.75rem;color:var(--text-2)"
                >
                  {e.blockers.map((b, i) => (
                    <li key={i} style="white-space:pre-wrap;word-break:break-word">
                      {b}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {e.nextSteps && e.nextSteps.length > 0 && (
              <div style="display:flex;flex-direction:column;gap:4px">
                <span
                  style="display:inline-flex;align-items:center;gap:5px;font-size:0.66rem;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--text-3)"
                >
                  <ArrowRight width={11} height={11} class="icon" /> {t('digest.nextSteps')}
                </span>
                <ul
                  style="margin:0;padding-inline-start:18px;display:flex;flex-direction:column;gap:2px;font-size:0.75rem;color:var(--text-2)"
                >
                  {e.nextSteps.map((s, i) => (
                    <li key={i} style="white-space:pre-wrap;word-break:break-word">
                      {s}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {e.status === 'failed' && e.error && (
              <div
                style="font-size:0.72rem;color:#fecaca;background:#7f1d1d;border-radius:8px;padding:7px 10px"
                role="alert"
              >
                {e.error}
              </div>
            )}

            {(e.provider || e.model) && (
              <div style="display:flex;gap:8px;flex-wrap:wrap;font-size:0.64rem;color:var(--text-3)">
                {e.model && <span>model: {e.model}</span>}
                {e.provider && <span>provider: {e.provider}</span>}
                {e.tokens != null && <span>tokens: {e.tokens}</span>}
                {e.cost != null && <span>cost: {e.cost}</span>}
              </div>
            )}
          </article>
        ))
      )}

      <ConfirmModal
        open={!!confirmDelete}
        danger
        title={t('digest.deleteTitle')}
        message={t('digest.deleteMessage')}
        confirmLabel={t('common.delete')}
        loading={deleting}
        onConfirm={doDelete}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}
