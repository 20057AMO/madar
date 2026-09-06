import { useState, useEffect, useRef } from 'preact/hooks';
import { ArrowLeft, SquareTerminal, FolderOpen, RefreshCw } from 'lucide-preact';
import { useHashLocation } from 'wouter/use-hash-location';
import { getOpencodeStatus, openOpencodeProject, listProjects, type Project } from '../api';
import { useDocumentVisible } from '../lib/visibility';

const PROJECT_KEY = 'wsd.opencode.project';
const BASE_INTERVAL = 5000;
const HIDDEN_INTERVAL = 30000;
const MAX_BACKOFF = 30000;

export function Opencode() {
  const [, setLocation] = useHashLocation();
  const [running, setRunning] = useState<boolean | null>(null);
  const [port, setPort] = useState(4096);
  const [projects, setProjects] = useState<Project[]>([]);
  const [picked, setPicked] = useState('');
  const pickedRef = useRef('');
  const [opening, setOpening] = useState(false);
  const [frameKey, setFrameKey] = useState(0);
  const [frameReady, setFrameReady] = useState(false);
  const [openErr, setOpenErr] = useState<string | null>(null);

  const visible = useDocumentVisible();

  // Warm the connection to the opencode web server before the iframe mounts
  // (saves DNS + TCP round-trips on first paint).
  useEffect(() => {
    try {
      const l = document.createElement('link');
      l.rel = 'preconnect';
      l.href = `${window.location.protocol}//${window.location.hostname}:4096`;
      document.head.appendChild(l);
      return () => {
        l.remove();
      };
    } catch {
      /* ignore */
    }
  }, []);

  const retryCountRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const load = () =>
      getOpencodeStatus()
        .then((s) => {
          if (cancelled) return;
          setRunning(s.running);
          setPort(s.port);
          retryCountRef.current = 0; // reset backoff on success
          scheduleNext();
        })
        .catch(() => {
          if (!cancelled) setRunning(false);
          retryCountRef.current = Math.min(retryCountRef.current + 1, 4);
          scheduleNext();
        });

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

    load();
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [visible]);

  const host = window.location.hostname;
  // Match the page protocol so the iframe is not blocked as mixed content
  // when the dashboard itself is served over HTTPS.
  const proto = window.location.protocol === 'https:' ? 'https' : 'http';
  const url = `${proto}://${host}:${port}`;

  useEffect(() => {
    let cancelled = false;
    listProjects()
      .then((r) => {
        if (cancelled) return;
        setProjects(r.projects || []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const openProject = async (slug: string) => {
    pickedRef.current = slug;
    setPicked(slug);
    setOpenErr(null);
    try {
      localStorage.setItem(PROJECT_KEY, slug);
    } catch {
      /* private mode */
    }
    if (!slug) {
      setFrameKey((k) => k + 1);
      return;
    }
    setOpening(true);
    try {
      await openOpencodeProject(slug);
      setFrameKey((k) => k + 1);
    } catch (err: any) {
      setOpenErr(err.message);
    } finally {
      setOpening(false);
    }
  };

  // Reactive deep-links (?project=slug) + last-project memory — both work
  // while this component stays mounted via the keep-alive layer.
  // NOTE: wouter's useHashLocation() strips the query string from `loc`,
  // so we read the full hash directly to get ?project=.
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
      if (projects.some((p) => p.slug === wanted)) openProject(wanted);
    };
    handleHash();
    window.addEventListener('hashchange', handleHash);
    return () => window.removeEventListener('hashchange', handleHash);
  }, [projects]);

  // Reset the loading overlay whenever a new frame mounts.
  useEffect(() => {
    setFrameReady(false);
  }, [frameKey]);

  return (
    <div class="opencode-page">
      <div class="opencode-toolbar">
        <button class="btn-ghost sm" onClick={() => setLocation('/')}><ArrowLeft width={13} height={13} class="icon" /> Dashboard</button>
        <a class="btn-ghost sm" href={url} target="_blank" rel="noreferrer">
          Open in new tab
        </a>
        <span style="display:inline-flex;align-items:center;gap:6px;margin-left:12px" title="Opens (or reuses) an opencode session for the project">
          <FolderOpen width={13} height={13} class="icon" />
          <select
            class="modern-input chat-sel"
            style="width:200px;padding:4px 8px;font-size:0.72rem"
            value={picked}
            disabled={opening}
            onInput={(e: any) => openProject(e.target.value)}
          >
            <option value="">opencode home…</option>
            {projects.map((p) => (
              <option key={p.slug} value={p.slug}>{p.name}</option>
            ))}
          </select>
        </span>
        <span class="term-title" style="flex: 1; text-align: right; font-size: 0.7rem" role="status">
          {openErr ? openErr : running === false ? 'opencode: offline' : opening ? 'opening…' : running ? 'opencode: running' : 'opencode: …'}
        </span>
      </div>
      {running === false ? (
        <div class="empty-state" style="margin: 60px auto; max-width: 480px" role="alert">
          <div class="big-icon"><SquareTerminal width={30} height={30} class="icon" /></div>
          opencode is not available right now. Check the container log:
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
            onLoad={() => setFrameReady(true)}
          />
          {!frameReady && (
            <div class="ide-loading" role="status">
              <RefreshCw width={16} height={16} class="icon spin" />
              Loading opencode…
            </div>
          )}
        </>
      )}
    </div>
  );
}
