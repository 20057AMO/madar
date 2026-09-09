import { useState, useEffect, useMemo, useRef } from 'preact/hooks';
import { FolderSearch,ExternalLink, FolderOpen, Copy, Upload, Globe, Trash2, Loader2, Clock, Users, HardDrive, X } from 'lucide-preact';
import { useHashLocation } from 'wouter/use-hash-location';
import { ConfirmModal } from '../components/ConfirmModal';
import { CrashBadge } from '../components/CrashBadge';
import { TrashPanel } from '../components/TrashPanel';
import {
  listProjects,
  listArchive,
  createProject,
  duplicateProject,
  importProjectSnapshot,
  startProject,
  stopProject,
  clearProjectCrash,
  deleteProject,
  wsUrl,
  type Project,
  getStorageMetrics,
  type ProjectStorage,
} from '../api';
import { fmtCpu, fmtMem } from '../lib/limits';
import { fmtBytes } from '../lib/size';
import { lastTouched, lastTouchedLabel } from '../lib/time';
import { useDocumentVisible } from '../lib/visibility';

type SortKey = 'name' | 'status' | 'created' | 'activity';
type SortDir = 'asc' | 'desc';
type FilterStatus = 'all' | 'running' | 'stopped' | 'crashed';
type ViewMode = 'cards' | 'table';

/** Number of team members beyond the owner (the owner is the first member). */
function extraMemberCount(p: Project): number {
  if (!p.members || !p.ownerId) return 0;
  return p.members.filter((m) => m.userId !== p.ownerId).length;
}

/** Who owns / can access a project, shown on cards and the table. */
function ProjectPeople({ p }: { p: Project }) {
  const ownerName = p.owner?.username || '(deleted user)';
  const extra = extraMemberCount(p);
  return (
    <span class="meta-chip people" title={`Owner: ${ownerName}${extra ? ` · ${extra} more member${extra === 1 ? '' : 's'}` : ''}`}>
      <Users width={11} height={11} class="icon" />
      <span class="people-owner">{ownerName}</span>
      {extra > 0 && <span class="people-extra">+{extra}</span>}
    </span>
  );
}

/** Workspace + snapshot disk usage for a project, rendered as a meta-chip. */
function ProjectStorageChip({ slug, bySlug }: { slug: string; bySlug: Map<string, ProjectStorage> }) {
  const s = bySlug.get(slug);
  if (!s) return null;
  const ws = fmtBytes(s.workspaceBytes);
  const snap = fmtBytes(s.snapshotBytes);
  const snapNote = snap !== '—' ? ` · snapshots ${snap}` : '';
  return (
    <span class="meta-chip storage" title={`Disk usage — workspace ${ws}${snapNote}`}>
      <HardDrive width={11} height={11} class="icon" /> {ws}
    </span>
  );
}

