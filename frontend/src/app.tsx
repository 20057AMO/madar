import { Component, type ComponentChildren } from 'preact';
import { lazy, Suspense } from 'preact/compat';
import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { Router, Route } from 'wouter';
import { useHashLocation } from 'wouter/use-hash-location';
import {
  LayoutDashboard,
  FolderOpen,
  Bot,
  KeyRound,
  Settings as SettingsIcon,
  LogOut,
  Unlock,
  Users,
  PencilRuler,
  Menu,
  ShieldAlert,
  MessageCircle,
  Languages,
  Command,
  Search,
} from 'lucide-preact';
import { AuthProvider, useAuth } from './auth';
import { I18nProvider, useI18n } from './i18n';
import { ToastProvider } from './components/ToastProvider';
import { CommandPalette } from './components/CommandPalette';
import { VSCodeIcon, OpencodeIcon } from './components/brand-icons';
import { Login } from './views/Login';
import { ConfirmModal } from './components/ConfirmModal';
import {
  getProvidersLockStatus,
  getProvidersUnlock,
  relockProviders,
  clearProvidersUnlock,
  avatarUrl,
  UNLOCK_KEY,
  getOpencodeStatus,
  getUpdates,
} from './api';
import { UPDATE_RUNNING_STATES } from './views/settings-shared';
import { Avatar } from './components/Avatar';

/**
 * Import wrappers with a side-effect-free prefetch seam: the chunk-network
 * request is exported so keep-alive layers can fire it when their route is
 * merely POSSIBLE (a sidebar link, a deep link) instead of when it renders.
 * The dynamic import itself stays the loader — no eager fetch at boot.
 */
const loadDashboard = () => import('./views/Dashboard');
const loadOpencode = () => import('./views/Opencode');
const loadEmbeddedIDE = () => import('./views/EmbeddedIDE');
const loadProject = () => import('./views/Project');
const loadTeamChat = () => import('./views/Chat');
const loadPlanner = () => import('./views/Planner');
const loadTerminals = () => import('./views/Terminals');
const loadProjects = () => import('./views/Projects');
const loadAgents = () => import('./views/Agents');
const loadProviders = () => import('./views/Providers');
const loadSettings = () => import('./views/Settings');
const loadProfile = () => import('./views/Profile');
const loadTeam = () => import('./views/Team');
const loadUserProfile = () => import('./views/UserProfile');
const loadOpencodeStudio = () => import('./views/OpencodeStudio');

const Dashboard = lazy(() => loadDashboard().then(m => ({ default: m.Dashboard })));
const Projects = lazy(() => loadProjects().then(m => ({ default: m.Projects })));
const Project = lazy(() => loadProject().then(m => ({ default: m.Project })));
const Opencode = lazy(() => loadOpencode().then(m => ({ default: m.Opencode })));
const OpencodeStudio = lazy(() => loadOpencodeStudio().then(m => ({ default: m.OpencodeStudio })));
const Agents = lazy(() => loadAgents().then(m => ({ default: m.Agents })));
const EmbeddedIDE = lazy(() => loadEmbeddedIDE().then(m => ({ default: m.EmbeddedIDE })));
const Terminals = lazy(() => loadTerminals().then(m => ({ default: m.Terminals })));
const Providers = lazy(() => loadProviders().then(m => ({ default: m.Providers })));
const Settings = lazy(() => loadSettings().then(m => ({ default: m.Settings })));
const Profile = lazy(() => loadProfile().then(m => ({ default: m.Profile })));
const Team = lazy(() => loadTeam().then(m => ({ default: m.Team })));
const UserProfile = lazy(() => loadUserProfile().then(m => ({ default: m.UserProfile })));
const Planner = lazy(() => loadPlanner().then(m => ({ default: m.Planner })));
const TeamChat = lazy(() => loadTeamChat().then(m => ({ default: m.Chat })));

/**
 * One idle tick of speculative prefetching for the most-likely next chunks.
 * Runs ONCE after the shell is interactive; every loader is idempotent (the
 * module promise is cached by the runtime), so a chunk already pulled by a
 * real navigation dedupes. Keep-alive tool layers (/ide, /opencode) come
 * first: their iframe-based first paint is the slowest in the product, and
 * removing the chunk fetch from that critical path is the win that matters.
 */
