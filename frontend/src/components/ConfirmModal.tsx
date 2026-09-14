import { useEffect, useRef } from 'preact/hooks';
import { TriangleAlert, Loader2 } from 'lucide-preact';

interface ConfirmModalProps {
  open: boolean;
  /** Title SHOULD name the exact target, e.g. `Delete project 'my-app'?` */
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Danger = destructive action: warning avatar + red confirm button. */
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * In-app replacement for native window.confirm() — same dark modal language
 * as ReAuthModal so destructive actions never break the app's visual flow
 * with raw browser chrome. Implemented as a real dialog: role="dialog",
 * aria-modal, labelled/described, focus moved in on open, Tab trapped, and
 * focus restored to the trigger on close (WCAG 4.1.2 / 2.4.3 / 2.4.7).
 */
export function ConfirmModal({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  loading = false,
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const loadingRef = useRef(loading);
  loadingRef.current = loading;

  // On open, save the trigger and move focus into the dialog. Restore focus on close.
  useEffect(() => {
    if (!open) return;
    const trigger = document.activeElement as HTMLElement | null;
    const focusables = () =>
      overlayRef.current && overlayRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
    const first = focusables()?.[0] ?? null;
    (first || cancelRef.current || overlayRef.current)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (!loadingRef.current) onCancel();
        return;
      }
      if (e.key !== 'Tab') return;
      const nodes = focusables();
      if (!nodes || nodes.length === 0) return;
      const list = Array.from(nodes);
      const firstEl = list[0];
      const lastEl = list[list.length - 1];
      if (e.shiftKey && (document.activeElement === firstEl || document.activeElement === overlayRef.current)) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (trigger?.isConnected) trigger.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div class="modal-overlay" ref={overlayRef} onMouseDown={(e: any) => { if (e.target === e.currentTarget && !loading) onCancel(); }}>
      <form
        class="modal-card reauth-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby={message ? 'confirm-msg' : undefined}
        onSubmit={(e: Event) => {
          e.preventDefault();
          if (!loading) onConfirm();
        }}
      >
        <div class={`reauth-avatar${danger ? ' confirm-danger-avatar' : ''}`} aria-hidden="true">
          <TriangleAlert width={26} height={26} />
        </div>
        <div class="reauth-title" id="confirm-title" style="text-align:center">{title}</div>
        {message && <p class="settings-hint" id="confirm-msg" style="text-align:center">{message}</p>}
        <div style="display:flex; gap:8px; margin-top:14px; justify-content:center;">
          <button class="btn-ghost sm" type="button" ref={cancelRef} onClick={onCancel} disabled={loading}>
            {cancelLabel}
          </button>
          <button class={`${danger ? 'btn-danger' : 'btn-primary'} sm`} type="submit" disabled={loading}>
            {loading ? (
              <span style="display:inline-flex;align-items:center;gap:6px;">
                <Loader2 width={14} height={14} class="icon spin" /> Working…
              </span>
            ) : (
              confirmLabel
            )}
          </button>
        </div>
      </form>
    </div>
  );
}
