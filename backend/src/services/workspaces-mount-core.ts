/**
 * workspaces-mount-core.ts
 * Madar — PURE rules for recovering the host-side path of the /workspaces
 * bind mount and for naming its failures.
 *
 * Import-free on purpose (node --test loads it directly, mirroring
 * serve-core.ts / alerts-core.ts / janitor-core.ts / snapshots-schedule.ts /
 * activity-core.ts): no fs, no dockerode, no process.env side effects. Every
 * input (env value, mountinfo text, fs error) is injected, so the decoder is
 * deterministically unit-testable without a container.
 *
 * WHY THIS EXISTS: docker-manager launches every project container with an
 * explicit absolute bind source, and the Docker daemon resolves that string on
 * the DOCKER DESKTOP VM — not inside this container. The value used to come from
 * WSD_WORKSPACES_HOST_DIR, defaulted by compose to "${PWD}/workspaces". ${PWD} is
 * an INHERITED SHELL variable, never a value compose computes: it is absent in
 * cmd/PowerShell and, when present, it is whatever the checkout was named when
 * the env was baked. Rename the folder and the value goes stale — a stale value
 * still "works" (docker happily mounts SOME directory), so every project file
 * becomes invisible instead of erroring.
 *
 * The kernel, however, always knows the truth: /proc/self/mountinfo records the
 * bind source the daemon actually resolved. Live line on Docker Desktop/Windows:
 *
 *   898 889 0:71 /Work/madar/workspaces /workspaces rw,noatime - 9p D:\134
 *   rw,aname=drvfs;path=D:\;symlinkroot=/mnt/host/
 *
 * Decoding `aname=drvfs;path=D:\` (the mount point's position on the Windows
 * drive) plus the `root` field (the sub-path inside that drive) yields
 * `D:\Work\madar\workspaces` — byte-for-byte the value the stale env carried,
 * which is the proof the decoder is right. A derivation cannot go stale after a
 * move: the kernel reports where the mount really is.
 */

/** One /proc/self/mountinfo record, already split into its stable fields. */
export interface MountinfoEntry {
  /** Field 4 — the subtree root of this mount inside its source filesystem. */
  root: string;
  /** Field 5 — where it is mounted inside this container. */
  mountPoint: string;
  /** Post-'-' segment: the filesystem type (9p, virtiofs, ext4, overlay, …). */
  fsType: string;
  /** Post-'-' segment: the mount source (device, volume name, share tag). */
  source: string;
  /** Final field: the super-block options (aname/path/symlinkroot/master:…). */
  superOpts: string;
}

/** Why a host path could not be recovered. */
export type MountDecodeReason = 'named_volume' | 'root_fs' | 'unresolved_source';

/** How a host path was recovered. */
export type MountSource = 'env' | 'mountinfo';

/** Result of decoding one mount record. */
export type DecodedBind =
  | { ok: true; hostPath: string; kind: 'windows-9p' | 'posix' }
  | { ok: false; reason: MountDecodeReason };

/** Why the physical check failed (fs error codes, not decode rules). */
export type MountIoReason = 'no_such_directory' | 'not_a_directory' | 'unreadable' | 'not_writable' | 'canary_mismatch';

/** Anything that can explain a broken mount, for the status payload + hints. */
export type MountReason = MountDecodeReason | MountIoReason | 'no_mount_entry';

/** The honest verdict on the bind mount. */
export type WorkspaceMountState = 'ok' | 'missing' | 'not_a_directory' | 'unreadable' | 'unresolved';

/**
 * Did a probe container agree that the decoded host path is the directory this
 * app container writes to? Ternary on purpose: 'unknown' is a real answer
 * (verification disabled or unavailable) and must never be reported as 'proved',
 * nor treated as breakage.
 */
export type MountVerification = 'proved' | 'refuted' | 'unknown';

/** Why project creation must be refused, in the order the rules apply. */
export type MountRefusalCode = 'unresolvable' | 'broken' | 'refuted';

