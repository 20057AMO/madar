import type { AuditEntry, ApplyState } from '../api';
import { useI18n } from '../i18n';

/** AR label map for audit events (keyed by backend event name). */
export const AUDIT_LABELS_AR: Record<string, string> = {
  setup: 'تم إنشاء الحساب',
  login: 'تسجيل دخول',
  'login-failed': 'فشل تسجيل الدخول',
  'logout-all': 'خروج من كل الأجهزة',
  'logout-all-failed': 'فشل الخروج من كل الأجهزة',
  'password-change': 'تغيير كلمة المرور',
  'password-change-failed': 'فشل تغيير كلمة المرور',
  'providers-lock-change': 'تحديث قفل المزوّدين',
  'providers-lock-change-failed': 'فشل تحديث قفل المزوّدين',
  'providers-unlock': 'فتح صفحة المزوّدين',
  'providers-unlock-failed': 'فشلت محاولة فتح المزوّدين',
  'providers-relock': 'قُفل المزوّدون على كل الأجهزة',
  '2fa-enabled': 'تفعيل التحقق بخطوتين',
  '2fa-enabled-failed': 'فشل تفعيل التحقق بخطوتين',
  '2fa-disabled': 'تعطيل التحقق بخطوتين',
  '2fa-disabled-failed': 'فشل تعطيل التحقق بخطوتين',
  'login-2fa-failed': 'حُجب الدخول — رمز المصادق غير صحيح',
  'backup-export': 'تصدير نسخة احتياطية',
  'backup-import': 'استيراد نسخة احتياطية',
  'user-created': 'إنشاء مستخدم',
  'user-role-changed': 'تغيير دور مستخدم',
  'user-deleted': 'إزالة مستخدم',
  'snapshot-save': 'التقاط لقطة',
  'snapshot-config-change': 'تغيير جدولة اللقطات',
  'snapshot-download': 'تنزيل لقطة',
  'snapshot-delete': 'حذف لقطة',
  'snapshot-restore': 'استعادة لقطة إلى مشروع',
  'project-tags': 'تحديث بيانات المشروع',
  'serve-start': 'بدء الموقع الثابت',
  'serve-start-failed': 'فشل بدء الموقع الثابت',
  'serve-stop': 'إيقاف الموقع الثابت',
  'project-files-deleted': 'حذف ملفات المشروع',
  'canvas-save': 'حفظ لوحة التخطيط',
  'chat-channel-settings': 'تغيير صلاحيات الإرسال في القناة',
  'chat-channel-settings-failed': 'فشل تغيير صلاحيات القناة',
  'workspace-janitor': 'أرشفة مساحات العمل اليتيمة',
  'opencode-studio': 'تحرير Opencode Studio',
  'opencode-update': 'تحديث Opencode',
  'opencode-update-failed': 'فشل تحديث Opencode',
  'opencode-update-rollback': 'تراجع تحديث Opencode',
  'code-server-update': 'تحديث VS Code',
  'code-server-update-failed': 'فشل تحديث VS Code',
  'code-server-update-rollback': 'تراجع تحديث VS Code',
  'updates-check': 'التحقق من التحديثات',
  'agent-run': 'اكتمال تشغيل الوكيل',
  'agent-run-failed': 'فشل تشغيل الوكيل',
};

/** EN label map for audit events. */
export const AUDIT_LABELS_EN: Record<string, string> = {
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
  'user-created': 'User created',
  'user-role-changed': 'User role changed',
  'user-deleted': 'User removed',
  'snapshot-save': 'Snapshot captured',
  'snapshot-config-change': 'Snapshot schedule changed',
  'snapshot-download': 'Snapshot downloaded',
  'snapshot-delete': 'Snapshot deleted',
  'snapshot-restore': 'Snapshot restored to a project',
  'project-tags': 'Project metadata updated',
  'serve-start': 'Static site started',
  'serve-start-failed': 'Static site start failed',
  'serve-stop': 'Static site stopped',
  'project-files-deleted': 'Project files deleted',
  'canvas-save': 'Planning canvas saved',
  'chat-channel-settings': 'Channel send permissions changed',
  'chat-channel-settings-failed': 'Channel send permissions change failed',
  'workspace-janitor': 'Orphan workspaces archived',
  'opencode-studio': 'Opencode Studio edited',
  'opencode-update': 'Opencode updated',
  'opencode-update-failed': 'Opencode update failed',
  'opencode-update-rollback': 'Opencode update rolled back',
  'code-server-update': 'VS Code updated',
  'code-server-update-failed': 'VS Code update failed',
  'code-server-update-rollback': 'VS Code update rolled back',
  'updates-check': 'Updates checked',
  'agent-run': 'Agent run completed',
  'agent-run-failed': 'Agent run failed',
};

export type Msg = { type: 'ok' | 'err'; text: string } | null;

/** Apply states that mean an update is actively running (used by the
 *  Updates panel AND the sidebar notification dot — must stay in sync). */
export const UPDATE_RUNNING_STATES: ApplyState[] = [
  'downloading',
  'verifying',
  'installing',
  'restarting',
  'verifying-boot',
  'rollback',
];

export function fmtDate(iso?: string, lang?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(lang === 'ar' ? 'ar' : undefined);
  } catch {
    return iso;
  }
}

export function AuditLog({
  entries,
  total,
  loadingMore,
  onLoadMore,
}: {
  entries: AuditEntry[];
  total: number;
  loadingMore: boolean;
  onLoadMore: () => void;
}) {
  const { t, lang } = useI18n();
  const labels = lang === 'ar' ? AUDIT_LABELS_AR : AUDIT_LABELS_EN;
  return (
    <div class="audit-list">
      {entries.map((e, i) => {
        const label = labels[e.event] || e.event;
        const failed = !e.ok || e.event.endsWith('-failed');
        return (
          <div class="audit-row" key={`${e.ts}-${i}`}>
            <span class={failed ? 'audit-dot bad' : 'audit-dot good'} title={t(failed ? 'audit.failed' : 'audit.success')} />
            <span class="audit-label">{label}</span>
            {e.ip && <span class="audit-ip" title={t('audit.sourceIp')}>{e.ip}</span>}
            <span class="audit-time">{fmtDate(e.ts, lang)}</span>
          </div>
        );
      })}
      {entries.length < total && (
        <button
          class="btn-ghost sm"
          style="width: 100%; margin-top: 8px; justify-content: center;"
          onClick={onLoadMore}
          disabled={loadingMore}
        >
          {loadingMore ? t('common.loading') : t('audit.showMore', { n: total - entries.length })}
        </button>
      )}
    </div>
  );
}
