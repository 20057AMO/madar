/**
 * project-snapshots.ts
 * Madar — Project snapshot export/restore.
 *
 * Export packs a project's workspace, developer notes, WSD_PROJECT.md (it
 * lives inside the workspace) and meta (name / description / image / ports /
 * env) into a single tar.gz containing:
 *
 *   manifest.json   — snapshot format version + project meta (env, ports…)
 *   notes.json      — the raw developer notes document
 *   canvas.json     — the raw visual planning canvas (only when non-empty)
 *   workspace/      — the project working directory (heavy regenerable dirs
 *                     excluded: .git, node_modules, build artifacts, …)
 *
 * Import restores the archive into a BRAND-NEW project with a unique slug,
 * ports reused when free (else re-allocated), so a snapshot never collides
 * with a running project. Both directions are streaming/guarded: a hand-rolled
 * POSIX-ustar writer (no third-party dep) and a hardened parser that rejects
 * path traversal, oversize output and absurd entry counts.
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { Readable } from 'stream';
import {
  HttpError,
  WORKSPACES_ROOT,
  createProject,
  getProject,
  listProjects,
  currentUsedPorts,
  resolvePorts,
  type ProjectInfo,
} from './docker-manager';
import { loadMeta } from './projects-meta';
import { loadNotes, saveNotes } from './project-notes';
import { loadCanvas, saveCanvas } from './project-canvas';

const BLOCK = 512;
const MAX_ENTRIES = 200_000;
const MAX_UNCOMPRESSED = 1024 * 1024 * 1024; // gunzip bomb guard (1 GiB)
const MAGIC_MADAR = 1;

/**
 * Directories excluded from a snapshot: all regenerable from a manifest /
 * package manager, and often enormous (a node_modules tree can dwarf the
 * actual sources). Skipping them keeps backups lean and within the upload
 * limit while preserving everything the user wrote.
 */
export const EXCLUDE_DIRS = new Set([
  '.git',
  'node_modules',
  '__pycache__',
  '.pyc',
  '.venv',
  'venv',
  'env',
  '.next',
  'dist',
  'build',
  'target',
  '.cache',
  '.terraform',
  '.serverless',
  'vendor',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.archive',
]);

interface SnapshotManifest {
  madar: number;
  appVersion?: string;
  exportedAt?: string;
  project?: {
    name?: string;
    slug?: string;
    description?: string;
    image?: string;
    ports?: number[];
    env?: Record<string, string>;
  };
}

// ── POSIX ustar writer (no deps; interoperable with GNU/bsdtar) ──────────

function writeOctal(buf: Buffer, offset: number, length: number, value: number): void {
  const digits = Math.max(0, Number(value) || 0).toString(8).padStart(length - 1, '0').slice(-(length - 1));
  buf.write(digits + (length % 2 === 0 ? '\0' : ' '), offset, length, 'ascii');
}

function tarHeader(entry: { name: string; size: number; mtime: number; type: '0' | '5' | 'L' }): Buffer {
  const h = Buffer.alloc(BLOCK);
  h.write(entry.name, 0, 100, 'ascii');
  writeOctal(h, 100, 8, 0o644);
  writeOctal(h, 108, 8, 0);
  writeOctal(h, 116, 8, 0);
  writeOctal(h, 124, 12, entry.size);
  writeOctal(h, 136, 12, entry.mtime);
  h.fill(0x20, 148, 156); // chksum placeholder
  h[156] = entry.type.charCodeAt(0);
  h.write('ustar  ', 257, 8, 'ascii'); // magic 'ustar' + GNU version '  '
  // uname/gname/devmajor/devminor stay zeroed; prefix unused (L handled below)
  return h;
}

/** Checksum a header (chksum field = 8 spaces), then store `%06o\0 `. */
function withChecksum(h: Buffer): Buffer {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return h;
}

/** Wrap a raw header so the tar stream includes the checksummed header. */
function* headerGen(entryCs: Buffer): Generator<Buffer> {
  yield entryCs;
}

