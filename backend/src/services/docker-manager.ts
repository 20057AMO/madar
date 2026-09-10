/**
 * docker-manager.ts
 * Madar — Docker orchestration layer.
 * Creates, starts, stops, and inspects per-project containers via Dockerode.
 * Each project gets its own container on its own port(s); the workspace dir
 * lives under WORKSPACES_ROOT and is bind-mounted at /workspace.
 */

import Docker from 'dockerode';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { execSync, spawn, execFileSync } from 'child_process';
import {
  loadMeta,
  saveMeta,
  deleteMeta,
  touchActivity,
  listMetaSlugs,
  markRequestedStop,
  clearCrashState,
  type CrashInfo,
  type ProjectMeta,
} from './projects-meta';
import { loadNotes, saveNotes } from './project-notes';
import { loadCanvas, saveCanvas } from './project-canvas';
import { purgeOpencodeProjectRows } from './opencode-store';
import { dispatchWebhook } from './webhook-sender';
import { parseCpu, parseMemory, sanitizeLimitsPatch, limitsEqual, isEmptyLimits, checkCeilings, resolveDefaultLimits, getHostInfo, formatMemory, formatCpu, type ProjectLimits } from './project-limits';
import { runSweep } from './workspace-janitor';
import {
  createOpencodeSession,
  ensureOpencodeSession as ensureOpencodeSessionApi,
  unregisterOpencodeProjectSessions,
} from './opencode-api';
import { ensureServeRunning, probeServe } from './project-serve';
import { deriveServeState, type ServeState } from './serve-core';
import { invalidateProjectsCache } from './projects-cache';
import { ensureProjectChannel, deleteChannel } from './chat-team-store';

const docker = new Docker(); // uses /var/run/docker.sock by default

// Host path where project workspaces live (bind-mounted into containers)
const WORKSPACES_ROOT = process.env.WSD_PROJECTS_DIR || '/workspaces';
// Host-side path of the same directory, used as the bind source for project
// containers. Bind sources are resolved by the Docker daemon (the Docker
// Desktop VM), so a container-internal path like /workspaces/<slug> would
// resolve to an unrelated empty directory there.
const WORKSPACES_HOST_DIR = (process.env.WSD_WORKSPACES_HOST_DIR || '').replace(/[\\/]+$/, '');

// Base image used for project workspaces (Ubuntu + dev tooling)
const BASE_IMAGE = process.env.WSD_WORKSPACE_IMAGE || 'wsd/workspace:latest';

export interface ProjectSpec {
  limits?: { cpu?: string | null; memory?: string | null };

  name: string;
  slug: string;
  description?: string;
  image?: string;
  ports?: number[]; // host ports to expose
  env?: Record<string, string>;
}

export interface ProjectInfo {
  limits?: ProjectLimits;
  liveLimits?: ProjectLimits;

  id: string;
  name: string;
  slug: string;
  description?: string;
  status: 'running' | 'stopped' | 'created' | 'missing';
  containerId?: string;
  hostPorts?: Record<string, string>;
  createdAt?: string;
  image?: string;
  ports?: number[];
  env?: Record<string, string>;
  activity?: { action: string; at: string; userId?: string }[];
  ownerId?: string;
  members?: { userId: string; role: 'admin' | 'editor' | 'viewer'; addedAt: string }[];
  /** User-defined labels for organizing/filtering projects. */
  tags?: string[];
  /** Last detected crash — set by the crash detector, cleared by start/recreate. */
  crash?: CrashInfo;
  /** Static-site serve state (config + live probe result). */
  serve?: ServeState;
}

function validateProjectSlug(slug: string): string {
  const value = String(slug ?? '').trim().toLowerCase();
  const clean = value.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  if (!clean) throw new HttpError(400, 'Project slug is invalid');

  const RESERVED_SLUGS = ['wsd', 'ide', 'admin', 'api', 'system', 'root', 'workspace'];
  if (RESERVED_SLUGS.includes(clean)) {
    throw new HttpError(400, `Project slug '${clean}' is reserved and cannot be used.`);
  }

  return clean;
}

function sanitizeSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || `project-${Date.now()}`;
}

function validateProjectSpec(spec: ProjectSpec): { name: string; slug: string; description?: string; image?: string; ports?: number[]; env: Record<string, string> } {
  const name = String(spec.name ?? '').trim();
  if (!name) throw new HttpError(400, 'Project name is required');

  const slugInput = spec.slug ? String(spec.slug).trim() : sanitizeSlug(name);
  const slug = validateProjectSlug(slugInput);

  const cleanPorts = validatePortSet(spec.ports);

  return {
    name,
    slug,
    description: spec.description ? String(spec.description).trim() : undefined,
    image: spec.image ? String(spec.image).trim() : undefined,
    ports: cleanPorts,
    env: normalizeEnv(spec.env),
  };
}

function normalizeEnv(env?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!env || typeof env !== 'object') return out;
  for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    if (typeof v === 'string' && v.length <= 4000) out[k] = v;
  }
  return out;
}

/**
 * Validate + dedupe a raw port array using the exact rules as project
 * creation: integers 1-65535, no privileged system ports (<1024), no Madar
 * reserved service ports. Sharing this with the create path keeps edit,
 * duplicate and import on one contract. When `max` is given, exceeding it
 * rejects the whole set (create stays uncapped).
 */
