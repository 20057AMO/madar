import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { Container, Loader2, RefreshCw, RotateCcw } from 'lucide-preact';
import {
  getWorkspaceImageStatus,
  refreshWorkspaceImage,
  type ApiError,
  type WorkspaceImageStatus,
} from '../api';
import { ConfirmModal } from './ConfirmModal';
import { useI18n } from '../i18n';

type Notice = { kind: 'progress' | 'ok' | 'err'; text: string } | null;

const REASON_KEYS: Record<string, string> = {
  'The workspace image build date is missing, invalid, or older than the allowed age.': 'workspaceImage.reasonStale',
  'Workspace toolchain metadata is unavailable.': 'workspaceImage.reasonDriftUnknown',
  'The workspace image was built for a toolchain target that differs from the expected target.': 'workspaceImage.reasonTargetMismatch',
  'The workspace image declared metadata contradicts the toolchain detected inside the image.': 'workspaceImage.reasonDeclaredMismatch',
};

function Row({ label, value, mono = false, iso = false }: { label: string; value: string; mono?: boolean; iso?: boolean }) {
  return (
    <div class="wim-row">
      <span class="wim-key">{label}</span>
      <span class={`wim-val${mono ? ' mono' : ''}${iso ? ' wim-iso' : ''}`}>{value}</span>
    </div>
  );
}

