/**
 * AttachmentLightbox.tsx
 * Madar — full-screen preview for team-chat images. Same dark modal language
 * and focus discipline as ConfirmModal: trigger saved on open, focus moved to
 * the close button, Tab trapped, Esc closes, focus restored on close. Only the
 * currently-shown image is fetched (own refcount retire via
 * revokeChatAttachmentObjectUrl on switch/close).
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { X, ChevronLeft, ChevronRight, Loader2 } from 'lucide-preact';
import { chatAttachmentObjectUrl, revokeChatAttachmentObjectUrl } from '../api';

interface AttachmentLightboxProps {
  images: { id: string; name: string }[];
  index: number;
  onClose: () => void;
  onIndexChange: (i: number) => void;
}

export function AttachmentLightbox({ images, index, onClose, onIndexChange }: AttachmentLightboxProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  // Live index for the keydown listener — kept in a ref so ←/→ navigation
  // never re-runs the mount-only focus effect (which would steal focus).
  const indexRef = useRef(index);
  indexRef.current = index;
  const current = images[index];
  const count = images.length;

  // Fetch the current image only; retire the previous one when switching.
  // A failed fetch surfaces an in-dialog error + Retry instead of a forever
  // spinner (the api-side blob cache drops rejected promises, so Retry
  // genuinely refetches).
  useEffect(() => {
    if (!current) return;
    let alive = true;
    setUrl(null);
    setLoadError(false);
    chatAttachmentObjectUrl(current.id)
      .then((u) => { if (alive) setUrl(u); })
      .catch(() => { if (alive) setLoadError(true); });
    return () => {
      alive = false;
      revokeChatAttachmentObjectUrl(current.id);
    };
  }, [current?.id, retryTick]);

  // Focus discipline (ConfirmModal pattern) + Esc/arrow navigation.
  // Mount-only wiring: the trigger element is captured once, focus moves to
  // the close button once, the page scroll is locked while the overlay is
  // open, and ←/→ read the live index from a ref — so navigating between
  // images never re-subscribes, never re-focuses, and never steals focus.
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const focusables = () =>
      overlayRef.current && overlayRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
      );
    const onKey = (e: KeyboardEvent) => {
      const i = indexRef.current;
      const n = images.length;
      if (n === 0) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        onIndexChange((i + 1) % n);
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        onIndexChange((i - 1 + n) % n);
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
      document.body.style.overflow = prevOverflow;
      if (trigger?.isConnected) trigger.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      class="lightbox-overlay"
      ref={overlayRef}
      dir="ltr"
      role="dialog"
      aria-modal="true"
      aria-label={`Attachment preview: ${current?.name || ''}, ${index + 1} of ${count}`}
      onMouseDown={(e: any) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div class="lightbox-nav lightbox-prev" role="button" tabIndex={0} aria-label="Previous image" onClick={() => onIndexChange((index - 1 + count) % count)} onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onIndexChange((index - 1 + count) % count); } }}>
        <ChevronLeft width={22} height={22} />
      </div>

      <div class="lightbox-stage">
        {url ? (
          <img class="lightbox-img" src={url} alt={current?.name || 'attachment'} />
        ) : loadError ? (
          <div class="lightbox-error" role="alert">
            <span>Failed to load image</span>
            <button class="lightbox-retry" onClick={() => setRetryTick((t) => t + 1)} aria-label="Retry loading image">
              Retry
            </button>
          </div>
        ) : (
          <div class="lightbox-loading" role="status">
            <Loader2 width={28} height={28} class="icon spin" />
          </div>
        )}
        <div class="lightbox-caption">
          <span class="lightbox-name">{current?.name || ''}</span>
          <span class="dim">{index + 1}/{count}</span>
        </div>
      </div>

      <div class="lightbox-nav lightbox-next" role="button" tabIndex={0} aria-label="Next image" onClick={() => onIndexChange((index + 1) % count)} onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onIndexChange((index + 1) % count); } }}>
        <ChevronRight width={22} height={22} />
      </div>

      <button class="lightbox-close" ref={closeRef} onClick={onClose} aria-label="Close preview">
        <X width={20} height={20} />
      </button>
    </div>
  );
}