function prefetchLikelyChunks() {
  const idle = (cb: () => void) => {
    if ('requestIdleCallback' in window) requestIdleCallback(cb, { timeout: 2500 });
    else setTimeout(cb, 1200);
  };
  idle(() => {
    void loadEmbeddedIDE();
    void loadOpencode();
  });
  setTimeout(() => {
    void loadDashboard();
    void loadProject();
    void loadTeamChat();
  }, 3500);
}


interface ErrorBoundaryProps { children: ComponentChildren; }
interface ErrorBoundaryState { error: Error | null; }

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div class="error-boundary">
          <div class="error-boundary-box">
            <div class="error-boundary-icon">⚠</div>
            <h2>Something went wrong</h2>
            <p class="error-boundary-msg">{this.state.error.message}</p>
            <button class="error-boundary-btn" onClick={() => { this.setState({ error: null }); window.location.hash = '/'; }}>
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const NavButton = ({
  href,
  label,
  icon: Icon,
  onClick,
  newTabUrl,
}: {
  href?: string;
  label: string;
  icon: any;
  onClick?: () => void;
  newTabUrl?: string;
}) => {
  const [location] = useHashLocation();
  const active = href ? location === href || (href !== '/' && (location.startsWith(href) || (href === '/projects' && location.startsWith('/project/')))) : false;
  return (
    <button
      class={`nav-btn ${active ? 'active' : ''}`}
      onClick={
        newTabUrl
          ? () => window.open(newTabUrl, '_blank', 'noopener')
          : href
            ? () => navigate(href)
            : onClick
      }
    >
      <Icon width={16} height={16} class="icon" />
      <span class="nav-btn-label">{label}</span>
    </button>
  );
};

function navigate(href: string): void {
  window.location.hash = href;
}

/**
 * Exact / segment-aware match for the two full-screen tool layers. A plain
 * startsWith mounted the bare layer for every near-miss (`/idea`,
 * `/opencodefoo`, `/ide-x`), which strands the user on a chrome-less dead end
 * they can only leave through the URL bar. Match the route segment instead:
 * `/ide` and `/opencode` exactly (an optional trailing slash and the in-hash
 * query are folded away), plus opencode's cold directory deep link
 * `/#/opencode/<base64url-directory>` — the server path main.tsx's
 * normalizeBootPath folds into the hash before the first render.
 * `/opencode-studio` can never match, because an extra segment has to follow a
 * real '/'.
 */
function isToolRoute(location: string | null, base: string, deepLink = false): boolean {
  const path = (location || '').split('?')[0].split('#')[0].replace(/\/+$/, '');
  if (path === base) return true;
  return deepLink && path.length > base.length + 1 && path.startsWith(`${base}/`);
}

/** Stable <main> ids the skip link resolves to while a layer owns the screen. */
const TOOL_MAIN_ID = { ide: 'ide-main', opencode: 'opencode-main' } as const;

type ToolLayer = keyof typeof TOOL_MAIN_ID;

function activeToolLayer(location: string | null): ToolLayer | null {
  if (isToolRoute(location, '/ide')) return 'ide';
  if (isToolRoute(location, '/opencode', true)) return 'opencode';
  return null;
}

/**
 * Visible only while the Providers page is unlocked: shows the remaining
 * unlock time and offers an instant re-lock. Syncs across tabs via the
 * storage event on the unlock key.
 */
function ProvidersUnlockBadge() {
  const { t } = useI18n();
  const [mins, setMins] = useState<number | null>(null);
  const [askRelock, setAskRelock] = useState(false);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      try {
        const { enabled } = await getProvidersLockStatus();
        if (!alive) return;
        if (!enabled) { setMins(null); return; }
        const unlock = getProvidersUnlock();
        if (!unlock) { setMins(null); return; }
        setMins(Math.max(0, Math.ceil((unlock.expiresAt - Date.now()) / 60_000)));
      } catch {
        if (alive) setMins(null);
      }
    };
    refresh();
    const timer = setInterval(refresh, 30_000);
    const onStorage = (e: StorageEvent) => {
      if (e.key === UNLOCK_KEY) refresh();
    };
    window.addEventListener('storage', onStorage);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  if (mins === null) return null;

  const relock = () => setAskRelock(true);

  const runRelock = async () => {
    try { await relockProviders(); } catch { /* ignore — local clear still applies */ }
    clearProvidersUnlock();
    setMins(null);
  };

  return (
    <>
      <button class="unlock-badge" title={t('nav.providersUnlocked')} onClick={relock}>
        <Unlock width={11} height={11} />
        <span>Providers · {mins}m</span>
      </button>
      <ConfirmModal
        open={askRelock}
        title={t('nav.relockNow')}
        message={t('nav.relockMessage')}
        confirmLabel={t('nav.lockNow')}
        onConfirm={runRelock}
        onCancel={() => setAskRelock(false)}
      />
    </>
  );
}

