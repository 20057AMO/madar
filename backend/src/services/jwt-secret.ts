/**
 * jwt-secret.ts
 * Madar — the ONE place the JWT signing secret is resolved. Every signer and
 * every verifier reads the memoized value returned here (all seven jwt.sign /
 * jwt.verify call sites live in user-store.ts), so a signer/verifier split is
 * structurally impossible.
 *
 * Precedence:
 *   1. JWT_SECRET from the environment, when classifyJwtSecret() accepts it.
 *   2. The secret persisted at DATA_DIR/jwt.secret (0600, inside the data
 *      volume) — written once on first boot, so sessions survive a restart.
 *   3. A freshly generated random secret, persisted to that same file. A file
 *      that is missing, unreadable, empty or holds a weak/short value is
 *      replaced rather than trusted.
 *   4. If the data dir cannot be written, the generated secret is kept in
 *      memory only: still unforgeable, but sessions do not survive a restart,
 *      which the startup banner says out loud.
 *
 * The data dir is the same one user-store/secret-box use, so the secret lives
 * and dies with the rest of the runtime state (and `*.secret` + `data/` are
 * gitignored — nothing here is ever committed).
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { classifyJwtSecret, type JwtSecretRejection } from './jwt-secret-core';

const DATA_DIR = process.env.WSD_DATA_DIR || '/app/data';
export const JWT_SECRET_FILE = path.join(DATA_DIR, 'jwt.secret');

export interface ResolvedJwtSecret {
  /** The value every signer and verifier must use. */
  secret: string;
  /** 'env' = the operator's value; 'file' = the persisted generated secret; 'memory' = unwritable data dir. */
  source: 'env' | 'file' | 'memory';
  /** Why a configured JWT_SECRET was refused, or null when it was used. */
  envRejection: JwtSecretRejection | null;
  /** Where the persisted secret lives, or null when there is none. */
  path: string | null;
}

let resolved: ResolvedJwtSecret | null = null;

function readPersisted(): string | null {
  try {
    const stored = fs.readFileSync(JWT_SECRET_FILE, 'utf8').trim();
    return classifyJwtSecret(stored) === null ? stored : null;
  } catch {
    return null;
  }
}

function writePersisted(secret: string): boolean {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(JWT_SECRET_FILE, secret + '\n', { mode: 0o600 });
    // writeFileSync only applies `mode` when it CREATES the file; an existing
    // one keeps whatever it had, so tighten it explicitly.
    try { fs.chmodSync(JWT_SECRET_FILE, 0o600); } catch { /* best effort */ }
    return true;
  } catch {
    return false;
  }
}

/** Resolve (once) and return the signing secret plus where it came from. */
export function getJwtSecret(): ResolvedJwtSecret {
  if (resolved) return resolved;

  const configured = process.env.JWT_SECRET;
  const envRejection = classifyJwtSecret(configured);
  if (envRejection === null) {
    resolved = { secret: String(configured), source: 'env', envRejection: null, path: null };
    return resolved;
  }

  const persisted = readPersisted();
  if (persisted) {
    resolved = { secret: persisted, source: 'file', envRejection, path: JWT_SECRET_FILE };
    return resolved;
  }

  const generated = crypto.randomBytes(32).toString('hex');
  const written = writePersisted(generated);
  resolved = {
    secret: generated,
    source: written ? 'file' : 'memory',
    envRejection,
    path: written ? JWT_SECRET_FILE : null,
  };
  return resolved;
}

/** The signing secret. Memoized, so sign and verify can never diverge. */
export function jwtSecretValue(): string {
  return getJwtSecret().secret;
}

/** Test-only: forget the memoized resolution so the rules can be re-exercised. */
export function resetJwtSecretCache(): void {
  resolved = null;
}
