import { useState, useEffect, useMemo, useRef } from 'preact/hooks';
import { FolderOpen, RefreshCw, TriangleAlert } from 'lucide-preact';
import { useHashLocation } from 'wouter/use-hash-location';
import { getIdeStatus, listProjects } from '../api';
import { VSCodeIcon } from '../components/brand-icons';
import { useI18n } from '../i18n';
import { useDocumentVisible } from '../lib/visibility';
import { useEmbedSession } from '../lib/embed-session';
import { useFrameFocusReturn, useFrameLoad } from '../lib/frame-load';
import { frameFocusRing } from '../lib/frame-focus-ring';
import { projectOptionLabel } from '../lib/project-label';
import { startFrameTimer } from '../lib/perf-metrics';

const FOLDER_KEY = 'wsd.ide.folder';
const BASE_INTERVAL = 8000;
const HIDDEN_INTERVAL = 30000;
const MAX_BACKOFF = 32000;

function readSavedFolder(): string {
  try {
    const f = localStorage.getItem(FOLDER_KEY);
    return f && f.startsWith('/workspaces') ? f : '/workspaces';
  } catch {
    return '/workspaces';
  }
}

export function EmbeddedIDE() {
  const [, setLocation] = useHashLocation();
  const { t } = useI18n();
  const [running, setRunning] = useState<boolean | null>(null);
  // The AUTHENTICATED PROXY port; /api/ide/status confirms it. 4097 is the
  // proxy default and the only port published to the IDE — code-server's own
  // 8100 is not published at all, so a stale default would be a dead link.
  const [port, setPort] = useState(4097);
  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState<{ slug: string; name: string }[]>([]);
  const [folder, setFolder] = useState(readSavedFolder);
  const folderRef = useRef(folder);

  const host = window.location.hostname;
  // Match the page protocol so the iframe is not blocked as mixed content
  // when the dashboard itself is served over HTTPS.
  const proto = window.location.protocol === 'https:' ? 'https' : 'http';
  // `port` is the AUTHENTICATED PROXY port reported by /api/ide/status, not
  // code-server's own port: the upstream is loopback-bound inside the app
  // container and no longer published, so this URL is the only route to it.
  // code-server serves relative asset URLs, so the /ide prefix is safe.
  const ideUrl = `${proto}://${host}:${port}/ide/?folder=${encodeURIComponent(folder)}`;
  const pickedSlug = folder === '/workspaces' ? '' : folder.replace('/workspaces/', '');

  // The proxy needs its session cookie before the frame can load, so the frame
  // stays unmounted (in the honest "checking…" state) until the exchange lands.
  const embed = useEmbedSession(true);
  const awaitingCredential = !embed.ready && !embed.forbidden;

  // The frame mounts only once BOTH prerequisites are answered: the status
  // endpoint (before that the default port is an assumption and a wrong one
  // dead-ends the frame) and the proxy credential (before that the request is
  // unauthenticated and the proxy answers 401 — reported as "did not load" for
  // an editor that is running perfectly well).
  const framePossible = !loading && running !== false && embed.ready;
  const { frameKey, state: frameState, onLoad: onFrameLoad, remount, isReady } = useFrameLoad(
    framePossible,
    ideUrl,
  );
  const overlayRef = useFrameFocusReturn(frameState);
  // Chromium rings no iframe for keyboard focus, so the frame arms its own.
  const frameRingRef = useMemo(frameFocusRing, []);

  // First-paint timing (Settings → Performance): the wall-clock wait from the
  // first status-probe start to the frame's `load`. Started lazily per mount
  // so remounts (Retry, folder switch) refresh the "how long did it take"
  // answer instead of blending into one sample. The clock starts only when the
  // frame can actually mount — a failed credential must not be recorded as a
  // frame that "errored".
  const frameTimerRef = useRef<ReturnType<typeof startFrameTimer> | null>(null);
  const probeStartRef = useRef<number | null>(null);
  const probeMsRef = useRef(0);

  useEffect(() => {
    if (!framePossible) return; // status and/or credential not answered yet — the wait hasn't begun
    if (frameTimerRef.current) return; // this mount already timed
    probeStartRef.current = probeStartRef.current ?? performance.now();
    frameTimerRef.current = startFrameTimer('ide', probeMsRef.current);
    return () => {
      // Unmount without a load (route change mid-load): record the attempt as
      // errored so the history stays honest — then reset for the next mount.
      frameTimerRef.current?.done({ errored: true });
      frameTimerRef.current = null;
      probeStartRef.current = null;
    };
  }, [framePossible]);

  useEffect(() => {
    if (frameState === 'ready') {
      frameTimerRef.current?.done();
      frameTimerRef.current = null;
    } else if (frameState === 'error') {
      frameTimerRef.current?.done({ errored: true });
      frameTimerRef.current = null;
    }
  }, [frameState]);

  // Apply a folder change: persist it and (optionally) reload the iframe.
  const applyFolder = (f: string, reload: boolean) => {
    folderRef.current = f;
    setFolder(f);
    try {
      localStorage.setItem(FOLDER_KEY, f);
    } catch {
      /* private mode */
    }
    if (reload) remount();
  };

  // Reactive deep-links: /ide?folder=/workspaces/<slug> preselects — including
  // while this component stays mounted via the keep-alive layer.
  // NOTE: wouter's useHashLocation() strips the query string from `loc`,
  // so we read the full hash directly to get ?folder=.
  useEffect(() => {
    const handleHash = () => {
      const hash = window.location.hash || '';
      const qIdx = hash.indexOf('?');
      const f = qIdx >= 0 ? new URLSearchParams(hash.slice(qIdx)).get('folder') : null;
      if (f && f.startsWith('/workspaces/') && f !== folderRef.current) applyFolder(f, true);
    };
    handleHash();
    window.addEventListener('hashchange', handleHash);
    return () => window.removeEventListener('hashchange', handleHash);
  }, []);

  useEffect(() => {
    let cancelled = false;
    listProjects()
      .then((r) => {
        if (!cancelled) setProjects(r.projects || []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const visible = useDocumentVisible();

  // Warm the connection to code-server before the iframe even mounts
  // (saves DNS + TCP round-trips on first paint). Driven by the reported port
  // so a remapped WSD_IDE_PORT still gets a preconnect.
  useEffect(() => {
    if (!port) return;
    try {
      const l = document.createElement('link');
      l.rel = 'preconnect';
      l.href = `${window.location.protocol}//${window.location.hostname}:${port}`;
      document.head.appendChild(l);
      return () => {
        l.remove();
      };
    } catch {
      /* ignore */
    }
  }, [port]);

  const retryCountRef = useRef(0);
  const refreshRef = useRef<(() => void) | null>(null);
  const loadingRef = useRef(true);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    let inFlight = false;

    const load = () => {
      // A slow probe must never stack: skip this tick while one is pending.
      if (inFlight) return;
      inFlight = true;
      const probeStartedAt = performance.now();
      getIdeStatus()
        .then((s) => {
          if (cancelled) return;
          setRunning(s.ide.running);
          setPort(s.ide.port);
          setLoading(false);
          loadingRef.current = false;
          retryCountRef.current = 0;
          // Latest probe duration feeds the frame timer's probe slice.
          probeMsRef.current = performance.now() - probeStartedAt;
          scheduleNext();
        })
        .catch(() => {
          if (!cancelled) {
            setRunning(false);
            setLoading(false);
            loadingRef.current = false;
          }
          retryCountRef.current = Math.min(retryCountRef.current + 1, 4);
          scheduleNext();
        })
        .finally(() => {
          inFlight = false;
        });
    };

    const scheduleNext = () => {
      if (timer) clearInterval(timer);
      if (cancelled) return;
      if (!visible) {
        timer = setInterval(load, HIDDEN_INTERVAL);
      } else {
        const delay = Math.min(BASE_INTERVAL * Math.pow(2, retryCountRef.current), MAX_BACKOFF);
        timer = setInterval(load, delay);
      }
    };

    refreshRef.current = () => {
      retryCountRef.current = 0;
      load();
    };

    load();
    return () => {
      cancelled = true;
      refreshRef.current = null;
      if (timer) clearInterval(timer);
    };
  }, [visible]);

  // code-server is supervised: it comes back on its own after a few seconds.
  // Re-frame the user once per outage so a frame that died with the process is
  // not left stranded — never while the frame is healthy, never repeatedly.
  const sawDownRef = useRef(false);
  const recoveredRef = useRef(false);

  useEffect(() => {
    if (running === false) {
      sawDownRef.current = true;
      recoveredRef.current = false;
      return;
    }
    if (running !== true || !sawDownRef.current || recoveredRef.current) return;
    if (isReady()) return;
    recoveredRef.current = true;
    remount();
  }, [running, isReady, remount]);

  const retry = () => {
    refreshRef.current?.();
    remount();
    // The credential may be the thing that actually failed (a frame that never
    // mounted has nothing to remount), so re-run the exchange too.
    embed.retry();
  };

  // Credential-only failure: no frame was ever mounted, so there is nothing to
  // remount and nothing to time — just re-run the exchange.
  const retryCredential = () => embed.retry();

  const pickProject = (slug: string) => {
    applyFolder(slug ? `/workspaces/${slug}` : '/workspaces', true);
  };

  // A passing process-level probe says nothing about whether the editor
  // actually rendered, so the toolbar reports the frame state and never claims
  // "running" while the frame is still loading or has failed. Mirrors the
  // opencode page: the badge is derived from the frame machine, never a
  // constant error string.
  const frameStatus = frameState === 'error'
    ? t('ide.frameError')
    : frameState === 'loading'
      ? t('ide.frameLoading')
      : t('ide.frameRunning');

  // The frame is unmounted until the proxy credential exists, so "loading" and
  // "no credential yet" share the one honest pre-frame state.
  const pending = loading || (running !== false && awaitingCredential);

  return (
    <main class="opencode-page" id="ide-main" tabIndex={-1}>
      <div class="opencode-toolbar">
        <button class="btn-ghost sm" onClick={() => setLocation('/')}>‹ {t('common.back')}</button>
        <h1 style="display:inline-flex;align-items:center;gap:6px;margin-left:8px;font-weight:600;font-size:0.9rem">
          <VSCodeIcon width={15} height={15} /> VS Code
        </h1>
        {embed.ready && running !== null && (
          <a class="btn-ghost sm" href={ideUrl} target="_blank" rel="noreferrer">{t('ide.openNewTab')}</a>
        )}
        <span style="display:inline-flex;align-items:center;gap:6px;margin-left:12px" title={t('ide.folderTitle')}>
          <FolderOpen width={13} height={13} class="icon" />
          <label class="sr-only" for="ide-project-select">{t('ide.folderLabel')}</label>
          <select
            id="ide-project-select"
            class="modern-input chat-sel"
            style="width:200px;min-height:26px;padding:4px 8px;font-size:0.72rem"
            value={pickedSlug}
            onInput={(e: any) => pickProject(e.target.value)}
          >
            <option value="">{t('ide.allProjects')}</option>
            {projects.map((p) => (
              <option key={p.slug} value={p.slug} title={p.slug}>{projectOptionLabel(p.name, p.slug)}</option>
            ))}
          </select>
        </span>
        <span style="flex: 1" />
        <span style="font-size: 0.68rem; color: var(--text-3); margin-left: 12px" role="status">
          {embed.error
            ? t('ide.credentialFailed')
            : running === false
              ? t('ide.offline')
              : embed.forbidden
                ? t('ide.needsEditor')
                : running
                  ? frameStatus
                  : ''}
      </span>
      </div>
      {embed.error ? (
        <div class="empty-state" style="margin: 60px auto; max-width: 480px" role="alert">
          <div class="big-icon"><TriangleAlert width={30} height={30} class="icon" style="color: var(--red)" /></div>
          {t('ide.credentialError')}
          <div class="mono dim" style="margin-top: 8px; font-size: 0.68rem; word-break: break-word">
            {embed.error}
          </div>
          <div style="margin-top:14px">
            <button class="btn-ghost sm" onClick={retryCredential}>
              <RefreshCw width={13} height={13} class="icon" /> {t('common.retry')}
            </button>
          </div>
        </div>
      ) : pending ? (
        <div class="empty-state" style="margin: 60px auto; max-width: 480px" role="status">
          <div class="big-icon"><VSCodeIcon width={30} height={30} /></div>
          {t('ide.credentialPending')}
        </div>
      ) : running === false || embed.forbidden ? (
        <div class="empty-state" style="margin: 60px auto; max-width: 480px" role="status">
          <div class="big-icon"><VSCodeIcon width={30} height={30} /></div>
          {embed.forbidden ? t('ide.needsEditor') : t('ide.offlineBody')}
          <div style="margin-top:14px">
            <button class="btn-ghost sm" onClick={retry}>
              <RefreshCw width={13} height={13} class="icon" /> {t('common.retry')}
            </button>
          </div>
          <code class="mono" style="display:block;margin-top:8px">docker compose logs app</code>
        </div>
      ) : (
        <>
          <iframe
            key={frameKey}
            ref={frameRingRef}
            class="opencode-frame"
            src={ideUrl}
            title="Madar VS Code"
            allow="clipboard-read; clipboard-write"
            aria-busy={frameState === 'loading' ? 'true' : undefined}
            aria-hidden={frameState === 'ready' ? undefined : 'true'}
            onLoad={() => {
              frameTimerRef.current?.done();
              frameTimerRef.current = null;
              onFrameLoad();
            }}
          />
          {frameState === 'loading' && (
            <div
              class="ide-loading"
              ref={overlayRef}
              tabIndex={-1}
              role="status"
              style="background: rgba(10, 12, 16, 0.85); color: var(--text); outline: none"
            >
              <RefreshCw width={16} height={16} class="icon spin" />
              {t('ide.loadingFrame')}
            </div>
          )}
          {frameState === 'error' && (
            <div
              class="ide-loading"
              ref={overlayRef}
              tabIndex={-1}
              role="alert"
              style="flex-direction: column; background: rgba(10, 12, 16, 0.85); color: var(--text); outline: none"
            >
              <TriangleAlert width={22} height={22} class="icon" style="color: var(--red)" />
              {t('ide.frameTimeout')}
              <button class="btn-ghost sm" style="margin-top:12px" onClick={retry}>
                <RefreshCw width={13} height={13} class="icon" /> {t('common.retry')}
              </button>
            </div>
          )}
        </>
      )}
    </main>
  );
}
