/**
 * project-index.ts
 * Madar — Lazy per-project text index + BM25 retrieval.
 * Chunks every text file in a project workspace and persists the index to
 * WSD_DATA_DIR/projects/<slug>/index.json so only changed files are re-chunked.
 * `retrieveProject` ranks chunks by BM25 against the user's message and returns
 * the top matches, which are injected into the chat system prompt so the model
 * can ground its answers in the actual project code.
 */
import fs from 'fs';
import path from 'path';
import { safeWorkspaceDir, IGNORED_DIRS } from './project-context';
import { readContainedFile } from './workspace-paths-core';

/** Same convention as project-context/agent-tools: resolve locally. */
const WORKSPACES_ROOT = process.env.WSD_PROJECTS_DIR || '/workspaces';

const DATA_DIR = process.env.WSD_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const PROJECTS_DIR = path.join(DATA_DIR, 'projects');

const CHUNK_CHARS = 800;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_SCAN_FILES = 1500;
const MAX_SCAN_DEPTH = 8;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
const BM25_K1 = 1.2;
const BM25_B = 0.75;

const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.avif', '.bmp', '.pdf',
  '.zip', '.gz', '.tar', '.bz2', '.7z', '.rar', '.woff', '.woff2', '.ttf',
  '.otf', '.eot', '.mp3', '.mp4', '.webm', '.mov', '.avi', '.wav', '.ogg',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.pyc', '.class', '.jar', '.wasm',
  '.map', '.db', '.sqlite', '.sqlite3', '.deb', '.rpm',
]);

interface IndexChunk {
  text: string;
  startLine: number;
  endLine: number;
}

interface IndexFile {
  file: string;
  mtimeMs: number;
  size: number;
  chunks: IndexChunk[];
}

interface IndexData {
  slug: string;
  builtAt: string;
  files: IndexFile[];
}

interface Bm25Stats {
  df: Map<string, number>;
  avgdl: number;
  totalChunks: number;
}

interface StatsCache {
  data: IndexData;
  stats: Bm25Stats;
  rebuilt: boolean;
}

const mem = new Map<string, StatsCache>();
const INDEX_CACHE_MAX = 15;

export interface RetrievedChunk {
  file: string;
  startLine: number;
  endLine: number;
  text: string;
  score: number;
}

export interface RetrievalResult {
  chunks: RetrievedChunk[];
  files: number;
  totalChunks: number;
  rebuilt: boolean;
}

export interface IndexStats {
  files: number;
  chunks: number;
  rebuilt: boolean;
  builtAt: string | null;
}

function indexFile(slug: string): string {
  return path.join(PROJECTS_DIR, slug, 'index.json');
}

function tokenize(s: string): string[] {
  return s.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
}

function loadIndex(slug: string): IndexData | null {
  const f = indexFile(slug);
  if (!fs.existsSync(f)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(f, 'utf8')) as IndexData;
    if (raw.slug === slug && Array.isArray(raw.files)) return raw;
  } catch {
    /* corrupt index — rebuild */
  }
  return null;
}

function walkTextFiles(dir: string): { file: string; size: number; mtimeMs: number }[] {
  const out: { file: string; size: number; mtimeMs: number }[] = [];
  const stack: { rel: string; depth: number }[] = [{ rel: '', depth: 0 }];
  let totalBytes = 0;
  while (stack.length > 0 && out.length < MAX_SCAN_FILES && totalBytes < MAX_TOTAL_BYTES) {
    const { rel, depth } = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(rel ? path.join(dir, rel) : dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (out.length >= MAX_SCAN_FILES || totalBytes >= MAX_TOTAL_BYTES) break;
      const child = rel ? `${rel}/${e.name}` : e.name;
      // lstat, never `stat` and never the dirent type alone: the walk must not
      // DESCEND through a link (a link to a directory would otherwise be walked
      // and its target's files indexed) and must not measure the target's size.
      // A link is skipped outright: never descended, never indexed.
      const abs = path.join(dir, child);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (IGNORED_DIRS.has(e.name)) continue;
        if (depth < MAX_SCAN_DEPTH) stack.push({ rel: child, depth: depth + 1 });
      } else if (st.isFile()) {
        if (st.size > MAX_FILE_BYTES) continue;
        const ext = path.extname(e.name).toLowerCase();
        if (BINARY_EXTS.has(ext)) continue;
        out.push({ file: child, size: st.size, mtimeMs: st.mtimeMs });
        totalBytes += st.size;
      }
    }
  }
  return out;
}