function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, lang, toggleLang } = useI18n();
  const { user, logout } = useAuth();
  const [ocPort, setOcPort] = useState(4096);
  const [updatesFlag, setUpdatesFlag] = useState<'none' | 'available' | 'applying'>('none');

  useEffect(() => {
    getOpencodeStatus()
      .then((s) => {
        if (s?.port) setOcPort(s.port);
      })
      .catch(() => {});
  }, []);

  // Update notification dot — admin only. Probed on mount, every 15 min and
  // whenever the tab becomes visible again (pageshow/visibilitychange, same
  // pattern as the providers-lock gate). Any failure stays silent.
  useEffect(() => {
    if (user?.role !== 'admin') return;
    let alive = true;
    let reprobe = 0;
    const check = () => {
      getUpdates()
        .then((s) => {
          if (!alive) return;
          const applying = s.components.some((c) => c.updateRunning || UPDATE_RUNNING_STATES.includes(c.applyState));
          const available = s.components.some((c) => !c.updateRunning && c.upToDate === false && c.channelUnlocked !== false);
          setUpdatesFlag(applying ? 'applying' : available ? 'available' : 'none');
        })
        .catch(() => {
          // A silent failure must not pin a stale flag forever (e.g. the
          // server was restarting mid-probe): re-probe shortly instead of
          // waiting out the whole 15-min interval.
          if (!alive) return;
          window.clearTimeout(reprobe);
          reprobe = window.setTimeout(() => { if (alive) check(); }, 30_000);
        });
    };
    check();
    // While an apply is showing, poll briefly so the sidebar clears the
    // moment it lands; otherwise the 15-min probe is enough.
    const period = updatesFlag === 'applying' ? 20_000 : 15 * 60_000;
    const timer = setInterval(check, period);
    const onVisible = () => { if (!document.hidden) check(); };
    // Settings page fires this when an apply starts/lands — re-probe at once.
    const onUpdatesChanged = () => check();
    window.addEventListener('wsd:updates-changed', onUpdatesChanged);
    window.addEventListener('pageshow', check);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      clearInterval(timer);
      window.clearTimeout(reprobe);
      window.removeEventListener('wsd:updates-changed', onUpdatesChanged);
      window.removeEventListener('pageshow', check);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [user?.role, updatesFlag]);

  const toolBase = `${window.location.protocol === 'https:' ? 'https' : 'http'}://${window.location.hostname}`;
  return (
    <aside class={`sidebar${open ? ' open' : ''}`}>
      <div
        class="sidebar-brand"
        role="button"
        tabIndex={0}
        onClick={() => { navigate('/'); onClose(); }}
        onKeyDown={(e: KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            navigate('/');
            onClose();
          }
        }}
      >
        <div class="brand-mark"><img class="brand-logo" src="/logo.png" alt="Madar" /></div>
        <div class="brand-text">
          <span class="brand-name">Madar</span>
          <span class="brand-tag">Developers Environment</span>
        </div>
      </div>
      <nav class="sidebar-nav" onClick={onClose}>
        <div class="nav-group-label">{t('nav.groupWorkspace')}</div>
        <NavButton href="/" label={t('nav.dashboard')} icon={LayoutDashboard} />
        <NavButton href="/projects" label={t('nav.projects')} icon={FolderOpen} />
        <NavButton href="/planner" label={t('nav.planner')} icon={PencilRuler} />
        <NavButton href="/agents" label={t('nav.agents')} icon={Bot} />
        <NavButton href="/ide" label={t('nav.vscode')} icon={VSCodeIcon} />
        <div class="nav-group-label">{t('nav.groupCollaborate')}</div>
        <NavButton href="/chat" label={t('nav.teamChat')} icon={MessageCircle} />
        <NavButton label="opencode" icon={OpencodeIcon} newTabUrl={`${toolBase}:${ocPort}/`} />
        {user?.role === 'admin' && <NavButton href="/opencode-studio" label={t('nav.ocStudio')} icon={OpencodeIcon} />}
        {user?.role === 'admin' && (
          <>
            <div class="nav-group-label">{t('nav.groupAdmin')}</div>
            <NavButton href="/providers" label={t('nav.providers')} icon={KeyRound} />
            <NavButton href="/team" label={t('nav.team')} icon={Users} />
            <div class="nav-btn-wrap">
              <NavButton
                href="/settings"
                label={updatesFlag === 'applying' ? t('nav.settingsUpdating') : updatesFlag === 'available' ? t('nav.settingsUpdates') : t('nav.settings')}
                icon={SettingsIcon}
              />
              {updatesFlag !== 'none' && (
                <span
                  class={`updates-dot ${updatesFlag === 'applying' ? 'good' : 'warn'}`}
                  title={updatesFlag === 'applying' ? t('nav.updatesApplying') : t('nav.updatesAvailable')}
                  aria-hidden="true"
                />
              )}
            </div>
          </>
        )}
      </nav>
      <button class="palette-hint-row" onClick={() => { onClose(); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true })); }}>
        <Search width={13} height={13} class="icon" />
        <span>{t('palette.title')}</span>
        <kbd class="palette-hint-kbd">Ctrl K</kbd>
      </button>
      <div class="sidebar-footer">
        <ProvidersUnlockBadge />
        <div
          class="sidebar-profile-row"
          role="button"
          tabIndex={0}
          onClick={() => { navigate('/profile'); onClose(); }}
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate('/profile'); onClose(); }
          }}
          title={t('nav.openProfile')}
        >
          <span class="sidebar-profile-label">{user?.profile?.displayName || user?.username || t('common.profile')}</span>
          {user && <Avatar name={user.profile?.displayName || user.username} avatar={avatarUrl(user.id, user.profile?.avatarExt)} size={20} />}
        </div>
        <div class="sys-row">
          <span class="sys-dot ok" />
          <button
            class="lang-btn"
            title={t('lang.switchTo')}
            aria-label={t('lang.switchTo')}
            onClick={(e: Event) => { e.stopPropagation(); toggleLang(); }}
          >
            <Languages width={12} height={12} />
            <span>{lang === 'ar' ? 'EN' : 'ع'}</span>
          </button>
          <button
            class="nav-icon-btn"
            title={t('common.signOut')}
            aria-label={t('common.signOut')}
            onClick={(e: Event) => { e.stopPropagation(); logout(); window.location.hash = '/login'; }}
          >
            <LogOut width={15} height={15} class="icon" />
          </button>
          <span class="beta-chip" title="Beta software — features and data format may change">BETA</span>
        </div>
      </div>
    </aside>
  );
}