export function validatePortSet(ports: unknown, opts?: { max?: number }): number[] {
  const rawPorts = Array.isArray(ports) ? [...ports] : [];
  const seen = new Set<number>();
  const cleanPorts: number[] = [];

  for (const raw of rawPorts) {
    const port = Number(raw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new HttpError(400, `Invalid port: ${raw} (must be 1-65535)`);
    }
    if (port < 1024) {
      throw new HttpError(400, `Port ${port} is a privileged system port (1-1023) and cannot be used.`);
    }
    const dashboardPort = Number(process.env.PORT) || 3000;
    const idePort = Number(process.env.WSD_IDE_PORT) || 8100;
    const opencodePort = Number(process.env.WSD_OPENCODE_PORT) || 4096;
    if (port === dashboardPort) {
      throw new HttpError(400, `Port ${port} is reserved for the Madar dashboard.`);
    }
    if (port === idePort) {
      throw new HttpError(400, `Port ${port} is reserved for the Madar VS Code service.`);
    }
    if (port === opencodePort) {
      throw new HttpError(400, `Port ${port} is reserved for the Madar opencode web UI.`);
    }

    if (seen.has(port)) continue;
    seen.add(port);
    cleanPorts.push(port);
    if (opts?.max && cleanPorts.length > opts.max) {
      throw new HttpError(400, `Too many ports (max ${opts.max})`);
    }
  }

  return cleanPorts;
}

/** All host ports currently claimed: reserved system ports, every project's
 *  declared meta ports, AND their container bindings — including STALE
 *  bindings of edited-but-not-recreated projects and fully stopped containers.
 *  Those bindings live in HostConfig.PortBindings (persist across stop/start),
 *  which the cheap docker list call does not expose, so stopped containers are
 *  inspected individually. Claiming such a port would destroy or brick a
 *  sibling container the moment it starts/recreates.
 */
export async function currentUsedPorts(): Promise<Set<number>> {
  const used = new Set<number>();
  const reserved = [Number(process.env.PORT) || 3000, Number(process.env.WSD_IDE_PORT) || 8100, Number(process.env.WSD_OPENCODE_PORT) || 4096];
  for (const p of reserved) used.add(p);
  for (const proj of await listProjects()) {
    for (const p of proj.ports || []) used.add(p);
    let live: number[] = [];
    if (proj.status === 'running') {
      live = Object.values(proj.hostPorts || {}).map(Number);
    } else {
      const info = await getProject(proj.slug);
      live = Object.values(info?.hostPorts || {}).map(Number);
    }
    for (const p of live) {
      if (Number.isInteger(p) && p >= 1024 && p <= 65535) used.add(p);
    }
  }
  return used;
}

/** Reuse requested ports when free; otherwise hand out fresh free ports. */
export function resolvePorts(requested: number[] | undefined, used: Set<number>): number[] {
  const out: number[] = [];
  let probe = 8000;
  for (const raw of Array.isArray(requested) ? requested : []) {
    const p = Number(raw);
    if (!Number.isInteger(p) || p < 1024 || p > 65535) continue;
    if (!used.has(p)) {
      used.add(p);
      out.push(p);
    } else {
      while (used.has(probe)) probe++;
      used.add(probe);
      out.push(probe);
    }
  }
  return out;
}

