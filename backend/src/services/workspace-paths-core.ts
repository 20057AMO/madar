/**
 * workspace-paths-core.ts
 * Madar — THE single containment primitive for every project-workspace path.
 *
 * NODE-BUILT-INS ONLY, transitively. The import graph of this file is exactly
 * { fs, path } -> ./project-slug-core -> path. `node --test` therefore loads it
 * offline — the same convention as janitor-core / storage-core / archive-core /
 * serve-core / alerts-core. The filesystem policy is the security boundary
 * between an HTTP request and the host disk, so it must be deterministically
 * unit-testable without a container.
 *
 * The single non-built-in import is `HttpError`, and it is deliberate: callers,
 * the Express error handler and the test suites all recognise ONE error class
 * (`instanceof HttpError` / `statusCode`). Declaring a second, structurally
 * identical class here would make every refusal an opaque 500 in one consumer
 * and a passing suite in another. `assertSafeStoreSlug` comes from the same
 * module so the slug trust boundary stays in exactly one place.
 *
 * WHY THIS EXISTS. Five consumers each re-implemented containment and each
 * re-implemented it slightly differently: the Files tab, the upload route,
 * the duplicate/copy path, the agent tools and the AI-context scanner. A
 * lexical `path.resolve(base, rel)` + `startsWith(base)` check is NOT
 * containment: a symlink or Windows junction *inside* the workspace satisfies
 * every lexical rule while the write lands anywhere the backend user can
 * reach (`x -> /app/data`, then upload `x/jwt.secret`). And a `realpath` of a
 * resolve-and-accept check is not enough either, because a link can be
 * re-pointed between the check and the use (TOCTOU).
 *
 * THE INVARIANT. A returned path is one where EVERY existing component below
 * the realpath'd workspace root is a real, non-link entry, and the final
 * component is strictly inside the workspace base. Links are refused outright
 * — including a link that currently points INSIDE the workspace — because
 * "inside right now" is not a property that survives the next write.
 */
import fs from 'fs';
import path from 'path';
import { HttpError, assertSafeStoreSlug } from './project-slug-core';

export interface ResolveOptions {
  /**
   * Allow the FINAL component to be a symlink/junction. Only for operations
   * that act ON the link itself (delete the link) and never for reads, writes
   * or anything that would follow it.
   */
  allowLinkLeaf?: boolean;
  /**
   * When false, a target that does not exist yet is accepted (create/rename
   * flows). Its deepest existing ancestor is still verified to be a real,
   * link-free directory strictly inside the root.
   */
  mustExist?: boolean;
  /** Message used for the 404 when `mustExist` is true and nothing is there. */
  missingMessage?: string;
}

function invalid(): HttpError {
  return new HttpError(400, 'Invalid path');
}

/** Case-insensitive containment on Windows, where the FS is case-insensitive. */
function inside(parent: string, child: string): boolean {
  const p = process.platform === 'win32' ? parent.toLowerCase() : parent;
  const c = process.platform === 'win32' ? child.toLowerCase() : child;
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/** Is this path strictly inside its parent (never equal to it)? */
function strictlyInside(parent: string, child: string): boolean {
  const same = process.platform === 'win32' ? parent === child.toLowerCase() : parent === child;
  return !same && inside(parent, child);
}

/**
 * The REAL workspace root. Every containment decision is made against this,
 * never against the raw env value: if `/workspaces` itself is a link, the
 * lexical prefix check would compare against a path the kernel never uses.
 */
export function realWorkspaceRoot(root: string): string {
  const resolved = path.resolve(root);
  try {
    return fs.realpathSync(resolved);
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      throw new HttpError(500, 'Workspace root is not available');
    }
    throw new HttpError(500, 'Workspace root is not readable');
  }
}

/**
 * Resolve a slug to its workspace directory, strictly inside the real root.
 * Throws 400 for anything that is not a single, canonical path segment.
 * Does NOT require the directory to exist — callers decide (404 vs create).
 */
export function resolveWorkspaceBase(root: string, slug: unknown): string {
  const realRoot = realWorkspaceRoot(root);
  const clean = assertSafeStoreSlug(slug, realRoot);
  const base = path.resolve(realRoot, clean);
  if (!strictlyInside(realRoot, base)) throw new HttpError(400, 'Project slug is invalid');
  return base;
}

/**
 * Resolve `rel` inside `slug`'s workspace, refusing traversal AND symlinks /
 * junctions at every level.
 *
 * Returns the LEXICAL path (identical to the real one by construction: no
 * component below the base may be a link). Throws:
 *   400 Invalid path           — traversal, escape, or a link component
 *   404 workspace not found    — the project dir does not exist
 *   404 missingMessage         — target missing while `mustExist`
 */
