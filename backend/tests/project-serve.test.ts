import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import jwt from 'jsonwebtoken';
import { execSync, execFileSync } from 'node:child_process';
import { uniqueId, req, reqAuth, initTestAuth, JWT_SECRET, authHeaders } from './helpers.ts';

/**
 * Project static-site serve (`python3 -m http.server <port> -d /workspace`
 * inside the project container):
 *  - POST /api/projects/:slug/serve (editor+) starts the server on a published
 *    port, persisting meta.serve={enabled:true,port,pid} only after a live
 *    host-side HTTP probe confirms it is really serving.
 *  - POST /api/projects/:slug/serve/stop (editor+) kills the process and
 *    flips enabled:false.
 *  - GET /api/projects/:slug/serve (viewer+) reports honest live state.
 *  - GET /api/projects carries serve config (config-only, active:false by
 *    design — the list never does N+1 per-project probes).
 *  - docker-manager auto re-runs the server after container start/recreate
 *    when meta.serve.enabled is set (ensureServeRunning — never throws).
 *
 * Errors:
 *  - 400 "No ports published for this project" (project with no published ports)
 *  - 400 "Port N is not a published port of this project"
 *  - 409 "Project is stopped. Start it first." (container not running)
 *  - 409 "Port N is already in use inside the container" (probe never answers)
 *
 * p1 starts with a single published port (8931) and is mutated sequentially:
 * start → host probe → stop → restart persistence → recreate persistence →
 * validation → access matrix → occupied-port 409 (a second port, 8933, is
 * published for that one case). Order-dependent by design (single shared real
 * container, mirroring project-limits.test.ts).
 */

const createdSlugs: string[] = [];
const createdUserIds: string[] = [];

const P1_PORT = 8931;
const P2_PORT = 8933; // added at 409-time: a never-served second published port

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function memberAuth(id: string, username: string, role: string) {
  const token = jwt.sign({ id, username, role, tv: 0 }, JWT_SECRET, { expiresIn: '24h' });
  return { headers: { ...authHeaders(), Authorization: `Bearer ${token}` } };
}

async function postServe(slug: string, body?: unknown, headers: Record<string, string> = authHeaders()): Promise<{ status: number; json: any }> {
  const r = await req('POST', `/projects/${slug}/serve`, body, headers);
  let json: any = {};
  try { json = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, json };
}

async function stopServe(slug: string, headers: Record<string, string> = authHeaders()): Promise<{ status: number; json: any }> {
  const r = await req('POST', `/projects/${slug}/serve/stop`, undefined, headers);
  let json: any = {};
  try { json = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, json };
}

async function getServe(slug: string, headers: Record<string, string> = authHeaders()): Promise<{ status: number; json: any }> {
  const r = await req('GET', `/projects/${slug}/serve`, undefined, headers);
  let json: any = {};
  try { json = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, json };
}

/**
 * HTTP GET the published host port from the test runner (the container binds
 * 0.0.0.0, so 127.0.0.1:<port> works). Retries briefly — the serve POST has
 * already probed to active, but Docker Desktop port forwarding can lag.
 */
async function hostGet(port: number, retries = 8): Promise<{ status: number; body: string }> {
  let last = { status: 0, body: '' };
  for (let i = 0; i < retries; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) });
      last = { status: r.status, body: await r.text() };
      if (r.status >= 200 && r.status < 400) return last;
    } catch {
      last = { status: 0, body: '' };
    }
    await sleep(1000);
  }
  return last;
}