function chunkText(text: string): IndexChunk[] {
  const lines = text.split('\n');
  const chunks: IndexChunk[] = [];
  let buf = '';
  let startLine = 1;
  let line = 1;
  for (const raw of lines) {
    if (buf && (buf.length + raw.length + 1 > CHUNK_CHARS)) {
      chunks.push({ text: buf, startLine, endLine: line - 1 });
      buf = '';
      startLine = line;
    }
    buf += (buf ? '\n' : '') + raw;
    line += 1;
  }
  if (buf.trim()) chunks.push({ text: buf, startLine, endLine: line - 1 });
  return chunks;
}

function chunkFile(slug: string, rel: string): IndexChunk[] {
  // The INDEXED bytes must come from the same containment primitive as every
  // other workspace read: `fs.readFileSync(abs)` opens by NAME, so a file
  // swapped for a link between the walk above and this read was chunked and
  // persisted into index.json, where verbatim workspace text becomes
  // retrievable into chat prompts. Refusals (link / directory / missing /
  // traversal) simply produce no chunks, exactly like the old empty catch.
  try {
    const read = readContainedFile(WORKSPACES_ROOT, slug, rel, {
      maxBytes: MAX_FILE_BYTES,
      invalidMessage: 'Invalid path',
      missingMessage: 'Path not found',
    });
    return chunkText(read.data.toString('utf8'));
  } catch {
    return [];
  }
}

function computeStats(data: IndexData): Bm25Stats {
  const df = new Map<string, number>();
  let totalLen = 0;
  let totalChunks = 0;
  for (const f of data.files) {
    for (const c of f.chunks) {
      const toks = tokenize(c.text);
      totalLen += toks.length;
      totalChunks += 1;
      for (const t of new Set(toks)) df.set(t, (df.get(t) || 0) + 1);
    }
  }
  const avgdl = totalChunks > 0 ? totalLen / totalChunks : 0;
  return { df, avgdl, totalChunks };
}

