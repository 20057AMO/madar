/**
 * workspace-files.ts
 * Madar — Filesystem access to project workspaces for the Files tab:
 * safe path resolution (no traversal), directory listing, text preview,
 * write/create, rename/move, and delete. Uploads exist via
 * /api/projects/:slug/upload.
 */
import fs from 'fs';
import path from 'path';
import { WORKSPACES_ROOT } from './docker-manager';
import { IGNORED_DIRS, invalidateProjectContext } from './project-context';
import { HttpError } from './project-slug-core';
import { writeContainedFile, renameContainedPath, resolveContainedPath, resolveWorkspaceBase, readContainedFile } from './workspace-paths-core';

const MAX_PREVIEW_CHARS = 200 * 1024;

/** Hard cap on directory-list rows — huge dirs get a truncated flag instead
 *  of shipping a multi-thousand-row array to the Files tab. Totals below
 *  (fileCount/totalBytes) always reflect the FULL directory, never the slice. */
const MAX_LIST_ENTRIES = 1000;

/**
 * Resolve a slug to its workspace dir, verified strictly inside the REAL
 * workspace root and refused when the dir itself is a link. Every path
 * consumer in this module goes through workspace-paths-core — see that file
 * for why a lexical `resolve` + `startsWith` check is not containment.
 */
function workspaceBase(slug: unknown): string {
  return resolveWorkspaceBase(WORKSPACES_ROOT, slug);
}

export interface FileEntry {
  path: string;
  /**
   * `link` is a symlink / Windows junction. It is listed so the user can SEE
   * and DELETE it — the alternative was a link that silently did not appear in
   * the Files tab and could not be removed through the API at all. Nothing
   * ever follows one: reads, previews, uploads and copies all refuse links.
   */
  type: 'file' | 'dir' | 'link';
  size: number;
  mtime: string;
}

export interface FileListing {
  entries: FileEntry[];
  fileCount: number;
  dirCount: number;
  totalBytes: number;
  truncated: boolean;
}

export interface SubdirInfo {
  subdir: string;
  /** Absolute workspace root on the host (used for IDE path). */
  hostPath: string;
  /** Path inside the project container (/workspace + subdir). */
  containerPath: string;
}

/**
 * Resolve the project's primary working directory inside the workspace.
 * Checks for a git repo at root first; otherwise picks the most likely
 * single subdirectory. The result is persisted in meta.subdir so it
 * survives restarts and only needs to be computed once.
 */
export function resolveProjectSubdir(slug: string): SubdirInfo {
  // Non-throwing on purpose: ws-terminal calls this without a try/catch. An
  // unsafe key falls back to the workspace ROOT rather than resolving `..`
  // outside it (the old behavior scanned the parent directory for git repos).
  let base: string;
  try {
    base = workspaceBase(slug);
  } catch {
    return { subdir: '', hostPath: path.resolve(WORKSPACES_ROOT), containerPath: '/workspace' };
  }
  if (!fs.existsSync(base)) {
    return { subdir: '', hostPath: base, containerPath: '/workspace' };
  }

  // 1. If the workspace root itself is a project root (has a git repo or
  //    known manifest), return ''.
  if (fs.existsSync(path.join(base, '.git'))) {
    return { subdir: '', hostPath: base, containerPath: '/workspace' };
  }

  // 2. Scan one level of subdirectories for the most likely project dir.
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return { subdir: '', hostPath: base, containerPath: '/workspace' };
  }

  const candidates = entries
    .filter((e) => e.isDirectory() && !IGNORED_DIRS.has(e.name))
    .map((e) => {
      const dir = path.join(base, e.name);
      let score = 0;
      if (fs.existsSync(path.join(dir, '.git'))) score = 3;
      else if (fs.existsSync(path.join(dir, 'package.json'))) score = 2;
      else if (fs.existsSync(path.join(dir, 'pyproject.toml'))) score = 1;
      else if (fs.existsSync(path.join(dir, 'Cargo.toml'))) score = 1;
      else if (fs.existsSync(path.join(dir, 'go.mod'))) score = 1;
      return { name: e.name, score };
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);

  if (candidates.length === 0) {
    return { subdir: '', hostPath: base, containerPath: '/workspace' };
  }

  // Prefer the highest-scoring single candidate.
  const subdir = candidates[0].name;
  return {
    subdir,
    hostPath: path.join(base, subdir),
    containerPath: `/workspace/${subdir}`,
  };
}

/**
 * Resolve a workspace path safely. Throws on traversal, on a symlink /
 * junction anywhere in the path, and on a missing workspace.
 *
 * `mustExist: false` is what lets the Files tab CREATE `new-folder/file.txt`:
 * the old lexical+realpath proof called `realpathSync` on the (not yet
 * existing) target's parent, so a path that did not exist yet failed the
 * containment check and every folder-creating write answered 404 "Path not
 * found" — while the UI label promised "folders allowed".
 */
