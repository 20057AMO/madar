import { useState, useEffect, useRef } from 'preact/hooks';
import {
  Loader2,
  Lock,
  LockOpen,
  KeyRound,
  Download,
  Upload,
  ShieldCheck,
  Settings as SettingsIcon,
  BellRing,
  Plus,
  Trash2,
  HardDrive,
  RefreshCw,
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
  getAuditLog,
  listWebhooks,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  testWebhook,
  getStorageMetrics,
  WEBHOOK_EVENTS,
  type BackupFile,
  type Webhook,
  type WebhookEvent,
  type WebhookInput,
  type StorageMetrics,
} from '../api';
import { PwMeter } from '../components/PwMeter';
import { ReAuthModal } from '../components/ReAuthModal';
import { ConfirmModal } from '../components/ConfirmModal';
import { fmtBytes } from '../lib/size';
import { type Msg, AuditLog } from './settings-shared';

const APP_VERSION = 'BETA';

type SensitiveAction = 'save-lock' | 'disable-lock' | 'export' | 'import';

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
  const { user } = useAuth();

  // ── Route guard: admin-only ──
  if (user && user.role !== 'admin') {
    window.location.hash = '/profile';
    return null;
  }

  // ── Providers security lock ──
  const [lockEnabled, setLockEnabled] = useState<boolean | null>(null);
  const [lockFetchError, setLockFetchError] = useState(false);
  const [lockNewPw, setLockNewPw] = useState('');
  const [lockConfirmPw, setLockConfirmPw] = useState('');
  const [lockMsg, setLockMsg] = useState<Msg>(null);
  const pendingLockPw = useRef('');

  // ── Backup ──
  const [backupMsg, setBackupMsg] = useState<Msg>(null);
  const pendingImportRef = useRef<BackupFile | null>(null);

  // ── Notifications / Webhooks ──
  const [webhooks, setWebhooks] = useState<Webhook[] | null>(null);
  const [whMsg, setWhMsg] = useState<Msg>(null);
  const [whName, setWhName] = useState('');
  const [whUrl, setWhUrl] = useState('');
  const [whDelete, setWhDelete] = useState<Webhook | null>(null);
  const [whDeleting, setWhDeleting] = useState(false);

  // ── Disk usage / storage metrics ──
  const [storage, setStorage] = useState<StorageMetrics | null>(null);
  const [storageRefreshing, setStorageRefreshing] = useState(false);
  const [storageMsg, setStorageMsg] = useState<Msg>(null);

  useEffect(() => {
    listWebhooks()
      .then((r) => setWebhooks(r.webhooks))
      .catch((err: any) => {
        setWhMsg({ type: 'err', text: err.message || 'Failed to load webhooks' });
        setWebhooks([]);
      });
  }, []);

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

  // ── Unified identity confirmation ──
  const [pendingAction, setPendingAction] = useState<SensitiveAction | null>(null);
  const [reauthLoading, setReauthLoading] = useState(false);
  const [reauthError, setReauthError] = useState<string | null>(null);

  // ── Security activity ──
  const AUDIT_PAGE = 20;
  const [audit, setAudit] = useState<import('../api').AuditEntry[] | null>(null);
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
      setPendingAction(null);
      if (pendingAction === 'save-lock' || pendingAction === 'disable-lock') {
        setLockMsg({ type: 'err', text: msg });
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
      }
      setPendingAction(null);
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

  const reauthTitle = () => {
    if (pendingAction === 'disable-lock') return 'Disable Providers lock';
    if (pendingAction === 'save-lock') return lockEnabled ? 'Change Providers password' : 'Enable Providers lock';
    if (pendingAction === 'import') return 'Import backup';
    return 'Export backup';
  };

  const reauthDescription = () => {
    if (pendingAction === 'disable-lock') return 'This removes the second password — anyone using this session will be able to open Providers.';
    return 'Enter your account password to authorize this action.';
  };

  return (
    <div class="view">
      <div class="hero">
        <span class="hero-badge"><SettingsIcon width={12} height={12} /> Settings</span>
        <h1 class="hero-title" style="font-size: 1.5rem">Settings</h1>
        <p class="hero-sub">Admin settings — security, webhooks, storage, backups.</p>
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

      {/* Security Activity */}
      <div class="panel settings-section">
        <h2 class="panel-title">Security Activity</h2>
        <p class="settings-hint">Recent security-related events (newest first, last 50).</p>
        {audit === null ? (
          <div class="inline-loading" role="status"><Loader2 width={12} height={12} class="icon spin" /> Loading…</div>
        ) : audit.length === 0 ? (
          <div class="settings-hint">No activity recorded yet.</div>
        ) : (
          <AuditLog entries={audit} total={auditTotal} loadingMore={auditLoadingMore} onLoadMore={loadMoreAudit} />
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

      {/* Delete webhook confirm modal */}
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

      {/* Combined identity confirmation */}
      <ReAuthModal
        open={pendingAction !== null}
        username={user?.username}
        loading={reauthLoading}
        error={reauthError}
        title={reauthTitle()}
        description={reauthDescription()}
        confirmLabel="Confirm"
        onConfirm={executeReauth}
        onCancel={() => { setPendingAction(null); setReauthError(null); pendingLockPw.current = ''; }}
      />
    </div>
  );
}
