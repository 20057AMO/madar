import { Component, type ComponentChildren } from 'preact';
import { lazy, Suspense } from 'preact/compat';
import { useState, useEffect, useCallback } from 'preact/hooks';
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

const Dashboard = lazy(() => import('./views/Dashboard').then(m => ({ default: m.Dashboard })));
const Projects = lazy(() => import('./views/Projects').then(m => ({ default: m.Projects })));
const Project = lazy(() => import('./views/Project').then(m => ({ default: m.Project })));
  const Opencode = lazy(() => import('./views/Opencode').then(m => ({ default: m.Opencode })));
  const OpencodeStudio = lazy(() => import('./views/OpencodeStudio').then(m => ({ default: m.OpencodeStudio })));
const Agents = lazy(() => import('./views/Agents').then(m => ({ default: m.Agents })));
const EmbeddedIDE = lazy(() => import('./views/EmbeddedIDE').then(m => ({ default: m.EmbeddedIDE })));
const Terminals = lazy(() => import('./views/Terminals').then(m => ({ default: m.Terminals })));
const Providers = lazy(() => import('./views/Providers').then(m => ({ default: m.Providers })));
const Settings = lazy(() => import('./views/Settings').then(m => ({ default: m.Settings })));
const Profile = lazy(() => import('./views/Profile').then(m => ({ default: m.Profile })));
const Team = lazy(() => import('./views/Team').then(m => ({ default: m.Team })));
const UserProfile = lazy(() => import('./views/UserProfile').then(m => ({ default: m.UserProfile })));
const Planner = lazy(() => import('./views/Planner').then(m => ({ default: m.Planner })));
const TeamChat = lazy(() => import('./views/Chat').then(m => ({ default: m.Chat })));


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
    const check = () => {
      getUpdates()
        .then((s) => {
          if (!alive) return;
          const applying = s.components.some((c) => c.updateRunning || UPDATE_RUNNING_STATES.includes(c.applyState));
          const available = s.components.some((c) => !c.updateRunning && c.upToDate === false && c.channelUnlocked !== false);
          setUpdatesFlag(applying ? 'applying' : available ? 'available' : 'none');
        })
        .catch(() => { /* silent — a failed probe must never disturb the UI */ });
    };
    check();
    const timer = setInterval(check, 15 * 60_000);
    const onVisible = () => { if (!document.hidden) check(); };
    window.addEventListener('pageshow', check);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener('pageshow', check);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [user?.role]);

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

function Shell() {
  const [location] = useHashLocation();
  const { user, loading } = useAuth();
  const { t } = useI18n();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

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

  return (
    <div class="app-view">
      <a class="skip-link" href="#main">{t('common.skipToContent')}</a>
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
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
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
  const wants = !!user && location.startsWith('/ide');
  const [everOpened, setEverOpened] = useState(wants);

  useEffect(() => {
    if (wants) setEverOpened(true);
  }, [wants]);

  if (!everOpened || !user) return null;
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
 * is opened the page stays mounted (hidden while navigating elsewhere), so
 * the opencode web session never reloads between visits. Note: /opencode
 * must NOT match /opencode-studio.
 */
function OpencodeKeepAlive() {
  const [location] = useHashLocation();
  const { user } = useAuth();
  const wants = !!user && location.startsWith('/opencode') && !location.startsWith('/opencode-studio');
  const [everOpened, setEverOpened] = useState(wants);

  useEffect(() => {
    if (wants) setEverOpened(true);
  }, [wants]);

  if (!everOpened || !user) return null;
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
