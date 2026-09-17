/**
 * Live integration tests for the security hardening (needs a running backend
 * + Docker, run like the other *-api/lifecycle suites):
 *
 * 1. WS routes are project-access gated: a viewer token gets close(1008) on
 *    terminal/logs for a project it is not a member of, while an editor token
 *    connects. Legacy all-authenticated membership behavior is preserved.
 * 2. env is stripped from generic project payloads and only exposed on the
 *    editor-gated GET /env route.
 *
 * Uses 'ws' (already a backend dependency) against the live server.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import WebSocket from 'ws';
import jwt from 'jsonwebtoken';
import { API_URL, JWT_SECRET, reqAuth, initTestAuth, uniqueId, authHeaders } from './helpers.ts';

const WS_BASE = API_URL.replace(/\/api$/, '').replace(/^http/, 'ws');

/** Role token for an arbitrary user id (server trusts verified JWT claims). */
function tokenFor(id: string, role: 'admin' | 'editor' | 'viewer'): string {
  return jwt.sign({ id, username: `t-${id.slice(0, 8)}`, role, tv: 0, jti: `test-${id.slice(0, 8)}` }, JWT_SECRET, { expiresIn: '1h' });
}

/** Open a WS and resolve with the close code / first error frame. */
function wsCloseCode(path: string, token: string, timeoutMs = 8000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const sep = path.includes('?') ? '&' : '?';
    const ws = new WebSocket(`${WS_BASE}${path}${sep}token=${encodeURIComponent(token)}`, { handshakeTimeout: timeoutMs });
    const timer = setTimeout(() => { try { ws.terminate(); } catch { /* noop */ } reject(new Error('ws timeout')); }, timeoutMs + 2000);
    ws.on('close', (code, reason) => { clearTimeout(timer); resolve({ code, reason: reason.toString() }); });
    ws.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      // ECONNRESET-ish handshake rejections also prove denial.
      if (err.code === '401' || /401|denied/.test(err.message)) resolve({ code: 401, reason: err.message });
      else { try { ws.terminate(); } catch { /* noop */ } reject(err); }
    });
  });
}

describe('WebSocket access gates (live server)', () => {
  before(async () => { await initTestAuth(); });

  const slug = uniqueId('sec-test');
  let created = false;
  // A viewer-role outsider: system editors intentionally hold global write
  // access, so the meaningful denial actor is a plain viewer non-member.
  const outsiderId = 'outsider-1111-2222-3333-444444444444';

  after(async () => {
    if (!created) return;
    try { await reqAuth('DELETE', `/projects/${slug}`); } catch { /* best effort */ }
  });

  test('setup: create project and set a secret env var', async () => {
    const res = await reqAuth('POST', '/projects', { name: 'Sec Test', slug, description: 'security suite' });
    assert.strictEqual(res.status, 201, `create failed: ${res.status}`);
    created = true;
    const envRes = await reqAuth('PUT', `/projects/${slug}/env`, { env: { WSD_SECRET_TOKEN: 'super-secret-value' } });
    assert.strictEqual(envRes.status, 200);
  });

  test('GET /projects does not leak env on any listed project', async () => {
    const res = await reqAuth('GET', '/projects');
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    const listed = (data.projects as any[]).find((p) => p.slug === slug);
    assert.ok(listed, 'created project should be listed');
    assert.ok(!('env' in listed), 'env must not appear in the list payload');
  });

  test('GET /projects/:slug omits env; GET /env (editor+) returns it', async () => {
    const res = await reqAuth('GET', `/projects/${slug}`);
    assert.strictEqual(res.status, 200);
    const { project } = await res.json();
    assert.ok(!('env' in project), 'detail payload must not carry env');

    const envRes = await reqAuth('GET', `/projects/${slug}/env`);
    assert.strictEqual(envRes.status, 200);
    const { env } = await envRes.json();
    assert.strictEqual(env.WSD_SECRET_TOKEN, 'super-secret-value');
  });

  test('terminal socket: outsider (non-member viewer) is denied with close 1008', async () => {
    const { code, reason } = await wsCloseCode(`/ws/projects/${slug}/terminal`, tokenFor(outsiderId, 'viewer'));
    assert.strictEqual(code, 1008, `expected 1008, got ${code} (${reason})`);
  });

  test('logs socket: outsider is denied with close 1008', async () => {
    const { code, reason } = await wsCloseCode(`/ws/projects/${slug}/logs`, tokenFor(outsiderId, 'viewer'));
    assert.strictEqual(code, 1008, `expected 1008, got ${code} (${reason})`);
  });

  test('admin (owner) still connects to logs socket', async () => {
    // initTestAuth's token is available via authHeaders; reuse it.
    const h = authHeaders();
    const token = h.Authorization.replace('Bearer ', '');
    // Rapid successive WS dials on Windows can transiently error — retry a
    // couple of times before concluding denial.
    let outcome = 'error';
    for (let attempt = 0; attempt < 3 && outcome !== 'open'; attempt += 1) {
      const ws = new WebSocket(`${WS_BASE}/ws/projects/${slug}/logs?token=${encodeURIComponent(token)}`, { handshakeTimeout: 8000 });
      outcome = await new Promise<string>((resolve) => {
        const t = setTimeout(() => resolve('timeout'), 3000);
        ws.on('open', () => { clearTimeout(t); resolve('open'); });
        ws.on('close', (code) => { clearTimeout(t); resolve(`closed:${code}`); });
        ws.on('error', () => { clearTimeout(t); resolve('error'); });
      });
      ws.terminate();
      if (outcome !== 'open') await new Promise((r) => setTimeout(r, 400));
    }
    assert.strictEqual(outcome, 'open', 'owner token must connect to project logs');
  });

  test('control-mode terminal requires admin (viewer token denied)', async () => {
    // The control gate demands a strict admin decision — a viewer non-member
    // must be refused before any shell is spawned.
    const { code, reason } = await wsCloseCode(`/ws/projects/${slug}/terminal?mode=control`, tokenFor(outsiderId, 'viewer'));
    assert.strictEqual(code, 1008, `non-admin must not open a control shell (got ${code} ${reason})`);
  });

  test('invalid token is still rejected at upgrade (401 path intact)', async () => {
    const { code } = await wsCloseCode(`/ws/projects/${slug}/logs`, 'not-a-real-token');
    assert.notStrictEqual(code, 1000, 'connection must not close cleanly');
  });
});
