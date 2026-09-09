/**
 * time.ts
 * Madar — shared relative-time helpers used across list views.
 */

/** Compact relative time: "now", "5m", "2h", "3d", else full ISO. */
export function relTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  return new Date(iso).toLocaleDateString();
}

/** Latest "touched" timestamp (ISO) for a project: newest activity entry vs
 *  the last canvas save, whichever is more recent. Null when neither exists. */
export function lastTouched(input: {
  activity?: { action: string; at: string; userId?: string }[] | null;
  canvasEditedAt?: string | null;
  createdAt?: string | null;
}): string | null {
  let best: string | null = null;
  const cands: Array<string | null | undefined> = [
    input.activity && input.activity.length > 0
      ? input.activity[input.activity.length - 1]?.at
      : null,
    input.canvasEditedAt,
    input.createdAt,
  ];
  for (const t of cands) {
    if (t && (!best || t > best)) best = t;
  }
  return best;
}

/** Humanized "last activity" label already relative to now. */
export function lastTouchedLabel(
  input: Parameters<typeof lastTouched>[0]
): string {
  const t = lastTouched(input);
  return t ? relTime(t) : '';
}