/** Error with an HTTP status code — routes map this to the response. */
export class HttpError extends Error {
  statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

/** Throw a 404 if no container exists for this slug. */
async function requireContainer(slug: string) {
  const projectSlug = validateProjectSlug(slug);
  const info = await getProject(projectSlug);
  if (!info) throw new HttpError(404, `Project '${projectSlug}' not found`);
  return info;
}

function ensureWorkspaceDir(slug: string): string {
  const dir = path.join(WORKSPACES_ROOT, slug);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// opencode runtime integration (sessions, version, updates) lives in
// services/opencode-api.ts — this module only forwards to it.

function registerOpencodeProject(slug: string): void {
  createOpencodeSession(slug);
}

/** Ensure a project has at least one opencode session (no duplicates). */
export function ensureOpencodeSession(slug: string): void {
  ensureOpencodeSessionApi(slug);
}

/**
 * Best-effort cleanup of opencode sessions bound to a deleted project's
 * directory, so stale sessions don't linger in the web UI. Non-fatal: any
 * failure (opencode down, API shape drift) is silently ignored.
 */
function unregisterOpencodeProject(slug: string): void {
  unregisterOpencodeProjectSessions(slug);
}

/**
 * Make sure the project image exists locally; if not, pull it so
 * `docker create` never fails on a missing image (fresh hosts, CI, etc).
 */
async function ensureImage(image: string): Promise<void> {
  try {
    await docker.getImage(image).inspect();
    return;
  } catch {
    // image not present locally — pull it
  }
  await new Promise<void>((resolve, reject) => {
    docker.pull(image, (err: any, stream: any) => {
      if (err || !stream) {
        return reject(new Error(`Failed to pull ${image}: ${err?.message || 'no stream'}`));
      }
      stream.on('data', () => { /* progress */ });
      stream.on('end', () => resolve());
      stream.on('close', () => resolve());
      stream.on('error', (e: Error) => reject(new Error(`Failed to pull ${image}: ${e.message}`)));
    });
  });
}

/**
 * Create a project: provision workspace dir + launch container.
 */
export async function createProject(spec: ProjectSpec, userId?: string): Promise<ProjectInfo> {
  const clean = validateProjectSpec(spec);
  // Compute effective limits: request > previous meta > defaults (if any).
  const rawLimits = spec.limits || {};
  let effectiveLimits: ProjectLimits | undefined;
  const prevMeta = loadMeta(clean.slug);
  if (rawLimits.cpu !== undefined || rawLimits.memory !== undefined) {
    // User explicitly provided a limits patch.
    let merged: ProjectLimits;
    try {
      merged = sanitizeLimitsPatch(rawLimits, {});
      await checkCeilings(merged, await getHostInfo());
    } catch (e: any) {
      throw new HttpError(400, e?.message || 'Invalid resource limits');
    }
    effectiveLimits = isEmptyLimits(merged) ? undefined : merged;
  } else if (prevMeta?.limits) {
    // Re-derived from stored meta — re-validate against the CURRENT host so a
    // migrated/down-sized host can never silently oversubscribe. A stored set
    // that no longer fits degrades to unlimited (logged), not a hard 400.
    try {
      const merged = sanitizeLimitsPatch(prevMeta.limits, {});
      await checkCeilings(merged, await getHostInfo());
      effectiveLimits = isEmptyLimits(merged) ? undefined : merged;
    } catch (e: any) {
      console.warn(`[limits] stored limits for '${clean.slug}' no longer fit this host, ignoring`, e?.message);
      effectiveLimits = undefined;
    }
  } else {
    // New project – apply defaults from env if defined. A misconfigured
    // WSD_DEFAULT_* must never 500 every create: warn and run unlimited.
    try {
      effectiveLimits = await resolveDefaultLimits();
    } catch (e: any) {
      console.warn('[limits] invalid WSD_DEFAULT_CPU/WSD_DEFAULT_MEMORY, ignoring defaults', e?.message);
      effectiveLimits = undefined;
    }
  }

  const existing = await getProject(clean.slug);
  if (existing) {
    throw new HttpError(409, `Project '${clean.slug}' already exists`);
  }

  const slug = clean.slug;
  // Guard against silently inheriting files left behind by a previously
  // deleted project (crash mid-delete, pre-upgrade leftovers, manual dirs).
  // The janitor archives such strays automatically, so this window is small.
  const workDirPath = path.join(WORKSPACES_ROOT, slug);
  if (!loadMeta(slug) && fs.existsSync(workDirPath)) {
    let hasLeftovers = false;
    try {
      hasLeftovers = fs
        .readdirSync(workDirPath)
        .some((f) => f !== '.archive' && !f.startsWith('.'));
    } catch {
      /* unreadable — let creation proceed */
    }
    if (hasLeftovers) {
      throw new HttpError(
        409,
        `A workspace folder '${slug}' already exists from an earlier project. ` +
          'It is archived automatically within a few minutes — retry shortly.',
      );
    }
  }
  ensureWorkspaceDir(slug);
  // A bind source missing is a silent-wrong-mount trap: dockerode passes the
  // string to the daemon, which resolves it on the daemon host (Docker Desktop
  // VM), not inside this container. Require the host-side path explicitly.
  if (!WORKSPACES_HOST_DIR) {
    throw new HttpError(
      500,
      'WSD_WORKSPACES_HOST_DIR is not set — project containers would mount the wrong directory. ' +
        'Set it to the host-side absolute path of ./workspaces in the environment.',
    );
  }
  const bindSource = `${WORKSPACES_HOST_DIR.replace(/\\/g, '/')}/${slug}`;
  const containerName = `wsd-${slug}`;
  const image = clean.image || BASE_IMAGE;
  await ensureImage(image);

  // Port mappings: expose requested host ports (bound to all interfaces)
  const portBindings: Record<string, any> = {};
  const exposedPorts: Record<string, any> = {};
  const hostPorts: Record<string, string> = {};
  if (clean.ports) {
    for (const p of clean.ports) {
      const key = `${p}/tcp`;
      exposedPorts[key] = {};
      portBindings[key] = [{ HostIp: '0.0.0.0', HostPort: String(p) }];
      hostPorts[String(p)] = String(p);
    }
  }

  const container = await docker.createContainer({
    name: containerName,
    Image: image,
    Cmd: ['/bin/bash', '-c', 'sleep infinity'],
    Tty: true,
    OpenStdin: true,
    Env: [
      ...Object.entries(clean.env || {}).map(([k, v]) => `${k}=${v}`),
      'DEBIAN_FRONTEND=noninteractive',
    ],
    ExposedPorts: exposedPorts,
    HostConfig: {
      Binds: [`${bindSource}:/workspace`],
      PortBindings: portBindings,
      // Resource limits – omitted if undefined (unlimited).
      ...(effectiveLimits?.memory ? { Memory: parseMemory(effectiveLimits.memory)!.bytes } : {}),
      ...(effectiveLimits?.cpu ? { NanoCpus: parseCpu(effectiveLimits.cpu)!.nano } : {}),
      // Without MemorySwap Docker silently defaults swap to 2× RAM, which
      // would undermine the memory cap. MemorySwap is the memory+swap TOTAL,
      // so passing the exact memory limit disables swap: the container is
      // OOM-killed at the cap instead of thrashing host swap. NB -1 would mean
      // UNLIMITED swap — that is the opposite of what a "limit" promises.
      ...(effectiveLimits?.memory
        ? { MemorySwap: parseMemory(effectiveLimits.memory)!.bytes }
        : {}),
      RestartPolicy: { Name: 'unless-stopped' },
    },
    Labels: {
      'wsd.project': slug,
      'wsd.name': clean.name,
      'wsd.managed': 'true',
      'wsd.createdAt': new Date().toISOString(),
    },
    WorkingDir: '/workspace',
  });

  try {
    await container.start();
  } catch (err: any) {
    if (err.message && err.message.includes('port is already allocated')) {
      throw {
        statusCode: 409,
        message: 'One or more requested ports are already in use by another project or service.',
      };
    }
    throw err;
  }

  registerOpencodeProject(slug);

  const info: ProjectInfo = {
    id: container.id,
    name: clean.name,
    slug,
    description: clean.description,
    status: 'running',
    containerId: container.id,
    hostPorts,
    createdAt: new Date().toISOString(),
    image,
    ports: clean.ports,
    env: clean.env,
    limits: effectiveLimits,
    liveLimits: effectiveLimits,
  };

  const prev = loadMeta(slug);
  // Merge with any existing meta instead of overwriting: a recreate (or any
  // later call with the same slug) must preserve membership, owner and the
  // snapshot schedule rather than silently demoting a team project to the
  // "legacy, allow all" state. A fresh slug sees prev = null → current behavior.
  // Crash state (crash / requestedStop / crashWatch) is NEVER carried over —
  // a brand-new container starts clean; the detector re-seeds its watch on
  // the next inspect pass.
  const savedMeta: ProjectMeta = {
    ...prev,
    name: clean.name,
    description: clean.description,
    image,
    ports: clean.ports,
    limits: effectiveLimits,
    createdAt: info.createdAt,
    env: clean.env,
    activity: [
      ...(prev?.activity || []),
      { action: 'created', at: new Date().toISOString(), ...(userId ? { userId } : {}) },
    ].slice(-200),
  };
  delete savedMeta.crash;
  delete savedMeta.requestedStop;
  delete savedMeta.crashWatch;
  saveMeta(slug, savedMeta);

  // A project gets its own auto channel (project:<slug>) tied to its lifecycle —
  // created here (create covers fresh + recreate + duplicate) so the team can
  // discuss the project from the moment it exists. Never breaks creation.
  try {
    await ensureProjectChannel(slug, clean.name, userId);
  } catch (e: any) {
    console.warn(`[chat] could not create auto channel for '${slug}':`, e?.message || e);
  }

  // If the persisted meta enables static-site serving, (re)start the serve
  // process now that the fresh container is up. Never throws — a failed serve
  // must not break creation. createProject also serves as the recreate path
  // (recreateProject routes through it) with the prev-meta merge preserving
  // `serve`, so a recreate transparently re-runs the server.
  await ensureServeRunning(slug).catch((e) =>
    console.warn(`[serve] could not start for '${slug}' during create:`, e?.message || e)
  );

  // Event-driven janitor pass: any orphan that accumulated while the app was
  // running is archived immediately, so code-server's explorer (rooted at
  // /workspaces) shows exactly the Projects-page set right now — not at the
  // next periodic sweep. Meta exists by this point, so the new project is
  // already "live" from the sweep's perspective.
  try {
    runSweep();
  } catch {
    /* never fail a create over cleanup */
  }

  dispatchWebhook('created', { event: 'created', slug, name: clean.name, at: new Date().toISOString() });

  // A new container is immediately listable — drop any cached project list.
  invalidateProjectsCache();

  return info;
}

/**
 * List all WSD-managed projects (containers with wsd.managed=true).
 */
export async function listProjects(): Promise<ProjectInfo[]> {
  const containers = await docker.listContainers({ all: true });
  const projects: ProjectInfo[] = [];

  for (const c of containers) {
    const labels = c.Labels || {};
    if (labels['wsd.managed'] !== 'true') continue;

    const slug = labels['wsd.project'] || c.Names[0]?.replace(/^\//, '');
    const ports: Record<string, string> = {};
    for (const p of c.Ports || []) {
      if (p.PublicPort) ports[String(p.PrivatePort)] = String(p.PublicPort);
    }

    const project: ProjectInfo = {
      id: c.Id,
      name: labels['wsd.name'] || slug.replace(/^wsd-/, ''),
      slug,
      status: c.State === 'running' ? 'running' : 'stopped',
      containerId: c.Id,
      hostPorts: ports,
      createdAt: labels['wsd.createdAt'],
    };

    const meta = loadMeta(slug);
    if (meta) {
      if (meta.name) project.name = meta.name;
      project.description = meta.description;
      project.image = meta.image;
      project.ports = meta.ports;
      project.limits = meta.limits;
      project.env = meta.env;
      project.activity = meta.activity;
      project.ownerId = meta.ownerId;
      project.members = meta.members;
      project.tags = meta.tags;
      project.crash = meta.crash;
      // Config-only serve state on the list (no per-project HTTP probe — that
      // would be N+1 invocations across every project on every list call).
      project.serve = deriveServeState(meta.serve, meta.ports, null);
    }

    projects.push(project);
  }

  return projects;
}

/**
 * Get a single project by slug — O(1) direct container lookup.
 */
export async function getProject(slug: string): Promise<ProjectInfo | null> {
  try {
    const projectSlug = validateProjectSlug(slug);
    const container = docker.getContainer(`wsd-${projectSlug}`);
    const data = await container.inspect();

    const labels = data.Config?.Labels || {};
    if (labels['wsd.managed'] !== 'true') return null;

    const ports: Record<string, string> = {};
    const portBindings = (data.HostConfig?.PortBindings || {}) as Record<string, Array<{ HostPort?: string }>>;
    for (const [priv, bindings] of Object.entries(portBindings)) {
      if (bindings && bindings.length > 0 && bindings[0].HostPort) {
        ports[priv.replace('/tcp', '')] = bindings[0].HostPort;
      }
    }

    const project: ProjectInfo = {
      id: data.Id?.slice(0, 12) || '',
      name: labels['wsd.name'] || projectSlug,
      slug: projectSlug,
      status: data.State?.Running ? 'running' : 'stopped',
      containerId: data.Id || '',
      hostPorts: ports,
      createdAt: labels['wsd.createdAt'],
    };

    const meta = loadMeta(projectSlug);
    if (meta) {
      if (meta.name) project.name = meta.name;
      project.description = meta.description;
      project.image = meta.image;
      project.ports = meta.ports;
      project.limits = meta.limits;
      project.env = meta.env;
      project.activity = meta.activity;
      project.ownerId = meta.ownerId;
      project.members = meta.members;
      project.tags = meta.tags;
      project.crash = meta.crash;
    }

    // Derive live limits from HostConfig (Memory / NanoCpus are set only
    // when a limit was applied at container creation; Docker reports 0 when
    // unlimited).
    const liveLimits: ProjectLimits = {};
    if (typeof data.HostConfig?.Memory === 'number' && data.HostConfig.Memory > 0) {
      liveLimits.memory = formatMemory(data.HostConfig.Memory);
    }
    if (typeof data.HostConfig?.NanoCpus === 'number' && data.HostConfig.NanoCpus > 0) {
      liveLimits.cpu = formatCpu(data.HostConfig.NanoCpus);
    }
    project.liveLimits = Object.keys(liveLimits).length ? liveLimits : undefined;

    // Serve state on single-project detail: probe the live HTTP endpoint when
    // the config enables serve AND the container is running, so the UI gets an
    // honest `active` (the cheap list path is config-only).
    const serveMeta = meta?.serve;
    if (serveMeta) {
      const running = Boolean(data.State?.Running);
      if (serveMeta.enabled && running) {
        const hostPort =
          serveMeta.port !== undefined && meta?.ports?.includes(serveMeta.port)
            ? serveMeta.port
            : meta?.ports?.[0];
        const probe =
          hostPort !== undefined ? await probeServe(projectSlug, hostPort) : null;
        project.serve = deriveServeState(serveMeta, meta?.ports, probe);
      } else {
        project.serve = deriveServeState(serveMeta, meta?.ports, null);
      }
    }

    return project;
  } catch {
    return null;
  }
}

/**
 * Start a stopped project container.
 */
export async function startProject(slug: string, userId?: string): Promise<ProjectInfo> {
  const projectSlug = validateProjectSlug(slug);
  await requireContainer(projectSlug);
  const container = docker.getContainer(`wsd-${projectSlug}`);
  await container.start();
  // An explicit start clears any prior crash and the requestedStop marker the
  // detector uses to tell intentional stops apart from crashes.
  clearCrashState(projectSlug);
  touchActivity(projectSlug, 'started', userId);
  // Re-run the static-site serve process now that the container is back up.
  // Never throws — a failed serve must not break the start.
  await ensureServeRunning(projectSlug).catch((e) =>
    console.warn(`[serve] could not start for '${projectSlug}' during start:`, e?.message || e)
  );
  const info = await getProject(projectSlug);
  if (!info) throw new HttpError(500, 'Project not found after start');
  info.status = 'running';
  dispatchWebhook('started', {
    event: 'started',
    slug: projectSlug,
    name: loadMeta(projectSlug)?.name || projectSlug,
    at: new Date().toISOString(),
  });
  // Status changed — force the next project-list read to rebuild.
  invalidateProjectsCache();
  return info;
}

/**
 * Stop a running project container.
 */
export async function stopProject(slug: string, userId?: string): Promise<ProjectInfo> {
  const projectSlug = validateProjectSlug(slug);
  await requireContainer(projectSlug);
  // Mark the stop as INTENTIONAL *before* the container exits, so a crash
  // sweep racing the stop can never classify this graceful shutdown as a
  // crash (both are synchronous on the event loop, but the sweep may already
  // hold an inspect promise).
  markRequestedStop(projectSlug);
  const container = docker.getContainer(`wsd-${projectSlug}`);
  await container.stop();
  touchActivity(projectSlug, 'stopped', userId);
  const info = await getProject(projectSlug);
  if (!info) throw new HttpError(500, 'Project not found after stop');
  info.status = 'stopped';
  dispatchWebhook('stopped', {
    event: 'stopped',
    slug: projectSlug,
    name: loadMeta(projectSlug)?.name || projectSlug,
    at: new Date().toISOString(),
  });
  // Status changed — force the next project-list read to rebuild.
  invalidateProjectsCache();
  return info;
}

/**
 * Remove a project entirely: container, meta store AND its workspace files
 * from disk. opencode session cleanup is best-effort (non-fatal).
 */
export async function removeProject(slug: string): Promise<void> {
  const projectSlug = validateProjectSlug(slug);
  await requireContainer(projectSlug);
  const removedMeta = loadMeta(projectSlug);
  const container = docker.getContainer(`wsd-${projectSlug}`);
  await container.remove({ force: true });
  deleteMeta(projectSlug);
  removeWorkspaceDir(projectSlug);
  unregisterOpencodeProject(projectSlug);
  purgeOpencodeProjectRows([projectSlug]);
  // The project's auto channel dies with it (messages + uploads reclaimed).
  try {
    await deleteChannel(`project:${projectSlug}`);
  } catch (e: any) {
    console.warn(`[chat] could not delete auto channel for '${projectSlug}':`, e?.message || e);
  }
  dispatchWebhook('deleted', {
    event: 'deleted',
    slug: projectSlug,
    name: removedMeta?.name || projectSlug,
    at: new Date().toISOString(),
  });
  // If the workspace dir could not be fully removed (busy files, partial
  // failure), archive the leftover NOW instead of letting it haunt
  // code-server/opencode until the next periodic sweep.
  try {
    runSweep();
  } catch {
    /* non-fatal */
  }
  // The project no longer exists — drop any cached project list.
  invalidateProjectsCache();
}

/**
 * Delete a workspace directory from disk — path-escape guarded, and failures
 * are non-fatal (the janitor archives any leftover on its next sweep).
 */
function removeWorkspaceDir(slug: string): void {
  try {
    const root = path.resolve(WORKSPACES_ROOT);
    const dir = path.resolve(root, slug);
    if (dir !== root && !dir.startsWith(root + path.sep)) return;
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* janitor archives leftovers */
  }
}

/**
 * Get a project container's logs.
 */
export async function projectLogs(slug: string, tail = 200): Promise<string> {
  const projectSlug = validateProjectSlug(slug);
  await requireContainer(projectSlug);
  const container = docker.getContainer(`wsd-${projectSlug}`);
  const logs = await container.logs({ stdout: true, stderr: true, tail });
  return logs.toString('utf8');
}

export { WORKSPACES_ROOT, BASE_IMAGE };

// ── Extended project capabilities ────────────────────────────

export interface ProjectStats {
  running: boolean;
  cpuPct: number;
  memBytes: number;
  memLimit: number;
  memPct: number;
  startedAt: string | null;
}

/** One-shot container stats (CPU %, memory) + uptime from inspect. */
export async function getProjectStats(slug: string): Promise<ProjectStats> {
  const projectSlug = validateProjectSlug(slug);
  await requireContainer(projectSlug);
  const container = docker.getContainer(`wsd-${projectSlug}`);
  const [stats, inspect] = await Promise.all([
    container.stats({ stream: false }) as unknown as any,
    container.inspect(),
  ]);

  const cpuDelta =
    (stats.cpu_stats?.cpu_usage?.total_usage || 0) -
    (stats.precpu_stats?.cpu_usage?.total_usage || 0);
  const sysDelta =
    (stats.cpu_stats?.system_cpu_usage || 0) -
    (stats.precpu_stats?.system_cpu_usage || 0);
  const cpuCount = stats.cpu_stats?.online_cpus || 1;
  const cpuPct = sysDelta > 0 ? (cpuDelta / sysDelta) * cpuCount * 100 : 0;

  const memBytes = stats.memory_stats?.usage || 0;
  const memLimit = stats.memory_stats?.limit || 0;
  const memPct = memLimit > 0 ? (memBytes / memLimit) * 100 : 0;

  return {
    running: Boolean(inspect?.State?.Running),
    cpuPct: Math.round(cpuPct * 10) / 10,
    memBytes,
    memLimit,
    memPct: Math.round(memPct * 10) / 10,
    startedAt: inspect?.State?.StartedAt || null,
  };
}

export interface PortHealth {
  port: string;
  hostPort: string;
  status: 'open' | 'refused' | 'timeout' | 'error';
  httpCode: number | null;
  ms: number;
}

/** Probe each published host port over HTTP from inside the control container. */
export async function checkProjectPorts(slug: string): Promise<PortHealth[]> {
  const project = await requireContainer(slug);
  if (!project.hostPorts || Object.keys(project.hostPorts).length === 0) return [];

  const results: PortHealth[] = [];
  for (const [priv, pub] of Object.entries(project.hostPorts)) {
    const started = Date.now();
    const url = `http://host.docker.internal:${pub}/`;
    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(3000),
      });
      results.push({
        port: priv,
        hostPort: pub,
        status: 'open',
        httpCode: res.status,
        ms: Date.now() - started,
      });
    } catch (err: any) {
      results.push({
        port: priv,
        hostPort: pub,
        status: err?.name === 'TimeoutError' ? 'timeout' : 'refused',
        httpCode: null,
        ms: Date.now() - started,
      });
    }
  }
  return results;
}

