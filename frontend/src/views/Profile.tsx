import { useState, useEffect, useRef } from 'preact/hooks';
import QRCode from 'qrcode';
import {
  Loader2,
  LogOut,
  ShieldCheck,
  Smartphone,
  UserRound,
  UserCheck,
  ImagePlus,
} from 'lucide-preact';
import { useAuth } from '../auth';
import {
  apiLogoutAll,
  getMyActivity,
  getTotpStatus,
  totpSetup,
  totpEnable,
  totpDisable,
  type AuditEntry,
} from '../api';
import { getMyProfile, updateMyProfile, uploadAvatar, deleteMyAvatar, avatarUrl, type UserProfile } from '../api';
import { Avatar } from '../components/Avatar';
import { PwMeter } from '../components/PwMeter';
import { ReAuthModal } from '../components/ReAuthModal';
import { ConfirmModal } from '../components/ConfirmModal';
import { fmtDate, type Msg, AuditLog } from './settings-shared';
import { useI18n } from '../i18n';

type SensitiveAction = 'revoke-all' | '2fa-disable';
type IdleChoice = 'off' | '30' | '60' | '120';
type RelockChoice = 'off' | '5' | '15' | '30';

export function Profile() {
  const { user, logout, refreshUser } = useAuth();
  const { t, t2, lang } = useI18n();

  // ── User profile (display name / email / bio / avatar) ──
  const [profile, setProfile] = useState<UserProfile>({});
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileMsg, setProfileMsg] = useState<Msg>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarRemoveOpen, setAvatarRemoveOpen] = useState(false);
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
      setTotpMsg({ type: 'err', text: err.message || t2('تعذّر بدء الإعداد.', 'Could not start setup.') });
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
      setTotpMsg({ type: 'ok', text: t2('التحقق بخطوتين مفعّل الآن.', 'Two-factor authentication is now active.') });
      setTimeout(() => setTotpMsg(null), 4000);
      getMyActivity(AUDIT_PAGE, 0).then((r) => { setAudit(r.entries || []); setAuditTotal(r.total || 0); }).catch(() => {});
    } catch (err: any) {
      setTotpMsg({ type: 'err', text: err.message || t2('رمز غير صحيح.', 'Invalid code.') });
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

  // ── Inactivity auto-logout ──
  const [idleChoice, setIdleChoice] = useState<IdleChoice>(() => {
    try {
      return (localStorage.getItem('wsd.idleTimeout') as IdleChoice) || 'off';
    } catch {
      return 'off';
    }
  });
  const [idleSaved, setIdleSaved] = useState(false);

  // ── Providers auto-relock on inactivity ──
  const [relockChoice, setRelockChoice] = useState<RelockChoice>(() => {
    try {
      return (localStorage.getItem('wsd.providersAutoRelock') as RelockChoice) || 'off';
    } catch {
      return 'off';
    }
  });
  const [relockSaved, setRelockSaved] = useState(false);

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
    getMyActivity(AUDIT_PAGE, 0)
      .then((r) => { setAudit(r.entries || []); setAuditTotal(r.total || 0); })
      .catch(() => { setAudit([]); setAuditTotal(0); });
  }, []);

  const loadMoreAudit = async () => {
    if (!audit) return;
    setAuditLoadingMore(true);
    try {
      const r = await getMyActivity(AUDIT_PAGE, audit.length);
      setAudit((prev) => [...(prev || []), ...(r.entries || [])]);
      setAuditTotal(r.total || 0);
    } catch { /* ignore */ }
    setAuditLoadingMore(false);
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
      setPendingAction(null);
      if (pendingAction === 'revoke-all') {
        setPwMsg({ type: 'err', text: msg });
      } else if (pendingAction === '2fa-disable') {
        setTotpMsg({ type: 'err', text: msg });
      }
    };

    try {
      switch (pendingAction) {
        case 'revoke-all': {
          await apiLogoutAll(accountPassword);
          logout();
          window.location.hash = '/login';
          break;
        }
        case '2fa-disable': {
          await totpDisable(accountPassword);
          setTotpEnabled(false);
          setTotpMsg({ type: 'ok', text: t2('عُطّل التحقق بخطوتين.', 'Two-factor authentication disabled.') });
          setTimeout(() => setTotpMsg(null), 4000);
          break;
        }
      }
      setPendingAction(null);
      getMyActivity(AUDIT_PAGE, 0)
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

  // ── Change account password (direct flow) ──
  const changePassword = async (e: Event) => {
    e.preventDefault();
    if (pwLoading) return;

    if (!currentPw || !newPw) {
      setPwMsg({ type: 'err', text: t2('يرجى تعبئة جميع الحقول.', 'Please fill in all fields.') });
      return;
    }
    if (newPw !== confirmPw) {
      setPwMsg({ type: 'err', text: t2('كلمتا المرور الجديدتان غير متطابقتين.', 'New passwords do not match.') });
      return;
    }
    if (newPw.length < 6) {
      setPwMsg({ type: 'err', text: t2('يجب ألا تقل كلمة المرور الجديدة عن 6 أحرف.', 'New password must be at least 6 characters.') });
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
      if (!res.ok) throw new Error(data.error || t2('فشل', 'Failed'));
      if (data.token) localStorage.setItem('wsd.token', data.token);
      await refreshUser();
      setPwMsg({ type: 'ok', text: t2('تغيّرت كلمة المرور وتم تسجيل خروج بقية الأجهزة.', 'Password changed. Other devices were signed out.') });
      setCurrentPw('');
      setNewPw('');
      setConfirmPw('');
    } catch (err: any) {
      setPwMsg({ type: 'err', text: err.message || t2('فشل', 'Failed') });
    } finally {
      setPwLoading(false);
    }
  };

  // ── User profile handlers ──
  const saveProfile = async () => {
    setProfileSaving(true);
    setProfileMsg(null);
    try {
      const r = await updateMyProfile({
        displayName: profile.displayName?.trim() || '',
        email: profile.email?.trim() || '',
        bio: profile.bio?.trim() || '',
        emailVisible: profile.emailVisible !== false,
      });
      setProfile(r.profile || {});
      await refreshUser();
      setProfileMsg({ type: 'ok', text: t2('حُفظ الملف الشخصي.', 'Profile saved.') });
    } catch (err: any) {
      setProfileMsg({ type: 'err', text: err.message || t2('فشل حفظ الملف الشخصي', 'Failed to save profile') });
    } finally {
      setProfileSaving(false);
    }
  };

  const pickAvatar = async (e: any) => {
    const file = e.target.files?.[0] as File | undefined;
    e.target.value = '';
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setProfileMsg({ type: 'err', text: t2('الصورة كبيرة جداً — الحد الأقصى 2 ميغابايت.', 'Image too large — max 2 MB.') });
      return;
    }
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setProfileMsg({ type: 'err', text: t2('نوع ملف غير مدعوم — استخدم PNG أو JPEG أو WebP.', 'Unsupported file type — use PNG, JPEG or WebP.') });
      return;
    }
    setAvatarBusy(true);
    setProfileMsg(null);
    try {
      await uploadAvatar(file);
      const r = await getMyProfile();
      setProfile(r.profile || {});
      await refreshUser();
      setProfileMsg({ type: 'ok', text: t2('حُدّثت الصورة الرمزية.', 'Avatar updated.') });
    } catch (err: any) {
      setProfileMsg({ type: 'err', text: err.message || t2('فشل الرفع', 'Upload failed') });
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
      setProfileMsg({ type: 'ok', text: t2('أُزيلت الصورة الرمزية.', 'Avatar removed.') });
    } catch (err: any) {
      setProfileMsg({ type: 'err', text: err.message || t2('فشل إزالة الصورة', 'Failed to remove avatar') });
    } finally {
      setAvatarBusy(false);
    }
  };

  return (
    <div class="view">
      <div class="hero">
        <span class="hero-badge"><UserRound width={12} height={12} /> {t('common.profile')}</span>
        <h1 class="hero-title" style="font-size: 1.5rem">{t2('الملف الشخصي', 'Profile')}</h1>
        <p class="hero-sub">{t2('إعدادات حسابك — الاسم والصورة والأمان وتفضيلات الدخول.', 'Your account settings — name, avatar, security, and sign-in preferences.')}</p>
      </div>

      {/* Profile */}
      <div class="panel settings-section">
        <h2 class="panel-title">
          <span class="icon-wrap"><UserRound width={14} height={14} /></span> {t2('الملف الشخصي', 'Profile')}
        </h2>
        <p class="settings-hint">
          {t2('كيف تظهر أمام الفريق — الاسم والصورة والنبذة وجهة الاتصال.', 'How you appear across the team — name, avatar, bio and contact.')}
        </p>
        {profileLoading && user ? (
          <div class="inline-loading"><Loader2 width={14} height={14} class="icon spin" /> {t('common.loading')}</div>
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
                    {profile.avatarExt ? t2('تغيير الصورة', 'Change photo') : t2('رفع صورة', 'Upload photo')}
                  </button>
                  {profile.avatarExt && (
                    <button class="btn-danger sm" type="button" onClick={() => setAvatarRemoveOpen(true)} disabled={avatarBusy}>
                      {avatarBusy ? <Loader2 width={13} height={13} class="icon spin" /> : t2('إزالة', 'Remove')}
                    </button>
                  )}
                </div>
                <span class="settings-hint" style="margin: 0">{t2('PNG أو JPEG أو WebP · حتى 2 ميغابايت', 'PNG, JPEG or WebP · up to 2 MB')}</span>
              </div>
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                hidden
                onChange={pickAvatar}
                aria-label={t2('رفع صورة الملف الشخصي', 'Upload profile photo')}
              />
            </div>

            <label class="field-label">{t2('اسم المستخدم', 'Username')}</label>
            <div class="settings-row" style="margin:0 0 12px">
              <span class="mono" style="color: var(--text)">@{user?.username || '—'}</span>
              <span class="settings-hint" style="margin:0">{t2('يُستخدم لتسجيل الدخول — لا يمكن تغييره.', 'Used to sign in — cannot be changed.')}</span>
            </div>

            <label class="field-label">{t2('الاسم المعروض', 'Display name')}</label>
            <input
              class="modern-input"
              maxLength={60}
              placeholder={t2('كيف تظهر أمام الفريق', 'How you appear to the team')}
              value={profile.displayName || ''}
              onInput={(e: any) => setProfile({ ...profile, displayName: e.target.value })}
            />

            <label class="field-label">{t2('البريد الإلكتروني', 'Email')}</label>
            <input
              class="modern-input"
              type="email"
              maxLength={200}
              placeholder="you@example.com"
              value={profile.email || ''}
              onInput={(e: any) => setProfile({ ...profile, email: e.target.value })}
            />

            <label class="field-label">{t2('نبذة', 'Bio')}</label>
            <textarea
              class="modern-input"
              rows={3}
              maxLength={500}
              placeholder={t2('سطر قصير عنك — يظهر للفريق.', 'A short line about you — shown to the team.')}
              value={profile.bio || ''}
              onInput={(e: any) => setProfile({ ...profile, bio: e.target.value })}
            />

            <label class="privacy-check" style="display:flex;align-items:center;gap:10px;margin-top:16px;cursor:pointer">
              <input
                type="checkbox"
                checked={profile.emailVisible !== false}
                onChange={(e: any) => setProfile({ ...profile, emailVisible: (e.target as HTMLInputElement).checked })}
              />
              <span>
                {t2('إظهار البريد الإلكتروني لأعضاء الفريق', 'Show email to team members')}
                <span class="settings-hint" style="display:block;margin:0">{t2('عند الإيقاف يُخفى بريدك في ملفك العام.', 'When off, your email is hidden on your public profile.')}</span>
              </span>
            </label>

            {profileMsg && (
              <div class={profileMsg.type === 'ok' ? 'chat-save-msg' : 'login-error'} style="margin-top: 8px" role={profileMsg.type === 'ok' ? 'status' : 'alert'}>
                {profileMsg.text}
              </div>
            )}

            <div style="margin-top: 12px">
              <button class="btn-primary sm" type="button" onClick={saveProfile} disabled={profileSaving}>
                {profileSaving ? <Loader2 width={13} height={13} class="icon spin" /> : (
                  <>
                    <span class="icon-wrap"><UserCheck width={13} height={13} /></span> {t2('حفظ الملف الشخصي', 'Save profile')}
                  </>
                )}
              </button>
            </div>
          </>
        )}
      </div>

      {/* Account Info */}
      <div class="panel settings-section">
        <h2 class="panel-title">{t2('الحساب', 'Account')}</h2>
        <div class="settings-row">
          <span class="field-label">{t2('اسم المستخدم', 'Username')}</span>
          <span class="mono" style="color: var(--text)">{user?.username || '—'}</span>
        </div>
        <div class="settings-row">
          <span class="field-label">{t2('الدور', 'Role')}</span>
          <span style="color: var(--text-2)">{user?.role || '—'}</span>
        </div>
        <div class="settings-row">
          <span class="field-label">{t2('تاريخ الإنشاء', 'Created')}</span>
          <span style="color: var(--text-2)">{fmtDate(user?.createdAt, lang)}</span>
        </div>
        <div class="settings-row">
          <span class="field-label">{t2('آخر تغيير لكلمة المرور', 'Last password change')}</span>
          <span style="color: var(--text-2)">{fmtDate(user?.passwordChangedAt, lang)}</span>
        </div>
        <div style="margin-top: 12px">
          <button class="btn-danger sm" onClick={handleLogout}>
            <span class="icon-wrap"><LogOut width={13} height={13} /></span> {t('common.signOut')}
          </button>
        </div>
      </div>

      {/* Change Password */}
      <div class="panel settings-section">
        <h2 class="panel-title">{t2('تغيير كلمة المرور', 'Change Password')}</h2>
        <form onSubmit={changePassword}>
          <label class="field-label">{t2('كلمة المرور الحالية', 'Current Password')}</label>
          <input
            class="modern-input"
            type="password"
            placeholder={t2('كلمة المرور الحالية', 'Current password')}
            value={currentPw}
            onInput={(e: any) => setCurrentPw(e.target.value)}
          />

          <label class="field-label">{t2('كلمة المرور الجديدة', 'New Password')}</label>
          <input
            class="modern-input"
            type="password"
            placeholder={t2('6 أحرف على الأقل', 'Min 6 characters')}
            value={newPw}
            onInput={(e: any) => setNewPw(e.target.value)}
          />
          {newPw && <PwMeter pw={newPw} />}

          <label class="field-label">{t2('تأكيد كلمة المرور الجديدة', 'Confirm New Password')}</label>
          <input
            class="modern-input"
            type="password"
            placeholder={t2('تأكيد كلمة المرور الجديدة', 'Confirm new password')}
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
                  <Loader2 width={13} height={13} class="icon spin" /> {t2('جارٍ التغيير…', 'Changing…')}
                </span>
              ) : t2('تغيير كلمة المرور', 'Change Password')}
            </button>
          </div>
        </form>
      </div>

      {/* Two-factor authentication (TOTP) */}
      <div class="panel settings-section">
        <h2 class="panel-title">
          {t2('التحقق بخطوتين', 'Two-Factor Authentication')}
          {totpEnabled === true && (
            <span class="badge-ok" style="margin-inline-start: 8px;">
              <ShieldCheck width={11} height={11} /> {t2('مفعّل', 'On')}
            </span>
          )}
          {totpEnabled === false && (
            <span class="badge-off" style="margin-inline-start: 8px;">{t2('معطّل', 'Off')}</span>
          )}
        </h2>
        <p class="settings-hint">
          {t2('اطلب رمزاً من 6 أرقام من تطبيق مصادقة (Google Authenticator أو Authy أو Aegis…) بعد كلمة المرور عند كل دخول.', 'Require a 6-digit code from an authenticator app (Google Authenticator, Authy, Aegis…) after your password at every sign-in.')}
        </p>

        {totpMsg && (
          <div class={totpMsg.type === 'ok' ? 'chat-save-msg' : 'login-error'} style="margin-bottom: 8px" role={totpMsg.type === 'ok' ? 'status' : 'alert'}>
            {totpMsg.text}
          </div>
        )}

        {totpEnrolling ? (
          <form onSubmit={confirmEnable2fa}>
            <div class="totp-enroll">
              {qrDataUrl && <img class="totp-qr" src={qrDataUrl} alt={t2('رمز QR للمصادقة', 'Authenticator QR code')} />}
              <div class="totp-manual">
                <span class="field-label">{t2('لا تستطيع المسح؟ أدخل هذا المفتاح بدلاً منه', "Can't scan? Enter this key instead")}</span>
                <code class="totp-secret">{totpEnrolling.secret}</code>
                <span class="settings-hint">{t2('مبني على الوقت · SHA-1 · 6 أرقام · كل 30 ثانية — الافتراضي لأي تطبيق.', 'Time-based · SHA-1 · 6 digits · 30s — defaults for any app.')}</span>
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
                {totpBusy ? <Loader2 width={13} height={13} class="icon spin" /> : <ShieldCheck width={13} height={13} />} {t2('تفعيل', 'Activate')}
              </button>
              <button class="btn-ghost sm" type="button" onClick={cancelEnable2fa}>{t('common.cancel')}</button>
            </div>
            <p class="settings-hint" style="margin-top:8px;">
              {t2('امسح الرمز بتطبيقك ثم أدخل الرمز الحالي للتفعيل.', 'Scan the code with your app, then enter the current code to activate.')}
            </p>
          </form>
        ) : totpEnabled === true ? (
          <button class="btn-danger sm" onClick={beginDisable2fa}>
            <Smartphone width={13} height={13} /> {t2('تعطيل التحقق بخطوتين', 'Disable two-factor')}
          </button>
        ) : (
          <button class="btn-primary sm" onClick={beginEnable2fa} disabled={totpBusy}>
            {totpBusy ? <Loader2 width={13} height={13} class="icon spin" /> : <Smartphone width={13} height={13} />}
            {t2('تفعيل التحقق بخطوتين', 'Enable two-factor')}
          </button>
        )}
      </div>

      {/* Auto-logout on inactivity */}
      <div class="panel settings-section">
        <h2 class="panel-title">{t2('أمان الخمول', 'Idle security')}</h2>
        <p class="settings-hint">
          {t2('خروج تلقائي بعد فترة خمول — مع خيار إعادة قفل صفحة المزوّدين (يبطل رمز فتحها في كل مكان).', 'Sign out automatically after a period of inactivity — and optionally re-lock the Providers page (revokes its unlock token everywhere).')}
        </p>
        <div class="settings-row">
          <span class="field-label">{t2('خروج تلقائي', 'Auto-logout')}</span>
          <select
            class="modern-input"
            style="max-width: 160px"
            value={idleChoice}
            onChange={(e: any) => applyIdleChoice(e.target.value as IdleChoice)}
          >
            <option value="off">{t2('معطّل', 'Disabled')}</option>
            <option value="30">{t2('30 دقيقة', '30 minutes')}</option>
            <option value="60">{t2('ساعة واحدة', '1 hour')}</option>
            <option value="120">{t2('ساعتان', '2 hours')}</option>
          </select>
          {idleSaved && <span class="chat-save-msg" role="status">{t2('حُفظ ✓', 'Saved ✓')}</span>}
        </div>
        <div class="settings-row">
          <span class="field-label">{t2('إعادة قفل المزوّدين تلقائياً', 'Auto-relock Providers')}</span>
          <select
            class="modern-input"
            style="max-width: 160px"
            value={relockChoice}
            onChange={(e: any) => applyRelockChoice(e.target.value as RelockChoice)}
          >
            <option value="off">{t2('معطّل', 'Disabled')}</option>
            <option value="5">{t2('5 دقائق', '5 minutes')}</option>
            <option value="15">{t2('15 دقيقة', '15 minutes')}</option>
            <option value="30">{t2('30 دقيقة', '30 minutes')}</option>
          </select>
          {relockSaved && <span class="chat-save-msg" role="status">{t2('حُفظ ✓', 'Saved ✓')}</span>}
        </div>
      </div>

      {/* Logout everywhere */}
      <div class="panel settings-section">
        <h2 class="panel-title">{t2('خروج من كل الأجهزة', 'Logout Everywhere')}</h2>
        <p class="settings-hint">
          {t2('إبطال كل الجلسات النشطة — ستحتاج جميع التبويبات والأجهزة إلى تسجيل الدخول من جديد، وأنت كذلك.', 'Invalidate every signed-in session — all browser tabs and devices will need to log in again. You will be logged out here too.')}
        </p>
        {pwMsg && pendingAction === null && (
          <div class={pwMsg.type === 'ok' ? 'chat-save-msg' : 'login-error'} style="margin-bottom: 8px" role={pwMsg.type === 'ok' ? 'status' : 'alert'}>
            {pwMsg.text}
          </div>
        )}
        <button class="btn-danger sm" onClick={beginRevokeAll}>
          <span class="icon-wrap"><LogOut width={13} height={13} /></span> {t2('خروج من كل الأجهزة', 'Sign out everywhere')}
        </button>
      </div>

      {/* Account Activity */}
      <div class="panel settings-section">
        <h2 class="panel-title">{t2('نشاط الحساب', 'Account Activity')}</h2>
        <p class="settings-hint">{t2('أحداث حسابك: تسجيلات الدخول والتغييرات الأمنية وتحرير الملف الشخصي (الأحدث أولاً، آخر 50).', 'Events on your account: sign-ins, security changes, and profile edits (newest first, last 50).')}</p>
        {audit === null ? (
          <div class="inline-loading" role="status"><Loader2 width={12} height={12} class="icon spin" /> {t('common.loading')}</div>
        ) : audit.length === 0 ? (
          <div class="settings-hint">{t2('لا نشاط مسجّل بعد.', 'No activity recorded yet.')}</div>
        ) : (
          <AuditLog entries={audit} total={auditTotal} loadingMore={auditLoadingMore} onLoadMore={loadMoreAudit} />
        )}
      </div>

      {/* Remove avatar confirmation */}
      <ConfirmModal
        open={avatarRemoveOpen}
        title={t2('إزالة صورتك الشخصية؟', 'Remove your profile photo?')}
        message={t2('تُزال الصورة فوراً ويمكنك رفع صورة جديدة في أي وقت.', 'Your photo is removed immediately. You can upload a new one any time.')}
        confirmLabel={t2('إزالة الصورة', 'Remove photo')}
        danger
        loading={avatarBusy}
        onConfirm={() => { setAvatarRemoveOpen(false); removeAvatar(); }}
        onCancel={() => setAvatarRemoveOpen(false)}
      />

      {/* Combined identity confirmation */}
      <ReAuthModal
        open={pendingAction !== null}
        username={user?.username}
        loading={reauthLoading}
        error={reauthError}
        title={
          pendingAction === 'revoke-all'
            ? t2('خروج من كل الأجهزة؟', 'Sign out everywhere?')
            : t2('تعطيل التحقق بخطوتين', 'Disable two-factor authentication')
        }
        description={
          pendingAction === 'revoke-all'
            ? t2('سيُسجَّل خروجك من كل الأجهزة والتبويبات.', 'This signs you out of every device and browser tab.')
            : t2('سيحمي حسابك كلمة المرور فقط. ستؤكد هذا بكلمة مرور حسابك.', 'Your account will be protected by the password only. You will confirm this with your account password.')
        }
        confirmLabel={t('common.confirm')}
        onConfirm={executeReauth}
        onCancel={() => { setPendingAction(null); setReauthError(null); }}
      />
    </div>
  );
}
