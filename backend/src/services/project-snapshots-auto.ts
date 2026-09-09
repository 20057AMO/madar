/**
 * project-snapshots-auto.ts
 * Madar — Automated per-project snapshots.
 *
 * A lightweight scheduler captures server-side snapshot archives on a
 * per-project schedule (meta.snapshot: enabled / intervalMin / keep) and
 * stores them next to the meta store at
 * WSD_DATA_DIR/projects/<slug>/snapshots/. The same tar.gz format exported
 * to a browser is written to disk, so a stored snapshot can be downloaded,
 * deleted or restored (as a brand-new project) without leaving the server.
 *
 * Scheduling logic is exposed as a pure function (computeDueSnapshots) so
 * the interval/retention rules are unit-testable without a running server.
 */
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { HttpError } from './docker-manager';
import { loadMeta, saveMeta, listMetaSlugs, type SnapshotSchedule } from './projects-meta';
import { exportProjectSnapshot, importProjectSnapshot } from './project-snapshots';
import { dispatchWebhook } from './webhook-sender';
import {
  DEFAULT_SCHEDULE,
  MAX_KEEP,
  SNAPSHOT_INTERVALS,
  sanitizeSchedule,
  computeDueSnapshots,
} from './snapshots-schedule';

const DATA_DIR = process.env.WSD_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const PROJECTS_DIR = path.join(DATA_DIR, 'projects');

export { DEFAULT_SCHEDULE, MAX_KEEP, SNAPSHOT_INTERVALS, computeDueSnapshots, sanitizeSchedule };

const SWEEP_MS = Math.max(10_000, Number(process.env.WSD_SNAPSHOT_SWEEP_MS) || 5 * 60_000);

/** Stored snapshot filenames: madar-<slug>-<yyyyMMddHHmmssSSS>.tar.gz */
const FILE_RE = /^madar-[a-z0-9][a-z0-9._-]{0,63}-\d{17}\.tar\.gz$/;

export interface SnapshotEntry {
  file: string;
  size: number;
  at: string;
}

function snapshotsDir(slug: string): string {
  const clean = String(slug ?? '').replace(/[^a-z0-9._-]+/gi, '');
  return path.join(PROJECTS_DIR, clean, 'snapshots');
}

/** Current schedule + last capture time for a project (defaults when unset). */
export function snapshotConfig(slug: string): SnapshotSchedule & { lastSnapshotAt: string | null } {
  const meta = loadMeta(slug);
  if (!meta) throw new HttpError(404, `Project '${slug}' not found`);
  return {
    ...DEFAULT_SCHEDULE,
    ...(meta.snapshot || {}),
    lastSnapshotAt: meta.lastSnapshotAt || null,
  };
}

/** Update a project's schedule (partial merge, re-validated). */
export function setSnapshotConfig(slug: string, input: Record<string, unknown>): ReturnType<typeof snapshotConfig> {
  const meta = loadMeta(slug);
  if (!meta) throw new HttpError(404, `Project '${slug}' not found`);
  meta.snapshot = sanitizeSchedule(input || {}, meta.snapshot);
  saveMeta(slug, meta);
  return snapshotConfig(slug);
}

/** Stored snapshots, newest first. */
export function listSnapshots(slug: string): { snapshots: SnapshotEntry[] } {
  const dir = snapshotsDir(slug);
  const items: SnapshotEntry[] = [];
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return { snapshots: [] };
  }
  for (const f of files.filter((n) => FILE_RE.test(n))) {
    try {
      const st = fs.statSync(path.join(dir, f));
      if (!st.isFile()) continue;
      const m = f.match(/^madar-[a-z0-9][a-z0-9._-]{0,63}-(\d{17})\.tar\.gz$/);
      const stamp = m?.[1] || '';
      const at = stamp
        ? new Date(
            +stamp.slice(0, 4),
            +stamp.slice(4, 6) - 1,
            +stamp.slice(6, 8),
            +stamp.slice(8, 10),
            +stamp.slice(10, 12),
            +stamp.slice(12, 14),
            +stamp.slice(14, 17),
          ).toISOString()
        : st.mtime.toISOString();
      items.push({ file: f, size: st.size, at });
    } catch {
      /* unreadable entry — skip */
    }
  }
  items.sort((a, b) => b.at.localeCompare(a.at));
  return { snapshots: items };
}

/** Validate a stored filename and return its path (traversal-proof). */
function resolveStoredFile(slug: string, file: string): string {
  if (!FILE_RE.test(file) || file.includes('/') || file.includes('\\') || file.includes('..')) {
    throw new HttpError(400, 'Invalid snapshot filename');
  }
  const dir = snapshotsDir(slug);
  const abs = path.resolve(dir, file);
  if (!abs.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(abs)) {
    throw new HttpError(404, 'Snapshot file not found');
  }
  return abs;
}