/** Yield the header(s) for one entry (GNU long-name when name > 100 bytes). */
function* entryHeaders(name: string, size: number, mtime: number, type: '0' | '5'): Generator<Buffer> {
  const nameBytes = Buffer.from(name, 'utf8');
  if (nameBytes.length > 100) {
    // GNU long-link entry carrying the full name as its payload.
    yield withChecksum(tarHeader({ name: '././@LongLink', size: nameBytes.length, mtime, type: 'L' }));
    yield nameBytes;
    if (nameBytes.length % BLOCK !== 0) yield Buffer.alloc(BLOCK - (nameBytes.length % BLOCK));
  }
  yield* headerGen(withChecksum(tarHeader({ name: name.slice(0, 100), size, mtime, type })));
}

/** Async file entry: header(s) + streamed content + zero padding. */
async function* fileEntry(name: string, absPath: string, mtime: number): AsyncGenerator<Buffer> {
  const size = (await fs.promises.stat(absPath)).size;
  yield* entryHeaders(name, size, mtime, '0');
  if (size === 0) return;
  const handle = await fs.promises.open(absPath, 'r');
  try {
    const stream = handle.createReadStream();
    let written = 0;
    for await (const chunk of stream) {
      written += chunk.length;
      yield chunk;
    }
    if (written % BLOCK !== 0) yield Buffer.alloc(BLOCK - (written % BLOCK));
  } finally {
    await handle.close();
  }
}

function dirEntry(name: string, mtime: number): Buffer {
  return withChecksum(tarHeader({ name, size: 0, mtime, type: '5' }));
}

/** Recursive walk, pruning excluded subtrees; dirs emitted before children. */
async function* walkTree(absRoot: string, relRoot = ''): AsyncGenerator<{ name: string; abs: string; type: 'file' | 'dir'; mtime: number }> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(absRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (EXCLUDE_DIRS.has(e.name)) continue;
    const abs = path.join(absRoot, e.name);
    const rel = relRoot ? `${relRoot}/${e.name}` : e.name;
    let mtime = 0;
    try {
      const st = await fs.promises.stat(abs);
      mtime = Math.floor(st.mtimeMs / 1000);
    } catch {
      continue; // unreadable/broken entry — never fail the export over one file
    }
    if (e.isDirectory()) {
      yield { name: rel, abs, type: 'dir', mtime };
      yield* walkTree(abs, rel);
    } else if (e.isFile()) {
      yield { name: rel, abs, type: 'file', mtime };
    }
  }
}

// ── Export ────────────────────────────────────────────────────────────────

export interface ProjectSnapshot {
  stream: Readable;
  filename: string;
}

export function exportProjectSnapshot(slug: string): ProjectSnapshot {
  const meta = loadMeta(slug);
  if (!meta) throw new HttpError(404, `Project '${slug}' not found`);
  const workspaceDir = path.resolve(WORKSPACES_ROOT, String(slug ?? '').replace(/[^a-z0-9._-]+/gi, ''));
  const now = Math.floor(Date.now() / 1000);
  const manifest: SnapshotManifest = {
    madar: MAGIC_MADAR,
    appVersion: (process.env.WSD_APP_VERSION as string) || 'BETA',
    exportedAt: new Date().toISOString(),
    project: {
      name: meta.name,
      slug,
      description: meta.description,
      image: meta.image,
      ports: meta.ports,
      env: meta.env,
    },
  };

  async function* build(): AsyncGenerator<Buffer> {
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
    yield* entryHeaders('manifest.json', manifestBytes.length, now, '0');
    yield manifestBytes;
    if (manifestBytes.length % BLOCK !== 0) yield Buffer.alloc(BLOCK - (manifestBytes.length % BLOCK));

    try {
      const notesBytes = Buffer.from(JSON.stringify(loadNotes(slug), null, 2), 'utf8');
      yield* entryHeaders('notes.json', notesBytes.length, now, '0');
      yield notesBytes;
      if (notesBytes.length % BLOCK !== 0) yield Buffer.alloc(BLOCK - (notesBytes.length % BLOCK));
    } catch {
      /* notes unavailable → skip (still a valid snapshot) */
    }

    // Visual planning canvas: authored content like notes, so it ships in the
    // backup too. Only materialized when the board has anything on it.
    try {
      const canvasDoc = loadCanvas(slug);
      if (canvasDoc.nodes.length || canvasDoc.edges.length || (canvasDoc.sections?.length ?? 0)) {
        const canvasBytes = Buffer.from(JSON.stringify(canvasDoc, null, 2), 'utf8');
        yield* entryHeaders('canvas.json', canvasBytes.length, now, '0');
        yield canvasBytes;
        if (canvasBytes.length % BLOCK !== 0) yield Buffer.alloc(BLOCK - (canvasBytes.length % BLOCK));
      }
    } catch {
      /* canvas unavailable → skip (still a valid snapshot) */
    }

    yield withChecksum(tarHeader({ name: 'workspace/', size: 0, mtime: now, type: '5' }));
    for await (const entry of walkTree(workspaceDir)) {
      const name = `workspace/${entry.name}`;
      if (entry.type === 'dir') {
        yield dirEntry(`${name}/`, entry.mtime);
      } else {
        yield* fileEntry(name, entry.abs, entry.mtime);
      }
    }
    yield Buffer.alloc(BLOCK); // end-of-archive marker
    yield Buffer.alloc(BLOCK);
  }

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const stream = Readable.from(build()).pipe(zlib.createGzip());
  return { stream, filename: `madar-${slug}-${stamp}.tar.gz` };
}