/** Stop + recreate a project container from its stored meta (env/image/ports). */
export async function recreateProject(slug: string, userId?: string): Promise<ProjectInfo> {
  const projectSlug = validateProjectSlug(slug);
  const proj = await requireContainer(projectSlug);
  const meta: ProjectMeta = loadMeta(projectSlug) || { activity: [] };

  if (proj.containerId) {
    const c = docker.getContainer(proj.containerId);
    await c.stop().catch(() => {});
    await c.remove({ force: true }).catch(() => {});
  }

  const created = await createProject({
    name: meta.name || proj.name,
    slug: projectSlug,
    description: meta.description,
    image: meta.image,
    ports: meta.ports,
    env: meta.env,
    limits: meta.limits,
  }, userId);

  // createProject already fired 'created'; the recreate gets its own event on
  // top (a genuine teardown + rebuild worth distinguishing in receivers).
  dispatchWebhook('recreated', {
    event: 'recreated',
    slug: projectSlug,
    name: meta.name || proj.name,
    at: new Date().toISOString(),
  });
  // Teardown + rebuild changed status/container — refresh the cached list.
  invalidateProjectsCache();
  return created;
}

export interface UpdatePortsResult {
  project: ProjectInfo;
  needsRecreate: boolean;
}

/**
 * Persist a new published-port set for an existing project. The set is
 * validated, conflict-checked against every other project's claimed ports and
 * Madar's reserved ports (own current set excluded), then written to meta
 * immediately. The live container catches up only on the next explicit
 * "Recreate container" — Docker cannot rebind published ports on a running
 * or stopped container, so `needsRecreate` reports honestly whether the
 * current binding already matches the requested set.
 */