describe('Project static-site serve (python3 http.server)', () => {
  let p1 = '';
  let p2 = '';
  let marker = '';
  let viewerUser: any;
  let editorUser: any;

  before(async () => {
    // Clear any orphaned wsd.managed containers from crashed runs so a stale
    // holder can never grab the published port the serve probes. `2>NUL`
    // silences the "no such container" noise on Windows (2>/dev/null on Linux).
    try {
      execSync('docker rm -f $(docker ps -aq --filter label=wsd.managed=true) 2>NUL', {
        timeout: 15000,
        stdio: 'pipe',
      });
    } catch { /* no orphan containers */ }
    await initTestAuth();

    p1 = uniqueId('srv-a');
    createdSlugs.push(p1);
    const c1 = await reqAuth('POST', '/projects', {
      name: 'Serve A',
      slug: p1,
      description: 'static-site serve fixture',
      ports: [P1_PORT],
    });
    assert.strictEqual(c1.status, 201, `p1 create: ${c1.status} ${(await c1.json()).error || ''}`);

    // Seed index.html with a unique marker so the served response is provably OURS.
    marker = `serve-${p1}`;
    const up = await reqAuth('PUT', `/projects/${p1}/file?path=index.html`, {
      content: `<!doctype html><html><body><h1>${marker}</h1></body></html>`,
    });
    assert.strictEqual(up.status, 200, `index.html write: ${up.status}`);

    // Second project WITHOUT published ports — POST /serve must 400 on it.
    p2 = uniqueId('srv-b');
    createdSlugs.push(p2);
    const c2 = await reqAuth('POST', '/projects', { name: 'Serve B (no ports)', slug: p2 });
    assert.strictEqual(c2.status, 201, `p2 create: ${c2.status}`);

    const vu = await reqAuth('POST', '/users', { username: uniqueId('srv-view'), password: 'Pw-123456!', role: 'viewer' });
    assert.strictEqual(vu.status, 201, 'viewer user create');
    viewerUser = await vu.json();
    createdUserIds.push(viewerUser.id);
    const eu = await reqAuth('POST', '/users', { username: uniqueId('srv-edit'), password: 'Pw-123456!', role: 'editor' });
    assert.strictEqual(eu.status, 201, 'editor user create');
    editorUser = await eu.json();
    createdUserIds.push(editorUser.id);

    const mv = await reqAuth('POST', `/projects/${p1}/members`, { userId: viewerUser.id, role: 'viewer' });
    assert.strictEqual(mv.status, 200, 'add viewer member');
    const me = await reqAuth('POST', `/projects/${p1}/members`, { userId: editorUser.id, role: 'editor' });
    assert.strictEqual(me.status, 200, 'add editor member');
  });

  after(async () => {
    // Stop serve (best-effort) before deleting so the python process dies first.
    try {
      const s = await getServe(p1);
      if (s.status === 200 && s.json.serve?.enabled) await stopServe(p1);
    } catch { /* best effort */ }
    for (const slug of createdSlugs) {
      try { await reqAuth('DELETE', `/projects/${slug}`); } catch { /* best effort */ }
    }
    for (const id of createdUserIds) {
      try { await reqAuth('DELETE', `/users/${id}`); } catch { /* best effort */ }
    }
  });

  test('start serving: live probe active, served marker reachable, list carries config', async () => {
    const { status, json } = await postServe(p1, { port: P1_PORT });
    assert.strictEqual(status, 200, `start serve: ${status} ${json.error || ''}`);
    assert.strictEqual(json.serve.enabled, true, 'enabled persisted');
    assert.strictEqual(json.serve.active, true, 'live probe active right after start');
    assert.strictEqual(json.serve.port, P1_PORT, 'port echoed');
    assert.strictEqual(json.serve.hostPort, String(P1_PORT), 'host port maps 1:1');

    // The test runner hits the published host port directly.
    const h = await hostGet(P1_PORT);
    assert.strictEqual(h.status, 200, `host GET / → ${h.status} ${h.body.slice(0, 80)}`);
    assert.ok(h.body.includes(marker), `served body carries marker '${marker}'`);

    const s = await getServe(p1);
    assert.strictEqual(s.status, 200, 'GET serve 200');
    assert.strictEqual(s.json.serve.enabled, true);
    assert.strictEqual(s.json.serve.active, true, 'status endpoint probes live state');

    // The list is config-only by design (no N+1 probes): enabled ticks,
    // active is honestly false there even while serving.
    const list = await reqAuth('GET', '/projects');
    assert.strictEqual(list.status, 200, 'project list 200');
    const p = (await list.json()).projects.find((x: any) => x.slug === p1);
    assert.ok(p, 'p1 present in the list');
    assert.strictEqual(p.serve.enabled, true, 'list carries serve.enabled');
    assert.strictEqual(p.serve.active, false, 'list is config-only (active false)');
  });

  test('stop serving: enabled false, port stops answering', async () => {
    const { status, json } = await stopServe(p1);
    assert.strictEqual(status, 200, `stop serve: ${status} ${json.error || ''}`);
    assert.strictEqual(json.serve.enabled, false, 'enabled flipped off');
    assert.strictEqual(json.serve.active, false, 'no active serve after stop');

    let refused = false;
    try {
      const r = await fetch(`http://127.0.0.1:${P1_PORT}/`, { signal: AbortSignal.timeout(3000) });
      refused = !(r.status >= 200 && r.status < 400);
    } catch {
      refused = true;
    }
    assert.ok(refused, 'port no longer answers HTTP after stop');

    const s = await getServe(p1);
    assert.strictEqual(s.json.serve.enabled, false, 'status reflects the disable');
    assert.strictEqual(s.json.serve.active, false);
  });

  test('restart persistence: serve auto re-runs after container stop → start', async () => {
    const re = await postServe(p1, { port: P1_PORT });
    assert.strictEqual(re.status, 200, `re-start serve: ${re.status} ${re.json.error || ''}`);
    assert.strictEqual(re.json.serve.active, true, 'serve back up');

    const st = await reqAuth('POST', `/projects/${p1}/stop`);
    assert.strictEqual(st.status, 200, 'stop container');
    const start = await reqAuth('POST', `/projects/${p1}/start`);
    assert.strictEqual(start.status, 200, 'start container');

    const s = await getServe(p1);
    assert.strictEqual(s.status, 200);
    assert.strictEqual(s.json.serve.enabled, true, 'serve config survives the stop/start');
    assert.strictEqual(s.json.serve.active, true, 'ensureServeRunning re-launched http.server after start');

    const h = await hostGet(P1_PORT);
    assert.strictEqual(h.status, 200, 'served again after restart');
    assert.ok(h.body.includes(marker), 'marker served after restart');
  });

  test('recreate persistence: serve auto re-runs after container recreate', async () => {
    const rc = await reqAuth('POST', `/projects/${p1}/recreate`);
    assert.strictEqual(rc.status, 200, `recreate: ${rc.status} ${(await rc.json()).error || ''}`);

    const s = await getServe(p1);
    assert.strictEqual(s.json.serve.enabled, true, 'serve config preserved through recreate');
    assert.strictEqual(s.json.serve.active, true, 'serve re-run after recreate');

    const h = await hostGet(P1_PORT);
    assert.strictEqual(h.status, 200, 'served after recreate');
    assert.ok(h.body.includes(marker), 'marker served after recreate');
  });

  test('validation: non-published port 400, no-ports project 400, stopped container 409', async () => {
    // Port not in this project's published set → 400; the running serve is untouched.
    const bad = await postServe(p1, { port: P1_PORT + 100 });
    assert.strictEqual(bad.status, 400, `non-published port → 400, got ${bad.status}`);
    assert.match(bad.json.error || '', /not a published port/i);
    const alive = await getServe(p1);
    assert.strictEqual(alive.json.serve.active, true, 'rejected edit leaves the running serve alone');

    // A project with zero published ports → 400 at sanitize time, before any exec.
    const none = await postServe(p2);
    assert.strictEqual(none.status, 400, `no-ports project → 400, got ${none.status} ${none.json.error || ''}`);
    assert.match(none.json.error || '', /no ports published/i);

    // Stopped container → 409 with no exec attempted.
    const st = await reqAuth('POST', `/projects/${p1}/stop`);
    assert.strictEqual(st.status, 200, 'stop container for the 409 case');
    const stopped = await postServe(p1, { port: P1_PORT });
    assert.strictEqual(stopped.status, 409, `stopped container → 409, got ${stopped.status} ${stopped.json.error || ''}`);
    assert.match(stopped.json.error || '', /start it first/i);

    // Bring it back — serve auto-recovers on start.
    const start = await reqAuth('POST', `/projects/${p1}/start`);
    assert.strictEqual(start.status, 200, 'restart container after the 409 case');
    const after = await getServe(p1);
    assert.strictEqual(after.json.serve.active, true, 'serve auto-recovered after the start');
  });

  test('access matrix: outsider viewer 403 on all routes, viewer member 403 on writes but 200 on status', async () => {
    const outsider = memberAuth('srv-outsider-user', 'srv-outsider', 'viewer');
    const oStart = await postServe(p1, { port: P1_PORT }, outsider.headers);
    assert.strictEqual(oStart.status, 403, 'outsider viewer POST /serve → 403');
    const oStop = await stopServe(p1, outsider.headers);
    assert.strictEqual(oStop.status, 403, 'outsider viewer POST /serve/stop → 403');
    const oGet = await getServe(p1, outsider.headers);
    assert.strictEqual(oGet.status, 403, 'outsider viewer GET /serve → 403');

    const viewer = memberAuth(viewerUser.id, viewerUser.username, 'viewer');
    const vStart = await postServe(p1, { port: P1_PORT }, viewer.headers);
    assert.strictEqual(vStart.status, 403, 'viewer member POST /serve → 403');
    const vStop = await stopServe(p1, viewer.headers);
    assert.strictEqual(vStop.status, 403, 'viewer member POST /serve/stop → 403');
    const vGet = await getServe(p1, viewer.headers);
    assert.strictEqual(vGet.status, 200, 'viewer member GET /serve → 200');
    assert.strictEqual(vGet.json.serve.active, true, 'viewer sees the live state');

    // None of the denied attempts disturbed the running serve.
    const s = await getServe(p1);
    assert.strictEqual(s.json.serve.active, true, 'serve still active after the denied attempts');
  });

  test('unknown project → 404 on all three serve routes', async () => {
    const g = await getServe(uniqueId('srv-nope'));
    assert.strictEqual(g.status, 404, `unknown GET serve → 404, got ${g.status}`);
    const s = await postServe(uniqueId('srv-nope2'));
    assert.strictEqual(s.status, 404, `unknown POST serve → 404, got ${s.status}`);
    const st = await stopServe(uniqueId('srv-nope3'));
    assert.strictEqual(st.status, 404, `unknown POST serve/stop → 404, got ${st.status}`);
  });

  test('409 when the port is already bound inside the container', async () => {
    // The blocker must hold a port the served port never touched: the app's
    // own probe connections leave server-side TIME_WAIT sockets (~60s) that
    // veto a plain (no SO_REUSEADDR) rebind — while python's http.server
    // (SO_REUSEADDR on) binds fine over TIME_WAIT. Only a LIVE, non-SO_REUSEADDR
    // listener forces the EADDRINUSE the 409 path relies on. So: publish a
    // second, never-served port and recreate so it exists in a fresh network
    // namespace with zero connection history.
    const edit = await reqAuth('PUT', `/projects/${p1}/ports`, { ports: [P1_PORT, P2_PORT] });
    assert.strictEqual(edit.status, 200, `add second published port: ${edit.status} ${(await edit.json()).error || ''}`);
    const rc = await reqAuth('POST', `/projects/${p1}/recreate`);
    assert.strictEqual(rc.status, 200, `recreate for the fresh port: ${rc.status} ${(await rc.json()).error || ''}`);

    // Serve auto re-ran on the original port; stop it (P2_PORT stays clean).
    const stopped = await stopServe(p1);
    assert.strictEqual(stopped.status, 200, 'stop serve to free the original port');

    // Occupy P2_PORT with a plain non-HTTP listener that does NOT set
    // SO_REUSEADDR. On Linux a bind-over-listen only succeeds when the existing
    // listener ALSO has SO_REUSEADDR — a plain listener makes the http.server
    // bind fail with EADDRINUSE. The probe then times out against the silent
    // holder and the route reports 409. Binding '' == INADDR_ANY.
    const holder =
      'import socket,time\n' +
      's=socket.socket()\n' +
      's.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)\n' +
      'i=0\n' +
      'while True:\n' +
      '    try:\n' +
      `        s.bind(('',${P2_PORT})); s.listen(1); break\n` +
      '    except OSError:\n' +
      '        i+=1\n' +
      "        if i>20: raise SystemExit('holder bind-failed')\n" +
      '        time.sleep(0.25)\n' +
      'time.sleep(30)\n';
    execFileSync('docker', ['exec', '-d', `wsd-${p1}`, 'python3', '-c', holder], { stdio: 'ignore' });

    // Verify the holder really owns the port before asserting the 409 — a
    // silent no-op here would otherwise turn into a false 200.
    let listening = false;
    for (let i = 0; i < 10 && !listening; i += 1) {
      await sleep(500);
      try {
        const out = execFileSync(
          'docker',
          ['exec', `wsd-${p1}`, 'sh', '-c', `ss -ltn 2>/dev/null | grep '${P2_PORT}'`],
          { encoding: 'utf8' },
        );
        listening = out.includes(`:${P2_PORT}`);
      } catch {
        listening = false;
      }
    }
    assert.ok(listening, `holder should be LISTENing on ${P2_PORT} inside wsd-${p1}`);

    try {
      const r = await postServe(p1, { port: P2_PORT });
      assert.strictEqual(r.status, 409, `occupied port → 409, got ${r.status} ${r.json.error || ''}`);
      assert.match(r.json.error || '', /already in use/i);

      const s = await getServe(p1);
      assert.strictEqual(s.json.serve.active, false, 'failed start does not claim active');
      assert.strictEqual(s.json.serve.enabled, false, 'failed start does not persist enabled');
    } finally {
      try {
        execFileSync('docker', ['exec', `wsd-${p1}`, 'pkill', '-f', 'time.sleep(30)'], { stdio: 'ignore' });
      } catch { /* holder already gone */ }
    }

    // Port freed → a normal start on the original port succeeds again (also
    // restores state for cleanup).
    const again = await postServe(p1, { port: P1_PORT });
    assert.strictEqual(again.status, 200, `serve restarts after the holder is killed: ${again.status} ${again.json.error || ''}`);
    assert.strictEqual(again.json.serve.active, true, 'serve active again');
  });
});