// ── Import (read side) ────────────────────────────────────────────────────

function readOctal(buf: Buffer, offset: number, length: number): number {
  const raw = buf.subarray(offset, offset + length).toString('ascii').replace(/[^0-7]/g, '');
  return raw ? parseInt(raw, 8) : 0;
}

const align512 = (n: number) => Math.ceil(n / BLOCK) * BLOCK;

/** Validate an archive path; returns null on any traversal / abs / drive form. */
function cleanTarName(name: string): string | null {
  const norm = name.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = norm.split('/').filter(Boolean);
  if (!parts.length) return '.';
  if (parts.some((p) => p === '..' || p.includes('\0'))) return null;
  if (norm.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(norm)) return null;
  return parts.join('/');
}

/**
 * Extract a tar buffer into `dest` with hard guards: valid ustar magic,
 * size-limited (bomb-proofed by the caller), traversal-free names, cap on
 * entry count. Throws HttpError(400) on any violation.
 */
function extractTar(buf: Buffer, dest: string): void {
  const root = path.resolve(dest);
  let idx = 0;
  let pendingName: string | null = null;
  let count = 0;

  while (idx + BLOCK <= buf.length) {
    const hdr = buf.subarray(idx, idx + BLOCK);
    if (hdr.every((b) => b === 0)) break;
    if (hdr.subarray(257, 262).toString('ascii') !== 'ustar') {
      throw new HttpError(400, 'Snapshot is not a valid tar archive');
    }
    count++;
    if (count > MAX_ENTRIES) throw new HttpError(400, 'Snapshot contains too many entries');

    const size = readOctal(hdr, 124, 12);
    const type = String.fromCharCode(hdr[156]);
    if (type === 'L') {
      pendingName = buf.subarray(idx + BLOCK, idx + BLOCK + size).toString('utf8').replace(/\0+$/g, '');
      idx += BLOCK + align512(size);
      continue;
    }
    if (size > 0 && idx + BLOCK + size > buf.length) {
      throw new HttpError(400, 'Snapshot archive is truncated');
    }

    let name = pendingName || hdr.subarray(0, 100).toString('utf8').replace(/\0+$/g, '');
    pendingName = null;
    const clean = cleanTarName(name);
    if (clean === null || clean === '.') {
      throw new HttpError(400, 'Snapshot contains an unsafe path');
    }
    const target = path.resolve(root, clean);
    if (!target.startsWith(root + path.sep)) {
      throw new HttpError(400, 'Snapshot contains an unsafe path');
    }

    if (type === '0' || type === '\0') {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buf.subarray(idx + BLOCK, idx + BLOCK + size));
    } else if (type === '5') {
      fs.mkdirSync(target, { recursive: true });
    }
    // 'x' / 'g' / '1' (hardlink) / others: skip payload, no write
    idx += BLOCK + align512(size);
  }
}

function tryJson<T>(buf: Buffer | undefined): T | undefined {
  if (!buf) return undefined;
  try {
    return JSON.parse(buf.toString('utf8')) as T;
  } catch {
    return undefined;
  }
}

