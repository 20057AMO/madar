/**
 * updates-core.ts
 * Madar — Pure rules for the component-update system (code-server + opencode).
 *
 * Import-free on purpose (node --test loads it directly, mirroring
 * serve-core.ts / alerts-core.ts / janitor-core.ts): zero external or
 * Node built-in imports — just plain types + pure functions, so every rule
 * is deterministically unit-testable without a running server or container.
 */

/* ── Semver helpers ──────────────────────────────────────────────────── */

const SEMVER_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-.*)?$/;

/**
 * Parse a raw semver string into its numeric components.
 * Accepts an optional `v` prefix; prerelease suffixes (`-beta.1`) are
 * stripped — v1 compares only major.minor.patch numerically.
 * Returns `null` when the input is not valid semver (missing components,
 * non-numeric, junk).
 */
export function parseSemver(raw: string): { major: number; minor: number; patch: number } | null {
  if (typeof raw !== 'string') return null;
  const m = SEMVER_RE.exec(raw.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * Numeric comparison of two semver strings.
 * Returns negative when `a < b`, positive when `a > b`, 0 when equal.
 * Prerelease suffixes are ignored in v1 (only major.minor.patch matter).
 * Non-semver input → returns `NaN` so the caller can decide (documented:
 * the caller should guard with `Number.isNaN` or treat `NaN` as "unknown").
 */
export function semverCompare(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return NaN;
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  return pa.patch - pb.patch;
}

/** True when two semver strings are numerically equal (NaN-safe: invalid
 * input never equals anything). Prerelease suffixes are ignored (v1). */
export function semverEquals(a: string, b: string): boolean {
  return semverCompare(a, b) === 0;
}

/* ── Strict npm dist-tag validation ──────────────────────────────────── */

/** Exact published semver: `X.Y.Z` with an optional prerelease. Accepts
 * `1.18.22` and `1.2.3-beta.1`; rejects every injection/spec form npm could
 * surface in a `latest` payload — ranges (`"1.99.0 || 2.0.0"`), dist-tags
 * (`latest`, `next`), `v` prefixes, paths (`../`, `/`) and URLs. A forged
 * range is otherwise accepted by a loose `/(\d+)\./` probe and would reach
 * the npm install argv verbatim. */
const STRICT_PUBLISHER_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** True only for a strict publisher-format version string (see above). */
export function isStrictPublisherVersion(raw: unknown): boolean {
  return typeof raw === 'string' && STRICT_PUBLISHER_VERSION_RE.test(raw.trim());
}

/* ── code-server version parsing ─────────────────────────────────────── */

/**
 * Parse a code-server `--version` string.
 * Real output: `"4.96.4 b7ef8f9... with Code 1.96.4"`.
 * Extracts the first 3-component semver token. Requires exactly 3 numeric
 * components (`4.96` → null; `4.96.4` → `'4.96.4'`).
 * Multi-line input is supported — takes the first valid line.
 */
export function parseCliVersion(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const lines = raw.split('\n');
  for (const line of lines) {
    const tokens = line.split(/\s+/);
    for (const tok of tokens) {
      const sv = parseSemver(tok);
      if (sv) {
        return `${sv.major}.${sv.minor}.${sv.patch}`;
      }
    }
  }
  return null;
}

/* ── GitHub release parsing ──────────────────────────────────────────── */

/** Known arch → Debian architecture mapping. */
const ARCH_MAP: Record<string, string> = { x64: 'amd64', arm64: 'arm64' };

/** Build the expected .deb filename for a given version + arch. */
export function assetDebName(version: string, arch: string): string {
  const debArch = ARCH_MAP[arch];
  if (!debArch) throw new Error(`Unsupported architecture: ${arch}`);
  return `code-server_${version}_${debArch}.deb`;
}

/** Shape we expect from a GitHub release asset. */
interface GhAsset {
  name?: string;
  browser_download_url?: string;
  digest?: string; // e.g. "sha256:<hex>"
  size?: number;
}

/** Shape we expect from the GitHub releases/latest response (subset). */
interface GhRelease {
  tag_name?: string;
  assets?: GhAsset[];
}

/**
 * Parse a GitHub releases/latest response for code-server.
 * Returns the version (without `v` prefix), the .deb download URL, and the
 * optional SHA-256 digest. Returns `null` on any parsing failure.
 */
export function parseCodeServerRelease(
  json: unknown,
  arch: string
): { version: string; debUrl: string; digest: string | null } | null {
  if (!json || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;
  if (typeof obj.tag_name !== 'string') return null;

  const version = parseCliVersion(obj.tag_name);
  if (!version) return null;

  const assets = obj.assets;
  if (!Array.isArray(assets)) return null;

  const expectedName = assetDebName(version, arch);
  for (const asset of assets) {
    if (!asset || typeof asset !== 'object') continue;
    const a = asset as Record<string, unknown>;
    if (a.name === expectedName && typeof a.browser_download_url === 'string') {
      let digest: string | null = null;
      if (typeof a.digest === 'string' && a.digest.startsWith('sha256:')) {
        digest = a.digest;
      }
      return { version, debUrl: a.browser_download_url, digest };
    }
  }
  return null;
}

/* ── Checksum ────────────────────────────────────────────────────────── */

/**
 * Constant-time-ish hex comparison for SHA-256 digests.
 * `expected` null → false (no verification = no pass).
 * `actualHex` is normalised to lowercase before comparison.
 */
export function checksumMatches(actualHex: string, expected: string | null): boolean {
  if (expected === null || expected === undefined) return false;
  const a = actualHex.toLowerCase();
  const b = expected.toLowerCase();
  if (a.length !== b.length) return false;
  return a === b;
}

/* ── Compatibility gate ──────────────────────────────────────────────── */

export interface CompatGateOpts {
  current: string;
  target: string;
  arch: string;
  maxBytes: number;
  debSizeBytes?: number;
}

export interface CompatGateResult {
  ok: boolean;
  reason?: string;
}

/**
 * Pre-flight check before starting a download/install.
 * Rejects: unsupported arch, target not strictly newer, .deb too large.
 */
export function compatGate(opts: CompatGateOpts): CompatGateResult {
  if (!ARCH_MAP[opts.arch]) {
    return { ok: false, reason: 'unsupported-arch' };
  }
  const cmp = semverCompare(opts.target, opts.current);
  if (Number.isNaN(cmp) || cmp <= 0) {
    return { ok: false, reason: 'not-newer' };
  }
  if (opts.debSizeBytes !== undefined && opts.debSizeBytes > opts.maxBytes) {
    return { ok: false, reason: 'too-large' };
  }
  return { ok: true };
}

/* ── Free-space gate ─────────────────────────────────────────────────── */

/**
 * Simple disk-space check with a 10 % safety margin.
 * `freeBytes` must cover `neededBytes * 1.1`.
 */
export function freeSpaceGate(freeBytes: number, neededBytes: number): boolean {
  return freeBytes >= neededBytes * 1.1;
}

/* ── Update endpoint safety (transport + host guard) ─────────────────── */

/**
 * Cloud-metadata / link-local hosts that must never be used as update
 * endpoints, mirroring provider-store's `assertFetchableHost` blocklist
 * (providers-detect.ts) — kept import-free here so both update services
 * (code-server + opencode) share the exact same rule.
 */
const BLOCKED_UPDATE_HOSTS = new Set([
  'metadata.goog',
  'metadata.google.internal',
  '100.100.100.200',
]);

/**
 * Wildcard-DNS naming services: a host like `169.254.169.254.nip.io`
 * resolves to the IP embedded in its subdomain, so the literal hostname
 * checks above would only see the benign-looking suffix while the fetch
 * lands on cloud-metadata / loopback. Cheap suffix blocklist — this round
 * deliberately does NOT resolve DNS, so IPv6/loopback aliasing through other
 * resolvers stays a documented limitation.
 */
const WILDCARD_DNS_SUFFIXES = ['nip.io', 'sslip.io', 'xip.io'];

function isWildcardDnsHost(hostname: string): boolean {
  return WILDCARD_DNS_SUFFIXES.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
  );
}

/**
 * Validate an update fetch base (env-configured mirror OR a download URL
 * extracted from a GitHub release response) before any fetch reaches it.
 *
 *  - Transport: `https:` is mandatory. Plain `http:` is only admitted under
 *    `WSD_TESTING=1` so the container test suites can point the components at
 *    a local mock server (host.docker.internal) — a production mirror that
 *    downgrades to plaintext is refused loudly, never silently accepted.
 *  - Host: the same cloud-metadata blocklist as provider endpoints
 *    (`169.254.x`, `metadata.google.internal`, …) — a hostile GitHub
 *    response must not be able to redirect the downloader at metadata.
 *
 * Returns the trimmed base URL. Throws a clear Error naming the env var so a
 * misconfigured mirror fails loudly instead of silently fetching over
 * plaintext or at a forbidden host.
 */
export function assertAllowedUpdateBase(
  raw: string,
  envName: string,
  allowInsecureHttp: boolean,
): string {
  const base = (raw || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error(`${envName} must not be empty`);
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(base) ? base : `https://${base}`);
  } catch {
    throw new Error(`${envName} is not a valid URL`);
  }
  if (url.protocol !== 'https:' && !(allowInsecureHttp && url.protocol === 'http:')) {
    throw new Error(
      `${envName} must use https (plain http is only allowed under WSD_TESTING=1)`,
    );
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (
    BLOCKED_UPDATE_HOSTS.has(hostname) ||
    hostname.startsWith('169.254.') ||
    hostname.startsWith('fe80:') ||
    isWildcardDnsHost(hostname)
  ) {
    throw new Error(`${envName} cannot point at this host`);
  }
  // Normalize back to a serialized URL: a bare host without a scheme is
  // upgraded to https here, so the caller never interpolates a scheme-less
  // value into a fetch. Trailing slash dropped for the callers' `${base}/…`
  // composition.
  return url.toString().replace(/\/+$/, '');
}

/** True when the arch has a published .deb asset for code-server. */
export function isSupportedArch(arch: string): boolean {
  return ARCH_MAP[arch] !== undefined;
}

/* ── Deb filename safety ─────────────────────────────────────────────── */

const SAFE_DEB_RE = /^code-server_\d+\.\d+\.\d+_(amd64|arm64)\.deb$/;

/**
 * Guard against traversal / injection in .deb filenames before saving to
 * disk. Returns `true` when the name matches the strict expected pattern.
 */
export function assertSafeDebName(name: string): boolean {
  return SAFE_DEB_RE.test(name);
}

/* ── Apply state machine ─────────────────────────────────────────────── */

export type ApplyState =
  | 'idle'
  | 'downloading'
  | 'verifying'
  | 'installing'
  | 'restarting'
  | 'verifying-boot'
  | 'ok'
  | 'failed'
  | 'rollback';

export type ApplyEvent =
  | 'start'
  | 'downloaded'
  | 'verified'
  | 'installed'
  | 'restarted'
  | 'boot-ok'
  | 'boot-fail'
  | 'error'
  | 'rollback-ok'
  | 'rollback-fail'
  | 'reset';

/**
 * Pure transition table for the update-apply lifecycle.
 *
 * Legal transitions (every unlisted pair throws — strictness surfaces bugs
 * early):
 *
 *   idle          → start         → downloading
 *   downloading   → downloaded    → verifying      | error → failed
 *   verifying     → verified      → installing     | error → failed
 *   installing    → installed     → restarting     | error → failed
 *   restarting    → restarted     → verifying-boot | error → failed
 *   verifying-boot→ boot-ok       → ok             | boot-fail → rollback
 *   rollback      → rollback-ok   → failed         | rollback-fail → failed | error → failed
 *   failed        → reset         → idle
 *   ok            → reset         → idle
 *   (any)         → reset         → idle
 *   (any)         → error         → failed  [only from execution states]
 *
 * `reset` from ANY state → `idle`.
 * `error` from any execution state (not idle/ok/failed) → `failed`.
 * `boot-fail` only valid from `verifying-boot` → `rollback`.
 * `rollback-ok` from `rollback` → `failed` (update did not succeed even
 *   though rollback was clean — the caller stores `rolledBack: true`
 *   alongside the `failed` state).
 */
export function applyStateMachine(current: ApplyState, event: ApplyEvent): ApplyState {
  if (event === 'reset') return 'idle';

  if (event === 'error') {
    const execStates: ApplyState[] = [
      'downloading', 'verifying', 'installing', 'restarting', 'verifying-boot', 'rollback',
    ];
    if (execStates.includes(current)) return 'failed';
    throw new Error(`Cannot apply 'error' from state '${current}'`);
  }

  switch (current) {
    case 'idle':
      if (event === 'start') return 'downloading';
      break;
    case 'downloading':
      if (event === 'downloaded') return 'verifying';
      break;
    case 'verifying':
      if (event === 'verified') return 'installing';
      break;
    case 'installing':
      if (event === 'installed') return 'restarting';
      break;
    case 'restarting':
      if (event === 'restarted') return 'verifying-boot';
      break;
    case 'verifying-boot':
      if (event === 'boot-ok') return 'ok';
      if (event === 'boot-fail') return 'rollback';
      break;
    case 'rollback':
      if (event === 'rollback-ok') return 'failed';
      if (event === 'rollback-fail') return 'failed';
      break;
    case 'ok':
    case 'failed':
      // Only reset is allowed from terminal states.
      break;
  }
  throw new Error(`Invalid transition: '${current}' + '${event}'`);
}

/* ── Fresh apply-state seeding ─────────────────────────────────────────── */

export interface ApplyStateSnapshot {
  applyState: ApplyState;
  currentVersion?: string;
  targetVersion?: string;
  error?: string;
  rolledBack?: boolean;
  startedAt?: string;
  updatedAt?: string;
}

export function freshApplyState(prev: ApplyStateSnapshot): { applyState: ApplyState } {
  return { applyState: applyStateMachine(prev.applyState, 'reset') };
}
