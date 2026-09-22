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
  DownloadCloud,
  CheckCircle2,
  TriangleAlert,
  ScrollText,
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
  getUpdates,
  checkUpdates,
  getUpdatesLog,
  applyUpdates,
  WEBHOOK_EVENTS,
  type BackupFile,
  type Webhook,
  type WebhookEvent,
  type WebhookInput,
  type StorageMetrics,
  type ApplyState,
  type UpdatesStatus,
  type UpdatesLog,
} from '../api';
import { PwMeter } from '../components/PwMeter';
import { ReAuthModal } from '../components/ReAuthModal';
import { ConfirmModal } from '../components/ConfirmModal';
import { fmtBytes } from '../lib/size';
import { type Msg, AuditLog, UPDATE_RUNNING_STATES } from './settings-shared';
import { useI18n } from '../i18n';

const APP_VERSION = 'BETA';

type SensitiveAction = 'save-lock' | 'disable-lock' | 'export' | 'import' | 'apply-update';

type UpdateTarget = { component: 'opencode' | 'code-server' | 'all'; label: string; toVersion: string };

function useApplyLabels(): Record<ApplyState, string> {
  const { t2 } = useI18n();
  return {
    idle: t2('خامل', 'Idle'),
    downloading: t2('جارٍ التنزيل', 'Downloading'),
    verifying: t2('جارٍ التحقق', 'Verifying'),
    installing: t2('جارٍ التثبيت', 'Installing'),
    restarting: t2('جارٍ إعادة التشغيل', 'Restarting'),
    'verifying-boot': t2('التحقق من الإقلاع', 'Verifying boot'),
    ok: t2('تم التحديث', 'Updated'),
    failed: t2('فشل', 'Failed'),
    rollback: t2('جارٍ التراجع', 'Rolling back'),
  };
}

function ApplyProgress({ state }: { state: ApplyState }) {
  const labels = useApplyLabels();
  const idx = UPDATE_RUNNING_STATES.indexOf(state);
  if (idx === -1) return null;
  return (
    <div class="upd-track" role="status">
      <div class="upd-steps">
        {UPDATE_RUNNING_STATES.map((s, i) => (
          <span key={s} class={`upd-step${i < idx ? ' done' : i === idx ? ' current' : ''}`} title={labels[s]} />
        ))}
      </div>
      <span class="dim" style="font-size:0.68rem; white-space:nowrap">{labels[state]}…</span>
    </div>
  );
}

interface WhRowProps {
  w: Webhook;
  onChanged: (msg: string) => void;
  onDelete: () => void;
}

