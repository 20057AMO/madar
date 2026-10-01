/**
 * webhooks.test.ts
 * Real-Docker integration for the Notifications / Webhooks feature:
 *  - Store CRUD + validation (name/url required, bad scheme rejected, junk
 *    events sanitized, signing secret masked as hasSecret and never echoed).
 *  - Background delivery: a local HTTP receiver proves lifecycle events
 *    ('created'/'stopped'/'deleted'), a manual 'snapshot-saved' capture, the
 *    manual Test endpoint (id + raw url modes) — with HMAC-SHA256 signature
 *    verification over the raw body.
 *  - Event filtering: a crash-only webhook never receives lifecycle traffic.
 *  - Access matrix: viewer/editor tokens get 403 on every webhook route.
 *  - Cap: 51st webhook rejected; full cleanup after the suite.
 *
 * The crash *decision* is unit-tested offline (project-alerts.test.ts →
 * classifyCrash); the crash webhook here is proven by the store subscription
 * filter + the identical HMAC send path exercised on lifecycle events.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { uniqueId, req, reqAuth, initTestAuth, authHeaders, liveUser, cleanupLiveUsers } from './helpers.ts';

/** One captured delivery. */
interface Capture {
  event: string;
  payload: any;
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  /** request path the delivery landed on (event-filter differentiation). */
  url: string;
}

let receiver: http.Server;
let receiverPort = 0;
const captured: Capture[] = [];

function hookUrl(path = '/hook'): string {
  // The server runs inside Docker — host.docker.internal reaches the host
  // (the test's receiver), while 127.0.0.1 would be the container's own loopback.
  return `http://host.docker.internal:${receiverPort}${path}`;
}

async function waitForEvent(matcher: (p: any) => boolean, timeoutMs = 12_000): Promise<Capture> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hit = captured.find((c) => matcher(c.payload));
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Timed out waiting for webhook delivery');
}

function sign(secret: string, hmacSecret: string): string {
  return createHmac('sha256', hmacSecret).update(secret).digest('hex');
}

function verifySignature(cap: Capture, secret: string): boolean {
  const ts = cap.headers['x-madar-timestamp'] as string;
  if (!ts) return false;
  const expected = `sha256=${sign(cap.rawBody, secret)}`;
  return cap.headers['x-madar-signature'] === expected;
}

// A REAL account per role: verifyToken refuses an id that is not in users.json,
// so a ghost id would turn every 403 row below into a bare 401.
async function forger(role: 'viewer' | 'editor', key: string) {
  const user = await liveUser(role, key);
  return { headers: { ...authHeaders(), Authorization: `Bearer ${user.token}` } };
}

const createdSlugs: string[] = [];
const whIds: string[] = [];

const P1_PORT = 8961;
const P2_PORT = 8962;
let webhookId = '';

