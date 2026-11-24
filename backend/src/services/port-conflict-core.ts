/**
 * port-conflict-core.ts
 * Pure rules for classifying Docker port-binding failures.
 * Import-free on purpose (node --test loads it directly, mirroring
 * serve-core.ts / alerts-core.ts): no service imports, no Docker types.
 */

export const PORTS_IN_USE_MESSAGE = 'One or more requested ports are already in use by another project or service.';

const CONFLICT_PHRASES = [
  'port is already allocated',
  'only one usage of each socket address',
  'address already in use',
] as const;

export function isPortConflictError(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized) return false;
  return CONFLICT_PHRASES.some((phrase) => normalized.includes(phrase))
    || /(^|[^a-z0-9])eaddrinuse([^a-z0-9]|$)/.test(normalized);
}
