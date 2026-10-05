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
 *
 * AND WHY THAT IS STILL NOT ENOUGH ON ITS OWN. Everything above is a CHECK.
 * A check is only a proof until the thing it proved is used, and between the
 * `lstat` that approved a name and the `writeFileSync` that consumes it an
 * attacker who can plant links (an editor has root inside their own project
 * container, with the workspace bind-mounted) can swap the entry. That is the
 * TOCTOU the callers below were still exposed to: `copyFileSync` and
 * `writeFileSync` follow a leaf symlink and expose no O_NOFOLLOW, so proving
 * containment and then writing through those APIs is a decision made before
 * the fact and acted on after it.
 *
 * Therefore this module also exposes a LINK-FREE OPEN — `openContainedForWrite`
 * and its two wrappers. It hands back a FILE DESCRIPTOR, and the caller writes
 * into that descriptor and nothing else. The kernel, not a prior `lstat`,
 * refuses a symlink leaf (`O_NOFOLLOW`), and on Linux the opened inode's real
 * path is read back out of `/proc/self/fd/<fd>` and re-proved inside the
 * workspace, which is what also catches a swapped INTERMEDIATE directory.
 * See `linkFreeControls()` for the exact control set on the current platform.
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

// ── Link-free writes ────────────────────────────────────────────────────────
//
// Everything above this line is a CHECK; everything below is the USE. The
// difference is the whole security property, so it is stated once, here.

export type WriteMode =
  /** The name MUST be free: opened `O_CREAT|O_EXCL`, which fails EEXIST atomically. */
  | 'create'
  /** Create it, or open an existing regular file and replace its contents. */
  | 'upsert';

export interface LinkFreeWriteOptions {
  mode?: WriteMode;
  /** Unix mode for a created file (ignored when nothing is created). */
  fileMode?: number;
  /** Create missing parent directories (default true). */
  mkdirParents?: boolean;
  /** 400 text for a refused write. */
  invalidMessage?: string;
}

export interface LinkFreeHandle {
  /** The verified descriptor — write into THIS, never into the path again. */
  fd: number;
  /** Absolute, contained target path (for messages and the response shape). */
  path: string;
  /** True when this call created the file, false when it replaced one. */
  created: boolean;
}

export interface LinkFreeWriteResult {
  path: string;
  bytes: number;
  created: boolean;
}

/**
 * Which link-free controls are ACTUALLY available on this platform.
 *
 * `nofollow`   — `O_NOFOLLOW` is a real flag here, so the kernel itself refuses
 *                a symlink leaf (ELOOP) at open() time. This is the control that
 *                closes the race: no `lstat` result can be stale in the kernel.
 * `identity`   — the open is cross-checked against the entry that was inspected
 *                (fstat dev/ino must equal the pre-open lstat), so a swap that
 *                happened between the two is refused.
 * `procSelfFd` — `/proc/self/fd/<fd>` exists, so the OPENED inode's real path
 *                is read back from the kernel and re-proved inside the
 *                workspace. This is the only control that also catches a
 *                swapped INTERMEDIATE directory.
 *
 * WINDOWS, STATED EXPLICITLY: `fs.constants.O_NOFOLLOW` is `undefined` there
 * (Node does not define it on win32), so `nofollow` is false and passing it
 * would produce `flags |= undefined` → NaN → an invalid open. Windows does not
 * get the kernel refusal. What it does get is `identity` (a junction/reparse
 * leaf is refused by the pre-open lstat, and a swap between the lstat and the
 * open is caught by comparing fstat dev/ino against that lstat) and, for a
 * CREATE, `O_CREAT|O_EXCL` — which is atomic and portable, so a new-file write
 * is closed there too. What it does NOT get is the `/proc/self/fd` proof of
 * the opened path, so an intermediate-directory swap inside the same instant is
 * not detected. Madar runs in a Linux container in production, where all three
 * controls are active; this function exists so that difference is reported
 * rather than assumed.
 */
export function linkFreeControls(): { platform: string; nofollow: boolean; identity: boolean; procSelfFd: boolean } {
  return {
    platform: process.platform,
    nofollow: typeof NOFOLLOW === 'number' && Number.isFinite(NOFOLLOW) && NOFOLLOW > 0,
    identity: true,
    procSelfFd: process.platform === 'linux' && fs.existsSync('/proc/self/fd'),
  };
}

const NOFOLLOW: number | undefined =
  typeof (fs.constants as Record<string, unknown>).O_NOFOLLOW === 'number'
    ? ((fs.constants as unknown as Record<string, number>).O_NOFOLLOW)
    : undefined;
const DEFAULT_FILE_MODE = 0o644;
const COPY_CHUNK = 64 * 1024;

/** open() flags, never OR-ing an undefined O_NOFOLLOW (that is NaN). */
function writeFlags(base: number, withNoFollow: boolean): number {
  return withNoFollow && typeof NOFOLLOW === 'number' ? base | NOFOLLOW : base;
}

function errnoOf(err: unknown): string {
  return typeof (err as { code?: unknown })?.code === 'string' ? ((err as { code: string }).code) : '';
}

