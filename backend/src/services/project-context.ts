/**
 * project-context.ts
 * Madar — Deep "project awareness" block injected into the chat system prompt.
 *
 *   - project === 'all'  → brief summary of every project (short-TTL cache).
 *   - project === slug   → full context: metadata + WSD_PROJECT.md goals +
 *                          key/entry files + small source files (fully) +
 *                          code signatures + recent logs + workspace tree.
 *
 * Sections are priority-ordered (goals → key files → source files → signatures
 * → logs → tree) so a budget cap always keeps the most useful information.
 * A cheap full-scan signature cache avoids rebuilding when nothing changed.
 *
 * Cache invalidation: `invalidateProjectContext(slug)` must be called after
 * any file write/delete/rename, notes save, or canvas save so the context
 * is rebuilt on the next prompt without waiting for TTL expiry.
 */
import fs from 'fs';
import path from 'path';
import { resolveWorkspaceBase, readContainedFile } from './workspace-paths-core';
import { HttpError } from './project-slug-core';
import type { ProjectInfo } from './docker-manager';
import { formatNotesForContext, noteCounts, notesSignature } from './project-notes';
import { formatCanvasForContext, canvasSignature as canvasSig, canvasNodeCount } from './project-canvas';
import {
  computeWorkspaceSignature,
  contextCacheKey,
  ProjectContextCache,
  BriefCache,
  buildContextBlock,
  isCanvasMirrorFile,
} from './project-context-core';

// Host path where project workspaces live (mirrors docker-manager's constant,
// read from env so this module stays importable offline without pulling the
// whole docker graph — see the lazy adapter below).
const WORKSPACES_ROOT = process.env.WSD_PROJECTS_DIR || '/workspaces';

/**
 * Docker-backed project source. This module statically imports ONLY leaf
 * services (notes/canvas). The Docker graph (docker-manager / projects-cache)
 * is REQUIRED LAZILY inside `currentDocker()` so that `node --test` can import
 * this module offline (Node's native TS loader can't resolve docker-manager's
 * extensionless transitive imports). Tests inject a stub via
 * `setContextDockerSource()`; production uses the real `getCachedProjects()`
 * (Phase B1 list cache) + `getProject` / `projectLogs`.
 */
export interface ProjectContextDockerSource {
  listProjects(): Promise<ProjectInfo[]>;
  getProject(slug: string): Promise<ProjectInfo | null>;
  projectLogs(slug: string, lines: number): Promise<string>;
}

let dockerSource: ProjectContextDockerSource | null = null;

function currentDocker(): ProjectContextDockerSource {
  if (dockerSource) return dockerSource;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dm = require('./docker-manager') as typeof import('./docker-manager');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pc = require('./projects-cache') as typeof import('./projects-cache');
  dockerSource = {
    listProjects: () => pc.getCachedProjects(),
    getProject: (slug) => dm.getProject(slug),
    projectLogs: (slug, lines) => dm.projectLogs(slug, lines),
  };
  return dockerSource;
}

/** Replace the docker-backed source (used by offline tests to stub projects).
 *  Pass `null` to restore the production lazy binding. */
export function setContextDockerSource(src: ProjectContextDockerSource | null): void {
  dockerSource = src;
}

export const DEFAULT_MAX_CHARS = 24000;
const BRIEF_MAX_CHARS = 4000;
const GOALS_MAX_CHARS = 4000;
const GOALS_READ_BYTES = 32 * 1024;
const KEY_FILE_READ_BYTES = 64 * 1024;
const SIG_MAX_BYTES = 256 * 1024;
const SIG_READ_BYTES = 256 * 1024;
const TREE_MAX_CHARS = 3000;
const SMALL_FILE_BYTES = 8 * 1024;
const KEY_FILE_MAX_BYTES = 64 * 1024;
const TREE_MAX_DEPTH = 6;
const TREE_MAX_ENTRIES = 400;
const MAX_SCAN_FILES = 2000;
const MAX_SCAN_DEPTH = 8;
const MAX_LOG_LINES = 60;

/**
 * Read one workspace text file through the link-free read primitive.
 *
 * Every file this module feeds into a chat prompt used to come from a bare
 * `readFileSync`, which FOLLOWS symlinks: a planted
 * `WSD_PROJECT.md -> /app/data/jwt.secret` needed no race at all and was
 * pasted into every prompt (this was a LIVE finding, not a hypothetical).
 * `reason: 'refused'` covers link / directory / non-regular entry / outside
 * the workspace / unreadable — the caller renders it as an explicit marker
 * rather than silently dropping the section, so planting a link cannot hide
 * content either. `'missing'` is the old "file simply is not there" case.
 */
