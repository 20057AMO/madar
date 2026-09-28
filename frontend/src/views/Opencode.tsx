import { useState, useEffect, useRef } from 'preact/hooks';
import { SquareTerminal, FolderOpen, RefreshCw, TriangleAlert } from 'lucide-preact';
import { useHashLocation } from 'wouter/use-hash-location';
import { canOpenProjectWorkspace, getOpencodeStatus, openOpencodeProject, listProjects } from '../api';
import { useAuth } from '../auth';
import { useI18n } from '../i18n';
import { useDocumentVisible } from '../lib/visibility';
import { useFrameFocusReturn, useFrameLoad } from '../lib/frame-load';
import { buildOpencodeUrl } from '../lib/opencode-link';
import { startFrameTimer } from '../lib/perf-metrics';

const PROJECT_KEY = 'wsd.opencode.project';
const BASE_INTERVAL = 5000;
const HIDDEN_INTERVAL = 30000;
const MAX_BACKOFF = 30000;

export function Opencode() {
  const [, setLocation] = useHashLocation();
  const { user } = useAuth();
  const { t } = useI18n();
  const [running, setRunning] = useState<boolean | null>(null);
  const [port, setPort] = useState(4096);
  const [projects, setProjects] = useState<{ slug: string; name: string; openable: boolean }[]>([]);
  const [picked, setPicked] = useState('');
  const pickedRef = useRef('');
  const [opening, setOpening] = useState(false);
  const [directory, setDirectory] = useState<string | null>(null);
  const [openErr, setOpenErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const host = window.location.hostname;
  // Match the page protocol so the iframe is not blocked as mixed content
  // when the dashboard itself is served over HTTPS.
  const proto = window.location.protocol === 'https:' ? 'https' : 'http';
  // A picked project deep-links straight into that directory; with no target
  // the bare root is used and opencode opens on its own home screen.
  const url = buildOpencodeUrl({ proto, host, port, directory });

  // The frame only mounts once the status endpoint has answered once: before
  // that the default port is an assumption and a wrong one 404s the frame into
  // the error overlay instead of the honest "checking…" state.
  const { frameKey, state: frameState, onLoad: onFrameLoad, remount, isReady } = useFrameLoad(
    running !== null && running !== false,
    url,
  );
  const overlayRef = useFrameFocusReturn(frameState);

  // First-paint timing (Settings → Performance): probe → iframe `load`, one
  // sample per mount (Retry / project switch starts a fresh measurement).
  const frameTimerRef = useRef<ReturnType<typeof startFrameTimer> | null>(null);
  const probeMsRef = useRef(0);

  const visible = useDocumentVisible();

  // Warm the connection to the opencode web server before the iframe mounts
  // (saves DNS + TCP round-trips on first paint). Driven by the reported port
  // so a remapped WSD_OPENCODE_PORT still gets a preconnect.
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

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    let inFlight = false;

    const load = () => {
      // A slow probe must never stack: skip this tick while one is pending.
      if (inFlight) return;
      inFlight = true;
      const probeStartedAt = performance.now();
      getOpencodeStatus()
        .then((s) => {
          if (cancelled) return;
          setRunning(s.running);
          setPort(s.port);
          retryCountRef.current = 0; // reset backoff on success
          probeMsRef.current = performance.now() - probeStartedAt; // feeds the frame timer
          scheduleNext();
        })
        .catch(() => {
          if (!cancelled) setRunning(false);
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
        // When hidden, poll at 30s regardless of backoff
        timer = setInterval(load, HIDDEN_INTERVAL);
      } else {
        // Exponential backoff: 5s, 10s, 20s, 30s cap
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

  useEffect(() => {
    let cancelled = false;
    listProjects()
      .then((r) => {
        if (cancelled) return;
        // The picker only offers projects this user could actually open, so a
        // viewer is never handed a selection that ends in a 403.
        setProjects(
          (r.projects || []).map((p) => ({
            slug: p.slug,
            name: p.name,
            openable: canOpenProjectWorkspace(user, p),
          })),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [user?.id, user?.role]);

  const openableProjects = projects.filter((p) => p.openable);

  const openProject = async (slug: string) => {
    pickedRef.current = slug;
    setPicked(slug);
    setOpenErr(null);
    setNotice(null);
    try {
      localStorage.setItem(PROJECT_KEY, slug);
    } catch {
      /* private mode */
    }
    if (!slug) {
      setDirectory(null);
      remount();
      return;
    }
    setOpening(true);
    try {
      const res = await openOpencodeProject(slug);
      const name = projects.find((p) => p.slug === slug)?.name || slug;
      // The backend keeps the created session id server-side, so the
      // directory-scoped link is what scopes the client: it opens a fresh
      // session inside that directory.
      setDirectory(res?.directory || `/workspaces/${slug}`);
      const ready = t('opencode.noticeReady', { name });
      setNotice(ready);
      // A transient success must not squat the status slot forever: clear it
      // after a bounded window (guarded so a newer notice is never cleared).
      window.setTimeout(() => setNotice((cur) => (cur === ready ? null : cur)), 8000);
    } catch (err: any) {
      // Roll the picker back to what is actually open — the selection the
      // user just chose did not take effect.
      pickedRef.current = '';
      setPicked('');
      try {
        localStorage.removeItem(PROJECT_KEY);
      } catch {
        /* private mode */
      }
      setOpenErr(err.message);
      setDirectory(null);
    } finally {
      setOpening(false);
    }
  };

  // Reactive deep-links (?project=slug) + last-project memory — both work
  // while this component stays mounted via the keep-alive layer. A remembered or
  // deep-linked project the user cannot open is skipped (and the stored value
  // dropped) instead of firing a request that can only 403.
  // NOTE: the query lives inside the hash, so read the full hash directly to
  // get ?project=.
  useEffect(() => {
    if (!projects.length) return;
    const handleHash = () => {
      let wanted = '';
      const hash = window.location.hash || '';
      const qIdx = hash.indexOf('?');
      if (qIdx >= 0) {
        wanted = new URLSearchParams(hash.slice(qIdx)).get('project') || '';
      } else {
        try {
          wanted = localStorage.getItem(PROJECT_KEY) || '';
        } catch {
          /* ignore */
        }
      }
      if (!wanted || wanted === pickedRef.current) return;
      const project = projects.find((p) => p.slug === wanted);
      if (project?.openable) openProject(wanted);
    };
    handleHash();
    window.addEventListener('hashchange', handleHash);
    return () => window.removeEventListener('hashchange', handleHash);
  }, [projects]);

  // opencode is supervised: it comes back on its own after an update restarts
  // it. Re-frame the user once per outage — never while the frame is healthy,
  // never repeatedly.
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
    frameTimerRef.current = startFrameTimer('opencode', probeMsRef.current);
    remount();
  }, [running, isReady, remount]);

  const retry = () => {
    frameTimerRef.current = startFrameTimer('opencode', probeMsRef.current);
    refreshRef.current?.();
    remount();
  };

  // Arm the timer when the frame becomes possible (status answered) — this is
  // the same tick the user starts waiting. Unmount mid-load records an errored
  // attempt; done() is idempotent-safe via the `finished` flag.
  useEffect(() => {
    if (running === null) return;
    if (!frameTimerRef.current) frameTimerRef.current = startFrameTimer('opencode', probeMsRef.current);
    return () => {
      frameTimerRef.current?.done({ errored: true });
      frameTimerRef.current = null;
    };
  }, [running === null]);

  // A passing process-level probe says nothing about whether the client actually
  // rendered, so the toolbar reports the frame state and never claims "running"
  // while the frame is still loading or has failed.
  const frameStatus = frameState === 'error'
    ? t('opencode.frameError')
    : frameState === 'loading'
      ? t('opencode.frameLoading')
      : t('opencode.frameRunning');

  return (
    <main class="opencode-page" id="opencode-main" tabIndex={-1}>
      <div class="opencode-toolbar">
        <h1 class="sr-only">opencode</h1>
        <button class="btn-ghost sm" onClick={() => setLocation('/')}>‹ {t('common.back')}</button>
        <a class="btn-ghost sm" href={url} target="_blank" rel="noreferrer">
          {t('opencode.openNewTab')}
        </a>
        <span style="display:inline-flex;align-items:center;gap:6px;margin-left:12px" title={t('opencode.pickerTitle')}>
          <FolderOpen width={13} height={13} class="icon" />
          <label class="sr-only" for="oc-project-select">{t('opencode.pickerLabel')}</label>
          <select
            id="oc-project-select"
            class="modern-input chat-sel"
            style="width:200px;min-height:26px;padding:4px 8px;font-size:0.72rem"
            value={picked}
            disabled={opening}
            onInput={(e: any) => openProject(e.target.value)}
          >
            <option value="">{t('opencode.pickerHome')}</option>
            {openableProjects.map((p) => (
              <option key={p.slug} value={p.slug}>{p.name}</option>
            ))}
          </select>
        </span>
        {!openableProjects.length && (
          <span class="term-title" style="font-size: 0.68rem; color: var(--text-3)">
            {t('opencode.needsEditor')}
          </span>
        )}
        <span class="term-title" style="flex: 1; text-align: right; font-size: 0.7rem" role="status">
          {notice && frameState !== 'ready'
            ? notice
            : running === false
              ? t('opencode.offline')
              : opening
                ? t('opencode.opening')
                : running
                  ? frameStatus
                  : t('opencode.checking')}
        </span>
      </div>
      {openErr && (
        <div
          class="term-title"
          style="padding: 6px 14px; font-size: 0.7rem; color: var(--red); border-bottom: 1px solid var(--border)"
          role="alert"
        >
          {openErr}
        </div>
      )}
      {running === false ? (
        <div class="empty-state" style="margin: 60px auto; max-width: 480px" role="alert">
          <div class="big-icon"><SquareTerminal width={30} height={30} class="icon" /></div>
          {t('opencode.offlineBody')}
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
            src={url}
            title="Madar opencode"
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
              {t('opencode.loadingFrame')}
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
              {t('opencode.frameTimeout')}
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
