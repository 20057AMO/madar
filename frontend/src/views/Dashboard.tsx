import { useState, useEffect, useRef } from 'preact/hooks';
import { useHashLocation } from 'wouter/use-hash-location';
import {
  FolderOpen,
  Loader2,
  Play,
  Square,
  TriangleAlert,
  ChevronRight,
  Globe,
  Plus,
  Upload,
  TerminalSquare,
  LayoutDashboard,
} from 'lucide-preact';
import { CrashBadge } from '../components/CrashBadge';
import { ConfirmModal } from '../components/ConfirmModal';
import { VSCodeIcon, OpencodeIcon } from '../components/brand-icons';
import {
  listProjects,
  startProject,
  stopProject,
  getServerInfo,
  importProjectSnapshot,
  wsUrl,
  Project,
  ServerInfo,
} from '../api';
import { fmtCpu, fmtMem } from '../lib/limits';
import { useDocumentVisible } from '../lib/visibility';

const PROJECT_PREVIEW_LIMIT = 8;

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  if (d > 0) return `${d}d ${h}h`;
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatMemBytes(bytes: number): string {
  const gb = bytes / (1024 ** 3);
  if (gb >= 1) return `${Math.round(gb)} GiB`;
  return `${Math.round(bytes / (1024 ** 2))} MiB`;
}