type WorkspaceRead = { ok: true; text: string } | { ok: false; reason: 'missing' | 'refused' };

function readWorkspaceText(slug: string, rel: string, maxBytes: number): WorkspaceRead {
  try {
    const read = readContainedFile(WORKSPACES_ROOT, slug, rel, { maxBytes });
    return { ok: true, text: read.data.toString('utf8') };
  } catch (err) {
    if (err instanceof HttpError && err.statusCode === 404) return { ok: false, reason: 'missing' };
    return { ok: false, reason: 'refused' };
  }
}

export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  'coverage',
  '.idea',
  '.vscode',
]);

const TEXT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.json', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
  '.mts', '.cts', '.py', '.pyw', '.go', '.java', '.kt', '.kts', '.rs', '.c', '.h',
  '.cc', '.cpp', '.hpp', '.hh', '.cs', '.php', '.rb', '.html', '.htm', '.css',
  '.scss', '.less', '.xml', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf',
  '.sh', '.bash', '.zsh', '.fish', '.sql', '.csv', '.env', '.gitignore',
  '.dockerignore', '.editorconfig', '.log', '.vue', '.svelte', '.svg',
  '.tf', '.properties', '.plist', '.lock', 'dockerfile',
]);

const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.avif', '.bmp', '.pdf',
  '.zip', '.gz', '.tar', '.bz2', '.7z', '.rar', '.woff', '.woff2', '.ttf',
  '.otf', '.eot', '.mp3', '.mp4', '.webm', '.mov', '.avi', '.wav', '.ogg',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.pyc', '.class', '.jar', '.wasm',
  '.map', '.db', '.sqlite', '.sqlite3', '.deb', '.rpm',
]);

const KEY_FILE_NAMES = [
  'README.md',
  'readme.md',
  'package.json',
  'requirements.txt',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'composer.json',
  'Gemfile',
  'tsconfig.json',
  'vite.config.ts',
  'vite.config.js',
  '.env.example',
  'Makefile',
  'CMakeLists.txt',
  'Dockerfile',
  'docker-compose.yml',
  '.gitignore',
];

const ENTRY_PATTERNS = [
  /^src\/index\.(ts|tsx|js|jsx)$/,
  /^src\/main\.(ts|tsx|js|jsx|py|go)$/,
  /^src\/app\.(tsx|jsx|ts|js)$/,
  /^index\.(ts|tsx|js|jsx)$/,
  /^main\.(ts|tsx|js|jsx|py|go)$/,
  /^app\.(tsx|jsx|ts|js)$/,
  /^server\.(ts|js)$/,
  /^manage\.py$/,
];

