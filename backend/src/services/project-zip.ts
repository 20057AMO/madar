/**
 * project-zip.ts
 * Madar — Download a project's workspace as a .zip archive.
 *
 * Hand-rolled ZIP writer (no third-party packaging dep, mirroring the
 * project-snapshots tar writer): a streaming producer yields local file
 * headers + deflated payloads, then the central directory + EOCD once every
 * entry has been walked. Heavy regenerable dirs use the SAME exclusion set as
 * snapshots (`EXCLUDE_DIRS`), and symlinks are skipped outright — a link
 * pointing outside the workspace is never followed or deep-copied.
 *
 * Files are stored with method 8 (deflate) when it shrinks them, otherwise
 * stored raw (method 0), so incompressible binaries don't balloon the file.
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { Readable } from 'stream';
import { HttpError, WORKSPACES_ROOT } from './docker-manager';
import { loadMeta } from './projects-meta';
import { EXCLUDE_DIRS } from './project-snapshots';

const MAX_ENTRIES = 200_000;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB uncompressed ceiling

interface ZipWalkEntry {
  name: string; // forward-slash path inside the archive
  abs: string;
  type: 'file' | 'dir';
  mtime: number; // unix seconds
}

// ── CRC-32 (IEEE) — table-driven, used by every zip local/central header ──

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** ZIP DOS date/time packing (local MTIME granularity is 2s — fine for ZIP). */
function dosDateTime(mtime: number): { time: number; date: number } {
  const d = new Date(mtime * 1000);
  const time =
    ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() >> 1) & 0x1f);
  const date =
    ((d.getFullYear() - 1980) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

// ── Recursive workspace walk (symlink-safe, exclusions pruned) ────────────

async function* walkWorkspace(
  absRoot: string,
  relRoot = ''
): AsyncGenerator<ZipWalkEntry> {
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
    // Never follow symlinks: a dangling/pointing link inside the workspace
    // must not smuggle data from elsewhere into the download.
    if (e.isSymbolicLink()) continue;
    let mtime = 0;
    try {
      const st = await fs.promises.stat(abs);
      mtime = Math.floor(st.mtimeMs / 1000);
    } catch {
      continue; // unreadable/broken entry — never fail the download over one file
    }
    if (e.isDirectory()) {
      yield { name: rel, abs, type: 'dir', mtime };
      yield* walkWorkspace(abs, rel);
    } else if (e.isFile()) {
      yield { name: rel, abs, type: 'file', mtime };
    }
  }
}

// ── ZIP binary builders ───────────────────────────────────────────────────

const LSIG = 0x04034b50;
const CSIG = 0x02014b50;
const ESIG = 0x06054b50;

function localHeader(name: string, crc: number, csize: number, usize: number, method: number, mtime: number): Buffer {
  const nameBuf = Buffer.from(name, 'utf8');
  const h = Buffer.alloc(30);
  h.writeUInt32LE(LSIG, 0);
  h.writeUInt16LE(20, 4); // version needed
  h.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
  h.writeUInt16LE(method, 8); // 8 = deflate, 0 = stored
  const dt = dosDateTime(mtime);
  h.writeUInt16LE(dt.time, 10);
  h.writeUInt16LE(dt.date, 12);
  h.writeUInt32LE(crc, 14);
  h.writeUInt32LE(csize, 18);
  h.writeUInt32LE(usize, 22);
  h.writeUInt16LE(nameBuf.length, 26);
  h.writeUInt16LE(0, 28); // extra length
  return Buffer.concat([h, nameBuf]);
}

function centralEntry(name: string, crc: number, csize: number, usize: number, method: number, mtime: number, offset: number): Buffer {
  const nameBuf = Buffer.from(name, 'utf8');
  const h = Buffer.alloc(46);
  h.writeUInt32LE(CSIG, 0);
  h.writeUInt16LE(0x031e, 4); // version made by
  h.writeUInt16LE(20, 6); // version needed
  h.writeUInt16LE(0x0800, 8); // UTF-8 filename flag
  h.writeUInt16LE(method, 10);
  const dt = dosDateTime(mtime);
  h.writeUInt16LE(dt.time, 12);
  h.writeUInt16LE(dt.date, 14);
  h.writeUInt32LE(crc, 16);
  h.writeUInt32LE(csize, 20);
  h.writeUInt32LE(usize, 24);
  h.writeUInt16LE(nameBuf.length, 28);
  h.writeUInt16LE(0, 30); // extra
  h.writeUInt16LE(0, 32); // comment
  h.writeUInt16LE(0, 34); // disk
  h.writeUInt16LE(0, 36); // internal attrs
  h.writeUInt32LE(0o644 << 16, 38); // external attrs (unix perm)
  h.writeUInt32LE(offset, 42);
  return Buffer.concat([h, nameBuf]);
}