/**
 * Per-route document title. Every route — including the full-screen keep-alive
 * layers (/ide, /opencode), which deliberately render no <Route> — needs a
 * distinct title so the window, the tab strip and screen-reader announcements
 * say where the user actually is. Location carries the query inside the hash,
 * so it is stripped before matching. Hard-coded English on purpose: this is
 * document metadata, not page copy, and the i18n lane is off-limits.
 */
const ROUTE_TITLES: Record<string, string> = {
  '/': 'Dashboard',
  '/projects': 'Projects',
  '/chat': 'Team Chat',
  '/planner': 'Planner',
  '/terminals': 'Terminals',
  '/ide': 'VS Code',
  '/opencode': 'opencode',
  '/opencode-studio': 'Opencode Studio',
  '/providers': 'Providers',
  '/team': 'Team',
  '/settings': 'Settings',
  '/profile': 'Profile',
};

function RouteTitle() {
  const [location] = useHashLocation();
  useEffect(() => {
    const path = (location || '/').split('?')[0].split('#')[0].replace(/\/+$/, '') || '/';
    let label = ROUTE_TITLES[path];
    if (!label && path.startsWith('/project/')) label = 'Project';
    if (!label && path.startsWith('/user/')) label = 'Profile';
    if (!label && path.startsWith('/terminals/')) label = 'Terminals';
    document.title = label ? `${label} — Madar` : 'Madar';
  }, [location]);
  return null;
}