const CODE_SIG_PATTERNS: { exts: string[]; re: RegExp }[] = [
  {
    exts: ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts'],
    re: /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function|class|interface|type|enum)\b[^;=]*$/gm,
  },
  { exts: ['py', 'pyw'], re: /^\s*(?:async\s+)?(?:def|class)\s+[\w_]+.*$/gm },
  { exts: ['go'], re: /^\s*(?:func|type)\s+[\w*(].*$/gm },
  {
    exts: ['java', 'kt', 'kts', 'scala'],
    re: /^\s*(?:(?:public|private|protected|internal)\s+)*(?:static\s+)?(?:final\s+)?(?:class|interface|enum)\s+\w+|^\s*(?:(?:public|private|protected)\s+)*(?:static\s+)?[\w<>,[\]\s]+\s+\w+\s*\([^)]*\)\s*(?:throws[\s\w]+)?\{?$/gm,
  },
  { exts: ['rs'], re: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+[\w_]+.*$/gm },
  { exts: ['rb'], re: /^\s*(?:def|class|module)\s+[\w:]+.*$/gm },
  { exts: ['php'], re: /^\s*(?:public|private|protected|final|static|abstract)?\s*(?:function|class)\s+\w+.*$/gm },
  { exts: ['sh', 'bash', 'zsh', 'fish'], re: /^\s*[a-zA-Z_]\w*\s*\(\)\s*\{?\s*$/gm },
];

export interface ProjectContextResult {
  /** 'all' or a project slug. */
  slug: string;
  text: string;
  truncated: boolean;
}

interface ScannedFile {
  rel: string;
  abs: string;
  size: number;
  mtimeMs: number;
  textLike: boolean;
  codeExt: string | null;
}

export function capText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max)}\n…(truncated, ${text.length} chars)`, truncated: true };
}

/**
 * Resolve a project workspace dir safely.
 *
 * Routed through the shared containment primitive. This used to fold the slug
 * and check the lexical prefix itself, which cannot tell a real project dir from
 * a symlink pointing at one: a linked project dir made the scanner below walk
 * the LINK'S TARGET and feed its files into the AI context block — and from
 * there into a chat transcript any member can read. The scanner already skips
 * link ENTRIES (a Dirent is neither file nor dir), but refusing a linked BASE is
 * the half that matters.
 *
 * `resolveWorkspaceBase` alone is NOT enough: it only proves the slug is a safe
 * single segment lexically inside the real root, so `workspaces/linked -> /app/data`
 * passes it. The base's realness is checked here with lstat, and a project whose
 * workspace does not exist yet still yields the path (the caller decides) — the
 * same contract this function always had, so a fresh project is not an error.
 */
export function safeWorkspaceDir(slug: string): string {
  const base = resolveWorkspaceBase(WORKSPACES_ROOT, slug);
  try {
    if (fs.lstatSync(base).isSymbolicLink()) {
      throw new HttpError(400, 'Project workspace is not a real directory');
    }
  } catch (err: any) {
    // A workspace that is not there yet is legitimate (create in flight); a
    // base we cannot inspect is an absence of proof, so refuse it loudly.
    if (err?.statusCode) throw err;
    if (err?.code !== 'ENOENT') {
      throw new HttpError(400, 'Project workspace is not readable');
    }
  }
  return base;
}

function textLike(ext: string, size: number): boolean {
  if (BINARY_EXTS.has(ext)) return false;
  if (TEXT_EXTS.has(ext)) return true;
  return size <= 64 * 1024;
}

function codeExtOf(ext: string): string | null {
  for (const p of CODE_SIG_PATTERNS) if (p.exts.includes(ext)) return ext;
  return null;
}

/** One full workspace scan (caps applied). Returns the text-like files. */
function scanWorkspace(dir: string): ScannedFile[] {
  const out: ScannedFile[] = [];
  const stack: { rel: string; depth: number }[] = [{ rel: '', depth: 0 }];
  while (stack.length > 0 && out.length < MAX_SCAN_FILES) {
    const { rel, depth } = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(rel ? path.join(dir, rel) : dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (out.length >= MAX_SCAN_FILES) break;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name)) continue;
        if (depth < MAX_SCAN_DEPTH) stack.push({ rel: child, depth: depth + 1 });
      } else if (e.isFile()) {
        // WSD_CANVAS.md is a derived mirror of canvas.json — it is already
        // rendered as the [Planning canvas] block, never scanned or signed.
        if (isCanvasMirrorFile(e.name)) continue;
        const abs = path.join(dir, child);
        let stat: fs.Stats;
        try {
          // lstat, never stat: statSync FOLLOWS a link, so a file swapped for a
          // symlink between readdir and here would contribute the TARGET's size
          // (and the read sites below used to follow it too). A link is not a
          // regular file, so it is never scanned.
          stat = fs.lstatSync(abs);
        } catch {
          continue;
        }
        if (!stat.isFile()) continue;
        const ext = path.extname(e.name).toLowerCase();
        if (!textLike(ext, stat.size)) continue;
        out.push({
          rel: child,
          abs,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          textLike: true,
          codeExt: codeExtOf(ext),
        });
      }
    }
  }
  out.sort((a, b) => {
    const da = a.rel.split('/').length;
    const db = b.rel.split('/').length;
    return da - db || a.size - b.size || a.rel.localeCompare(b.rel);
  });
  return out;
}

/** Indented tree of the workspace, depth/entry capped, ignoring heavy dirs. */
function buildTree(base: string, rel: string, depth: number, budget: { count: number }): string[] {
  if (depth > TREE_MAX_DEPTH || budget.count <= 0) return [];
  const dir = rel ? path.join(base, rel) : base;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  entries.sort(
    (a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)
  );
  const lines: string[] = [];
  for (const e of entries) {
    if (budget.count <= 0) return lines;
    if (e.isDirectory()) {
      if (IGNORED_DIRS.has(e.name)) continue;
      const child = rel ? path.join(rel, e.name).split(path.sep).join('/') : e.name;
      lines.push(`${'  '.repeat(depth)}${e.name}/`);
      budget.count -= 1;
      lines.push(...buildTree(base, child, depth + 1, budget));
    } else {
      lines.push(`${'  '.repeat(depth)}${e.name}`);
      budget.count -= 1;
    }
  }
  return lines;
}

/** Extract declaration signatures from a code file (with line numbers).
 *  The caller reads the content through `readWorkspaceText` — this function
 *  never opens a path itself. */
function extractSignatures(file: ScannedFile, content: string, maxLines: number): string[] {
  const codeExt = file.codeExt;
  if (!codeExt) return [];
  const pattern = CODE_SIG_PATTERNS.find((p) => p.exts.includes(codeExt))!;
  const lines: string[] = [];
  const seen = new Set<string>();
  pattern.re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.re.exec(content)) !== null && lines.length < maxLines) {
    const text = m[0].trim().slice(0, 140);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    const lineNo = content.slice(0, m.index).split('\n').length;
    lines.push(`L${lineNo}: ${text}`);
    if (m[0].length === 0) pattern.re.lastIndex += 1;
  }
  return lines;
}

/** Build the brief block text from a project list (pure — shared with cache). */
function buildBriefText(projects: ProjectInfo[]): string {
  const lines = projects.map((p) => {
    const ports =
      p.hostPorts && Object.keys(p.hostPorts).length
        ? ` — preview ${Object.values(p.hostPorts).join(', ')}`
        : '';
    const desc = p.description ? ` — ${p.description}` : '';
    const counts = noteCounts(p.slug);
    const notes =
      counts && (counts.bugs > 0 || counts.goals > 0)
        ? ` — notes: ${counts.bugs} open bug(s), ${counts.goals} active goal(s)`
        : '';
    const boardNodes = canvasNodeCount(p.slug);
    const board =
      boardNodes > 0 ? ` — board: ${boardNodes} node${boardNodes === 1 ? '' : 's'}` : '';
    return `- ${p.name} [${p.slug}] — ${p.status}${desc}${ports}${notes}${board}`;
  });
  return lines.length
    ? `[Project context — all projects]\n${lines.join('\n')}`
    : '[Project context — all projects]\n(no projects found yet)';
}

/**
 * Brief summary of every project (for the 'all' scope).
 *
 * Cached for `WSD_BRIEF_TTL_MS` (default 15s, min 1s) so repeated 'all'-scope
 * prompts don't fan out to `docker listContainers` on every call. When the
 * projects-cache module is available (Phase B1) we reuse its snapshot instead
 * of hitting Docker directly — it refreshes on a far shorter TTL and is
 * invalidated at lifecycle points, so brief data is rarely stale.
 */
export async function listProjectsBrief(maxChars: number = BRIEF_MAX_CHARS): Promise<ProjectContextResult> {
  const raw = await briefCache.get(async () => {
    let projects: ProjectInfo[];
    try {
      projects = await currentDocker().listProjects();
    } catch {
      projects = [];
    }
    return buildBriefText(projects);
  });
  const { text, truncated } = capText(raw, maxChars);
  return { slug: 'all', text, truncated };
}

export const CTX_CACHE_MAX = 40;
const CTX_CACHE_TTL_MS = Math.max(1000, Number(process.env.WSD_CTX_CACHE_TTL_MS) || 5 * 60_000);

const ctxCache: ProjectContextCache = new ProjectContextCache(CTX_CACHE_MAX, CTX_CACHE_TTL_MS);

/** Short-TTL cache for the 'all'-scope brief so repeated prompts don't re-query
 *  Docker. A single slot is enough (only one 'all' scope exists). */
const BRIEF_CACHE_TTL_MS = Math.max(1000, Number(process.env.WSD_BRIEF_TTL_MS) || 15_000);
const briefCache: BriefCache = new BriefCache(BRIEF_CACHE_TTL_MS);

/** Cache key = workspace signature + notes signature + canvas signature, so
 *  note/canvas edits (which bump their own signatures) invalidate the cached
 *  context without explicit bookkeeping. */
function cacheKey(slug: string, sig: string): string {
  return contextCacheKey(slug, sig, notesSignature(slug), canvasSig(slug));
}

/** Drop a project's cached context so the next prompt rebuilds it. Called by
 *  file-write / notes-save / canvas-save paths so edits invalidate instantly
 *  while idle workspaces stay warm on their 5min TTL. The 'all'-scope brief
 *  aggregates per-project notes/canvas counts, so ANY project edit must also
 *  drop the stale brief slot — it rebuilds on the next 'all' prompt (cheap:
 *  the Phase B1 projects-cache snapshot, not a fresh Docker list). */
export function invalidateProjectContext(slug: string): void {
  const clean = String(slug ?? '').trim();
  if (!clean) return;
  ctxCache.invalidateProject(clean);
  briefCache.invalidate();
}

/** Full context block for one project. */
export async function getProjectContext(
  slug: string,
  maxChars: number = DEFAULT_MAX_CHARS
): Promise<ProjectContextResult> {
  const clean = String(slug).trim();
  const dir = safeWorkspaceDir(clean);
  const exists = fs.existsSync(dir);

  if (exists) {
    const files = scanWorkspace(dir);
    const sig = computeWorkspaceSignature(files);
    const key = cacheKey(clean, sig);
    const now = Date.now();
    const cached = ctxCache.get(key, now);
    if (cached) {
      // Cache hit — notes/canvas are folded into the sig-keyed text, so we
      // return without re-formatting either (they were computed at build).
      return { slug: clean, text: cached.text, truncated: cached.truncated };
    }

    const info = await currentDocker().getProject(clean).catch(() => null);
    const built = await buildFullContext(clean, dir, files, info, maxChars);
    ctxCache.set(key, { sig, text: built.text, truncated: built.truncated }, now);
    return { slug: clean, text: built.text, truncated: built.truncated };
  }

  // Workspace gone — developer notes survive workspace loss. Canvas too.
  const notesText = formatNotesForContext(clean);
  const canvasText = formatCanvasForContext(clean);
  return {
    slug: clean,
    text:
      `[Project context — ${clean}]\n(workspace not found on disk)` +
      (notesText ? `\n\n## Developer notes (from Madar Notes)\n${notesText}` : '') +
      (canvasText ? `\n\n${canvasText}` : ''),
    truncated: false,
  };
}

