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
// verifyToken requires the SUBJECT to still exist in users.json (a deleted
// user's token is refused, deliberately), so these defaults are placeholders
// only: signTestToken() throws until a real id was resolved below.
let _userId = '';
let _username = '';
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
    } else {
      // A user exists. We cannot read its id without a session, so log in for
      // real: the documented WSD_TEST_USER/WSD_TEST_PASS pair first, then the
      // suite's own bootstrap account.
      const candidates: Array<[string, string]> = [];
      if (process.env.WSD_TEST_USER && process.env.WSD_TEST_PASS) {
        candidates.push([process.env.WSD_TEST_USER, process.env.WSD_TEST_PASS]);
      }
      const pw = process.env.WSD_TEST_ACCOUNT_PASSWORD || 'test-password-123';
      candidates.push(['test-admin', pw]);

      for (const [username, password] of candidates) {
        const loginRes = await fetch(`${API_URL}/auth/login`, {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ username, password }),
        });
        const loginData = await loginRes.json() as any;
        if (loginData.token) {
          const decoded = jwt.decode(loginData.token) as any;
          _userId = decoded.id;
          _username = decoded.username;
          _userRole = decoded.role || 'admin';
          _tv = decoded.tv || 0;
          break;
        }
      }
      if (!_userId) resolveIdentityFromContainer();
    }
  } catch {
    // Server might not be running yet; keep the unresolved placeholders.
  }
  _initialized = true;
}

/**
 * Synchronous sign — call ensureSession() in a before() hook first.
 * Returns a token that matches a user that really exists in users.json, with
 * its real tokenVersion. Throws when no real id could be resolved: a token for
 * a non-existent id is refused by the server (401) since that is exactly the
 * hole this helper used to paper over, so failing loudly here beats a wall of
 * confusing 401s later.
 */
export function signTestToken(expiresIn = '24h'): string {
  if (!_userId) {
    throw new Error(
      '[helpers] No real user id was resolved, so no session can be signed. initTestAuth() must run ' +
      'with the API reachable (http://127.0.0.1:3000/api) and either WSD_TEST_USER/WSD_TEST_PASS or ' +
      'a working test-admin password. Forging a token for an invented id no longer authenticates.',
    );
  }
  return jwt.sign(
    { id: _userId, username: _username, role: _userRole, tv: _tv, jti: 'test-session' },
    JWT_SECRET,
    { expiresIn }
  );
}

/** The live user id the shared session was signed for (null when unresolved). */
export function testUserId(): string | null {
  return _userId || null;
}

/** The resolved REAL account (id/username/role/tv) behind the shared session. */
export function testIdentity(): { id: string; username: string; role: string; tv: number } | null {
  if (!_userId) return null;
  return { id: _userId, username: _username, role: _userRole, tv: _tv };
}

/**
 * Last-resort identity resolution for a dev box with no test credentials: read
 * the FIRST account (id / username / role only — never the password hash) out
 * of the running container's users.json through the local docker daemon, the
 * same way resolveServerJwtSecret() reads data/jwt.secret. A REAL id is what
 * the server now requires; inventing one no longer authenticates.
 */
function resolveIdentityFromContainer(): boolean {
  const container = process.env.WSD_TEST_CONTAINER || 'wsd-pro';
  try {
    const raw = execFileSync('docker', ['exec', container, 'cat', '/app/data/users.json'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parsed = JSON.parse(raw) as { users?: Array<{ id?: string; username?: string; role?: string; tokenVersion?: number }> };
    const first = parsed.users?.find((u) => u?.id);
    if (!first?.id) return false;
    _userId = first.id;
    _username = String(first.username || '');
    _userRole = String(first.role || 'admin');
    _tv = Number(first.tokenVersion || 0);
    console.warn(
      `[helpers] No test credentials resolved a session; adopted the first account (${_username}) from ` +
      `'docker exec ${container} cat /app/data/users.json'. Set WSD_TEST_USER/WSD_TEST_PASS to avoid this.`,
    );
    return true;
  } catch {
    return false;
  }
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

// ── Throwaway users that really exist ──────────────────────────
//
// verifyToken refuses a token whose subject is missing from users.json, so a
// suite can no longer invent an identity: an "outsider" or a "global editor"
// has to be a real account, or the assertion would be measuring 401s instead
// of the authorization it claims to test. liveUser() creates one (memoized per
// role+key) and hands back its REAL id plus a signed session for it.

export type TestRole = 'admin' | 'editor' | 'viewer';

export interface LiveTestUser {
  id: string;
  username: string;
  role: TestRole;
  token: string;
}

export const LIVE_USER_PASSWORD = 'LiveProbe-1234';
const LIVE_PASSWORD = LIVE_USER_PASSWORD;
const _liveUsers = new Map<string, LiveTestUser>();
const _liveUserIds: string[] = [];

/** Sign a session for an id that exists in users.json (tokenVersion 0). */
export function signUserToken(
  user: { id: string; username: string; role: string },
  extra: Record<string, unknown> = {},
  expiresIn = '24h'
): string {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, tv: 0, jti: `suite-${user.id}`, ...extra },
    JWT_SECRET,
    { expiresIn }
  );
}

export async function liveUser(role: TestRole = 'viewer', key = role): Promise<LiveTestUser> {
  const cacheKey = `${role}:${key}`;
  const hit = _liveUsers.get(cacheKey);
  if (hit) return hit;
  const username = uniqueId(`live-${key}`).replace(/[^a-z0-9-]/g, '').slice(0, 50);
  const create = () => reqAuth('POST', '/users', { username, password: LIVE_PASSWORD, role });
  // POST /users sits behind the admin user-provisioning limiter (production
  // budget: 20/min), so back off on 429 the way team-access.test.ts does. A rate
  // limit must never be reported as an authorization failure.
  let res = await create();
  for (let attempt = 0; res.status === 429 && attempt < 10; attempt += 1) {
    const secs = Math.max(1, parseInt(String(res.headers.get('Retry-After') || '5'), 10));
    await new Promise((r) => setTimeout(r, secs * 1000 + 250));
    res = await create();
  }
  if (res.status !== 201) {
    throw new Error(`liveUser(${cacheKey}) could not create the throwaway user: ${res.status} ${JSON.stringify(await res.json())}`);
  }
  const acc = await res.json() as { id: string; username: string };
  _liveUserIds.push(acc.id);
  const user: LiveTestUser = { id: acc.id, username: acc.username, role, token: signUserToken({ id: acc.id, username: acc.username, role }) };
  _liveUsers.set(cacheKey, user);
  return user;
}

/** Delete every throwaway user liveUser() created (call from a suite's after). */
export async function cleanupLiveUsers(): Promise<void> {
  for (const id of _liveUserIds.splice(0)) {
    try { await reqAuth('DELETE', `/users/${id}`); } catch { /* best effort */ }
  }
  _liveUsers.clear();
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
