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

import { withFileLock, withFileLockAsync } from './write-queue';
import {
  HttpError,
  cleanStoreSlug,
  assertSafeStoreSlug,
  isStrictlyInside,
} from './project-slug-core';
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
  activity?: ActivityEntry[];
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

/**
 * Thrown by every write path that refuses to touch an UNREADABLE meta store.
 *
 * It is a distinct type (not a bare 500) so a caller that owns a better answer
 * than "fail" can recognize it and degrade instead of propagating: an explicit
 * stop, for example, must still stop the container when the bookkeeping flag
 * cannot be written, because the damaged file is the ONLY copy of the project's
 * name/ports/env/members and overwriting it with a partial document would
 * destroy them.
 */
export class CorruptMetaError extends HttpError {
  constructor(slug: unknown) {
    super(
      500,
      `Project metadata for '${cleanStoreSlug(String(slug ?? ''))}' is corrupt — refusing to overwrite it with a partial document`,
    );
    this.name = 'CorruptMetaError';
  }
}

/** True only for the unreadable-store case — never for a real write failure. */
export function isCorruptMetaError(err: unknown): boolean {
  return err instanceof CorruptMetaError;
}

/**
 * The meta store's dir for a slug: sanitized, containment-checked, throwing.
 * This is the single choke point for load/save/delete AND metaFile — before this
 * change the three functions sanitized inconsistently (`loadMeta` not at all),
 * so `loadMeta('../x')` and `saveMeta('../x')` targeted DIFFERENT directories.
 * A bare `.` / `..` / empty / separator-bearing slug is refused outright: the
 * storage filter keeps dots on purpose (legacy slugs with dots exist), so the
 * containment assert is the actual sandbox.
 */
function metaDir(slug: unknown): string {
  const clean = assertSafeStoreSlug(slug, META_DIR);
  return path.join(META_DIR, clean);
}

/** meta.json for a slug — always routed through metaDir so ONE function decides. */
function metaFile(slug: unknown): string {
  return path.join(metaDir(slug), 'meta.json');
}

/** True when `resolved` is strictly inside META_DIR (defense in depth). */
function isMetaStorePath(resolved: string): boolean {
  return isStrictlyInside(path.resolve(META_DIR), resolved);
}

export type MetaReadState = 'ok' | 'absent' | 'corrupt';
export interface MetaReadResult {
  state: MetaReadState;
  meta: ProjectMeta | null;
}

/**
 * Tri-state read: absent / corrupt / ok.
 *
 * This exists because a CORRUPT meta.json must never be indistinguishable from
 * an ABSENT one. loadMeta() historically collapsed both to null, which (a) let
 * the legacy no-membership access fallback open a project whose membership
 * data was unreadable, and (b) let a write path silently persist a field-only
 * document built from `|| {}`, permanently destroying the project's metadata.
 * Write paths must use loadMetaStrict / updateMeta (which throw on corrupt);
 * the read-only contract of loadMeta (null on both) is preserved.
 */
export function readMeta(slug: unknown): MetaReadResult {
  // A store key that cannot resolve inside META_DIR is treated as absent —
  // never as a real project path.
  let clean: string;
  try {
    clean = assertSafeStoreSlug(slug, META_DIR);
  } catch {
    return { state: 'absent', meta: null };
  }
  const file = metaFile(clean);
  if (!isMetaStorePath(path.resolve(file))) return { state: 'absent', meta: null };
  if (!fs.existsSync(file)) return { state: 'absent', meta: null };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return { state: 'ok', meta: { activity: [], ...raw } };
    }
  } catch {
    /* fall through to corrupt */
  }
  return { state: 'corrupt', meta: null };
}

export function loadMeta(slug: string): ProjectMeta | null {
  return readMeta(slug).meta;
}

/**
 * Strict read for WRITE paths: absent → null, ok → meta, corrupt → throws.
 * A corrupt store is a 500, never an implicit empty document — writing back a
 * whole document built from `{}` would permanently wipe name/description/
 * ports/env/limits/tags/ownerId/members.
 */
export function loadMetaStrict(slug: string): ProjectMeta | null {
  const read = readMeta(slug);
  if (read.state === 'corrupt') {
    throw new CorruptMetaError(slug);
  }
  return read.meta;
}