export function resolveContainedPath(
  root: string,
  slug: unknown,
  rel?: string,
  opts: ResolveOptions = {}
): string {
  const base = resolveWorkspaceBase(root, slug);

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(base);
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      throw new HttpError(404, `Project workspace '${String(slug ?? '')}' not found`);
    }
    throw invalid();
  }
  // The project dir itself must be real: a link here would make every
  // "inside the workspace" claim below a claim about the link's target.
  if (stat.isSymbolicLink()) throw invalid();

  const relClean = String(rel ?? '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  const isRootRequest = !relClean || relClean === '.';

  const parts = isRootRequest
    ? []
    : path.posix.normalize(relClean).split('/').filter((p) => p !== '.' && p !== '');

  if (!isRootRequest) {
    for (const part of parts) {
      if (part === '..') throw invalid();
    }
  }

  const target = parts.length === 0 ? base : path.resolve(base, ...parts);
  if (target !== base && !inside(base, target)) throw invalid();

  // Walk every component below the base. The first missing component ends the
  // walk: everything deeper is missing too, and the deepest existing ancestor
  // is what has to be proven real.
  let current = base;
  let deepestExisting = base;
  let missing = false;
  for (const part of parts) {
    current = path.join(current, part);
    let entry: fs.Stats;
    try {
      entry = fs.lstatSync(current);
    } catch (err: any) {
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') {
        missing = true;
        break;
      }
      // EACCES / ELOOP / EMFILE … — an unreadable component is never "fine",
      // it is an absence of proof, so fail closed.
      throw invalid();
    }
    const isLeaf = current === target;
    if (entry.isSymbolicLink()) {
      if (!(opts.allowLinkLeaf && isLeaf)) throw invalid();
      // An allowed leaf link is deliberately NOT adopted as the verified
      // component: realpath-ing it would resolve to the link's TARGET and the
      // containment proof below would (correctly) fail. The verified ancestor
      // stays the link's parent directory, which is what the caller acts on.
      break;
    }
    deepestExisting = current;
  }

  // Final containment proof against the REAL root, using the deepest existing
  // component: this is what catches a link ABOVE the root, and — when the walk
  // ended early on a missing segment — it is the real directory the remaining
  // plain segments will be created under. Those segments carry no separator
  // and no dot (rejected above), so appending them cannot leave that
  // directory; no second check is needed.
  const realRoot = realWorkspaceRoot(root);
  let realDeepest: string;
  let deepestStat: fs.Stats | null = null;
  try {
    realDeepest = fs.realpathSync(deepestExisting);
    deepestStat = fs.lstatSync(deepestExisting);
  } catch {
    throw invalid();
  }
  if (!strictlyInside(realRoot, realDeepest)) throw invalid();
  // Creating "file.txt/child.txt" must fail as an invalid path, not surface
  // later as an opaque mkdir/write 500.
  if (missing && deepestExisting !== base && !deepestStat!.isDirectory()) throw invalid();

  if (missing && opts.mustExist !== false) {
    throw new HttpError(404, opts.missingMessage || 'Path not found');
  }
  return target;
}

/**
 * Is the final component of `rel` a symlink / junction? Used by listings and
 * by tree walkers that must SKIP links rather than follow them. A missing
 * path is not a link; an unsafe path is reported as "not a link" so a caller
 * that skips links still refuses it via resolveContainedPath.
 */
export function workspaceLinkAt(root: string, slug: unknown, rel: string): boolean {
  try {
    // allowLinkLeaf is what this question is asking about: a link leaf is
    // exactly the answer, so refusing it would answer "false" for every link.
    const target = resolveContainedPath(root, slug, rel, { mustExist: false, allowLinkLeaf: true });
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Parse the client-supplied upload `paths` field: { "<original filename>": "<folder/name>" }.
 *
 * This field was ALWAYS dead code in the route: multer hands multipart fields
 * over as strings, so `req.body.paths` was raw JSON TEXT and indexing it as an
 * object returned undefined for any real filename — every upload silently fell
 * back to its bare name and landed in the workspace ROOT. Uploading into a
 * folder selected in the Files tab therefore never worked, and the folder
 * prefix the UI sends was discarded without a word.
 *
 * Parsing it makes the documented feature real, which is exactly why the write
 * target must then go through resolveContainedPath: the subdirectory the client
 * asks for becomes attacker-influenced input that reaches the filesystem.
 *
 * Junk degrades to {} (the pre-existing "everything lands at the root"
 * behaviour) rather than failing the whole upload, and only string values are
 * kept so a nested object/array can never reach path construction.
 */
export function parseUploadPaths(raw: unknown): Record<string, string> {
  if (typeof raw !== 'string' || !raw || raw.length > 64 * 1024) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/**
 * Workspace-relative POSIX form of a client-supplied upload path, or null when
 * it is unusable. This is a SHAPE filter only — it strips leading slashes,
 * refuses '..' segments and NUL, and caps the length. It is NOT containment:
 * resolveContainedPath remains the authority (it also refuses symlinked
 * components, which this cannot see), and every caller must still re-prove the
 * candidate it finally writes.
 */
export function uploadRelativePath(raw: unknown): string | null {
  // Strictly a string: `String({})` is the perfectly valid-looking
  // '[object Object]', so stringifying junk here would invent a filename out of
  // it instead of falling back to the bare one.
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  const clean = value.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean === '.') return null;
  if (clean.startsWith('..') || clean.includes('/../') || clean.endsWith('/..')) return null;
  if (clean.includes('\0')) return null;
  return clean.slice(0, 1024);
}

/**
 * Non-throwing resolution for callers that treat "unusable path" as absent
 * (agent tools return null, the context scanner skips the entry) instead of
 * turning it into an HTTP error.
 */
export function tryResolveContainedPath(
  root: string,
  slug: unknown,
  rel?: string,
  opts: ResolveOptions = {}
): string | null {
  try {
    return resolveContainedPath(root, slug, rel, opts);
  } catch {
    return null;
  }
}