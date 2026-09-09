/**
 * projects-meta.ts
 * Madar — Durable per-project metadata (description, image, ports, env,
 * activity history) stored as JSON under WSD_DATA_DIR/projects/<slug>/meta.json.
 * Docker labels are too limited for this (no description label, no update
 * endpoint for labels), so the meta store is the source of truth for anything
 * editable after creation.
 */
import fs from 'fs';
import path from 'path';

import { withFileLock } from './write-queue';
import type { ProjectLimits } from './project-limits';
import type { ServeConfig } from './serve-core';

const DATA_DIR = process.env.WSD_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const META_DIR = path.join(DATA_DIR, 'projects');

export interface ActivityEntry {
  action: string;
  at: string;
  /** The user who performed the action — legacy entries have none. */
  userId?: string;
}

export interface ProjectMember {
  userId: string;
  role: 'admin' | 'editor' | 'viewer';
  addedAt: string;
}

/** Automated snapshot schedule for a project (meta.snapshot). */
export interface SnapshotSchedule {
  enabled: boolean;
  intervalMin: number;
  keep: number;
}

/**
 * A detected container crash — user-facing, rendered as a red chip/banner
 * until an explicit start/recreate clears it. Kept OUT of the status union
 * so every existing status consumer (WS diff, pollers, filters) keeps working.
 */
export interface CrashInfo {
  at: string;
  reason: 'exited' | 'oom' | 'restart';
  exitCode?: number;
  /** how many times the container has auto-restarted (restart reason). */
  restarted?: number;
  /** the container start epoch this crash is attached to (restart dedupe). */
  startedAt?: string;
}

/**
 * Internal last-known container state used by the crash detector to spot
 * silent auto-restarts under RestartPolicy:unless-stopped. Never surfaced
 * to clients.
 */
export interface CrashWatch {
  restartCount: number;
  startedAt: string;
}

export interface ProjectMeta {
  name?: string;
  description?: string;
  image?: string;
  ports?: number[];
  createdAt?: string;
  env?: Record<string, string>;
  limits?: ProjectLimits;
  activity: ActivityEntry[];
  ownerId?: string;
  members?: ProjectMember[];
  snapshot?: SnapshotSchedule;
  lastSnapshotAt?: string;
  tags?: string[];
  /** true after an explicit UI stop — protects the exit from crash detection. */
  requestedStop?: boolean;
  /** last detected crash (surfaced to clients; cleared by start/recreate). */
  crash?: CrashInfo;
  /** internal crash-detector bookkeeping (never surfaced). */
  crashWatch?: CrashWatch;
  /** static-site serve toggle (enabled/port/pid) — see services/serve-core.ts. */
  serve?: ServeConfig;
}

function metaFile(slug: string): string {
  return path.join(META_DIR, slug, 'meta.json');
}

export function loadMeta(slug: string): ProjectMeta | null {
  const file = metaFile(String(slug ?? ''));
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object') {
      return { activity: [], ...raw };
    }
  } catch {
    /* corrupt meta — treated as missing */
  }
  return null;
}

/** Raw (unlocked) write — used inside withFileLock blocks to avoid reentrance. */
function saveMetaRaw(slug: string, meta: ProjectMeta): void {
  const clean = String(slug ?? '').replace(/[^a-z0-9._-]+/gi, '');
  if (!clean) return;
  fs.mkdirSync(path.dirname(metaFile(clean)), { recursive: true });
  fs.writeFileSync(metaFile(clean), JSON.stringify(meta, null, 2), 'utf8');
}

/** Per-slug write lock — prevents lost concurrent updates on meta.json. */
export function saveMeta(slug: string, meta: ProjectMeta): void {
  const clean = String(slug ?? '').replace(/[^a-z0-9._-]+/gi, '');
  if (!clean) return;
  withFileLock(`meta:${clean}`, () => saveMetaRaw(clean, meta));
}

export function deleteMeta(slug: string): void {
  const dir = path.dirname(metaFile(String(slug ?? '')));
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** Slugs of every project that has a meta store — the "live project" set. */
export function listMetaSlugs(): string[] {
  try {
    return fs
      .readdirSync(META_DIR)
      .filter((s) => s && !s.startsWith('.') && fs.existsSync(metaFile(s)));
  } catch {
    return [];
  }
}

export function touchActivity(slug: string, action: string, userId?: string): ProjectMeta | null {
  const clean = String(slug ?? '');
  return withFileLock(`meta:${clean}`, () => {
    const meta = loadMeta(clean) || { activity: [] };
    meta.activity = [
      ...(meta.activity || []),
      { action, at: new Date().toISOString(), ...(userId ? { userId } : {}) },
    ].slice(-200);
    saveMetaRaw(clean, meta);
    return meta;
  });
}

// ── Crash-detection state (requestedStop / crash / crashWatch) ──────────

/** Record that the user explicitly asked to stop this container (pre-stop). */
export function markRequestedStop(slug: string): void {
  withFileLock(`meta:${slug}`, () => {
    const meta = loadMeta(slug) || { activity: [] };
    meta.requestedStop = true;
    saveMetaRaw(slug, meta);
  });
}

export function getCrashWatch(slug: string): CrashWatch | null {
  return loadMeta(slug)?.crashWatch || null;
}

export function setCrashWatch(slug: string, watch: CrashWatch | undefined): void {
  withFileLock(`meta:${slug}`, () => {
    const meta = loadMeta(slug);
    if (!meta) return;
    if (watch) meta.crashWatch = watch;
    else delete meta.crashWatch;
    saveMetaRaw(slug, meta);
  });
}

/** Persist a detected crash (single-fire by design — see project-alerts). */
export function setCrashState(slug: string, crash: CrashInfo): void {
  withFileLock(`meta:${slug}`, () => {
    const meta = loadMeta(slug);
    if (!meta) return;
    meta.crash = crash;
    meta.activity = [...(meta.activity || []), { action: 'crashed', at: new Date().toISOString() }].slice(-200);
    saveMetaRaw(slug, meta);
  });
}

/**
 * Clear crash state + requestedStop after an explicit start/recreate/create.
 * `crashWatch` is re-seeded by the detector on its next inspect pass.
 */
export function clearCrashState(slug: string): void {
  withFileLock(`meta:${slug}`, () => {
    const meta = loadMeta(slug);
    if (!meta) return;
    delete meta.crash;
    delete meta.requestedStop;
    delete meta.crashWatch;
    saveMetaRaw(slug, meta);
  });
}