export async function updateProjectPorts(slug: string, requested: number[]): Promise<UpdatePortsResult> {
  const projectSlug = validateProjectSlug(slug);
  const proj = await requireContainer(projectSlug);

  const used = await currentUsedPorts();
  for (const p of proj.ports || []) used.delete(p);
  for (const p of Object.values(proj.hostPorts ?? {}).map(Number)) used.delete(p);
  const taken = requested.filter((p) => used.has(p));
  if (taken.length > 0) {
    const err = new HttpError(409, `Ports already in use: ${taken.join(', ')}`);
    (err as any).taken = taken;
    throw err;
  }

  const meta: ProjectMeta = loadMeta(projectSlug) || { activity: [] };
  meta.ports = requested;
  meta.activity = [
    ...(meta.activity || []),
    { action: 'ports_updated', at: new Date().toISOString() },
  ].slice(-200);
  saveMeta(projectSlug, meta);

  const live = Object.values(proj.hostPorts ?? {})
    .map(Number)
    .sort((a, b) => a - b);
  const want = [...requested].sort((a, b) => a - b);
  const needsRecreate = live.length !== want.length || live.some((p, i) => p !== want[i]);

  return { project: { ...proj, ports: requested }, needsRecreate };
}

export interface UpdateLimitsResult {
  limits: ProjectLimits | undefined;
  needsRecreate: boolean;
}