/** Raw (unlocked) write — used inside withFileLock blocks to avoid reentrance. */
function saveMetaRaw(slug: string, meta: ProjectMeta): void {
  const clean = assertSafeStoreSlug(slug, META_DIR);
  const final = metaFile(clean);
  // Atomic: tmp + rename in the SAME directory — a crash/OOM/full-disk mid-write
  // can never leave a truncated meta.json that the next reader mistakes for a
  // legacy "no meta" project (which would trigger the open-access fallback).
  // Copy of the pattern from project-reviews.ts writeReviews().
  fs.mkdirSync(path.dirname(final), { recursive: true });
  const tmp = `${final}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, final);
}

/** Per-slug write lock — prevents lost concurrent updates on meta.json. */
export function saveMeta(slug: string, meta: ProjectMeta): void {
  const clean = assertSafeStoreSlug(slug, META_DIR);
  withFileLock(`meta:${clean}`, () => saveMetaRaw(clean, meta));
}

/**
 * Read-modify-write under one load. This is the FIX for the silent-wipe class:
 * a whole-document write built from `loadMeta(s) || {}` persisted ONLY the
 * mutated field whenever the load returned null (corrupt OR absent), destroying
 * every other field. `updateMeta` loads the real document (throwing on corrupt
 * — see loadMetaStrict), applies the mutation to that freshly-loaded object,
 * and saves. It also eliminates the stale-write class where a document is read,
 * held across an await, and written back having dropped concurrent changes.
 * `init` is used only when the store is genuinely ABSENT (legacy projects that
 * predate the meta store) — never for corrupt data.
 */
export function updateMeta(
  slug: string,
  mutator: (meta: ProjectMeta) => void,
  init: ProjectMeta = { activity: [] },
): ProjectMeta {
  const clean = assertSafeStoreSlug(slug, META_DIR);
  return withFileLock(`meta:${clean}`, () => {
    const loaded = loadMetaStrict(clean);
    const meta: ProjectMeta = loaded ?? { ...init };
    mutator(meta);
    saveMetaRaw(clean, meta);
    return meta;
  });
}

/**
 * Async variant of updateMeta — for mutators that must AWAIT inside the
 * read-modify-write (e.g. updateProjectLimits sanitizes + checks host ceilings
 * before persisting). Serialized per slug via withFileLockAsync, so the
 * loaded document can never go stale across the await.
 */
export async function updateMetaAsync(
  slug: string,
  mutator: (meta: ProjectMeta) => Promise<void> | void,
  init: ProjectMeta = { activity: [] },
): Promise<ProjectMeta> {
  const clean = assertSafeStoreSlug(slug, META_DIR);
  return withFileLockAsync(`meta:${clean}`, async () => {
    const loaded = loadMetaStrict(clean);
    const meta: ProjectMeta = loaded ?? { ...init };
    await mutator(meta);
    saveMetaRaw(clean, meta);
    return meta;
  });
}

export function deleteMeta(slug: string): void {
  const clean = assertSafeStoreSlug(slug, META_DIR);
  const dir = metaDir(clean);
  // Refuse anything not strictly inside META_DIR — a `..` slug used to make
  // path.dirname() point at DATA_DIR and rm -rf the ENTIRE data directory
  // (users.json / providers.json / audit.json / jwt.secret / crypto.salt).
  if (!isMetaStorePath(path.resolve(dir))) {
    throw new HttpError(400, 'Project slug is invalid');
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** Slugs of every project that has a meta store — the "live project" set. */
export function listMetaSlugs(): string[] {
  try {
    return fs.readdirSync(META_DIR).filter((s) => {
      if (!s || s.startsWith('.')) return false;
      // metaFile is the sanitizing choke point, so an unexpected directory name
      // must degrade to "no store" instead of throwing out of a listing.
      try {
        return fs.existsSync(metaFile(s));
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
}

// Activity history now lives in per-project activity.json via
// services/project-activity.ts (recordActivity/loadActivity/listActivity) —
// meta.activity is retained on the ProjectMeta type ONLY for legacy reads and
// the lazy backfill done by that store. touchActivity was removed in the
// migration; every write point records through project-activity instead.

// ── Crash-detection state (requestedStop / crash / crashWatch) ──────────

/** Record that the user explicitly asked to stop this container (pre-stop). */
export function markRequestedStop(slug: string): void {
  try {
    updateMeta(slug, (meta) => {
      meta.requestedStop = true;
    });
  } catch (err) {
    // An UNREADABLE store must not fail the stop: the flag is bookkeeping, the
    // stop is the user's instruction. Every other failure (unsafe slug, disk
    // error) still propagates — those are real errors, not an unreadable store.
    if (isCorruptMetaError(err)) return;
    throw err;
  }
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

/** Persist a detected crash (single-fire by design — see project-alerts).
 *  The `crashed` activity entry is recorded through project-activity's
 *  recordActivity by the detector, not here. */
export function setCrashState(slug: string, crash: CrashInfo): void {
  withFileLock(`meta:${slug}`, () => {
    const meta = loadMeta(slug);
    if (!meta) return;
    meta.crash = crash;
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
