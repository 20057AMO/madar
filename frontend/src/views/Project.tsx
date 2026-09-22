import { useState, useEffect, useRef } from 'preact/hooks';
import { Download, TriangleAlert, Globe, Copy, Loader2, Check, Ellipsis, Pencil, FileArchive, Folder, FileText, FileCode, FileJson, FileImage, Home, Bot, FolderOpen, ScrollText, SquareTerminal, StickyNote, Wrench, Users, Camera, PenTool, History, MessageSquare, BrainCircuit } from 'lucide-preact';
import { useHashLocation } from 'wouter/use-hash-location';
import {
  getProject,
  getProjectEnv,
  startProject,
  stopProject,
  deleteProject,
  updateProject,
  recreateProject,
  setProjectEnv,
  setProjectPorts,
  setProjectLimits,
  cloneProject,
  updateProjectTags,
  getProjectStats,
  checkProjectPorts,
  getChatContext,
  getIdeStatus,
  listProjectFiles,
  getProjectFile,
  fetchProjectFileRaw,
  saveProjectFile,
  renameProjectPath,
  deleteProjectFile,
  uploadFiles,
  getProjectScripts,
  runProjectScript,
  getProjectSubdir,
  getLogs,
  wsUrl,
  exportProjectSnapshot,
  exportProjectZip,
  crashSummary,
  startServe,
  stopServe,
  clearProjectCrash,
} from '../api';
import type {
  Project,
  ProjectStats,
  PortHealth,
  SubdirInfo,
  FileEntry,
  FilePreview,
  ChatContext,
} from '../api';
import { NotesPanel } from '../components/NotesPanel';
import { ReviewsPanel } from '../components/ReviewsPanel';
import { AgentRunPanel } from '../components/AgentRunPanel';
import { fmtCpu, fmtMem, limitsPending } from '../lib/limits';
import { fmtAction } from '../lib/activity-meta';
import { ProjectChat } from '../components/ProjectChat';
import { ProjectTerminal } from '../components/ProjectTerminal';
import { ConfirmModal } from '../components/ConfirmModal';
import { TeamPanel } from '../components/TeamPanel';
import { SnapshotsPanel } from '../components/SnapshotsPanel';
import { ActivityPanel } from '../components/ActivityPanel';
import { ProjectCanvas } from '../components/ProjectCanvas';
import { CrashBadge } from '../components/CrashBadge';
import { useAuth } from '../auth';
import { useI18n } from '../i18n';
import { usePresence } from '../usePresence';
import { useDocumentVisible } from '../lib/visibility';
import { VSCodeIcon, OpencodeIcon } from '../components/brand-icons';

type Tab = 'overview' | 'chat' | 'files' | 'reviews' | 'logs' | 'terminal' | 'notes' | 'scripts' | 'team' | 'activity' | 'snapshots' | 'canvas' | 'agents';

const VALID_TABS: readonly Tab[] = ['overview', 'chat', 'files', 'reviews', 'logs', 'terminal', 'notes', 'scripts', 'team', 'activity', 'snapshots', 'canvas', 'agents'];

/** i18n keys per tab — labels resolve through useI18n at render time. */
const TAB_KEYS: Record<Tab, string> = {
  overview: 'project.overview',
  chat: 'project.chat',
  files: 'project.files',
  reviews: 'project.reviews',
  logs: 'project.logs',
  terminal: 'project.terminal',
  notes: 'project.notes',
  scripts: 'project.scripts',
  team: 'project.team',
  activity: 'project.activity',
  snapshots: 'project.snapshots',
  canvas: 'project.canvas',
  agents: 'project.agents',
};

const TAB_ICON: Record<Tab, any> = {
  overview: Home,
  chat: Bot,
  files: FolderOpen,
  reviews: MessageSquare,
  logs: ScrollText,
  terminal: SquareTerminal,
  notes: StickyNote,
  scripts: Wrench,
  team: Users,
  activity: History,
  snapshots: Camera,
  canvas: PenTool,
  agents: BrainCircuit,
};

