/**
 * opencode-delegate-store.ts
 * Madar — Per-project delegation history at
 * WSD_DATA_DIR/projects/<slug>/delegations.json (mode 0600), capped at
 * DELEGATIONS_MAX_ENTRIES (20). Written under a per-slug file lock
 * (`delegate:<slug>`) like notes/activity; reads always sanitize and never
 * throw — a corrupt/missing store reads as empty.
 */
import fs from 'fs';
import path from 'path';

import { withFileLock } from './write-queue';
import {
  DELEGATIONS_MAX_ENTRIES,
  capDelegations,
  delegateEntryId,
  validAgentName,
  type DelegateCapability,
} from './opencode-delegate-core';

const DATA_DIR = process.env.WSD_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const META_DIR = path.join(DATA_DIR, 'projects');

export type DelegationStatus = 'running' | 'done' | 'failed';

export interface DelegationResult {
  text: string;
  agent?: string;
  model?: string;
  finish?: string;
  cost?: number | null;
  tokens?: number | null;
  files?: string[];
}

export interface DelegationEntry {
  id: string;
  agent: string;
  capability: DelegateCapability;
  prompt: string;
  status: DelegationStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  userId?: string;
  actorName?: string;
  error?: string;
  result?: DelegationResult;
}

const STATUSES: DelegationStatus[] = ['running', 'done', 'failed'];

function cleanSlug(slug: unknown): string {
  const clean = String(slug ?? '').replace(/[^a-z0-9._-]+/gi, '').slice(0, 64);
  return clean === '.' || clean === '..' ? '' : clean;
}

function delegationsFile(clean: string): string {
  return path.join(META_DIR, clean, 'delegations.json');
}

function isValidDate(v: unknown): v is string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

/** Validate + normalize one stored row — junk rows are dropped. */
function normalizeEntry(raw: unknown): DelegationEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const agent = typeof r.agent === 'string' && validAgentName(r.agent) ? r.agent : '';
  if (!agent) return null;
  const status: DelegationStatus = STATUSES.includes(r.status as DelegationStatus)
    ? (r.status as DelegationStatus)
    : 'failed';
  const prompt = typeof r.prompt === 'string' ? r.prompt.slice(0, 20_000) : '';
  const id =
    typeof r.id === 'string' && /^d-[a-z0-9]{6}-[a-z0-9]{6}$/.test(r.id)
      ? r.id
      : delegateEntryId();
  const capability: DelegateCapability = r.capability === 'readonly' ? 'readonly' : 'write';

  const entry: DelegationEntry = {
    id,
    agent,
    capability,
    prompt,
    status,
    createdAt: isValidDate(r.createdAt) ? r.createdAt : new Date().toISOString(),
  };
  if (isValidDate(r.startedAt)) entry.startedAt = r.startedAt;
  if (isValidDate(r.finishedAt)) entry.finishedAt = r.finishedAt;
  if (typeof r.durationMs === 'number' && Number.isFinite(r.durationMs)) entry.durationMs = r.durationMs;
  if (typeof r.userId === 'string' && r.userId) entry.userId = r.userId;
  if (typeof r.actorName === 'string' && r.actorName) entry.actorName = r.actorName;
  if (typeof r.error === 'string') entry.error = r.error.slice(0, 1000);

  const res = r.result as Record<string, unknown> | undefined;
  if (res && typeof res === 'object' && !Array.isArray(res)) {
    const result: DelegationResult = {
      text: typeof res.text === 'string' ? res.text.slice(0, 100_000) : '',
    };
    if (typeof res.agent === 'string') result.agent = res.agent;
    if (typeof res.model === 'string') result.model = res.model;
    if (typeof res.finish === 'string') result.finish = res.finish;
    if (typeof res.cost === 'number' && Number.isFinite(res.cost)) result.cost = res.cost;
    if (typeof res.tokens === 'number' && Number.isFinite(res.tokens)) result.tokens = res.tokens;
    if (Array.isArray(res.files)) {
      const files = res.files.filter((f): f is string => typeof f === 'string' && f.length <= 400);
      if (files.length) result.files = [...new Set(files)].slice(0, 100);
    }
    if (result.text) entry.result = result;
  }
  return entry;
}

