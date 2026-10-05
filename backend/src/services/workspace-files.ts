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
import { resolveContainedPath, resolveWorkspaceBase } from './workspace-paths-core';

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
  } catch (err: any) {
    throw new HttpError(500, err?.message || 'Failed to read directory');
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
  const target = resolveWorkspacePath(slug, rel);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    throw new HttpError(404, 'File not found');
  }
  if (stat.isDirectory()) throw new HttpError(400, 'Is a directory');

  const size = stat.size;
  // Bound the READ, not just the response: a huge workspace file must never be
  // slurped into memory only to be sliced. Read at most the preview budget.
  const readSize = Math.min(size, MAX_PREVIEW_CHARS);
  let buf: Buffer;
  if (readSize <= 0) {
    buf = Buffer.alloc(0);
  } else {
    const fd = fs.openSync(target, 'r');
    try {
      buf = Buffer.alloc(readSize);
      let off = 0;
      while (off < readSize) {
        const n = fs.readSync(fd, buf, off, readSize - off, off);
        if (n <= 0) break;
        off += n;
      }
      if (off < readSize) buf = buf.subarray(0, off);
    } finally {
      fs.closeSync(fd);
    }
  }
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
  const base = workspaceBase(slug);
  // mustExist:false — the target (and its parent folders) may not exist yet.
  // The primitive still proves the deepest existing ancestor is a real,
  // link-free directory strictly inside the workspace before we mkdir here.
  const target = resolveWorkspacePath(slug, rel, { mustExist: false });
  if (target === base) throw new HttpError(400, 'Invalid file path');
  if (typeof content !== 'string') throw new HttpError(400, 'Content must be a string');
  if (content.length > MAX_WRITE_CHARS) {
    throw new HttpError(413, `File too large (${content.length} chars, max ${MAX_WRITE_CHARS})`);
  }

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Re-prove containment AFTER creating the parents: mkdir is the only step
    // in this flow that touches the filesystem, and a link that appeared in a
    // race would otherwise make the write land outside the workspace.
    resolveWorkspacePath(slug, rel, { mustExist: false });
    fs.writeFileSync(target, content, 'utf8');
  } catch (err: any) {
    throw new HttpError(500, err?.message || 'Failed to write file');
  }
  invalidateProjectContext(slug);
  return { ok: true, path: rel, bytes: Buffer.byteLength(content, 'utf8') };
}

/** Rename or move a file/directory to another path in the same workspace. */
export function renameWorkspacePath(slug: string, from: string, to: string): { ok: true } {
  const src = resolveWorkspacePath(slug, from);
  // The destination may not exist yet — moving into a new folder has to work.
  const dst = resolveWorkspacePath(slug, to, { mustExist: false });
  const base = workspaceBase(slug);
  if (src === base || dst === base) throw new HttpError(400, 'Invalid rename path');
  if (src === dst) return { ok: true };
  if (!fs.existsSync(src)) throw new HttpError(404, 'Source not found');
  if (fs.existsSync(dst)) throw new HttpError(409, 'Target already exists');

  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.renameSync(src, dst);
  } catch (err: any) {
    throw new HttpError(500, err?.message || 'Rename failed');
  }
  invalidateProjectContext(slug);
  return { ok: true };
}