export function resolveWorkspacePath(slug: string, rel?: string, opts: { mustExist?: boolean; allowLinkLeaf?: boolean } = {}): string {
  return resolveContainedPath(WORKSPACES_ROOT, slug, rel, {
    mustExist: opts.mustExist !== false,
    allowLinkLeaf: opts.allowLinkLeaf === true,
  });
}

export function listWorkspaceFiles(slug: string, rel?: string): FileListing {
  const dir = resolveWorkspacePath(slug, rel);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    throw new HttpError(404, 'Path not found');
  }
  if (!stat.isDirectory()) throw new HttpError(400, 'Not a directory');

  let items: fs.Dirent[];
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // Same rule as the rename path: an fs error message embeds absolute host
    // paths, so it is logged here and the client gets a generic sentence.
    console.error(`[workspace-files] readdir failed:`, err);
    throw new HttpError(500, 'Failed to read directory');
  }

  const entries: FileEntry[] = [];
  let fileCount = 0;
  let dirCount = 0;
  let totalBytes = 0;

  for (const item of items) {
    if (item.isDirectory()) {
      if (IGNORED_DIRS.has(item.name)) continue;
      entries.push({ path: item.name, type: 'dir', size: 0, mtime: '' });
      dirCount += 1;
    } else if (item.isFile() || item.isSymbolicLink()) {
      // lstat, never stat: a link's own size is what the link costs, and
      // stat-ing it would pull the TARGET's bytes into this workspace's totals
      // (the same rule storage-core.ts follows for disk usage).
      let st: fs.Stats;
      try {
        st = fs.lstatSync(path.join(dir, item.name));
      } catch {
        continue;
      }
      const isLink = st.isSymbolicLink();
      entries.push({
        path: item.name,
        type: isLink ? 'link' : 'file',
        size: st.size,
        mtime: st.mtime.toISOString(),
      });
      // A link is not a directory, so it counts (and bills) as a file row.
      fileCount += 1;
      totalBytes += st.size;
    }
  }

  entries.sort((a, b) => {
    if (a.type === 'dir' && b.type !== 'dir') return -1;
    if (b.type === 'dir' && a.type !== 'dir') return 1;
    return a.path.localeCompare(b.path);
  });

  const truncated = entries.length > MAX_LIST_ENTRIES;
  const listed = truncated ? entries.slice(0, MAX_LIST_ENTRIES) : entries;

  return { entries: listed, fileCount, dirCount, totalBytes, truncated };
}

export interface FilePreview {
  content: string;
  truncated: boolean;
  size: number;
  binary: boolean;
}

export function readWorkspaceFile(slug: string, rel: string): FilePreview {
  // The preview read is bound by the same primitive as every write. This used
  // to be `resolve` + `statSync` + `open` by NAME — statSync FOLLOWS a link, so
  // a planted `notes.txt -> /app/data/jwt.secret` was previewed, downloaded
  // and, through the AI-context scanner, pasted into chat prompts. Now the
  // link refusal and the descriptor identity proof come first, and the bytes
  // are copied OUT OF THE DESCRIPTOR at a fixed position (never re-resolved by
  // name). Refusals are 400/403/404 out of the primitive; a directory answers
  // 400 "Invalid path" (the old "Is a directory" text is gone with the
  // statSync that produced it — no caller asserted the string).
  const read = readContainedFile(WORKSPACES_ROOT, slug, rel, {
    maxBytes: MAX_PREVIEW_CHARS,
    invalidMessage: 'Invalid path',
    missingMessage: 'Path not found',
  });
  const size = read.size;
  const buf = read.data;
  const binary = buf.length > 0 && buf.subarray(0, Math.min(8192, buf.length)).includes(0);
  if (binary) return { content: '', truncated: size > buf.length, size, binary: true };

  let text = buf.toString('utf8');
  const truncated = size > buf.length;
  if (truncated) text = text.slice(0, MAX_PREVIEW_CHARS) + '\n… (preview truncated)';
  return { content: text, truncated, size, binary: false };
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.ts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.csv': 'text/csv',
  '.xml': 'application/xml',
  '.wasm': 'application/wasm',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.tgz': 'application/gzip',
};

/** Stream a workspace file's raw bytes (images, binaries, downloads). */
export function streamWorkspaceFile(
  slug: string,
  rel: string
): { stream: fs.ReadStream; size: number; mime: string } {
  const target = resolveWorkspacePath(slug, rel);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    throw new HttpError(404, 'File not found');
  }
  if (stat.isDirectory()) throw new HttpError(400, 'Is a directory');

  const ext = path.extname(target).toLowerCase();
  return {
    stream: fs.createReadStream(target),
    size: stat.size,
    mime: MIME_BY_EXT[ext] || 'application/octet-stream',
  };
}