export function Dashboard() {
  const [, setLocation] = useHashLocation();
  const [projects, setProjects] = useState<Project[]>([]);
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);
  const [qaBusy, setQaBusy] = useState<string | null>(null);
  const [stopAllOpen, setStopAllOpen] = useState(false);
  const [stopAllBusy, setStopAllBusy] = useState(false);
  const [stopAllSuccess, setStopAllSuccess] = useState(false);
  const restoreInputRef = useRef<HTMLInputElement | null>(null);
  const [importing, setImporting] = useState(false);

  const visible = useDocumentVisible();
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    let closed = false;
    let timer: number | null = null;
    let socket: WebSocket | null = null;

    const refreshProjects = async () => {
      if (!visibleRef.current) return;
      try {
        const p = await listProjects();
        if (!closed) { setProjects(p.projects); setLoadError(null); }
      } catch (err: any) {
        if (!closed) setLoadError(err.message);
      } finally {
        if (!closed) setLoading(false);
      }
    };

    const tickInfo = async () => {
      if (!visibleRef.current) return;
      try {
        const i = await getServerInfo();
        if (closed) return;
        setInfo(i);
      } catch { /* non-critical */ }
    };

    const connectWs = () => {
      if (closed) return;
      try { socket = new WebSocket(wsUrl('/ws/projects/status')); } catch { socket = null; }
      if (!socket) { startPolling(); return; }

      socket.onmessage = (ev) => {
        if (closed) return;
        let msg: any;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'error') { socket?.close(); if (!closed) startPolling(); return; }
        if (msg.type === 'ready') {
          setProjects((prev) => {
            const map = new Map<string, string>(msg.projects.map((p: any) => [p.slug, p.status]));
            return prev.map((p) => {
              const ns = map.get(p.slug) as Project['status'] | undefined;
              return ns && ns !== p.status ? { ...p, status: ns } : p;
            });
          });
          setLoading(false);
          setLoadError(null);
        }
        if (msg.type === 'update') {
          setProjects((prev) =>
            prev.map((p) => p.slug === msg.slug ? { ...p, status: msg.status } : p),
          );
        }
      };

      const fail = () => { socket?.close(); if (!closed) startPolling(); };
      socket.onerror = fail;
      socket.onclose = () => { if (!closed) startPolling(); };
    };

    const startPolling = () => {
      if (timer) return;
      const tick = async () => {
        if (!visibleRef.current) return;
        try {
          const p = await listProjects();
          if (!closed) { setProjects(p.projects); setLoadError(null); }
        } catch { /* ignore */ }
      };
      tick();
      timer = window.setInterval(tick, 5000);
    };

    refreshProjects();
    tickInfo();
    const infoTimer = setInterval(tickInfo, 30000);
    connectWs();

    return () => {
      closed = true;
      if (timer) clearInterval(timer);
      clearInterval(infoTimer);
      try { socket?.close(); } catch { /* ignore */ }
    };
  }, []);

  const prevVisible = useRef(visible);
  useEffect(() => {
    if (visible && !prevVisible.current) {
      listProjects().then((p) => { setProjects(p.projects); setLoadError(null); }).catch(() => {});
      getServerInfo().then((i) => setInfo(i)).catch(() => {});
    }
    prevVisible.current = visible;
  }, [visible]);

  const handleNewProject = () => {
    try { sessionStorage.setItem('wsd.openCreate', '1'); } catch { /* ignored */ }
    setLocation('/projects');
  };

  const handleRestoreFile = async (e: any) => {
    const file = e.target?.files?.[0];
    if (!file) return;
    setImporting(true);
    setLoadError(null);
    try {
      const { project } = await importProjectSnapshot(file);
      setLocation(`/project/${project.slug}`);
    } catch (err: any) {
      setLoadError(err?.message || 'Restore failed');
    } finally {
      if (e.target) e.target.value = '';
      setImporting(false);
    }
  };

  const handleStartAll = async () => {
    if (qaBusy) return;
    setQaBusy('start-all');
    const errors: string[] = [];
    for (const p of projects) {
      if (p.status !== 'running') {
        try { await startProject(p.slug); }
        catch (err: any) { errors.push(`${p.name}: ${err.message || 'failed'}`); }
      }
    }
    if (errors.length > 0) {
      setLoadError(`Failed starting ${errors.length} project(s):\n${errors.join('\n')}`);
    }
    setQaBusy(null);
  };

  const handleStopAll = () => { setStopAllOpen(true); };

  const confirmStopAll = async () => {
    if (stopAllBusy) return;
    setStopAllBusy(true);
    const errors: string[] = [];
    for (const p of projects) {
      if (p.status === 'running') {
        try { await stopProject(p.slug); }
        catch (err: any) { errors.push(`${p.name}: ${err.message || 'failed'}`); }
      }
    }
    if (errors.length > 0) {
      setLoadError(`Failed stopping ${errors.length} project(s):\n${errors.join('\n')}`);
    } else {
      setStopAllSuccess(true);
      setTimeout(() => setStopAllSuccess(false), 3000);
    }
    setStopAllBusy(false);
    setStopAllOpen(false);
  };

  const running = projects.filter((p) => p.status === 'running').length;
  const stopped = projects.filter((p) => p.status === 'stopped' || p.status === 'created').length;
  const crashed = projects.filter((p) => p.crash).length;

  const handleAction = async (e: MouseEvent, slug: string, action: 'start' | 'stop') => {
    e.stopPropagation();
    if (acting) return;
    setActing(slug);
    try {
      if (action === 'start') await startProject(slug);
      else await stopProject(slug);
    } catch (err: any) {
      setLoadError(err.message);
    } finally {
      setActing(null);
    }
  };

  const openProject = (e: MouseEvent, p: Project) => {
    e.stopPropagation();
    if (p.status === 'running' && p.serve?.enabled && p.serve.hostPort) {
      window.open(`http://${window.location.hostname}:${p.serve.hostPort}`, '_blank', 'noopener,noreferrer');
    } else {
      setLocation(`/project/${p.slug}`);
    }
  };

  const navigateTo = (path: string) => (e: MouseEvent) => {
    e.stopPropagation();
    setLocation(path);
  };

  const handleCardKeyDown = (path: string) => (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setLocation(path); }
  };

  if (loading) {
    return (
      <div class="view">
        <div class="dash-loading">
          <Loader2 width={28} height={28} class="icon spin" />
          <span role="status">Loading…</span>
        </div>
      </div>
    );
  }

  const previewProjects = projects.slice(0, PROJECT_PREVIEW_LIMIT);
  const runningCount = projects.filter(p => p.status === 'running').length;
  const stoppedCount = projects.filter(p => p.status !== 'running').length;

  return (
    <div class="view">
      <div class="hero">
        <span class="hero-badge">BETA</span>
        <h1 class="hero-title">Dashboard</h1>
        <p class="hero-sub">Your development environment at a glance.</p>
      </div>

      {loadError && <div class="login-error dash-error" role="alert">{loadError}</div>}
      {stopAllSuccess && <div class="dash-success" role="status">All projects stopped.</div>}

      {/* ── Quick Actions ─────────────────────────────────── */}
      <div class="dash-qa-section">
        <div class="dash-qa-grid">
          <button class="qa-tile" onClick={handleNewProject}>
            <Plus width={18} height={18} class="icon" />
            <span>New Project</span>
          </button>
          <button class="qa-tile" onClick={() => restoreInputRef.current?.click()} disabled={importing}>
            {importing
              ? <Loader2 width={18} height={18} class="icon spin" />
              : <Upload width={18} height={18} class="icon" />}
            <span>{importing ? 'Importing…' : 'Restore'}</span>
          </button>
          <input
            ref={restoreInputRef}
            type="file"
            accept=".tar.gz,application/gzip"
            class="dash-restore-input"
            onChange={handleRestoreFile}
          />
          <button class="qa-tile" onClick={handleStartAll} disabled={!!qaBusy || stoppedCount === 0}>
            <Play width={18} height={18} class="icon" />
            <span>Start All</span>
          </button>
          <button class="qa-tile" onClick={handleStopAll} disabled={!!qaBusy || runningCount === 0}>
            <Square width={18} height={18} class="icon" />
            <span>Stop All</span>
          </button>
          <button class="qa-tile" onClick={() => setLocation('/ide')}>
            <VSCodeIcon width={18} height={18} />
            <span>VS Code</span>
          </button>
          <button class="qa-tile" onClick={() => setLocation('/opencode')}>
            <OpencodeIcon width={18} height={18} />
            <span>Opencode</span>
          </button>
          <button class="qa-tile" onClick={() => setLocation('/terminals')}>
            <TerminalSquare width={18} height={18} class="icon" />
            <span>Terminals</span>
          </button>
          <button class="qa-tile" onClick={() => setLocation('/planner')}>
            <LayoutDashboard width={18} height={18} class="icon" />
            <span>Planner</span>
          </button>
        </div>
      </div>

      {/* ── Stat Cards ────────────────────────────────────── */}
      <div class="dash-stats">
        <div
          class="dash-stat-card"
          role="button"
          tabIndex={0}
          onClick={navigateTo('/projects')}
          onKeyDown={handleCardKeyDown('/projects')}
        >
          <div class="dash-stat-icon"><FolderOpen width={18} height={18} class="icon" /></div>
          <div class="dash-stat-info">
            <span class="dash-stat-value">{projects.length}</span>
            <span class="dash-stat-label">Total Projects</span>
          </div>
        </div>
        <div
          class="dash-stat-card running"
          role="button"
          tabIndex={0}
          onClick={navigateTo('/projects?filter=running')}
          onKeyDown={handleCardKeyDown('/projects?filter=running')}
        >
          <div class="dash-stat-icon"><Play width={18} height={18} class="icon" /></div>
          <div class="dash-stat-info">
            <span class="dash-stat-value">{running}</span>
            <span class="dash-stat-label">Running</span>
          </div>
        </div>
        <div
          class="dash-stat-card stopped"
          role="button"
          tabIndex={0}
          onClick={navigateTo('/projects?filter=stopped')}
          onKeyDown={handleCardKeyDown('/projects?filter=stopped')}
        >
          <div class="dash-stat-icon"><Square width={18} height={18} class="icon" /></div>
          <div class="dash-stat-info">
            <span class="dash-stat-value">{stopped}</span>
            <span class="dash-stat-label">Stopped</span>
          </div>
        </div>
        {crashed > 0 && (
          <div
            class="dash-stat-card crashed"
            role="button"
            tabIndex={0}
            onClick={navigateTo('/projects?filter=crashed')}
            onKeyDown={handleCardKeyDown('/projects?filter=crashed')}
          >
            <div class="dash-stat-icon"><TriangleAlert width={18} height={18} class="icon" /></div>
            <div class="dash-stat-info">
              <span class="dash-stat-value">{crashed}</span>
              <span class="dash-stat-label">Crashed</span>
            </div>
          </div>
        )}
      </div>

      {/* ── Projects Preview ──────────────────────────────── */}
      <div class="section-head">
        <h2>Projects</h2>
        {projects.length > 0 && (
          <a class="dash-view-all" href="#/projects">View all{projects.length > PROJECT_PREVIEW_LIMIT ? ` (${projects.length})` : ''}</a>
        )}
      </div>
      {previewProjects.length === 0 ? (
        <div class="dash-empty-state">
          <div class="big-icon"><FolderOpen width={30} height={30} class="icon" /></div>
          No projects yet — create your first one.
          <button class="btn-primary dash-empty-cta" onClick={handleNewProject}>+ New Project</button>
        </div>
      ) : (
        <div class="projects-grid">
          {previewProjects.map((p) => (
            <div
              class="project-card"
              key={p.slug}
              role="button"
              tabIndex={0}
              onClick={() => setLocation(`/project/${p.slug}`)}
              onKeyDown={handleCardKeyDown(`/project/${p.slug}`)}
            >
              <div class="project-card-header">
                <h2>{p.name}</h2>
                <span class={`status-badge ${p.status}`}>{p.status}</span>
                {p.crash && <CrashBadge crash={p.crash} />}
              </div>
              <div class="project-desc">{p.description || '—'}</div>
              <div class="project-tags">
                {p.tags && p.tags.map(t => (
                  <span class="tag-chip" key={t}>{t}</span>
                ))}
              </div>
              <div class="project-meta">
                {p.hostPorts && Object.keys(p.hostPorts).length > 0
                  ? Object.entries(p.hostPorts).map(([priv, pub]) => (
                    <span class="meta-chip port" key={priv}>:{pub}</span>
                  ))
                  : p.ports && p.ports.length > 0 && p.ports.map(port => (
                    <span class="meta-chip port" key={String(port)}>:{port}</span>
                  ))
                }
                {p.limits?.cpu && <span class="meta-chip" title="CPU limit">{fmtCpu(p.limits.cpu)}</span>}
                {p.limits?.memory && <span class="meta-chip" title="Memory limit">RAM {fmtMem(p.limits.memory)}</span>}
                {p.serve?.enabled && p.serve.port && (
                  <span class="meta-chip serve" title="Static site"><Globe width={11} height={11} class="icon" /> site :{p.serve.port}</span>
                )}
                {(!p.hostPorts || Object.keys(p.hostPorts).length === 0) && (!p.ports || p.ports.length === 0) && !p.limits?.cpu && !p.limits?.memory && !p.serve?.enabled && <span class="meta-chip">{p.slug}</span>}
              </div>
              <div class="card-footer">
                <button class="btn-ghost sm" disabled={acting === p.slug} onClick={(e) => handleAction(e, p.slug, p.status === 'running' ? 'stop' : 'start')}>
                  {acting === p.slug ? '…' : p.status === 'running' ? 'Stop' : 'Start'}
                </button>
                <button class="btn-ghost sm" onClick={(e) => openProject(e, p)}>
                  Open <ChevronRight width={13} height={13} class="icon" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── System Footer ─────────────────────────────────── */}
      <div class="dash-system-footer">
        <div class="dash-system-item">
          <span>Server</span>
          <span class="dash-system-val">{info?.version || '…'}</span>
        </div>
        {info && (
          <>
            <div class="dash-system-item">
              <span>Host</span>
              <span class="dash-system-val">{info.hostCpu} CPU · {formatMemBytes(info.hostMemBytes)}</span>
            </div>
            <div class="dash-system-item">
              <span>Up</span>
              <span class="dash-system-val">{formatUptime(info.uptime)}</span>
            </div>
            <div class="dash-system-item">
              <span>Port</span>
              <span class="dash-system-val">:{info.basePort}</span>
            </div>
            {info.lanIp && (
              <div class="dash-system-item">
                <span>LAN</span>
                <span class="dash-system-val">{info.lanIp}</span>
              </div>
            )}
            {info.tailscaleIp && (
              <div class="dash-system-item">
                <span>Tailscale</span>
                <span class="dash-system-val">{info.tailscaleIp}</span>
              </div>
            )}
          </>
        )}
      </div>

      <ConfirmModal
        open={stopAllOpen}
        danger
        loading={stopAllBusy}
        title="Stop all projects?"
        message="Stops every running project container."
        confirmLabel="Stop All"
        onConfirm={confirmStopAll}
        onCancel={() => { if (!stopAllBusy) setStopAllOpen(false); }}
      />
    </div>
  );
}
