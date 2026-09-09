import { useState } from 'preact/hooks';

const PALETTE = ['#3b82f6', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#f43f5e', '#84cc16'];

function hashName(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = ((h * 31 + name.charCodeAt(i)) >>> 0);
  return h;
}

/** Uppercase initials of the first two words — the always-available fallback. */
export function initials(name: string): string {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

interface Props {
  /** Display name or username — drives the initials and the deterministic color. */
  name: string;
  /** Avatar URL (from `avatarUrl()`), or null/undefined to render initials. */
  avatar?: string | null;
  size?: number;
  title?: string;
}

/**
 * Deterministic user avatar: renders the uploaded image when present, and
 * falls back (also on image error) to a colored initials disc.
 */
export function Avatar({ name, avatar, size = 28, title }: Props) {
  const [failed, setFailed] = useState(false);
  const color = PALETTE[hashName(name) % PALETTE.length];
  const label = title ?? name;
  const base: Record<string, string | number> = {
    width: size,
    height: size,
    borderRadius: '50%',
    background: `${color}26`,
    color,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: 600,
    fontSize: Math.max(10, Math.round(size * 0.38)),
    flexShrink: 0,
    overflow: 'hidden',
    userSelect: 'none',
  };

  if (avatar && !failed) {
    return (
      <img
        class="user-avatar"
        src={avatar}
        alt={label}
        title={label}
        loading="lazy"
        onError={() => setFailed(true)}
        style={{ ...base, background: 'var(--bg)', textIndent: '-9999px' }}
      />
    );
  }
  return (
    <div class="user-avatar" role="img" aria-label={label} title={label} style={base}>
      {initials(name)}
    </div>
  );
}