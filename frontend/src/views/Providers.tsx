import { useState, useEffect, useRef } from 'preact/hooks';
import {
  Loader2,
  KeyRound,
  Lock,
  LockOpen,
  ShieldCheck,
  Plus,
  Timer,
} from 'lucide-preact';
import { ConfirmModal } from '../components/ConfirmModal';
import {
  getProviders,
  getProviderTemplates,
  detectProvider,
  createProvider,
  updateProvider,
  testProvider,
  deleteProvider,
  getProvidersLockStatus,
  unlockProviders,
  getProvidersUnlock,
  setProvidersUnlock,
  clearProvidersUnlock,
  relockProviders,
  UNLOCK_KEY,
  type ProviderInfo,
  type ProviderType,
  type KnownTemplate,
} from '../api';

const TYPE_LABEL: Record<ProviderType, string> = {
  ollama: 'Ollama',
  openai: 'OpenAI-compatible',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  azure: 'Azure OpenAI',
};

// Last-known lock state from the server. Lets the page render the unlock gate
// on the VERY FIRST paint (before any network round-trip) when protection is
// on and no valid local token exists — provider data can never flash.
const LOCK_KNOWN_KEY = 'wsd.providers.lockEnabled';

function cachedLockEnabled(): boolean | null {
  try {
    const v = localStorage.getItem(LOCK_KNOWN_KEY);
    if (v === '1') return true;
    if (v === '0') return false;
  } catch { /* storage unavailable */ }
  return null;
}

function storeLockEnabled(enabled: boolean): void {
  try { localStorage.setItem(LOCK_KNOWN_KEY, enabled ? '1' : '0'); } catch { /* ignore */ }
}