/** One webhook editor row — self-contained local state, merged on Save. */
function WhRow({ w, onChanged, onDelete }: WhRowProps) {
  const { t, t2 } = useI18n();
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
      onChanged(t2(`حُفظ الويب هوك '${name.trim()}'.`, `Webhook '${name.trim()}' saved.`));
    } catch (err: any) {
      setMsg({ type: 'err', text: err.message || t2('فشل حفظ الويب هوك', 'Failed to save webhook') });
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
          ? { type: 'ok', text: t2(`تم التسليم — استجاب المستقبِل بـ HTTP ${r.status}.`, `Test delivered — receiver answered HTTP ${r.status}.`) }
          : { type: 'err', text: r.error || t2('فشل تسليم الاختبار', 'Test delivery failed') }
      );
    } catch (err: any) {
      setMsg({ type: 'err', text: err.message || t2('فشل تسليم الاختبار', 'Test delivery failed') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style="border:1px solid var(--border); border-radius:var(--radius); padding:10px 12px;">
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
        <input class="modern-input" style="max-width:190px" placeholder={t2('الاسم', 'Name')} value={name} onInput={(e: any) => setName(e.currentTarget.value)} />
        <input class="modern-input" style="flex:1; min-width:260px" placeholder="https://…" value={url} onInput={(e: any) => setUrl(e.currentTarget.value)} />
        <label class="wh-event-label" style="white-space:nowrap">
          <input type="checkbox" checked={enabled} onChange={(e: any) => setEnabled(e.currentTarget.checked)} /> {t2('مفعّل', 'enabled')}
        </label>
        <button class="btn-ghost sm" onClick={test} disabled={busy}>{t2('اختبار', 'Test')}</button>
        <button class="btn-primary sm" onClick={save} disabled={busy}>{busy ? t2('جارٍ الحفظ…', 'Saving…') : t('common.save')}</button>
        <button class="btn-ghost sm" style="color: var(--red)" onClick={onDelete} title={t2('حذف الويب هوك', 'Delete webhook')} aria-label={t2('حذف الويب هوك', 'Delete webhook')}>
          <Trash2 width={13} height={13} class="icon" />
        </button>
      </div>
      <div style="margin-top:8px; display:flex; gap:12px; flex-wrap:wrap; align-items:center;">
        {WEBHOOK_EVENTS.map((ev) => (
          <label class="wh-event-label" key={ev}>
            <input type="checkbox" checked={events.includes(ev)} onChange={toggleEvent(ev)} /> {ev}
          </label>
        ))}
        {w.hasSecret && <span class="meta-chip" style="color:var(--text-3)">{t2('سر HMAC مضبوط', 'HMAC secret set')}</span>}
      </div>
      <div style="margin-top:8px; display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
        <input
          class="modern-input"
          type="password"
          style="max-width:300px"
          placeholder={w.hasSecret ? t2('سر توقيع جديد (اتركه فارغاً للإبقاء على الحالي)', 'New signing secret (blank = keep current)') : t2('سر توقيع اختياري', 'Optional signing secret')}
          value={secret}
          onInput={(e: any) => setSecret(e.currentTarget.value)}
        />
        {(w.hasSecret || secret.trim()) && (
          <label class="wh-event-label" style="white-space:nowrap">
            <input type="checkbox" checked={clearSecret} onChange={(e: any) => setClearSecret(e.currentTarget.checked)} /> {t2('إزالة السر', 'remove secret')}
          </label>
        )}
      </div>
      {msg && <div class={msg.type === 'ok' ? 'chat-save-msg' : 'login-error'} style="margin-top:6px" role={msg.type === 'ok' ? 'status' : 'alert'}>{msg.text}</div>}
    </div>
  );
}

export function Settings() {
  const { user } = useAuth();
  const { t, t2, lang } = useI18n();

  // ── Route guard: admin-only ──
  // Redirect inside an effect (never during render); the null return sits after
  // every hook so hook order stays stable across the user null→role transition.
  const isAdmin = !user || user.role === 'admin';
  useEffect(() => {
    if (user && user.role !== 'admin') window.location.hash = '/profile';
  }, [user]);

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
        setWhMsg({ type: 'err', text: err.message || t2('فشل تحميل الويب هوكات', 'Failed to load webhooks') });
        setWebhooks([]);
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    getStorageMetrics()
      .then((r) => { if (!cancelled) setStorage(r); })
      .catch((err: any) => {
        if (!cancelled) setStorageMsg({ type: 'err', text: err.message || t2('فشل تحميل إحصاءات التخزين', 'Failed to load storage metrics') });
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
      setStorageMsg({ type: 'err', text: err.message || t2('فشل تحديث التخزين', 'Failed to refresh storage') });
    } finally {
      setStorageRefreshing(false);
    }
  };

  // ── Updates (opencode + code-server) ──
  const [updates, setUpdates] = useState<UpdatesStatus | null>(null);
  const [updatesMsg, setUpdatesMsg] = useState<Msg>(null);
  const [updatesChecking, setUpdatesChecking] = useState(false);
  const [updatesCheckError, setUpdatesCheckError] = useState<string | null>(null);
  const [updateConfirm, setUpdateConfirm] = useState<UpdateTarget | null>(null);
  const [applyInFlight, setApplyInFlight] = useState(false);
  const [updLogOpen, setUpdLogOpen] = useState(false);
  const [updLog, setUpdLog] = useState<UpdatesLog | null>(null);
  const [updLogLoading, setUpdLogLoading] = useState(false);
  const [updLogError, setUpdLogError] = useState<string | null>(null);
  const pendingUpdateComponent = useRef<'opencode' | 'code-server' | 'all'>('opencode');
  const updatesPanelRef = useRef<HTMLDivElement | null>(null);
  const updLogAlive = useRef(true);
  useEffect(() => () => { updLogAlive.current = false; }, []);

  useEffect(() => {
    let cancelled = false;
    getUpdates()
      .then((r) => {
        if (cancelled) return;
        setUpdatesCheckError(null);
        setUpdates(r);
        // Reached this page mid-apply (reload, or a fresh tab during a run):
        // resume progress polling instead of freezing on one stale step.
        if (r.components.some((c) => c.updateRunning || UPDATE_RUNNING_STATES.includes(c.applyState))) {
          setApplyInFlight(true);
        }
      })
      .catch((err: any) => {
        if (cancelled) return;
        setUpdatesCheckError(err.message || t2('فشل تحميل حالة التحديثات', 'Failed to load update status'));
      });
    return () => { cancelled = true; };
  }, []);

  const retryLoadUpdates = async () => {
    setUpdatesCheckError(null);
    try {
      const r = await getUpdates();
      setUpdates(r);
      if (r.components.some((c) => c.updateRunning || UPDATE_RUNNING_STATES.includes(c.applyState))) {
        setApplyInFlight(true);
      }
    } catch (err: any) {
      setUpdatesCheckError(err.message || t2('فشل تحميل حالة التحديثات', 'Failed to load update status'));
    }
  };

  // Poll while an apply runs in the background (202 → server continues).
  useEffect(() => {
    if (!applyInFlight) return;
    let alive = true;
    const tick = async () => {
      try {
        const r = await getUpdates();
        if (!alive) return;
        setUpdates(r);
        const stillRunning = r.components.some((c) => c.updateRunning || UPDATE_RUNNING_STATES.includes(c.applyState));
        if (!stillRunning) {
          setApplyInFlight(false);
          const failed = r.components.some((c) => c.applyState === 'failed');
          setUpdatesMsg(failed
            ? { type: 'err', text: t2('لم يكتمل أحد التحديثات بشكل نظيف — انظر حالة المكوّن أدناه.', 'An update did not finish cleanly — see the component status below.') }
            : { type: 'ok', text: t2('اكتمل التحديث — النسخة الجديدة تعمل الآن.', 'Update finished — the new version is live.') });
        }
      } catch {
        // transient network error — keep polling; the server continues.
      }
    };
    const t = setInterval(tick, 2500);
    tick();
    return () => { alive = false; clearInterval(t); };
  }, [applyInFlight]);

  // Idle re-check: catches an update started in ANOTHER tab (or a server-side
  // scheduled change) — this tab's applyInFlight stays false until a running
  // component appears, then the fast 2.5s poll above takes over.
  useEffect(() => {
    if (applyInFlight) return;
    let alive = true;
    let inflight = false;
    const recheck = async () => {
      if (inflight) return;
      inflight = true;
      try {
        const r = await getUpdates();
        if (!alive) return;
        setUpdates(r);
        if (r.components.some((c) => c.updateRunning || UPDATE_RUNNING_STATES.includes(c.applyState))) {
          setApplyInFlight(true);
        }
      } catch {
        // transient — next tick retries.
      } finally {
        inflight = false;
      }
    };
    const timer = setInterval(recheck, 30_000);
    const onVisible = () => { if (!document.hidden) recheck(); };
    window.addEventListener('pageshow', recheck);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      clearInterval(timer);
      window.removeEventListener('pageshow', recheck);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [applyInFlight]);

  const openUpdatesLog = () => {
    const next = !updLogOpen;
    setUpdLogOpen(next);
    if (!next) return;
    if (!updLogAlive.current) return;
    setUpdLogLoading(true);
    setUpdLogError(null);
    getUpdatesLog()
      .then((r) => { if (updLogAlive.current) setUpdLog(r); })
      .catch((err: any) => { if (updLogAlive.current) setUpdLogError(err.message || t2('فشل تحميل سجل التحديثات', 'Failed to load update log')); })
      .finally(() => { if (updLogAlive.current) setUpdLogLoading(false); });
  };

  const whRefresh = async (okText?: string) => {
    try {
      const r = await listWebhooks();
      setWebhooks(r.webhooks);
      if (okText) setWhMsg({ type: 'ok', text: okText });
      else setWhMsg(null);
    } catch (err: any) {
      setWhMsg({ type: 'err', text: err.message || t2('فشل تحديث الويب هوكات', 'Failed to refresh webhooks') });
    }
  };

  const whAdd = async () => {
    if (!whName.trim() || !whUrl.trim()) {
      setWhMsg({ type: 'err', text: t2('اسم الويب هوك والرابط مطلوبان.', 'Webhook name and URL are required.') });
      return;
    }
    try {
      await createWebhook({ name: whName.trim(), url: whUrl.trim(), events: ['crash'], enabled: true });
      setWhName('');
      setWhUrl('');
      await whRefresh(t2("أُضيف الويب هوك (مشترك في 'crash'). عدّل الأحداث أدناه عند الحاجة.", "Webhook added (subscribed to 'crash'). Edit events below if needed."));
    } catch (err: any) {
      setWhMsg({ type: 'err', text: err.message || t2('فشل إضافة الويب هوك', 'Failed to add webhook') });
    }
  };

  const whConfirmDelete = async () => {
    if (!whDelete) return;
    setWhDeleting(true);
    try {
      await deleteWebhook(whDelete.id);
      setWhDelete(null);
      await whRefresh(t2(`حُذف الويب هوك '${whDelete.name}'.`, `Webhook '${whDelete.name}' deleted.`));
    } catch (err: any) {
      setWhMsg({ type: 'err', text: err.message || t2('فشل حذف الويب هوك', 'Failed to delete webhook') });
    } finally {
      setWhDeleting(false);
    }
  };

  const doCheckUpdates = async () => {
    if (updatesChecking || applyInFlight) return;
    setUpdatesChecking(true);
    setUpdatesMsg(null);
    try {
      const r = await checkUpdates();
      setUpdatesCheckError(null);
      setUpdates(r);
    } catch (err: any) {
      setUpdatesMsg({ type: 'err', text: err.message || t2('فشل التحقق من التحديثات', 'Failed to check updates') });
    } finally {
      setUpdatesChecking(false);
    }
  };

  const beginUpdate = (component: 'opencode' | 'code-server' | 'all') => {
    // 'all' must never sweep already-current components: the backend's
    // code-server preflight rejects a not-newer target and marks the whole
    // apply failed. Resolve 'all' down to the single stale component when
    // only one needs updating.
    let target = component;
    if (component === 'all') {
      const stale = updates?.components.filter((c) => c.upToDate === false && c.channelUnlocked !== false);
      if (stale && stale.length === 1) target = stale[0].id;
    }
    const label = target === 'all' ? t2('كل المكوّنات', 'all components') : target;
    const comp = updates?.components.find((c) => c.id === target);
    setUpdatesMsg(null);
    setUpdateConfirm({ component: target, label, toVersion: comp?.latest || 'latest' });
  };

  const confirmUpdate = () => {
    if (!updateConfirm) return;
    pendingUpdateComponent.current = updateConfirm.component;
    setUpdatesMsg(null);
    setUpdateConfirm(null);
    setPendingAction('apply-update');
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
      setLockMsg({ type: 'err', text: t2('أدخل كلمة مرور المزوّدين الجديدة وتأكيدها.', 'Fill in the new providers password and its confirmation.') });
      return;
    }
    if (lockNewPw !== lockConfirmPw) {
      setLockMsg({ type: 'err', text: t2('كلمتا مرور المزوّدين الجديدتان غير متطابقتين.', 'New providers passwords do not match.') });
      return;
    }
    if (lockNewPw.length < 6) {
      setLockMsg({ type: 'err', text: t2('يجب ألا تقل كلمة مرور المزوّدين عن 6 أحرف.', 'Providers password must be at least 6 characters.') });
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
      setBackupMsg({ type: 'err', text: t2('اختر ملف نسخة احتياطية بامتداد .json أولاً.', 'Choose a backup .json file first.') });
      return;
    }
    try {
      const parsed = JSON.parse(await file.text());
      if (parsed?.kind !== 'madar-backup' && parsed?.kind !== 'wsd-pro-backup') throw new Error(t2('ليس ملف نسخ احتياطي صالحاً.', 'Not a Madar backup file.'));
      pendingImportRef.current = parsed as BackupFile;
      setBackupMsg(null);
      setPendingAction('import');
    } catch (err: any) {
      setBackupMsg({ type: 'err', text: err.message || t2('ملف نسخة احتياطية غير صالح.', 'Invalid backup file.') });
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
      } else if (pendingAction === 'apply-update') {
        setUpdatesMsg({ type: 'err', text: msg });
        // The panel may be stale (e.g. 409 — another update already running):
        // resync it so progress and disabled buttons reflect the real state.
        getUpdates()
          .then((r) => {
            setUpdates(r);
            if (r.components.some((c) => c.updateRunning || UPDATE_RUNNING_STATES.includes(c.applyState))) {
              setApplyInFlight(true);
            }
          })
          .catch(() => {});
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
          setLockMsg({ type: 'ok', text: wasEnabled ? t2('تغيّرت كلمة مرور المزوّدين.', 'Providers password changed.') : t2('فُعّل قفل المزوّدين.', 'Providers lock enabled.') });
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
          setLockMsg({ type: 'ok', text: t2('عُطّل قفل المزوّدين.', 'Providers lock disabled.') });
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
          setBackupMsg({ type: 'ok', text: t2('نُزّلت النسخة الاحتياطية (مفاتيح API مستثناة عمداً).', 'Backup downloaded (API keys excluded by design).') });
          break;
        }
        case 'import': {
          const backup = pendingImportRef.current;
          if (!backup) throw new Error(t2('بيانات الاستيراد مفقودة — اختر الملف من جديد.', 'Import data is missing — pick the file again.'));
          const result = await importSettings(accountPassword, backup);
          const total = Object.values(result.imported || {}).reduce((s, n) => s + n, 0);
          setBackupMsg({
            type: 'ok',
            text: t2(`استُورد ${total} عنصراً، وتخطّى ${result.skipped} موجوداً. أعد إضافة مفاتيح مزوّدي API يدوياً.`, `Imported ${total} item(s), skipped ${result.skipped} existing. Re-add provider API keys manually.`),
          });
          const input = document.getElementById('import-file') as HTMLInputElement | null;
          if (input) input.value = '';
          pendingImportRef.current = null;
          break;
        }
        case 'apply-update': {
          await applyUpdates(accountPassword, pendingUpdateComponent.current);
          setApplyInFlight(true);
          const label = pendingUpdateComponent.current === 'all' ? t2('كل المكوّنات', 'All components') : pendingUpdateComponent.current;
          setUpdatesMsg({ type: 'ok', text: t2(`بدأ تحديث ${label} — يُتابع التقدم أدناه.`, `${label} update started — progress is tracked below.`) });
          // The trigger button is now disabled, so ReAuthModal's focus-return
          // to it would land nowhere — move focus into the Updates panel
          // (first enabled control, else the panel box) after the dialog closes.
          setTimeout(() => {
            const panel = updatesPanelRef.current;
            if (!panel) return;
            const btn = panel.querySelector<HTMLElement>('button:not([disabled])');
            if (btn) btn.focus();
            else panel.focus();
          }, 50);
          break;
        }
      }
      setPendingAction(null);
      getAuditLog(AUDIT_PAGE, 0)
        .then((r) => { setAudit(r.entries || []); setAuditTotal(r.total || 0); })
        .catch(() => {});
    } catch (err: any) {
      const msg = err.message || t2('فشلت العملية.', 'Operation failed.');
      const isRetryable = err.status === 401 || err.status === 429 || (err.status === 400 && /password/i.test(msg));
      fail(msg, isRetryable);
    } finally {
      setReauthLoading(false);
    }
  };

  const reauthTitle = () => {
    if (pendingAction === 'disable-lock') return t2('تعطيل قفل المزوّدين', 'Disable Providers lock');
    if (pendingAction === 'save-lock') return lockEnabled ? t2('تغيير كلمة مرور المزوّدين', 'Change Providers password') : t2('تفعيل قفل المزوّدين', 'Enable Providers lock');
    if (pendingAction === 'import') return t2('استيراد نسخة احتياطية', 'Import backup');
    if (pendingAction === 'apply-update') return t2('اعتماد التحديث', 'Authorize update');
    return t2('تصدير نسخة احتياطية', 'Export backup');
  };

  const reauthDescription = () => {
    if (pendingAction === 'disable-lock') return t2('يزيل هذا كلمة المرور الثانية — أي مستخدم لهذه الجلسة سيستطيع فتح المزوّدين.', 'This removes the second password — anyone using this session will be able to open Providers.');
    if (pendingAction === 'apply-update') {
      const label = pendingUpdateComponent.current === 'all' ? t2('كل المكوّنات', 'all components') : pendingUpdateComponent.current;
      return t2(`جارٍ تحديث ${label}. أدخل كلمة مرور حسابك للاعتماد.`, `Updating ${label}. Enter your account password to authorize.`);
    }
    return t2('أدخل كلمة مرور حسابك لاعتماد هذا الإجراء.', 'Enter your account password to authorize this action.');
  };

  if (!isAdmin) return null;

  return (
    <div class="view">
      <div class="hero">
        <span class="hero-badge"><SettingsIcon width={12} height={12} /> {t('nav.settings')}</span>
        <h1 class="hero-title" style="font-size: 1.5rem">{t2('الإعدادات', 'Settings')}</h1>
        <p class="hero-sub">{t2('إعدادات المدير — الأمان والويب هوكات والتخزين والنسخ الاحتياطي.', 'Admin settings — security, webhooks, storage, backups.')}</p>
      </div>

      {/* Providers Security Lock — two-step flow */}
      <div class="panel settings-section">
        <h2 class="panel-title">
          <span class="icon-wrap"><KeyRound width={14} height={14} /></span> {t2('أمان المزوّدين', 'Providers Security')}
        </h2>
        <p class="settings-hint">
          {t2('كلمة مرور ثانية اختيارية تحرس صفحة المزوّدين.', 'Optional second-layer password guarding the Providers page.')}
        </p>
        <div class="settings-row">
          <span class="field-label">{t2('الحالة', 'Status')}</span>
          {lockFetchError ? (
            <span class="badge-off"><Loader2 width={11} height={11} class="icon spin" /> {t2('تعذّر التحقق — حاول التحديث', 'Could not check — try refreshing')}</span>
          ) : lockEnabled === null ? (
            <span class="inline-loading"><Loader2 width={12} height={12} class="icon spin" /> {t2('جارٍ التحقق…', 'Checking…')}</span>
          ) : lockEnabled ? (
            <span class="badge-ok"><Lock width={11} height={11} /> {t2('مفعّل · يبقى مفتوحاً 30 دقيقة بعد الدخول', 'Enabled · stays open 30 min after entry')}</span>
          ) : (
            <span class="badge-off"><LockOpen width={11} height={11} /> {t2('معطّل — المزوّدون مفتوحون أثناء الجلسة', 'Disabled — Providers open while signed in')}</span>
          )}
        </div>

        <form onSubmit={beginSaveLock}>
          <label class="field-label">
            {lockEnabled ? t2('كلمة مرور المزوّدين الجديدة', 'New Providers password') : t2('ضبط كلمة مرور المزوّدين', 'Set Providers password')}
          </label>
          <input
            class="modern-input"
            type="password"
            placeholder={t2('6 أحرف على الأقل', 'Min 6 characters')}
            value={lockNewPw}
            onInput={(e: any) => setLockNewPw(e.target.value)}
          />
          {lockNewPw && <PwMeter pw={lockNewPw} />}

          <label class="field-label">{t2('تأكيد كلمة مرور المزوّدين', 'Confirm Providers password')}</label>
          <input
            class="modern-input"
            type="password"
            placeholder={t2('أعد كتابة كلمة مرور المزوّدين', 'Repeat providers password')}
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
              {lockEnabled ? t2('تغيير كلمة مرور المزوّدين', 'Change Providers password') : t2('تفعيل القفل', 'Enable lock')}
            </button>
            {lockEnabled && (
              <>
                <button class="btn-ghost sm" type="button" onClick={async () => {
                  try {
                    await relockProviders();
                    clearProvidersUnlock();
                    setLockMsg({ type: 'ok', text: t2('قُفل على كل التبويبات والأجهزة.', 'Locked on all tabs and devices.') });
                  } catch {
                    setLockMsg({ type: 'err', text: t2('تعذّر قفل الأجهزة الأخرى.', 'Could not lock other devices.') });
                  }
                }}>
                  {t('nav.lockNow')}
                </button>
                <button class="btn-danger sm" type="button" onClick={beginDisableLock}>
                  {t2('تعطيل القفل', 'Disable lock')}
                </button>
              </>
            )}
          </div>
          <p class="settings-hint" style="margin-top:10px;">
            {t2('ستؤكد هويتك بكلمة مرور حسابك في الخطوة التالية.', 'You will confirm your identity with your account password in the next step.')}
          </p>
        </form>
      </div>

      {/* Notifications / Webhooks */}
      <div class="panel settings-section">
        <h2 class="panel-title"><span class="icon-wrap"><BellRing width={14} height={14} /></span> {t2('التنبيهات والويب هوكات', 'Notifications & Webhooks')}</h2>
        <p class="settings-hint">
          {t2('حوّل أحداث دورة حياة الحاويات والأعطال إلى رابط خارجي (Slack أو Discord أو Telegram أو صفحة حالة…). الخادم يكشف الأعطال حتى بلا متصفح مفتوح. عند ضبط سر توقيع، يحمل كل POST ترويسة ', 'Forward container lifecycle and crash events to an external URL (Slack, Discord, Telegram, a status page…). Crashes are detected by the server even when no browser is open. When a signing secret is set, every POST carries an ')}
          <code>X-Madar-Signature</code>
          {t2(' HMAC ليستطيع المستقبِلون التحقق من المرسل.', ' HMAC header so receivers can verify the sender.')}
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
              placeholder={t2('اسم الويب هوك', 'Webhook name')}
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
              <span class="icon-wrap"><Plus width={13} height={13} /></span> {t2('إضافة', 'Add')}
            </button>
          </div>

          {webhooks === null ? (
            <div class="dim" style="margin-top: 12px" role="status">{t2('جارٍ تحميل الويب هوكات…', 'Loading webhooks…')}</div>
          ) : webhooks.length === 0 ? (
            <div class="dim" style="margin-top: 12px">
              {t2('لا ويب هوكات — تظهر الأعطال وأحداث دورة الحياة داخل التطبيق رغم ذلك.', 'No webhooks — crashes and lifecycle events are still shown in-app.')}
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
          <span>{t2('التخزين', 'Storage')}</span>
          <button class="btn-ghost sm" onClick={refreshStorage} disabled={storageRefreshing}>
            {storageRefreshing ? <Loader2 width={13} height={13} class="icon spin" /> : <RefreshCw width={13} height={13} class="icon" />}
            {t2('تحديث', 'Refresh')}
          </button>
        </h2>
        <p class="settings-hint">
          {t2('استخدام القرص عبر مساحات العمل وأرشيف اللقطات وDocker. لقطة للقراءة فقط — التحديث يجبر إعادة مسح.', 'Disk usage across workspaces, snapshot archives and Docker. Read-only snapshot — refresh forces a rescan.')}
        </p>
        {storageMsg && (
          <div class={storageMsg.type === 'ok' ? 'chat-save-msg' : 'login-error'} style="margin-bottom:8px" role={storageMsg.type === 'ok' ? 'status' : 'alert'}>{storageMsg.text}</div>
        )}
        {storage == null ? (
          <div class="dim" role="status">{t2('جارٍ تحميل إحصاءات التخزين…', 'Loading storage metrics…')}</div>
        ) : (
          <>
            <div class="storage-totals">
              <div class="storage-total"><span>{t2('مساحات العمل', 'Workspaces')}</span><b>{fmtBytes(storage.totalWorkspaceBytes)}</b></div>
              <div class="storage-total"><span>{t2('أرشيف اللقطات', 'Snapshot archives')}</span><b>{fmtBytes(storage.totalSnapshotBytes)}</b></div>
              <div class="storage-total"><span>{t2('مجلد البيانات', 'Data directory')}</span><b>{fmtBytes(storage.dataDirBytes)}</b></div>
              <div class="storage-total"><span>{t2('الحاويات (قابلة للكتابة)', 'Containers (writable)')}</span><b>{fmtBytes(storage.containerWritableBytes)}</b></div>
              {storage.docker.system && (
                <div class="storage-total"><span>{t2('إجمالي Docker', 'Docker total')}</span><b>{fmtBytes(storage.docker.system.totalBytes)}</b></div>
              )}
            </div>
            <div class="dim" style="font-size:0.75rem;margin:14px 0 6px">{t2('حسب المشروع', 'Per project')}</div>
            <div class="table-scroll">
              <table class="storage-table">
              <thead>
                <tr><th>{t2('المشروع', 'Project')}</th><th>{t2('مساحة العمل', 'Workspace')}</th><th>{t2('اللقطات', 'Snapshots')}</th><th>{t2('الحاوية', 'Container')}</th></tr>
              </thead>
              <tbody>
                {storage.projects.length === 0 && (
                  <tr><td colspan={4} class="dim">{t2('لا مشاريع — التخزين خامل.', 'No projects — storage is idle.')}</td></tr>
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
                {t2('إجماليات Docker — الصور ', 'Docker totals — images ')}
                {fmtBytes(storage.docker.system.imagesBytes)} · {t2('الحاويات', 'containers')} {fmtBytes(storage.docker.system.containersBytes)} ·
                {' '}{t2('الأحجام', 'volumes')} {fmtBytes(storage.docker.system.volumesBytes)} · {t2('ذاكرة البناء', 'build cache')} {fmtBytes(storage.docker.system.buildCacheBytes)}
              </p>
            )}
          </>
        )}
      </div>

      {/* Backup / Restore */}
      <div class="panel settings-section">
        <h2 class="panel-title">{t2('النسخ الاحتياطي والاستعادة', 'Backup & Restore')}</h2>
        <p class="settings-hint">
          {t2('صدّر الوكلاء والجلسات وإعدادات المزوّدين وتفضيلات المحادثة كملف JSON.', 'Export agents, sessions, provider configs and chat preferences as JSON.')}
          <strong> {t2('مفاتيح API لا تُضمّن أبداً.', 'API keys are never included.')}</strong> {t2('الاستيراد يدمج العناصر الجديدة فقط.', 'Import merges new items only.')}
        </p>

        {backupMsg && (
          <div class={backupMsg.type === 'ok' ? 'chat-save-msg' : 'login-error'} style="margin-bottom: 8px" role={backupMsg.type === 'ok' ? 'status' : 'alert'}>
            {backupMsg.text}
          </div>
        )}

        <div style="display: flex; gap: 10px; margin-top: 4px; flex-wrap: wrap; align-items: center;">
          <button class="btn-primary sm" onClick={beginExport}>
            <span class="icon-wrap"><Download width={13} height={13} /></span> {t2('تصدير نسخة احتياطية', 'Export backup')}
          </button>
          <form onSubmit={beginImport} style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
            <label for="import-file" class="sr-only">{t2('ملف نسخة احتياطية للاستيراد (.json)', 'Backup file to import (.json)')}</label>
            <input id="import-file" type="file" accept=".json,application/json" class="modern-file" />
            <button class="btn-ghost sm" type="submit">
              <span class="icon-wrap"><Upload width={13} height={13} /></span> {t2('استيراد', 'Import')}
            </button>
          </form>
        </div>
      </div>

      {/* Security Activity */}
      <div class="panel settings-section">
        <h2 class="panel-title">{t2('النشاط الأمني', 'Security Activity')}</h2>
        <p class="settings-hint">{t2('أحدث الأحداث المتعلقة بالأمان (الأحدث أولاً، آخر 50).', 'Recent security-related events (newest first, last 50).')}</p>
        {audit === null ? (
          <div class="inline-loading" role="status"><Loader2 width={12} height={12} class="icon spin" /> {t('common.loading')}</div>
        ) : audit.length === 0 ? (
          <div class="settings-hint">{t2('لا نشاط مسجّل بعد.', 'No activity recorded yet.')}</div>
        ) : (
          <AuditLog entries={audit} total={auditTotal} loadingMore={auditLoadingMore} onLoadMore={loadMoreAudit} />
        )}
      </div>

      {/* Updates (opencode + code-server) */}
      <div class="panel settings-section" ref={updatesPanelRef} tabIndex={-1}>
        <h2 class="panel-title" style="display:flex;align-items:center;justify-content:space-between">
          <span><span class="icon-wrap"><DownloadCloud width={14} height={14} /></span> {t2('التحديثات', 'Updates')}</span>
          <button class="btn-ghost sm" onClick={doCheckUpdates} disabled={updatesChecking || applyInFlight}>
            {updatesChecking ? <Loader2 width={13} height={13} class="icon spin" /> : <RefreshCw width={13} height={13} class="icon" />}
            {t2('تحقق الآن', 'Check now')}
          </button>
        </h2>
        <p class="settings-hint">
          {t2('حدّث opencode أو VS Code (code-server) في مكانه. تحديث المكوّن يعيد تشغيله فقط (~ثوانٍ) وتتصل جلساتك تلقائياً من جديد. إعادة بناء الصورة (', 'Update opencode or VS Code (code-server) in place. Updating a component only restarts it (~seconds) — your sessions reconnect automatically. Rebuilding the image (')}
          <code>docker compose build</code>
          {t2(') تعود للنسخة المثبتة في الصورة.', ') returns to the baked build version.')}
          {updates && (
            <span style="display:block;margin-top:4px">
              {t2('آخر تحقق:', 'Last checked:')} <span class="mono">{updates.checkedAt ? new Date(updates.checkedAt).toLocaleTimeString(lang === 'ar' ? 'ar' : undefined) : '—'}</span>
            </span>
          )}
        </p>

        {updatesMsg && (
          <div class={updatesMsg.type === 'ok' ? 'chat-save-msg' : 'login-error'} style="margin-bottom: 8px" role={updatesMsg.type === 'ok' ? 'status' : 'alert'}>
            {updatesMsg.text}
          </div>
        )}

        {updates === null ? (
          updatesCheckError ? (
            <div style="margin-bottom:8px">
              <div class="upd-msg-err" role="alert" style="margin-bottom:8px">{updatesCheckError}</div>
              <button class="btn-ghost sm" onClick={retryLoadUpdates}>
                <RefreshCw width={13} height={13} class="icon" /> {t('common.retry')}
              </button>
            </div>
          ) : (
            <div class="dim" role="status">{t2('جارٍ التحقق من التحديثات…', 'Checking for updates…')}</div>
          )
        ) : updates.components.length === 0 ? (
          <div class="dim">{t2('لا مكوّنات أبلغ عنها الخادم.', 'No components reported by the server.')}</div>
        ) : (
          <>
            {updates.components.map((c) => {
              const running = c.updateRunning || UPDATE_RUNNING_STATES.includes(c.applyState);
              const locked = c.upToDate === false && c.channelUnlocked === false;
              const lockReason = c.id === 'opencode'
                ? t2('إصدار رئيسي أحدث يتطلب تحديث Madar — هذه القناة مقيّدة.', 'A newer major version requires a Madar update — this channel is gated.')
                : t2('لا توجد نسخة مستقرة لهذه المنصة — القناة مقيّدة.', 'No stable build ships for this platform — this channel is gated.');
              const canUpdate = c.upToDate === false && !running && !applyInFlight && !locked;
              const updateTitle =
                c.upToDate === null
                  ? t2('السجل غير متاح — الإصدار مجهول', 'Registry unreachable — version unknown')
                  : locked
                    ? lockReason
                    : running || applyInFlight
                      ? t2('هناك تحديث قيد التشغيل بالفعل', 'An update is already running')
                      : c.upToDate === true
                        ? t2('محدّث بالفعل', 'Already up to date')
                        : t2('حدّث هذا المكوّن', 'Update this component');
              return (
                <div class="settings-row" style="flex-wrap:wrap;" key={c.id}>
                  <span class="upd-name">
                    <span class={`upd-dot ${c.upToDate === true ? 'good' : c.upToDate === false ? 'warn' : 'unknown'}`} />
                    {c.id === 'opencode' ? 'opencode' : 'VS Code'}
                  </span>
                  <span class="upd-version" title={t2('الإصدار الحالي', 'Current version')}>v{c.current || '—'}</span>
                  <span class="dim" aria-hidden="true">→</span>
                  <span class="upd-version" title={t2('أحدث إصدار', 'Latest version')}>{c.latest ? `v${c.latest}` : '—'}</span>
                  {c.upToDate === true && c.error && (
                    <span class="upd-pill-warn"><TriangleAlert width={11} height={11} /> {t2('مطلوب إعادة تشغيل', 'Restart required')}</span>
                  )}
                  {c.upToDate === true && !c.error && (
                    <span class="badge-ok"><CheckCircle2 width={11} height={11} /> {t2('محدّث', 'Up to date')}</span>
                  )}
                  {c.upToDate === false && (
                    <span class="upd-pill-warn">{t2('يتوفر تحديث', 'Update available')}</span>
                  )}
                  {c.upToDate === null && (
                    <span class="badge-off">{t2('مجهول — السجل غير متاح', 'Unknown — registry unreachable')}</span>
                  )}
                  <div style="flex:1" />
                  <button class="btn-primary sm" onClick={() => beginUpdate(c.id)} disabled={!canUpdate} title={updateTitle}>
                    {t2('تحديث', 'Update')}
                  </button>
                  {running && UPDATE_RUNNING_STATES.includes(c.applyState) && (
                    <ApplyProgress state={c.applyState} />
                  )}
                  {running && !UPDATE_RUNNING_STATES.includes(c.applyState) && (
                    <div class="upd-track"><span class="dim" style="font-size:0.7rem">{t2('جارٍ التحديث…', 'Updating…')}</span></div>
                  )}
                  {!running && c.applyState === 'ok' && (
                    <div class="upd-msg-ok" role="status"><CheckCircle2 width={12} height={12} /> {t2('النسخة الجديدة تعمل الآن.', 'New version is live.')}</div>
                  )}
                  {!running && c.applyState === 'failed' && (
                    <div class="upd-msg-err" role="alert">
                      {c.rolledBack === true
                        ? t2(`فشل التحديث — تراجع تلقائياً إلى ${c.current ? `v${c.current}` : 'النسخة السابقة'}.`, `Update failed — automatically rolled back to ${c.current ? `v${c.current}` : 'the previous version'}.`)
                        : c.rolledBack === false
                          ? t2('فشل التحديث وفشل التراجع أيضاً. يلزم تدخل يدوي.', 'Update failed — rollback also failed. Manual intervention required.')
                          : c.error || t2('فشل التحديث — انظر سجلات الخادم.', 'Update failed — see server logs.')}
                      {c.rolledBack !== undefined && c.error && (
                        <span style="display:block;font-size:0.72rem;opacity:.9;margin-top:3px">{c.error}</span>
                      )}
                    </div>
                  )}
                  {!running && !['rollback', 'ok', 'failed'].includes(c.applyState) && locked && (
                    <div class="upd-msg-warn" role="status">{lockReason}</div>
                  )}
                  {!running && c.error && c.applyState !== 'failed' && (
                    <div class="upd-msg-err" role="alert">{c.error}</div>
                  )}
                </div>
              );
            })}

            {(() => {
              const allAvailable = updates.components.some((c) => c.upToDate === false);
              const allRunning = updates.components.some((c) => c.updateRunning || UPDATE_RUNNING_STATES.includes(c.applyState));
              const allLocked = updates.components.some((c) => c.upToDate === false && c.channelUnlocked === false);
              const canAll = allAvailable && !allRunning && !allLocked && !applyInFlight;
              const allTitle = !allAvailable
                ? t2('لا شيء للتحديث', 'Nothing to update')
                : allRunning
                  ? t2('هناك تحديث قيد التشغيل بالفعل', 'An update is already running')
                  : allLocked
                    ? t2('قناة أحد المكوّنات مقيّدة', 'A component channel is locked')
                    : t2('طبّق كل التحديثات المتاحة', 'Apply every available update');
              return (
                <div class="settings-row" style="flex-wrap:wrap; border-bottom:none;">
                  <span class="upd-name"><DownloadCloud width={13} height={13} class="icon" style="opacity:.6" /> {t2('كل المكوّنات', 'All components')}</span>
                  <span class="dim" style="font-size:0.72rem">{t2('طبّق كل التحديثات المتاحة', 'Apply every available update')}</span>
                  <div style="flex:1" />
                  <button class="btn-primary sm" onClick={() => beginUpdate('all')} disabled={!canAll} title={allTitle}>
                    {t2('تحديث الكل', 'Update all')}
                  </button>
                </div>
              );
            })()}
          </>
        )}

        <div style="margin-top:14px; border-top:1px solid var(--border); padding-top:12px;">
          <button class="btn-ghost sm" onClick={openUpdatesLog} aria-expanded={updLogOpen} aria-controls="updates-log">
            <ScrollText width={13} height={13} class="icon" /> {t2('سجل التحديثات', 'Update log')}
          </button>
          {updLogOpen && (
            <div style="margin-top:10px" aria-busy={updLogLoading}>
              {updLogLoading ? (
                <div class="inline-loading" role="status"><Loader2 width={12} height={12} class="icon spin" /> {t2('جارٍ التحميل…', 'Loading…')}</div>
              ) : updLogError ? (
                <div class="upd-msg-err" role="alert">{updLogError}</div>
              ) : updLog && updLog.log === '' ? (
                <div class="dim">{t2('لا سجل بعد — يظهر بعد أول عملية تحديث.', 'No log yet — entries appear after the first update.')}</div>
              ) : updLog ? (
                <>
                  <pre
                    id="updates-log"
                    class="mono scrollbar"
                    role="region"
                    tabIndex={0}
                    aria-label={t2('سجل التحديثات', 'Update log')}
                    style="margin:0; max-height:280px; overflow:auto; font-size:0.72rem; line-height:1.55; color:#e4e4e7; background:rgba(0,0,0,.35); border:1px solid rgba(255,255,255,.07); border-radius:8px; padding:10px 12px; white-space:pre-wrap; word-break:break-word; direction:ltr; unicodeBidi:isolate;"
                  >{updLog.log}</pre>
                  {updLog.truncated && (
                    <div class="settings-hint" style="margin-top:6px">
                      {t2('السجل طويل — عُرض آخر جزء فقط.', 'Log is long — only the tail is shown.')}
                    </div>
                  )}
                </>
              ) : null}
            </div>
          )}
        </div>
      </div>

      {/* About */}
      <div class="panel settings-section">
        <h2 class="panel-title">{t2('حول', 'About')}</h2>
        <div class="settings-row">
          <span class="field-label">{t2('الإصدار', 'Version')}</span>
          <span class="mono beta-chip" title={t2('برنامج تجريبي — الميزات وصيغة البيانات قد تتغير', 'Beta software — features and data format may change')}>{APP_VERSION}</span>
        </div>
        <div class="settings-row">
          <span class="field-label">{t2('الرخصة', 'License')}</span>
          <span style="color: var(--text-2)">MIT</span>
        </div>
      </div>

      {/* Delete webhook confirm modal */}
      <ConfirmModal
        open={!!whDelete}
        danger
        title={whDelete ? t2(`حذف الويب هوك '${whDelete.name}'؟`, `Delete webhook '${whDelete.name}'?`) : t2('حذف الويب هوك؟', 'Delete webhook?')}
        message={t2('سيتوقف تمرير أحداث الأعطال ودورة الحياة إلى هذا الرابط.', 'Crash and lifecycle events will stop being forwarded to this URL.')}
        confirmLabel={t('common.delete')}
        loading={whDeleting}
        onConfirm={whConfirmDelete}
        onCancel={() => setWhDelete(null)}
      />

      {/* Update confirm modal — names the exact component + target version */}
      <ConfirmModal
        open={!!updateConfirm}
        title={updateConfirm && updateConfirm.component === 'all'
          ? t2('تحديث كل المكوّنات؟', 'Update all components?')
          : updateConfirm
            ? t2(`تحديث ${updateConfirm.label} إلى ${updateConfirm.toVersion}؟`, `Update ${updateConfirm.label} to ${updateConfirm.toVersion}?`)
            : t2('تحديث؟', 'Update?')}
        message={t2('يُعاد تشغيل المكوّن لبضع ثوانٍ وتتصل جلساتك تلقائياً من جديد.', 'The component restarts for a few seconds; your sessions reconnect automatically.')}
        confirmLabel={t2('تحديث', 'Update')}
        onConfirm={confirmUpdate}
        onCancel={() => setUpdateConfirm(null)}
      />

      {/* Combined identity confirmation */}
      <ReAuthModal
        open={pendingAction !== null}
        username={user?.username}
        loading={reauthLoading}
        error={reauthError}
        title={reauthTitle()}
        description={reauthDescription()}
        confirmLabel={t('common.confirm')}
        onConfirm={executeReauth}
        onCancel={() => { setPendingAction(null); setReauthError(null); pendingLockPw.current = ''; }}
      />
    </div>
  );
}
