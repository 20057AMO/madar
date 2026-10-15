/**
 * Shared E2E helpers — auth plumbing for the Madar browser suites.
 *
 * We sign a JWT locally with the same secret the server resolved (repo .env
 * JWT_SECRET). The session must belong to a REAL user: verifyToken refuses an
 * unknown id, so a fabricated identity yields `user: null` and the app bounces
 * to /login. The id / role / tokenVersion therefore come from the running
 * container's data/users.json. The UI language is pinned to English so text
 * assertions stay deterministic (first-visit default is Arabic).
 */
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import type { Page } from '@playwright/test';

export const BASE = 'http://localhost:3000';

/** Minimal .env parser (no dotenv dependency). */
function parseDotEnv(filePath: string): Record<string, string> {
  const raw = fs.readFileSync(filePath, 'utf8');
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return out;
}

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..', '..');
const env = parseDotEnv(path.join(repoRoot, '.env'));
const JWT_SECRET = env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error(
    'JWT_SECRET not found in .env — the server no longer has a public default to share, ' +
    'so set a long random JWT_SECRET in .env (the server then uses that same value) before running e2e',
  );
}

/** Resolve a session token for a REAL user that exists in the running container. */
let cachedToken: string | null = null;
export function sessionToken(): string {
  if (cachedToken) return cachedToken;
  const container = process.env.WSD_TEST_CONTAINER || 'wsd-pro';
  const users = JSON.parse(
    execFileSync('docker', ['exec', container, 'cat', '/app/data/users.json'], { encoding: 'utf8' }),
  );
  const list: Array<{ id?: string; username?: string; role?: string; tokenVersion?: number }> = users.users || [];
  const user = list.find((entry) => entry.role === 'admin') || list.find((entry) => entry.id);
  if (!user?.id) {
    throw new Error('No existing user is available in the running container');
  }
  cachedToken = jwt.sign(
    { id: user.id, username: user.username, role: user.role, tv: user.tokenVersion || 0, jti: 'e2e-session' },
    JWT_SECRET,
    { expiresIn: '24h' },
  );
  return cachedToken;
}

/** Inject auth token + English UI into localStorage before any page script runs. */
export async function injectAuth(page: Page): Promise<void> {
  const token = sessionToken();
  await page.addInitScript((value) => {
    localStorage.setItem('wsd.token', value);
    localStorage.setItem('wsd.lang', 'en');
  }, token);
}
