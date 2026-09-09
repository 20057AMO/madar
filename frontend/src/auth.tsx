import { createContext, type ComponentChildren } from 'preact';
import { useState, useEffect, useContext, useCallback } from 'preact/hooks';
import { relockProviders, clearProvidersUnlock, type UserProfile } from './api';

interface AuthUser {
  id: string;
  username: string;
  role: 'admin' | 'editor' | 'viewer';
  createdAt: string;
  passwordChangedAt?: string;
  profile?: UserProfile;
}

interface AuthState {
  user: AuthUser | null;
  token: string | null;
  loading: boolean;
  hasUser: boolean;
  login: (username: string, password: string) => Promise<{ requires2fa?: boolean }>;
  verify2fa: (code: string) => Promise<void>;
  cancel2fa: () => void;
  /** True between a password-verified login and the authenticator-code step. */
  pending2fa: boolean;
  setup: (username: string, password: string) => Promise<void>;
  logout: () => void;
  /** Re-fetch the current user (profile edits, etc.) and update the context. */
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  user: null,
  token: null,
  loading: true,
  hasUser: false,
  login: async () => ({}),
  verify2fa: async () => {},
  cancel2fa: () => {},
  pending2fa: false,
  setup: async () => {},
  logout: () => {},
  refreshUser: async () => {},
});

