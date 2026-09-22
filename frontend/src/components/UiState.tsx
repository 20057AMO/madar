import type { ComponentChildren } from 'preact';
import { Inbox } from 'lucide-preact';

/**
 * Skeleton loading placeholder. `rows` renders that many shimmer lines of
 * varying widths — enough for most list/card panels.
 */
export function Skeleton({ rows = 3, style }: { rows?: number; style?: string | Record<string, string> }) {
  const widths = ['w80', 'w60', 'w40', 'w70'];
  return (
    <div class="skel-block" style={style} role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div class={`skel-line ${widths[i % widths.length]}`} key={i} />
      ))}
    </div>
  );
}

/**
 * Empty/error state with an icon, a message, and an optional action button.
 * `tone` switches between a neutral empty state and a red error state.
 */
export function EmptyState({
  icon,
  message,
  hint,
  tone = 'empty',
  action,
  style,
}: {
  icon?: ComponentChildren;
  message: string;
  hint?: string;
  tone?: 'empty' | 'error';
  action?: ComponentChildren;
  style?: string | Record<string, string>;
}) {
  return (
    <div
      class={`ui-empty${tone === 'error' ? ' ui-empty-error' : ''}`}
      role={tone === 'error' ? 'alert' : 'status'}
      style={style}
    >
      <div class="ui-empty-icon">{icon ?? <Inbox width={26} height={26} />}</div>
      <div class="ui-empty-msg">{message}</div>
      {hint && <div class="ui-empty-hint">{hint}</div>}
      {action && <div class="ui-empty-action">{action}</div>}
    </div>
  );
}