/** Full operator-facing mount description, surfaced by both status routes. */
export interface WorkspaceMountInfo {
  state: WorkspaceMountState;
  /** Host-side absolute bind source, or null when it could not be recovered. */
  hostPath: string | null;
  source: MountSource | null;
  reason: MountReason | null;
  /** ONE operator-facing sentence naming the real cause, safe to render. */
  hint: string;
  checkedAt: string;
  /**
   * Did a probe container see the same directory the app container writes?
   * Ternary on purpose: 'unknown' is a real answer (verification disabled or
   * unavailable) and must never be reported as 'proved'.
   */
  verification: MountVerification;
}

/** Placeholder the non-privileged view carries instead of the absolute path. */
export const HOST_PATH_REDACTED = '<redacted>';

/** Name of the writability canary, written at the ROOT of the workspaces dir. */
export const MOUNT_CANARY_FILE = '.madar-mount-canary';

/**
 * Name of the PROBE canary, deliberately distinct from MOUNT_CANARY_FILE.
 *
 * physicalCheck() unlinks its own canary in a `finally`, and it is fully
 * synchronous — so it can run (a MOUNT_AUDIT_MS cache expiry, or the sweep tick)
 * while a verification probe sits in its `await` between writing the canary and
 * the probe container starting. With ONE shared name that audit deleted the
 * file the probe was about to look for, `test -f` exited 1, and the verdict was
 * recorded as 'refuted' — which (since the creation gate landed) refuses every
 * project create with an alarming 500 against a mount that was never broken.
 * Two names make that interleaving structurally impossible.
 */
export const MOUNT_VERIFY_CANARY_FILE = '.madar-mount-verify-canary';

// ── /proc/self/mountinfo parsing ──────────────────────────────────────────

/** Split a mountinfo line on whitespace and split off the post-'-' segment. */
function parseLine(line: string): MountinfoEntry | null {
  const fields = line.trim().split(/\s+/).filter(Boolean);
  if (fields.length < 7) return null;
  const sep = fields.indexOf('-');
  // The optional fields end with a bare '-', so a separator is mandatory, and at
  // least fsType + source + superOptions must follow it.
  if (sep < 6 || fields.length < sep + 4) return null;
  return {
    root: fields[3],
    mountPoint: fields[4],
    fsType: fields[sep + 1],
    source: fields[sep + 2],
    superOpts: fields[fields.length - 1],
  };
}

/**
 * Every record of a mountinfo dump, malformed lines skipped. A single garbage
 * line must never cost us the whole mount table.
 */
export function parseMountinfo(text: string): MountinfoEntry[] {
  const out: MountinfoEntry[] = [];
  for (const line of String(text ?? '').split('\n')) {
    const entry = parseLine(line);
    if (entry) out.push(entry);
  }
  return out;
}

/**
 * The kernel escapes the four characters that would break its whitespace-
 * separated field format, in EVERY path field of mountinfo: space `\040`, tab
 * `\011`, newline `\012`, backslash `\134`. A checkout under
 * `C:\Users\First Last\` is therefore reported as `/Users/First\040Last/`, and
 * building a host path without undoing that yields a path that does not exist —
 * the very regression this module exists to prevent.
 *
 * Only these four codes are decoded (a single left-to-right pass, so an escaped
 * backslash cannot re-open an escape sequence); any other `\NNN` is literal text.
 */
/** The kernel's escape vocabulary, mapped back to the character it stands for. */
const MOUNTINFO_UNESCAPE: Record<string, string> = {
  '\\040': ' ',
  '\\011': '\t',
  '\\012': '\n',
  '\\134': '\\',
};

export function unescapeMountinfoField(value: string): string {
  return String(value ?? '').replace(/\\(?:040|011|012|134)/g, (esc) => MOUNTINFO_UNESCAPE[esc]);
}

/** Exact mount-point match. Duplicated mount points are not a thing here. */
export function pickMount(entries: MountinfoEntry[], mountPoint: string): MountinfoEntry | null {
  if (!mountPoint) return null;
  return entries.find((e) => unescapeMountinfoField(e.mountPoint) === mountPoint) || null;
}

// ── bind-source decoding ──────────────────────────────────────────────────

/** Filesystems whose `root` field is a real host path rather than a container path. */
const REAL_FS = /^(ext4|xfs|btrfs|zfs|overlay|virtiofs|9p|nfs|fuse\..*)$/;