export function deleteSnapshot(slug: string, file: string): { ok: boolean } {
  const abs = resolveStoredFile(slug, file);
  try {
    fs.rmSync(abs, { force: true });
  } catch {
    throw new HttpError(500, 'Failed to delete snapshot file');
  }
  return { ok: true };
}

/** Download a stored snapshot as a gzip stream (caller attaches headers). */
export function downloadSnapshot(slug: string, file: string): fs.ReadStream {
  return fs.createReadStream(resolveStoredFile(slug, file));
}

/** Restore a stored snapshot as a brand-new project (never overwrites). */
export function restoreStoredSnapshot(slug: string, file: string, userId?: string): Promise<Awaited<ReturnType<typeof importProjectSnapshot>>> {
  return importProjectSnapshot(resolveStoredFile(slug, file), userId);
}

/**
 * Capture a server-side snapshot NOW. Writes the same tar.gz a browser
 * export produces, records lastSnapshotAt and prunes to the configured keep.
 */
export async function captureSnapshot(slug: string): Promise<SnapshotEntry> {
  const meta = loadMeta(slug);
  if (!meta) throw new HttpError(404, `Project '${slug}' not found`);
  const schedule = { ...DEFAULT_SCHEDULE, ...(meta.snapshot || {}) };

  const stamp = new Date()
    .toISOString()
    .replace(/[-:T]/g, '')
    .replace(/\.(\d{3})Z$/, '$1'); // yyyyMMddHHmmssSSS
  const file = `madar-${slug}-${stamp}.tar.gz`;
  const dir = snapshotsDir(slug);
  fs.mkdirSync(dir, { recursive: true });
  const abs = path.join(dir, file);

  try {
    await pipeline(exportProjectSnapshot(slug).stream, fs.createWriteStream(abs));
  } catch (err: any) {
    try {
      fs.rmSync(abs, { force: true });
    } catch {
      /* best-effort cleanup */
    }
    throw new HttpError(500, `Snapshot capture failed: ${err?.message || 'write error'}`);
  }

  const size = fs.statSync(abs).size;
  meta.lastSnapshotAt = new Date().toISOString();
  saveMeta(slug, meta);

  // Retention: keep at most `keep` newest archive files.
  if (schedule.keep >= 1) {
    const stored = listSnapshots(slug).snapshots;
    for (const old of stored.slice(schedule.keep)) {
      try {
        fs.rmSync(path.join(dir, old.file), { force: true });
      } catch {
        /* best-effort pruning */
      }
    }
  }

  dispatchWebhook('snapshot-saved', {
    event: 'snapshot-saved',
    slug,
    name: meta.name || slug,
    file,
    size,
    at: meta.lastSnapshotAt,
  });

  return { file, size, at: meta.lastSnapshotAt };
}

// ── Scheduling ───────────────────────────────────────────────────────────

let sweeping = false;

/** One sweep pass over every project with a due schedule. Returns captures. */
export async function runSnapshotSweep(now = Date.now()): Promise<number> {
  if (sweeping) return 0;
  sweeping = true;
  let captured = 0;
  try {
    const infos = listMetaSlugs().map((slug) => {
      const meta = loadMeta(slug);
      if (!meta) return { slug, schedule: null, lastSnapshotAt: null };
      return { slug, schedule: meta.snapshot || null, lastSnapshotAt: meta.lastSnapshotAt || null };
    });
    for (const slug of computeDueSnapshots(infos, now)) {
      try {
        await captureSnapshot(slug);
        captured++;
      } catch (err: any) {
        console.warn(`[snapshots] capture failed for ${slug}:`, err?.message || err);
      }
    }
  } finally {
    sweeping = false;
  }
  return captured;
}

let deferTimer: NodeJS.Timeout | null = null;

/** Defer one sweep shortly (used when a schedule flips on / at boot). */
export function scheduleSnapshotSweep(delayMs = 5000): void {
  if (deferTimer) clearTimeout(deferTimer);
  deferTimer = setTimeout(() => {
    deferTimer = null;
    void runSnapshotSweep();
  }, Math.max(500, delayMs));
}

/** Boot the automation loop (from index.ts). */
export function startSnapshotAutomation(): void {
  const iv = setInterval(() => void runSnapshotSweep(), SWEEP_MS);
  iv.unref?.();
  console.log(`[Madar] Snapshot automation: sweep interval ${Math.round(SWEEP_MS / 1000)}s`);
  scheduleSnapshotSweep();
}