/**
 * Translate a filesystem refusal into the ONE error shape callers and the
 * Express handler already recognise. A raw errno must never escape as a 500:
 * ELOOP here means "you tried to write through a symlink", which is a client
 * refusal (400), not a server fault.
 */
function refusalFromErrno(err: unknown, invalidMessage: string): HttpError {
  switch (errnoOf(err)) {
    case 'ELOOP':
    case 'ENOTDIR':
    case 'EISDIR':
    case 'ENOENT':
    case 'EEXIST':
      return new HttpError(400, invalidMessage);
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return new HttpError(403, 'Workspace path is not writable');
    default:
      return new HttpError(500, (err as { message?: string })?.message || 'Write failed');
  }
}

/** Create the parent chain ONE component at a time, proving each one first. */
function ensureParentChain(base: string, parts: string[], invalidMessage: string): void {
  let current = base;
  for (const part of parts) {
    const next = path.join(current, part);
    try {
      // mkdirSync cannot create THROUGH a symlinked `part` (EEXIST), and
      // `current` was proved a real directory by the previous iteration.
      fs.mkdirSync(next);
    } catch (err: any) {
      if (errnoOf(err) !== 'EEXIST') throw refusalFromErrno(err, invalidMessage);
    }
    let entry: fs.Stats;
    try {
      entry = fs.lstatSync(next);
    } catch {
      throw new HttpError(400, invalidMessage);
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new HttpError(400, invalidMessage);
    // A directory we just created could still have been created through a
    // swapped parent. Re-prove where it ACTUALLY landed and undo it if that is
    // outside the workspace.
    let real: string;
    try {
      real = fs.realpathSync(next);
    } catch {
      throw new HttpError(400, invalidMessage);
    }
    if (!strictlyInside(base, real)) {
      try {
        fs.rmdirSync(next);
      } catch {
        /* best-effort undo; the refusal below is what matters */
      }
      throw new HttpError(400, invalidMessage);
    }
    current = next;
  }
}

/** The OPENED inode's real path, or null when the platform cannot report one. */
function openedFdRealPath(fd: number): string | null {
  if (!linkFreeControls().procSelfFd) return null;
  try {
    return fs.realpathSync(`/proc/self/fd/${fd}`);
  } catch {
    return null;
  }
}

/**
 * Open `rel` for writing and return a LINK-FREE descriptor.
 *
 * The caller must write into the returned `fd` and must not touch `path` again.
 * Order of operations, and why each step is load-bearing:
 *
 *   1. `resolveContainedPath(..., {mustExist:false})` — slug, root, traversal and
 *      every existing component's link-ness. Cheap, and it produces the good
 *      error message; it is NOT the control.
 *   2. Parent directories created and proved one at a time (see above).
 *   3. `open` with `O_NOFOLLOW` — the kernel refuses a symlink leaf. This is
 *      the step a prior `lstat` cannot do: the kernel evaluates the leaf in the
 *      same syscall that opens it, so there is no window to swap it in.
 *   4. `fstat` vs the pre-open `lstat` (dev/ino) — the opened object must BE
 *      the object that was inspected. Covers platforms without O_NOFOLLOW and
 *      closes the swap that happens between step 1 and step 3.
 *   5. `/proc/self/fd/<fd>` re-proof on Linux — the only step that also covers
 *      a swapped INTERMEDIATE directory, since the opened inode reports where
 *      it really lives.
 *
 * `mode:'create'` opens `O_CREAT|O_EXCL`, which is atomic and portable: a name
 * that already exists (or is a symlink) fails EEXIST instead of being adopted.
 * `mode:'upsert'` tries that FIRST (so a missing file is created, never
 * truncated-by-guess), and only on EEXIST re-opens without O_TRUNC and
 * `ftruncate`s the verified descriptor — O_TRUNC is never in the open flags of
 * a path whose link-ness has not already been decided by the kernel.
 */
export function openContainedForWrite(
  root: string,
  slug: unknown,
  rel: string,
  opts: LinkFreeWriteOptions = {}
): LinkFreeHandle {
  const invalidMessage = opts.invalidMessage || 'Invalid path';
  const mode: WriteMode = opts.mode === 'create' ? 'create' : 'upsert';
  const fileMode = typeof opts.fileMode === 'number' ? opts.fileMode : DEFAULT_FILE_MODE;

  // (1) The cheap proof + the lexical target. A missing project dir is still a
  // 404 here, which callers rely on for their not-found contract.
  const target = resolveContainedPath(root, slug, rel, { mustExist: false });
  const base = resolveWorkspaceBase(root, slug);
  if (target === base) throw new HttpError(400, invalidMessage);

  const relClean = String(rel ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = path.posix.normalize(relClean).split('/').filter((p) => p !== '.' && p !== '');
  const parents = parts.slice(0, -1);

  // (2) Parents, proved and created one at a time.
  if (parents.length > 0) {
    if (opts.mkdirParents === false) {
      let probe: fs.Stats;
      try {
        probe = fs.lstatSync(path.dirname(target));
      } catch {
        throw new HttpError(404, 'Parent directory not found');
      }
      if (probe.isSymbolicLink() || !probe.isDirectory()) throw new HttpError(400, invalidMessage);
    } else {
      ensureParentChain(base, parents, invalidMessage);
    }
  }

  const controls = linkFreeControls();

  // Pre-open inspection. Absent is fine (that is a create); a link or a
  // non-regular entry is a refusal — a FIFO would also BLOCK an O_WRONLY open,
  // and a directory is not a file at all.
  let expected: string | null = null;
  try {
    const st = fs.lstatSync(target);
    if (st.isSymbolicLink()) throw new HttpError(400, invalidMessage);
    if (!st.isFile()) throw new HttpError(400, invalidMessage);
    expected = `${st.dev}:${st.ino}`;
  } catch (err: any) {
    if (err instanceof HttpError) throw err;
    if (errnoOf(err) !== 'ENOENT') throw refusalFromErrno(err, invalidMessage);
  }

  // (3) The kernel-enforced open.
  let fd = -1;
  let created = false;
  try {
    fd = fs.openSync(
      target,
      writeFlags(fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, controls.nofollow),
      fileMode
    );
    created = true;
  } catch (err: any) {
    const code = errnoOf(err);
    if (code === 'ELOOP') throw new HttpError(400, invalidMessage);
    if (mode === 'create') {
      // 'create' means "this name must be free": an existing entry is the
      // caller's problem to resolve (the upload route de-duplicates), not ours
      // to adopt.
      throw refusalFromErrno(err, invalidMessage);
    }
    if (code !== 'EEXIST') throw refusalFromErrno(err, invalidMessage);

    // upsert on an existing file: re-open WITHOUT O_TRUNC so nothing is
    // modified until the descriptor itself has been verified below.
    try {
      fd = fs.openSync(target, writeFlags(fs.constants.O_WRONLY, controls.nofollow));
    } catch (inner: any) {
      throw refusalFromErrno(inner, invalidMessage);
    }
  }

  try {
    // (4) The opened object must be the object that was inspected.
    let opened: fs.Stats;
    try {
      opened = fs.fstatSync(fd);
    } catch {
      throw new HttpError(400, invalidMessage);
    }
    if (!opened.isFile()) throw new HttpError(400, invalidMessage);
    if (expected !== null && `${opened.dev}:${opened.ino}` !== expected) {
      throw new HttpError(400, invalidMessage);
    }

    // (5) The opened inode's real path, straight out of the kernel.
    const realOpened = openedFdRealPath(fd);
    if (realOpened !== null && !strictlyInside(base, realOpened)) {
      throw new HttpError(400, invalidMessage);
    }

    if (!created) fs.ftruncateSync(fd, 0);
    return { fd, path: target, created };
  } catch (err) {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
    throw err;
  }
}

/** Write a string/Buffer into a link-free descriptor and close it. */
export function writeAndClose(fd: number, data: string | Buffer): number {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  let written = 0;
  try {
    while (written < buf.length) {
      written += fs.writeSync(fd, buf, written, buf.length - written);
    }
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* already closed */
    }
  }
  return buf.length;
}

/** Create or replace a workspace file through the link-free open. */
export function writeContainedFile(
  root: string,
  slug: unknown,
  rel: string,
  data: string | Buffer,
  opts: LinkFreeWriteOptions = {}
): LinkFreeWriteResult {
  const handle = openContainedForWrite(root, slug, rel, opts);
  const bytes = writeAndClose(handle.fd, data);
  return { path: handle.path, bytes, created: handle.created };
}

/**
 * Copy a local file into the workspace through the link-free open, in bounded
 * chunks. `copyFileSync` follows symlinks and has no O_NOFOLLOW, which is how
 * the upload route wrote through a planted link; streaming into the verified
 * descriptor is the same fix for the upload path, without ever holding a
 * 200 MB upload in memory.
 */
export function copyContainedFile(
  root: string,
  slug: unknown,
  rel: string,
  srcPath: string,
  opts: LinkFreeWriteOptions = {}
): LinkFreeWriteResult {
  const handle = openContainedForWrite(root, slug, rel, opts);
  const buf = Buffer.allocUnsafe(COPY_CHUNK);
  let total = 0;
  let srcFd = -1;
  try {
    srcFd = fs.openSync(srcPath, 'r');
    for (;;) {
      const n = fs.readSync(srcFd, buf, 0, buf.length, null);
      if (n <= 0) break;
      let off = 0;
      while (off < n) off += fs.writeSync(handle.fd, buf, off, n - off);
      total += n;
    }
  } catch (err) {
    try {
      fs.closeSync(handle.fd);
    } catch {
      /* already closed */
    }
    throw err;
  } finally {
    if (srcFd >= 0) {
      try {
        fs.closeSync(srcFd);
      } catch {
        /* already closed */
      }
    }
  }
  try {
    fs.closeSync(handle.fd);
  } catch {
    /* already closed */
  }
  return { path: handle.path, bytes: total, created: handle.created };
}