describe('Webhooks & notifications', () => {
  before(async () => {
    await initTestAuth();

    receiver = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        let payload: any = {};
        try {
          payload = JSON.parse(rawBody);
        } catch {
          /* receiver tolerant of junk */
        }
        captured.push({ event: String(payload.event || ''), payload, headers: req.headers, rawBody, url: req.url || '' });
        res.setHeader('Content-Type', 'application/json');
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((r) => receiver.listen(0, '0.0.0.0', r));
    receiverPort = (receiver.address() as any).port;
  });

  after(async () => {
    for (const slug of createdSlugs) {
      try { await reqAuth('DELETE', `/projects/${slug}`); } catch { /* best effort */ }
    }
    const list = await reqAuth('GET', '/webhooks').catch(() => null);
    if (list && list.status === 200) {
      const ws = (await list.json()).webhooks as any[];
      for (const w of ws) {
        try { await reqAuth('DELETE', `/webhooks/${w.id}`); } catch { /* best effort */ }
      }
    }
    receiver?.close();
    await cleanupLiveUsers();
  });

  test('validation: missing name / url / bad scheme / bad length secret → 400', async () => {
    const bad = [
      { url: hookUrl() },
      { name: 'No URL' },
      { name: 'Ftp', url: 'ftp://example.com/hook' },
      { name: 'Meta', url: 'http://169.254.169.254/' },
      { name: 'LongSecret', url: hookUrl(), secret: 'x'.repeat(300) },
    ];
    for (const body of bad) {
      const r = await reqAuth('POST', '/webhooks', body);
      assert.strictEqual(r.status, 400, `expected 400 for ${JSON.stringify(body).slice(0, 60)}`);
    }
  });

  test('create → masked secret (hasSecret), junk events sanitized, list reflects it', async () => {
    const r = await reqAuth('POST', '/webhooks', {
      name: 'Suite hook',
      url: hookUrl(),
      events: ['created', 'bogus-event', 'started', 'stopped', 'deleted', 'snapshot-saved', 'crash'],
      secret: 's3cret-hmac-1',
    });
    assert.strictEqual(r.status, 201);
    const { webhook } = await r.json();
    webhookId = webhook.id;
    whIds.push(webhookId);

    assert.strictEqual(webhook.hasSecret, true);
    assert.ok(!('secret' in webhook), 'signing secret must never be echoed');
    assert.deepStrictEqual(
      [...webhook.events].sort(),
      ['crash', 'created', 'deleted', 'snapshot-saved', 'started', 'stopped'],
      'junk events dropped'
    );
    assert.strictEqual(webhook.name, 'Suite hook');

    const list = await reqAuth('GET', '/webhooks');
    assert.strictEqual(list.status, 200);
    const { webhooks } = await list.json();
    const found = webhooks.find((w: any) => w.id === webhookId);
    assert.ok(found);
    assert.strictEqual(found.hasSecret, true);
    assert.ok(!('secret' in found));
  });

  test('created project fires an HMAC-signed "created" delivery', async () => {
    const slug = uniqueId('wh-created');
    createdSlugs.push(slug);
    const c = await reqAuth('POST', '/projects', { name: 'Webhook Created', slug, ports: [P1_PORT] });
    assert.strictEqual(c.status, 201);

    const cap = await waitForEvent((p) => p.event === 'created' && p.slug === slug);
    assert.strictEqual(cap.payload.name, 'Webhook Created');
    assert.ok(cap.payload.at);
    assert.ok(verifySignature(cap, 's3cret-hmac-1'), 'HMAC signature must match the raw body');
    assert.ok((cap.headers['user-agent'] as string)?.startsWith('Madar/'));
  });

  test('snapshot capture-now fires a "snapshot-saved" delivery', async () => {
    const slug = uniqueId('wh-snap');
    createdSlugs.push(slug);
    const c = await reqAuth('POST', '/projects', { name: 'Webhook Snap', slug, ports: [P2_PORT] });
    assert.strictEqual(c.status, 201);
    await waitForEvent((p) => p.event === 'created' && p.slug === slug);

    const snap = await reqAuth('POST', `/projects/${slug}/snapshots`);
    assert.strictEqual(snap.status, 201, 'capture-now must succeed');

    const cap = await waitForEvent((p) => p.event === 'snapshot-saved' && p.slug === slug);
    assert.match(cap.payload.file, /^madar-.+\.tar\.gz$/);
    assert.ok(cap.payload.size > 0);
    assert.ok(verifySignature(cap, 's3cret-hmac-1'));
  });

  test('stop then delete the project fire "stopped" and "deleted"', async () => {
    const slug = uniqueId('wh-stop');
    createdSlugs.push(slug);
    const c = await reqAuth('POST', '/projects', { name: 'Webhook Stop', slug });
    assert.strictEqual(c.status, 201);
    await waitForEvent((p) => p.event === 'created' && p.slug === slug);

    const s = await reqAuth('POST', `/projects/${slug}/stop`);
    assert.strictEqual(s.status, 200);
    await waitForEvent((p) => p.event === 'stopped' && p.slug === slug);

    const d = await reqAuth('DELETE', `/projects/${slug}`);
    assert.strictEqual(d.status, 200);
    await waitForEvent((p) => p.event === 'deleted' && p.slug === slug);
  });

  test('event filtering: a crash-only webhook never receives lifecycle traffic', async () => {
    const r = await reqAuth('POST', '/webhooks', {
      name: 'Crash-only',
      url: hookUrl('/crash-only'),
      events: ['crash'],
      secret: 'crash-secret',
    });
    assert.strictEqual(r.status, 201);
    const { webhook } = await r.json();
    whIds.push(webhook.id);
    assert.deepStrictEqual(webhook.events, ['crash']);

    const slug = uniqueId('wh-filter');
    createdSlugs.push(slug);
    const c = await reqAuth('POST', '/projects', { name: 'Webhook Filter', slug });
    assert.strictEqual(c.status, 201);
    await waitForEvent((p) => p.event === 'created' && p.slug === slug);

    await new Promise((r2) => setTimeout(r2, 700));
    const crashOnlyHits = captured.filter((c2) => c2.url === '/crash-only');
    assert.strictEqual(crashOnlyHits.length, 0, 'a crash-only webhook must be excluded from created events');
  });

  test('partial update: rename, swap events, drop the secret, disable', async () => {
    const r = await reqAuth('PUT', `/webhooks/${webhookId}`, {
      name: 'Suite hook renamed',
      events: ['deleted'],
      secret: '',
      enabled: false,
    });
    assert.strictEqual(r.status, 200);
    const { webhook } = await r.json();
    assert.strictEqual(webhook.name, 'Suite hook renamed');
    assert.deepStrictEqual(webhook.events, ['deleted']);
    assert.strictEqual(webhook.hasSecret, false, "'' clears the secret");
    assert.strictEqual(webhook.enabled, false);

    // Disabled → no longer delivered to. Re-enable for the remaining tests.
    await reqAuth('PUT', `/webhooks/${webhookId}`, { enabled: true, name: 'Suite hook', events: ['created', 'stopped', 'deleted', 'snapshot-saved', 'crash'] });
  });

  test('manual Test endpoint: saved id and raw url modes, both hit the receiver', async () => {
    const t1 = await reqAuth('POST', '/webhooks/test', { id: webhookId });
    assert.strictEqual(t1.status, 200);
    const r1 = await t1.json();
    assert.deepStrictEqual({ ok: r1.ok, status: r1.status }, { ok: true, status: 200 });

    const t2 = await reqAuth('POST', '/webhooks/test', { url: hookUrl() });
    assert.strictEqual(t2.status, 200);
    assert.strictEqual((await t2.json()).ok, true);

    assert.strictEqual((await reqAuth('POST', '/webhooks/test', {})).status, 400);
    assert.strictEqual((await reqAuth('POST', '/webhooks/test', { id: 'does-not-exist' })).status, 404);
  });

  test('access matrix: viewer and editor tokens are 403 on every webhook route', async () => {
    const viewer = await forger('viewer', 'wh-viewer');
    const editor = await forger('editor', 'wh-editor');
    for (const h of [viewer, editor]) {
      assert.strictEqual(await req('GET', '/webhooks', undefined, h.headers).then(r => r.status), 403);
      assert.strictEqual(await req('POST', '/webhooks', { name: 'x', url: hookUrl() }, h.headers).then(r => r.status), 403);
      assert.strictEqual(await req('PUT', `/webhooks/${webhookId}`, { name: 'y' }, h.headers).then(r => r.status), 403);
      assert.strictEqual(await req('DELETE', `/webhooks/${webhookId}`, undefined, h.headers).then(r => r.status), 403);
      assert.strictEqual(await req('POST', '/webhooks/test', { id: webhookId }, h.headers).then(r => r.status), 403);
    }
  });

  test('unknown id → 404 on update and delete', async () => {
    assert.strictEqual((await reqAuth('PUT', '/webhooks/nope', { name: 'x' })).status, 404);
    assert.strictEqual((await reqAuth('DELETE', '/webhooks/nope')).status, 404);
  });

  test('delete removes the webhook for good', async () => {
    const extra = await reqAuth('POST', '/webhooks', { name: 'To delete', url: hookUrl() });
    assert.strictEqual(extra.status, 201);
    const { webhook } = await extra.json();
    whIds.push(webhook.id);

    const d = await reqAuth('DELETE', `/webhooks/${webhook.id}`);
    assert.strictEqual(d.status, 200);
    const list = await reqAuth('GET', '/webhooks');
    const ids = ((await list.json()).webhooks as any[]).map((w: any) => w.id);
    assert.ok(!ids.includes(webhook.id), 'deleted webhook must not be listed');
  });

  test('webhook cap: 51st is rejected (runs last — fills the store)', async () => {
    const list = await reqAuth('GET', '/webhooks');
    const existing = ((await list.json()).webhooks as any[]).length;
    const toCreate = 50 - existing + 1;
    let last: any;
    for (let i = 0; i < toCreate; i += 1) {
      last = await reqAuth('POST', '/webhooks', {
        name: `Cap #${i}`,
        url: `${hookUrl()}?i=${i}`,
        events: ['crash'],
      });
      if (last.status === 201) whIds.push((await last.json()).webhook.id);
      if (i === toCreate - 1) break;
    }
    assert.strictEqual(last.status, 400, '51st webhook must be refused');
    assert.match((await last.json()).error, /Too many webhooks/);
  });
});