export function deleteWorkspacePath(slug: string, rel: string): { ok: boolean; type: 'file' | 'dir' | 'link' } {
  const base = workspaceBase(slug);
  // allowLinkLeaf: deleting must be able to remove the LINK itself. Every other
  // operation refuses links, which used to make a link undeletable through the
  // API — it could not be listed either, so it was simply invisible.
  const target = resolveWorkspacePath(slug, rel, { allowLinkLeaf: true });
  if (target === base) throw new HttpError(400, 'Cannot delete the workspace root');

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch {
    throw new HttpError(404, 'Path not found');
  }
  // Order matters: lstat on a symlink reports the LINK, never its target, so a
  // link-to-directory is unlinked instead of rm -rf'd through.
  if (stat.isSymbolicLink()) {
    fs.unlinkSync(target);
    invalidateProjectContext(slug);
    return { ok: true, type: 'link' };
  }
  if (stat.isDirectory()) {
    fs.rmSync(target, { recursive: true, force: true });
    invalidateProjectContext(slug);
    return { ok: true, type: 'dir' };
  }
  fs.unlinkSync(target);
  invalidateProjectContext(slug);
  return { ok: true, type: 'file' };
}

/** Matches agent-tools MAX_FILE_WRITE so UI edits and agents share one cap. */
const MAX_WRITE_CHARS = 500000;

/** Create or overwrite a text file inside the workspace. */
export function writeWorkspaceFile(
  slug: string,
  rel: string,
  content: string
): { ok: true; path: string; bytes: number } {
  if (typeof content !== 'string') throw new HttpError(400, 'Content must be a string');
  if (content.length > MAX_WRITE_CHARS) {
    throw new HttpError(413, `File too large (${content.length} chars, max ${MAX_WRITE_CHARS})`);
  }
  // The write goes through the primitive's LINK-FREE open, not through
  // `mkdirSync` + `writeFileSync`. Both of those follow a symlink and expose no
  // O_NOFOLLOW, so the containment proof a moment earlier was a promise about
  // the past: an editor with root inside their own project container could swap
  // the entry between the proof and the write (measured: a canary outside the
  // workspace overwritten within ~2.2 s of racing). The kernel now refuses a
  // symlink leaf at open() time, and the caller writes into the returned
  // descriptor — there is no longer a second, link-following step. The 404 for
  // a missing workspace and the refusal of the bare workspace root both still
  // come from the primitive, unchanged.
  const out = writeContainedFile(WORKSPACES_ROOT, slug, rel, content, {
    mode: 'upsert',
    mkdirParents: true,
    invalidMessage: 'Invalid file path',
  });
  invalidateProjectContext(slug);
  return { ok: true, path: rel, bytes: out.bytes };
}

/** Rename or move a file/directory to another path in the same workspace. */
export function renameWorkspacePath(slug: string, from: string, to: string): { ok: true } {
  // This used to be the Files tab's one remaining check-then-USE: resolve both
  // ends (lstat every component), then `mkdirSync(dirname(dst), {recursive})`
  // + `renameSync(src, dst)` by NAME. `rename(2)` takes no O_NOFOLLOW and no
  // descriptor, so nothing about that pair re-verifies the directory the kernel
  // is about to walk — an editor racing a destination intermediate directory
  // (`rm -rf d; ln -s /app/data d`) moves a workspace file out of the
  // workspace. `renameContainedPath` pins each parent by descriptor, re-proves
  // from the kernel where that descriptor points, and hands the syscall the
  // procfs magic link, so a later swap of any ancestor name cannot redirect it.
  // See the block comment above `renameContainedPath` for the full argument and
  // for what is only narrowed on a platform without procfs.
  let moved = false;
  let pinned = false;
  try {
    const out = renameContainedPath(WORKSPACES_ROOT, slug, from, to);
    moved = !out.noop;
    pinned = out.pinned;
  } catch (err) {
    // F4: an fs error message embeds absolute host paths, so it is logged and
    // never reflected. The primitive already maps errno to a clean 4xx/5xx.
    if (err instanceof HttpError) throw err;
    console.error(`[workspace-files] rename failed in project '${slug}':`, err);
    throw new HttpError(500, 'Rename failed');
  }
  if (moved && !pinned) {
    // Never silently degrade. With the pin now FAIL-CLOSED this can only be a
    // platform without /proc/self/fd (Windows), where the primitive still
    // refused every link it saw — but say so where an operator will see it.
    console.warn(`[workspace-files] rename in project '${slug}' ran WITHOUT a descriptor pin (no /proc/self/fd)`);
  }
  if (moved) invalidateProjectContext(slug);
  return { ok: true };
}
