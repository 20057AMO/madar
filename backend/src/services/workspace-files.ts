/**
 * workspace-files.ts
 * Madar — Filesystem access to project workspaces for the Files tab:
 * safe path resolution (no traversal), directory listing, text preview,
 * write/create, rename/move, and delete. Uploads exist via
 * /api/projects/:slug/upload.
 */
import fs from 'fs';
import path from 'path';
import { HttpError, WORKSPACES_ROOT } from './docker-manager';
import { IGNORED_DIRS, invalidateProjectContext } from './project-context';

const MAX_PREVIEW_CHARS = 200 * 1024;

export interface FileEntry {
  path: string;
  type: 'file' | 'dir';
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
  const base = path.resolve(WORKSPACES_ROOT, String(slug ?? '').replace(/[^a-z0-9._-]+/gi, ''));
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

/** Resolve a workspace path safely; throws on traversal or missing workspace. */
export function resolveWorkspacePath(slug: string, rel?: string): string {
  const cleanSlug = String(slug ?? '').replace(/[^a-z0-9._-]+/gi, '');
  const base = path.resolve(WORKSPACES_ROOT, cleanSlug);
  if (!fs.existsSync(base)) throw new HttpError(404, `Project workspace '${cleanSlug}' not found`);

  const relClean = String(rel ?? '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  if (!relClean || relClean === '.') return base;

  const normalized = path.posix.normalize(relClean);
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new HttpError(400, 'Invalid path');
  }
  const target = path.resolve(base, normalized);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new HttpError(400, 'Invalid path');
  }
  return target;
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
    } else if (item.isFile()) {
      let st: fs.Stats;
      try {
        st = fs.statSync(path.join(dir, item.name));
      } catch {
        continue;
      }
      entries.push({
        path: item.name,
        type: 'file',
        size: st.size,
        mtime: st.mtime.toISOString(),
      });
      fileCount += 1;
      totalBytes += st.size;
    }
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.path.localeCompare(b.path);
  });

  return { entries, fileCount, dirCount, totalBytes, truncated: false };
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

  const buf = fs.readFileSync(target);
  const binary = buf.length > 0 && buf.subarray(0, 8192).includes(0);
  const size = buf.length;
  if (binary) return { content: '', truncated: false, size, binary: true };

  let text = buf.toString('utf8');
  const truncated = text.length > MAX_PREVIEW_CHARS;
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

export function deleteWorkspacePath(slug: string, rel: string): { ok: boolean; type: 'file' | 'dir' } {
  const base = path.resolve(WORKSPACES_ROOT, String(slug ?? '').replace(/[^a-z0-9._-]+/gi, ''));
  const target = resolveWorkspacePath(slug, rel);
  if (target === base) throw new HttpError(400, 'Cannot delete the workspace root');

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch {
    throw new HttpError(404, 'Path not found');
  }
  const type = stat.isDirectory() ? 'dir' : 'file';
  if (type === 'dir') fs.rmSync(target, { recursive: true, force: true });
  else fs.unlinkSync(target);
  invalidateProjectContext(slug);
  return { ok: true, type };
}

/** Matches agent-tools MAX_FILE_WRITE so UI edits and agents share one cap. */
const MAX_WRITE_CHARS = 500000;

/** Create or overwrite a text file inside the workspace. */
export function writeWorkspaceFile(
  slug: string,
  rel: string,
  content: string
): { ok: true; path: string; bytes: number } {
  const base = path.resolve(WORKSPACES_ROOT, String(slug ?? '').replace(/[^a-z0-9._-]+/gi, ''));
  const target = resolveWorkspacePath(slug, rel);
  if (target === base) throw new HttpError(400, 'Invalid file path');
  if (typeof content !== 'string') throw new HttpError(400, 'Content must be a string');
  if (content.length > MAX_WRITE_CHARS) {
    throw new HttpError(413, `File too large (${content.length} chars, max ${MAX_WRITE_CHARS})`);
  }

  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
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
  const dst = resolveWorkspacePath(slug, to);
  const base = path.resolve(WORKSPACES_ROOT, String(slug ?? '').replace(/[^a-z0-9._-]+/gi, ''));
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
