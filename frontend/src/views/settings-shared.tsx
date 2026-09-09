import type { AuditEntry } from '../api';

export const AUDIT_LABELS: Record<string, string> = {
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

export type Msg = { type: 'ok' | 'err'; text: string } | null;

export function fmtDate(iso?: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
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
  return (
    <div class="audit-list">
      {entries.map((e, i) => {
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
      {entries.length < total && (
        <button
          class="btn-ghost sm"
          style="width: 100%; margin-top: 8px; justify-content: center;"
          onClick={onLoadMore}
          disabled={loadingMore}
        >
          {loadingMore ? 'Loading…' : `Show more (${total - entries.length} remaining)`}
        </button>
      )}
    </div>
  );
}
