import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { hasUser, setup } from './user-store';
import { withFileLockAsync } from './write-queue';

const HASH_PATTERN = /^[a-f0-9]{64}$/;

let expectedHash: string | null = null;
let initialized = false;
let lastInit: SetupTokenInitResult | null = null;

export type SetupTokenInitResult = {
  source: 'existing-user' | 'env' | 'file' | 'generated' | 'memory';
  path: string | null;
  token?: string;
};

export type SetupOutcome =
  | { ok: true; user: { id: string; username: string; token: string } }
  | { ok: false; status: 400 | 401 | 409; error: string; message: string };

function hashFilePath(): string {
  return path.join(process.env.WSD_DATA_DIR || '/app/data', 'setup.token.sha256');
}

function cleanToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export function hashSetupToken(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readStoredHash(file: string): string | null {
  try {
    const stored = fs.readFileSync(file, 'utf8').trim().toLowerCase();
    return HASH_PATTERN.test(stored) ? stored : null;
  } catch {
    return null;
  }
}

function writeStoredHash(file: string, hash: string): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, hash + '\n', { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
    return true;
  } catch {
    return false;
  }
}

function consumeStoredHash(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      console.warn('[madar] Could not remove the setup token hash after setup.');
    }
  }
}

export function initSetupToken(): SetupTokenInitResult {
  if (initialized && lastInit) return lastInit;
  initialized = true;

  const file = hashFilePath();
  if (hasUser()) {
    expectedHash = null;
    lastInit = { source: 'existing-user', path: null };
    return lastInit;
  }

  const envToken = cleanToken(process.env.WSD_SETUP_TOKEN);
  if (envToken) {
    const hash = hashSetupToken(envToken);
    expectedHash = hash;
    const persisted = writeStoredHash(file, hash);
    lastInit = { source: persisted ? 'env' : 'memory', path: persisted ? file : null };
    return lastInit;
  }

  const stored = readStoredHash(file);
  if (stored) {
    expectedHash = stored;
    lastInit = { source: 'file', path: file };
    return lastInit;
  }

  const token = crypto.randomBytes(32).toString('hex');
  const hash = hashSetupToken(token);
  expectedHash = hash;
  const persisted = writeStoredHash(file, hash);
  console.log(`Madar setup token: ${token}`);
  console.log('If you missed it, find it again with: docker compose logs app');
  lastInit = { source: persisted ? 'generated' : 'memory', token, path: persisted ? file : null };
  return lastInit;
}

export function setupTokenCandidates(bodyToken: unknown, headerToken: unknown): string[] {
  const candidates: string[] = [];
  for (const raw of [bodyToken, headerToken]) {
    const token = cleanToken(raw);
    if (token && !candidates.includes(token)) candidates.push(token);
  }
  return candidates;
}

export function verifySetupToken(candidates: readonly unknown[]): boolean {
  if (!expectedHash || !HASH_PATTERN.test(expectedHash)) return false;
  const expected = Buffer.from(expectedHash, 'hex');
  for (const candidate of candidates) {
    const token = cleanToken(candidate);
    if (!token) continue;
    const hash = hashSetupToken(token);
    if (hash.length !== expectedHash.length) continue;
    const actual = Buffer.from(hash, 'hex');
    if (crypto.timingSafeEqual(actual, expected)) return true;
  }
  return false;
}

function failure(status: 400 | 401 | 409, error: string, message: string): SetupOutcome {
  return { ok: false, status, error, message };
}

export async function performSetup(input: {
  username: unknown;
  password: unknown;
  bodyToken?: unknown;
  headerToken?: unknown;
}): Promise<SetupOutcome> {
  const candidates = setupTokenCandidates(input.bodyToken, input.headerToken);
  // withFileLock('setup') is sync-only; the async variant tail-chains the whole
  // bcrypt/create/consume window so two concurrent setups cannot both pass.
  return withFileLockAsync('setup', async () => {
    if (hasUser()) {
      return failure(409, 'setup_complete', 'Setup is already complete.');
    }
    if (!verifySetupToken(candidates)) {
      return failure(401, 'invalid_setup_token', 'A valid setup token is required.');
    }
    if (typeof input.username !== 'string' || typeof input.password !== 'string' || !input.username.trim() || !input.password) {
      return failure(400, 'invalid_setup_request', 'Username and password are required.');
    }

    try {
      const user = await setup(input.username, input.password);
      expectedHash = null;
      consumeStoredHash(hashFilePath());
      return { ok: true, user };
    } catch (err: any) {
      const message = err instanceof Error && err.message ? err.message : 'Unable to complete setup.';
      if (/already exists/i.test(message)) {
        return failure(409, 'setup_complete', 'Setup is already complete.');
      }
      return failure(400, 'invalid_setup_request', message);
    }
  });
}

/** Test-only: re-run boot initialization against a fresh environment. */
export function resetSetupTokenState(): void {
  expectedHash = null;
  initialized = false;
  lastInit = null;
}