function readEntries(clean: string): DelegationEntry[] {
  try {
    const file = delegationsFile(clean);
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list: unknown[] = Array.isArray(parsed) ? parsed : [];
    return capDelegations(
      list.map(normalizeEntry).filter((e): e is DelegationEntry => e !== null),
      DELEGATIONS_MAX_ENTRIES,
    );
  } catch {
    return [];
  }
}

function persist(clean: string, entries: DelegationEntry[], mode: number = 0o600): void {
  const file = delegationsFile(clean);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(entries, null, 2), { encoding: 'utf8', mode });
}

/** All entries, oldest→newest (the last one is the newest). */
export function listDelegations(slug: unknown): DelegationEntry[] {
  const clean = cleanSlug(slug);
  if (!clean) return [];
  return readEntries(clean);
}

/** One entry by id — undefined when unknown. */
export function getDelegation(slug: unknown, id: unknown): DelegationEntry | undefined {
  const clean = cleanSlug(slug);
  if (!clean || typeof id !== 'string' || !id) return undefined;
  return readEntries(clean).find((e) => e.id === id);
}

/**
 * Append one entry (oldest→newest) and prune to DELEGATIONS_MAX_ENTRIES.
 * Never throws — a failed write must not break a delegation run.
 */
export function appendDelegation(slug: unknown, entry: DelegationEntry): DelegationEntry | null {
  const clean = cleanSlug(slug);
  const normalized = normalizeEntry(entry);
  if (!clean || !normalized) return null;
  withFileLock(`delegate:${clean}`, () => {
    try {
      const next = capDelegations([...readEntries(clean), normalized], DELEGATIONS_MAX_ENTRIES);
      persist(clean, next);
    } catch {
      /* delegation history must never break the flow */
    }
  });
  return normalized;
}

/**
 * Update one existing entry in place (the running task flips to done/failed,
 * gets its result/error/duration). Returns the updated entry or undefined
 * when the id is unknown. Never throws.
 */
export function updateDelegation(
  slug: unknown,
  id: string,
  patch: Partial<Omit<DelegationEntry, 'id'>>,
): DelegationEntry | undefined {
  const clean = cleanSlug(slug);
  if (!clean || !/^d-[a-z0-9]{6}-[a-z0-9]{6}$/.test(id)) return undefined;
  let updated: DelegationEntry | undefined;
  withFileLock(`delegate:${clean}`, () => {
    try {
      const entries = readEntries(clean);
      const idx = entries.findIndex((e) => e.id === id);
      if (idx < 0) return;
      const merged = { ...entries[idx], ...patch, id };
      const normalized = normalizeEntry(merged);
      if (!normalized) return;
      entries[idx] = normalized;
      updated = normalized;
      persist(clean, capDelegations(entries, DELEGATIONS_MAX_ENTRIES));
    } catch {
      /* best effort */
    }
  });
  return updated;
}

/** Delete one entry; true when it existed. Never throws. */
export function deleteDelegation(slug: unknown, id: unknown): boolean {
  const clean = cleanSlug(slug);
  if (!clean || typeof id !== 'string' || !id) return false;
  let removed = false;
  withFileLock(`delegate:${clean}`, () => {
    try {
      const entries = readEntries(clean);
      const next = entries.filter((e) => e.id !== id);
      if (next.length === entries.length) return;
      removed = true;
      persist(clean, next);
    } catch {
      /* best effort */
    }
  });
  return removed;
}

/**
 * Reconcile entries left `running` by a crashed server: flip them to
 * `failed` with a server-restart marker so the history never shows a
 * permanently-pending task. Called at boot.
 */
export function reconcileRunningDelegations(): void {
  const projectsDir = META_DIR;
  let slugs: string[] = [];
  try {
    slugs = fs.existsSync(projectsDir) ? fs.readdirSync(projectsDir) : [];
  } catch {
    return;
  }
  for (const slug of slugs) {
    if (!cleanSlug(slug)) continue;
    const running = readEntries(slug).filter((e) => e.status === 'running');
    if (!running.length) continue;
    withFileLock(`delegate:${slug}`, () => {
      try {
        const entries = readEntries(slug).map((e) =>
          e.status === 'running'
            ? { ...e, status: 'failed' as const, finishedAt: new Date().toISOString(), error: 'Interrupted by server restart' }
            : e,
        );
        persist(slug, entries);
      } catch {
        /* best effort */
      }
    });
  }
}

export { DELEGATIONS_MAX_ENTRIES };
export type { DelegateCapability };