function Shell() {
  const [location] = useHashLocation();
  const { user, loading } = useAuth();
  const { t } = useI18n();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // One-shot speculative chunk prefetch once the shell is up and the user is
  // known — never during the login/setup flow (no wasted bytes there).
  const prefetchedRef = useRef(false);
  useEffect(() => {
    if (loading || prefetchedRef.current) return;
    if (!user) return;
    prefetchedRef.current = true;
    prefetchLikelyChunks();
  }, [loading, user]);
  const layer = activeToolLayer(location);

  useEffect(() => {
    setSidebarOpen(false);
  }, [location]);

  // Global Ctrl+K / Cmd+K opens the command palette (authenticated only).
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  useEffect(() => {
    if (!user) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [user, openPalette]);

  if (loading) {
    return (
      <div class="app-view" style="display:flex;align-items:center;justify-content:center;height:100vh;">
        <div class="dim" style="font-size:0.85rem">{t('common.loading')}</div>
      </div>
    );
  }

  // Not logged in → redirect to login
  if (!user) {
    if (location === '/login') return <Login />;
    window.location.hash = '/login';
    return null;
  }

  // Logged in, but on /login → redirect to home
  if (location === '/login') {
    window.location.hash = '/';
    return null;
  }

  if (location.startsWith('/opencode-studio') && user.role === 'admin') {
    return <Suspense fallback={<div class="app-view" style="display:flex;align-items:center;justify-content:center;height:100vh;"><div class="dim" style="font-size:0.85rem">{t('common.loading')}</div></div>}><OpencodeStudio /></Suspense>;
  }

  if (location.startsWith('/agents')) {
    return <Suspense fallback={<div class="app-view" style="display:flex;align-items:center;justify-content:center;height:100vh;"><div class="dim" style="font-size:0.85rem">{t('common.loading')}</div></div>}><Agents /></Suspense>;
  }

  // The tool layers cover the whole viewport but never unmount the shell, so
  // everything under it would stay tabbable and visible to AT — ~18 invisible
  // controls behind a full-screen page. `inert` is the mechanism: aria-hidden
  // alone only hides from screen readers and leaves the keyboard free to walk
  // into the hidden chrome, whereas inert drops the whole subtree out of both
  // the tab order and the accessibility tree. Declared, not applied in an
  // effect, so it is already in place on the first paint of the layer and is
  // torn down the instant the layer closes. The skip link and the command
  // palette sit outside .app-view (as does the toast stack) and keep working.
  return (
    <>
      <a
        class="skip-link"
        href={layer ? `#${TOOL_MAIN_ID[layer]}` : '#main'}
        onClick={(e) => {
          // The app is hash-routed, so a plain fragment target would REPLACE
          // the route (/#/ide → #ide-main) and drop the user on an empty shell
          // instead of moving focus. Move focus to the landmark ourselves.
          e.preventDefault();
          const target = document.getElementById(layer ? TOOL_MAIN_ID[layer] : 'main');
          if (!target) return;
          target.focus();
          target.scrollIntoView();
        }}
      >
        {t('common.skipToContent')}
      </a>
      <div class="app-view" inert={layer !== null}>
        <div class={`sidebar-backdrop${sidebarOpen ? ' open' : ''}`} onClick={() => setSidebarOpen(false)} />
        <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
        <div class="mobile-topbar">
          <button class="menu-btn" aria-label={t('nav.openMenu')} onClick={() => setSidebarOpen(true)}>
            <Menu width={20} height={20} />
          </button>
          <span class="mobile-topbar-brand">Madar</span>
          <button
            class="menu-btn palette-trigger"
            aria-label={t('palette.title')}
            title={`${t('palette.title')} (Ctrl+K)`}
            onClick={() => setPaletteOpen(true)}
          >
            <Command width={16} height={16} />
          </button>
        </div>
        <main class="main" id="main" tabindex={-1}>
          <Suspense fallback={<div style="display:flex;align-items:center;justify-content:center;height:100%;"><div class="dim" style="font-size:0.85rem">{t('common.loading')}</div></div>}>
            <Route path="/" component={Dashboard} />
            <Route path="/projects" component={Projects} />
            <Route path="/chat" component={TeamChat} />
            <Route path="/planner" component={Planner} />
            <Route path="/project/:slug" component={Project} />
            <Route path="/terminals" component={Terminals} />
            <Route path="/terminals/:slug" component={Terminals} />
            {user?.role === 'admin' ? (
              <>
                <Route path="/providers" component={Providers} />
                <Route path="/team" component={Team} />
                <Route path="/opencode-studio" component={OpencodeStudio} />
              </>
            ) : (
              <>
                <Route path="/providers" component={AdminOnly} />
                <Route path="/team" component={AdminOnly} />
                <Route path="/opencode-studio" component={AdminOnly} />
              </>
            )}
            <Route path="/settings" component={Settings} />
            <Route path="/profile" component={Profile} />
            <Route path="/user/:id" component={UserProfile} />
          </Suspense>
        </main>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </>
  );
}

/**
 * Admin-only guard panel — rendered in place of the restricted routes
 * (/providers, /team) when the signed-in user is not an admin. Settings has
 * its own internal redirect guard and stays untouched.
 */
function AdminOnly() {
  return (
    <div
      class="page-container"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        paddingTop: '6rem',
        gap: '0.75rem',
      }}
    >
      <h1 class="sr-only">Admin only</h1>
      <ShieldAlert size={32} style={{ color: 'var(--text-secondary)' }} />
      <div style={{ fontWeight: 600, fontSize: '1.05rem' }}>Admin only</div>
      <div class="dim" style={{ fontSize: '0.85rem', maxWidth: 380, textAlign: 'center' }}>
        This page is restricted to administrators. Sign in with an admin account to manage it.
      </div>
    </div>
  );
}

