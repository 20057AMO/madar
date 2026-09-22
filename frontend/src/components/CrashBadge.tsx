import { crashTitle, crashSummary, type CrashInfo } from '../api';
import { useI18n } from '../i18n';

/**
 * Red "crashed" badge shown next to a project's status when the background
 * alert sweeper detected a non-user-initiated exit / OOM / auto-restart.
 * The visible label is localized; the tooltip keeps the full timestamped
 * details (localized summary + raw reason/exitCode for bug reports).
 */
export function CrashBadge({ crash }: { crash: CrashInfo }) {
  const { t } = useI18n();
  const title = `${crashSummary(crash, t)}\n[${crashTitle(crash)}]`;
  return <span class="status-badge error" title={title}>{t('status.crashed')}</span>;
}
