import { Component, type ComponentChildren } from 'preact';
import { lazy, Suspense } from 'preact/compat';
import { useState, useEffect } from 'preact/hooks';
import { Router, Route } from 'wouter';
import { useHashLocation } from 'wouter/use-hash-location';
import {
  LayoutDashboard,
  FolderOpen,
  Bot,
  KeyRound,
  Settings as SettingsIcon,
  Unlock,
  Users,
  PencilRuler,
  Menu,
} from 'lucide-preact';
import { AuthProvider, useAuth } from './auth';
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
} from './api';
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
const Team = lazy(() => import('./views/Team').then(m => ({ default: m.Team })));
const Planner = lazy(() => import('./views/Planner').then(m => ({ default: m.Planner })));


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
      <span>{label}</span>
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
      <button class="unlock-badge" title="Providers page is unlocked — click to re-lock" onClick={relock}>
        <Unlock width={11} height={11} />
        <span>Providers · {mins}m</span>
      </button>
      <ConfirmModal
        open={askRelock}
        title="Re-lock Providers now?"
        message="Every open tab loses access to the Providers page immediately."
        confirmLabel="Lock now"
        onConfirm={runRelock}
        onCancel={() => setAskRelock(false)}
      />
    </>
  );
}

function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user } = useAuth();
  const [ocPort, setOcPort] = useState(4096);

  useEffect(() => {
    getOpencodeStatus()
      .then((s) => {
        if (s?.port) setOcPort(s.port);
      })
      .catch(() => {});
  }, []);

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
        <NavButton href="/" label="Dashboard" icon={LayoutDashboard} />
        <NavButton href="/projects" label="Projects" icon={FolderOpen} />
        <NavButton href="/planner" label="Planner" icon={PencilRuler} />
        <NavButton href="/agents" label="Agents" icon={Bot} />
        <NavButton label="opencode" icon={OpencodeIcon} newTabUrl={`${toolBase}:${ocPort}/`} />
        <NavButton href="/opencode-studio" label="OC Studio" icon={OpencodeIcon} />
        <NavButton href="/providers" label="Providers" icon={KeyRound} />
        {user?.role === 'admin' && <NavButton href="/team" label="Team" icon={Users} />}
        <NavButton href="/settings" label="Settings" icon={SettingsIcon} />
        <NavButton href="/ide" label="VS Code" icon={VSCodeIcon} />
      </nav>
      <div class="sidebar-footer">
        <ProvidersUnlockBadge />
        <div class="sys-row">
          <span class="sys-dot ok" />
          {user?.profile?.displayName || user?.username || 'authenticated'}
          {user && <Avatar name={user.profile?.displayName || user.username} avatar={avatarUrl(user.id, user.profile?.avatarExt)} size={20} />}
          <span class="beta-chip" title="Beta software — features and data format may change">BETA</span>
        </div>
      </div>
    </aside>
  );
}

function Shell() {
  const [location] = useHashLocation();
  const { user, loading } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    setSidebarOpen(false);
  }, [location]);

  if (loading) {
    return (
      <div class="app-view" style="display:flex;align-items:center;justify-content:center;height:100vh;">
        <div class="dim" style="font-size:0.85rem">Loading…</div>
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

  if (location.startsWith('/opencode-studio')) {
    return <Suspense fallback={<div class="app-view" style="display:flex;align-items:center;justify-content:center;height:100vh;"><div class="dim" style="font-size:0.85rem">Loading…</div></div>}><OpencodeStudio /></Suspense>;
  }

  if (location.startsWith('/agents')) {
    return <Suspense fallback={<div class="app-view" style="display:flex;align-items:center;justify-content:center;height:100vh;"><div class="dim" style="font-size:0.85rem">Loading…</div></div>}><Agents /></Suspense>;
  }

  return (
    <div class="app-view">
      <a class="skip-link" href="#main">Skip to content</a>
      <div class={`sidebar-backdrop${sidebarOpen ? ' open' : ''}`} onClick={() => setSidebarOpen(false)} />
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div class="mobile-topbar">
        <button class="menu-btn" aria-label="Open menu" onClick={() => setSidebarOpen(true)}>
          <Menu width={20} height={20} />
        </button>
        <span class="mobile-topbar-brand">Madar</span>
      </div>
      <main class="main" id="main" tabindex={-1}>
        <Suspense fallback={<div style="display:flex;align-items:center;justify-content:center;height:100%;"><div class="dim" style="font-size:0.85rem">Loading…</div></div>}>
          <Route path="/" component={Dashboard} />
          <Route path="/projects" component={Projects} />
        <Route path="/planner" component={Planner} />
          <Route path="/project/:slug" component={Project} />
          <Route path="/terminals" component={Terminals} />
          <Route path="/terminals/:slug" component={Terminals} />
          <Route path="/providers" component={Providers} />
          <Route path="/settings" component={Settings} />
          <Route path="/team" component={Team} />
        </Suspense>
      </main>
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
    </ErrorBoundary>
  );
}
