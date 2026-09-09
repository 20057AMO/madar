import { useState, useEffect, useRef } from 'preact/hooks';
import QRCode from 'qrcode';
import {
  Loader2,
  LogOut,
  Lock,
  LockOpen,
  KeyRound,
  Download,
  Upload,
  ShieldCheck,
  Smartphone,
  Settings as SettingsIcon,
  BellRing,
  Plus,
  Trash2,
  HardDrive,
  RefreshCw,
  UserRound,
  UserCheck,
  ImagePlus,
} from 'lucide-preact';
import { useAuth } from '../auth';
import {
  getProvidersLockStatus,
  setProvidersPassword,
  removeProvidersPassword,
  exportSettings,
  importSettings,
  clearProvidersUnlock,
  setProvidersUnlock,
  relockProviders,
  apiLogoutAll,
  getAuditLog,
  getTotpStatus,
  totpSetup,
  totpEnable,
  totpDisable,
  listWebhooks,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  testWebhook,
  getStorageMetrics,
  WEBHOOK_EVENTS,
  type AuditEntry,
  type BackupFile,
  type Webhook,
  type WebhookEvent,
  type WebhookInput,
  type StorageMetrics,
} from '../api';
import { getMyProfile, updateMyProfile, uploadAvatar, deleteMyAvatar, avatarUrl, type UserProfile } from '../api';
import { Avatar } from '../components/Avatar';
import { PwMeter } from '../components/PwMeter';
import { ReAuthModal } from '../components/ReAuthModal';
import { ConfirmModal } from '../components/ConfirmModal';
import { fmtBytes } from '../lib/size';

const APP_VERSION = 'BETA';

const AUDIT_LABELS: Record<string, string> = {
  setup: 'Account created',
  login: 'Sign in',
  'login-failed': 'Sign in failed',
  'logout-all': 'Signed out everywhere',
  'logout-all-failed': 'Sign-out-everywhere attempt failed',
  'password-change': 'Password changed',
  'password-change-failed': 'Password change failed',
  'providers-lock-change': 'Providers lock updated',
  'providers-lock-change-failed': 'Providers lock update failed',
  'providers-unlock': 'Providers page unlocked',
  'providers-unlock-failed': 'Providers unlock attempt failed',
  'providers-relock': 'Providers locked on all devices',
  '2fa-enabled': 'Two-factor authentication enabled',
  '2fa-enabled-failed': 'Two-factor enable attempt failed',
  '2fa-disabled': 'Two-factor authentication disabled',
  '2fa-disabled-failed': 'Two-factor disable attempt failed',
  'login-2fa-failed': 'Sign in blocked — wrong authenticator code',
  'backup-export': 'Backup exported',
  'backup-import': 'Backup imported',
  'project-ports': 'Project ports updated',
  'project-limits': 'Project resource limits updated',
  'container-crash': 'Container crash detected',
  'archive-delete': 'Trash entry deleted permanently',
  'archive-empty': 'Trash emptied',
  'archive-restore': 'Project restored from trash',
  'webhook-send': 'Webhook delivered',
  'webhook-send-failed': 'Webhook delivery failed',
  'webhook-config-change': 'Webhooks configuration changed',
  'profile-update': 'Profile updated',
  'avatar-upload': 'Profile photo uploaded',
  'avatar-remove': 'Profile photo removed',
};

type Msg = { type: 'ok' | 'err'; text: string } | null;

type SensitiveAction = 'save-lock' | 'disable-lock' | 'export' | 'import' | 'revoke-all' | '2fa-disable';