function endOfCentral(count: number, cdirSize: number, cdirOffset: number): Buffer {
  const h = Buffer.alloc(22);
  h.writeUInt32LE(ESIG, 0);
  h.writeUInt16LE(0, 4);
  h.writeUInt16LE(0, 6);
  h.writeUInt16LE(count, 8);
  h.writeUInt16LE(count, 10);
  h.writeUInt32LE(cdirSize, 12);
  h.writeUInt32LE(cdirOffset, 16);
  h.writeUInt16LE(0, 20); // comment length
  return h;
}

// ── Streaming producer ────────────────────────────────────────────────────

export interface ProjectZip {
  stream: Readable;
  filename: string;
}

export function exportProjectZip(slug: string): ProjectZip {
  const meta = loadMeta(slug);
  if (!meta) throw new HttpError(404, `Project '${slug}' not found`);
  const workspaceDir = path.resolve(WORKSPACES_ROOT, String(slug ?? '').replace(/[^a-z0-9._-]+/gi, ''));
  if (!fs.existsSync(workspaceDir)) throw new HttpError(404, `Project workspace '${slug}' not found`);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `${slug}-${stamp}.zip`;

  /** Buffer the whole archive. Files are deflated per-entry and yielded one
   *  at a time, so peak memory ≈ largest single stored/compressed file
   *  rather than the full tree. The central directory is emitted last. */
  async function* produce(): AsyncGenerator<Buffer> {
    let count = 0;
    let totalBytes = 0;
    let offset = 0;
    const central: { name: string; crc: number; csize: number; usize: number; method: number; mtime: number; offset: number }[] = [];

    for await (const entry of walkWorkspace(workspaceDir)) {
      if (count >= MAX_ENTRIES) break;

      if (entry.type === 'dir') {
        // Empty dirs are kept via a trailing-slash entry.
        const name = `${entry.name.replace(/\/+$/, '')}/`;
        const h = localHeader(name, 0, 0, 0, 0, entry.mtime);
        yield h;
        central.push({ name, crc: 0, csize: 0, usize: 0, method: 0, mtime: entry.mtime, offset });
        offset += h.length;
        count += 1;
        continue;
      }

      let data: Buffer;
      try {
        data = await fs.promises.readFile(entry.abs);
      } catch {
        continue; // unreadable file — skip, keep the archive valid
      }
      if (totalBytes + data.length > MAX_TOTAL_BYTES) break;

      const crc = crc32(data);
      let payload: Buffer;
      let usize = data.length;
      let csize: number;
      let method: number;
      // Deflate when it actually shrinks; otherwise store raw so images/zip
      // binaries aren't bloated by recompression.
      const deflated = zlib.deflateRawSync(data, { level: 6 });
      if (deflated.length < data.length) {
        payload = deflated;
        csize = deflated.length;
        method = 8;
      } else {
        payload = data;
        csize = data.length;
        method = 0;
      }

      const h = localHeader(entry.name, crc, csize, usize, method, entry.mtime);
      const entryBytes = h.length + csize;
      yield h;
      yield payload;
      central.push({ name: entry.name, crc, csize, usize, method, mtime: entry.mtime, offset });
      offset += entryBytes;
      totalBytes += usize;
      count += 1;
    }

    // Central directory + end-of-central-directory record.
    const cdirStart = offset;
    const cdirParts: Buffer[] = [];
    for (const c of central) {
      cdirParts.push(centralEntry(c.name, c.crc, c.csize, c.usize, c.method, c.mtime, c.offset));
    }
    const cdir = Buffer.concat(cdirParts);
    yield cdir;
    yield endOfCentral(central.length, cdir.length, cdirStart);
  }

  return { stream: Readable.from(produce()), filename };
}