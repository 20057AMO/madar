/**
 * archive-manager.ts
 * Madar — Trash Bin orchestration over the workspace janitor's .archive dir.
 *
 * The workspace janitor moves orphaned (deleted-project) workspace directories
 * into <WORKSPACES_ROOT>/.archive/<base36-ts>-<slug>/ and auto-purges them
 * after WSD_ARCHIVE_DAYS. This module gives that directory a first-class,
 * authenticated, audit-trailed management surface:
 *   1. listArchives()   — list entries with derived slug/date + size (cached)
 *   2. deleteArchive()  — permanently remove a single entry
 *   3. emptyTrash()     — purge every entry now
 *   4. restoreArchive() — create a NEW live project from an entry's files
 *
 * Restore ordering is deliberately NO-move-then-create: the source is kept
 * inside `.archive` (invisible to code-server/opencode and never a janitor
 * sweep target) for the whole operation (createProject first, then copy), and
 * is removed ONLY after `createProject` has persisted a fresh meta store. This
 * eliminates the orphan race where a moved-but-not-yet-live /workspaces/<slug>
 * gets re-archived by a concurrent sweep. On any mid-restore failure the source
 * is left intact (the created project, having meta, remains recoverable).
 */
import fs from 'fs';
import path from 'path';

import {
  listArchiveEntries,
  parseArchiveName,
  archiveEntryPath,
  copyTree,
  safeName,
} from './archive-core';
import { dirSize } from './storage-core';
import {
  WORKSPACES_ROOT,
  createProject,
  getProject,
  currentUsedPorts,
  validatePortSet,
  HttpError,
  type ProjectInfo,
} from './docker-manager';
import { loadMeta, saveMeta, touchActivity } from './projects-meta';
import { invalidateProjectsCache } from './projects-cache';
import { invalidateStorageCache } from './storage-metrics';

export interface ArchivedEntry {
  entry: string;
  slug: string;
  name: string;
  date: string | null;
  sizeBytes: number;
  truncated?: boolean;
}

const LIST_DEFAULT_BUDGET_MS = 8_000;

// Short-TTL + singleflight list cache so opening Trash doesn't rescan every
// large archived dir on each mount. Invalidated on delete/empty/restore.
let cache: { at: number; value: ArchivedEntry[] } | null = null;
const CACHE_TTL_MS = 15_000;
let inflight: Promise<ArchivedEntry[]> | null = null;

export function invalidateArchiveCache(): void {
  cache = null;
}

function archiveRoot(): string {
  return WORKSPACES_ROOT;
}

function computeList(): ArchivedEntry[] {
  return listArchiveEntries(archiveRoot()).map((entry) => {
    const { slug, date } = parseArchiveName(entry);
    const full = archiveEntryPath(archiveRoot(), entry);
    let sizeBytes = 0;
    let truncated = false;
    if (full && fs.existsSync(full)) {
      const r = dirSize(full, { budgetMs: LIST_DEFAULT_BUDGET_MS });
      sizeBytes = r.size;
      truncated = r.truncated;
    }
    return { entry, slug, name: slug || entry, date, sizeBytes, truncated };
  });
}

/** List archived projects (cached with a short TTL + singleflight). */
export async function listArchives(fresh = false): Promise<ArchivedEntry[]> {
  if (fresh) {
    // A fresh request must supersede any scan already in flight — otherwise it
    // would inherit (and re-cache) a stale snapshot.
    cache = null;
    inflight = null;
  }
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.value;
  }
  if (!inflight) {
    inflight = Promise.resolve().then(() => {
      try {
        const value = computeList();
        cache = { at: Date.now(), value };
        return value;
      } finally {
        inflight = null;
      }
    });
  }
  return inflight;
}

/**
 * Permanently delete a single archive entry. Returns 404 for missing or
 * unsafe entry names; path-traversal is impossible because `archiveEntryPath`
 * only resolves safe names inside `.archive`.
 */
export async function deleteArchive(entry: string): Promise<void> {
  const full = archiveEntryPath(archiveRoot(), entry);
  if (!full || !fs.existsSync(full)) {
    throw new HttpError(404, `Archive entry '${entry}' not found`);
  }
  fs.rmSync(full, { recursive: true, force: true });
  invalidateArchiveCache();
  invalidateStorageCache();
}