/** Docker's volume roots — a `root` under one of these is NOT a host bind path. */
const VOLUME_ROOT = /^\/(var\/lib\/docker\/volumes|data\/docker\/volumes)(\/|$)/;

/** Docker Desktop's Windows-share marker: `aname=drvfs;path=D:\`. */
const DRVFS = /aname=drvfs;path=([A-Za-z]:)[\\/]/;

/** virtiofs / gRPC-FUSE expose a Windows drive as a leading `/c`-style segment. */
const DRIVE_SEGMENT = /^\/([a-zA-Z])(?=\/|$)/;

/** A volume is either explicitly shared (master:) or rooted in docker/volumes. */
function looksLikeVolume(entry: MountinfoEntry, root: string): boolean {
  return (
    entry.superOpts.includes('master:') ||
    VOLUME_ROOT.test(root) ||
    VOLUME_ROOT.test(unescapeMountinfoField(entry.mountPoint))
  );
}

/**
 * Recover the host path the daemon resolved for one bind mount, or explain why
 * it cannot. Rules, first match wins:
 *
 *  1. `aname=drvfs;path=D:\` → drive letter + `root` (VERIFIED on live hardware).
 *  2. virtiofs / `symlinkroot=/host_mnt` → promote a leading `/c` segment to `C:/`
 *     (NOT verified on hardware — a shape that does not match degrades to
 *     'unresolved_source' below, never to a guess).
 *  3. a real filesystem, a non-root `root`, and no shared mount → `root` is the
 *     host path (the Linux bind-mount case).
 *  4. shared/volume-shaped mount → 'named_volume' (a volume name is not a path).
 *  5. `root === '/'` → the container's own filesystem, not a bind.
 *  6. anything else → 'unresolved_source'.
 *
 * The subtree root is kernel-unescaped (`\040` → space, …) before any rule reads
 * it, so a path with a space decodes to the directory that actually exists.
 */
export function decodeBindSource(entry: MountinfoEntry): DecodedBind {
  // Decoded ONCE here, before any path construction: every rule below that reads
  // the subtree root must see real characters, never the kernel's `\040` escapes.
  const root = unescapeMountinfoField(String(entry?.root ?? ''));

  const drvfs = DRVFS.exec(String(entry?.superOpts ?? ''));
  if (drvfs) {
    const drive = drvfs[1].toUpperCase();
    const rest = root.replace(/^\/+/, '').replace(/\//g, '\\');
    return { ok: true, hostPath: rest ? `${drive}\\${rest}` : `${drive}\\`, kind: 'windows-9p' };
  }

  const virtiofs =
    entry?.fsType === 'virtiofs' || String(entry?.superOpts ?? '').includes('symlinkroot=/host_mnt');
  if (virtiofs) {
    const seg = DRIVE_SEGMENT.exec(root);
    if (seg) {
      const rest = root.replace(/^\/[a-zA-Z]/, '').replace(/^\/+/, '');
      return { ok: true, hostPath: `${seg[1].toUpperCase()}:/${rest}`, kind: 'posix' };
    }
    // A virtiofs/symlinkroot entry WITHOUT a drive segment is the unverified
    // shape, and rule 3 would read its root as a real host path. Refuse instead.
    return { ok: false, reason: 'unresolved_source' };
  }

  if (REAL_FS.test(String(entry?.fsType ?? '')) && root !== '/' && !looksLikeVolume(entry, root)) {
    return { ok: true, hostPath: root, kind: 'posix' };
  }

  if (looksLikeVolume(entry, root)) return { ok: false, reason: 'named_volume' };
  if (root === '/') return { ok: false, reason: 'root_fs' };
  return { ok: false, reason: 'unresolved_source' };
}

// ── fs error classification ───────────────────────────────────────────────

/** Map a Node fs error onto the state vocabulary. Unknown codes stay honest. */
export function classifyMountError(err: unknown): MountIoReason {
  const code = String((err as { code?: unknown } | null | undefined)?.code ?? '');
  if (code === 'ENOENT') return 'no_such_directory';
  if (code === 'ENOTDIR') return 'not_a_directory';
  if (code === 'EACCES' || code === 'ESTALE' || code === 'ENODEV' || code === 'EPERM') return 'unreadable';
  return 'unreadable';
}

// ── the single decision function ──────────────────────────────────────────

/** Strip trailing separators, but never eat a bare drive/posix root. */
function trimTrailingSeparators(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, '');
  if (trimmed === '' || /^[A-Za-z]:$/.test(trimmed)) return value;
  return trimmed;
}