/**
 * Persist new CPU/memory limits for an existing project. The limits are
 * validated against host capacity, then written to meta immediately. The
 * live container catches up only on the next explicit "Recreate container" —
 * Docker cannot change a running/stopped container's cgroup limits, so
 * `needsRecreate` reports honestly whether the current container already
 * applies the requested set.
 */
export async function updateProjectLimits(slug: string, patch: Partial<ProjectLimits>): Promise<UpdateLimitsResult> {
  const projectSlug = validateProjectSlug(slug);
  const proj = await requireContainer(projectSlug);

  const meta: ProjectMeta = loadMeta(projectSlug) || { activity: [] };
  let merged: ProjectLimits;
  try {
    merged = sanitizeLimitsPatch(patch, meta.limits ?? {});
    await checkCeilings(merged, await getHostInfo());
  } catch (e: any) {
    throw new HttpError(400, e?.message || 'Invalid resource limits');
  }

  meta.limits = isEmptyLimits(merged) ? undefined : merged;
  meta.activity = [
    ...(meta.activity || []),
    { action: 'limits_updated', at: new Date().toISOString() },
  ].slice(-200);
  saveMeta(projectSlug, meta);

  // requireContainer already inspected the container — reuse its liveLimits
  // instead of paying for a second Docker inspect per edit.
  const needsRecreate = !limitsEqual(meta.limits, proj.liveLimits);

  return { limits: meta.limits, needsRecreate };
}

