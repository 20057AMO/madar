/**
 * workspace-image.ts
 * Madar — admin-facing workspace image status + controlled image refresh.
 *
 * The pure rules live in workspace-image-core.ts (import-free, unit-tested).
 * This module is the wiring: Docker inspection, the bounded `docker build`,
 * the 0600 last-refresh stamp, the 30 s status cache, and the typed errors the
 * HTTP layer maps to exact {error,message} responses.
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import {
  DEFAULT_WORKSPACE_STALE_DAYS,
  buildWorkspaceRefreshArgv,
  deriveWorkspaceImageStatus,
  parseWorkspaceImageLabels,
  type LastWorkspaceRefresh,
  type WorkspaceImageStatus,
} from './workspace-image-core';
import {
  getDockerDaemonVersion,
  inspectWorkspaceImage,
  invalidateWorkspaceImageCache,
  listWorkspaceImageProjects,
  readWorkspaceMarker,
} from './docker-manager';
import { createStorageCache } from './storage-cache-core';
import { recordAudit } from './audit-store';
import { withFileLockAsync } from './write-queue';

export const WORKSPACE_IMAGE_STATUS_TTL_MS = 30_000;
export const WORKSPACE_REFRESH_DEFAULT_TIMEOUT_MS = 900_000;
export const WORKSPACE_REFRESH_MIN_TIMEOUT_MS = 60_000;

const DATA_DIR = process.env.WSD_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const REFRESH_FILE = path.join(DATA_DIR, 'workspace-image-refresh.json');
const DOCKERFILE = '/opt/madar/build/Dockerfile.workspace';
const BUILD_CONTEXT = '/opt/madar/build';
const STDERR_CAP = 8 * 1024;
const BUILD_EXIT_GRACE_MS = 5_000;

export const WORKSPACE_IMAGE_ERRORS = {
  unauthorized: { status: 401, error: 'unauthorized', message: 'Authentication required' },
  forbidden: { status: 403, error: 'forbidden', message: 'Admin access required' },
  refresh_in_progress: { status: 409, error: 'refresh_in_progress', message: 'A workspace image refresh is already running' },
  rate_limited: { status: 429, error: 'rate_limited', message: 'Too many workspace-image requests' },
  docker_unavailable: { status: 503, error: 'docker_unavailable', message: 'Docker daemon is not reachable' },
  workspace_build_unavailable: { status: 503, error: 'workspace_build_unavailable', message: 'Workspace image build source is unavailable' },
  workspace_build_failed: { status: 502, error: 'workspace_build_failed', message: 'Workspace image refresh failed' },
  workspace_build_timeout: { status: 504, error: 'workspace_build_timeout', message: 'Workspace image refresh timed out' },
} as const;

export type WorkspaceImageErrorCode = keyof typeof WORKSPACE_IMAGE_ERRORS;

export class WorkspaceImageError extends Error {
  readonly code: WorkspaceImageErrorCode;

  constructor(code: WorkspaceImageErrorCode) {
    super(WORKSPACE_IMAGE_ERRORS[code].message);
    this.name = 'WorkspaceImageError';
    this.code = code;
  }
}

export interface WorkspaceImageApiStatus {
  workspaceImage: Omit<WorkspaceImageStatus, 'daemon' | 'projects' | 'checkedAt'>;
  daemon: WorkspaceImageStatus['daemon'];
  projects: WorkspaceImageStatus['projects'];
  lastRefresh: LastWorkspaceRefresh | null;
  checkedAt: string;
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function floorInt(raw: string | undefined, fallback: number, min: number): number {
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.floor(n));
}

/** Env knobs resolve once per call so a test can vary process.env safely. */
export function workspaceImageEnv(): { staleDays: number; timeoutMs: number } {
  return {
    staleDays: clampInt(
      process.env.WSD_WORKSPACE_STALE_DAYS,
      DEFAULT_WORKSPACE_STALE_DAYS,
      1,
      365,
    ),
    timeoutMs: floorInt(
      process.env.WSD_WORKSPACE_REFRESH_TIMEOUT_MS,
      WORKSPACE_REFRESH_DEFAULT_TIMEOUT_MS,
      WORKSPACE_REFRESH_MIN_TIMEOUT_MS,
    ),
  };
}