export function Providers() {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // Lock state: null = still checking. If the cached truth says a lock is
  // enabled and no valid unlock token exists locally, start GATED — the
  // strictest possible default that never leaks a single frame of content.
  const [locked, setLocked] = useState<boolean | null>(() =>
    cachedLockEnabled() === true && !getProvidersUnlock() ? true : null
  );
  const [lockConfigured, setLockConfigured] = useState<boolean | null>(null);
  const [unlockPw, setUnlockPw] = useState('');
  const [unlockLoading, setUnlockLoading] = useState(false);
  const [unlockErr, setUnlockErr] = useState<string | null>(null);
  const [, forceTick] = useState(0);
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const [relockWarn, setRelockWarn] = useState<string | null>(null);
  const [unlockNotice, setUnlockNotice] = useState<{ type: 'ok' | 'info'; text: string } | null>(null);
  // Why the gate is showing right now — so an unexpected lock is never silent.
  const [lockReason, setLockReason] = useState<'idle' | 'expired' | null>(null);

  const refresh = async () => {
    try {
      const { providers: list } = await getProviders();
      setProviders(list);
      setLocked(false);
      setError(null);
    } catch (err: any) {
      handleMaybeLocked(err);
    }
  };

  const [dirtyCount, setDirtyCount] = useState(0);

  // Warn before page refresh / tab close when cards have unsaved edits.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyCount > 0) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirtyCount]);

  /**
   * Single funnel for every providers_locked response — whether it comes
   * from the initial load, a card toggle/test/delete, or the add-provider
   * modal. Flips the whole page to the unlock gate instead of leaking raw
   * error text into small message slots.
   */
  const handleMaybeLocked = (err: any): boolean => {
    if (err?.code === 'providers_locked') {
      // A providers_locked response PROVES a lock exists server-side — sync
      // the cached truth so future page opens gate instantly.
      storeLockEnabled(true);
      setLockConfigured(true);
      clearProvidersUnlock();
      setProviders([]);
      setLocked(true);
      return true;
    }
    setError(err?.message || 'Failed to load providers');
    return false;
  };

  useEffect(() => {
    let cancelled = false;
    getProvidersLockStatus()
      .then((r) => {
        if (cancelled) return;
        storeLockEnabled(r.enabled);
        setLockConfigured(r.enabled);
        if (r.enabled && !getProvidersUnlock()) {
          setLocked(true);
        } else {
          refresh();
        }
        // First-visit guidance: when no lock password exists yet, explain what
        // this page protects and offer to enable it. Shown once per browser.
        if (!r.enabled) {
          try {
            if (!localStorage.getItem('wsd.providers.onboarded')) setWelcomeOpen(true);
          } catch { /* storage unavailable */ }
        }
      })
      .catch(() => { if (!cancelled) refresh(); });
    return () => { cancelled = true; };
  }, []);

  const dismissWelcome = () => {
    setWelcomeOpen(false);
    try { localStorage.setItem('wsd.providers.onboarded', '1'); } catch { /* ignore */ }
  };

  // Esc dismisses the welcome modal.
  useEffect(() => {
    if (!welcomeOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismissWelcome();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [welcomeOpen]);

  // Countdown ticker while unlocked — re-render every 30s so the badge stays honest.
  useEffect(() => {
    if (locked !== false) return;
    const t = setInterval(() => forceTick((n: number) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [locked]);

  // Auto-lock the view the moment the stored unlock expires. Checked every
  // second, and again whenever the tab becomes visible or is restored from
  // bfcache — an expired token must never leave content on screen, even
  // briefly after sleep/wake or back/forward navigation.
  useEffect(() => {
    if (locked !== false) return;
    const recheck = () => {
      if (!getProvidersUnlock()) {
        setLockReason('expired');
        setLocked(true);
        setProviders([]);
      }
    };
    const onVisible = () => { if (!document.hidden) recheck(); };
    const t = setInterval(recheck, 1000);
    window.addEventListener('pageshow', recheck);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(t);
      window.removeEventListener('pageshow', recheck);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [locked]);

  // Success/info notices fade out on their own.
  useEffect(() => {
    if (!unlockNotice) return;
    const t = setTimeout(() => setUnlockNotice(null), 6000);
    return () => clearTimeout(t);
  }, [unlockNotice]);

  // When the gate appears, explain WHY: idle auto-relock leaves a per-tab
  // breadcrumb in auth.tsx; a locally-detected token expiry sets 'expired'.
  useEffect(() => {
    if (locked !== true) return;
    let idle = false;
    try {
      idle = sessionStorage.getItem('wsd.providers.autoRelocked') === '1';
      sessionStorage.removeItem('wsd.providers.autoRelocked');
    } catch { /* ignore */ }
    if (idle) setLockReason((cur) => cur ?? 'idle');
  }, [locked]);

  // Cross-tab sync: when another tab unlocks or locks, follow along.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== UNLOCK_KEY && e.key !== null) return;
      const has = getProvidersUnlock();
      if (!has && lockConfigured) {
        setLocked(true);
        setProviders([]);
      } else if (has) {
        setLockReason(null);
        setLocked(false);
        refresh();
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [lockConfigured]);

  const doUnlock = async (e: Event) => {
    e.preventDefault();
    if (unlockLoading || !unlockPw) return;
    setUnlockLoading(true);
    setUnlockErr(null);
    try {
      // skipAuthRedirect keeps a wrong providers password INLINE — the global
      // session-expiry handler must never fire for this endpoint.
      const res = await unlockProviders(unlockPw);
      if (res.unlocked && !res.unlockToken) {
        // Server has no providers password — explain instead of silently
        // letting "any word" unlock the gate.
        storeLockEnabled(false);
        setLockConfigured(false);
        setUnlockPw('');
        setLocked(false);
        setUnlockNotice({
          type: 'info',
          text: 'No providers password is set — protection is off. You can enable it from Settings → Providers Security.',
        });
        await refresh();
        return;
      }
      if (!res.unlockToken) throw new Error('Incorrect providers password.');
      const minutes = Math.max(1, Math.round((res.expiresInSec || 1800) / 60));
      setProvidersUnlock(res.unlockToken, res.expiresInSec || 1800);
      storeLockEnabled(true);
      setLockConfigured(true);
      setUnlockPw('');
      setUnlockErr(null);
      setLockReason(null);
      setLocked(false);
      setUnlockNotice({ type: 'ok', text: `Unlocked · ${minutes} min` });
      await refresh();
    } catch (err: any) {
      // Wrong password, cooldown, network — all stay on this page with an
      // inline message. The session is untouched.
      setUnlockErr(err?.message || 'Unlock failed');
    } finally {
      setUnlockLoading(false);
    }
  };

  const lockNow = async () => {
    // True global lock: the server bumps its token version so every
    // outstanding unlock token — in any tab or device — dies instantly.
    let serverLocked = true;
    try {
      const r = await relockProviders();
      if (!r.locked) serverLocked = false;
    } catch {
      serverLocked = false;
    }
    clearProvidersUnlock();
    setProviders([]);
    setUnlockNotice(null);
    setLockReason(null);
    setLocked(true);
    if (!serverLocked) {
      setRelockWarn(
        'Locked locally, but the server could not lock other devices. You can re-lock from Settings → Providers Security.'
      );
    }
  };

  // ── Checking state: skeleton shimmer instead of a bare "Loading…" ──
  if (locked === null) {
    return (
      <div class="view">
        <div class="hero">
          <span class="hero-badge"><KeyRound width={12} height={12} /> Providers</span>
          <h1 class="hero-title" style="font-size: 1.5rem">Providers</h1>
          <p class="hero-sub">
            Manage any chat provider (Ollama, OpenRouter, OpenAI, Google AI Studio, Anthropic,
            Groq, DeepSeek…). Paste an API key — everything else is detected automatically.
          </p>
        </div>
        <div class="providers-grid" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <div class="panel skel-card" key={i}>
              <div class="skel-line w40" />
              <div class="skel-line w80" />
              <div class="skel-line w60" />
              <div style="display:flex; gap:8px; margin-top:14px;">
                <span class="skel-chip" />
                <span class="skel-chip" />
              </div>
            </div>
          ))}
        </div>
<div class="inline-loading" style="justify-content:center; margin-top:18px;" role="status">
          <Loader2 width={14} height={14} class="icon spin" /> Checking providers…
        </div>
      </div>
    );
  }

  // ── Locked gate: page context (hero) with the unlock card beneath it ──
  if (locked === true) {
    return (
      <div class="view">
        <div class="hero">
          <span class="hero-badge"><KeyRound width={12} height={12} /> Providers</span>
          <h1 class="hero-title" style="font-size: 1.5rem">Providers</h1>
          <p class="hero-sub">
            {lockReason === 'idle'
              ? 'Auto-relocked after inactivity — enter the Providers password to continue.'
              : lockReason === 'expired'
                ? 'Your unlock window ended — enter the Providers password to continue.'
                : 'Protection is enabled for this page.'}
          </p>
        </div>
        <div class="modal-overlay static-overlay">
          <form class="modal-card unlock-card" onSubmit={doUnlock}>
            <div class="reauth-avatar" aria-hidden="true"><Lock width={24} height={24} /></div>
            <div class="reauth-title" style="text-align:center;">Providers locked</div>
            <p class="settings-hint" style="text-align:center;">
              A second-layer password protects your API keys. Enter the
              Providers password — the page stays open for 30 minutes.
              A wrong attempt keeps you signed in.
            </p>
            <input
              class="modern-input"
              type="password"
              placeholder="Providers password"
              autoFocus
              value={unlockPw}
              onInput={(e: any) => setUnlockPw(e.target.value)}
            />
            {unlockErr && <div class="login-error" style="text-align:center" role="alert">{unlockErr}</div>}
            <button class="btn-primary sm" type="submit" disabled={unlockLoading || !unlockPw} style="width:100%;">
              {unlockLoading ? (
                <span style="display:inline-flex;align-items:center;gap:6px;">
                  <Loader2 width={14} height={14} class="icon spin" /> Checking…
                </span>
              ) : (
                <span style="display:inline-flex;align-items:center;gap:6px;">
                  <LockOpen width={14} height={14} /> Unlock
                </span>
              )}
            </button>
            <p class="settings-hint" style="margin-top:10px; text-align:center;">
              Forgot it? Reset it from{' '}
              <a href="#/settings" style="color: var(--accent)">Settings → Providers Security</a>{' '}
              using your account password.
            </p>
          </form>
        </div>
        {relockWarn && (
          <div class="login-error" style="max-width: 360px; text-align: center; margin-top: 12px;" role="alert">
            {relockWarn}
          </div>
        )}
      </div>
    );
  }

  const unlockLeft = getProvidersUnlock();
  const minutesLeft = unlockLeft ? Math.max(0, Math.ceil((unlockLeft.expiresAt - Date.now()) / 60_000)) : 0;

  return (
    <div class="view">
      <div class="hero">
        <span class="hero-badge"><KeyRound width={12} height={12} /> Providers</span>
        <h1 class="hero-title" style="font-size: 1.5rem">Providers</h1>
        <p class="hero-sub">
          Manage any chat provider (Ollama, OpenRouter, OpenAI, Google AI Studio, Anthropic,
          Groq, DeepSeek…). Paste an API key — the provider, host and name are detected
          automatically in the background. Changes take effect immediately — no restart needed.
        </p>
      </div>

      <div style="display: flex; justify-content: flex-end; gap: 8px; margin-bottom: 14px; align-items: center;">
        {minutesLeft > 0 && (
          <span class="badge-ok unlock-countdown" title="Time remaining before this page locks again">
            <Timer width={11} height={11} /> unlocked · {minutesLeft} min left
          </span>
        )}
        {lockConfigured && (
          <button class="btn-ghost sm" onClick={lockNow} title="Lock on all tabs and devices">
            <span class="icon-wrap"><Lock width={13} height={13} /></span> Lock now
          </button>
        )}
        <button class="btn-primary sm" onClick={() => setAdding(true)}>
          <span class="icon-wrap"><Plus width={13} height={13} /></span> Add provider
        </button>
      </div>

      {unlockNotice && (
        <div class={`chat-save-msg${unlockNotice.type === 'info' ? ' unlock-info-note' : ''}`} style="margin-bottom: 12px" role="status">
          {unlockNotice.text}
        </div>
      )}

      {error && <div class="chat-save-msg" style="margin-bottom: 12px" role="alert">{error}</div>}

      <div class="providers-grid">
        {providers.map((p) => (
          <ProviderCard key={p.id} provider={p} onChanged={refresh} onDeleted={refresh} onLocked={handleMaybeLocked} onDirtyChange={setDirtyCount} />
        ))}
      </div>

      {adding && <AddProviderModal onClose={() => setAdding(false)} onAdded={async () => { await refresh(); setAdding(false); }} onLocked={handleMaybeLocked} />}

      {/* First-visit guidance while no lock password is configured */}
      {welcomeOpen && lockConfigured === false && (
        <div class="modal-overlay" onMouseDown={(e: any) => { if (e.target === e.currentTarget) dismissWelcome(); }}>
          <div class="modal-card reauth-card" role="dialog" aria-label="Protect your API keys">
            <div class="reauth-avatar" aria-hidden="true"><ShieldCheck width={26} height={26} /></div>
            <div class="reauth-title" style="text-align:center;">Protect your API keys</div>
            <p class="settings-hint" style="text-align:center;">
              This page stores provider API keys. You can add a second-layer password so that
              opening this page requires a quick unlock — even while you are signed in.
            </p>
            <div style="display:flex; gap:8px; margin-top:8px; justify-content:center; flex-wrap:wrap;">
              <a href="#/settings" class="btn-primary sm" style="text-decoration:none;" onClick={dismissWelcome}>
                <span class="icon-wrap"><ShieldCheck width={13} height={13} /></span> Enable protection
              </a>
              <button class="btn-ghost sm" onClick={dismissWelcome}>Not now</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ProviderCard({
  provider,
  onChanged,
  onDeleted,
  onLocked,
  onDirtyChange,
}: {
  provider: ProviderInfo;
  onChanged: () => void;
  onDeleted: () => void;
  onLocked: (err: any) => boolean;
  onDirtyChange: (delta: number) => void;
}) {
  const [name, setName] = useState(provider.name);
  const [host, setHost] = useState(provider.host);
  const [key, setKey] = useState('');
  const [enabled, setEnabled] = useState(provider.enabled);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ok: boolean; msg: string} | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const busyRef = useRef(false);

  // Track dirty state: true if any field differs from the original provider prop.
  const isDirty = name !== provider.name || host !== provider.host || key !== '' || enabled !== provider.enabled;
  const wasDirtyRef = useRef(false);
  useEffect(() => {
    if (isDirty && !wasDirtyRef.current) { wasDirtyRef.current = true; onDirtyChange(1); }
    if (!isDirty && wasDirtyRef.current) { wasDirtyRef.current = false; onDirtyChange(-1); }
  }, [isDirty]);
  useEffect(() => () => { if (wasDirtyRef.current) onDirtyChange(-1); }, []);

  // Sync with prop changes (cross-tab update, parent refresh).
  useEffect(() => { setName(provider.name); }, [provider.name]);
  useEffect(() => { setHost(provider.host); }, [provider.host]);
  useEffect(() => { setEnabled(provider.enabled); }, [provider.enabled]);

  const save = async () => {
    if (busyRef.current || saving) return;
    busyRef.current = true;
    setSaving(true);
    setError(null);
    setSaved(false);
    setTestResult(null);
    try {
      await updateProvider(provider.id, {
        name,
        host,
        ...(key.trim() ? { apiKey: key.trim() } : {}),
        enabled,
      });
      setSaved(true);
      setKey('');
      onChanged();
      setTimeout(() => setSaved(false), 2500);
    } catch (err: any) {
      if (onLocked(err)) return;
      setError(err.message);
    } finally {
      setSaving(false);
      busyRef.current = false;
    }
  };

  const test = async () => {
    if (busyRef.current || testing) return;
    busyRef.current = true;
    setTesting(true);
    setTestResult(null);
    try {
      const r = await testProvider(provider.id);
      const msg = r.ok
        ? `✓ Connected (${r.modelCount ?? 0} models) • key verified`
        : `✗ Failed${r.status ? ` (HTTP ${r.status})` : ''}${r.error ? ` — ${r.error}` : ''}`;
      setTestResult({ ok: r.ok, msg });
      if (r.ok) setTimeout(() => setTestResult(null), 5000);
    } catch (err: any) {
      if (onLocked(err)) return;
      setTestResult({ ok: false, msg: `✗ ${err.message}` });
    } finally {
      setTesting(false);
      busyRef.current = false;
    }
  };

  const remove = () => setConfirmDelete(true);

  const runDelete = async () => {
    if (busyRef.current || deleting) return;
    busyRef.current = true;
    setDeleting(true);
    try {
      await deleteProvider(provider.id);
      onDeleted();
    } catch (err: any) {
      if (onLocked(err)) return;
      setError(err.message);
      setDeleting(false);
      busyRef.current = false;
    }
  };

  return (
    <div class={`panel provider-card${saving || deleting ? ' card-busy' : ''}`}>
      <div class="provider-head">
        <div class="provider-title">
          <div class="provider-name">{provider.name}</div>
          <div class="provider-id mono">{provider.id}</div>
        </div>
        <div style="display: flex; align-items: center; gap: 10px">
          <span class="provider-type">{TYPE_LABEL[provider.type]}</span>
          <label class="provider-toggle">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e: any) => setEnabled(e.target.checked)}
            />
            <span>{enabled ? 'Enabled' : 'Disabled'}</span>
          </label>
        </div>
      </div>

      <label class="field-label">Name</label>
      <input class="modern-input" dir="auto" value={name} onInput={(e: any) => setName(e.target.value)} />

      <label class="field-label">Host / Base URL</label>
      <input class="modern-input" dir="auto" value={host} onInput={(e: any) => setHost(e.target.value)} />

      <label class="field-label">API key</label>
      {provider.apiKeyMasked ? (
        <div class="key-row">
          <span class="key-masked mono">{provider.apiKeyMasked}</span>
          <input
            class="modern-input key-replace"
            type="password"
            placeholder="Replace key…"
            value={key}
            onInput={(e: any) => setKey(e.target.value)}
          />
        </div>
      ) : (
        <input
          class="modern-input"
          type="password"
          placeholder="API key (optional)"
          value={key}
          onInput={(e: any) => setKey(e.target.value)}
        />
      )}

{error && <div class="login-error" role="alert">{error}</div>}
      {saved && <div class="chat-save-msg" role="status">Saved ✓</div>}

      <div class="provider-actions">
        <button class="btn-ghost sm" onClick={test} disabled={testing}>
          {testing ? 'Testing…' : 'Test'}
        </button>
        <button class="btn-primary sm" onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button class="btn-danger sm" onClick={remove} disabled={deleting}>
          {deleting ? 'Deleting…' : 'Delete'}
        </button>
      </div>

      {testResult && (
        <div class={`terminal-line ${testResult.ok ? 't-ok' : 'login-error'}`} style="margin-top: 8px" role={testResult.ok ? 'status' : 'alert'}>{testResult.msg}</div>
      )}

      <ConfirmModal
        open={confirmDelete}
        danger
        loading={deleting}
        title={`Delete provider '${provider.name}'?`}
        message="The configuration and its stored API key are removed."
        confirmLabel="Delete"
        onConfirm={runDelete}
        onCancel={() => { if (!deleting) setConfirmDelete(false); }}
      />
    </div>
  );
}

type DetectState = 'idle' | 'probing' | 'ok' | 'fail';

function AddProviderModal({ onClose, onAdded, onLocked }: { onClose: () => void; onAdded: () => void; onLocked: (err: any) => boolean }) {
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [host, setHost] = useState('');
  const [type, setType] = useState<ProviderType>('openai');
  const [enabled, setEnabled] = useState(true);
  const [templates, setTemplates] = useState<KnownTemplate[]>([]);
  const [detectState, setDetectState] = useState<DetectState>('idle');
  const [detectMsg, setDetectMsg] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  const seqRef = useRef(0);
  const nameAutoRef = useRef(false);
  const keyTimerRef = useRef<number | null>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    getProviderTemplates()
      .then(({ templates: list }) => setTemplates(list))
      .catch(() => {});
    return () => {
      if (keyTimerRef.current) window.clearTimeout(keyTimerRef.current);
      seqRef.current += 1;
    };
  }, []);

  // Esc closes the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Background auto-detect: fires ~600ms after the key settles (debounce).
  useEffect(() => {
    const key = apiKey.trim();
    if (keyTimerRef.current) window.clearTimeout(keyTimerRef.current);
    if (key.length < 6) {
      setDetectState('idle');
      setDetectMsg(null);
      return;
    }
    const seq = ++seqRef.current;
    keyTimerRef.current = window.setTimeout(() => {
      setDetectState('probing');
      setDetectMsg(null);
      setShowAdvanced(false);
      detectProvider({ apiKey: key })
        .then((r) => {
          if (seqRef.current !== seq) return;
          if (r.provider) {
            setHost(r.provider.host);
            setType(r.provider.type);
            if (!name.trim() || nameAutoRef.current) {
              setName(r.provider.name);
              nameAutoRef.current = true;
            }
            setDetectState('ok');
            setDetectMsg(`✓ Detected: ${r.provider.name} (${r.provider.modelCount} models)`);
          } else {
            setDetectState('fail');
            setDetectMsg('✗ Not detected from this key.');
            setShowAdvanced(true);
          }
        })
        .catch((err: any) => {
          if (seqRef.current !== seq) return;
          setDetectState('fail');
          setDetectMsg(`✗ ${err.message}`);
          setShowAdvanced(true);
        });
    }, 600);
    return () => {
      if (keyTimerRef.current) window.clearTimeout(keyTimerRef.current);
    };
  }, [apiKey, retryNonce]);

  const retryDetect = () => {
    setDetectState('probing');
    setDetectMsg(null);
    setShowAdvanced(false);
    setRetryNonce((n) => n + 1);
  };

  const applyTemplate = (tname: string) => {
    const t = templates.find((x) => x.name === tname);
    if (!t) return;
    setHost(t.host);
    setType(t.type);
    if (!name.trim() || nameAutoRef.current) {
      setName(t.name);
      nameAutoRef.current = true;
    }
    setDetectState('ok');
    setDetectMsg(`✓ ${t.name}`);
    setShowAdvanced(true);
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    const key = apiKey.trim();
    const h = host.trim();
    if (!name.trim() || saving || busyRef.current) return;
    if (!h && !key) {
      setError('Paste an API key to auto-detect, or open Advanced to set the host.');
      return;
    }
    busyRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await createProvider({
        name: name.trim(),
        ...(h ? { host: h, type } : {}),
        ...(key ? { apiKey: key } : {}),
        enabled,
      });
      onAdded();
    } catch (err: any) {
      if (onLocked(err)) return;
      if (err.code === 'detection_required') {
        setShowAdvanced(true);
        setDetectState('fail');
        setDetectMsg('✗ Could not auto-detect — pick a template above or enter the host manually.');
      }
      setError(err.message || 'Failed to add provider');
      setSaving(false);
      busyRef.current = false;
    }
  };

  const statusLabel = () => {
    if (detectState === 'probing') return '⏳ Probing known providers…';
    return null;
  };

  return (
    <div class="modal-overlay">
      <form class="modal-card" onSubmit={submit}>
        <div class="modal-title">Add provider</div>
        <div class="modal-sub">
          Paste your API key — everything else is detected automatically.
        </div>

        <label class="field-label">API key</label>
        <input
          class="modern-input"
          type="password"
          placeholder="sk-… / AIza… / gsk_… / ollama_…"
          autoFocus
          value={apiKey}
          onInput={(e: any) => setApiKey(e.target.value)}
        />

        <div class="detect-row">
          {statusLabel() && <div class="detect-status">{statusLabel()}</div>}
          {detectMsg && <div class={`detect-status ${detectState === 'ok' ? 'detect-ok' : detectState === 'fail' ? 'detect-fail' : ''}`}>{detectMsg}</div>}
          {detectState === 'fail' && (
            <div class="detect-quick-picks">
              <span class="detect-quick-label">Quick pick:</span>
              {templates.filter((t) => !t.host.includes('host.docker.internal')).map((t) => (
                <button key={t.name} class="btn-ghost sm" type="button" onClick={() => applyTemplate(t.name)}>
                  {t.name}
                </button>
              ))}
            </div>
          )}
          {detectState === 'fail' && (
            <button class="btn-ghost sm" type="button" onClick={retryDetect}>
              ↻ Retry
            </button>
          )}
        </div>

        <label class="field-label">Name</label>
        <input
          class="modern-input"
          dir="auto"
          placeholder="My Provider"
          value={name}
          onInput={(e: any) => { setName(e.target.value); nameAutoRef.current = false; }}
        />

        <details
          class="advanced-box"
          open={showAdvanced}
          onToggle={(e: any) => setShowAdvanced(e.target.open)}
        >
          <summary>Advanced (host / type)</summary>
          <label class="field-label">Template</label>
          <select class="modern-input" value="" onChange={(e: any) => applyTemplate(e.target.value)}>
            <option value="" disabled>Choose a known provider…</option>
            {templates.filter((t) => !t.host.includes('host.docker.internal')).map((t) => (
              <option key={t.name} value={t.name}>{t.name}</option>
            ))}
          </select>

          <label class="field-label">Host / Base URL</label>
          <input
            class="modern-input"
            dir="auto"
            placeholder={type === 'azure' ? 'https://YOUR-RESOURCE.openai.azure.com' : 'https://api.example.com/v1'}
            value={host}
            onInput={(e: any) => {
              setHost(e.target.value);
              if (detectState === 'ok') {
                setDetectState('idle');
                setDetectMsg(null);
              }
            }}
          />
          {type === 'azure' && (
            <div class="field-hint">
              Azure: Host = your resource endpoint (<code>*.openai.azure.com</code>). Models are picked from
              your <b>deployments</b> later in chat/agent settings.
            </div>
          )}

          <div class="add-provider-row">
            <label class="chat-settings-label">
              <span>Type</span>
              <select class="modern-input chat-sel" value={type} onChange={(e: any) => setType(e.target.value as ProviderType)}>
                <option value="openai">OpenAI-compatible</option>
                <option value="ollama">Ollama</option>
                <option value="anthropic">Anthropic</option>
                <option value="gemini">Gemini (native)</option>
                <option value="azure">Azure OpenAI</option>
              </select>
            </label>
            <label class="provider-toggle" style="align-self: flex-end">
              <input type="checkbox" checked={enabled} onChange={(e: any) => setEnabled(e.target.checked)} />
              <span>Enabled</span>
            </label>
          </div>
        </details>

        {error && <div class="login-error">{error}</div>}

        <div style="display: flex; gap: 8px; margin-top: 14px; justify-content: flex-end">
          <button class="btn-ghost sm" type="button" onClick={onClose}>Cancel</button>
          <button class="btn-primary sm" type="submit" disabled={saving || !name.trim()}>
            {saving ? 'Adding…' : 'Add provider'}
          </button>
        </div>
      </form>
    </div>
  );
}




