/**
 * jwt-secret-core.ts
 * Madar — the pure rule for deciding whether a CONFIGURED JWT signing secret
 * may be used. Import-free (like serve-core / alerts-core / janitor-core) so
 * node --test can load it offline.
 *
 * There is deliberately no acceptable default. A value is either usable or it
 * is refused — never repaired — because the compose fallback used to be the
 * literal `wsd-pro-insecure-default`, which is published in this repository:
 * anyone holding it could mint a dashboard-admin session, and from there the
 * embedded-surface proxy hands out a credential for code-server/opencode,
 * which run as root next to /var/run/docker.sock. A warning banner is not a
 * control; the default itself had to go.
 *
 * Resolution when a value is refused (see jwt-secret.ts): a random secret is
 * generated once and persisted in the data dir, so a fresh install is safe with
 * zero configuration and a restart keeps existing sessions valid.
 */

export const MIN_JWT_SECRET_LENGTH = 32;

const KNOWN_WEAK_SECRETS: ReadonlySet<string> = new Set([
  'wsd-pro-insecure-default',
  'wsd-pro-default-secret-change-me',
  'change-me',
  'changeme',
  'secret',
  'secretkey',
  'jwt-secret',
  'jwtsecret',
  'supersecret',
  'password',
  'your-secret-here',
]);

export type JwtSecretRejection = 'missing' | 'known-weak' | 'too-short';

/**
 * Classify a candidate secret. Returns null when it may be used to sign and
 * verify, otherwise why it was refused. Surrounding whitespace is ignored for
 * the decision (a `.env` line or a file body can carry a stray newline) and the
 * value is compared case-insensitively against the weak list.
 */
export function classifyJwtSecret(value: unknown): JwtSecretRejection | null {
  const candidate = (typeof value === 'string' ? value : '').trim();
  if (!candidate) return 'missing';
  if (KNOWN_WEAK_SECRETS.has(candidate.toLowerCase())) return 'known-weak';
  if (candidate.length < MIN_JWT_SECRET_LENGTH) return 'too-short';
  return null;
}

/** Human-readable reason for a refusal, for the startup banner and logs. */
export function describeJwtSecretRejection(rejection: JwtSecretRejection | null): string {
  switch (rejection) {
    case 'missing': return 'not set';
    case 'known-weak': return 'a value published in the public repository';
    case 'too-short': return `shorter than ${MIN_JWT_SECRET_LENGTH} characters`;
    default: return 'in use';
  }
}