async function buildFullContext(
  clean: string,
  dir: string,
  files: ScannedFile[],
  info: ProjectInfo | null,
  maxChars: number
): Promise<{ text: string; truncated: boolean }> {
  const parts: string[] = [`[Project context — ${clean}]`];
  if (info) {
    parts.push(`Name: ${info.name}`);
    parts.push(`Status: ${info.status}`);
    if (info.description) parts.push(`Description: ${info.description}`);
    if (info.hostPorts && Object.keys(info.hostPorts).length) {
      parts.push(
        `Preview ports: ${Object.entries(info.hostPorts)
          .map(([priv, pub]) => `${pub} → container ${priv}`)
          .join(', ')}`
      );
    }
    // Live runtime state so agents know the machine's constraints/hazards.
    const liveLimits = info.liveLimits ?? info.limits;
    if (liveLimits && (liveLimits.cpu || liveLimits.memory)) {
      const bits: string[] = [];
      if (liveLimits.cpu) bits.push(`CPU ${liveLimits.cpu}`);
      if (liveLimits.memory) bits.push(`RAM ${liveLimits.memory}`);
      parts.push(`Resource limits: ${bits.join(' / ')} (OOM-capped at the RAM cap)`);
    }
    if (info.crash) {
      const why =
        info.crash.reason === 'oom'
          ? 'out-of-memory kill'
          : info.crash.reason === 'restart'
            ? `silent auto-restart (restarts=${info.crash.restarted ?? '?'})`
            : `non-zero exit (exit=${info.crash.exitCode ?? '?'})`;
      parts.push(`Crashed: ${why} at ${info.crash.at}`);
    }
    if (info.serve?.enabled) {
      const serveUrl = info.serve.url || (info.serve.hostPort ? `http://<host>:${info.serve.hostPort}` : '');
      parts.push(`Serving static site: ${info.serve.active ? (serveUrl || 'active') : `configured:${info.serve.port} (${info.serve.error ?? 'not answering'})`}`);
    }
  } else {
    parts.push('(container metadata unavailable — workspace present on disk)');
  }

  // 1) Goals — read link-free. A planted WSD_PROJECT.md symlink used to be
  // read with existsSync+readFileSync (both FOLLOW the link), so the target's
  // bytes went straight into the system prompt.
  const goals = readWorkspaceText(clean, 'WSD_PROJECT.md', GOALS_READ_BYTES);
  if (goals.ok) {
    parts.push(`\n## Project goals (WSD_PROJECT.md)\n${goals.text.slice(0, GOALS_MAX_CHARS) || '(empty)'}`);
  } else if (goals.reason === 'refused') {
    parts.push(`\n## Project goals (WSD_PROJECT.md)\n(refused — not a regular file)`);
  }

  // 1.5) Developer notes from the Madar Notes tab (open bugs → goals → ideas).
  const notesText = formatNotesForContext(clean);
  if (notesText) parts.push(`\n## Developer notes (from Madar Notes)\n${notesText}`);

  // 1.6) Visual planning canvas (sticky notes + task cards) — compact flat text.
  const canvasText = formatCanvasForContext(clean);
  if (canvasText) parts.push(`\n${canvasText}`);

  const byRel = new Map(files.map((f) => [f.rel, f]));

  // 2) Key + entry files (fully when small, otherwise head).
  const keySet = new Set<string>();
  const keyParts: string[] = [];
  const keyList: string[] = [];
  for (const name of KEY_FILE_NAMES) {
    if (byRel.has(name) || byRel.has(name.toLowerCase())) keyList.push(name);
  }
  for (const p of ENTRY_PATTERNS) {
    const found = files.find((f) => p.test(f.rel));
    if (found) keyList.push(found.rel);
  }
  for (const rel of [...new Set(keyList)]) {
    const f = byRel.get(rel) || byRel.get(rel.toLowerCase());
    if (!f || keySet.has(f.rel)) continue;
    keySet.add(f.rel);
    if (f.size > KEY_FILE_MAX_BYTES) continue;
    const read = readWorkspaceText(clean, f.rel, KEY_FILE_READ_BYTES);
    if (!read.ok) continue; // missing or refused — a link contributes nothing
    const content = read.text;
    const body = f.size <= SMALL_FILE_BYTES ? content : `${content.slice(0, 800)}\n…(file too large, showing head)`;
    keyParts.push(`\n## ${f.rel}\n${body.slice(0, 4000)}`);
  }
  if (keyParts.length) parts.push(`\n## Key files\n${keyParts.join('\n')}`);

  // 3) Small source files (fully), excluding key/goals already shown.
  const smallParts: string[] = [];
  for (const f of files) {
    if (keySet.has(f.rel) || f.rel === 'WSD_PROJECT.md' || f.rel === 'WSD_CANVAS.md') continue;
    if (f.size > SMALL_FILE_BYTES) continue;
    const read = readWorkspaceText(clean, f.rel, SMALL_FILE_BYTES);
    if (!read.ok) continue;
    smallParts.push(`\n### ${f.rel}\n${read.text}`);
  }
  if (smallParts.length) parts.push(`\n## Source files (small)\n${smallParts.join('\n')}`);

  // 4) Code signatures of larger files.
  const sigParts: string[] = [];
  for (const f of files) {
    if (f.size <= SMALL_FILE_BYTES || !f.codeExt || f.size > SIG_MAX_BYTES) continue;
    const read = readWorkspaceText(clean, f.rel, SIG_READ_BYTES);
    if (!read.ok) continue;
    const sigs = extractSignatures(f, read.text, 40);
    if (sigs.length) sigParts.push(`\n### ${f.rel}\n${sigs.join('\n')}`);
  }
  if (sigParts.length) parts.push(`\n## Code signatures\n${sigParts.join('\n')}`);

  // 5) Recent container logs when running.
  if (info?.status === 'running') {
    try {
      const logs = (await currentDocker().projectLogs(clean, MAX_LOG_LINES))
        .split('\n')
        .filter((l) => l.trim())
        .slice(-MAX_LOG_LINES)
        .join('\n');
      if (logs) parts.push(`\n## Recent logs\n${logs}`);
    } catch {
      /* logs unavailable */
    }
  }

  // 6) Workspace tree (capped).
  const budget = { count: TREE_MAX_ENTRIES };
  const tree = buildTree(dir, '', 0, budget);
  if (tree.length) {
    const treeText = capText(tree.join('\n'), TREE_MAX_CHARS).text;
    parts.push(`\n## Workspace layout\n${treeText}`);
  }

  const { text, truncated } = buildContextBlock(parts, maxChars);
  return { text, truncated };
}
