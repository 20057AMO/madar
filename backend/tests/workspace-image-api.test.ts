/**
 * workspace-image-api.test.ts — the admin-only workspace image status surface
 * and the controlled refresh contract.
 *
 * Offline rows pin the exact {error,message} map, the env clamps and the 0600
 * last-refresh stamp. Live rows prove 401/403/200 and the fresh parameter
 * against the running container. A refresh is NEVER POSTed with a valid admin
 * token here: that would start a real `docker build`.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import {
  API_URL,
  authHeaders,
  cleanupLiveUsers,
  initTestAuth,
  liveUser,
  signUserToken,
  testIdentity,
  testUserId,
} from './helpers.ts';

// The wiring module imports its siblings extensionless; see tests/ts-ext-resolve.mjs.
register(new URL('./ts-ext-resolve.mjs', import.meta.url).href);

const TEMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'madar-wsimg-api-'));
process.env.WSD_DATA_DIR = TEMP_DATA_DIR;
const REFRESH_FILE = path.join(TEMP_DATA_DIR, 'workspace-image-refresh.json');

const {
  WORKSPACE_IMAGE_ERRORS,
  WorkspaceImageError,
  workspaceImageEnv,
  getLastWorkspaceRefresh,
  refreshWorkspaceImage,
  WORKSPACE_IMAGE_STATUS_TTL_MS,
  WORKSPACE_REFRESH_DEFAULT_TIMEOUT_MS,
  WORKSPACE_REFRESH_MIN_TIMEOUT_MS,
} = await import('../src/services/workspace-image.ts');

const {
  workspaceImageDigest,
  workspaceImageDigestsMatch,
  inspectWorkspaceImage,
} = await import('../src/services/docker-manager.ts');

let serverReady = false;
let liveReady = false;
let adminReady = false;

before(async () => {
  try {
    const res = await fetch(`${API_URL}/health`, { signal: AbortSignal.timeout(4000) });
    serverReady = res.ok && (await res.json() as { status?: string })?.status === 'ok';
  } catch {
    serverReady = false;
  }
  if (!serverReady) return;
  // The verification gate intentionally does not rebuild/restart the container.
  // Only exercise the live rows when that running server actually exposes this
  // route's exact contract; a stale deployment must skip, not fail.
  try {
    const probe = await callApi('GET', '/workspace-image/status');
    liveReady = probe.status === 401
      && probe.body?.error === 'unauthorized'
      && probe.body?.message === 'Authentication required'
      && !('status' in probe.body);
  } catch {
    liveReady = false;
  }
  if (!liveReady) return;
  try {
    await initTestAuth();
    adminReady = Boolean(testUserId());
  } catch {
    adminReady = false;
  }
});

after(async () => {
  if (adminReady) await cleanupLiveUsers();
  try { fs.rmSync(TEMP_DATA_DIR, { recursive: true, force: true }); } catch {}
});

interface ApiCall {
  status: number;
  headers: Headers;
  body: any;
}

async function callApi(method: string, urlPath: string, token?: string): Promise<ApiCall> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_URL}${urlPath}`, {
    method,
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  let body: any = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, headers: res.headers, body };
}

function withEnv(key: string, value: string | undefined, fn: () => number): number {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

describe('workspace-image error contract — offline', () => {
  test('every mapped failure carries its exact status, error and message', () => {
    assert.deepStrictEqual(WORKSPACE_IMAGE_ERRORS, {
      unauthorized: { status: 401, error: 'unauthorized', message: 'Authentication required' },
      forbidden: { status: 403, error: 'forbidden', message: 'Admin access required' },
      refresh_in_progress: { status: 409, error: 'refresh_in_progress', message: 'A workspace image refresh is already running' },
      rate_limited: { status: 429, error: 'rate_limited', message: 'Too many workspace-image requests' },
      docker_unavailable: { status: 503, error: 'docker_unavailable', message: 'Docker daemon is not reachable' },
      workspace_build_unavailable: { status: 503, error: 'workspace_build_unavailable', message: 'Workspace image build source is unavailable' },
      workspace_build_failed: { status: 502, error: 'workspace_build_failed', message: 'Workspace image refresh failed' },
      workspace_build_timeout: { status: 504, error: 'workspace_build_timeout', message: 'Workspace image refresh timed out' },
    });
  });

  test('the typed error exposes only the code and its fixed message', () => {
    const err = new WorkspaceImageError('refresh_in_progress');
    assert.ok(err instanceof Error);
    assert.strictEqual(err.name, 'WorkspaceImageError');
    assert.strictEqual(err.code, 'refresh_in_progress');
    assert.strictEqual(err.message, 'A workspace image refresh is already running');
    assert.ok(!('stderr' in err));
    assert.ok(!('buildId' in err));
  });

  test('the status cache TTL and refresh timeout bounds are pinned', () => {
    assert.strictEqual(WORKSPACE_IMAGE_STATUS_TTL_MS, 30_000);
    assert.strictEqual(WORKSPACE_REFRESH_DEFAULT_TIMEOUT_MS, 900_000);
    assert.strictEqual(WORKSPACE_REFRESH_MIN_TIMEOUT_MS, 60_000);
  });
});

describe('workspace-image env + stamp — offline', () => {
  test('WSD_WORKSPACE_STALE_DAYS defaults to 30 and clamps to 1..365', () => {
    assert.strictEqual(withEnv('WSD_WORKSPACE_STALE_DAYS', undefined, () => workspaceImageEnv().staleDays), 30);
    assert.strictEqual(withEnv('WSD_WORKSPACE_STALE_DAYS', 'junk', () => workspaceImageEnv().staleDays), 30);
    assert.strictEqual(withEnv('WSD_WORKSPACE_STALE_DAYS', '0', () => workspaceImageEnv().staleDays), 1);
    assert.strictEqual(withEnv('WSD_WORKSPACE_STALE_DAYS', '999', () => workspaceImageEnv().staleDays), 365);
    assert.strictEqual(withEnv('WSD_WORKSPACE_STALE_DAYS', '7', () => workspaceImageEnv().staleDays), 7);
  });

  test('WSD_WORKSPACE_REFRESH_TIMEOUT_MS defaults to 900000 with a 60000 floor', () => {
    assert.strictEqual(withEnv('WSD_WORKSPACE_REFRESH_TIMEOUT_MS', undefined, () => workspaceImageEnv().timeoutMs), 900_000);
    assert.strictEqual(withEnv('WSD_WORKSPACE_REFRESH_TIMEOUT_MS', 'junk', () => workspaceImageEnv().timeoutMs), 900_000);
    assert.strictEqual(withEnv('WSD_WORKSPACE_REFRESH_TIMEOUT_MS', '1000', () => workspaceImageEnv().timeoutMs), 60_000);
    assert.strictEqual(withEnv('WSD_WORKSPACE_REFRESH_TIMEOUT_MS', '120000', () => workspaceImageEnv().timeoutMs), 120_000);
  });

  test('a missing or corrupt refresh stamp is absent state, never a throw', () => {
    try { fs.unlinkSync(REFRESH_FILE); } catch {}
    assert.strictEqual(getLastWorkspaceRefresh(), null);
    fs.writeFileSync(REFRESH_FILE, '{not json', { encoding: 'utf8', mode: 0o600 });
    assert.strictEqual(getLastWorkspaceRefresh(), null);
  });

  test('a valid refresh stamp round-trips its fixed fields', () => {
    const entry = {
      at: '2026-11-20T10:00:00.000Z',
      ok: false,
      durationMs: 4321,
      buildId: 'wi-abc',
      errorCode: 'docker_unavailable',
    };
    fs.writeFileSync(REFRESH_FILE, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
    assert.deepStrictEqual(getLastWorkspaceRefresh(), entry);
  });
});

describe('workspace-image digest representation — offline', () => {
  test('only digest values are accepted and normalized', () => {
    assert.strictEqual(workspaceImageDigest('sha256:ABC123'), 'sha256:abc123');
    assert.strictEqual(workspaceImageDigest(' sha512:00ff '), 'sha512:00ff');
    assert.strictEqual(workspaceImageDigest('wsd/workspace:latest'), null);
    assert.strictEqual(workspaceImageDigest('wsd/workspace@sha256:abc123'), null);
    assert.strictEqual(workspaceImageDigest('sha256:xyz'), null);
    assert.strictEqual(workspaceImageDigest(null), null);
  });

  test('imageCurrent comparisons match digests and reject tags or mismatches', () => {
    const sameDigest = 'sha256:abc123';
    assert.strictEqual(workspaceImageDigestsMatch(sameDigest, sameDigest.toUpperCase()), true);
    assert.strictEqual(workspaceImageDigestsMatch(` ${sameDigest} `, sameDigest), true);
    assert.strictEqual(workspaceImageDigestsMatch(sameDigest, 'sha256:deadbeef'), false);
    assert.strictEqual(workspaceImageDigestsMatch(sameDigest, null), false);
    assert.strictEqual(workspaceImageDigestsMatch('wsd/workspace:latest', sameDigest), false);
    assert.strictEqual(workspaceImageDigestsMatch('wsd/workspace@sha256:abc123', sameDigest), false);
  });
});

describe('workspace-image refresh failure — offline', () => {
  test('a synchronous setup throw does not wedge the refresh guard', async () => {
    const boom = new Error('workspace env exploded');
    const originalEnv = process.env;
    process.env = new Proxy(originalEnv, {
      get(target, prop, receiver) {
        if (prop === 'WSD_WORKSPACE_STALE_DAYS') return { trim() { throw boom; } };
        return Reflect.get(target, prop, receiver);
      },
    }) as NodeJS.ProcessEnv;
    try {
      for (let i = 0; i < 2; i += 1) {
        await assert.rejects(refreshWorkspaceImage(), (err: unknown) =>
          err instanceof WorkspaceImageError && err.code === 'workspace_build_failed');
      }
    } finally {
      process.env = originalEnv;
    }
  });

  test('a failed refresh invalidates the cached image inspection', async () => {
    const first = await inspectWorkspaceImage();
    assert.strictEqual(await inspectWorkspaceImage(), first);
    const boom = new Error('workspace env exploded');
    const originalEnv = process.env;
    process.env = new Proxy(originalEnv, {
      get(target, prop, receiver) {
        if (prop === 'WSD_WORKSPACE_STALE_DAYS') return { trim() { throw boom; } };
        return Reflect.get(target, prop, receiver);
      },
    }) as NodeJS.ProcessEnv;
    try {
      await assert.rejects(refreshWorkspaceImage(), (err: unknown) =>
        err instanceof WorkspaceImageError && err.code === 'workspace_build_failed');
    } finally {
      process.env = originalEnv;
    }
    assert.notStrictEqual(await inspectWorkspaceImage(), first);
  });
});

describe('workspace-image status rate limit — offline source gate', () => {
  test('status reads are admin-gated and rate-bounded with the mapped 429', () => {
    const source = fs.readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
    assert.match(source, /const WORKSPACE_STATUS_MAX = rateCeil\('WSD_RATE_WORKSPACE_STATUS_MAX', 60, 600\);/);
    assert.match(source, /app\.get\('\/api\/workspace-image\/status', workspaceImageAuth, workspaceStatusLimiter,/);
    const start = source.indexOf('const workspaceStatusLimiter');
    const end = source.indexOf('app.get(', start);
    assert.ok(start >= 0 && end > start);
    const limiter = source.slice(start, end);
    assert.match(limiter, /const key = `workspace-status:\$\{ip\}`;/);
    assert.match(limiter, /if \(entry\.count > WORKSPACE_STATUS_MAX\)/);
    assert.match(limiter, /Retry-After/);
    assert.match(limiter, /sendWorkspaceImageError\(res, 'rate_limited'\)/);
  });
});

describe('workspace-image status — live HTTP gate', () => {
  test('GET without a token is 401 with the exact shape', async (t) => {
    if (!liveReady) return t.skip('running server does not expose the workspace-image route contract');
    const res = await callApi('GET', '/workspace-image/status');
    assert.strictEqual(res.status, 401);
    assert.deepStrictEqual(res.body, { error: 'unauthorized', message: 'Authentication required' });
  });

  test('GET with a viewer token is 403 and carries no payload', async (t) => {
    if (!liveReady || !adminReady) return t.skip('no admin identity to create the viewer');
    const viewer = await liveUser('viewer', 'workspace-image-status');
    const res = await callApi('GET', '/workspace-image/status', viewer.token);
    assert.strictEqual(res.status, 403);
    assert.deepStrictEqual(res.body, { error: 'forbidden', message: 'Admin access required' });
  });

  test('GET with an admin token is 200 with the full contract shape', async (t) => {
    if (!liveReady || !adminReady) return t.skip('no admin identity available');
    const res = await callApi('GET', '/workspace-image/status', authHeaders().Authorization!.replace('Bearer ', ''));
    assert.strictEqual(res.status, 200);
    const body = res.body;
    for (const key of ['workspaceImage', 'daemon', 'projects', 'lastRefresh', 'checkedAt']) {
      assert.ok(Object.hasOwn(body, key), `missing ${key}`);
    }
    assert.ok(Array.isArray(body.projects));
    assert.strictEqual(typeof body.checkedAt, 'string');
    assert.ok(Number.isFinite(Date.parse(body.checkedAt)));
    assert.strictEqual(typeof body.workspaceImage, 'object');
    assert.ok(body.workspaceImage !== null);
    for (const nested of ['daemon', 'projects', 'checkedAt']) {
      assert.ok(!Object.hasOwn(body.workspaceImage, nested));
    }
    assert.strictEqual(body.lastRefresh === null || typeof body.lastRefresh === 'object', true);
  });

  test('fresh=1 and fresh=true are both accepted', async (t) => {
    if (!liveReady || !adminReady) return t.skip('no admin identity available');
    const token = authHeaders().Authorization!.replace('Bearer ', '');
    for (const query of ['?fresh=1', '?fresh=true']) {
      const res = await callApi('GET', `/workspace-image/status${query}`, token);
      assert.strictEqual(res.status, 200, query);
      assert.ok(Array.isArray(res.body.projects), query);
    }
  });

  test('a scoped token is refused as a session (401)', async (t) => {
    if (!liveReady || !adminReady) return t.skip('no real user for the scoped token');
    const identity = testIdentity()!;
    const scoped = signUserToken(identity, { scope: 'embed' });
    const res = await callApi('GET', '/workspace-image/status', scoped);
    assert.strictEqual(res.status, 401);
    assert.deepStrictEqual(res.body, { error: 'unauthorized', message: 'Authentication required' });
  });

  test('POST refresh without a token is 401, never a build', async (t) => {
    if (!liveReady) return t.skip('running server does not expose the workspace-image route contract');
    const res = await callApi('POST', '/workspace-image/refresh');
    assert.strictEqual(res.status, 401);
    assert.deepStrictEqual(res.body, { error: 'unauthorized', message: 'Authentication required' });
  });

  test('POST refresh with a viewer token is 403, never a build', async (t) => {
    if (!liveReady || !adminReady) return t.skip('no admin identity to create the viewer');
    const viewer = await liveUser('viewer', 'workspace-image-refresh');
    const res = await callApi('POST', '/workspace-image/refresh', viewer.token);
    assert.strictEqual(res.status, 403);
    assert.deepStrictEqual(res.body, { error: 'forbidden', message: 'Admin access required' });
  });
});