function sanitizeSlug(raw: string | undefined, name?: string): string {
  const fromSlug = String(raw ?? '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  if (fromSlug) return fromSlug;
  const fromName = String(name ?? 'restored-project')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return fromName || 'restored-project';
}

async function uniqueProjectSlug(base: string): Promise<string> {
  let slug = base;
  for (let n = 1; (await getProject(slug)) !== null; n++) slug = `${base}-${n}`;
  return slug;
}

/** Import a snapshot upload (path to the multer-saved tar.gz) as a NEW project.
 * Returns the created ProjectInfo (owner is attributed by the route, mirroring
 * the create-project flow).
 */
export async function importProjectSnapshot(uploadPath: string): Promise<ProjectInfo> {
  let raw: Buffer;
  try {
    raw = await fs.promises.readFile(uploadPath);
  } catch {
    throw new HttpError(400, 'Invalid upload file');
  }
  if (raw.length < 2 || raw[0] !== 0x1f || raw[1] !== 0x8b) {
    throw new HttpError(400, 'Not a snapshot archive (.tar.gz expected)');
  }
  let tarBuf: Buffer;
  try {
    tarBuf = zlib.gunzipSync(raw, { maxOutputLength: MAX_UNCOMPRESSED });
  } catch (err: any) {
    throw new HttpError(400, err?.code === 'ERR_BUFFER_TOO_LARGE' ? 'Snapshot expands beyond the size limit' : 'Corrupt snapshot archive');
  }

  const staging = fs.mkdtempSync(path.join(process.env.WSD_TMP_DIR || '/tmp', 'wsd-import-'));
  try {
    extractTar(tarBuf, staging);

    const manifest = tryJson<SnapshotManifest>(fs.readFileSync(path.join(staging, 'manifest.json')));
    if (!manifest) throw new HttpError(400, 'Snapshot is missing a valid manifest.json');
    const src: SnapshotManifest['project'] = manifest.project || {};
    if (manifest.madar !== MAGIC_MADAR) throw new HttpError(400, 'Unsupported snapshot format');

    const baseName = String(src.name ?? 'Restored project').trim() || 'Restored project';
    const slug = await uniqueProjectSlug(sanitizeSlug(src.slug, baseName));
    const used = await currentUsedPorts();
    const ports = resolvePorts(src.ports, used);

    const created = await createProject({
      name: baseName,
      slug,
      description: typeof src.description === 'string' ? src.description : undefined,
      image: typeof src.image === 'string' && src.image ? src.image : undefined,
      ports,
      env: src.env && typeof src.env === 'object' ? src.env : undefined,
    });

    // Copy verified workspace files (extraction already pruned traversal + exclusions).
    const srcWork = path.join(staging, 'workspace');
    if (fs.existsSync(srcWork)) {
      copyTreeInto(created.slug, srcWork);
    }

    // Restore developer notes (best-effort; malformed documents are dropped).
    const notesPath = path.join(staging, 'notes.json');
    if (fs.existsSync(notesPath)) {
      const parsed = tryJson<unknown>(readIfPresent(notesPath));
      if (parsed) {
        try {
          saveNotes(created.slug, parsed);
        } catch {
          /* invalid notes doc — keep fresh empty notes */
        }
      }
    }

    // Restore the visual planning canvas (best-effort; malformed docs dropped).
    const canvasPath = path.join(staging, 'canvas.json');
    if (fs.existsSync(canvasPath)) {
      const parsed = tryJson<unknown>(readIfPresent(canvasPath));
      if (parsed) {
        try {
          saveCanvas(created.slug, { ...parsed, updatedAt: null });
        } catch {
          /* invalid canvas doc — keep fresh empty board */
        }
      }
    }

    return created;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function readIfPresent(p: string): Buffer | undefined {
  try {
    return fs.readFileSync(p);
  } catch {
    return undefined;
  }
}

/** Copy the extracted workspace tree into the new project's working dir. */
function copyTreeInto(slug: string, srcDir: string): void {
  const dst = path.resolve(WORKSPACES_ROOT, String(slug ?? '').replace(/[^a-z0-9._-]+/gi, ''));
  fs.mkdirSync(dst, { recursive: true });
  const copy = (from: string, to: string): void => {
    for (const entry of fs.readdirSync(from)) {
      try {
        const s = path.join(from, entry);
        const d = path.join(to, entry);
        const st = fs.statSync(s);
        if (st.isDirectory()) {
          fs.mkdirSync(d, { recursive: true });
          copy(s, d);
        } else if (st.isFile()) {
          fs.copyFileSync(s, d);
        }
      } catch {
        /* skip unreadable/broken entries — never fail a restore over one file */
      }
    }
  };
  copy(srcDir, dst);
}