export interface ResolveHostDirInput {
  /** Raw WSD_WORKSPACES_HOST_DIR (an explicit override always wins). */
  envValue?: string | null;
  /** Raw /proc/self/mountinfo contents. */
  mountinfoText?: string | null;
  /** In-container mount point, default '/workspaces'. */
  mountPoint?: string;
}

export interface ResolvedHostDir {
  hostPath: string | null;
  source: MountSource | null;
  reason: MountReason | null;
}

/**
 * THE decision: an explicit non-empty env override wins (back-compat for
 * operators on UNC / WSL-distro paths), otherwise derive from mountinfo, and
 * otherwise report why not. An unset env value now DERIVES instead of degrading
 * to the string '/workspaces', which is what made a stale mount look plausible.
 */
export function resolveHostDir(input: ResolveHostDirInput): ResolvedHostDir {
  const envValue = trimTrailingSeparators(String(input?.envValue ?? '').trim());
  if (envValue) return { hostPath: envValue, source: 'env', reason: null };

  const entries = parseMountinfo(String(input?.mountinfoText ?? ''));
  const entry = pickMount(entries, String(input?.mountPoint ?? '/workspaces'));
  if (!entry) return { hostPath: null, source: null, reason: 'no_mount_entry' };

  const decoded = decodeBindSource(entry);
  if (!decoded.ok) return { hostPath: null, source: null, reason: decoded.reason };
  return { hostPath: trimTrailingSeparators(decoded.hostPath), source: 'mountinfo', reason: null };
}

// ── creation gate ──────────────────────────────────────────────────────────

/**
 * May a project container be created on this verdict? Returns the refusal code
 * or null. A wrong bind source is the silent failure class this whole module
 * exists for, so all three are refusals:
 *
 *  - 'unresolvable' — no host path at all: dockerode would hand the daemon a
 *    string that is not a path (and the daemon resolves it on ITS host).
 *  - 'broken'       — the mount this app container writes through does not work.
 *  - 'refuted'      — the probe container looked at the decoded host path and
 *    did NOT see the canary this container wrote, which is positive knowledge
 *    that the daemon mounts a different directory than the one we audited.
 *
 * 'unknown' stays PERMISSIVE: an unavailable probe (no docker binary, daemon
 * down, timeout) is an absence of proof, never a refutation, and refusing on it
 * would take a healthy install offline whenever Docker hiccups.
 */
export function mountRefusalCode(input: {
  hostPath: string | null;
  state: WorkspaceMountState;
  verification: MountVerification;
}): MountRefusalCode | null {
  if (!input?.hostPath) return 'unresolvable';
  if (input.state !== 'ok') return 'broken';
  if (input.verification === 'refuted') return 'refuted';
  return null;
}

// ── host-path proof (probe argv + exit-code mapping) ───────────────────────

/**
 * The probe container's argv, built from ONE canary name so the file the
 * verification writes and the path the probe looks for can never drift apart
 * (a rename in one place only is exactly the regression MOUNT_VERIFY_CANARY_FILE
 * exists to prevent). No shell is involved: the args go to execFile as an array.
 */
export function buildProbeArgv(
  hostPath: string,
  image: string,
  canaryFile: string = MOUNT_VERIFY_CANARY_FILE,
): string[] {
  return ['run', '--rm', '-v', `${hostPath}:/probe`, image, 'test', '-f', `/probe/${canaryFile}`];
}

/**
 * The probe's exit code, read off a child_process error.
 *
 * Node's execFile error carries the exit status on `code` and has NO `status`
 * key at all, so a mapping that reads `err.status === 1` is silently dead — every
 * refutation degraded to 'unknown' and the strongest creation-gate signal never
 * fired. `status` is kept as a fallback for a spawn-style error object.
 */
