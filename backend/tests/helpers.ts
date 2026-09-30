/**
 * Shared test helpers for Madar backend test suites.
 * Runs under `node --test` (Node 22 type stripping) — plain TS only,
 * relative imports must include the explicit `.ts` extension.
 */
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import dotenv from 'dotenv';
import { classifyJwtSecret } from '../src/services/jwt-secret-core.ts';

// Load secrets: repo-root .env first, then backend/.env (no override).
// Tests run with cwd = backend/, so the root .env is one level up.
const rootEnv = path.resolve(process.cwd(), '..', '.env');
if (fs.existsSync(rootEnv)) dotenv.config({ path: rootEnv });
dotenv.config();

export const API_URL = process.env.WSD_TEST_API_URL || 'http://127.0.0.1:3000/api';

/**
 * The signing secret the server actually uses, resolved the same way the
 * server does — there is no in-repo default to fall back on any more, so a
 * helper that invented one would only produce 401s:
 *   1. JWT_SECRET in the environment (CI, and the documented repo-root `.env`
 *      contract, both of which the server sees too).
 *   2. The secret the container generated and persisted at /app/data/jwt.secret
 *      — read through the local docker daemon, which is already a prerequisite
 *      for every live suite. Override the container with WSD_TEST_CONTAINER.
 *   3. A random per-process value plus a loud warning, so a missing step fails
 *      visibly instead of quietly signing with a public literal.
 */
function resolveServerJwtSecret(): string {
  const configured = (process.env.JWT_SECRET || '').trim();
  if (classifyJwtSecret(configured) === null) return configured;

  const container = process.env.WSD_TEST_CONTAINER || 'wsd-pro';
  try {
    const fromContainer = execFileSync('docker', ['exec', container, 'cat', '/app/data/jwt.secret'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (classifyJwtSecret(fromContainer) === null) return fromContainer;
  } catch { /* no docker / no container / no persisted secret */ }

  const random = `suite-only-${crypto.randomBytes(16).toString('hex')}`;
  console.warn(
    `[helpers] Could not resolve the server JWT signing secret: JWT_SECRET is not set in this ` +
    `environment and 'docker exec ${container} cat /app/data/jwt.secret' did not answer. ` +
    `Forged tokens will be REFUSED by the server — set JWT_SECRET (same value the server uses) ` +
    `or point WSD_TEST_CONTAINER at the running app container.`,
  );
  return random;
}

export const JWT_SECRET = resolveServerJwtSecret();

export const JSON_HEADERS: Record<string, string> = { 'Content-Type': 'application/json' };

// ── Lazy-init real session info ───────────────────────────────
let _userId = 'test-user';
let _username = 'test';
let _userRole: string = 'admin';
let _tv = 0;
let _initialized = false;

async function ensureSession(): Promise<void> {
  if (_initialized) return;
  try {
    const statusRes = await fetch(`${API_URL}/auth/status`);
    const status = await statusRes.json() as any;

    if (!status.hasUser) {
      // No user exists — run setup to create the first admin
      const setupRes = await fetch(`${API_URL}/auth/setup`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ username: 'test-admin', password: 'test-password-123' }),
      });
      const setupData = await setupRes.json() as any;
      if (setupData.id) {
        _userId = setupData.id;
        _username = setupData.username;
        _userRole = 'admin';
        _tv = 0;
      }
    } else if (status.user) {
      // Authenticated status (shouldn't happen without token, but handle it)
      _userId = status.user.id;
      _username = status.user.username;
      _userRole = status.user.role || 'admin';
      const pw = process.env.WSD_TEST_ACCOUNT_PASSWORD || 'test-password-123';
      const loginRes = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ username: _username, password: pw }),
      });
      const loginData = await loginRes.json() as any;
      if (loginData.token) {
        const decoded = jwt.decode(loginData.token) as any;
        if (decoded?.tv !== undefined) _tv = decoded.tv;
      }
    } else {
      // User exists but no token — try login with known password
      // Read the user list from /api/users (requires auth — won't work here)
      // Instead, try to forge a token. verifyToken accepts unknown users with
      // valid JWT signatures, so we just need the correct id.
      // We can't get the id without auth, so try login which will tell us.
      const pw = process.env.WSD_TEST_ACCOUNT_PASSWORD || 'test-password-123';
      const loginRes = await fetch(`${API_URL}/auth/login`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ username: 'test-admin', password: pw }),
      });
      const loginData = await loginRes.json() as any;
      if (loginData.token) {
        // Login succeeded — use the real token
        const decoded = jwt.decode(loginData.token) as any;
        _userId = decoded.id;
        _username = decoded.username;
        _userRole = decoded.role || 'admin';
        _tv = decoded.tv || 0;
      }
      // If login fails, _userId stays as 'test-user' — verifyToken will accept it
      // as an unknown user with the embedded role.
    }
  } catch {
    // Server might not be running yet; keep defaults
  }
  _initialized = true;
}

/**
 * Synchronous sign — call ensureSession() in a before() hook first.
 * Returns a token that matches the real user in the store.
 */
export function signTestToken(expiresIn = '24h'): string {
  return jwt.sign(
    { id: _userId, username: _username, role: _userRole, tv: _tv, jti: 'test-session' },
    JWT_SECRET,
    { expiresIn }
  );
}

/**
 * Call this once at the top of a describe() block that needs auth.
 * Ensures the test user exists and tokens will verify.
 */
export async function initTestAuth(): Promise<void> {
  await ensureSession();
}

export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${signTestToken()}`, ...extra };
}

let counter = 0;
export function uniqueId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`.toLowerCase();
}

export interface Res {
  status: number;
  ok: boolean;
  json(): Promise<any>;
}

export async function req(
  method: string,
  urlPath: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<Res> {
  const doFetch = (): Promise<Res> =>
    fetch(`${API_URL}${urlPath}`, {
      method,
      headers: { ...headers, ...(body !== undefined ? JSON_HEADERS : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }) as Promise<Res>;

  let res = await doFetch();
  for (let attempt = 0; res.status === 429 && attempt < 3; attempt += 1) {
    await new Promise((r) => setTimeout(r, 1500));
    res = await doFetch();
  }
  return res;
}

export async function reqAuth(
  method: string,
  urlPath: string,
  body?: unknown
): Promise<Res> {
  return req(method, urlPath, body, authHeaders());
}

/** First existing project slug, or null when none exist. */
export async function firstProjectSlug(): Promise<string | null> {
  try {
    const res = await reqAuth('GET', '/projects');
    if (!res.ok) return null;
    const data = await res.json();
    const arr = data?.projects;
    return Array.isArray(arr) && arr.length > 0 ? arr[0].slug : null;
  } catch {
    return null;
  }
}