/** Permanently delete EVERY archive entry. Returns the count removed. */
export async function emptyTrash(): Promise<number> {
  let count = 0;
  for (const entry of listArchiveEntries(archiveRoot())) {
    const full = archiveEntryPath(archiveRoot(), entry);
    if (!full || !fs.existsSync(full)) continue;
    try {
      fs.rmSync(full, { recursive: true, force: true });
      count += 1;
    } catch {
      /* skip unremovable entries — never fail the whole empty over one */
    }
  }
  invalidateArchiveCache();
  invalidateStorageCache();
  return count;
}

export interface RestoreOptions {
  name?: string;
  ports?: number[];
  description?: string;
}

/**
 * Restore an archived project as a NEW live project. Metadata (name, ports,
 * description, tags, notes, members) is NOT preserved from the archived
 * workspace — the archive holds only files — so restore recreates a minimal
 * project with fresh ports unset by default.
 *
 * Returns the created ProjectInfo. Sets the caller's ownership in the route.
 */
export async function restoreArchive(
  entry: string,
  opts: RestoreOptions = {},
  userId?: string,
): Promise<ProjectInfo> {
  const root = archiveRoot();
  const srcDir = archiveEntryPath(root, entry);
  if (!srcDir || !fs.existsSync(srcDir)) {
    throw new HttpError(404, `Archive entry '${entry}' not found`);
  }

  // Derive a base slug from the entry name (traversal-unsafe => fall back to
  // a timestamped slug) and make it unique against ANY existing workspace —
  // both live projects AND orphaned leftover dirs (which createProject rightly
  // refuses to reuse with a 409). Back off to `-1`, `-2`, ... in both cases,
  // mirroring duplicateProject's loop.
  const parsed = parseArchiveName(entry);
  let baseSlug = parsed.slug
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  if (!baseSlug || /^(wsd|ide|admin|api|system|root|workspace)$/.test(baseSlug)) {
    baseSlug = `restored-${Date.now().toString(36)}`;
  }

  let newSlug = baseSlug;
  let n = 1;
  while (await workspaceDirBusy(newSlug)) {
    newSlug = `${baseSlug}-${n}`;
    n += 1;
  }

  const displayName = (opts.name && String(opts.name).trim()) || parsed.slug || newSlug;

  // Fail fast with a clean 409 when a restore-requested port is already bound,
  // instead of letting container.start() surface an opaque Docker EADDRINUSE 500.
  if (opts.ports !== undefined) {
    const requested = validatePortSet(opts.ports); // throws a canonical 400 on junk/non-array
    if (requested.length > 0) {
      const used = await currentUsedPorts();
      const taken = requested.filter((p) => used.has(p));
      if (taken.length > 0) {
        throw new HttpError(409, `Ports already in use: ${taken.join(', ')}`);
      }
    }
  }

  // Provision a fresh project (container + empty workspace + fresh meta).
  const created = await createProject({
    name: displayName.slice(0, 120),
    slug: newSlug,
    description: opts.description !== undefined ? String(opts.description).trim() || undefined : undefined,
    ports: opts.ports,
  }, userId);

  // COPY the archived files into the fresh workspace (never move — see header).
  const dstDir = path.join(root, created.slug);
  copyTree(srcDir, dstDir);

  // Only now, after the project is live (meta persisted), consume the archive.
  try {
    fs.rmSync(srcDir, { recursive: true, force: true });
  } catch {
    /* leftover source handled by the janitor's next sweep — restore already done */
  }

  touchActivity(created.slug, 'restored', userId);
  invalidateArchiveCache();
  invalidateStorageCache();
  invalidateProjectsCache();

  return created;
}

/** True if a slug is already taken — by a live project OR a leftover workspace
 *  dir (the latter would make createProject 409, so we back off pre-emptively). */
async function workspaceDirBusy(slug: string): Promise<boolean> {
  try {
    if (await getProject(slug)) return true;
  } catch {
    /* not a live project — keep probing the filesystem */
  }
  const dir = path.join(archiveRoot(), slug);
  if (!fs.existsSync(dir)) return false;
  try {
    return fs.readdirSync(dir).some((f) => f !== '.archive' && !f.startsWith('.'));
  } catch {
    return true; // unreadable — assume busy, prefer a fresh suffix
  }
}

/** Re-expose a role/owner write after restore (mirrors import/duplicate routes). */
export async function setOwner(slug: string, userId: string): Promise<void> {
  const meta = loadMeta(slug) || { activity: [] };
  meta.ownerId = userId;
  meta.members = [{ userId, role: 'admin' as const, addedAt: new Date().toISOString() }];
  saveMeta(slug, meta);
}

// Re-exported for the route layer convenience.
export { safeName };
