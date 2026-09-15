/**
 * stress.test.ts — Stress / performance / stability for Madar.
 *
 * Runs against the LIVE container (no Docker project creation — only chat-team
 * channels/messages and light GET endpoints).
 *
 * Rate-limit budgeting (analyzed from src/index.ts + chat-team-routes.ts):
 *   global budget      240/min prod · 4 000/min WSD_TESTING=1 (everything
 *                       except /health, which is exempt)
 *   chat write budget  240/min per-user (chatWriteLimiter — NOT relaxed by
 *                       WSD_TESTING) → total writes stay far below 240
 *   user write budget  120/min per-user (unused here)
 *
 * Run the suite with the container under WSD_TESTING=1 (see repo AGENTS.md) —
 * the file paces itself adaptively so it also stays under production budgets
 * when WSD_TESTING=0.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import WebSocket from 'ws';
import { uniqueId, initTestAuth, signTestToken, reqAuth, API_URL } from './helpers.ts';

// ── Constants ──────────────────────────────────────────────────
const WS_BASE = (process.env.WSD_TEST_API_URL || 'http://127.0.0.1:3000/api')
  .replace('/api', '')
  .replace(/^http/, 'ws');
const CHAT_BASE = '/chat-team';
const IS_TESTING = process.env.WSD_TESTING === '1';
// Adaptive pacing: under production limits, slow down to stay under 240/min.
const INTER_REQUEST_MS = IS_TESTING ? 5 : 350;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Fetch helper that measures pure request latency (retry-on-429 included).
async function timedReq(
  method: string,
  urlPath: string,
  body?: unknown
): Promise<{ status: number; ms: number; json?: any }> {
  const t0 = performance.now();
  let res = await fetch(`${API_URL}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${signTestToken()}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get('Retry-After') || '5');
    await sleep(Math.min(retryAfter * 1000, 8000));
    res = await fetch(`${API_URL}${urlPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${signTestToken()}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }
  const ms = performance.now() - t0;
  let json: any = undefined;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, ms, json };
}

function stats(name: string, latencies: number[]): void {
  const sorted = [...latencies].sort((a, b) => a - b);
  const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))].toFixed(1);
  console.log(`  ${name}: n=${sorted.length} avg=${(sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(1)}ms ` +
    `p50=${p(0.5)}ms p95=${p(0.95)}ms max=${sorted[sorted.length - 1].toFixed(1)}ms`);
}

// ── Tracked channels (deleted in after) ────────────────────────
const createdChannelIds: string[] = [];

async function cleanupChannels(): Promise<void> {
  for (const id of createdChannelIds) {
    try { await reqAuth('DELETE', `${CHAT_BASE}/channels/${id}`); } catch { /* gone */ }
  }
  createdChannelIds.length = 0;
}

async function makeChannel(name: string): Promise<string> {
  const res = await timedReq('POST', `${CHAT_BASE}/channels`, { name });
  assert.strictEqual(res.status, 201, `channel create failed: ${res.status} ${JSON.stringify(res.json)}`);
  const id = res.json!.channel.id;
  createdChannelIds.push(id);
  return id;
}