/**
 * Keep-alive VS Code layer: once the user opens /#/ide the EmbeddedIDE stays
 * mounted for the whole session (hidden via display:none when navigating
 * away), so code-server never reloads between visits. Rendered as a sibling
 * of Shell — outside its early-return branches — and sits under the global
 * watermark (z-index 50 < 90).
 */
function IdeKeepAlive() {
  const [location] = useHashLocation();
  const { user } = useAuth();
  const wants = !!user && isToolRoute(location, '/ide');
  const [everOpened, setEverOpened] = useState(wants);
  // Background warm-up: the code-server frame is the heaviest first-load in the
  // app (~3.5s cold: a 19MB workbench bundle to download + parse), so once the
  // user is signed in we mount the IDE layer HIDDEN a few seconds after boot.
  // The workbench downloads/parses while they work in the dashboard, and the
  // first visit to /#/ide finds a ready frame instead of a spinner. Once the
  // IDE is really opened this flag is irrelevant (everOpened takes over).
  const [warmed, setWarmed] = useState(false);

  useEffect(() => {
    if (wants) setEverOpened(true);
  }, [wants]);

  useEffect(() => {
    if (!user || everOpened || wants) return;
    const t = setTimeout(() => setWarmed(true), 3500);
    return () => clearTimeout(t);
  }, [user, everOpened, wants]);

  if ((!everOpened && !warmed) || !user) return null;
  return (
    <Suspense fallback={null}>
      <div style={wants ? undefined : 'display: none'}>
        <EmbeddedIDE />
      </div>
    </Suspense>
  );
}

/**
 * Keep-alive opencode layer — same pattern as IdeKeepAlive: once /#/opencode
 * (or its /#/opencode/<directory> cold deep link) is opened the page stays
 * mounted (hidden while navigating elsewhere), so the opencode web session
 * never reloads between visits. The segment-aware match means
 * /opencode-studio can never land here, and a near-miss like /opencodefoo no
 * longer opens a chrome-less layer.
 */
function OpencodeKeepAlive() {
  const [location] = useHashLocation();
  const { user } = useAuth();
  const wants = !!user && isToolRoute(location, '/opencode', true);
  const [everOpened, setEverOpened] = useState(wants);

  useEffect(() => {
    if (wants) setEverOpened(true);
  }, [wants]);

  // Background warm-up — tiered behind the IDE (IdeKeepAlive mounts at +3.5 s;
  // this one at +5.5 s) so the two heavy frames never compete for bandwidth/
  // parse CPU in the same tick. The opencode web bundle ships with NO cache
  // headers and no compression (measured: 2.7 MB JS + 0.5 MB CSS raw), so this
  // hidden frame also fills the per-session HTTP cache — later first-visits
  // within the session reuse it instead of re-pulling megabytes. The component
  // itself gates the actual frame on its first honest status answer.
  const [warmed, setWarmed] = useState(false);

  useEffect(() => {
    if (!user || everOpened || wants) return;
    const t = setTimeout(() => setWarmed(true), 5500);
    return () => clearTimeout(t);
  }, [user, everOpened, wants]);

  if ((!everOpened && !warmed) || !user) return null;
  return (
    <Suspense fallback={null}>
      <div style={wants ? undefined : 'display: none'}>
        <Opencode />
      </div>
    </Suspense>
  );
}

export function App() {
  return (
    <ErrorBoundary>
      <I18nProvider>
        <ToastProvider>
          <AuthProvider>
            <Router hook={useHashLocation}>
              <RouteTitle />
              <Shell />
              <IdeKeepAlive />
              <OpencodeKeepAlive />
              <div class="watermark" aria-hidden="true">
                <img src="/logo.png" alt="" />
              </div>
            </Router>
          </AuthProvider>
        </ToastProvider>
      </I18nProvider>
    </ErrorBoundary>
  );
}