export function Projects() {
  const [, setLocation] = useHashLocation();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [storageBySlug, setStorageBySlug] = useState<Map<string, ProjectStorage>>(new Map());

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterStatus>('all');
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('created');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [view, setView] = useState<ViewMode>('cards');
  const [page, setPage] = useState(0);

  const [selected, setSelected] = useState<Set<string>>(new Set());

  type PageTab = 'projects' | 'trash';
  const PAGE_TABS: readonly PageTab[] = ['projects', 'trash'];
  const [pageTab, setPageTab] = useState<PageTab>('projects');
  const [trashCount, setTrashCount] = useState<number | null>(null);

  const tabsRef = useRef<HTMLDivElement | null>(null);
  const pendingTabFocus = useRef<PageTab | null>(null);
  useEffect(() => {
    const bar = tabsRef.current;
    if (!bar) return;
    if (pendingTabFocus.current === pageTab) {
      pendingTabFocus.current = null;
      bar.querySelector<HTMLElement>(`.tab-btn[data-tab="${pageTab}"]`)?.focus();
    }
    if (window.innerWidth > 700) return;
    const active = bar.querySelector<HTMLElement>('.tab-btn.active');
    if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [pageTab]);

  const onPageTabsKeyDown = (e: any) => {
    const idx = PAGE_TABS.indexOf(pageTab);
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = (idx + 1) % PAGE_TABS.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + PAGE_TABS.length) % PAGE_TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = PAGE_TABS.length - 1;
    if (next === null) return;
    e.preventDefault();
    const t = PAGE_TABS[next];
    pendingTabFocus.current = t;
    setPageTab(t);
  };

  const [createOpen, setCreateOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const restoreInputRef = useRef<HTMLInputElement>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [ports, setPorts] = useState('');
  const [createCpu, setCreateCpu] = useState('');
  const [createMem, setCreateMem] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    // Deep-link from dashboard stat cards: ?filter=running|stopped|crashed.
    // wouter's useHashLocation().navigate() splits hash from query and places
    // the ?filter= part into window.location.search (never the hash), so read
    // search first, then fall back to the hash's own query portion (covers
    // plain <a href="#/projects?filter=…"> deep-links too).
    let raw = window.location.search;
    if (!raw) {
      const hash = window.location.hash;
      const qIdx = hash.indexOf('?');
      if (qIdx >= 0) raw = hash.slice(qIdx);
    }
    const params = new URLSearchParams(raw);
    const f = params.get('filter');
    if (f === 'running' || f === 'stopped' || f === 'crashed') setFilter(f);
    const t = params.get('tab');
    if (t === 'trash') setPageTab('trash');
  }, []);

  // Deep-link from the dashboard: its empty-state "New Project" button sets
  // ws.openCreate in sessionStorage, then navigates here — we open the modal
  // once and consume the intent. (A ?create=1 query in the hash would defeat
  // wouter's route matching, so the intent is passed out-of-band instead.)
  useEffect(() => {
    let open = false;
    try { open = sessionStorage.getItem('wsd.openCreate') === '1'; } catch { /* ignored */ }
    if (open) {
      setCreateOpen(true);
      try { sessionStorage.removeItem('wsd.openCreate'); } catch { /* ignored */ }
    }
  }, []);

  // Duplicate-project modal state.
  const [dupSrc, setDupSrc] = useState<Project | null>(null);
  const [dupName, setDupName] = useState('');
  const [dupDesc, setDupDesc] = useState('');
  const [dupPorts, setDupPorts] = useState('');
  const [duplicating, setDuplicating] = useState(false);
  const [dupError, setDupError] = useState<string | null>(null);

  // Trash count for the tab label — fetched on mount and refreshed after changes.
  useEffect(() => {
    listArchive().then((r) => setTrashCount(r.archives.length)).catch(() => {});
  }, []);

  // Styled destructive-confirm (replaces native window.confirm).
  // Per-card delete lives in the project page's Danger zone now — the cards
  // expose an "Open" action instead.
  type ConfirmState = { kind: 'bulk-delete'; slugs: string[] };
  const [confirmState, setConfirm] = useState<ConfirmState | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  const refresh = async () => {
    try {
      const p = await listProjects();
      setProjects(p.projects);
      setLoadError(null);
    } catch (err: any) {
      setLoadError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Per-project disk usage (workspace + snapshots) from GET /api/storage.
  // The endpoint has its own short TTL cache, so this re-scan is cheap even
  // when called alongside lifecycle changes.
  const refreshStorage = async () => {
    try {
      const s = await getStorageMetrics();
      setStorageBySlug(new Map(s.projects?.map((p) => [p.slug, p]) || []));
    } catch { /* storage is a soft enhancement — never block the page */ }
  };

  const handleTrashRestored = async (_slug: string) => {
    await refresh();
    refreshStorage();
    listArchive().then((r) => setTrashCount(r.archives.length)).catch(() => {});
  };

  const handleTrashCountChange = (count: number) => setTrashCount(count);

  const visible = useDocumentVisible();
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => {
    let closed = false;
    let timer: number | null = null;
    let socket: WebSocket | null = null;

    // Initial data fetch
    refresh();
    refreshStorage();

    const connectWs = () => {
      if (closed) return;
      try {
        socket = new WebSocket(wsUrl('/ws/projects/status'));
      } catch {
        socket = null;
      }
      if (!socket) { startPolling(); return; }

      socket.onmessage = (ev) => {
        if (closed) return;
        let msg: any;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'error') { socket?.close(); if (!closed) startPolling(); return; }
        if (msg.type === 'ready') {
          // Full status list — patch existing project statuses
          setProjects((prev) => {
            const map = new Map<string, string>(msg.projects.map((p: any) => [p.slug, p.status]));
            return prev.map((p) => {
              const newStatus = map.get(p.slug) as Project['status'] | undefined;
              return newStatus && newStatus !== p.status ? { ...p, status: newStatus } : p;
            });
          });
          setLoading(false);
          setLoadError(null);
        }
        if (msg.type === 'update') {
          // Single project status changed
          setProjects((prev) =>
            prev.map((p) => p.slug === msg.slug ? { ...p, status: msg.status } : p)
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
        if (!visibleRef.current) return; // skip when hidden
        try {
          const p = await listProjects();
          if (!closed) { setProjects(p.projects); setLoadError(null); }
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
  }, []);

  // When the tab becomes visible, tick once immediately to catch up
  const prevVisible = useRef(visible);
  useEffect(() => {
    if (visible && !prevVisible.current) {
      listProjects().then((p) => {
        setProjects(p.projects);
        setLoadError(null);
      }).catch(() => {});
    }
    prevVisible.current = visible;
  }, [visible]);

  const running = projects.filter((p) => p.status === 'running').length;
  const stopped = projects.filter((p) => p.status === 'stopped' || p.status === 'created').length;
  const crashed = projects.filter((p) => p.crash).length;

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const p of projects) for (const t of p.tags || []) set.add(t);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [projects]);

  const filtered = useMemo(() => {
    let list = projects;
    if (filter === 'crashed') {
      list = list.filter((p) => p.crash);
    } else if (filter !== 'all') {
      list = list.filter((p) => filter === 'running' ? p.status === 'running' : p.status !== 'running');
    }
    if (tagFilter) {
      list = list.filter((p) => p.tags?.includes(tagFilter));
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((p) =>
        p.name.toLowerCase().includes(q) ||
        p.slug.toLowerCase().includes(q) ||
        (p.description || '').toLowerCase().includes(q) ||
        (p.tags || []).some(t => t.toLowerCase().includes(q))
      );
    }
    list = [...list].sort((a, b) => {
      let cmp = 0;
      if (sortKey === 'name') cmp = a.name.localeCompare(b.name);
      else if (sortKey === 'status') cmp = a.status.localeCompare(b.status);
      else if (sortKey === 'created') cmp = (a.createdAt || '').localeCompare(b.createdAt || '');
      else if (sortKey === 'activity') {
        const at = lastTouched(a) || '';
        const bt = lastTouched(b) || '';
        cmp = at.localeCompare(bt);
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return list;
  }, [projects, filter, tagFilter, search, sortKey, sortDir]);

  // Pagination — client-side slice of the already filtered+sorted array.
  const PAGE_SIZE = 12;
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount - 1);
  const pageItems = useMemo(
    () => filtered.slice(clampedPage * PAGE_SIZE, (clampedPage + 1) * PAGE_SIZE),
    [filtered, clampedPage],
  );

  // Keep the current page in range after a WS refresh/delete shrinks the list
  // (background status patches never reset to page 1 — only deliberate
  // filter/search/sort changes do, via setPage(0) at those controls).
  useEffect(() => {
    setPage((p) => Math.min(p, pageCount - 1));
  }, [pageCount]);

  // Collapse many pages to "1 … c-1 c c+1 … last" so the row stays compact.
  const paginationNumbers = useMemo(() => {
    return (current: number, count: number): (number | 'ellipsis')[] => {
      if (count <= 7) return Array.from({ length: count }, (_, i) => i);
      const nums: number[] = [0];
      for (let p = current - 1; p <= current + 1; p++) {
        if (p > 0 && p < count - 1) nums.push(p);
      }
      nums.push(count - 1);
      const out: (number | 'ellipsis')[] = [];
      let prev = -2;
      for (const np of nums) {
        if (typeof np === 'number' && np - prev > 1) out.push('ellipsis');
        out.push(np);
        prev = np;
      }
      return out.filter((v, i) => i === 0 || v !== out[i - 1]);
    };
  }, []);

  const toggleSelect = (slug: string) => {
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  };

  // Select-all spans the ENTIRE filtered set across pages (bulk start/stop/
  // delete always operate over everything matching the current filter, not
  // just the visible page). The header checkbox .indeterminate communicates
  // "some of the filtered set is selected" from any page.
  const selectAll = () => {
    if (filtered.every((p) => selected.has(p.slug))) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map((p) => p.slug)));
    }
  };

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selected.size > 0 && !filtered.every(p => selected.has(p.slug));
    }
  }, [selected, filtered]);

  const bulkAction = async (action: 'start' | 'stop' | 'delete') => {
    const slugs = [...selected];
    if (action === 'delete') {
      if (slugs.length === 0) return;
      setConfirm({ kind: 'bulk-delete', slugs });
      return;
    }
    const errors: string[] = [];
    for (const slug of slugs) {
      try {
        if (action === 'start') await startProject(slug);
        else if (action === 'stop') await stopProject(slug);
      } catch (err: any) {
        errors.push(`${slug}: ${err.message || 'failed'}`);
      }
    }
    if (errors.length > 0) {
      setLoadError(`Failed ${action === 'start' ? 'starting' : 'stopping'} ${errors.length} project(s):\n${errors.join('\n')}`);
    }
    setSelected(new Set());
    await refresh();
  };

  const runConfirmed = async () => {
    if (!confirmState || confirmBusy) return;
    setConfirmBusy(true);
    try {
      const errors: string[] = [];
      for (const slug of confirmState.slugs) {
        try { await deleteProject(slug); } catch (err: any) { errors.push(`${slug}: ${err.message || 'failed'}`); }
      }
      if (errors.length > 0) {
        setLoadError(`Failed deleting ${errors.length} project(s):\n${errors.join('\n')}`);
      }
      setSelected(new Set());
      setConfirm(null);
      await refresh();
    } catch (err: any) {
      setLoadError(err.message);
      setConfirm(null);
    } finally {
      setConfirmBusy(false);
    }
  };

  const handleCreate = async (e: Event) => {
    e.preventDefault();
    if (!name.trim()) return;
    let parsedPorts = ports
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0 && n <= 65535);
    if (parsedPorts.length === 0) parsedPorts = [8000];  // sensible default
    setCreating(true);
    setCreateError(null);
    try {
      // Optional creation-time limits — blank fields mean "unconstrained",
      // the server re-validates them against the current host (400 on junk).
      const cpuText = createCpu.trim();
      const memText = createMem.trim();
      const limits =
        cpuText || memText
          ? { cpu: cpuText || undefined, memory: memText || undefined }
          : undefined;
      const { project } = await createProject({
        name: name.trim(),
        description: description.trim() || undefined,
        ports: parsedPorts,
        limits,
      });
      setName('');
      setDescription('');
      setPorts('');
      setCreateCpu('');
      setCreateMem('');
      setCreateOpen(false);
      await refresh();
      setLocation(`/project/${project.slug}`);
    } catch (err: any) {
      setCreateError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const openDuplicate = (e: Event, p: Project) => {
    e.stopPropagation();
    setDupSrc(p);
    setDupName(`${p.name} Copy`);
    setDupDesc(p.description || '');
    setDupPorts((p.ports && p.ports.length > 0 ? p.ports : []).join(', '));
    setDupError(null);
  };

  const handleDuplicate = async (e: Event) => {
    e.preventDefault();
    if (!dupSrc || !dupName.trim()) return;
    let parsedPorts = dupPorts
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0 && n <= 65535);
    if (parsedPorts.length === 0) parsedPorts = [8000];  // sensible default
    setDuplicating(true);
    setDupError(null);
    try {
      const { project } = await duplicateProject(dupSrc.slug, {
        name: dupName.trim(),
        description: dupDesc.trim() || undefined,
        ports: parsedPorts,
      });
      setDupSrc(null);
      await refresh();
      setLocation(`/project/${project.slug}`);
    } catch (err: any) {
      setDupError(err.message);
    } finally {
      setDuplicating(false);
    }
  };

  const handleAction = async (e: MouseEvent, slug: string, action: 'start' | 'stop') => {
    e.stopPropagation();
    try {
      if (action === 'start') await startProject(slug);
      else await stopProject(slug);
      await refresh();
    } catch (err: any) {
      setLoadError(err.message);
    }
  };

  // Dismiss a crash badge from the list without touching the container.
  const handleClearCrash = async (e: MouseEvent, slug: string) => {
    e.stopPropagation();
    try {
      await clearProjectCrash(slug);
      setProjects((prev) => prev.map((p) => (p.slug === slug ? { ...p, crash: undefined } : p)));
    } catch (err: any) {
      setLoadError(err.message);
    }
  };

  const openProjectCard = (e: MouseEvent, p: Project) => {
    e.stopPropagation();
    if (p.status === 'running' && p.serve?.enabled && p.serve.hostPort) {
      window.open(`http://${window.location.hostname}:${p.serve.hostPort}`, '_blank', 'noopener,noreferrer');
    } else {
      setLocation(`/project/${p.slug}`);
    }
  };

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
    setPage(0);
  };

  const handleSortSelect = (e: any) => {
    const val = e.target.value as SortKey;
    if (val !== sortKey) {
      setSortKey(val);
      setSortDir('asc');
    } else {
      setSortDir((d) => d === 'asc' ? 'desc' : 'asc');
    }
    setPage(0);
  };

  const sortIcon = (key: SortKey) => sortKey === key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';

  // Restore a snapshot upload as a brand-new project, then jump to it.
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

  if (loading) {
    return (
      <div class="view">
        <div class="dash-loading"><Loader2 width={28} height={28} class="icon spin" />Loading…</div>
      </div>
    );
  }

  return (
    <div class="view">
      <div class="detail-tabs" style="margin-bottom:16px" ref={tabsRef} role="tablist" aria-label="Projects views" onKeyDown={onPageTabsKeyDown}>
        <button class={`tab-btn ${pageTab === 'projects' ? 'active' : ''}`} type="button" id="ptab-projects" role="tab" aria-selected={pageTab === 'projects'} tabIndex={pageTab === 'projects' ? 0 : -1} aria-controls="pane-projects" data-tab="projects" onClick={() => setPageTab('projects')}>
          Projects
        </button>
        <button class={`tab-btn ${pageTab === 'trash' ? 'active' : ''}`} type="button" id="ptab-trash" role="tab" aria-selected={pageTab === 'trash'} tabIndex={pageTab === 'trash' ? 0 : -1} aria-controls="pane-trash" data-tab="trash" onClick={() => setPageTab('trash')}>
          <Trash2 width={13} height={13} class="icon" /> Trash{trashCount != null ? ` (${trashCount})` : ''}
        </button>
      </div>

      <div id={`pane-${pageTab}`} role="tabpanel" aria-labelledby={`ptab-${pageTab}`} tabIndex={0}>
      {pageTab === 'projects' && (<>
      <div class="proj-header">
        <div>
          <h1 class="hero-title" style="font-size:1.5rem">Projects</h1>
          <p class="hero-sub" style="margin:0">{projects.length} projects · {running} running · {stopped} stopped{crashed > 0 ? ` · ${crashed} crashed` : ''}</p>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <input ref={restoreInputRef} type="file" accept=".tar.gz,application/gzip" style="display:none" onChange={handleRestoreFile} />
          <button class="btn-ghost" onClick={() => restoreInputRef.current?.click()} disabled={importing}>
            <Upload class="icon" /> {importing ? 'Restoring…' : 'Restore'}
          </button>
          <button class="btn-primary" onClick={() => setCreateOpen(true)}>+ New Project</button>
        </div>
      </div>

      {loadError && <div class="login-error" style="margin-bottom:12px">{loadError}</div>}

      <div class="proj-toolbar">
        <div class="proj-search-row">
          <input
            class="modern-input proj-search"
            placeholder="Search projects…"
            value={search}
            onInput={(e: any) => { setSearch(e.target.value); setPage(0); }}
          />
          <select class="modern-input chat-sel" value={filter} onChange={(e: any) => { setFilter(e.target.value); setPage(0); }} aria-label="Filter by status">
            <option value="all">All</option>
            <option value="running">Running</option>
            <option value="stopped">Stopped</option>
            <option value="crashed">Crashed</option>
          </select>
          <select class="modern-input chat-sel" value={sortKey} onChange={handleSortSelect} aria-label="Sort projects">
            <option value="activity">Sort: Activity</option>
            <option value="created">Sort: Date</option>
            <option value="name">Sort: Name</option>
            <option value="status">Sort: Status</option>
          </select>
          <button class="btn-ghost sm" onClick={() => { setSortDir((d) => d === 'asc' ? 'desc' : 'asc'); setPage(0); }}>
            {sortDir === 'asc' ? '↑ Asc' : '↓ Desc'}
          </button>
        </div>
        <div class="proj-view-toggle">
          <button class={`btn-ghost sm ${view === 'cards' ? 'active' : ''}`} onClick={() => setView('cards')}>▣ Cards</button>
          <button class={`btn-ghost sm ${view === 'table' ? 'active' : ''}`} onClick={() => setView('table')}>☰ Table</button>
        </div>
      </div>

      {allTags.length > 0 && (
        <div class="proj-tag-filter">
          <button
            class={`tag-chip ${tagFilter === null ? 'active' : ''}`}
            onClick={() => { setTagFilter(null); setPage(0); }}
          >
            All
          </button>
          {allTags.map((t) => (
            <button
              class={`tag-chip ${tagFilter === t ? 'active' : ''}`}
              key={t}
              onClick={() => { setTagFilter(tagFilter === t ? null : t); setPage(0); }}
            >
              {t}
            </button>
          ))}
        </div>
      )}

      {selected.size > 0 && (
        <div class="proj-bulk-bar">
          <span>{selected.size} selected</span>
          <button class="btn-ghost sm" onClick={() => bulkAction('start')}>▶ Start Selected</button>
          <button class="btn-ghost sm" onClick={() => bulkAction('stop')}>⏹ Stop Selected</button>
          <button class="btn-danger sm" onClick={() => bulkAction('delete')}>✕ Delete Selected</button>
          <button class="btn-ghost sm" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

      {filtered.length === 0 ? (
        <div class="empty-state">
          <div class="big-icon"><FolderSearch width={30} height={30} class="icon" /></div>
          {projects.length === 0 ? 'No projects yet. Create your first one!' : 'No projects match your search.'}
          {projects.length === 0 && (
            <button class="btn-primary" style="margin-top:12px" onClick={() => setCreateOpen(true)}>+ New Project</button>
          )}
        </div>
      ) : view === 'cards' ? (
        <div class="projects-grid">
          {pageItems.map((p) => (
            <div
              class={`project-card ${selected.has(p.slug) ? 'selected' : ''}`}
              key={p.slug}
              role="button"
              tabIndex={0}
              onClick={() => setLocation(`/project/${p.slug}`)}
              onKeyDown={(e: KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setLocation(`/project/${p.slug}`);
                }
              }}
            >
              <div class="project-card-header">
                <label class="proj-checkbox" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selected.has(p.slug)}
                    onChange={() => toggleSelect(p.slug)}
                    aria-label={`Select ${p.name}`}
                  />
                </label>
                <h2>{p.name}</h2>
                <span class={`status-badge ${p.status}`}>{p.status}</span>
                {p.crash && <CrashBadge crash={p.crash} />}
                {p.crash && (
                  <button class="crash-dismiss" title="Dismiss crash alert" onClick={(e) => handleClearCrash(e, p.slug)}>
                    <X width={11} height={11} class="icon" />
                  </button>
                )}
              </div>
              <div class="project-desc">{p.description || '—'}</div>
              <div class="project-tags" style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px">
                {p.tags && p.tags.map(t => (
                  <span class="tag-chip" key={t}>{t}</span>
                ))}
              </div>
              <div class="project-meta">
                <span class="meta-chip">{p.slug}</span>
                <ProjectPeople p={p} />
                <ProjectStorageChip slug={p.slug} bySlug={storageBySlug} />
                {lastTouchedLabel(p) && (
                  <span class="meta-chip activity" title="Last activity">
                    <Clock width={11} height={11} class="icon" /> {lastTouchedLabel(p)}
                  </span>
                )}
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
              </div>
              <div class="card-footer">
                <button class="btn-ghost sm" onClick={(e) => handleAction(e, p.slug, p.status === 'running' ? 'stop' : 'start')}>
                  {p.status === 'running' ? 'Stop' : 'Start'}
                </button>
                <button class="btn-ghost sm" onClick={(e) => openProjectCard(e, p)}>
                  <ExternalLink width={13} height={13} class="icon" /> Preview
                </button>
                <button class="btn-ghost sm" title="Duplicate this project (copy files + notes)" onClick={(e) => openDuplicate(e, p)}>
                  <Copy width={13} height={13} class="icon" /> Duplicate
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div class="proj-table-wrap">
          <table class="proj-table">
            <thead>
              <tr>
                <th class="proj-th-check">
                  <input type="checkbox" ref={selectAllRef} checked={filtered.length > 0 && filtered.every((p) => selected.has(p.slug))} onChange={selectAll} aria-label="Select all projects" />
                </th>
                <th
                  class="proj-th-sortable"
                  tabIndex={0}
                  onClick={() => toggleSort('name')}
                  onKeyDown={(e: KeyboardEvent) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSort('name'); }
                  }}
                >Name{sortIcon('name')}</th>
                <th>Status</th>
                <th>Description</th>
                <th>Ports</th>
                <th>Team</th>
                <th>Size</th>
                <th
                  className="proj-th-sortable"
                  tabIndex={0}
                  onClick={() => toggleSort('activity')}
                  onKeyDown={(e: KeyboardEvent) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSort('activity'); }
                  }}
                >Activity{sortIcon('activity')}</th>
                <th
                  className="proj-th-sortable"
                  tabIndex={0}
                  onClick={() => toggleSort('created')}
                  onKeyDown={(e: KeyboardEvent) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSort('created'); }
                  }}
                >Created{sortIcon('created')}</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {pageItems.map((p) => (
                <tr
                  key={p.slug}
                  class={selected.has(p.slug) ? 'selected' : ''}
                  tabIndex={0}
                  onClick={() => setLocation(`/project/${p.slug}`)}
                  onKeyDown={(e: KeyboardEvent) => {
                    if ((e.key === 'Enter' || e.key === ' ') && !(e.target as HTMLElement).closest('button,a,input,select')) {
                      e.preventDefault();
                      setLocation(`/project/${p.slug}`);
                    }
                  }}
                >
                  <td onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={selected.has(p.slug)} onChange={() => toggleSelect(p.slug)} aria-label={`Select ${p.name}`} />
                  </td>
                  <td class="proj-td-name">{p.name}</td>
                  <td><span class={`status-badge ${p.status}`}>{p.status}</span>{p.crash && <CrashBadge crash={p.crash} />}</td>
                  <td class="proj-td-desc">{p.description || '—'}</td>
                  <td>{p.hostPorts && Object.keys(p.hostPorts).length > 0
                    ? Object.values(p.hostPorts).map((pub) => (
                      <span class="meta-chip port" key={pub}>:{pub}</span>
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
                  {p.tags && p.tags.length > 0 && <span class="dim" style="margin-left:4px;font-size:0.7rem">{p.tags.join(', ')}</span>}
                </td>
                  <td onClick={(e) => e.stopPropagation()}><ProjectPeople p={p} /></td>
                  <td onClick={(e) => e.stopPropagation()}><ProjectStorageChip slug={p.slug} bySlug={storageBySlug} /></td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <span class="proj-td-activity" title={lastTouched(p) ? new Date(lastTouched(p)!).toLocaleString() : undefined}>
                      {lastTouchedLabel(p) ? `~${lastTouchedLabel(p)} ago` : '—'}
                    </span>
                  </td>
                  <td class="proj-td-date">{p.createdAt ? new Date(p.createdAt).toLocaleDateString() : '—'}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <button class="btn-ghost sm" onClick={(e) => handleAction(e, p.slug, p.status === 'running' ? 'stop' : 'start')}>
                      {p.status === 'running' ? '⏹' : '▶'}
                    </button>
                    <button class="btn-ghost sm" title="Preview project" onClick={(e) => openProjectCard(e, p)}>
                      <FolderOpen width={12} height={12} class="icon" />
                    </button>
                    <button class="btn-ghost sm" title="Duplicate project (copy files + notes)" onClick={(e) => openDuplicate(e, p)}>
                      <Copy width={12} height={12} class="icon" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {filtered.length > PAGE_SIZE && (
        <div class="proj-pagination" aria-label="Projects pagination">
          <button
            class="btn-ghost sm"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={clampedPage === 0}
            aria-label="Previous page"
          >
            ‹
          </button>
          {paginationNumbers(clampedPage, pageCount).map((n, i) =>
            n === 'ellipsis' ? (
              <span class="proj-page-ellipsis" key={`e${i}`}>…</span>
            ) : (
              <button
                class={`btn-ghost sm ${n === clampedPage ? 'active' : ''}`}
                key={i}
                onClick={() => setPage(n)}
                aria-current={n === clampedPage ? 'page' : undefined}
              >
                {n + 1}
              </button>
            ),
          )}
          <button
            class="btn-ghost sm"
            onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            disabled={clampedPage === pageCount - 1}
            aria-label="Next page"
          >
            ›
          </button>
          <span class="proj-page-info">
            Showing {clampedPage * PAGE_SIZE + 1}–{Math.min(filtered.length, (clampedPage + 1) * PAGE_SIZE)} of {filtered.length}
          </span>
        </div>
      )}

      {createOpen && (
        <div class="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setCreateOpen(false); }}>
          <div class="create-card modal-dialog" style="max-width:500px;width:100%">
            <div class="create-title">New Project</div>
            <form onSubmit={handleCreate}>
              <input
                class="modern-input"
                placeholder="Project name"
                value={name}
                onInput={(e: any) => setName(e.target.value)}
                autoFocus
              />
              <input
                class="modern-input"
                style="margin-top:10px"
                placeholder="Description (optional)"
                value={description}
                onInput={(e: any) => setDescription(e.target.value)}
              />
              <input
                class="modern-input"
                style="margin-top:10px"
                placeholder="Ports (optional, defaults to 8000)"
                value={ports}
                onInput={(e: any) => setPorts(e.target.value)}
              />
              <div style="display:flex;gap:10px;margin-top:10px">
                <input
                  class="modern-input"
                  style="flex:1"
                  placeholder="CPU limit (optional, e.g. 2 or 500m)"
                  value={createCpu}
                  onInput={(e: any) => setCreateCpu(e.target.value)}
                />
                <input
                  class="modern-input"
                  style="flex:1"
                  placeholder="Memory limit (optional, e.g. 128Mi)"
                  value={createMem}
                  onInput={(e: any) => setCreateMem(e.target.value)}
                />
              </div>
              {createError && <div class="login-error" style="margin-top:10px">{createError}</div>}
              <div style="display:flex;gap:10px;margin-top:14px;justify-content:flex-end">
                <button type="button" class="btn-ghost sm" onClick={() => setCreateOpen(false)}>Cancel</button>
                <button type="submit" class="btn-primary" disabled={creating || !name.trim()}>
                  {creating ? 'Creating…' : 'Create'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {dupSrc && (
        <div class="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget && !duplicating) setDupSrc(null); }}>
          <div class="create-card modal-dialog" style="max-width:500px;width:100%">
            <div class="create-title">Duplicate “{dupSrc.name}”</div>
            <p class="hero-sub" style="margin:0 0 12px">
              Creates a new project with a copy of the workspace files and developer notes.
            </p>
            <form onSubmit={handleDuplicate}>
              <input
                class="modern-input"
                placeholder="New project name"
                value={dupName}
                onInput={(e: any) => setDupName(e.target.value)}
                autoFocus
              />
              <input
                class="modern-input"
                style="margin-top:10px"
                placeholder="Description (optional)"
                value={dupDesc}
                onInput={(e: any) => setDupDesc(e.target.value)}
              />
              <input
                class="modern-input"
                style="margin-top:10px"
                placeholder="Ports (optional, defaults to 8000)"
                value={dupPorts}
                onInput={(e: any) => setDupPorts(e.target.value)}
              />
              {dupError && <div class="login-error" style="margin-top:10px">{dupError}</div>}
              <div style="display:flex;gap:10px;margin-top:14px;justify-content:flex-end">
                <button type="button" class="btn-ghost sm" onClick={() => setDupSrc(null)} disabled={duplicating}>Cancel</button>
                <button type="submit" class="btn-primary" disabled={duplicating || !dupName.trim()}>
                  {duplicating ? 'Duplicating…' : 'Duplicate'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <ConfirmModal
        open={!!confirmState}
        danger
        loading={confirmBusy}
        title={`Delete ${confirmState?.slugs.length ?? 0} project(s)?`}        message="The container and its workspace files are permanently removed."
        confirmLabel="Delete"
        onConfirm={runConfirmed}
        onCancel={() => { if (!confirmBusy) setConfirm(null); }}
      />
      </>)}

      {pageTab === 'trash' && (
        <TrashPanel onRestored={handleTrashRestored} onTrashCountChange={handleTrashCountChange} />
      )}
      </div>
    </div>
  );
}
