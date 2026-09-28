import { useState, useEffect, useRef } from 'preact/hooks';
import { FolderOpen, RefreshCw, TriangleAlert } from 'lucide-preact';
import { useHashLocation } from 'wouter/use-hash-location';
import { getIdeStatus, listProjects } from '../api';
import { VSCodeIcon } from '../components/brand-icons';
import { useI18n } from '../i18n';
import { useDocumentVisible } from '../lib/visibility';
import { useFrameFocusReturn, useFrameLoad } from '../lib/frame-load';
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
  const [port, setPort] = useState(8100);
  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState<{ slug: string; name: string }[]>([]);
  const [folder, setFolder] = useState(readSavedFolder);
  const folderRef = useRef(folder);

  const host = window.location.hostname;
  // Match the page protocol so the iframe is not blocked as mixed content
  // when the dashboard itself is served over HTTPS.
  const proto = window.location.protocol === 'https:' ? 'https' : 'http';
  const ideUrl = `${proto}://${host}:${port}/?folder=${encodeURIComponent(folder)}`;
  const pickedSlug = folder === '/workspaces' ? '' : folder.replace('/workspaces/', '');

  const { frameKey, state: frameState, onLoad: onFrameLoad, remount, isReady } = useFrameLoad(
    !loading && running !== false,
    ideUrl,
  );
  const overlayRef = useFrameFocusReturn(frameState);

  // First-paint timing (Settings → Performance): the wall-clock wait from the
  // first status-probe start to the frame's `load`. Started lazily per mount
  // so remounts (Retry, folder switch) refresh the "how long did it take"
  // answer instead of blending into one sample.
  const frameTimerRef = useRef<ReturnType<typeof startFrameTimer> | null>(null);
  const probeStartRef = useRef<number | null>(null);
  const probeMsRef = useRef(0);

  useEffect(() => {
    if (loading) return; // status not answered yet — the wait hasn't begun for the user
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
  }, [loading]);

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
  };

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

  return (
    <main class="opencode-page" id="ide-main" tabIndex={-1}>
      <div class="opencode-toolbar">
        <button class="btn-ghost sm" onClick={() => setLocation('/')}>‹ {t('common.back')}</button>
        <h1 style="display:inline-flex;align-items:center;gap:6px;margin-left:8px;font-weight:600;font-size:0.9rem">
          <VSCodeIcon width={15} height={15} /> VS Code
        </h1>
        <a class="btn-ghost sm" href={ideUrl} target="_blank" rel="noreferrer">{t('ide.openNewTab')}</a>
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
              <option key={p.slug} value={p.slug}>{p.name}</option>
            ))}
          </select>
        </span>
        <span style="flex: 1" />
        <span style="font-size: 0.68rem; color: var(--text-3); margin-left: 12px" role="status">
          {running === false
            ? t('ide.offline')
            : running
              ? frameStatus
              : ''}
      </span>
      </div>
      {loading ? (
        <div class="empty-state" style="margin: 60px auto; max-width: 480px" role="status">
          <div class="big-icon"><VSCodeIcon width={30} height={30} /></div>
          {t('ide.loadingStatus')}
        </div>
      ) : running === false ? (
        <div class="empty-state" style="margin: 60px auto; max-width: 480px" role="status">
          <div class="big-icon"><VSCodeIcon width={30} height={30} /></div>
          {t('ide.offlineBody')}
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
