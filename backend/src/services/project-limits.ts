/**
 * project-limits.ts
 * Madar — Helpers for parsing, validating, and comparing per‑project resource limits.
 *
 * Limits are stored in project meta as canonical strings:
 *   cpu:   "2" (full CPUs) or "500m" (milli‑CPUs)
 *   memory: "128Mi" (MiB) or "1Gi" (GiB) — always expressed in binary units.
 *
 * All limits are optional; `null` means "unlimited" (no HostConfig field).
 */

import Docker from 'dockerode';
import os from 'os';

export interface ProjectLimits {
  cpu?: string | null; // e.g. "2" or "500m"
  memory?: string | null; // e.g. "128Mi" or "1Gi"
}

/** Host capabilities – number of CPUs and total memory (bytes). */
export interface HostInfo {
  cpu: number; // total logical CPUs
  memBytes: number; // total RAM in bytes
}

/** Parse a CPU string → {nano: number, canonical: string}. */
export function parseCpu(value: string | null | undefined): { nano: number; canonical: string } | null {
  if (!value) return null;
  const s = String(value).trim();
  // Accept "2" (full CPUs) or "500m" (milli‑CPUs).
  const full = /^\d+$/.exec(s);
  if (full) {
    const n = Number(full[0]);
    if (!Number.isFinite(n) || n <= 0) throw new Error('CPU must be a positive number');
    return { nano: n * 1e9, canonical: String(n) };
  }
  const milli = /^(\d+)m$/.exec(s);
  if (milli) {
    const n = Number(milli[1]);
    if (!Number.isFinite(n) || n <= 0) throw new Error('CPU must be a positive number');
    // Canonicalize to whole CPUs when it divides evenly, so the string form
    // matches what the live inspector reports (formatCpu(n * 1e6)).
    const canonical = n % 1000 === 0 ? String(n / 1000) : `${n}m`;
    return { nano: n * 1e6, canonical };
  }
  throw new Error('Invalid cpu format – expected integer or <num>m');
}

/** Parse a memory string → {bytes: number, canonical: string}. Supports binary (Mi, Gi) and SI (M, G). */
export function parseMemory(value: string | null | undefined): { bytes: number; canonical: string } | null {
  if (!value) return null;
  const s = String(value).trim().toUpperCase();
  // Binary units
  const binary = /^(\d+)(MI|GI)$/.exec(s);
  if (binary) {
    const n = Number(binary[1]);
    const unit = binary[2];
    const bytes = unit === 'MI' ? n * 1024 ** 2 : n * 1024 ** 3;
    if (!Number.isFinite(bytes)) throw new Error('Memory value too large');
    const canonical = `${n}${unit[0]}${unit[1].toLowerCase()}`; // "128Mi" / "1Gi"
    return { bytes, canonical };
  }
  // SI units — canonicalize to the exact whole-MiB value the live inspector
  // reports (formatMemory), so meta ↔ HostConfig ↔ live round-trips exactly.
  const si = /^(\d+)(M|G)$/.exec(s);
  if (si) {
    const n = Number(si[1]);
    const unit = si[2];
    const bytes = unit === 'M' ? n * 1000 ** 2 : n * 1000 ** 3;
    if (!Number.isFinite(bytes)) throw new Error('Memory value too large');
    return { bytes, canonical: formatMemory(bytes) };
  }
  // Plain number = bytes
  const plain = /^\d+$/.exec(s);
  if (plain) {
    const bytes = Number(plain[0]);
    if (!Number.isFinite(bytes)) throw new Error('Memory value too large');
    return { bytes, canonical: formatMemory(bytes) };
  }
  throw new Error('Invalid memory format – e.g. 128Mi, 1Gi, 500M');
}

/** Merge a partial patch into an existing limits object (or {} if none). */
export function sanitizeLimitsPatch(patch: Partial<ProjectLimits>, current: Partial<ProjectLimits> = {}): ProjectLimits {
  const out: ProjectLimits = {};
  // cpu
  if (Object.prototype.hasOwnProperty.call(patch, 'cpu')) {
    const raw = (patch as any).cpu;
    if (raw === null || raw === undefined || raw === '') {
      out.cpu = undefined;
    } else {
      const parsed = parseCpu(String(raw));
      if (!parsed) throw new Error('Invalid cpu');
      out.cpu = parsed.canonical;
    }
  } else if (current.cpu) {
    out.cpu = current.cpu;
  }
  // memory
  if (Object.prototype.hasOwnProperty.call(patch, 'memory')) {
    const raw = (patch as any).memory;
    if (raw === null || raw === undefined || raw === '') {
      out.memory = undefined;
    } else {
      const parsed = parseMemory(String(raw));
      if (!parsed) throw new Error('Invalid memory');
      out.memory = parsed.canonical;
    }
  } else if (current.memory) {
    out.memory = current.memory;
  }
  return out;
}

