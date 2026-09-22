import { createContext, type ComponentChildren } from 'preact';
import { useState, useEffect, useContext, useCallback, useMemo, useRef } from 'preact/hooks';
import { CheckCircle2, XCircle, TriangleAlert, Info, X } from 'lucide-preact';
import { useI18n } from '../i18n';

export type ToastKind = 'success' | 'error' | 'warn' | 'info';

export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
  /** Auto-dismiss after this many ms (default 4500; errors stick to 8000). */
  ttl?: number;
}

interface ToastState {
  /** Fire a toast; returns its id. */
  push: (kind: ToastKind, text: string, opts?: { ttl?: number }) => number;
  success: (text: string) => number;
  error: (text: string) => number;
  warn: (text: string) => number;
  info: (text: string) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastState>({
  push: () => 0,
  success: () => 0,
  error: () => 0,
  warn: () => 0,
  info: () => 0,
  dismiss: () => {},
});

export function useToast(): ToastState {
  return useContext(ToastContext);
}

const MAX_VISIBLE = 4;
const DEFAULT_TTL = 4500;
const ERROR_TTL = 8000;

let nextId = 1;

const KIND_ICON = {
  success: CheckCircle2,
  error: XCircle,
  warn: TriangleAlert,
  info: Info,
};

export function ToastProvider({ children }: { children: ComponentChildren }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    setToasts((cur) => cur.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const timer of map.values()) clearTimeout(timer);
      map.clear();
    };
  }, []);

  const push = useCallback((kind: ToastKind, text: string, opts?: { ttl?: number }) => {
    const id = nextId++;
    const ttl = opts?.ttl ?? (kind === 'error' ? ERROR_TTL : DEFAULT_TTL);
    setToasts((cur) => [...cur.slice(-(MAX_VISIBLE - 1)), { id, kind, text, ttl }]);
    timers.current.set(
      id,
      window.setTimeout(() => dismiss(id), ttl),
    );
    return id;
  }, [dismiss]);

  const api = useMemo<ToastState>(() => ({
    push,
    success: (text) => push('success', text),
    error: (text) => push('error', text),
    warn: (text) => push('warn', text),
    info: (text) => push('info', text),
    dismiss,
  }), [push, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div class="toast-stack" role="region" aria-label="Notifications">
        {toasts.map((t) => (
          <ToastRow key={t.id} toast={t} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastRow({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const { t } = useI18n();
  const Icon = KIND_ICON[toast.kind];
  return (
    <div
      class={`toast toast-${toast.kind}`}
      role={toast.kind === 'error' ? 'alert' : 'status'}
      aria-live={toast.kind === 'error' ? 'assertive' : 'polite'}
    >
      <Icon width={15} height={15} class="icon" />
      <span class="toast-text">{toast.text}</span>
      <button
        class="toast-x"
        aria-label={t('toast.dismiss')}
        onClick={() => onDismiss(toast.id)}
      >
        <X width={13} height={13} />
      </button>
    </div>
  );
}