export interface ScriptRunResult {
  exitCode: number | null;
  output: string;
}

/** Run `npm run <script>` inside the project container (must be running). */
export async function runProjectScript(slug: string, script: string): Promise<ScriptRunResult> {
  const projectSlug = validateProjectSlug(slug);
  const proj = await requireContainer(projectSlug);
  if (proj.status !== 'running') throw new HttpError(409, 'Project is stopped. Start it first.');

  const container = docker.getContainer(`wsd-${projectSlug}`);
  const exec = await container.exec({
    Cmd: ['sh', '-lc', `npm run ${script} 2>&1`],
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream: any = await exec.start({ hijack: false });

  let output = '';
  let raw = Buffer.alloc(0);
  await new Promise<void>((resolve) => {
    const onData = (d: Buffer) => {
      // docker stream: [1 byte stream][3 bytes padding][4 byte big-endian len]
      // then payload. Demux by walking frames in case a chunk splits a frame.
      raw = Buffer.concat([raw, d]);
      while (raw.length >= 8) {
        const size = raw.readUInt32BE(4);
        if (raw.length < 8 + size) break;
        output += raw.subarray(8, 8 + size).toString('utf8');
        raw = raw.subarray(8 + size);
      }
      if (output.length > 300000) output = output.slice(-300000);
    };
    stream.on('data', onData);
    stream.on('end', resolve);
    stream.on('error', resolve);
    const timer = setTimeout(() => {
      try {
        stream.destroy();
      } catch {
        /* ignore */
      }
      resolve();
    }, 180000);
    stream.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });

  const info = await exec.inspect().catch(() => null);
  return { exitCode: info?.ExitCode ?? null, output };
}

/** git clone into the project workspace (empty workspace → root, else subdir). */
export async function cloneIntoWorkspace(
  slug: string,
  url: string,
  userId?: string
): Promise<{ target: string; output: string }> {
  const projectSlug = validateProjectSlug(slug);
  const base = path.resolve(WORKSPACES_ROOT, projectSlug);
  if (!fs.existsSync(base)) throw new HttpError(404, `Project workspace '${projectSlug}' not found`);

  const cleanUrl = String(url ?? '').trim();
  const validHttp = /^[a-z][a-z0-9+.-]*:\/\/[^\s]+$/i.test(cleanUrl);
  const validScp = /^[\w.-]+@[\w.-]+:[\w./-]+$/i.test(cleanUrl);
  const validShort = /^[\w.-]+\/[\w.-]+(\.git)?$/.test(cleanUrl);
  if (!validHttp && !validScp && !validShort) {
    throw new HttpError(400, 'Invalid git repository URL');
  }

  const existing = fs.readdirSync(base).filter((f) => f !== '.git');
  let target = existing.length === 0 ? base : path.join(base, repoName(cleanUrl));

  // If we're cloning into the root, the only thing there may be the auto-init
  // .git scaffold (no commits) created for opencode registration — drop it so
  // `git clone` can seed the workspace. Keep any .git that has real history.
  if (target === base && fs.existsSync(path.join(base, '.git'))) {
    let hasCommits = true;
    try {
      hasCommits =
        execFileSync('git', ['-C', base, 'rev-parse', '--verify', 'HEAD'], {
          stdio: 'pipe',
        }).toString().trim().length > 0;
    } catch {
      hasCommits = false;
    }
    if (!hasCommits) {
      fs.rmSync(path.join(base, '.git'), { recursive: true, force: true });
    }
  }

  return new Promise((resolve, reject) => {
    const proc = spawn('git', ['clone', '--depth', '1', '--progress', cleanUrl, target], { cwd: '/' });
    let output = '';
    const onData = (d: Buffer) => {
      output += d.toString('utf8');
      if (output.length > 5000) output = output.slice(-5000);
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    const timer = setTimeout(() => proc.kill('SIGKILL'), 300000);
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        touchActivity(projectSlug, 'cloned', userId);
        resolve({ target: path.relative(base, target).split(path.sep).join('/'), output });
      } else {
        reject(new Error(`git clone failed (exit ${code}): ${output.slice(-2000)}`));
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function repoName(url: string): string {
  const cleaned = url.replace(/\/+$/, '').replace(/\.git$/i, '');
  const name = cleaned.split('/').pop() || cleaned.split(':').pop() || 'repo';
  return name.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80) || 'repo';
}

/** Recursively copy one workspace dir into another (all files, incl. dotfiles). */
function copyWorkspaceTree(srcDir: string, dstDir: string): void {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(dstDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir)) {
    try {
      const s = path.join(srcDir, entry);
      const d = path.join(dstDir, entry);
      const st = fs.statSync(s);
      if (st.isDirectory()) {
        copyWorkspaceTree(s, d);
      } else if (st.isFile()) {
        fs.copyFileSync(s, d);
      }
    } catch {
      /* skip unreadable/broken entries — never fail the duplicate over one file */
    }
  }
}

export interface DuplicateSpec {
  name?: string;
  slug?: string;
  description?: string;
  ports?: number[];
}

/**
 * Duplicate a project: create a brand-new project that inherits the source's
 * image and env, carries over its workspace files, its developer notes and its
 * planning canvas, and gets a fresh meta store with the copying user as owner. Host ports are
 * intentionally NOT inherited (the caller supplies fresh ones) so both
 * containers can run side by side. The new container is provisioned and
 * started just like a normal create.
 */
export async function duplicateProject(
  sourceSlug: string,
  spec: DuplicateSpec = {},
  userId?: string
): Promise<ProjectInfo> {
  const srcSlug = validateProjectSlug(sourceSlug);
  const srcMeta = loadMeta(srcSlug);
  if (!srcMeta) throw new HttpError(404, `Project '${sourceSlug}' not found`);

  const srcDir = path.join(WORKSPACES_ROOT, srcSlug);
  if (!fs.existsSync(srcDir)) {
    throw new HttpError(404, `Project workspace '${sourceSlug}' not found`);
  }

  // Determine the new project's identity (name + slug).
  const name = (spec.name ? String(spec.name).trim() : srcMeta.name || sourceSlug) || sourceSlug;
  const providedSlug = spec.slug ? String(spec.slug).trim().toLowerCase() : '';
  const baseSlug = providedSlug || sanitizeSlug(name);

  // Make sure the derived slug is unique before provisioning anything.
  let newSlug = baseSlug;
  let n = 1;
  while (await getProject(newSlug)) {
    newSlug = `${baseSlug}-${n}`;
    n += 1;
  }

  // Provision the new project (container + empty workspace + fresh meta).
  // It inherits the source's runtime image/env (no host-port conflict —
  // ports are NOT carried over; the caller supplies fresh ones so the two
  // containers can run side by side).
  const created = await createProject({
    name,
    slug: newSlug,
    description: spec.description !== undefined ? String(spec.description).trim() || undefined : srcMeta.description,
    image: srcMeta.image,
    ports: (spec.ports && spec.ports.length > 0) ? spec.ports : undefined,
    env: srcMeta.env,
    limits: srcMeta.limits,
  }, userId);

  // Carry the source workspace files into the new project.
  const dstDir = path.join(WORKSPACES_ROOT, created.slug);
  copyWorkspaceTree(srcDir, dstDir);

  // Carry over the developer notes (ideas/bugs/goals).
  const srcNotes = loadNotes(srcSlug);
  if (srcNotes.items.length > 0) {
    try {
      saveNotes(created.slug, srcNotes);
    } catch {
      /* notes are best-effort — never fail the duplicate over them */
    }
  }

  // Carry over the visual planning canvas (only when the board is non-empty).
  const srcCanvas = loadCanvas(srcSlug);
  if (srcCanvas.nodes.length > 0 || srcCanvas.edges.length > 0) {
    try {
      saveCanvas(created.slug, srcCanvas);
    } catch {
      /* canvas is best-effort — never fail the duplicate over it */
    }
  }

  touchActivity(created.slug, 'duplicated', userId);
  // Workspace files + canvas landed after createProject's own invalidation —
  // refresh once more so the copy's canvasEditedAt is immediately accurate.
  invalidateProjectsCache();

  return created;
}
