import { RefreshCw } from 'lucide-preact';
import { useI18n } from '../i18n';

export function ImageCurrentChip({ imageCurrent }: { imageCurrent?: boolean }) {
  const { t } = useI18n();
  if (imageCurrent !== false) return null;
  const label = t('workspaceImage.needsRecreate');
  return (
    <span class="meta-chip recreate" title={label}>
      <RefreshCw width={11} height={11} class="icon" /> {label}
    </span>
  );
}