/** Compare two limit sets for equality (both undefined → equal). */
export function limitsEqual(a?: ProjectLimits, b?: ProjectLimits): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (a.cpu ?? null) === (b.cpu ?? null) && (a.memory ?? null) === (b.memory ?? null);
}

/** True when a limits object carries no actual constraint (aka "unlimited"). */
export function isEmptyLimits(l?: ProjectLimits): boolean {
  return !l || (!l.cpu && !l.memory);
}

/** Retrieve host capability info (cached for 60 s). */
let cachedHostInfo: HostInfo | null = null;
let hostInfoExpires = 0;
export async function getHostInfo(): Promise<HostInfo> {
  const now = Date.now();
  if (cachedHostInfo && now < hostInfoExpires) return cachedHostInfo;
  const docker = new Docker();
  try {
    const info = await docker.info();
    const cpu = Number(info.NCPU) || os.cpus().length;
    const mem = Number(info.MemTotal) || os.totalmem();
    cachedHostInfo = { cpu, memBytes: mem };
  } catch {
    cachedHostInfo = { cpu: os.cpus().length, memBytes: os.totalmem() };
  }
  hostInfoExpires = now + 60_000; // 1 min cache
  return cachedHostInfo;
}

/**
 * Pure, synchronous ceiling validation — the read-modify-write safe form.
 * A caller that must validate INSIDE a store lock (a synchronous mutator)
 * precomputes the host info and calls this, so the lock is never held across
 * an await (which would let a concurrent sync writer be clobbered).
 */
export function checkCeilingsSync(limits: ProjectLimits, host: HostInfo): void {
  const hi = host;
// CPU caps – default max 4 × host CPUs, min 0.1 CPU (100 m). Exact numbers
  // are logged server-side only — they would leak host capacity to any client.
  if (limits.cpu) {
    const parsed = parseCpu(limits.cpu)!;
    const maxNano = hi.cpu * 4 * 1e9; // oversubscribe up to 4×
    if (parsed.nano > maxNano) {
      console.warn(`[limits] denied cpu ${limits.cpu} (${parsed.nano}ns) > host cap ${maxNano}ns`);
      throw new Error('CPU limit exceeds host capacity');
    }
    if (parsed.nano < 1e8) { // 0.1 CPU
      throw new Error('CPU limit too low (minimum 0.1)');
    }
  }
  if (limits.memory) {
    const parsed = parseMemory(limits.memory)!;
    const maxBytes = Math.floor(hi.memBytes * 0.9); // 90 % of RAM
    if (parsed.bytes > maxBytes) {
      console.warn(`[limits] denied memory ${limits.memory} (${parsed.bytes}B) > host cap ${maxBytes}B`);
      throw new Error('Memory limit exceeds host capacity');
    }
    const minBytes = 32 * 1024 ** 2; // 32 MiB
    if (parsed.bytes < minBytes) {
      throw new Error('Memory limit too low (minimum 32 MiB)');
    }
  }
}

/**
 * Async convenience wrapper — resolves the (cached) host info when the caller
 * does not already hold it. Prefer `checkCeilingsSync` when validating inside a
 * store lock: awaiting here would extend the lock across a tick.
 */
export async function checkCeilings(limits: ProjectLimits, host?: HostInfo): Promise<void> {
  checkCeilingsSync(limits, host ?? (await getHostInfo()));
}

/** Resolve default limits from environment variables, if any. */
export async function resolveDefaultLimits(): Promise<ProjectLimits | undefined> {
  const cpuEnv = process.env.WSD_DEFAULT_CPU;
  const memEnv = process.env.WSD_DEFAULT_MEMORY;
  if (!cpuEnv && !memEnv) return undefined;
  const defaults: Partial<ProjectLimits> = {};
  if (cpuEnv) defaults.cpu = cpuEnv;
  if (memEnv) defaults.memory = memEnv;
  // Validate against host caps.
  const parsed = sanitizeLimitsPatch(defaults);
  await checkCeilings(parsed);
  return parsed;
}

/** Helper to format bytes → canonical binary string (Mi/Gi). */
export function formatMemory(bytes: number): string {
  if (bytes % (1024 ** 3) === 0) return `${bytes / (1024 ** 3)}Gi`;
  if (bytes % (1024 ** 2) === 0) return `${bytes / (1024 ** 2)}Mi`;
  // fallback to Mi with rounding
  return `${Math.ceil(bytes / (1024 ** 2))}Mi`;
}

/** Helper to format nano‑CPUs → canonical string. */
export function formatCpu(nano: number): string {
  if (nano % 1e9 === 0) return `${nano / 1e9}`;
  const milli = Math.round(nano / 1e6);
  return `${milli}m`;
}
