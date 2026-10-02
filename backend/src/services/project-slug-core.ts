/**
 * project-slug-core.ts
 * Madar — Pure project-slug rules, shared by the auth boundary, the meta store
 * and the workspace filesystem layer.
 *
 * Import-free of OTHER modules (only node:path — the same convention as
 * janitor-core.ts / storage-core.ts / archive-core.ts): the slug is the trust
 * boundary between the HTTP layer and the filesystem, so its folding and
 * containment rules must be deterministically unit-testable without a
 * container.
 *
 * Two different slug sanitizers coexist in this codebase and must NOT be
 * conflated:
 *   - `canonicalProjectSlug` — the project IDENTITY form ([a-z0-9-], <=32):
 *     dots and slashes cannot survive, so it is used at the route boundary.
 *   - `cleanStoreSlug` — the STORAGE key form ([a-z0-9._-]): it deliberately
 *     KEEPS dots because legacy project dirs/files named with dots and
 *     underscores exist on disk. That is why it is never a security control by
 *     itself: `..` passes through unchanged. Every store path MUST therefore
 *     also assert containment (see assertSafeStoreSlug / isStrictlyInside) —
 *     the filter alone is structural noise, the containment check is the sandbox.
 */
import path from 'path';

/** HTTP error with a status code — mirrors the HttpError shape in
 * docker-manager.ts (kept local so this module stays import-free). */
export class HttpError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

/** Slugs that collide with Madar's own reserved names / docker resource names. */
export const RESERVED_SLUGS = ['wsd', 'ide', 'admin', 'api', 'system', 'root', 'workspace'];

/**
 * Fold any input to the canonical project-slug form, WITHOUT throwing.
 *
 * `validateProjectSlug` is the enforcing wrapper (it rejects empty + reserved
 * values); routes that must authorise on the SAME string the rest of the
 * pipeline acts on need the fold itself: evaluating the access gate against a
 * raw, unfurled value lets a near-miss ("my-project!") miss the meta store,
 * trip the legacy no-meta fallback, and still resolve to the real project
 * downstream. Returns '' when nothing usable remains — the caller decides
 * whether that is a 400 (malformed) or a 404 (no such project).
 */
export function canonicalProjectSlug(slug: unknown): string {
  return String(slug ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

/** Throwing variant — rejects empty + reserved values (used at project creation). */
export function validateProjectSlug(slug: string): string {
  const clean = canonicalProjectSlug(slug);
  if (!clean) throw new HttpError(400, 'Project slug is invalid');
  if (RESERVED_SLUGS.includes(clean)) {
    throw new HttpError(400, `Project slug '${clean}' is reserved and cannot be used.`);
  }
  return clean;
}

/**
 * The storage-key filter shared by the meta store and the workspace filesystem
 * layer: strips anything outside [a-z0-9._-]. This is what makes `../x` and
 * `a/b` collapse to a single path segment (`..x`, `ab`) — but note it KEEPS
 * dots, so `.` / `..` survive untouched. Never use this filter alone as a
 * security boundary; pair it with containment (assertSafeStoreSlug).
 */
export function cleanStoreSlug(slug: unknown): string {
  return String(slug ?? '').replace(/[^a-z0-9._-]+/gi, '');
}

/**
 * Strict containment: is `child` strictly inside `parent`? `child === parent`
 * is NOT inside — a project store can never BE the root it lives under.
 * Both arguments are expected already `path.resolve`d.
 */
export function isStrictlyInside(parent: string, child: string): boolean {
  return child !== parent && child.startsWith(parent + path.sep);
}

/**
 * Resolve + verify a store-key slug against its root directory. Throws 400 for
 * anything that cannot be a real store dir: empty, a bare dot-path (`.` / `..`
 * — which the store filter deliberately lets through) or a raw path separator
 * (a real slug can never contain one; refusing the raw value keeps `a/b` from
 * being silently collapsed into the unrelated-looking `ab`).
 */
export function assertSafeStoreSlug(slug: unknown, root: string): string {
  const raw = String(slug ?? '');
  if (!raw || raw === '.' || raw === '..' || raw.includes('/') || raw.includes('\\')) {
    throw new HttpError(400, 'Project slug is invalid');
  }
  const clean = cleanStoreSlug(raw);
  if (!clean || clean === '.' || clean === '..' || clean !== raw) {
    throw new HttpError(400, 'Project slug is invalid');
  }
  // Defense in depth: even a canonical-looking store key must resolve strictly
  // inside the root. `..x` is a single segment (safe), `.`/`..` are refused
  // above — this also guards against a future filter regression.
  const resolved = path.resolve(root, clean);
  if (!isStrictlyInside(path.resolve(root), resolved)) {
    throw new HttpError(400, 'Project slug is invalid');
  }
  return clean;
}