export function WorkspaceImagePanel() {
  const { t, t2, lang } = useI18n();
  const [status, setStatus] = useState<WorkspaceImageStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const refreshTrigger = useRef<HTMLButtonElement | null>(null);

  const errorText = useCallback((e: unknown): string => {
    const err = e as Partial<ApiError> | null;
    let text: string;
    switch (err?.code) {
      case 'unauthorized':
        text = t('workspaceImage.errUnauthorized');
        break;
      case 'forbidden':
        text = t('workspaceImage.errForbidden');
        break;
      case 'refresh_in_progress':
        text = t('workspaceImage.errRefreshInProgress');
        break;
      case 'rate_limited':
        text = t('workspaceImage.errRateLimited');
        if (typeof err.retryAfter === 'number' && err.retryAfter > 0) text += ` (${err.retryAfter}s)`;
        break;
      case 'docker_unavailable':
        text = t('workspaceImage.errDockerUnavailable');
        break;
      case 'workspace_build_unavailable':
        text = t('workspaceImage.errBuildUnavailable');
        break;
      case 'workspace_build_failed':
        text = t('workspaceImage.errBuildFailed');
        break;
      case 'workspace_build_timeout':
        text = t('workspaceImage.errBuildTimeout');
        break;
      default:
        text = t('workspaceImage.errGeneric');
    }
    return text;
  }, [t]);

  const load = useCallback(async (fresh: boolean): Promise<boolean> => {
    setLoading(true);
    setLoadError(null);
    try {
      setStatus(await getWorkspaceImageStatus(fresh));
      if (fresh) setNotice({ kind: 'ok', text: t('workspaceImage.refreshSuccess') });
      return true;
    } catch (e) {
      if (fresh) setNotice(null);
      setLoadError(errorText(e));
      return false;
    } finally {
      setLoading(false);
    }
  }, [errorText, t]);

  useEffect(() => {
    void load(false);
  }, [load]);

  const doRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    setConfirmError(null);
    setNotice({ kind: 'progress', text: t('workspaceImage.refreshing') });
    try {
      await refreshWorkspaceImage();
      const reloaded = await load(true);
      if (!reloaded) setNotice(null);
      setRefreshing(false);
      setConfirmOpen(false);
      requestAnimationFrame(() => refreshTrigger.current?.focus());
    } catch (e) {
      const text = errorText(e);
      setConfirmError(text);
      setNotice({ kind: 'err', text });
    } finally {
      setRefreshing(false);
    }
  };

  const reload = () => {
    setNotice(null);
    void load(true);
  };

  const retry = () => {
    setNotice(null);
    void load(false);
  };

  const fmtTime = (iso: string | null): string => {
    if (!iso) return t('workspaceImage.unknownValue');
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return t('workspaceImage.unknownValue');
    return date.toLocaleString(lang === 'ar' ? 'ar' : undefined);
  };

  const wi = status?.workspaceImage;
  const staleProjects = status?.projects.filter((p) => !p.imageCurrent) ?? [];
  const sourceLabel = wi
    ? wi.source === 'container-marker'
      ? t('workspaceImage.sourceContainer')
      : wi.source === 'image-label'
        ? t('workspaceImage.sourceLabel')
        : t('workspaceImage.sourceUnavailable')
    : t('workspaceImage.unknownValue');
  const driftLabel = wi
    ? wi.drift === 'ok'
      ? t('workspaceImage.driftOk')
      : wi.drift === 'declared_actual_mismatch'
        ? t('workspaceImage.driftMismatch')
        : wi.drift === 'target_mismatch'
          ? t('workspaceImage.driftTarget')
          : t('workspaceImage.driftUnknown')
    : t('workspaceImage.unknownValue');

  return (
    <section
      class="panel settings-section"
      id="sec-workspace-image"
      aria-labelledby="wim-title"
    >
      <div class="set-head">
        <span class="set-head-icon" aria-hidden="true"><Container width={15} height={15} /></span>
        <div class="set-head-text">
          <h2 class="set-title" id="wim-title">{t('workspaceImage.title')}</h2>
          <div class="set-desc">{t('workspaceImage.subtitle')}</div>
        </div>
        <div class="set-head-action">
          <div class="wim-head-actions">
            <button
              class="btn-ghost sm"
              type="button"
              onClick={reload}
              disabled={loading || refreshing}
            >
              <RefreshCw width={13} height={13} class="icon" /> {t('workspaceImage.reload')}
            </button>
            <button
              ref={refreshTrigger}
              class="btn-primary sm"
              type="button"
              onClick={() => { setConfirmError(null); setConfirmOpen(true); }}
              disabled={loading || refreshing || !status}
            >
              <Container width={13} height={13} class="icon" /> {t('workspaceImage.refresh')}
            </button>
          </div>
        </div>
      </div>

      <div class="wim-live" role="status" aria-live="polite">
        {notice?.kind === 'err' ? '' : (notice?.text ?? '')}
      </div>
      <div class={`wim-live${notice?.kind === 'err' ? ' login-error' : ''}`} role="alert" aria-live="assertive">
        {notice?.kind === 'err' ? (notice?.text ?? '') : ''}
      </div>

      {loadError && (
        <div class="wim-note warn" role="alert" style="margin-bottom:10px">
          {loadError}
          <button class="btn-ghost sm" type="button" onClick={retry} style="margin-inline-start:8px">
            <RotateCcw width={13} height={13} class="icon" /> {t('workspaceImage.retry')}
          </button>
        </div>
      )}

      <div class="wim-results" aria-busy={loading || refreshing}>
        {status === null && !loadError && loading ? (
          <div class="dim" role="status">
            <Loader2 width={13} height={13} class="icon spin" /> {t('workspaceImage.loading')}
          </div>
        ) : wi && status ? (
        <>
          {!status.daemon && <div class="wim-note warn">{t('workspaceImage.daemonUnavailable')}</div>}

          <div class="wim-badges">
            <span class={`wim-badge ${wi.installed ? 'good' : 'bad'}`}>
              {wi.installed ? t('workspaceImage.installed') : t('workspaceImage.notInstalled')}
            </span>
            <span class={`wim-badge ${wi.stale ? 'warn' : 'good'}`}>
              {wi.stale ? t('workspaceImage.stale') : t('workspaceImage.current')}
            </span>
            <span class={`wim-badge ${wi.drift === 'ok' ? 'good' : wi.drift === 'unknown' ? 'bad' : 'warn'}`}>
              {driftLabel}
            </span>
          </div>

          <div class="wim-grid">
            <div class="wim-card">
              <h3>{t('workspaceImage.declared')}</h3>
              <Row label={t2('أوبونتو', 'Ubuntu')} value={wi.declared?.ubuntuVersionId ?? t('workspaceImage.unknownValue')} iso />
              <Row label={t2('إصدار Node', 'Node major')} value={wi.declared ? String(wi.declared.nodeMajor) : t('workspaceImage.unknownValue')} iso />
              <Row label={t2('قناة Node', 'Node channel')} value={wi.declared?.nodeChannel ?? t('workspaceImage.unknownValue')} iso />
            </div>
            <div class="wim-card">
              <h3>{t('workspaceImage.actual')}</h3>
              <Row label={t2('أوبونتو', 'Ubuntu')} value={wi.actual?.ubuntuPrettyName ?? t('workspaceImage.unknownValue')} iso />
              <Row label={t2('Node', 'Node')} value={wi.actual?.node ?? t('workspaceImage.unknownValue')} iso />
              <Row label={t2('npm', 'npm')} value={wi.actual?.npm ?? t('workspaceImage.unknownValue')} iso />
              <Row label={t2('Docker CLI', 'Docker CLI')} value={wi.actual ? (wi.actual.dockerCli ? t2('نعم', 'Yes') : t2('لا', 'No')) : t('workspaceImage.unknownValue')} />
            </div>
            <div class="wim-card">
              <h3>{t2('الصورة', 'Image')}</h3>
              <Row label={t('workspaceImage.imageId')} value={wi.imageId ?? t('workspaceImage.unknownValue')} mono iso />
              <Row label={t('workspaceImage.buildId')} value={wi.buildId ?? t('workspaceImage.unknownValue')} mono iso />
              <Row label={t('workspaceImage.builtAt')} value={fmtTime(wi.builtAt)} />
              <Row label={t('workspaceImage.source')} value={sourceLabel} />
              <Row label={t('workspaceImage.drift')} value={driftLabel} />
            </div>
            <div class="wim-card">
              <h3>{t2('الخادم', 'Daemon')}</h3>
              <Row label={t('workspaceImage.daemonVersion')} value={status.daemon?.version ?? t('workspaceImage.unknownValue')} iso />
              <Row label={t('workspaceImage.daemonApiVersion')} value={status.daemon?.apiVersion ?? t('workspaceImage.unknownValue')} iso />
              <Row label={t2('وقت الفحص', 'Checked at')} value={fmtTime(status.checkedAt)} />
            </div>
          </div>

          {wi.reasons.length > 0 && (
            <div class="wim-note warn">
              <strong>{t('workspaceImage.reasons')}</strong>
              <ul class="wim-reasons">
                {wi.reasons.map((reason, i) => (
                  <li key={i}>{REASON_KEYS[reason] ? t(REASON_KEYS[reason]) : t('workspaceImage.reasonUnknown')}</li>
                ))}
              </ul>
            </div>
          )}

          <div class="wim-note">
            <strong>
              {staleProjects.length > 0
                ? t('workspaceImage.projectsStale', { count: staleProjects.length })
                : t('workspaceImage.projectsAllCurrent')}
            </strong>
            {staleProjects.length > 0 && (
              <ul class="wim-slugs">
                {staleProjects.map((p) => <li key={p.slug} class="mono wim-iso">{p.slug}</li>)}
              </ul>
            )}
          </div>

          <div class="wim-last">
            <span>{t('workspaceImage.lastRefresh')}:</span>
            {status.lastRefresh ? (
              <>
                <time dateTime={status.lastRefresh.at}>{fmtTime(status.lastRefresh.at)}</time>
                <span class={`wim-badge ${status.lastRefresh.ok ? 'good' : 'bad'}`}>
                  {status.lastRefresh.ok ? t('workspaceImage.refreshOk') : t('workspaceImage.refreshFailed')}
                </span>
                <span>{t('workspaceImage.durationMs')}: <bdi class="wim-iso">{status.lastRefresh.durationMs} ms</bdi></span>
                {status.lastRefresh.buildId && <span class="mono wim-iso">{status.lastRefresh.buildId}</span>}
              </>
            ) : (
              <span>{t('workspaceImage.neverRefreshed')}</span>
            )}
          </div>

          <div class="wim-note warn">{t('workspaceImage.note')}</div>
        </>
        ) : null}
      </div>

      <ConfirmModal
        open={confirmOpen}
        title={t('workspaceImage.confirmedTitle')}
        message={t('workspaceImage.confirmedMessage')}
        confirmLabel={t('workspaceImage.confirm')}
        loading={refreshing}
        error={confirmError}
        onCancel={() => {
          if (refreshing) return;
          setConfirmOpen(false);
          setConfirmError(null);
        }}
        onConfirm={() => { void doRefresh(); }}
      />
    </section>
  );
}