function fmtDate(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

interface WhRowProps {
  w: Webhook;
  onChanged: (msg: string) => void;
  onDelete: () => void;
}

/** One webhook editor row — self-contained local state, merged on Save. */
function WhRow({ w, onChanged, onDelete }: WhRowProps) {
  const [name, setName] = useState(w.name);
  const [url, setUrl] = useState(w.url);
  const [events, setEvents] = useState<WebhookEvent[]>([...w.events]);
  const [enabled, setEnabled] = useState(w.enabled);
  const [secret, setSecret] = useState('');
  const [clearSecret, setClearSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);

  const toggleEvent = (ev: WebhookEvent) => () =>
    setEvents((cur) => (cur.includes(ev) ? cur.filter((x) => x !== ev) : [...cur, ev]));

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const body: WebhookInput = { name, url, events, enabled };
      if (secret.trim()) body.secret = secret.trim();
      else if (clearSecret) body.secret = '';
      await updateWebhook(w.id, body);
      setSecret('');
      setClearSecret(false);
      onChanged(`Webhook '${name.trim()}' saved.`);
    } catch (err: any) {
      setMsg({ type: 'err', text: err.message || 'Failed to save webhook' });
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await testWebhook({ id: w.id });
      setMsg(
        r.ok
          ? { type: 'ok', text: `Test delivered — receiver answered HTTP ${r.status}.` }
          : { type: 'err', text: r.error || 'Test delivery failed' }
      );
    } catch (err: any) {
      setMsg({ type: 'err', text: err.message || 'Test delivery failed' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style="border:1px solid var(--border); border-radius:var(--radius); padding:10px 12px;">
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
        <input class="modern-input" style="max-width:190px" placeholder="Name" value={name} onInput={(e: any) => setName(e.currentTarget.value)} />
        <input class="modern-input" style="flex:1; min-width:260px" placeholder="https://…" value={url} onInput={(e: any) => setUrl(e.currentTarget.value)} />
        <label class="wh-event-label" style="white-space:nowrap">
          <input type="checkbox" checked={enabled} onChange={(e: any) => setEnabled(e.currentTarget.checked)} /> enabled
        </label>
        <button class="btn-ghost sm" onClick={test} disabled={busy}>Test</button>
        <button class="btn-primary sm" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        <button class="btn-ghost sm" style="color: var(--red)" onClick={onDelete} title="Delete webhook" aria-label="Delete webhook">
          <Trash2 width={13} height={13} class="icon" />
        </button>
      </div>
      <div style="margin-top:8px; display:flex; gap:12px; flex-wrap:wrap; align-items:center;">
        {WEBHOOK_EVENTS.map((ev) => (
          <label class="wh-event-label" key={ev}>
            <input type="checkbox" checked={events.includes(ev)} onChange={toggleEvent(ev)} /> {ev}
          </label>
        ))}
        {w.hasSecret && <span class="meta-chip" style="color:var(--text-3)">HMAC secret set</span>}
      </div>
      <div style="margin-top:8px; display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
        <input
          class="modern-input"
          type="password"
          style="max-width:300px"
          placeholder={w.hasSecret ? 'New signing secret (blank = keep current)' : 'Optional signing secret'}
          value={secret}
          onInput={(e: any) => setSecret(e.currentTarget.value)}
        />
        {(w.hasSecret || secret.trim()) && (
          <label class="wh-event-label" style="white-space:nowrap">
            <input type="checkbox" checked={clearSecret} onChange={(e: any) => setClearSecret(e.currentTarget.checked)} /> remove secret
          </label>
        )}
      </div>
      {msg && <div class={msg.type === 'ok' ? 'chat-save-msg' : 'login-error'} style="margin-top:6px">{msg.text}</div>}
    </div>
  );
}

export function Settings() {
  const { user, logout, refreshUser } = useAuth();

  // ── User profile (display name / email / bio / avatar) ──
  const [profile, setProfile] = useState<UserProfile>({});
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileMsg, setProfileMsg] = useState<Msg>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    getMyProfile()
      .then((r) => setProfile(r.profile || {}))
      .catch(() => {})
      .finally(() => setProfileLoading(false));
  }, []);

  // ── Change account password ──
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [pwLoading, setPwLoading] = useState(false);
  const [pwMsg, setPwMsg] = useState<Msg>(null);

  // ── Providers security lock ──
  const [lockEnabled, setLockEnabled] = useState<boolean | null>(null);
  const [lockFetchError, setLockFetchError] = useState(false);
  const [lockNewPw, setLockNewPw] = useState('');
  const [lockConfirmPw, setLockConfirmPw] = useState('');
  const [lockMsg, setLockMsg] = useState<Msg>(null);
  const pendingLockPw = useRef('');

  // ── Inactivity auto-logout ──
  type IdleChoice = 'off' | '30' | '60' | '120';
  const [idleChoice, setIdleChoice] = useState<IdleChoice>(() => {
    try {
      return (localStorage.getItem('wsd.idleTimeout') as IdleChoice) || 'off';
    } catch {
      return 'off';
    }
  });
  const [idleSaved, setIdleSaved] = useState(false);

  // ── Providers auto-relock on inactivity ──
  type RelockChoice = 'off' | '5' | '15' | '30';
  const [relockChoice, setRelockChoice] = useState<RelockChoice>(() => {
    try {
      return (localStorage.getItem('wsd.providersAutoRelock') as RelockChoice) || 'off';
    } catch {
      return 'off';
    }
  });
  const [relockSaved, setRelockSaved] = useState(false);

  // ── Backup ──
  const [backupMsg, setBackupMsg] = useState<Msg>(null);
  const pendingImportRef = useRef<BackupFile | null>(null);

  // ── Notifications / Webhooks (admin-only management) ──
  const [webhooks, setWebhooks] = useState<Webhook[] | null>(null);
  const [whMsg, setWhMsg] = useState<Msg>(null);
  const [whName, setWhName] = useState('');
  const [whUrl, setWhUrl] = useState('');
  const [whDelete, setWhDelete] = useState<Webhook | null>(null);
  const [whDeleting, setWhDeleting] = useState(false);

  // ── Disk usage / storage metrics (read-only, any authenticated user) ──
  const [storage, setStorage] = useState<StorageMetrics | null>(null);
  const [storageRefreshing, setStorageRefreshing] = useState(false);
  const [storageMsg, setStorageMsg] = useState<Msg>(null);

  useEffect(() => {
    if (user?.role !== 'admin') return;
    listWebhooks()
      .then((r) => setWebhooks(r.webhooks))
      .catch((err: any) => {
        setWhMsg({ type: 'err', text: err.message || 'Failed to load webhooks' });
        setWebhooks([]);
      });
  }, [user?.role]);

  useEffect(() => {
    let cancelled = false;
    getStorageMetrics()
      .then((r) => { if (!cancelled) setStorage(r); })
      .catch((err: any) => {
        if (!cancelled) setStorageMsg({ type: 'err', text: err.message || 'Failed to load storage metrics' });
      });
    return () => { cancelled = true; };
  }, []);

  const refreshStorage = async () => {
    if (storageRefreshing) return;
    setStorageRefreshing(true);
    setStorageMsg(null);
    try {
      const r = await getStorageMetrics(true);
      setStorage(r);
    } catch (err: any) {
      setStorageMsg({ type: 'err', text: err.message || 'Failed to refresh storage' });
    } finally {
      setStorageRefreshing(false);
    }
  };

  const whRefresh = async (okText?: string) => {
    try {
      const r = await listWebhooks();
      setWebhooks(r.webhooks);
      if (okText) setWhMsg({ type: 'ok', text: okText });
      else setWhMsg(null);
    } catch (err: any) {
      setWhMsg({ type: 'err', text: err.message || 'Failed to refresh webhooks' });
    }
  };

  const whAdd = async () => {
    if (!whName.trim() || !whUrl.trim()) {
      setWhMsg({ type: 'err', text: 'Webhook name and URL are required.' });
      return;
    }
    try {
      await createWebhook({ name: whName.trim(), url: whUrl.trim(), events: ['crash'], enabled: true });
      setWhName('');
      setWhUrl('');
      await whRefresh("Webhook added (subscribed to 'crash'). Edit events below if needed.");
    } catch (err: any) {
      setWhMsg({ type: 'err', text: err.message || 'Failed to add webhook' });
    }
  };

  const whConfirmDelete = async () => {
    if (!whDelete) return;
    setWhDeleting(true);
    try {
      await deleteWebhook(whDelete.id);
      setWhDelete(null);
      await whRefresh(`Webhook '${whDelete.name}' deleted.`);
    } catch (err: any) {
      setWhMsg({ type: 'err', text: err.message || 'Failed to delete webhook' });
    } finally {
      setWhDeleting(false);
    }
  };

  // ── Two-factor authentication (TOTP) ──
  const [totpEnabled, setTotpEnabled] = useState<boolean | null>(null);
  const [totpMsg, setTotpMsg] = useState<Msg>(null);
  const [totpEnrolling, setTotpEnrolling] = useState<{ secret: string; uri: string } | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [totpCode, setTotpCode] = useState('');
  const [totpBusy, setTotpBusy] = useState(false);

  useEffect(() => {
    getTotpStatus()
      .then((r) => setTotpEnabled(r.enabled))
      .catch(() => setTotpEnabled(null));
  }, []);

  // Render the provisioning URI as a QR image whenever enrollment starts.
  useEffect(() => {
    if (!totpEnrolling) { setQrDataUrl(''); return; }
    QRCode.toDataURL(totpEnrolling.uri, { width: 180, margin: 1 })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(''));
  }, [totpEnrolling]);

  const beginEnable2fa = async () => {
    setTotpMsg(null);
    setTotpBusy(true);
    try {
      const r = await totpSetup();
      setTotpEnrolling({ secret: r.secret, uri: r.uri });
      setTotpCode('');
    } catch (err: any) {
      setTotpMsg({ type: 'err', text: err.message || 'Could not start setup.' });
    } finally {
      setTotpBusy(false);
    }
  };

  const confirmEnable2fa = async (e: Event) => {
    e.preventDefault();
    if (!totpEnrolling || totpBusy) return;
    setTotpBusy(true);
    try {
      await totpEnable(totpCode.trim());
      setTotpEnabled(true);
      setTotpEnrolling(null);
      setTotpCode('');
      setTotpMsg({ type: 'ok', text: 'Two-factor authentication is now active.' });
      setTimeout(() => setTotpMsg(null), 4000);
      getAuditLog(AUDIT_PAGE, 0).then((r) => { setAudit(r.entries || []); setAuditTotal(r.total || 0); }).catch(() => {});
    } catch (err: any) {
      setTotpMsg({ type: 'err', text: err.message || 'Invalid code.' });
    } finally {
      setTotpBusy(false);
    }
  };

  const cancelEnable2fa = () => {
    setTotpEnrolling(null);
    setTotpCode('');
    setTotpMsg(null);
  };

  const beginDisable2fa = () => {
    setTotpMsg(null);
    setPendingAction('2fa-disable');
  };

  // ── Unified identity confirmation (sudo-style) ──
  const [pendingAction, setPendingAction] = useState<SensitiveAction | null>(null);
  const [reauthLoading, setReauthLoading] = useState(false);
  const [reauthError, setReauthError] = useState<string | null>(null);

  // ── Security activity ──
  const AUDIT_PAGE = 20;
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditLoadingMore, setAuditLoadingMore] = useState(false);

  useEffect(() => {
    getProvidersLockStatus()
      .then((r) => { setLockEnabled(r.enabled); setLockFetchError(false); })
      .catch(() => { setLockEnabled(null); setLockFetchError(true); });
    getAuditLog(AUDIT_PAGE, 0)
      .then((r) => { setAudit(r.entries || []); setAuditTotal(r.total || 0); })
      .catch(() => { setAudit([]); setAuditTotal(0); });
  }, []);

  const loadMoreAudit = async () => {
    if (!audit) return;
    setAuditLoadingMore(true);
    try {
      const r = await getAuditLog(AUDIT_PAGE, audit.length);
      setAudit((prev) => [...(prev || []), ...(r.entries || [])]);
      setAuditTotal(r.total || 0);
    } catch { /* ignore */ }
    setAuditLoadingMore(false);
  };

  // ════ Step 1 handlers: validate locally, then open the ReAuth dialog ════

  const beginSaveLock = (e: Event) => {
    e.preventDefault();
    if (!lockNewPw || !lockConfirmPw) {
      setLockMsg({ type: 'err', text: 'Fill in the new providers password and its confirmation.' });
      return;
    }
    if (lockNewPw !== lockConfirmPw) {
      setLockMsg({ type: 'err', text: 'New providers passwords do not match.' });
      return;
    }
    if (lockNewPw.length < 6) {
      setLockMsg({ type: 'err', text: 'Providers password must be at least 6 characters.' });
      return;
    }
    setLockMsg(null);
    pendingLockPw.current = lockNewPw;
    setPendingAction('save-lock');
  };

  const beginDisableLock = () => setPendingAction('disable-lock');

  const beginExport = () => {
    setBackupMsg(null);
    setPendingAction('export');
  };

  const beginImport = async (e: Event) => {
    e.preventDefault();
    const input = document.getElementById('import-file') as HTMLInputElement | null;
    const file = input?.files?.[0];
    if (!file) {
      setBackupMsg({ type: 'err', text: 'Choose a backup .json file first.' });
      return;
    }
    try {
      const parsed = JSON.parse(await file.text());
      if (parsed?.kind !== 'madar-backup' && parsed?.kind !== 'wsd-pro-backup') throw new Error('Not a Madar backup file.');
      pendingImportRef.current = parsed as BackupFile;
      setBackupMsg(null);
      setPendingAction('import');
    } catch (err: any) {
      setBackupMsg({ type: 'err', text: err.message || 'Invalid backup file.' });
    }
  };

  const beginRevokeAll = () => setPendingAction('revoke-all');

  // ════ Step 2: the ReAuth dialog confirmed — execute the real operation ════

  const executeReauth = async (accountPassword: string) => {
    if (!pendingAction) return;
    setReauthLoading(true);
    setReauthError(null);

    const fail = (msg: string, keepOpen: boolean) => {
      if (keepOpen) {
        setReauthError(msg);
        return;
      }
      // Route the failure message to exactly ONE panel — never duplicate it.
      setPendingAction(null);
      if (pendingAction === 'save-lock' || pendingAction === 'disable-lock') {
        setLockMsg({ type: 'err', text: msg });
      } else if (pendingAction === 'revoke-all') {
        setPwMsg({ type: 'err', text: msg });
      } else if (pendingAction === '2fa-disable') {
        setTotpMsg({ type: 'err', text: msg });
      } else {
        setBackupMsg({ type: 'err', text: msg });
      }
    };

    try {
      switch (pendingAction) {
        case 'save-lock': {
          const result = await setProvidersPassword(accountPassword, pendingLockPw.current);
          const wasEnabled = lockEnabled === true;
          setLockEnabled(true);
          setLockMsg({ type: 'ok', text: wasEnabled ? 'Providers password changed.' : 'Providers lock enabled.' });
          setTimeout(() => setLockMsg(null), 4000);
          // The server hands back a fresh unlock token for the new password —
          // store it so visiting Providers right away is open, not a lockout.
          if (result.unlockToken) {
            setProvidersUnlock(result.unlockToken, result.expiresInSec || 1800);
          } else {
            clearProvidersUnlock();
          }
          pendingLockPw.current = '';
          setLockNewPw('');
          setLockConfirmPw('');
          break;
        }
        case 'disable-lock': {
          await removeProvidersPassword(accountPassword);
          setLockEnabled(false);
          setLockMsg({ type: 'ok', text: 'Providers lock disabled.' });
          setTimeout(() => setLockMsg(null), 4000);
          clearProvidersUnlock();
          break;
        }
        case 'export': {
          const backup = await exportSettings(accountPassword);
          const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `madar-backup-${new Date().toISOString().slice(0, 10)}.json`;
          a.click();
          URL.revokeObjectURL(url);
          setBackupMsg({ type: 'ok', text: 'Backup downloaded (API keys excluded by design).' });
          break;
        }
        case 'import': {
          const backup = pendingImportRef.current;
          if (!backup) throw new Error('Import data is missing — pick the file again.');
          const result = await importSettings(accountPassword, backup);
          const total = Object.values(result.imported || {}).reduce((s, n) => s + n, 0);
          setBackupMsg({
            type: 'ok',
            text: `Imported ${total} item(s), skipped ${result.skipped} existing. Re-add provider API keys manually.`,
          });
          const input = document.getElementById('import-file') as HTMLInputElement | null;
          if (input) input.value = '';
          pendingImportRef.current = null;
          break;
        }
        case 'revoke-all': {
          await apiLogoutAll(accountPassword);
          logout();
          window.location.hash = '/login';
          break;
        }
        case '2fa-disable': {
          await totpDisable(accountPassword);
          setTotpEnabled(false);
          setTotpMsg({ type: 'ok', text: 'Two-factor authentication disabled.' });
          setTimeout(() => setTotpMsg(null), 4000);
          break;
        }
      }
      setPendingAction(null);
      // Security Activity reflects the operation that just succeeded.
      getAuditLog(AUDIT_PAGE, 0)
        .then((r) => { setAudit(r.entries || []); setAuditTotal(r.total || 0); })
        .catch(() => {});
    } catch (err: any) {
      const msg = err.message || 'Operation failed.';
      const isRetryable = err.status === 401 || err.status === 429 || (err.status === 400 && /password/i.test(msg));
      fail(msg, isRetryable);
    } finally {
      setReauthLoading(false);
    }
  };

  // ── Change account password (unchanged flow) ──
  const changePassword = async (e: Event) => {
    e.preventDefault();
    if (pwLoading) return;

    if (!currentPw || !newPw) {
      setPwMsg({ type: 'err', text: 'Please fill in all fields.' });
      return;
    }
    if (newPw !== confirmPw) {
      setPwMsg({ type: 'err', text: 'New passwords do not match.' });
      return;
    }
    if (newPw.length < 6) {
      setPwMsg({ type: 'err', text: 'New password must be at least 6 characters.' });
      return;
    }

    setPwLoading(true);
    setPwMsg(null);

    try {
      const token = localStorage.getItem('wsd.token');
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ currentPassword: currentPw, newPassword: newPw }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed');
      if (data.token) localStorage.setItem('wsd.token', data.token);
      setPwMsg({ type: 'ok', text: 'Password changed. Other devices were signed out.' });
      setCurrentPw('');
      setNewPw('');
      setConfirmPw('');
    } catch (err: any) {
      setPwMsg({ type: 'err', text: err.message || 'Failed' });
    } finally {
      setPwLoading(false);
    }
  };

  const applyIdleChoice = (value: IdleChoice) => {
    setIdleChoice(value);
    try {
      localStorage.setItem('wsd.idleTimeout', value);
    } catch { /* ignore */ }
    setIdleSaved(true);
    setTimeout(() => setIdleSaved(false), 2000);
  };

  const applyRelockChoice = (value: RelockChoice) => {
    setRelockChoice(value);
    try {
      localStorage.setItem('wsd.providersAutoRelock', value);
    } catch { /* ignore */ }
    setRelockSaved(true);
    setTimeout(() => setRelockSaved(false), 2000);
  };

  const handleLogout = () => {
    logout();
    window.location.hash = '/login';
  };

  // ── User profile handlers ────────────────────────────────────
  const saveProfile = async () => {
    setProfileSaving(true);
    setProfileMsg(null);
    try {
      const r = await updateMyProfile({
        displayName: profile.displayName?.trim() || '',
        email: profile.email?.trim() || '',
        bio: profile.bio?.trim() || '',
      });
      setProfile(r.profile || {});
      await refreshUser();
      setProfileMsg({ type: 'ok', text: 'Profile saved.' });
    } catch (err: any) {
      setProfileMsg({ type: 'err', text: err.message || 'Failed to save profile' });
    } finally {
      setProfileSaving(false);
    }
  };

  const pickAvatar = async (e: any) => {
    const file = e.target.files?.[0] as File | undefined;
    e.target.value = '';
    if (!file) return;
    setAvatarBusy(true);
    setProfileMsg(null);
    try {
      await uploadAvatar(file);
      const r = await getMyProfile();
      setProfile(r.profile || {});
      await refreshUser();
      setProfileMsg({ type: 'ok', text: 'Avatar updated.' });
    } catch (err: any) {
      setProfileMsg({ type: 'err', text: err.message || 'Upload failed' });
    } finally {
      setAvatarBusy(false);
    }
  };

  const removeAvatar = async () => {
    setAvatarBusy(true);
    setProfileMsg(null);
    try {
      await deleteMyAvatar();
      const r = await getMyProfile();
      setProfile(r.profile || {});
      await refreshUser();
      setProfileMsg({ type: 'ok', text: 'Avatar removed.' });
    } catch (err: any) {
      setProfileMsg({ type: 'err', text: err.message || 'Failed to remove avatar' });
    } finally {
      setAvatarBusy(false);
    }
  };

  return (
    <div class="view">
      <div class="hero">
        <span class="hero-badge"><SettingsIcon width={12} height={12} /> Settings</span>
        <h1 class="hero-title" style="font-size: 1.5rem">Settings</h1>
        <p class="hero-sub">Manage your account and application settings.</p>
      </div>

      {/* Profile */}
      <div class="panel settings-section">
        <h2 class="panel-title">
          <span class="icon-wrap"><UserRound width={14} height={14} /></span> Profile
        </h2>
        <p class="settings-hint">
          How you appear across the team — name, avatar, bio and contact.
        </p>
        {profileLoading && user ? (
          <div class="inline-loading"><Loader2 width={14} height={14} class="icon spin" /> Loading profile…</div>
        ) : (
          <>
            <div style="display: flex; align-items: center; gap: 14px; margin-bottom: 14px; flex-wrap: wrap;">
              <Avatar
                name={profile.displayName || user?.username || user?.id || 'user'}
                avatar={user ? avatarUrl(user.id, profile.avatarExt) : null}
                size={56}
              />
              <div style="display: flex; flex-direction: column; gap: 6px">
                <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                  <button class="btn-ghost sm" type="button" onClick={() => avatarInputRef.current?.click()} disabled={avatarBusy}>
                    <span class="icon-wrap">
                      {avatarBusy ? <Loader2 width={13} height={13} class="icon spin" /> : <ImagePlus width={13} height={13} />}
                    </span>
                    {profile.avatarExt ? 'Change photo' : 'Upload photo'}
                  </button>
                  {profile.avatarExt && (
                    <button class="btn-danger sm" type="button" onClick={removeAvatar} disabled={avatarBusy}>
                      {avatarBusy ? <Loader2 width={13} height={13} class="icon spin" /> : 'Remove'}
                    </button>
                  )}
                </div>
                <span class="settings-hint" style="margin: 0">PNG, JPEG or WebP · up to 2 MB</span>
              </div>
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                hidden
                onChange={pickAvatar}
                aria-label="Upload profile photo"
              />
            </div>

            <label class="field-label">Display name</label>
            <input
              class="modern-input"
              maxLength={60}
              placeholder="How you appear to the team"
              value={profile.displayName || ''}
              onInput={(e: any) => setProfile({ ...profile, displayName: e.target.value })}
            />

            <label class="field-label">Email</label>
            <input
              class="modern-input"
              type="email"
              maxLength={200}
              placeholder="you@example.com"
              value={profile.email || ''}
              onInput={(e: any) => setProfile({ ...profile, email: e.target.value })}
            />

            <label class="field-label">Bio</label>
            <textarea
              class="modern-input"
              rows={3}
              maxLength={500}
              placeholder="A short line about you — shown to the team."
              value={profile.bio || ''}
              onInput={(e: any) => setProfile({ ...profile, bio: e.target.value })}
            />

            {profileMsg && (
              <div class={profileMsg.type === 'ok' ? 'chat-save-msg' : 'login-error'} style="margin-top: 8px" role={profileMsg.type === 'ok' ? 'status' : 'alert'}>
                {profileMsg.text}
              </div>
            )}

            <div style="margin-top: 12px">
              <button class="btn-primary sm" type="button" onClick={saveProfile} disabled={profileSaving}>
                {profileSaving ? <Loader2 width={13} height={13} class="icon spin" /> : (
                  <>
                    <span class="icon-wrap"><UserCheck width={13} height={13} /></span> Save profile
                  </>
                )}
              </button>
            </div>
          </>
        )}
      </div>

      {/* Account Info */}
      <div class="panel settings-section">
        <h2 class="panel-title">Account</h2>
        <div class="settings-row">
          <span class="field-label">Username</span>
          <span class="mono" style="color: var(--text)">{user?.username || '—'}</span>
        </div>
        <div class="settings-row">
          <span class="field-label">Created</span>
          <span style="color: var(--text-2)">{fmtDate(user?.createdAt)}</span>
        </div>
        <div class="settings-row">
          <span class="field-label">Last password change</span>
          <span style="color: var(--text-2)">{fmtDate(user?.passwordChangedAt)}</span>
        </div>
        <div style="margin-top: 12px">
          <button class="btn-danger sm" onClick={handleLogout}>
            <span class="icon-wrap"><LogOut width={13} height={13} /></span> Logout
          </button>
        </div>
      </div>

      {/* Providers Security Lock — two-step flow */}
      <div class="panel settings-section">
        <h2 class="panel-title">
          <span class="icon-wrap"><KeyRound width={14} height={14} /></span> Providers Security
        </h2>
        <p class="settings-hint">
          Optional second-layer password guarding the Providers page.
        </p>
        <div class="settings-row">
          <span class="field-label">Status</span>
          {lockFetchError ? (
            <span class="badge-off"><Loader2 width={11} height={11} class="icon spin" /> Could not check — try refreshing</span>
          ) : lockEnabled === null ? (
            <span class="inline-loading"><Loader2 width={12} height={12} class="icon spin" /> Checking…</span>
          ) : lockEnabled ? (
            <span class="badge-ok"><Lock width={11} height={11} /> Enabled · stays open 30 min after entry</span>
          ) : (
            <span class="badge-off"><LockOpen width={11} height={11} /> Disabled — Providers open while signed in</span>
          )}
        </div>

        <form onSubmit={beginSaveLock}>
          <label class="field-label">
            {lockEnabled ? 'New Providers password' : 'Set Providers password'}
          </label>
          <input
            class="modern-input"
            type="password"
            placeholder="Min 6 characters"
            value={lockNewPw}
            onInput={(e: any) => setLockNewPw(e.target.value)}
          />
          {lockNewPw && <PwMeter pw={lockNewPw} />}

          <label class="field-label">Confirm Providers password</label>
          <input
            class="modern-input"
            type="password"
            placeholder="Repeat providers password"
            value={lockConfirmPw}
            onInput={(e: any) => setLockConfirmPw(e.target.value)}
          />

          {lockMsg && (
            <div class={lockMsg.type === 'ok' ? 'chat-save-msg' : 'login-error'} style="margin-top: 8px" role={lockMsg.type === 'ok' ? 'status' : 'alert'}>
              {lockMsg.text}
            </div>
          )}

          <div style="display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap;">
            <button class="btn-primary sm" type="submit">
              <span class="icon-wrap"><ShieldCheck width={13} height={13} /></span>
              {lockEnabled ? 'Change Providers password' : 'Enable lock'}
            </button>
            {lockEnabled && (
              <>
                <button class="btn-ghost sm" type="button" onClick={async () => {
                  try {
                    await relockProviders();
                    clearProvidersUnlock();
                    setLockMsg({ type: 'ok', text: 'Locked on all tabs and devices.' });
                  } catch {
                    setLockMsg({ type: 'err', text: 'Could not lock other devices.' });
                  }
                }}>
                  Lock now
                </button>
                <button class="btn-danger sm" type="button" onClick={beginDisableLock}>
                  Disable lock
                </button>
              </>
            )}
          </div>
          <p class="settings-hint" style="margin-top:10px;">
            You will confirm your identity with your account password in the next step.
          </p>
        </form>
      </div>

      {/* Logout everywhere */}
      <div class="panel settings-section">
        <h2 class="panel-title">Logout Everywhere</h2>
        <p class="settings-hint">
          Invalidate every signed-in session — all browser tabs and devices will
          need to log in again. You will be logged out here too.
        </p>
        {pwMsg && pendingAction === null && (
          <div class={pwMsg.type === 'ok' ? 'chat-save-msg' : 'login-error'} style="margin-bottom: 8px" role={pwMsg.type === 'ok' ? 'status' : 'alert'}>
            {pwMsg.text}
          </div>
        )}
        <button class="btn-danger sm" onClick={beginRevokeAll}>
          <span class="icon-wrap"><LogOut width={13} height={13} /></span> Sign out everywhere
        </button>
      </div>

      {/* Two-factor authentication (TOTP) */}
      <div class="panel settings-section">
        <h2 class="panel-title">
          Two-Factor Authentication
          {totpEnabled === true && (
            <span class="badge-ok" style="margin-inline-start: 8px;">
              <ShieldCheck width={11} height={11} /> On
            </span>
          )}
          {totpEnabled === false && (
            <span class="badge-off" style="margin-inline-start: 8px;">Off</span>
          )}
        </h2>
        <p class="settings-hint">
          Require a 6-digit code from an authenticator app (Google Authenticator,
          Authy, Aegis…) after your password at every sign-in.
        </p>

        {totpMsg && (
          <div class={totpMsg.type === 'ok' ? 'chat-save-msg' : 'login-error'} style="margin-bottom: 8px" role={totpMsg.type === 'ok' ? 'status' : 'alert'}>
            {totpMsg.text}
          </div>
        )}

        {totpEnrolling ? (
          <form onSubmit={confirmEnable2fa}>
            <div class="totp-enroll">
              {qrDataUrl && <img class="totp-qr" src={qrDataUrl} alt="Authenticator QR code" />}
              <div class="totp-manual">
                <span class="field-label">Can't scan? Enter this key instead</span>
                <code class="totp-secret">{totpEnrolling.secret}</code>
                <span class="settings-hint">Time-based · SHA-1 · 6 digits · 30s — defaults for any app.</span>
              </div>
            </div>
            <div class="settings-row" style="margin-top: 10px;">
              <input
                class="modern-input login-otp"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="000000"
                maxLength={7}
                autoFocus
                value={totpCode}
                onInput={(e: any) => setTotpCode(e.target.value)}
              />
              <button class="btn-primary sm" type="submit" disabled={totpBusy || !totpCode.trim()}>
                {totpBusy ? <Loader2 width={13} height={13} class="icon spin" /> : <ShieldCheck width={13} height={13} />} Activate
              </button>
              <button class="btn-ghost sm" type="button" onClick={cancelEnable2fa}>Cancel</button>
            </div>
            <p class="settings-hint" style="margin-top:8px;">
              Scan the code with your app, then enter the current code to activate.
            </p>
          </form>
        ) : totpEnabled === true ? (
          <button class="btn-danger sm" onClick={beginDisable2fa}>
            <Smartphone width={13} height={13} /> Disable two-factor
          </button>
        ) : (
          <button class="btn-primary sm" onClick={beginEnable2fa} disabled={totpBusy}>
            {totpBusy ? <Loader2 width={13} height={13} class="icon spin" /> : <Smartphone width={13} height={13} />}
            Enable two-factor
          </button>
        )}
      </div>

      {/* Auto-logout on inactivity */}
      <div class="panel settings-section">
        <h2 class="panel-title">Idle security</h2>
        <p class="settings-hint">
          Sign out automatically after a period of inactivity — and optionally re-lock
          the Providers page (revokes its unlock token everywhere).
        </p>
        <div class="settings-row">
          <span class="field-label">Auto-logout</span>
          <select
            class="modern-input"
            style="max-width: 160px"
            value={idleChoice}
            onChange={(e: any) => applyIdleChoice(e.target.value as IdleChoice)}
          >
            <option value="off">Disabled</option>
            <option value="30">30 minutes</option>
            <option value="60">1 hour</option>
            <option value="120">2 hours</option>
          </select>
          {idleSaved && <span class="chat-save-msg" role="status">Saved ✓</span>}
        </div>
        <div class="settings-row">
          <span class="field-label">Auto-relock Providers</span>
          <select
            class="modern-input"
            style="max-width: 160px"
            value={relockChoice}
            onChange={(e: any) => applyRelockChoice(e.target.value as RelockChoice)}
          >
            <option value="off">Disabled</option>
            <option value="5">5 minutes</option>
            <option value="15">15 minutes</option>
            <option value="30">30 minutes</option>
          </select>
          {relockSaved && <span class="chat-save-msg" role="status">Saved ✓</span>}
        </div>
      </div>

      {/* Notifications / Webhooks */}
      <div class="panel settings-section">
        <h2 class="panel-title"><span class="icon-wrap"><BellRing width={14} height={14} /></span> Notifications &amp; Webhooks</h2>
        <p class="settings-hint">
          Forward container lifecycle and crash events to an external URL (Slack, Discord, Telegram, a status page…).
          Crashes are detected by the server even when no browser is open. When a signing secret is set, every POST
          carries an <code>X-Madar-Signature</code> HMAC header so receivers can verify the sender.
        </p>

        {whMsg && (
          <div class={whMsg.type === 'ok' ? 'chat-save-msg' : 'login-error'} style="margin-bottom: 8px" role={whMsg.type === 'ok' ? 'status' : 'alert'}>
            {whMsg.text}
          </div>
        )}

        {user?.role !== 'admin' ? (
          <div class="dim" style="margin-top: 4px">Only admins can manage webhooks.</div>
        ) : (
          <>
            <div style="display: flex; gap: 8px; margin-top: 4px; flex-wrap: wrap; align-items: center;">
              <input
                class="modern-input"
                placeholder="Webhook name"
                style="max-width: 190px"
                value={whName}
                onInput={(e: any) => setWhName(e.currentTarget.value)}
              />
              <input
                class="modern-input"
                placeholder="https://hooks.slack.com/…"
                style="flex: 1; min-width: 260px; max-width: 380px"
                value={whUrl}
                onInput={(e: any) => setWhUrl(e.currentTarget.value)}
              />
              <button class="btn-primary sm" onClick={whAdd}>
                <span class="icon-wrap"><Plus width={13} height={13} /></span> Add
              </button>
            </div>

            {webhooks === null ? (
              <div class="dim" style="margin-top: 12px" role="status">Loading webhooks…</div>
            ) : webhooks.length === 0 ? (
              <div class="dim" style="margin-top: 12px">
                No webhooks — crashes and lifecycle events are still shown in-app.
              </div>
            ) : (
              <div style="display: flex; flex-direction: column; gap: 10px; margin-top: 12px;">
                {webhooks.map((w) => (
                  <WhRow key={w.id} w={w} onChanged={(msg) => void whRefresh(msg)} onDelete={() => setWhDelete(w)} />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Storage / disk usage */}
      <div class="panel settings-section">
        <h2 class="panel-title" style="display:flex;align-items:center;justify-content:space-between">
          <span>Storage</span>
          <button class="btn-ghost sm" onClick={refreshStorage} disabled={storageRefreshing}>
            {storageRefreshing ? <Loader2 width={13} height={13} class="icon spin" /> : <RefreshCw width={13} height={13} class="icon" />}
            Refresh
          </button>
        </h2>
        <p class="settings-hint">
          Disk usage across workspaces, snapshot archives and Docker. Read-only snapshot — refresh forces a rescan.
        </p>
        {storageMsg && (
          <div class={storageMsg.type === 'ok' ? 'chat-save-msg' : 'login-error'} style="margin-bottom:8px" role={storageMsg.type === 'ok' ? 'status' : 'alert'}>{storageMsg.text}</div>
        )}
        {storage == null ? (
          <div class="dim" role="status">Loading storage metrics…</div>
        ) : (
          <>
            <div class="storage-totals">
              <div class="storage-total"><span>Workspaces</span><b>{fmtBytes(storage.totalWorkspaceBytes)}</b></div>
              <div class="storage-total"><span>Snapshot archives</span><b>{fmtBytes(storage.totalSnapshotBytes)}</b></div>
              <div class="storage-total"><span>Data directory</span><b>{fmtBytes(storage.dataDirBytes)}</b></div>
              <div class="storage-total"><span>Containers (writable)</span><b>{fmtBytes(storage.containerWritableBytes)}</b></div>
              {storage.docker.system && (
                <div class="storage-total"><span>Docker total</span><b>{fmtBytes(storage.docker.system.totalBytes)}</b></div>
              )}
            </div>
            <div class="dim" style="font-size:0.75rem;margin:14px 0 6px">Per project</div>
            <div class="table-scroll">
              <table class="storage-table">
              <thead>
                <tr><th>Project</th><th>Workspace</th><th>Snapshots</th><th>Container</th></tr>
              </thead>
              <tbody>
                {storage.projects.length === 0 && (
                  <tr><td colspan={4} class="dim">No projects — storage is idle.</td></tr>
                )}
                {storage.projects.map((p) => (
                  <tr key={p.slug}>
                    <td class="storage-name"><HardDrive width={12} height={12} class="icon" /> {p.name}<span class="dim">{p.slug}</span></td>
                    <td>{fmtBytes(p.workspaceBytes)}</td>
                    <td>{fmtBytes(p.snapshotBytes)}</td>
                    <td>{p.container ? fmtBytes(p.container.writableBytes) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            {storage.docker.system && (
              <p class="settings-hint" style="font-size:0.72rem;margin-top:10px">
                Docker totals — images {fmtBytes(storage.docker.system.imagesBytes)} · containers {fmtBytes(storage.docker.system.containersBytes)} ·
                volumes {fmtBytes(storage.docker.system.volumesBytes)} · build cache {fmtBytes(storage.docker.system.buildCacheBytes)}
              </p>
            )}
          </>
        )}
      </div>

      {/* Backup / Restore */}
      <div class="panel settings-section">
        <h2 class="panel-title">Backup &amp; Restore</h2>
        <p class="settings-hint">
          Export agents, sessions, provider configs and chat preferences as JSON.
          <strong> API keys are never included.</strong> Import merges new items only.
        </p>

        {backupMsg && (
          <div class={backupMsg.type === 'ok' ? 'chat-save-msg' : 'login-error'} style="margin-bottom: 8px" role={backupMsg.type === 'ok' ? 'status' : 'alert'}>
            {backupMsg.text}
          </div>
        )}

        <div style="display: flex; gap: 10px; margin-top: 4px; flex-wrap: wrap; align-items: center;">
          <button class="btn-primary sm" onClick={beginExport}>
            <span class="icon-wrap"><Download width={13} height={13} /></span> Export backup
          </button>
          <form onSubmit={beginImport} style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
            <input id="import-file" type="file" accept=".json,application/json" class="modern-file" />
            <button class="btn-ghost sm" type="submit">
              <span class="icon-wrap"><Upload width={13} height={13} /></span> Import
            </button>
          </form>
        </div>
      </div>

      {/* Change Password */}
      <div class="panel settings-section">
        <h2 class="panel-title">Change Password</h2>
        <form onSubmit={changePassword}>
          <label class="field-label">Current Password</label>
          <input
            class="modern-input"
            type="password"
            placeholder="Current password"
            value={currentPw}
            onInput={(e: any) => setCurrentPw(e.target.value)}
          />

          <label class="field-label">New Password</label>
          <input
            class="modern-input"
            type="password"
            placeholder="Min 6 characters"
            value={newPw}
            onInput={(e: any) => setNewPw(e.target.value)}
          />
          {newPw && <PwMeter pw={newPw} />}

          <label class="field-label">Confirm New Password</label>
          <input
            class="modern-input"
            type="password"
            placeholder="Confirm new password"
            value={confirmPw}
            onInput={(e: any) => setConfirmPw(e.target.value)}
          />

          {pwMsg && (
            <div class={pwMsg.type === 'ok' ? 'chat-save-msg' : 'login-error'} style="margin-top: 8px" role={pwMsg.type === 'ok' ? 'status' : 'alert'}>
              {pwMsg.text}
            </div>
          )}

          <div style="margin-top: 12px">
            <button class="btn-primary sm" type="submit" disabled={pwLoading}>
              {pwLoading ? (
                <span style="display:inline-flex;align-items:center;gap:6px;">
                  <Loader2 width={13} height={13} class="icon spin" /> Changing…
                </span>
              ) : 'Change Password'}
            </button>
          </div>
        </form>
      </div>

      {/* Security Activity */}
      <div class="panel settings-section">
        <h2 class="panel-title">Security Activity</h2>
        <p class="settings-hint">Recent security-related events (newest first, last 50).</p>
        {audit === null ? (
          <div class="inline-loading" role="status"><Loader2 width={12} height={12} class="icon spin" /> Loading…</div>
        ) : audit.length === 0 ? (
          <div class="settings-hint">No activity recorded yet.</div>
        ) : (
          <div class="audit-list">
            {audit.map((e, i) => {
              const label = AUDIT_LABELS[e.event] || e.event;
              const failed = !e.ok || e.event.endsWith('-failed');
              return (
                <div class="audit-row" key={`${e.ts}-${i}`}>
                  <span class={failed ? 'audit-dot bad' : 'audit-dot good'} title={failed ? 'Failed' : 'Success'} />
                  <span class="audit-label">{label}</span>
                  {e.ip && <span class="audit-ip" title="Source IP">{e.ip}</span>}
                  <span class="audit-time">{fmtDate(e.ts)}</span>
                </div>
              );
            })}
            {audit.length < auditTotal && (
              <button
                class="btn-ghost sm"
                style="width: 100%; margin-top: 8px; justify-content: center;"
                onClick={loadMoreAudit}
                disabled={auditLoadingMore}
              >
                {auditLoadingMore ? 'Loading…' : `Show more (${auditTotal - audit.length} remaining)`}
              </button>
            )}
          </div>
        )}
      </div>

      {/* About */}
      <div class="panel settings-section">
        <h2 class="panel-title">About</h2>
        <div class="settings-row">
          <span class="field-label">Version</span>
          <span class="mono beta-chip" title="Beta software — features and data format may change">{APP_VERSION}</span>
        </div>
        <div class="settings-row">
          <span class="field-label">License</span>
          <span style="color: var(--text-2)">MIT</span>
        </div>
      </div>

      {/* Combined identity confirmation */}
      <ConfirmModal
        open={!!whDelete}
        danger
        title={whDelete ? `Delete webhook '${whDelete.name}'?` : 'Delete webhook?'}
        message="Crash and lifecycle events will stop being forwarded to this URL."
        confirmLabel="Delete"
        loading={whDeleting}
        onConfirm={whConfirmDelete}
        onCancel={() => setWhDelete(null)}
      />
      <ReAuthModal
        open={pendingAction !== null}
        username={user?.username}
        loading={reauthLoading}
        error={reauthError}
        title={
          pendingAction === 'revoke-all'
            ? 'Sign out everywhere?'
            : pendingAction === 'disable-lock'
              ? 'Disable Providers lock'
              : pendingAction === '2fa-disable'
                ? 'Disable two-factor authentication'
                : pendingAction === 'save-lock'
                  ? (lockEnabled ? 'Change Providers password' : 'Enable Providers lock')
                  : pendingAction === 'import'
                    ? 'Import backup'
                    : 'Export backup'
        }
        description={
          pendingAction === 'revoke-all'
            ? 'This signs you out of every device and browser tab.'
            : pendingAction === 'disable-lock'
              ? 'This removes the second password — anyone using this session will be able to open Providers.'
              : pendingAction === '2fa-disable'
                ? 'Your account will be protected by the password only. You will confirm this with your account password.'
                : 'Enter your account password to authorize this action.'
        }
        confirmLabel="Confirm"
        onConfirm={executeReauth}
        onCancel={() => { setPendingAction(null); setReauthError(null); pendingLockPw.current = ''; }}
      />
    </div>
  );
}