export function probeExitCode(err: unknown): number | null {
  const e = (err ?? {}) as { code?: unknown; status?: unknown };
  const raw = typeof e.code === 'number' ? e.code : typeof e.status === 'number' ? e.status : null;
  return raw === null ? null : raw;
}

/**
 * What a probe run proves. Only the probe's OWN failure code refutes the path:
 * `test -f` exiting 1 means the container saw the mounted directory WITHOUT our
 * canary. Docker reserves 125+ for "could not run the container" (daemon down,
 * image missing, bad mount) and a ceiling kill leaves no code at all — both are
 * the absence of an answer, never a refutation, so they stay 'unknown' (which
 * the creation gate deliberately treats as permissive).
 */
export function probeVerdictFor(exitCode: number | null | undefined, ok: boolean): MountVerification {
  if (ok) return 'proved';
  return exitCode === 1 ? 'refuted' : 'unknown';
}

/**
 * What a SECOND, independent look decides. A refuted verdict is persisted and now
 * refuses every project create, so one observation must never be able to take the
 * app down: a bind mount can hide a just-written file for a moment (attribute
 * caching, an indexer touching the directory), and a single such miss would
 * otherwise read as positive knowledge. Two consecutive refutations of two
 * FRESH canaries are knowledge; anything else degrades to the permissive answer.
 */
export function confirmProbeVerdict(
  first: MountVerification,
  second: MountVerification,
): MountVerification {
  if (second === 'proved') return 'proved';
  return first === 'refuted' && second === 'refuted' ? 'refuted' : 'unknown';
}

// ── hints + canary ────────────────────────────────────────────────────────

/**
 * One operator-facing sentence per failure, safe to render verbatim. Names the
 * real cause (and never a credential — the raw status bodies are asserted to
 * contain no secret-bearing word at all).
 */
export function mountHint(
  state: WorkspaceMountState,
  reason: MountReason | null,
  hostPath: string | null,
  mountPoint: string,
): string {
  switch (state) {
    case 'ok':
      return `The workspaces bind mount is healthy${hostPath ? ` (${hostPath})` : ''}.`;
    case 'missing':
      return (
        `${mountPoint} is not mounted inside the container: the host directory ` +
        'moved or was deleted after the container was created — recreate the app ' +
        'container (docker compose up -d --force-recreate app).'
      );
    case 'not_a_directory':
      return `${mountPoint} is a file, not a directory, so the workspaces bind mount target is wrong.`;
    case 'unreadable':
      return reason === 'not_writable' || reason === 'canary_mismatch'
        ? `${mountPoint} is read-only, so new project files could never be seen again — fix the bind mount permissions on the host.`
        : `${mountPoint} cannot be read by the container — check the bind mount permissions on the host.`;
    case 'unresolved':
    default:
      return (
        `The host path of ${mountPoint} could not be determined (${reason || 'unresolved_source'}); ` +
        'set WSD_WORKSPACES_HOST_DIR in .env to the absolute host path of ./workspaces.'
      );
  }
}

/**
 * The view a caller may see. The status routes are viewer-readable, but the
 * absolute host path of the checkout is operator information (it discloses the
 * machine's directory layout and username), so it is admin-only. Everything that
 * makes the verdict useful stays: the state, the reason, the source, the
 * verification ternary and a hint with the path masked out of its sentence.
 * The input is never mutated — the cached object is shared by every caller.
 */
export function publicMountInfo(info: WorkspaceMountInfo, privileged: boolean): WorkspaceMountInfo {
  if (privileged || !info) return info;
  const hostPath = info.hostPath ? HOST_PATH_REDACTED : null;
  return {
    ...info,
    hostPath,
    hint: info.hostPath ? info.hint.split(info.hostPath).join(HOST_PATH_REDACTED) : info.hint,
  };
}

/**
 * Deterministic canary token, so a test can assert "the probe container saw the
 * exact bytes this container wrote" without importing a crypto module (FNV-1a).
 */
export function canaryToken(seed: string): string {
  let hash = 0x811c9dc5;
  const input = String(seed ?? '');
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `madar-mount-canary-${hash.toString(16).padStart(8, '0')}`;
}