export function useAuth(): AuthState {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: ComponentChildren }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasUser, setHasUser] = useState(false);
  const [pending2faToken, setPending2faToken] = useState<string | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem('wsd.token');
    if (stored) {
      setToken(stored);
      fetch('/api/auth/status', { headers: { Authorization: `Bearer ${stored}` } })
        .then((r) => r.json())
        .then((data) => {
          if (data.user) {
            setUser(data.user);
            setHasUser(true);
          } else {
            localStorage.removeItem('wsd.token');
            setToken(null);
            setHasUser(data.hasUser || false);
          }
        })
        .catch(() => {
          localStorage.removeItem('wsd.token');
          setToken(null);
        })
        .finally(() => setLoading(false));
    } else {
      fetch('/api/auth/status')
        .then((r) => r.json())
        .then((data) => setHasUser(data.hasUser || false))
        .catch(() => {})
        .finally(() => setLoading(false));
    }
  }, []);

  const refreshUser = useCallback(async () => {
    const stored = localStorage.getItem('wsd.token');
    if (!stored) return;
    try {
      const res = await fetch('/api/auth/status', { headers: { Authorization: `Bearer ${stored}` } });
      const data = await res.json();
      if (data?.user) setUser(data.user);
    } catch {
      /* keep the current user — a fresh leak here is not worth a logout */
    }
  }, []);

  const doLogin = useCallback(async (username: string, password: string) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    // Correct password + 2FA on → hold the pending token; the session is
    // only issued after the authenticator-code step (verify2fa).
    if (data.requires2fa && data.pendingToken) {
      setPending2faToken(String(data.pendingToken));
      return { requires2fa: true };
    }
    localStorage.setItem('wsd.token', data.token);
    setToken(data.token);
    setUser({ id: data.id, username: data.username, role: data.role || 'editor', createdAt: '' });
    setHasUser(true);
    await refreshUser();
    return {};
  }, [refreshUser]);

  const verify2fa = useCallback(async (code: string) => {
    if (!pending2faToken) throw new Error('No pending sign-in. Start again.');
    const res = await fetch('/api/auth/login/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pendingToken: pending2faToken, code }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Invalid code');
    setPending2faToken(null);
    localStorage.setItem('wsd.token', data.token);
    setToken(data.token);
    setUser({ id: data.id, username: data.username, role: data.role || 'editor', createdAt: '' });
    setHasUser(true);
    await refreshUser();
  }, [pending2faToken, refreshUser]);

  const cancel2fa = useCallback(() => setPending2faToken(null), []);

  const doSetup = useCallback(async (username: string, password: string) => {
    const res = await fetch('/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Setup failed');
    localStorage.setItem('wsd.token', data.token);
    setToken(data.token);
    setUser({ id: data.id, username: data.username, role: data.role || 'admin', createdAt: '' });
    setHasUser(true);
    await refreshUser();
  }, [refreshUser]);

  const logout = useCallback(() => {
    localStorage.removeItem('wsd.token');
    setToken(null);
    setUser(null);
  }, []);

  // ── Auto-logout on inactivity ─────────────────────────────────
  // Reads the idle timeout (minutes) from localStorage ('wsd.idleTimeout':
  // 'off' | '30' | '60' | '120'). Activity events throttle-refresh the clock.
  useEffect(() => {
    if (!token) return;

    let limitMs = 0;
    const readLimit = () => {
      try {
        const raw = localStorage.getItem('wsd.idleTimeout');
        if (!raw || raw === 'off') { limitMs = 0; return; }
        limitMs = Math.max(1, parseInt(raw, 10) || 0) * 60_000;
      } catch { limitMs = 0; }
    };
    readLimit();

    let lastActivity = Date.now();
    let throttled = false;
    const markActive = () => {
      if (throttled) return;
      throttled = true;
      lastActivity = Date.now();
      setTimeout(() => { throttled = false; }, 5_000);
    };

    const events = ['mousemove', 'keydown', 'click', 'touchstart', 'scroll'];
    events.forEach((ev) => window.addEventListener(ev, markActive, { passive: true }));

    // Re-read limit when another tab changes the setting
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'wsd.idleTimeout') readLimit();
    };
    window.addEventListener('storage', onStorage);

    const checker = setInterval(() => {
      if (limitMs <= 0) return;
      if (Date.now() - lastActivity > limitMs) {
        clearInterval(checker);
        events.forEach((ev) => window.removeEventListener(ev, markActive));
        window.removeEventListener('storage', onStorage);
        localStorage.removeItem('wsd.token');
        setToken(null);
        setUser(null);
        window.location.hash = '/login';
      }
    }, 15_000);

    return () => {
      clearInterval(checker);
      events.forEach((ev) => window.removeEventListener(ev, markActive));
      window.removeEventListener('storage', onStorage);
    };
  }, [token]);

  // ── Auto-relock Providers on inactivity ───────────────────────
  // Mirrors auto-logout: reads 'wsd.providersAutoRelock' ('off' | '5' |
  // '15' | '30' minutes), activity events throttle-refresh the clock, and
  // the storage event keeps tabs in sync. On expiry it revokes every
  // unlock token server-side and clears the local copy. No-ops server-side
  // when the providers lock is not enabled.
  useEffect(() => {
    if (!token) return;

    let limitMs = 0;
    const readLimit = () => {
      try {
        const raw = localStorage.getItem('wsd.providersAutoRelock');
        if (!raw || raw === 'off') { limitMs = 0; return; }
        limitMs = Math.max(1, parseInt(raw, 10) || 0) * 60_000;
      } catch { limitMs = 0; }
    };
    readLimit();

    let lastActivity = Date.now();
    let throttled = false;
    const markActive = () => {
      if (throttled) return;
      throttled = true;
      lastActivity = Date.now();
      setTimeout(() => { throttled = false; }, 5_000);
    };

    const events = ['mousemove', 'keydown', 'click', 'touchstart', 'scroll'];
    events.forEach((ev) => window.addEventListener(ev, markActive, { passive: true }));

    const onStorage = (e: StorageEvent) => {
      if (e.key === 'wsd.providersAutoRelock') readLimit();
    };
    window.addEventListener('storage', onStorage);

    const checker = setInterval(() => {
      if (limitMs <= 0) return;
      if (Date.now() - lastActivity > limitMs) {
        clearInterval(checker);
        events.forEach((ev) => window.removeEventListener(ev, markActive));
        window.removeEventListener('storage', onStorage);
        // Leave a per-tab breadcrumb so the Providers page can explain WHY it
        // just locked ("after inactivity") instead of a silent gate.
        try { sessionStorage.setItem('wsd.providers.autoRelocked', '1'); } catch { /* ignore */ }
        relockProviders().catch(() => {});
        clearProvidersUnlock();
      }
    }, 15_000);

    return () => {
      clearInterval(checker);
      events.forEach((ev) => window.removeEventListener(ev, markActive));
      window.removeEventListener('storage', onStorage);
    };
  }, [token]);

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        loading,
        hasUser,
        login: doLogin,
        verify2fa,
        cancel2fa,
        pending2fa: !!pending2faToken,
        setup: doSetup,
        logout,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