function fmtBytes(bytes: number): string {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

function fmtUptime(startedAt: string | null): string {
  if (!startedAt) return '—';
  const s = Math.round((Date.now() - new Date(startedAt).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

function relTime(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function Project({ params }: { params: { slug: string } }) {
  // wouter's :slug captures query strings too (hash routing), so strip `?tab=…`.
  const slug = (params.slug || '').split('?')[0];
  const [location, setLocation] = useHashLocation();
  const { t, lang } = useI18n();
  const { user } = useAuth();
  const [project, setProject] = useState<Project | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [error, setError] = useState<string | null>(null);
  const [ideRunning, setIdeRunning] = useState<boolean | null>(null);
  const [subdirInfo, setSubdirInfo] = useState<SubdirInfo | null>(null);
  const [liveStats, setLiveStats] = useState<ProjectStats | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [ideNotice, setIdeNotice] = useState<string | null>(null);
  const onlineUsers = usePresence(slug);

  const visible = useDocumentVisible();
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  // Deep-linkable tabs via `?tab=<name>`. wouter's hash router relocates the
  // query into the real window.location.search, so match that first. A `path=`
  // query pre-fills the Reviews composer (from the Files tab "Review" button).
  const [reviewInitialPath, setReviewInitialPath] = useState('');
  useEffect(() => {
    const src = window.location.search || location || '';
    const m = src.match(/[?&]tab=([a-z]+)/);
    if (m && (VALID_TABS as readonly string[]).includes(m[1])) setTab(m[1] as Tab);
    const pm = src.match(/[?&]path=([^&]*)/);
    if (pm) {
      try {
        setReviewInitialPath(decodeURIComponent(pm[1]));
      } catch {
        setReviewInitialPath(pm[1]);
      }
    } else {
      setReviewInitialPath('');
    }
  }, [location]);

  // After a deep-link from the file preview ("Review" button), the popup closes
  // and focus would land on <body> — move it to the composer's file-path field
  // (or the tabpanel for viewers, who have no composer) once the tab mounts.
  const pathInputRef = useRef<HTMLInputElement | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (tab !== 'reviews' || !reviewInitialPath) return;
    if (pathInputRef.current) pathInputRef.current.focus();
    else paneRef.current?.focus();
  }, [tab]);

  // Viewer members (and non-members) get a read-only board; owners/admins edit.
  // System editors are global writers — they pass even without membership.
  const readOnly = !!project && !!user && user.role !== 'admin' && user.role !== 'editor' && project.ownerId !== user.id &&
    (project.members?.find((m) => m.userId === user.id)?.role ?? 'viewer') === 'viewer';

  // Transient notices fade out on their own.
  useEffect(() => {
    if (!ideNotice) return;
    const t = setTimeout(() => setIdeNotice(null), 4000);
    return () => clearTimeout(t);
  }, [ideNotice]);

  /** Localized copy for the WS 'missing' status (outside JSX scope). */
  const t2ProjectDeleted = (): string =>
    lang === 'ar' ? 'تم حذف هذا المشروع.' : 'Project was deleted.';

  const load = async () => {
    try {
      const { project } = await getProject(slug);
      setProject(project);
      setError(null);
    } catch (err: any) {
      setError(err.message);
    }
  };

  // WebSocket for live status + stats updates
  useEffect(() => {
    let closed = false;
    let timer: number | null = null;
    let socket: WebSocket | null = null;

    // Always fetch full project data on mount
    load();

    const connectWs = () => {
      if (closed) return;
      try {
        socket = new WebSocket(wsUrl(`/ws/projects/${slug}/status`));
      } catch {
        socket = null;
      }
      if (!socket) { startPolling(); return; }

      socket.onmessage = (ev) => {
        if (closed) return;
        let msg: any;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'error') { socket?.close(); setWsConnected(false); if (!closed) startPolling(); return; }
        if (msg.type === 'ready' || msg.type === 'update') {
          setWsConnected(true);
          if (msg.status === 'missing') {
            setError(t2ProjectDeleted());
            setLiveStats(null);
            return;
          }
          setProject((prev) => {
            if (!prev) return prev;
            return { ...prev, status: msg.status };
          });
          if (msg.stats !== undefined) setLiveStats(msg.stats);
        }
      };

      const fail = () => { socket?.close(); setWsConnected(false); if (!closed) startPolling(); };
      socket.onerror = fail;
      socket.onclose = () => { setWsConnected(false); if (!closed) startPolling(); };
    };

    const startPolling = () => {
      if (timer) return;
      const tick = async () => {
        if (!visibleRef.current) return; // skip when hidden
        try {
          const { project } = await getProject(slug);
          if (!closed) { setProject(project); setError(null); }
        } catch { /* ignore */ }
      };
      tick();
      timer = window.setInterval(tick, 5000);
    };

    connectWs();

    return () => {
      closed = true;
      if (timer) clearInterval(timer);
      try { socket?.close(); } catch { /* ignore */ }
    };
  }, [slug]);

  // When the tab becomes visible again, tick once immediately to catch up
  // on any state changes that happened while hidden.
  const prevVisible = useRef(visible);
  useEffect(() => {
    if (visible && !prevVisible.current) {
      load();
    }
    prevVisible.current = visible;
  }, [visible]);

  useEffect(() => {
    getProjectSubdir(slug)
      .then(setSubdirInfo)
      .catch(() => {});
  }, [slug]);

  const tabsRef = useRef<HTMLDivElement | null>(null);
  const pendingTabFocus = useRef<Tab | null>(null);
  useEffect(() => {
    const bar = tabsRef.current;
    if (!bar) return;
    if (pendingTabFocus.current === tab) {
      pendingTabFocus.current = null;
      bar.querySelector<HTMLElement>(`.tab-btn[data-tab="${tab}"]`)?.focus();
    }
    if (window.innerWidth > 700) return;
    const active = bar.querySelector<HTMLElement>('.tab-btn.active');
    if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [tab]);

  const onTabListKeyDown = (e: any) => {
    const idx = VALID_TABS.indexOf(tab);
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = (idx + 1) % VALID_TABS.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + VALID_TABS.length) % VALID_TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = VALID_TABS.length - 1;
    if (next === null) return;
    e.preventDefault();
    const t = VALID_TABS[next];
    pendingTabFocus.current = t;
    setTab(t);
  };

  useEffect(() => {
    getIdeStatus()
      .then(({ ide }) => setIdeRunning(ide.running))
      .catch(() => setIdeRunning(false));
  }, []);

  const handleStart = async () => {
    try {
      await startProject(slug);
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleStop = async () => {
    try {
      await stopProject(slug);
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleDismissCrash = async () => {
    try {
      await clearProjectCrash(slug);
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const handleRestart = async () => {
    setConfirmRestart(true);
  };

  const [exporting, setExporting] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [copied, setCopied] = useState(false);
  const [zipping, setZipping] = useState(false);

  const [moreOpen, setMoreOpen] = useState(false);
  const headerMoreWrap = useRef<HTMLDivElement | null>(null);

  const [exportOpen, setExportOpen] = useState(false);
  const exportWrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!moreOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (headerMoreWrap.current && !headerMoreWrap.current.contains(e.target as Node)) setMoreOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMoreOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [moreOpen]);

  useEffect(() => {
    if (!exportOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (exportWrap.current && !exportWrap.current.contains(e.target as Node)) setExportOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setExportOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [exportOpen]);

  const handleExport = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const { blob, filename } = await exportProjectSnapshot(slug);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setExporting(false);
    }
  };

  const runRestart = async () => {
    setConfirmRestart(false);
    try {
      await stopProject(slug);
      await startProject(slug);
      await load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const openIde = () => {
    if (!ideRunning) {
      setIdeNotice('VS Code is not running yet.');
      return;
    }
    const folder = subdirInfo?.hostPath || `/workspaces/${slug}`;
    // Set the hash directly (instead of setLocation('/ide?folder=…')): wouter's
    // navigate() pushes a query into location.search — OUTSIDE the hash — so the
    // IDE keep-alive layer (which watches hashchange) would never see the folder.
    // "#/ide?folder=/workspaces/<slug>" keeps the query inside the hash where
    // EmbeddedIDE's handler parses it.
    window.location.hash = `/ide?folder=${encodeURIComponent(folder)}`;
  };

  const openOpencode = () => {
    const folder = subdirInfo?.hostPath || `/workspaces/${slug}`;
    window.location.hash = `/opencode?folder=${encodeURIComponent(folder)}`;
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      return;
    } catch {
      // Fallback: legacy execCommand for insecure contexts / older browsers.
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand('copy');
        ta.remove();
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } catch { /* clipboard unavailable */ }
    }
  };

  const handleZip = async () => {
    if (zipping) return;
    setZipping(true);
    try {
      const { blob, filename } = await exportProjectZip(slug);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setZipping(false);
    }
  };

  // Escape/blur both cancel — never commit a draft on accidental blur. The
  // input unmounts right after Escape, firing onBlur; routing it here instead
  // of handleSaveName is what keeps a stale keystroke from being PATCHed.
  const cancelRename = () => {
    setNameDraft(project?.name || '');
    setRenaming(false);
  };

  const handleSaveName = async () => {
    const trimmed = nameDraft.trim();
    if (!trimmed || trimmed === (project?.name || '')) {
      cancelRename();
      return;
    }
    try {
      await updateProject(slug, { name: trimmed });
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setRenaming(false);
    }
  };

  return (
    <div class="view">
      {error && <div class="login-error" style="margin-bottom: 12px">{error}</div>}
      {ideNotice && <div class="chat-save-msg unlock-info-note" style="margin-bottom: 12px">{ideNotice}</div>}

      <div class="detail-topbar">
        <button class="btn-ghost sm" onClick={() => setLocation('/projects')}>{t('project.backToProjects')}</button>
        <div class="detail-title-wrap">
          <div>
            {renaming ? (
              <input
                type="text"
                class="detail-title"
                value={nameDraft}
                onInput={(e: any) => setNameDraft((e.target as HTMLInputElement).value)}
                onBlur={cancelRename}
                onKeyDown={(e: KeyboardEvent) => {
                  if (e.key === 'Enter') { e.preventDefault(); handleSaveName(); }
                  if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
                }}
                autoFocus
                aria-label={t('misc.projectNameAria')}
              />
            ) : (
              <h1 class="detail-title" style="display:inline-flex;align-items:center;gap:6px; margin-bottom:10px;">
                {project?.name || t('common.loading')}
                {!readOnly && (
                  <button
                    class="btn-ghost sm icon-only"
                    style="padding:8px; margin-left:6px"
                    title={t('misc.renameProject')}
                    aria-label={t('misc.renameProject')}
                    onClick={() => { setNameDraft(project?.name || ''); setRenaming(true); }}
                  >
                    <Pencil width={13} height={13} class="icon" />
                  </button>
                )}
              </h1>
            )}
            <div class="detail-meta-line">
              <span class="detail-slug">{slug}</span>
              <button
                class={`btn-ghost sm${copied ? ' copied-flash' : ''}`}
                style="padding: 4px 8px"
                onClick={() => copy(slug)}
                aria-label={copied ? t('misc.slugCopied') : t('misc.copySlug')}
              >
                {copied ? <><Check width={13} height={13} class="icon" /> {t('project.copied')}</> : t('project.copy')}
              </button>
              <span class={`status-badge ${project?.status || 'missing'}`}>{project ? t(`status.${project.status}`) : '…'}</span>
              {project?.crash && <CrashBadge crash={project.crash} />}
              {wsConnected && <span class="ws-live-dot" role="status" title={t('misc.liveUpdates')} aria-label={t('misc.liveUpdates')} />}
               {onlineUsers.length > 0 && (
                 <div class="presence-indicator" role="status">
                   <div class="presence-avatar-stack">
                     {onlineUsers.slice(0, 5).map(u => (
                       <span class="presence-avatar-wrap" key={u.id} title={u.username}>
                         <span class="presence-avatar">{u.username.charAt(0).toUpperCase()}</span>
                         <span class="presence-online-dot" />
                       </span>
                     ))}
                     {onlineUsers.length > 5 && (
                       <span class="presence-avatar-wrap presence-avatar-more" title={t('misc.moreOnline', { n: onlineUsers.length - 5 })}>
                         <span class="presence-avatar">+{onlineUsers.length - 5}</span>
                       </span>
                     )}
                   </div>
                   <span class="presence-count">{t('misc.online', { n: onlineUsers.length })}</span>
                 </div>
               )}
            </div>
          </div>
        </div>
        <div class="detail-actions">
           <div class="header-overflow">
             <button class="btn-ghost sm" onClick={openIde} >
               <VSCodeIcon width={13} height={13} class="icon" /> {t('project.openWith')}
             </button>
             <button class="btn-ghost sm" onClick={openOpencode} >
               <OpencodeIcon width={13} height={13} class="icon" /> Opencode
             </button>
             <span class="detail-action-sep" aria-hidden="true" />
             <span style={{ position: 'relative', display: 'inline-block' }} ref={exportWrap}>
               <button 
                 class="btn-ghost sm" 
                 onClick={() => setExportOpen(!exportOpen)} 
                 disabled={readOnly}
                 title={readOnly ? t('misc.exportViewer') : t('misc.exportTitle')}
               >
                 <Download width={13} height={13} class="icon" /> {t('misc.exportBtn')}
               </button>
               {exportOpen && (
                 <div class="header-menu" role="menu" style={{ right: 'auto', left: 0 }}>
                   <button role="menuitem" onClick={() => { setExportOpen(false); handleExport(); }} disabled={exporting}>
                     <Download width={13} height={13} class="icon" /> {exporting ? t('project.backingUp') : t('project.backup')}
                   </button>
                   <button role="menuitem" onClick={() => { setExportOpen(false); handleZip(); }} disabled={zipping}>
                     <FileArchive width={13} height={13} class="icon" /> {zipping ? t('project.zipping') : t('project.filesZip')}
                   </button>
                 </div>
               )}
             </span>
           </div>
          <span class="header-more-wrap" ref={headerMoreWrap}>
            <button
              class="btn-ghost sm icon-only header-more"
              aria-label={t('common.more')}
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen(!moreOpen)}
            >
              <Ellipsis width={15} height={15} class="icon" />
            </button>
            {moreOpen && (
              <div class="header-menu" role="menu">
                <button role="menuitem" onClick={() => { setMoreOpen(false); openIde(); }}><VSCodeIcon width={13} height={13} class="icon" /> {t('project.openWith')}</button>
                <div class="header-menu-sep" role="separator" />
                <button role="menuitem" onClick={() => { setMoreOpen(false); handleExport(); }} disabled={exporting || readOnly} title={t('misc.downloadSnapshot')}>
                  <Download width={13} height={13} class="icon" /> {exporting ? t('project.backingUp') : t('project.backup')}
                </button>
              </div>
            )}
          </span>
          <button
            class={project?.status === 'running' ? 'btn-danger sm' : 'btn-primary sm'}
            onClick={() => (project?.status === 'running' ? handleStop() : handleStart())}
            disabled={readOnly}
            title={readOnly ? t('project.viewerNoStart') : undefined}
          >
            {project?.status === 'running' ? t('common.stop') : t('common.start')}
          </button>
          <button class="btn-ghost sm restart-btn" onClick={handleRestart} disabled={readOnly || project?.status !== 'running'} title={readOnly ? t('project.viewerNoRestart') : undefined}>
            {t('common.restart')}
          </button>
        </div>
      </div>

      {project?.crash && (
        <div class="panel" style="margin-bottom: 16px; border-left: 3px solid var(--red); background: rgba(248,81,73,0.06);">
          <div style="display:flex; align-items:center; gap:8px; color: var(--red); font-weight: 600;">
            <span style="display:flex; align-items:center; gap:8px; flex:1">
              <TriangleAlert width={15} height={15} class="icon" />
              <span>{t('project.crashBanner')}</span>
              <span class="dim" style="color:var(--text-2); font-weight:400">{crashSummary(project.crash, t)}</span>
            </span>
            {!readOnly && (
              <button class="btn-ghost sm" style="white-space:nowrap" onClick={handleDismissCrash}>
                <Check width={13} height={13} class="icon" /> {t('project.dismiss')}
              </button>
            )}
          </div>
          <p class="settings-hint" style="margin: 6px 0 0">
            {project.crash.reason === 'oom'
              ? t('project.crashOom')
              : project.crash.reason === 'restart'
                ? t('project.crashRestart')
                : t('project.crashExited')}
          </p>
        </div>
      )}

      <nav class="detail-tabs" ref={tabsRef} role="tablist" aria-label={t('misc.a11yTablist')} onKeyDown={onTabListKeyDown}>
        {VALID_TABS.map((tb) => {
          const Ic = TAB_ICON[tb];
          return (
            <button
              class={`tab-btn ${tab === tb ? 'active' : ''}`}
              type="button"
              key={tb}
              role="tab"
              id={`ptab-${tb}`}
              aria-selected={tab === tb}
              tabIndex={tab === tb ? 0 : -1}
              aria-controls={`pane-${tb}`}
              data-tab={tb}
              onClick={() => setTab(tb)}
            >
              <span class="tab-icon" aria-hidden="true"><Ic width={13} height={13} class="icon" /></span>
              {t(TAB_KEYS[tb])}
            </button>
          );
        })}
      </nav>

      <div id={`pane-${tab}`} role="tabpanel" aria-labelledby={`ptab-${tab}`} tabIndex={0} ref={paneRef}>
        {tab === 'overview' && <OverviewPanel slug={slug} project={project} liveStats={liveStats} readOnly={readOnly} onChanged={load} onError={setError} />}
        {tab === 'chat' && <ProjectChat slug={slug} readOnly={readOnly}  />}
        {tab === 'files' && <FilesPanel slug={slug} readOnly={readOnly} />}
        {tab === 'reviews' && (
          <ReviewsPanel
            key={`${slug}:${reviewInitialPath}`}
            slug={slug}
            readOnly={readOnly}
            initialPath={reviewInitialPath}
            project={project}
            pathInputRef={pathInputRef}
          />
        )}
        {tab === 'logs' && <LogsPanel slug={slug} running={project?.status === 'running'} />}
        {tab === 'terminal' && <ProjectTerminal slug={slug} />}
        {tab === 'notes' && <NotesPanel slug={slug} readOnly={readOnly} />}
        {tab === 'scripts' && <ScriptsPanel slug={slug} />}
        {tab === 'team' && <TeamPanel slug={slug} project={project} onlineUsers={onlineUsers} />}
        {tab === 'activity' && <ActivityPanel slug={slug} readOnly={readOnly} />}
        {tab === 'snapshots' && <SnapshotsPanel slug={slug} />}
        {tab === 'canvas' && <ProjectCanvas slug={slug} readOnly={readOnly} />}
        {tab === 'agents' && <AgentRunPanel slug={slug} readOnly={readOnly} />}
      </div>

      <ConfirmModal
        open={confirmRestart}
        danger={false}
        title={t('project.restartTitle', { slug })}
        message={t('project.restartMessage')}
        confirmLabel={t('common.restart')}
        onConfirm={runRestart}
        onCancel={() => setConfirmRestart(false)}
      />
    </div>
  );
}

// ── Overview ──────────────────────────────────────────────────
function OverviewPanel({
  slug,
  project,
  liveStats,
  readOnly,
  onChanged,
  onError,
}: {
  slug: string;
  project: Project | null;
  liveStats: ProjectStats | null;
  readOnly: boolean;
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  const [, setLocation] = useHashLocation();
  const { t } = useI18n();
  const [stats, setStats] = useState<ProjectStats | null>(null);
  const [checks, setChecks] = useState<PortHealth[] | null>(null);
  const [ctx, setCtx] = useState<ChatContext | null>(null);
  const [ctxOpen, setCtxOpen] = useState(false);
  const [copiedPort, setCopiedPort] = useState<string | null>(null);

  const [editDesc, setEditDesc] = useState(false);
  const [descText, setDescText] = useState('');

  const [cloneUrl, setCloneUrl] = useState('');
  const [cloning, setCloning] = useState(false);
  const [cloneMsg, setCloneMsg] = useState<string | null>(null);

  const [envText, setEnvText] = useState('');
  // Project payloads no longer carry env (secrets). Editors fetch the real
  // values from the dedicated env endpoint; viewers keep the count only.
  const [envVars, setEnvVars] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (readOnly) {
      setEnvVars({});
      return;
    }
    getProjectEnv(slug)
      .then((d) => { if (!cancelled) setEnvVars(d.env || {}); })
      .catch(() => { if (!cancelled) setEnvVars({}); });
    return () => { cancelled = true; };
  }, [slug, readOnly]);
  const [envMsg, setEnvMsg] = useState<string | null>(null);

  const [portsText, setPortsText] = useState('');
  const [portsMsg, setPortsMsg] = useState<string | null>(null);
  const [savingPorts, setSavingPorts] = useState(false);
  const [editPortsOpen, setEditPortsOpen] = useState(false);
  const portsInputRef = useRef<HTMLInputElement | null>(null);

  const [servePort, setServePort] = useState<number | undefined>();
  const [serving, setServing] = useState(false);
  const [serveCopied, setServeCopied] = useState(false);

  const [cpuText, setCpuText] = useState('');
  const [memText, setMemText] = useState('');
  const [limitsMsg, setLimitsMsg] = useState<string | null>(null);
  const [savingLimits, setSavingLimits] = useState(false);
  const cpuInputRef = useRef<HTMLInputElement | null>(null);
  const memInputRef = useRef<HTMLInputElement | null>(null);
  const envInputRef = useRef<HTMLTextAreaElement | null>(null);
  const envDirtyRef = useRef(false);
  const tagsDirtyRef = useRef(false);

  const [tagInput, setTagInput] = useState('');
  const [currentTags, setCurrentTags] = useState<string[]>([]);
  const [tagsMsg, setTagsMsg] = useState<string | null>(null);
  const [savingTags, setSavingTags] = useState(false);
  const [editingTags, setEditingTags] = useState(false);
  const tagInputRef = useRef<HTMLInputElement | null>(null);

  const [recreating, setRecreating] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [confirmRecreate, setConfirmRecreate] = useState(false);

  // Which config section is currently in edit mode (view/edit pattern).
  const [editSection, setEditSection] = useState<'env' | 'ports' | 'limits' | null>(null);

  // Quick-nav: exclusive overview tab — Links & health is the default; Danger zone stays pinned.
  const [activeSec, setActiveSec] = useState<string>('ov-links');

  const visible = useDocumentVisible();
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  // Prefer liveStats from WebSocket; fall back to polling
  const effectiveStats = liveStats || stats;

  useEffect(() => {
    if (project?.status !== 'running' || liveStats) {
      setStats(null);
      return;
    }
    let cancelled = false;
    const poll = () => {
      if (!visibleRef.current) return; // skip when hidden
      getProjectStats(slug)
        .then(({ stats: s }) => {
          if (!cancelled) setStats(s);
        })
        .catch(() => {});
    };
    poll();
    const t = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [slug, project?.status, liveStats]);

  // Port-health check: 15s interval with overlap guard.
  // A changing hostPorts dependency re-runs this effect; an in-flight
  // ref prevents the previous poll from stacking.
  const portCheckInflight = useRef(0);
  useEffect(() => {
    if (!project?.hostPorts || Object.keys(project.hostPorts).length === 0) {
      setChecks(null);
      return;
    }
    let cancelled = false;
    const seq = ++portCheckInflight.current;
    const poll = () => {
      if (!visibleRef.current) return; // skip when hidden
      if (seq !== portCheckInflight.current) return; // superseded
      checkProjectPorts(slug)
        .then(({ checks: c }) => {
          if (!cancelled && seq === portCheckInflight.current) setChecks(c);
        })
        .catch(() => {});
    };
    poll();
    const t = setInterval(poll, 15000);
    return () => {
      cancelled = true;
      portCheckInflight.current++; // invalidate any in-flight
      clearInterval(t);
    };
  }, [slug, project?.hostPorts]);

  // When the tab becomes visible again, tick once immediately to catch up
  // on runtime stats + port health that may have changed while hidden.
  const prevVisible = useRef(visible);
  useEffect(() => {
    if (visible && !prevVisible.current) {
      if (project?.status === 'running' && !liveStats) {
        getProjectStats(slug).then(({ stats: s }) => setStats(s)).catch(() => {});
      }
      if (project?.hostPorts && Object.keys(project.hostPorts).length > 0) {
        checkProjectPorts(slug).then(({ checks: c }) => setChecks(c)).catch(() => {});
      }
    }
    prevVisible.current = visible;
  }, [visible]);

  useEffect(() => {
    let cancelled = false;
    getChatContext(slug)
      .then((c) => {
        if (!cancelled) setCtx(c);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [slug]);

  useEffect(() => {
    if (document.activeElement === envInputRef.current || envDirtyRef.current) return;
    setEnvText(Object.entries(envVars || {}).map(([k, v]) => `${k}=${v}`).join('\n'));
  }, [envVars]);

  useEffect(() => {
    if (document.activeElement === portsInputRef.current) return;
    setPortsText((project?.ports || []).join(', '));
  }, [project?.ports]);

  useEffect(() => {
    if (document.activeElement === cpuInputRef.current) return;
    setCpuText(project?.limits?.cpu || '');
  }, [project?.limits?.cpu]);

  useEffect(() => {
    if (document.activeElement === memInputRef.current) return;
    setMemText(project?.limits?.memory || '');
  }, [project?.limits?.memory]);

  useEffect(() => {
    if (tagsDirtyRef.current) return;
    setCurrentTags(project?.tags ? [...project.tags] : []);
  }, [project?.tags]);

  useEffect(() => {
    envDirtyRef.current = false;
    tagsDirtyRef.current = false;
  }, [slug]);

  const saveDescription = async () => {
    try {
      await updateProject(slug, { description: descText });
      setEditDesc(false);
      onChanged();
    } catch (err: any) {
      onError(err.message);
    }
  };

  const doClone = async () => {
    if (!cloneUrl.trim()) return;
    setCloning(true);
    setCloneMsg(null);
    try {
      const r = await cloneProject(slug, cloneUrl.trim());
      setCloneMsg(t('cfg.cloneOk', { target: r.target || t('cfg.cloneRoot') }));
      setCloneUrl('');
      onChanged();
    } catch (err: any) {
      setCloneMsg(t('cfg.cloneFail', { error: err.message }));
    } finally {
      setCloning(false);
    }
  };

  const saveEnv = async () => {
    const env: Record<string, string> = {};
    const skipped: string[] = [];
    for (const raw of envText.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      const eq = line.indexOf('=');
      const k = eq > 0 ? line.slice(0, eq).trim() : '';
      const v = eq > 0 ? line.slice(eq + 1).trim() : '';
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) env[k] = v;
      else if (raw.trim()) skipped.push(line);
    }
    if (Object.keys(env).length === 0 && skipped.length > 0) {
      setEnvMsg(t('cfg.noValidEnv', { lines: skipped.join(' · ') }));
      return;
    }
    try {
      const r = await setProjectEnv(slug, env);
      const note = r.needsRecreate ? t('cfg.envSavedRecreate') : t('cfg.envSavedStart');
      setEnvMsg(skipped.length ? `${note} ${t('cfg.skipped', { lines: skipped.join(' · ') })}` : note);
      envDirtyRef.current = false;
      onChanged();
    } catch (err: any) {
      setEnvMsg(t('files.saveFail', { error: err.message }));
    }
  };

  const savePorts = async () => {
    if (savingPorts) return;
    const parsed = portsText
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')
      .map(Number);
    if (parsed.length > 0 && parsed.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) {
      setPortsMsg(t('cfg.invalidPorts'));
      return;
    }
    setSavingPorts(true);
    try {
      const r = await setProjectPorts(slug, parsed);
      setPortsMsg(r.needsRecreate ? t('cfg.portsSavedRecreate') : t('cfg.portsSaved'));
      onChanged();
    } catch (err: any) {
      setPortsMsg(t('files.saveFail', { error: err.message }));
    } finally {
      setSavingPorts(false);
    }
  };

  const toggleServe = async () => {
    if (serving) return;
    setServing(true);
    try {
      const sel = servePort ?? project?.serve?.port ?? project?.ports?.[0];
      if (project?.serve?.enabled) {
        const r = await stopServe(slug);
        setServePort(r.serve.port);
      } else {
        const r = await startServe(slug, sel);
        setServePort(r.serve.port);
      }
      onChanged();
    } catch (err: any) {
      onError(err.message);
    } finally {
      setServing(false);
    }
  };

  // The backend serve.url embeds `localhost` — rebuild it from the real browser hostname so remote
  // deployments link the viewer's own host (hostPort is the published binding, port the fallback).
  const serveUrl = project?.serve?.active
    ? `http://${window.location.hostname}:${project.serve.hostPort ?? project.serve.port ?? ''}`
    : '';

  const copyServeUrl = async () => {
    if (!serveUrl) return;
    await copy(serveUrl);
    setServeCopied(true);
    setTimeout(() => setServeCopied(false), 2000);
  };

  const saveLimits = async () => {
    if (savingLimits) return;
    const limits = {
      cpu: cpuText.trim() || null,
      memory: memText.trim() || null,
    };
    setSavingLimits(true);
    setLimitsMsg(null);
    try {
      const r = await setProjectLimits(slug, limits);
      setLimitsMsg(
        r.needsRecreate
          ? t('cfg.limitsSavedRecreate')
          : limits.cpu || limits.memory
            ? t('cfg.limitsSaved')
            : t('cfg.limitsSavedRemoved'),
      );
      onChanged();
    } catch (err: any) {
      setLimitsMsg(t('files.saveFail', { error: err.message }));
    } finally {
      setSavingLimits(false);
    }
  };

  const saveTags = async () => {
    if (savingTags) return;
    setSavingTags(true);
    setTagsMsg(null);
    try {
      await updateProjectTags(slug, currentTags);
      setTagsMsg(t('files.savedOk'));
      setTimeout(() => setTagsMsg(null), 4000);
      tagsDirtyRef.current = false;
      setEditingTags(false);
      onChanged();
    } catch (err: any) {
      setTagsMsg(t('files.saveFail', { error: err.message }));
    } finally {
      setSavingTags(false);
    }
  };

  const addTag = (raw: string) => {
    const val = raw.trim().slice(0, 30);
    if (!val) {
      setTagInput('');
      return;
    }
    if (currentTags.some((t) => t.toLowerCase() === val.toLowerCase())) {
      setTagInput('');
      return;
    }
    if (currentTags.length >= 20) {
      setTagsMsg(t('cfg.maxTags'));
      setTimeout(() => setTagsMsg(null), 3000);
      return;
    }
    tagsDirtyRef.current = true;
    setCurrentTags([...currentTags, val]);
    setTagInput('');
  };

  const handleTagKeyDown = (e: any) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
      e.preventDefault();
      addTag(tagInput);
    } else if (e.key === 'Backspace' && tagInput === '' && currentTags.length > 0) {
      removeTag(currentTags[currentTags.length - 1]);
    }
  };

  const removeTag = (tag: string) => {
    tagsDirtyRef.current = true;
    setCurrentTags(currentTags.filter((t) => t !== tag));
    tagInputRef.current?.focus();
  };

  const doRecreate = async () => {
    setRecreating(true);
    try {
      await recreateProject(slug);
      onChanged();
    } catch (err: any) {
      onError(err.message);
    } finally {
      setRecreating(false);
      setConfirmRecreate(false);
    }
  };

  const requestRecreate = () => {
    if (recreating) return;
    setConfirmRecreate(true);
  };

  const doDelete = async () => {
    if (confirmText !== slug) return;
    setDeleting(true);
    try {
      await deleteProject(slug);
      setLocation('/');
    } catch (err: any) {
      onError(err.message);
      setDeleting(false);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard unavailable */
    }
  };

  const copyPortUrl = async (url: string, priv: string) => {
    await copy(url);
    setCopiedPort(priv);
    setTimeout(() => setCopiedPort((p) => (p === priv ? null : p)), 2000);
  };

  const host = window.location.hostname;

  const msgRole = (m: string | null): 'alert' | 'status' | undefined =>
    // Localized failure copy starts with the fail/error prefix in both langs
    // (فشل/خطأ/منافذ غير صالحة/لا توجد/تعذّر) — match either language.
    m && /^(Failed|No valid|Invalid|Save failed|Clone failed|Error|In use|Ports already|فشل|خطأ|تعذّر|منافذ غير صالحة|لا توجد)/i.test(m) ? 'alert' : m ? 'status' : undefined;

  return (
    <div class="overview-stack overview">
      {/* ── At a glance ── */}
      <div class="glance-strip" role="group" aria-label={t('project.glanceLabel')}>
        <div class="glance-item">
          <span class="glance-k">{t('project.status')}</span>
          <span class="glance-v">
            <span class={`glance-dot ${project?.status || 'unknown'}`} />
            {t(`status.${project?.status || 'unknown'}`)}
            {effectiveStats?.running ? ` · ${t('project.up')} ${fmtUptime(effectiveStats.startedAt)}` : ''}
          </span>
        </div>
        <div class="glance-item">
          <span class="glance-k">{t('project.ports')}</span>
          <span class="glance-v mono">{project?.ports?.length ? project.ports.join(', ') : t('project.none')}</span>
        </div>
        {effectiveStats?.running && (
          <div class="glance-item">
            <span class="glance-k">CPU</span>
            <span class="glance-v">{effectiveStats.cpuPct}%</span>
          </div>
        )}
        {effectiveStats?.running && (
          <div class="glance-item">
            <span class="glance-k">{t('project.memory')}</span>
            <span class="glance-v">{fmtBytes(effectiveStats.memBytes)} / {fmtBytes(effectiveStats.memLimit)}</span>
          </div>
        )}
        <div class="glance-item">
          <span class="glance-k">{t('project.staticSite')}</span>
          <span class="glance-v">
            {project?.serve?.active
              ? <span class="glance-serve on">{t('project.live')} · :{project.serve.port}</span>
              : project?.serve?.enabled
                ? t('project.serveConfiguredShort')
                : t('project.siteOff')}
          </span>
        </div>
      </div>

      {/* ── Quick-nav ── */}
        <nav class="ov-nav" aria-label={t('misc.a11yOverviewNav')}>
          <button type="button" class={`ov-nav-btn${activeSec === 'ov-links' ? ' active' : ''}`} onClick={() => setActiveSec('ov-links')}>
            {t('project.secLinks')}
          </button>
          <button type="button" class={`ov-nav-btn${activeSec === 'ov-info' ? ' active' : ''}`} onClick={() => setActiveSec('ov-info')}>
            {t('project.secInfo')}
          </button>
          <button type="button" class={`ov-nav-btn${activeSec === 'ov-config' ? ' active' : ''}`} onClick={() => setActiveSec('ov-config')}>
            {t('project.secConfig')}
          </button>
          <button type="button" class={`ov-nav-btn${activeSec === 'ov-ctx' ? ' active' : ''}`} onClick={() => setActiveSec('ov-ctx')}>
            {t('project.secCtx')}
          </button>
          <button type="button" class={`ov-nav-btn${activeSec === 'ov-runtime' ? ' active' : ''}`} onClick={() => setActiveSec('ov-runtime')}>
            {t('project.secRuntime')}
          </button>
          <button type="button" class={`ov-nav-btn${activeSec === 'ov-activity' ? ' active' : ''}`} onClick={() => setActiveSec('ov-activity')}>
            {t('project.secActivity')}
          </button>
        </nav>

      {/* ── Links & health ── */}
      {activeSec === 'ov-links' && (
      <div class="panel" id="ov-links">
        <h2 class="panel-title" style="display:flex;align-items:center;justify-content:space-between">
          <span>{t('project.secLinks')}</span>
          {checks && checks.length > 0 && (
            <span class="health-summary">
              {checks.filter((k) => k.status === 'open').length}/{checks.length} {t('project.open')}
            </span>
          )}
        </h2>
        {project?.ports && project.ports.length > 0 ? (
          <>
            {(() => {
              const hostEntries = Object.entries(project.hostPorts || {});
              return hostEntries.length > 0 ? (
                <div class="port-grid">
                  {hostEntries.map(([priv, pub]) => {
                    const served = project.serve?.active && project.serve.hostPort && Number(project.serve.port) === Number(priv);
                    const url = served ? `http://${host}:${project.serve!.hostPort}` : `http://${host}:${pub}`;
                    const check = checks?.find((c) => c.port === priv);
                    const copied = copiedPort === priv;
                    return (
                      <div key={priv} class={`port-link-row${served ? ' served' : ''}`}>
                        <a class="port-link" href={url} target="_blank" rel="noreferrer">
                          <span class="p-label">{served ? t('project.servedSite') : `${t('project.port')} ${priv}`}</span>
                          <span class="p-val">{host}:{served ? project.serve?.hostPort : pub}</span>
                        </a>
                        {served && <span class="served-badge"><Globe width={11} height={11} class="icon" /> {t('project.live')}</span>}
                        {check && (
                          <span class={`health-chip ${check.status}`}>
                            {check.status === 'open' ? `HTTP ${check.httpCode} · ${check.ms}ms` : check.status}
                          </span>
                        )}
                        <button class="btn-ghost sm icon-only" aria-label={t('project.copyUrlFor', { port: priv })} title={t('project.copy')} onClick={() => copyPortUrl(url, priv)}>
                          {copied ? <Check width={12} height={12} class="icon" /> : <Copy width={12} height={12} class="icon" />}
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div class="empty-state" style="padding: 16px">
                  {project.hostPorts ? t('project.checkingBindings') : t('project.noBindings')}
                </div>
              );
            })()}

            {/* Published ports editing (moved into Links & health) */}
            <div class="ov-section" style="margin-top: 14px">
              <div class="ov-row-actions" style="align-items:center;gap:8px">
                <span class="ov-section-label" style="margin:0">{t('project.publishedPorts')}</span>
                {!readOnly && !editPortsOpen && (
                  <button class="btn-ghost sm" onClick={() => setEditPortsOpen(true)}>{t('project.edit')}</button>
                )}
              </div>
              {editPortsOpen ? (
                <>
                  <div class="ov-field" style="margin-top:8px">
                    <input
                      class="modern-input mono"
                      style="flex:1"
                      aria-label={t('project.publishedPorts')}
                      aria-describedby="portsFormatHint"
                      placeholder={t('cfg.portsPlaceholder')}
                      value={portsText}
                      ref={portsInputRef}
                      onInput={(e: any) => setPortsText(e.target.value)}
                      onKeyDown={(e: any) => e.key === 'Enter' && savePorts()}
                    />
                    <span class="sr-only" id="portsFormatHint">{t('cfg.portsFormatHint')}</span>
                  </div>
                  <div class="ov-row-actions" style="margin-top:8px">
                    <button class="btn-ghost sm" onClick={savePorts} disabled={savingPorts}>
                      {savingPorts ? t('project.saving') : t('project.savePorts')}
                    </button>
                    <button class="btn-ghost sm" onClick={() => { setEditPortsOpen(false); setPortsText((project?.ports || []).join(', ')); }}>{t('common.cancel')}</button>
                    {portsMsg && <span class="dim" style="color: var(--text-3)" role={msgRole(portsMsg)}>{portsMsg}</span>}
                  </div>
                </>
              ) : (
                !readOnly && (
                  <div class="ov-value">
                    {project?.ports && project.ports.length > 0 ? project.ports.join(', ') : <span class="ov-value-empty">{t('project.noPublishedPorts')}</span>}
                  </div>
                )
              )}
            </div>

            {/* Tags (moved into Links & health) */}
            <div class="ov-section" style="margin-top: 14px">
              <div class="ov-row-actions" style="align-items:center;gap:8px">
                <span class="ov-section-label" style="margin:0">{t('project.tags')}</span>
                {!readOnly && !editingTags && (
                  <button class="btn-ghost sm" onClick={() => setEditingTags(true)}>
                    {currentTags.length > 0 ? t('project.edit') : t('project.add')}
                  </button>
                )}
              </div>
              <div class="tag-editor">
                {currentTags.map((t) => (
                  <span class="tag-chip" key={t}>
                    {t}
                    {!readOnly && editingTags && (
                      <button type="button" class="tag-remove" aria-label={`Remove tag ${t}`} onClick={() => removeTag(t)}>×</button>
                    )}
                  </span>
                ))}
                {!readOnly && editingTags && (
                  <input
                    class="tag-input"
                    placeholder={t('project.addTag')}
                    maxLength={30}
                    value={tagInput}
                    aria-label={t('project.addTag')}
                    ref={tagInputRef}
                    onInput={(e: any) => setTagInput(e.target.value)}
                    onKeyDown={handleTagKeyDown}
                  />
                )}
              </div>
              {!readOnly && editingTags ? (
                <div class="ov-row-actions" style="margin-top:8px">
                  <button class="btn-ghost sm" onClick={saveTags} disabled={savingTags}>
                    {savingTags ? t('project.saving') : t('project.saveTags')}
                  </button>
                  <button class="btn-ghost sm" onClick={() => { setEditingTags(false); setCurrentTags(project?.tags ? [...project.tags] : []); }}>{t('common.cancel')}</button>
                  <span class="dim">{t('project.enterToAdd', { n: currentTags.length })}</span>
                  {tagsMsg && <span class="dim" role={msgRole(tagsMsg)}>{tagsMsg}</span>}
                </div>
              ) : (
                (readOnly || currentTags.length === 0) && (
                  <div class="ov-value" style="margin-top:4px">
                    {currentTags.length > 0
                      ? currentTags.join(' · ')
                      : <span class="ov-value-empty">{t('project.noTags')} {readOnly ? '' : t('project.noTagsHint')}</span>}
                  </div>
                )
              )}
            </div>

            {project && project.ports && project.ports.length > 0 && (
              <div class="serve-box" style="margin-top: 16px">
                <div class="serve-head">
                  <span class="serve-label">
                    <span class={`serve-dot ${project.serve?.active ? 'on' : project.serve?.enabled && project.serve?.error ? 'err' : ''}`} />
                    {t('project.staticSite')}
                  </span>
                  {!readOnly && (
                    <>
                      <select
                        class="modern-input mono"
                        style="max-width:110px"
                        aria-label={t('project.staticSite')}
                        value={project.serve?.enabled ? project.serve.port : servePort ?? project.serve?.port ?? project.ports[0]}
                        disabled={project.serve?.enabled || project.status !== 'running'}
                        title={project.serve?.enabled ? t('project.portFixedWhileServing') : t('project.pickServePort')}
                        onChange={(e: any) => setServePort(Number(e.target.value))}
                      >
                        {project.ports.map((p) => (
                          <option key={p} value={p}>:{p}</option>
                        ))}
                      </select>
                      <button
                        class="btn-primary sm serve-toggle"
                        onClick={toggleServe}
                        disabled={serving || project.status !== 'running'}
                      >
                        {serving ? (
                          <Loader2 width={12} height={12} class="icon spin" />
                        ) : project.serve?.enabled ? (
                          t('project.stopServer')
                        ) : (
                          t('project.startServer')
                        )}
                      </button>
                      {project.serve?.enabled && (
                        <button class="btn-ghost sm" title={t('project.copyUrlFor', { port: project.serve?.port ?? '' })} onClick={copyServeUrl}>
                          <Copy width={12} height={12} class="icon" />{serveCopied ? t('project.copied') : t('project.copy')}
                        </button>
                      )}
                    </>
                  )}
                </div>
                {project.serve?.enabled && (
                  <div class="serve-status" aria-live="polite">
                    {project.serve?.active ? (
                      <span class="serve-msg ok">{t('project.servingOn', { port: project.serve.port ?? 0 })}</span>
                    ) : project.serve?.error ? (
                      <span class="serve-msg err">{t('project.serveError', { error: project.serve.error })}</span>
                    ) : (
                      <span class="serve-msg">{t('project.serveConfigured')}</span>
                    )}
                  </div>
                )}
                {project.serve?.active && serveUrl && (
                  <div class="serve-url-row">
                    <a class="port-link" style="flex:1; min-width:0" href={serveUrl} target="_blank" rel="noreferrer">
                      <span class="p-val">{serveUrl}</span>
                    </a>
                  </div>
                )}
                {project.status !== 'running' && !project.serve?.enabled && (
                  <div class="ov-section-desc" style="margin-top: 8px">{t('project.serveNeedsStart')}</div>
                )}
              </div>
            )}
          </>
        ) : (
          <div class="empty-state" style="padding: 16px">{t('project.noPublishedPortsHint')}</div>
        )}
      </div>
      )}

      {/* ── Project info ── */}
      {activeSec === 'ov-info' && (
      <div class="panel" id="ov-info">
        <h2 class="panel-title">{t('project.secInfo')}</h2>
          <div class="kv-list">
            <div class="kv">
              <span>{t('project.description')}</span>
              <div style="display:flex; gap:8px; align-items:flex-start; justify-content:flex-end; flex:1">
                {editDesc ? (
                  <>
                    <textarea
                      class="modern-input"
                      style="flex:1; resize:vertical; min-height:48px"
                      rows={3}
                      aria-label={t('project.description')}
                      value={descText}
                      onInput={(e: any) => setDescText(e.target.value)}
                      onKeyDown={(e: any) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') saveDescription(); if (e.key === 'Escape') { setEditDesc(false); setDescText(project?.description || ''); } }}
                    />
                    <div style="display:flex; gap:6px">
                      <button class="btn-primary sm" onClick={saveDescription}>{t('common.save')}</button>
                    </div>
                  </>
                ) : (
                  <>
                    <span style="text-align:right">{project?.description || '—'}</span>
                    <button class="btn-ghost sm" onClick={() => { setDescText(project?.description || ''); setEditDesc(true); }}>{t('project.edit')}</button>
                  </>
                )}
              </div>
            </div>
            <div class="kv">
              <span>{t('project.image')}</span>
              <b>{project?.image || 'wsd/workspace:latest'}</b>
            </div>
            <div class="kv">
              <span>{t('project.containerId')}</span>
              <div style="display:flex; gap:8px; align-items:center">
                <b class="mono">{project?.containerId ? project.containerId.slice(0, 12) : '—'}</b>
                {project?.containerId && (
                  <button class="btn-ghost sm" onClick={() => copy(project.containerId!)}>{t('project.copy')}</button>
                )}
              </div>
            </div>
                <div class="kv">
                  <span>{t('project.created')}</span>
                  <b>{project?.createdAt ? fmtTime(project.createdAt) : '—'}</b>
                </div>
                <div class="kv">
                  <span>{t('project.uptime')}</span>
                  <b>{effectiveStats?.running ? fmtUptime(effectiveStats.startedAt) : project?.status === 'running' ? '…' : t('project.stoppedLower')}</b>
                </div>
                </div>
        </div>
        )}

        {/* ── Runtime ── */}
        {activeSec === 'ov-runtime' && (
        <div class="panel" id="ov-runtime">
          <h2 class="panel-title">{t('project.runtime')}</h2>
          {effectiveStats?.running ? (
            <div class="ov-stat-grid">
              <div class="ov-stat">
                <div class="ov-stat-label">CPU</div>
                <div class="ov-stat-value" aria-live="polite">{effectiveStats.cpuPct}%</div>
                <div class="stat-bar" style="margin-top:8px"><div class="stat-fill" style={`width: ${Math.min(100, effectiveStats.cpuPct)}%`} /></div>
              </div>
              <div class="ov-stat">
                <div class="ov-stat-label">{t('project.memory')}</div>
                <div class="ov-stat-value" aria-live="polite">{fmtBytes(effectiveStats.memBytes)}</div>
                <div class="ov-stat-sub">{t('project.of')} {fmtBytes(effectiveStats.memLimit)} · {effectiveStats.memPct}%</div>
                <div class="stat-bar" style="margin-top:8px"><div class="stat-fill" style={`width: ${Math.min(100, effectiveStats.memPct)}%`} /></div>
              </div>
            </div>
          ) : (
            <div class="empty-state" style="padding: 24px">{t('project.projectIs', { status: t(`status.${project?.status || 'unknown'}`) })} {t('project.startToSeeRuntime')}</div>
          )}

          </div>
        )}

        {/* ── AI context ── */}
        {activeSec === 'ov-ctx' && (
          <div class="panel" id="ov-ctx">
          <h2 class="panel-title">{t('project.aiContext')}</h2>
          <div class="kv-list">
            <div class="kv">
              <span>{t('project.index')}</span>
              <b>
                {ctx?.indexStats
                  ? t('project.filesChunks', { files: ctx.indexStats.files, chunks: ctx.indexStats.chunks })
                  : t('project.building')}
              </b>
            </div>
            <div class="kv">
              <span>{t('project.budget')}</span>
              <b>~24 KB</b>
            </div>
          </div>
          <div class="kv" style="gap:10px; margin-top:10px">
            <button class="btn-ghost sm" onClick={() => setCtxOpen(!ctxOpen)}>{ctxOpen ? t('project.hidePreview') : t('project.preview')}</button>
          </div>
          {ctxOpen && (
            <div class="ctx-preview mono scrollbar" style="margin-top:10px">{ctx?.text || t('project.loadingContext')}</div>
          )}
        </div>
        )}

        {/* ── Configuration ── */}
        {activeSec === 'ov-config' && (
        <div class="panel" id="ov-config">
          <h2 class="panel-title">{t('project.secConfig')}</h2>

          <div class="ov-section">
            <h3 class="ov-section-label">{t('project.cloneFromGit')}</h3>
            <div class="ov-section-desc">{t('project.cloneDesc')}</div>
            {readOnly ? (
              <div class="ov-value ov-value-empty">{t('project.viewerReadOnly')}</div>
            ) : (
              <div class="ov-field">
                <input
                  class="modern-input"
                  style="flex:1"
                  aria-label={t('project.cloneFromGit')}
                  placeholder="https://github.com/org/repo.git"
                  value={cloneUrl}
                  onInput={(e: any) => setCloneUrl(e.target.value)}
                  onKeyDown={(e: any) => e.key === 'Enter' && doClone()}
                />
                <button class="btn-primary sm" onClick={doClone} disabled={cloning || !cloneUrl.trim()}>
                  {cloning ? t('project.cloning') : t('project.clone')}
                </button>
              </div>
            )}
            {cloneMsg && <div class="terminal-line">{cloneMsg}</div>}
          </div>

          <div class="ov-section">
            <h3 class="ov-section-label">{t('project.envVars')}</h3>
            {editSection === 'env' ? (
              <>
                <textarea
                  class="modern-input mono"
                  style="width:100%; resize:vertical; min-height:96px"
                  placeholder={t('cfg.envPlaceholder')}
                  value={envText}
                  aria-label={t('project.envVars')}
                  aria-describedby="envFormatHint"
                  ref={envInputRef}
                  onInput={(e: any) => { envDirtyRef.current = true; setEnvText(e.target.value); }}
                />
                <span class="sr-only" id="envFormatHint">{t('cfg.envFormatHint')}</span>
                <div class="ov-row-actions">
                  <button class="btn-primary sm" onClick={saveEnv}>{t('project.saveEnv')}</button>
                  <button class="btn-ghost sm" onClick={() => {
                    envDirtyRef.current = false;
                    setEnvText(Object.entries(envVars || {}).map(([k, v]) => `${k}=${v}`).join('\n'));
                    setEditSection(null);
                  }}>{t('common.cancel')}</button>
                  {envMsg && <span class="dim" style="color: var(--text-3)" role={msgRole(envMsg)}>{envMsg}</span>}
                </div>
              </>
            ) : (
              <>
                {Object.keys(envVars || {}).length > 0 ? (
                  <div class="ov-env-view">
                    {Object.entries(envVars || {}).map(([k, v]) => (
                      <span class="ov-env-chip" key={k}>{k}={v}</span>
                    ))}
                  </div>
                ) : (
                  <div class="ov-value ov-value-empty">{t('project.noEnvVars')}</div>
                )}
                <div class="ov-row-actions">
                  {!readOnly && <button class="btn-ghost sm" onClick={() => setEditSection('env')}>{t('project.edit')}</button>}
                </div>
              </>
            )}
          </div>

          <div class="ov-section">
            <h3 class="ov-section-label">{t('cfg.limits')}</h3>
            {editSection === 'limits' ? (
              <>
                <div class="ov-field">
                  <input
                    class="modern-input mono"
                    style="flex:1; min-width:120px"
                    aria-label={t('cfg.cpuLimit')}
                    placeholder={t('cfg.cpuPlaceholder')}
                    value={cpuText}
                    ref={cpuInputRef}
                    onInput={(e: any) => setCpuText(e.target.value)}
                    onKeyDown={(e: any) => e.key === 'Enter' && saveLimits()}
                  />
                  <input
                    class="modern-input mono"
                    style="flex:1; min-width:120px"
                    aria-label={t('cfg.memLimit')}
                    placeholder={t('cfg.memPlaceholder')}
                    value={memText}
                    ref={memInputRef}
                    onInput={(e: any) => setMemText(e.target.value)}
                    onKeyDown={(e: any) => e.key === 'Enter' && saveLimits()}
                  />
                </div>
                <div class="ov-row-actions">
                  <button class="btn-ghost sm" onClick={saveLimits} disabled={savingLimits}>
                    {savingLimits ? t('project.saving') : t('cfg.saveLimits')}
                  </button>
                  <button class="btn-ghost sm" onClick={() => setEditSection(null)}>{t('common.cancel')}</button>
                  {!limitsPending(project) && limitsMsg && <span class="dim" style="color: var(--text-3)" role={msgRole(limitsMsg)}>{limitsMsg}</span>}
                </div>
              </>
            ) : (
              <>
                <div class="ov-value">
                  {project?.limits?.cpu || project?.limits?.memory
                    ? `${project.limits.cpu ? `${t('cfg.cpu')} ${project.limits.cpu}` : t('cfg.noCpu')}${project.limits.memory ? ` · ${t('cfg.ram')} ${fmtMem(project.limits.memory)}` : ` · ${t('cfg.noMem')}`}`
                    : <span class="ov-value-empty">{t('cfg.noLimits')}</span>}
                </div>
                {limitsPending(project) && (
                  <div class="ov-pending">
                    <Loader2 width={13} height={13} class="icon spin" />
                    {t('cfg.pendingLine', {
                      current: `${fmtCpu(project?.liveLimits?.cpu) || t('cfg.noCpu')}${project?.liveLimits?.memory ? ` / ${fmtMem(project.liveLimits.memory)}` : ` / ${t('cfg.noMemLimit')}`}`,
                    })}
                  </div>
                )}
                <div class="ov-row-actions">
                  {!readOnly && <button class="btn-ghost sm" onClick={() => setEditSection('limits')}>{t('project.edit')}</button>}
                </div>
              </>
            )}
          </div>

          <div class="ov-section">
            <h3 class="ov-section-label">{t('cfg.containerActions')}</h3>
            <div class="ov-row-actions">
              <button class="btn-ghost sm" onClick={requestRecreate} disabled={recreating}>
                {recreating ? t('cfg.recreating') : t('cfg.recreate')}
              </button>
              {envMsg && <span class="dim" style="color: var(--text-3)" role={msgRole(envMsg)}>{envMsg}</span>}
            </div>
          </div>
        </div>
        )}

        {/* ── Activity ── */}
        {activeSec === 'ov-activity' && (
        <div class="panel" id="ov-activity">
          <h2 class="panel-title">{t('misc.activityTitle')}</h2>
          {project?.activity && project.activity.length > 0 ? (
            <ul class="activity-list">
              {project.activity.slice().reverse().slice(0, 15).map((a, i) => (
                <li class="activity-row" key={i}>
                  <span class="activity-dot-wrap">
                    <span class={`activity-dot ${a.action}`} />
                    <span class="activity-act">{fmtAction(a.action)}</span>
                  </span>
                  <time class="activity-at" datetime={a.at} aria-label={new Date(a.at).toLocaleString()}>{t('act.ago', { t: relTime(a.at) })}</time>
                </li>
              ))}
            </ul>
          ) : (
            <div class="empty-state" style="padding: 24px">{t('act.emptyFeed')}</div>
          )}
        </div>
        )}

        {/* ── Danger zone ── */}
        <div class="panel danger-zone" id="ov-danger">
          <h2 class="panel-title" style="color: var(--red)">{t('cfg.dangerTitle')}</h2>
        <div class="danger-desc">
          <TriangleAlert width={14} height={14} class="icon" />
          <span>{t('cfg.dangerDesc')}</span>
        </div>
        {readOnly ? (
          <div class="ov-value ov-value-empty">{t('cfg.viewerDelete')}</div>
        ) : (
          <div class="danger-confirm">
            <input
              class="modern-input"
              aria-label={t('cfg.typeSlugAria', { slug })}
              placeholder={t('cfg.typeSlug', { slug })}
              value={confirmText}
              onInput={(e: any) => setConfirmText(e.target.value)}
            />
            <button class="btn-danger sm" onClick={doDelete} disabled={confirmText !== slug || deleting}>
              {deleting ? <Loader2 width={12} height={12} class="icon spin" /> : null}
              {deleting ? t('cfg.deleting') : t('cfg.deleteProject')}
            </button>
          </div>
        )}
        </div>

      <ConfirmModal
        open={confirmRecreate}
        danger
        loading={recreating}
        title={t('cfg.recreateTitle', { slug })}
        message={t('cfg.recreateMessage')}
        confirmLabel={t('cfg.recreateConfirm')}
        onConfirm={doRecreate}
        onCancel={() => { if (!recreating) setConfirmRecreate(false); }}
      />
    </div>
  );
}

// ── Files ─────────────────────────────────────────────────────
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'tif', 'tiff']);
const isImagePath = (p: string) => {
  const ext = p.toLowerCase().split('.').pop() || '';
  return IMAGE_EXTS.has(ext);
};

/** Professional type icon for a file/dir name: folder / image / code / json / archive / text / plain. */
function fileTypeMeta(name: string, type: 'file' | 'dir'): { Icon: any; color: string } {
  if (type === 'dir') return { Icon: Folder, color: 'var(--blue)' };
  const ext = (name.toLowerCase().split('.').pop() || '').trim();
  if (IMAGE_EXTS.has(ext)) return { Icon: FileImage, color: '#a78bfa' };
  if (ext === 'json' || ext === 'jsonc' || ext === 'yaml' || ext === 'yml' || ext === 'toml') return { Icon: FileJson, color: '#eab308' };
  if (['zip', 'gz', 'tar', 'tgz', 'rar', '7z', 'bz2', 'xz'].includes(ext)) return { Icon: FileArchive, color: '#fb923c' };
  if (['js', 'jsx', 'ts', 'tsx', 'py', 'rb', 'go', 'rs', 'c', 'cpp', 'h', 'hpp', 'java', 'cs', 'php', 'sh', 'bash', 'sql', 'html', 'css', 'scss', 'vue', 'svelte', 'astro', 'swift', 'kt', 'wasm'].includes(ext)) return { Icon: FileCode, color: '#38bdf8' };
  if (['md', 'markdown', 'txt', 'log', 'csv', 'yml', 'rst', 'rtf'].includes(ext)) return { Icon: FileText, color: '#4ade80' };
  return { Icon: FileText, color: 'var(--text-3)' };
}

function FilesPanel({ slug, readOnly }: { slug: string; readOnly?: boolean }) {
  const { t } = useI18n();
  const [cwd, setCwd] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [meta, setMeta] = useState<{ fileCount: number; totalBytes: number; truncated?: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [previewName, setPreviewName] = useState('');
  const [editContent, setEditContent] = useState<string | null>(null);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [imgLoading, setImgLoading] = useState(false);
  const [savingFile, setSavingFile] = useState(false);
  const [fileMsg, setFileMsg] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  const [confirmDeleteFile, setConfirmDeleteFile] = useState<string | null>(null);
  const [showNewFile, setShowNewFile] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);
  const loadSeqRef = useRef(0);
  const newFileInputRef = useRef<HTMLInputElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  const imgUrlRef = useRef<string | null>(null);
  const setImgUrlSafe = (url: string | null) => {
    if (imgUrlRef.current && imgUrlRef.current !== url) URL.revokeObjectURL(imgUrlRef.current);
    imgUrlRef.current = url;
    setImgUrl(url);
  };

  useEffect(() => () => {
    if (imgUrlRef.current) URL.revokeObjectURL(imgUrlRef.current);
  }, []);
  useEffect(() => {
    if (showNewFile && newFileInputRef.current) newFileInputRef.current.focus();
  }, [showNewFile]);

  useEffect(() => {
    if (renaming && renameInputRef.current) renameInputRef.current.focus();
  }, [renaming]);

  const popupCloseRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!preview) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    popupCloseRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePreview();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [preview]);

  const load = async (dir: string) => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setError(null);
    try {
      const l = await listProjectFiles(slug, dir || undefined);
      if (seq !== loadSeqRef.current) return;
      setEntries(l.entries);
      setMeta({ fileCount: l.fileCount, totalBytes: l.totalBytes, truncated: l.truncated });
    } catch (err: any) {
      if (seq !== loadSeqRef.current) return;
      setError(err.message);
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    load(cwd);
  }, [cwd, slug]);

  const crumbs = cwd ? cwd.split('/') : [];

  const openFile = async (name: string) => {
    const p = cwd ? `${cwd}/${name}` : name;
    try {
      const fp = await getProjectFile(slug, p);
      setPreview(fp);
      setPreviewName(p);
      // P0 fix: never open a truncated preview for editing — saving it would
      // overwrite the whole file with ~200KB of cut-off text + the truncation
      // marker. Truncated files stay read-only.
      setEditContent(fp.binary || fp.truncated ? null : fp.content);
      setFileMsg(null);
      setImgUrlSafe(null);
      if (fp.binary && isImagePath(p)) {
        setImgLoading(true);
        try {
          const blob = await fetchProjectFileRaw(slug, p);
          setImgUrlSafe(URL.createObjectURL(blob));
        } catch (err: any) {
          setFileMsg(t('files.imgLoadFail', { error: err.message }));
        } finally {
          setImgLoading(false);
        }
      }
    } catch (err: any) {
      setError(err.message);
    }
  };

  const downloadFile = async (name: string) => {
    const p = cwd ? `${cwd}/${name}` : name;
    try {
      const blob = await fetchProjectFileRaw(slug, p, true);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = p.split('/').pop() || 'download';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const closePreview = () => {
    setImgUrlSafe(null);
    setPreview(null);
    setPreviewName('');
    setEditContent(null);
    setFileMsg(null);
  };

  const saveFile = async () => {
    if (!preview || editContent === null) return;
    setSavingFile(true);
    setFileMsg(null);
    try {
      await saveProjectFile(slug, previewName, editContent);
      setFileMsg(t('files.savedOk'));
      setTimeout(() => setFileMsg(null), 4000);
    } catch (err: any) {
      setFileMsg(t('files.saveFail', { error: err.message }));
    } finally {
      setSavingFile(false);
    }
  };

  const newFile = () => setShowNewFile(true);

  const submitNewFile = () => {
    const clean = newFileName.trim().replace(/^\/+/, '');
    if (!clean) return;
    setPreview({ content: '', truncated: false, size: 0, binary: false });
    setPreviewName(cwd ? `${cwd}/${clean}` : clean);
    setEditContent('');
    setFileMsg(null);
    setNewFileName('');
    setShowNewFile(false);
  };

  const startRename = (name: string) => {
    setRenaming(name);
    setRenameValue(name);
  };

  const doRename = async (name: string) => {
    const nn = renameValue.trim();
    setRenaming(null);
    setRenameValue('');
    if (!nn || nn === name) return;
    const p = cwd ? `${cwd}/${name}` : name;
    const to = cwd ? `${cwd}/${nn.replace(/^\/+/, '')}` : nn.replace(/^\/+/, '');
    try {
      await renameProjectPath(slug, p, to);
      if (previewName === p) setPreviewName(to);
      load(cwd);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const remove = async (name: string) => {
    setConfirmDeleteFile(name);
  };

  const runRemoveFile = async () => {
    const name = confirmDeleteFile;
    if (!name) return;
    const p = cwd ? `${cwd}/${name}` : name;
    setConfirmDeleteFile(null);
    try {
      await deleteProjectFile(slug, p);
      if (previewName === p) {
        setPreview(null);
        setPreviewName('');
        setEditContent(null);
        setFileMsg(null);
      }
      load(cwd);
    } catch (err: any) {
      setError(err.message);
    }
  };

  const doUpload = async (files: File[]) => {
    if (files.length === 0) return;
    setUploading(true);
    setUploadMsg(null);
    try {
      const { files: saved } = await uploadFiles(slug, files, cwd || undefined);
      setUploadMsg(cwd ? t('files.uploaded', { n: saved.length, dir: cwd }) : t('files.uploadedRoot', { n: saved.length }));
      load(cwd);
    } catch (err: any) {
      setUploadMsg(t('files.uploadFail', { error: err.message }));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div class="files-panel">
      <h2 class="panel-title">{t('files.title')}</h2>
      <div class="files-toolbar">
        <div class="files-path">
          <button class="btn-ghost sm" onClick={() => setCwd('')} disabled={!cwd}>{t('files.root')}</button>
          {crumbs.map((c, i) => (
            <span key={i} class="files-crumb">
              <span class="dim">/</span>
              <button
                class="btn-ghost sm"
                aria-current={i === crumbs.length - 1 ? 'location' : undefined}
                onClick={() => setCwd(crumbs.slice(0, i + 1).join('/'))}
              >{c}</button>
            </span>
          ))}
        </div>
        <div style="display:flex; gap:10px; align-items:center; flex-direction:row-reverse;">
          {meta && (
            <span class="dim" style="color: var(--text-3); font-size:0.72rem">
              {t('files.filesSize', { n: meta.fileCount, size: fmtBytes(meta.totalBytes) })}
              {meta.truncated && <span title={t('files.listCappedTitle')}> · {t('files.listCapped')}</span>}
            </span>
          )}
          <input
            ref={fileRef}
            type="file"
            multiple
            style="display:none"
            onChange={(e: any) => doUpload(Array.from(e.target.files || []))}
          />
          <button class="btn-ghost sm" onClick={newFile} aria-expanded={showNewFile}>{t('files.newFile')}</button>
          <button class="btn-primary sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
            {uploading ? t('files.uploading') : cwd ? t('files.uploadTo', { dir: cwd }) : t('files.upload')}
          </button>
        </div>
      </div>
      {showNewFile && (
        <div class="files-newfile-row">
          <input
            class="modern-input compact"
            ref={newFileInputRef}
            placeholder={t('files.newFilePath')}
            aria-label={t('files.newFilePathAria')}
            value={newFileName}
            onInput={(e: any) => setNewFileName(e.target.value)}
            onKeyDown={(e: any) => {
              if (e.key === 'Enter') submitNewFile();
              else if (e.key === 'Escape') { setShowNewFile(false); setNewFileName(''); }
            }}
          />
          <button class="btn-primary sm" onClick={submitNewFile} disabled={!newFileName.trim()}>{t('files.create')}</button>
          <button class="btn-ghost sm" onClick={() => { setShowNewFile(false); setNewFileName(''); }}>{t('common.cancel')}</button>
        </div>
      )}
      {uploadMsg && (
        <div
          class="terminal-line"
          style="margin: 8px 0"
          role={uploadMsg.startsWith('Upload failed') ? 'alert' : 'status'}
        >{uploadMsg}</div>
      )}
      {error && <div class="login-error" role="alert" style="margin: 8px 0">{error}</div>}

      <div class="file-list" aria-busy={loading}>
        {loading && entries.length === 0 && (
          <div class="panel-muted" role="status">{t('files.loadingFiles')}</div>
        )}
        {entries.length === 0 && !loading && (
          <div class="empty-state" role="status" style="padding: 32px">{cwd ? t('files.emptyDir') : t('files.emptyWorkspace')}</div>
        )}
        {entries.map((e) => {
          const { Icon: EIcon, color: eColor } = fileTypeMeta(e.path, e.type);
          return (
            <div class="file-row" key={e.path}>
              <button
                class="file-name"
                onClick={() => (e.type === 'dir' ? setCwd(cwd ? `${cwd}/${e.path}` : e.path) : openFile(e.path))}
              >
                <span class={`file-icon ${e.type}`} style={`color:${eColor};display:inline-flex;align-items:center;justify-content:center`}>
                  <EIcon width={15} height={15} />
                </span>
                <span class="mono">{e.path}</span>
              </button>
              <span class="file-size">{e.type === 'file' ? fmtBytes(e.size) : ''}</span>
              <div class="file-actions">
                {e.type === 'file' && (
                  <>
                    <button class="btn-ghost sm" onClick={() => openFile(e.path)}>{t('files.view')}</button>
                    <button class="btn-ghost sm" onClick={() => downloadFile(e.path)} title={t('files.downloadFile')} aria-label={t('files.downloadAria', { name: e.path })}>
                      <Download width={12} height={12} class="icon" />
                    </button>
                  </>
                )}
                {renaming === e.path ? (
                  <input
                    class="modern-input compact"
                    ref={renameInputRef}
                    aria-label={t('files.renameAria', { name: e.path })}
                    value={renameValue}
                    onInput={(ev: any) => setRenameValue(ev.target.value)}
                    onKeyDown={(ev: any) => {
                      if (ev.key === 'Enter') doRename(e.path);
                      else if (ev.key === 'Escape') { setRenaming(null); setRenameValue(''); }
                    }}
                  />
                ) : (
                  <button class="btn-ghost sm" onClick={() => startRename(e.path)}>{t('files.rename')}</button>
                )}
                <button class="btn-danger sm" onClick={() => remove(e.path)}>{t('files.delete')}</button>
              </div>
            </div>
          );
        })}
      </div>

      {preview && (
        <div
          class="modal-overlay"
          onMouseDown={(e: any) => { if (e.target === e.currentTarget) closePreview(); }}
        >
          <div
            class="modal-card file-popup-card"
            role="dialog"
            aria-modal="true"
            aria-label={`Preview ${previewName}`}
          >
            <div class="file-preview-head">
              <h3 class="file-preview-name"><span class="mono">{previewName}</span></h3>
              {editContent !== null && editContent !== preview.content && (
                <span class="dim" style="color: var(--warn, #eab308); font-size:0.72rem">{t('files.unsaved')}</span>
              )}
              <span class="dim" style="color: var(--text-3); font-size:0.72rem">
                {preview.binary ? `${fmtBytes(preview.size)} · ${t('files.binary')}` : `${fmtBytes(preview.size)}${preview.truncated ? ` · ${t('files.readOnlyLarge')}` : ''}`}
              </span>
              {editContent !== null && (
                <button class="btn-primary sm" onClick={saveFile} disabled={savingFile}>
                  {savingFile ? t('project.saving') : t('common.save')}
                </button>
              )}
              <button
                class="btn-ghost sm"
                onClick={() => {
                  closePreview();
                  window.location.hash = `/project/${slug}?tab=reviews&path=${encodeURIComponent(previewName)}`;
                }}
                disabled={readOnly}
                title={readOnly ? t('files.reviewViewer') : t('files.reviewTitle')}
                aria-label={t('files.reviewAria')}
              >
                <MessageSquare width={12} height={12} class="icon" /> {t('files.review')}
              </button>
              <button class="btn-ghost sm" onClick={() => downloadFile(previewName)} title={t('files.downloadFile')} aria-label={t('files.downloadFile')}>
                <Download width={12} height={12} class="icon" /> {t('files.download')}
              </button>
              <button class="btn-ghost sm" ref={popupCloseRef} onClick={closePreview}>{t('common.close')}</button>
            </div>
            {fileMsg && (
              <div
                class="terminal-line"
                style="margin: 6px 0"
                role={fileMsg.startsWith('Save failed') ? 'alert' : 'status'}
              >{fileMsg}</div>
            )}
            {preview.binary ? (
              imgUrl ? (
                <div class="file-image-view" style="max-height:60vh;overflow:auto;padding:14px;display:flex;justify-content:center;background:#0a0b0e">
                  <img src={imgUrl} alt={previewName} style="max-width:100%;height:auto;border-radius:6px;object-fit:contain" />
                </div>
              ) : imgLoading ? (
                <div class="empty-state" style="padding: 24px">{t('files.loadingImage')}</div>
              ) : isImagePath(previewName) ? (
                <div class="empty-state" style="padding: 24px">{t('files.imageFail')}</div>
              ) : (
                <div class="empty-state" style="padding: 24px">{t('files.binaryPreview')}</div>
              )
            ) : editContent !== null && !preview.truncated ? (
              <textarea
                class="file-editor mono scrollbar"
                value={editContent}
                onInput={(e: any) => setEditContent(e.target.value)}
                onKeyDown={(e: any) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                    e.preventDefault();
                    saveFile();
                  }
                }}
                spellcheck={false}
              />
            ) : (
              <pre class="file-preview-body mono scrollbar">{preview.content}</pre>
            )}
          </div>
        </div>
      )}

      <ConfirmModal
        open={!!confirmDeleteFile}
        danger
        title={t('files.deleteTitle', { path: cwd ? `${cwd}/${confirmDeleteFile}` : (confirmDeleteFile ?? '') })}
        message={t('files.deleteMessage')}
        confirmLabel={t('files.deleteConfirm')}
        onConfirm={runRemoveFile}
        onCancel={() => setConfirmDeleteFile(null)}
      />
    </div>
  );
}

// ── Logs ──────────────────────────────────────────────────────
function LogsPanel({ slug, running }: { slug: string; running?: boolean }) {
  const { t } = useI18n();
  const [logs, setLogs] = useState('');
  const [filter, setFilter] = useState('');
  const [follow, setFollow] = useState(true);
  const [pollFallback, setPollFallback] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let closed = false;
    let timer: number | null = null;
    let socket: WebSocket | null = null;

    const connectWs = () => {
      if (closed) return;
      try {
        socket = new WebSocket(wsUrl(`/ws/projects/${slug}/logs`));
      } catch {
        socket = null;
      }
      if (!socket) {
        startPolling();
        return;
      }
      const fail = () => {
        socket?.close();
        if (!closed) startPolling();
      };
      socket.onerror = fail;
      socket.onopen = () => {
        if (!closed) setLoadedOnce(true);
      };
      socket.onclose = () => {
        if (!closed && !socketWasClosedByUs) startPolling();
      };
      socket.onmessage = (ev) => {
        let msg: any;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'logs' && typeof msg.data === 'string') {
          if (!closed) {
            setLoadedOnce(true);
            setLogs((prev) => (prev + msg.data).slice(-200000));
          }
        }
      };
    };

    let socketWasClosedByUs = false;
    const stopPolling = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const startPolling = () => {
      if (timer) return;
      setPollFallback(true);
      const tick = () =>
        getLogs(slug, 500)
          .then((d) => {
            if (!closed) {
              setLoadedOnce(true);
              setLogs(d.logs);
            }
          })
          .catch(() => {});
      tick();
      timer = window.setInterval(tick, 4000);
    };

    connectWs();

    return () => {
      closed = true;
      socketWasClosedByUs = true;
      stopPolling();
      try {
        socket?.close();
      } catch {
        /* ignore */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  useEffect(() => {
    const el = bodyRef.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [logs, follow]);

  const filtered = filter.trim()
    ? logs.split('\n').filter((l) => l.toLowerCase().includes(filter.toLowerCase())).join('\n')
    : logs;

  const download = () => {
    const blob = new Blob([logs], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${slug}.log`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(logs);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div class="logs-panel">
      <h2 class="panel-title">{t('logs.title')}</h2>
      <div class="logs-toolbar">
        <input
          class="modern-input"
          style="max-width: 260px"
          placeholder={t('logs.filter')}
          aria-label={t('logs.filterAria')}
          value={filter}
          onInput={(e: any) => setFilter(e.target.value)}
        />
        <button
          class="btn-ghost sm"
          aria-pressed={follow}
          title={t('logs.followTitle')}
          onClick={() => setFollow(!follow)}
        >{follow ? t('logs.autoOn') : t('logs.autoOff')}</button>
        <button class="btn-ghost sm" title={t('logs.copyAllTitle')} onClick={copyAll}>{t('project.copy')}</button>
        <button class="btn-ghost sm" title={t('logs.downloadTitle')} onClick={download}>{t('files.download')}</button>
        <button class="btn-ghost sm" title={t('logs.clearTitle')} onClick={() => setLogs('')}>{t('logs.clear')}</button>
        {pollFallback && (
          <span class="logs-fallback" role="status">{t('logs.fallback')}</span>
        )}
      </div>
      <div class="logs-box mono scrollbar" ref={bodyRef} role="log" aria-live="polite" aria-relevant="additions" aria-busy={!loadedOnce}>
        {filtered
          || (!logs && !loadedOnce && <span class="logs-empty">{t('logs.loading')}</span>)
          || (!logs && running && <span class="logs-empty">{t('logs.noOutput')}</span>)
          || (!logs && <span class="logs-empty">{t('logs.stoppedHint')}</span>)
          || (filter.trim() && <span class="logs-empty">{t('logs.noMatch', { q: filter.trim() })}</span>)}
      </div>
    </div>
  );
}

// ── Scripts ───────────────────────────────────────────────────
function ScriptsPanel({ slug }: { slug: string }) {
  const { t } = useI18n();
  const [scripts, setScripts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState<string | null>(null);
  const [output, setOutput] = useState<{ script: string; exitCode: number | null; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getProjectScripts(slug)
      .then(({ scripts: s }) => setScripts(s))
      .catch((err: any) => setError(err.message))
      .finally(() => setLoading(false));
  }, [slug]);

  const run = async (name: string) => {
    setRunning(name);
    setError(null);
    setOutput(null);
    try {
      const r = await runProjectScript(slug, name);
      setOutput({ script: name, exitCode: r.exitCode, text: r.output });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setRunning(null);
    }
  };

  const names = Object.keys(scripts);
  return (
    <div class="scripts-panel">
      <h2 class="panel-title">{t('scripts.title')}</h2>
      {error && <div class="login-error" style="margin: 8px 0" role="alert">{error}</div>}
      {loading ? (
        <p role="status">{t('scripts.loading')}</p>
      ) : names.length === 0 ? (
        <div class="empty-state" style="padding: 32px">
          {t('scripts.none')} <span class="dim">{t('scripts.noneHint')}</span>
        </div>
      ) : (
        <div class="scripts-grid">
          {names.map((n) => (
            <button class="script-card" key={n} onClick={() => run(n)} disabled={running !== null} aria-label={t('scripts.runAria', { name: n })}>
              <span class="script-name mono">{n}</span>
              <span class="script-cmd">{scripts[n]}</span>
              {running === n && <span class="dim">{t('scripts.running')}</span>}
            </button>
          ))}
        </div>
      )}
      {output && (
        <div class="file-preview" style="margin-top: 16px">
          <div class="file-preview-head">
            <span class="mono">npm run {output.script}</span>
            <span style={`color: ${output.exitCode === 0 ? 'var(--green)' : 'var(--red)'}`} role="status">
              exit {output.exitCode === null ? '…' : output.exitCode}
            </span>
          </div>
          <pre class="file-preview-body mono scrollbar" role="status">{output.text || t('scripts.noOutput')}</pre>
        </div>
      )}
    </div>
  );
}
