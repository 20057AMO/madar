/**
 * project-public.ts
 * Madar — Pure payload-scrubbing helpers for project API responses.
 *
 * ProjectInfo.env holds the container's environment variables (API keys,
 * tokens, passwords). It is needed internally to (re)create containers but
 * must never be serialized to an API client — the dedicated editor-gated
 * GET/PUT /env routes are the only sanctioned read/write paths.
 *
 * Pure module: no imports (offline-testable by design, like the other
 * *-core.ts modules).
 */

/**
 * Strip `env` from a ProjectInfo before it is serialized to any API client.
 * Null-safe (getProject() can return null).
 */
export function publicProject<T extends { env?: Record<string, string> }>(p: T | null): Omit<T, 'env'> | null {
  if (!p || !('env' in p)) return p;
  const { env, ...rest } = p;
  void env;
  return rest;
}

/** publicProject() over a list (list entries are never null in practice). */
export function publicProjects<T extends { env?: Record<string, string> }>(list: T[]): Omit<T, 'env'>[] {
  return list.map((p) => publicProject(p) as Omit<T, 'env'>);
}