/** Ensure the index for a project is built and up to date (lazy, persisted). */
function ensureIndex(slug: string): StatsCache | null {
  const dir = safeWorkspaceDir(slug);
  if (!fs.existsSync(dir)) return null;

  const cached = mem.get(slug);
  if (cached) return { ...cached, rebuilt: false };

  const files = walkTextFiles(dir);
  const byPath = new Map(files.map((f) => [f.file, f]));

  const persisted = loadIndex(slug);
  let rebuilt = !persisted;
  const keep = new Map<string, IndexFile>();

  if (persisted) {
    for (const pf of persisted.files) {
      const cur = byPath.get(pf.file);
      if (cur && cur.size === pf.size && cur.mtimeMs === pf.mtimeMs) {
        keep.set(pf.file, pf);
      } else if (cur) {
        rebuilt = true;
      }
    }
  }

  for (const f of files) {
    if (keep.has(f.file)) continue;
    const chunks = chunkFile(slug, f.file);
    if (chunks.length === 0) continue;
    keep.set(f.file, { file: f.file, mtimeMs: f.mtimeMs, size: f.size, chunks });
    rebuilt = true;
  }

  const data: IndexData = {
    slug,
    builtAt: new Date().toISOString(),
    files: [...keep.values()].sort((a, b) => a.file.localeCompare(b.file)),
  };

  fs.mkdirSync(path.dirname(indexFile(slug)), { recursive: true });
  try {
    // 0600, like every other file in the data dir: index.json holds verbatim
    // chunks of workspace files and sits beside the signing secret, so it must
    // not be the one world-readable object in there. The mode only applies to a
    // fresh create, so an already-written index is re-stamped explicitly.
    const f = indexFile(slug);
    fs.writeFileSync(f, JSON.stringify(data), { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(f, 0o600);
    } catch {
      /* best-effort: a chmod failure must not drop the index */
    }
  } catch {
    /* persist is best-effort */
  }

  const entry: StatsCache = { data, stats: computeStats(data), rebuilt };
  if (mem.size >= INDEX_CACHE_MAX && !mem.has(slug)) {
    const oldest = mem.keys().next().value;
    if (oldest !== undefined) mem.delete(oldest);
  }
  mem.set(slug, entry);
  return entry;
}

/**
 * Rank index chunks by BM25 against a query and return the top matches.
 * A small bonus is given to chunks whose file path matches query tokens.
 */
export async function retrieveProject(slug: string, query: string, k = 6): Promise<RetrievalResult> {
  const clean = String(slug).trim();
  const cache = ensureIndex(clean);
  if (!cache) return { chunks: [], files: 0, totalChunks: 0, rebuilt: false };

  const { data, stats, rebuilt } = cache;
  if (stats.totalChunks === 0) return { chunks: [], files: 0, totalChunks: 0, rebuilt };

  const qTokens = tokenize(query);
  if (qTokens.length === 0) return { chunks: [], files: 0, totalChunks: data.files.length, rebuilt };

  const { df, avgdl, totalChunks: N } = stats;
  const qSet = new Set(qTokens);
  const fileNameHits = new Set<string>();
  for (const f of data.files) {
    const pathToks = new Set(tokenize(f.file));
    for (const t of qTokens) {
      if (pathToks.has(t)) fileNameHits.add(f.file);
    }
  }

  const scored: { file: string; chunk: IndexChunk; score: number }[] = [];
  for (const f of data.files) {
    const boost = fileNameHits.has(f.file) ? 0.6 : 0;
    for (const c of f.chunks) {
      const toks = tokenize(c.text);
      const tfMap = new Map<string, number>();
      for (const t of toks) tfMap.set(t, (tfMap.get(t) || 0) + 1);
      const dl = toks.length;
      let score = 0;
      for (const t of qSet) {
        const tf = tfMap.get(t) || 0;
        if (tf === 0) continue;
        const n = df.get(t) || 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * (dl / (avgdl || 1)));
        score += idf * ((tf * (BM25_K1 + 1)) / denom);
      }
      if (score > 0) scored.push({ file: f.file, chunk: c, score: score + boost });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, k);
  return {
    chunks: top.map((s) => ({
      file: s.file,
      startLine: s.chunk.startLine,
      endLine: s.chunk.endLine,
      text: s.chunk.text,
      score: Math.round(s.score * 1000) / 1000,
    })),
    files: data.files.length,
    totalChunks: stats.totalChunks,
    rebuilt,
  };
}

/** Human-readable block of retrieved chunks for the system prompt. */
export function formatRetrievedChunks(ret: RetrievalResult): string {
  if (ret.chunks.length === 0) return '';
  const parts: string[] = ['## Retrieved from project files (relevant to your question)'];
  for (const c of ret.chunks) {
    parts.push(`\n### ${c.file} (lines ${c.startLine}–${c.endLine})\n${c.text}`);
  }
  return parts.join('\n');
}

/** Quick stats for the UI (triggers a lazy build when missing). */
export function getIndexStats(slug: string): IndexStats {
  const clean = String(slug).trim();
  const cache = ensureIndex(clean);
  if (!cache) return { files: 0, chunks: 0, rebuilt: false, builtAt: null };
  return {
    files: cache.data.files.length,
    chunks: cache.stats.totalChunks,
    rebuilt: cache.rebuilt,
    builtAt: cache.data.builtAt,
  };
}

/** Drop cached indexes (tests). */
export function resetIndexCache(): void {
  mem.clear();
}