function sanitizeLastRefresh(value: unknown): LastWorkspaceRefresh | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.at !== 'string' || !raw.at.trim() || !Number.isFinite(Date.parse(raw.at))) return null;
  if (typeof raw.ok !== 'boolean') return null;
  if (typeof raw.durationMs !== 'number' || !Number.isFinite(raw.durationMs) || raw.durationMs < 0) return null;
  const buildId = typeof raw.buildId === 'string' && raw.buildId.trim() ? raw.buildId : null;
  const errorCode = typeof raw.errorCode === 'string' && raw.errorCode.trim() ? raw.errorCode : null;
  return { at: raw.at, ok: raw.ok, durationMs: raw.durationMs, buildId, errorCode };
}

/** Corrupt/missing stamps are absent state, never a startup failure. */
export function getLastWorkspaceRefresh(): LastWorkspaceRefresh | null {
  try {
    if (!fs.existsSync(REFRESH_FILE)) return null;
    return sanitizeLastRefresh(JSON.parse(fs.readFileSync(REFRESH_FILE, 'utf8')));
  } catch {
    return null;
  }
}

async function persistLastRefresh(entry: LastWorkspaceRefresh): Promise<void> {
  await withFileLockAsync('workspace-image-refresh', async () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(REFRESH_FILE, `${JSON.stringify(entry, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  });
}

async function loadWorkspaceImageStatus(): Promise<WorkspaceImageApiStatus> {
  const env = workspaceImageEnv();
  const [inspection, marker, daemon, listed] = await Promise.all([
    inspectWorkspaceImage().catch(() => ({ imageId: null, labels: {} })),
    readWorkspaceMarker().catch(() => null),
    getDockerDaemonVersion().catch(() => null),
    listWorkspaceImageProjects(null).catch(() => []),
  ]);

  const currentImageId = inspection.imageId;
  const projects = listed.map((p) => ({
    ...p,
    imageCurrent: Boolean(currentImageId && p.imageId === currentImageId),
  }));
  const labels = parseWorkspaceImageLabels(inspection.labels);
  // Older images carry the declared toolchain only in the baked marker.
  const effectiveLabels = {
    ...labels,
    declared: labels.declared ?? marker?.declared ?? null,
  };
  const derived = deriveWorkspaceImageStatus({
    labels: effectiveLabels,
    marker,
    daemon,
    projects,
    maxAgeDays: env.staleDays,
  });
  const { daemon: derivedDaemon, projects: derivedProjects, checkedAt, ...workspaceImage } = derived;
  return {
    workspaceImage: { ...workspaceImage, installed: currentImageId !== null, imageId: currentImageId },
    daemon: derivedDaemon,
    projects: derivedProjects,
    lastRefresh: getLastWorkspaceRefresh(),
    checkedAt,
  };
}

const statusCache = createStorageCache<WorkspaceImageApiStatus>({
  ttlMs: WORKSPACE_IMAGE_STATUS_TTL_MS,
  load: loadWorkspaceImageStatus,
});

/** `fresh=1` / `fresh=true` use the separate fresh slot, never a stale fan-out. */
export function getWorkspaceImageStatus(fresh = false): Promise<WorkspaceImageApiStatus> {
  return statusCache.get({ fresh });
}

interface BuildResult {
  code: number | null;
  stderr: string;
  timedOut: boolean;
  spawnError: boolean;
}

interface DockerBuild {
  result: Promise<BuildResult>;
  exited: Promise<void>;
}

function runDockerBuild(argv: string[], timeoutMs: number): DockerBuild {
  let resolveExited: () => void = () => {};
  const exited = new Promise<void>((resolve) => { resolveExited = resolve; });
  const result = new Promise<BuildResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('docker', argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolveExited();
      resolve({ code: null, stderr: '', timedOut: false, spawnError: true });
      return;
    }

    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => finish({ code: null, stderr, timedOut: true, spawnError: false }), timeoutMs);

    function finish(result: BuildResult): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (result.timedOut || result.spawnError) {
        try { child.kill('SIGKILL'); } catch {}
      }
      resolve(result);
    }

    child.stdout?.on('data', () => {});
    child.stderr?.on('data', (chunk: Buffer) => {
      const remaining = STDERR_CAP - stderr.length;
      if (remaining > 0) stderr += chunk.toString('utf8', 0, Math.min(chunk.length, remaining));
    });
    child.on('error', () => {
      resolveExited();
      finish({ code: null, stderr, timedOut: false, spawnError: true });
    });
    child.on('close', (code) => {
      resolveExited();
      finish({ code, stderr, timedOut: false, spawnError: false });
    });
  });
  return { result, exited };
}

async function waitForBuildExit(exited: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<void>((resolve) => { timer = setTimeout(resolve, BUILD_EXIT_GRACE_MS); });
  try {
    await Promise.race([exited, grace]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function classifyBuildFailure(stderr: string): WorkspaceImageErrorCode {
  const text = stderr.toLowerCase();
  if (/docker daemon|docker\.sock|econnrefused|econnreset|is the docker daemon running|cannot connect/i.test(text)) {
    return 'docker_unavailable';
  }
  if (/cannot locate specified dockerfile|failed to read dockerfile|no such file or directory|does not exist|not found/i.test(text)) {
    return 'workspace_build_unavailable';
  }
  return 'workspace_build_failed';
}

let refreshInProgress = false;

export interface RefreshWorkspaceImageInput {
  ip?: string;
  userId?: string;
}

/**
 * Bounded, synchronous refresh. It rebuilds the workspace image only — no
 * container is recreated, so existing projects keep running on the old image
 * until an explicit recreate. A second concurrent POST gets 409, never a
 * second build.
 */
export async function refreshWorkspaceImage(input: RefreshWorkspaceImageInput = {}): Promise<{ status: 'ok'; lastRefresh: LastWorkspaceRefresh }> {
  if (refreshInProgress) throw new WorkspaceImageError('refresh_in_progress');
  const buildId = `wi-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
  let startedAt = Date.now();
  let code: WorkspaceImageErrorCode | null = null;

  try {
    refreshInProgress = true;
    startedAt = Date.now();
    const env = workspaceImageEnv();
    const daemon = await getDockerDaemonVersion();
    if (!daemon) throw new WorkspaceImageError('docker_unavailable');

    if (!fs.existsSync(DOCKERFILE) || !fs.existsSync(BUILD_CONTEXT)) {
      throw new WorkspaceImageError('workspace_build_unavailable');
    }

    const builtAt = new Date().toISOString();
    const argv = buildWorkspaceRefreshArgv({ dockerfile: DOCKERFILE, context: BUILD_CONTEXT, buildId, builtAt });
    const build = runDockerBuild(argv, env.timeoutMs);
    let result: BuildResult;
    try {
      result = await build.result;
    } finally {
      await waitForBuildExit(build.exited);
    }
    if (result.spawnError) throw new WorkspaceImageError('docker_unavailable');
    if (result.timedOut) throw new WorkspaceImageError('workspace_build_timeout');
    if (result.code !== 0) throw new WorkspaceImageError(classifyBuildFailure(result.stderr));

    const lastRefresh: LastWorkspaceRefresh = {
      at: new Date().toISOString(),
      ok: true,
      durationMs: Math.max(0, Date.now() - startedAt),
      buildId,
      errorCode: null,
    };
    await persistLastRefresh(lastRefresh);
    invalidateWorkspaceImageCache();
    statusCache.invalidate();
    recordAudit('workspace-image-refresh', true, input.ip, input.userId, {
      buildId,
      durationMs: lastRefresh.durationMs,
    });
    return { status: 'ok', lastRefresh };
  } catch (err) {
    code = err instanceof WorkspaceImageError ? err.code : 'workspace_build_failed';
    const lastRefresh: LastWorkspaceRefresh = {
      at: new Date().toISOString(),
      ok: false,
      durationMs: Math.max(0, Date.now() - startedAt),
      buildId,
      errorCode: code,
    };
    try { await persistLastRefresh(lastRefresh); } catch {}
    try { invalidateWorkspaceImageCache(); } catch {}
    try { statusCache.invalidate(); } catch {}
    recordAudit('workspace-image-refresh-failed', false, input.ip, input.userId, {
      buildId,
      durationMs: lastRefresh.durationMs,
      errorCode: code,
    });
    throw err instanceof WorkspaceImageError ? err : new WorkspaceImageError(code);
  } finally {
    refreshInProgress = false;
  }
}