// ── Suite ─────────────────────────────────────────────────────
describe('Stress & Performance', () => {
  before(async () => { await initTestAuth(); });
  after(async () => { await cleanupChannels(); });

  // ═══════════════════════════════════════════════════════════
  // 1. API THROUGHPUT
  // ═══════════════════════════════════════════════════════════
  describe('1. API Throughput', () => {

    test('GET /health ×100 sequential — average < 50 ms', async () => {
      const N = 100;
      const latencies: number[] = [];
      const t0 = performance.now();

      for (let i = 0; i < N; i++) {
        const { status, ms } = await timedReq('GET', '/health');
        assert.strictEqual(status, 200, `iter ${i}: expected 200, got ${status}`);
        latencies.push(ms);
        if (i < N - 1) await sleep(INTER_REQUEST_MS);
      }

      const totalMs = performance.now() - t0;
      const avg = latencies.reduce((a, b) => a + b, 0) / N;
      stats('GET /health', latencies);

      assert.ok(avg < 50, `avg /health latency ${avg.toFixed(1)}ms exceeds 50ms budget`);
      assert.ok(Math.max(...latencies) < 2000, `max latency ${Math.max(...latencies).toFixed(0)}ms exceeds 2s stall threshold`);
      console.log(`  total wall time: ${totalMs.toFixed(0)}ms`);
    }, { timeout: 60_000 });

    test('GET /projects ×50 sequential — measures baseline', async () => {
      const N = 50;
      const latencies: number[] = [];

      for (let i = 0; i < N; i++) {
        const { status, ms } = await timedReq('GET', '/projects');
        assert.strictEqual(status, 200, `iter ${i}: expected 200, got ${status}`);
        latencies.push(ms);
        if (i < N - 1) await sleep(INTER_REQUEST_MS);
      }

      const avg = latencies.reduce((a, b) => a + b, 0) / N;
      stats('GET /projects', latencies);

      assert.ok(avg < 1000, `avg /projects latency ${avg.toFixed(1)}ms exceeds 1s budget`);
      assert.ok(Math.max(...latencies) < 5000, 'single request exceeded 5s stall threshold');
    }, { timeout: 60_000 });

    test('POST /chat-team/channels ×20 — create all, cleanup in after()', async () => {
      const N = 20;
      const latencies: number[] = [];

      for (let i = 0; i < N; i++) {
        const res = await timedReq('POST', `${CHAT_BASE}/channels`, { name: uniqueId('stress-ch') });
        assert.strictEqual(res.status, 201, `iter ${i}: expected 201, got ${res.status}`);
        createdChannelIds.push(res.json!.channel.id);
        latencies.push(res.ms);
        if (i < N - 1) await sleep(INTER_REQUEST_MS);
      }

      const avg = latencies.reduce((a, b) => a + b, 0) / N;
      stats('POST /channels', latencies);

      assert.ok(avg < 1000, `avg channel-create latency ${avg.toFixed(1)}ms exceeds 1s budget`);
    }, { timeout: 60_000 });
  });

  // ═══════════════════════════════════════════════════════════
  // 2. WEBSOCKET CONCURRENCY
  // ═══════════════════════════════════════════════════════════
  describe('2. WebSocket Concurrency', () => {

    test('10 concurrent /ws/chat-team connections — all open', async () => {
      const N = 10;
      const token = signTestToken();
      const url = `${WS_BASE}/ws/chat-team?token=${encodeURIComponent(token)}`;

      const results = await Promise.all(
        Array.from({ length: N }, () =>
          new Promise<'open' | 'error' | 'closed'>((resolve) => {
            const ws = new WebSocket(url);
            const to = setTimeout(() => { try { ws.terminate(); } catch { /* gone */ } resolve('closed'); }, 8000);
            ws.on('open', () => { clearTimeout(to); try { ws.terminate(); } catch { /* gone */ } resolve('open'); });
            ws.on('error', () => { clearTimeout(to); resolve('error'); });
            ws.on('close', () => { clearTimeout(to); resolve('closed'); });
          })
        )
      );

      const opens = results.filter((r) => r === 'open').length;
      console.log(`  ${opens}/${N} connections opened`);
      assert.strictEqual(opens, N, `expected all ${N} to open, got ${opens}`);
    }, { timeout: 30_000 });

    test('broadcast: 10 sockets subscribed → 1 REST send → all receive (< 500ms fan-out)', async () => {
      const N = 10;
      const token = signTestToken();
      const channelId = await makeChannel(uniqueId('bcast'));
      const sendText = `stress-bcast-${Date.now().toString(36)}`;

      const sockets: WebSocket[] = [];
      const received = new Array<boolean>(N).fill(false);
      const fanoutMs = new Array<number>(N).fill(-1);

      // Open all sockets and subscribe each to the channel.
      await Promise.all(Array.from({ length: N }, (_, i) =>
        new Promise<void>((resolve, reject) => {
          const ws = new WebSocket(`${WS_BASE}/ws/chat-team?token=${encodeURIComponent(token)}`);
          sockets.push(ws);
          const to = setTimeout(() => reject(new Error(`socket ${i}: subscribed timeout`)), 10_000);
          ws.on('open', () => ws.send(JSON.stringify({ type: 'subscribe', channelId })));
          ws.on('message', (d) => {
            const f = JSON.parse(d.toString());
            if (f.type === 'subscribed' && f.channelId === channelId) {
              clearTimeout(to);
              resolve();
            }
          });
          ws.on('error', (e) => { clearTimeout(to); reject(e); });
        })
      ));

      // Response-received timestamp is the fan-out baseline: the server
      // broadcasts to subscribers BEFORE res.status(201) is sent.
      let responseTs = 0;
      sockets.forEach((ws, i) => {
        ws.on('message', (d) => {
          const f = JSON.parse(d.toString());
          if (f.type === 'message' && f.channel?.id === channelId && f.message?.text === sendText) {
            received[i] = true;
            if (responseTs > 0) fanoutMs[i] = performance.now() - responseTs;
          }
        });
      });

      await sleep(100); // let all subscriptions settle on the server
      // Timestamp BEFORE the POST: the server broadcasts to subscribers before
      // responding, so a WS frame can beat the HTTP response back to us.
      responseTs = performance.now();
      const post = await timedReq('POST', `${CHAT_BASE}/messages`, { channelId, text: sendText });
      assert.strictEqual(post.status, 201);
      assert.ok(post.ms < 10_000, `REST send took ${post.ms.toFixed(0)}ms`);

      const deadline = performance.now() + 5000;
      while (performance.now() < deadline && !received.every(Boolean)) await sleep(50);

      for (const ws of sockets) { try { ws.terminate(); } catch { /* gone */ } }

      const got = received.filter(Boolean).length;
      const fanouts = fanoutMs.filter((v) => v >= 0);
      const p95 = (arr: number[]) => {
        if (arr.length === 0) return 0;
        const s = [...arr].sort((a, b) => a - b);
        return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
      };

      console.log(`  broadcast: ${got}/${N} received, fan-out p95=${p95(fanouts).toFixed(1)}ms max=` +
        `${fanouts.length ? Math.max(...fanouts).toFixed(1) : 'n/a'}ms`);
      assert.strictEqual(got, N, `expected all ${N} sockets to receive, got ${got}`);
      assert.ok(fanouts.length >= N, 'every receiving socket must be timestamped');
      assert.ok(p95(fanouts) < 500, `broadcast p95 ${p95(fanouts).toFixed(1)}ms exceeds 500ms budget`);
      assert.ok(responseTs > 0, 'REST send must have completed');
    }, { timeout: 30_000 });
  });

  // ═══════════════════════════════════════════════════════════
  // 3. MESSAGE THROUGHPUT
  // ═══════════════════════════════════════════════════════════
  describe('3. Message Throughput', () => {

    test('50 sequential messages to one channel — all persist, zero loss', async () => {
      const N = 50;
      const channelId = await makeChannel(uniqueId('msgs'));
      const t0 = performance.now();
      const sent: string[] = [];
      const latencies: number[] = [];

      for (let i = 0; i < N; i++) {
        const res = await timedReq('POST', `${CHAT_BASE}/messages`, {
          channelId,
          text: `stress-msg-${i}`,
        });
        assert.strictEqual(res.status, 201, `msg ${i}: expected 201, got ${res.status}`);
        sent.push(res.json!.message.id);
        latencies.push(res.ms);
        if (i < N - 1) await sleep(INTER_REQUEST_MS);
      }

      const sendTotalMs = performance.now() - t0;
      stats('POST /messages', latencies);

      // Verify nothing was dropped: every sent id is readable back.
      const list = await timedReq('GET', `${CHAT_BASE}/channels/${channelId}/messages`);
      assert.strictEqual(list.status, 200);
      const ids = new Set(list.json!.messages.map((m: any) => m.id));
      const lost = sent.filter((id) => !ids.has(id));

      console.log(`  sent=${sent.length} readable=${ids.size} lost=${lost.length} total-send-time=${sendTotalMs.toFixed(0)}ms`);
      assert.strictEqual(lost.length, 0, `lost messages: ${lost.join(', ')}`);
    }, { timeout: 90_000 });
  });

  // ═══════════════════════════════════════════════════════════
  // 4. STABILITY — 30 s mixed activity, no 5xx
  // ═══════════════════════════════════════════════════════════
  describe('4. Stability', () => {

    test('30s mixed GET/POST/WS — zero 5xx and zero connection failures', async () => {
      const DURATION_MS = 30_000;
      const deadline = performance.now() + DURATION_MS;

      const channelId = await makeChannel(uniqueId('stab'));
      const token = signTestToken();
      const ws = new WebSocket(`${WS_BASE}/ws/chat-team?token=${encodeURIComponent(token)}`);

      await new Promise<void>((resolve, reject) => {
        const to = setTimeout(() => reject(new Error('WS subscribe timeout')), 8000);
        ws.on('open', () => ws.send(JSON.stringify({ type: 'subscribe', channelId })));
        ws.on('message', (d) => {
          const f = JSON.parse(d.toString());
          if (f.type === 'subscribed' && f.channelId === channelId) { clearTimeout(to); resolve(); }
        });
        ws.on('error', (e) => { clearTimeout(to); reject(e); });
      });

      const errors: string[] = [];
      const counts = { get: 0, post: 0, typing: 0 };
      // Hard cap on chat writes: the chatWriteLimiter budget is 240/min per
      // user and is NOT relaxed by WSD_TESTING — the GET stream absorbs the
      // remaining time.
      const MAX_POSTS = 80;
      const pacing = IS_TESTING ? 100 : 600;
      let msgCounter = 0;
      let wsDropped = false;

      while (performance.now() < deadline) {
        try {
          const r = Math.random();
          if (r < 0.45) {
            const path = Math.random() < 0.5 ? '/health' : '/projects';
            const res = await timedReq('GET', path);
            counts.get++;
            if (res.status >= 500) errors.push(`GET ${path} → ${res.status}`);
          } else if (r < 0.65 && counts.post < MAX_POSTS) {
            const res = await timedReq('POST', `${CHAT_BASE}/messages`, { channelId, text: `stab-${msgCounter++}` });
            counts.post++;
            if (res.status >= 500) errors.push(`POST msg → ${res.status}`);
          } else {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'typing_start', channelId }));
              counts.typing++;
            } else {
              wsDropped = true;
            }
          }
        } catch (err) {
          errors.push(`exception: ${(err as Error).message}`);
        }
        await sleep(pacing);
      }

      try { ws.terminate(); } catch { /* gone */ }

      console.log(`  ops: GET=${counts.get} POST=${counts.post} WS-typing=${counts.typing}`);
      console.log(`  errors: ${errors.length}`);
      if (errors.length) errors.forEach((e) => console.log(`    ! ${e}`));

      assert.strictEqual(errors.length, 0, `errors during stability: ${errors.join('; ')}`);
      assert.ok(!wsDropped, 'the WS connection must stay alive for the whole run');
      const totalOps = counts.get + counts.post + counts.typing;
      assert.ok(totalOps > 20, `expected >20 ops in 30s, got ${totalOps}`);
    }, { timeout: 60_000 });
  });

  // ═══════════════════════════════════════════════════════════
  // 5. RESOURCE / MEMORY STABILITY
  // ═══════════════════════════════════════════════════════════
  describe('5. Resource Stability', () => {

    test('20 rapid WS open/subscribe/close cycles — no leak, server stays healthy', async () => {
      const N = 20;
      const token = signTestToken();
      const channelId = await makeChannel(uniqueId('mem'));
      const url = `${WS_BASE}/ws/chat-team?token=${encodeURIComponent(token)}`;

      for (let i = 0; i < N; i++) {
        const ws = new WebSocket(url);
        await new Promise<void>((resolve) => {
          const to = setTimeout(() => { try { ws.terminate(); } catch { /* gone */ } resolve(); }, 4000);
          ws.on('open', () => ws.send(JSON.stringify({ type: 'subscribe', channelId })));
          ws.on('message', (d) => {
            const f = JSON.parse(d.toString());
            if (f.type === 'subscribed' && f.channelId === channelId) {
              clearTimeout(to);
              try { ws.close(); } catch { /* gone */ }
              resolve();
            }
          });
          ws.on('error', () => { clearTimeout(to); resolve(); });
          ws.on('close', () => { clearTimeout(to); resolve(); });
        });
        await sleep(IS_TESTING ? 20 : 100);
      }

      // The server must still answer health and the channel must still work.
      const health = await timedReq('GET', '/health');
      assert.strictEqual(health.status, 200, 'server must respond after rapid WS churn');
      const info = await timedReq('GET', `${CHAT_BASE}/channels/${channelId}`);
      assert.strictEqual(info.status, 200, 'channel store must remain consistent');
      console.log(`  ${N} rapid WS cycles — server healthy`);
    }, { timeout: 60_000 });
  });
});