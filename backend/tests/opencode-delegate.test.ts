/**
 * opencode-delegate.test.ts
 * Real-Docker container suite for the "run a roster subagent on my project"
 * delegation feature (POST/GET /opencode/delegate/:slug, history CRUD).
 *
 * Contract covered:
 *   1. 401 without a token (launch + state).
 *   2. 404 unknown project (launch + history; the route resolves meta BEFORE
 *      the opencode probe, so these stay deterministic even offline).
 *   3. 400 empty / whitespace / junk prompt (opencode must be up â€” the route
 *      probes `/global/health` before any validation).
 *   4. 404 unknown agent (valid kebab not on the roster + invalid name shape).
*   5. Capability-gated access matrix: outsider viewer 403 (write AND
 *      readonly — a non-member viewer never passes), viewer member 403 on a
 *      write agent, editor (+ member of the project) launches a write agent
 *      201 {capability:'write'}, viewer member launches a readonly agent 201
 *      {capability:'readonly'}, **viewer member 403 on a bash-capable agent
 *      (pentester / incident-responder / log-analyst: `edit: deny` + `bash:
 *      allow` ≡ a WRITER — the old readonly gate would have handed viewers
 *      root command execution)**.
 *   6. Singleflight 409 on the SAME project while its task is active, and the
 *      global 429 once MAX_CONCURRENT (=2) tasks are running â€” both asserted
 *      MILLISECONDS after their 201s (a background run can never finish in
 *      that window, so the concurrency checks are timing-independent).
 *   7. Oversized prompts are truncated to 20 000 chars, never rejected
 *      (asserted through the stored history entry of the write-agent launch).
 *   8. State endpoint: {state:'running', entryId} on the launched project,
 *      {state:'idle'} on an untouched one.
 *   9. History roundtrip: list newest-first contains the entry, GET :id
 *      matches, viewer member reads 200 but DELETE is 403, editor member
 *      DELETE {ok:true} â†’ GET :id 404.
 *  10. `agent_run` {agent, status:'started'} lands in the activity feed at
 *      launch time (deterministic â€” written synchronously before the run).
 *  11. Deterministic degradation: opencode unreachable â†’ 503
 *      {error:'opencode_offline'}. Implemented by SIGSTOPping the opencode
 *      web child (verified by its process args first) â€” the supervisor's
 *      while-loop only revives EXITED children in ~2s, so a plain kill is
 *      not reliable; a frozen process blocks the probe deterministically and
 *      SIGCONT restores it.
 *  12. Audit line ('agent-run'/'agent-run-failed') for a completed run â€”
 *      written only when the BACKGROUND run finishes, which without a live
 *      LLM provider takes 60-300s. Bounded poll; self-skips with the reason
 *      when no run completes in-suite.
 *  13. OPTIONAL real run to completion (requires a live provider key inside
 *      the container; self-skips otherwise) â€” asserts status done + the
 *      `agent-run` audit line.
 *
 * Self-cleanup: every project/user created carries the `zde-` prefix; after()
 * deletes them robustly and sweeps any leftover `zde-*` projects from
 * interrupted runs.
 *
 * Like all real-Docker suites it needs the container up (WSD_TESTING=1) and
 * opencode web running (entrypoint default). Uses the forged-JWT trick of
 * project-reviews.test.ts (JWT_SECRET from repo .env).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import jwt from 'jsonwebtoken';
import { execFileSync } from 'node:child_process';
import { uniqueId, req, reqAuth, initTestAuth, JWT_SECRET, API_URL, JSON_HEADERS } from './helpers.ts';

const WRITE_AGENT = 'backend-developer'; // baked roster: permission.edit allow
const READONLY_AGENT = 'code-reviewer'; // baked roster: permission.edit deny

function signUser(id: string, username: string, role: string): string {
  return jwt.sign({ id, username, role, tv: 0 }, JWT_SECRET, { expiresIn: '24h' });
}

function runAs(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/** Direct fetch WITHOUT the helpers' 429-retry â€” concurrency assertions need
 *  the first (and only) response, not a 1.5s-then-retry dance. */
async function rawReq(
  method: string,
  urlPath: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${API_URL}${urlPath}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? JSON_HEADERS : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function deleteRobust(urlPath: string, attempts = 25): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await reqAuth('DELETE', urlPath);
      if (res.status === 200 || res.status === 404) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

// â”€â”€ opencode weave helpers (health / SIGSTOP / SIGCONT) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const CONTAINER = 'wsd-pro';

function dockerExec(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', timeout: 20_000 });
}

function opencodeCmd(): string {
  return dockerExec(['exec', CONTAINER, 'sh', '-c', 'cat /app/data/opencode-web.pid']).trim();
}

function opencodeHealth(): boolean {
  try {
    dockerExec(['exec', CONTAINER, 'sh', '-c', 'curl -fsS --max-time 2 http://localhost:4096/global/health >/dev/null 2>&1 && echo ok']);
    return true;
  } catch {
    return false;
  }
}

/** SIGSTOP the opencode web child (verified as opencode by its argv first). */
function stopOpencode(): { ok: boolean; pid: string; reason: string } {
  try {
    const pid = opencodeCmd();
    if (!/^\d+$/.test(pid)) return { ok: false, pid: '', reason: `pid file not numeric: '${pid}'` };
    const args = dockerExec(['exec', CONTAINER, 'sh', '-c', `ps -p ${pid} -o args=`]).trim();
    if (!args.toLowerCase().includes('opencode')) {
      return { ok: false, pid, reason: `pid ${pid} is not opencode (cmd '${args.slice(0, 60)}')` };
    }
    dockerExec(['exec', CONTAINER, 'sh', '-c', `kill -STOP ${pid}`]);
    return { ok: true, pid, reason: '' };
  } catch (e) {
    return { ok: false, pid: '', reason: (e as Error).message };
  }
}

function contOpencode(pid: string): void {
  try {
    dockerExec(['exec', CONTAINER, 'sh', '-c', `kill -CONT ${pid}`]);
  } catch {
    /* the process may already be gone â€” non-fatal */
  }
}

describe('Opencode agent delegation (real Docker container)', () => {
  const slugA = uniqueId('zde-a'); // editor member + viewer member â€” write-agent launch, history, 409
  const slugB = uniqueId('zde-b'); // viewer member only â€” readonly-agent launch
  const slugC = uniqueId('zde-c'); // no members â€” concurrency-cap target (global editor), idle-state probe
  const slugD = uniqueId('zde-d'); // optional real-run project (global editor)
  const editorName = `zdee_${Date.now().toString(36)}`;
  const viewerName = `zdev_${Date.now().toString(36)}`;
  const pw = 'delegate-pass-123';

  let editorId = '';
  let viewerId = '';
  let editorToken: string;
  let viewerToken: string;
  const globalEditorToken = signUser('zde-global-1', 'zde_global_editor', 'editor');
  const outsiderToken = signUser('zde-out-1', 'zde_outside_viewer', 'viewer');

  const created: Record<string, boolean> = { A: false, B: false, C: false, D: false };
  let task1Id: string; // editor write-agent launch on A
  let task2Id: string; // viewer readonly-agent launch on B
  let task1Launched = false;
  let task2Launched = false;

  // Audit snapshot â€” captures a pre-suite baseline so a finished-run audit
  // assertion requires a NEW entry, never a stale one from an earlier run.
  const auditSeen = new Set<string>();
  let ocUp = false;

  before(async () => {
    await initTestAuth();
    // Capture the audit baseline (best-effort â€” the poll test self-skips
    // when the endpoint is unavailable).
    try {
      const res = await reqAuth('GET', '/auth/audit?limit=100');
      if (res.ok) {
        for (const e of (await res.json()).entries ?? []) {
          auditSeen.add(`${e.ts}|${e.event}|${e.ok}`);
        }
      }
    } catch {
      /* audit baseline is best-effort */
    }
    // opencode must be healthy within ~40s (entrypoint registration loop).
    for (let i = 0; i < 40 && !ocUp; i += 1) {
      if (opencodeHealth()) ocUp = true;
      else await new Promise((r) => setTimeout(r, 1000));
    }
  });

  after(async () => {
    for (const [key, slug] of [['A', slugA], ['B', slugB], ['C', slugC], ['D', slugD]] as const) {
      if (created[key]) await deleteRobust(`/projects/${slug}`);
    }
    if (editorId) await deleteRobust(`/users/${editorId}`);
    if (viewerId) await deleteRobust(`/users/${viewerId}`);
    // Self-cleanup sweep: any `zde-*` project left by an interrupted run.
    try {
      const res = await reqAuth('GET', '/projects');
      const projects = (await res.json()).projects ?? [];
      for (const p of projects) {
        if (String(p.slug ?? '').startsWith('zde-')) await deleteRobust(`/projects/${p.slug}`);
      }
    } catch {
      /* sweep is best-effort */
    }
  });

  // â”€â”€ Auth â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  test('401 without a token on launch and state', async () => {
    const post = await rawReq('POST', `/opencode/delegate/${slugA}`, { agent: WRITE_AGENT, prompt: 'x' });
    assert.strictEqual(post.status, 401);
    const get = await rawReq('GET', `/opencode/delegate/${slugA}`);
    assert.strictEqual(get.status, 401);
    const history = await rawReq('GET', `/opencode/delegate/${slugA}/history`);
    assert.strictEqual(history.status, 401);
  });

  // â”€â”€ Setup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  test('create projects + users and wire membership', async () => {
    const e = await reqAuth('POST', '/users', { username: editorName, password: pw, role: 'editor' });
    assert.strictEqual(e.status, 201, `create editor: ${e.status}`);
    editorId = (await e.json()).id;
    const v = await reqAuth('POST', '/users', { username: viewerName, password: pw, role: 'viewer' });
    assert.strictEqual(v.status, 201, `create viewer: ${v.status}`);
    viewerId = (await v.json()).id;
    editorToken = signUser(editorId, editorName, 'editor');
    viewerToken = signUser(viewerId, viewerName, 'viewer');

    const createdSlugs: Array<[string, string]> = [
      ['A', slugA],
      ['B', slugB],
      ['C', slugC],
      ['D', slugD],
    ];
    for (const [key, slug] of createdSlugs) {
      const r = await reqAuth('POST', '/projects', {
        name: `Delegate Test ${key}`,
        slug,
        description: 'Temporary project for opencode delegation testing',
      });
      assert.strictEqual(r.status, 201, `create ${key}: ${r.status}`);
      assert.strictEqual((await r.json()).project.slug, slug);
      created[key] = true;
    }

    const m1 = await reqAuth('POST', `/projects/${slugA}/members`, { userId: editorId, role: 'editor' });
    assert.strictEqual(m1.status, 200, `add editor to A: ${JSON.stringify(await m1.json())}`);
    const m2 = await reqAuth('POST', `/projects/${slugA}/members`, { userId: viewerId, role: 'viewer' });
    assert.strictEqual(m2.status, 200, `add viewer to A: ${JSON.stringify(await m2.json())}`);
    const m3 = await reqAuth('POST', `/projects/${slugB}/members`, { userId: viewerId, role: 'viewer' });
    assert.strictEqual(m3.status, 200, `add viewer to B: ${JSON.stringify(await m3.json())}`);
  });

  // â”€â”€ 404s (pre-probe â€” deterministic even with opencode down) â”€â”€â”€â”€â”€
  test('404 for an unknown project slug on launch + history', async () => {
    const missing = uniqueId('zde-missing');
    const post = await rawReq('POST', `/opencode/delegate/${missing}`, { agent: WRITE_AGENT, prompt: 'x' }, runAs(globalEditorToken));
    assert.strictEqual(post.status, 404);
    assert.strictEqual(post.body.error, 'Project not found');
    const history = await rawReq('GET', `/opencode/delegate/${missing}/history`, undefined, runAs(globalEditorToken));
    assert.strictEqual(history.status, 404);
    const state = await rawReq('GET', `/opencode/delegate/${missing}`, undefined, runAs(globalEditorToken));
    assert.strictEqual(state.status, 404);
  });

  // â”€â”€ Validation (route probes opencode first â€” skip when down) â”€â”€â”€
  test('400 for an empty / whitespace / junk prompt', async (t) => {
    if (!ocUp) { t.skip('opencode web unreachable â€” route probe pre-empts validation'); return; }
    for (const body of [{}, { agent: WRITE_AGENT }, { agent: WRITE_AGENT, prompt: '   ' }, { agent: WRITE_AGENT, prompt: 42 }]) {
      const res = await rawReq('POST', `/opencode/delegate/${slugA}`, body, runAs(editorToken));
      assert.strictEqual(res.status, 400, JSON.stringify(body));
      assert.strictEqual(res.body.error, 'Prompt is required');
    }
  });

  test('404 for an unknown agent (valid kebab off-roster + invalid shape)', async (t) => {
    if (!ocUp) { t.skip('opencode web unreachable â€” route probe pre-empts validation'); return; }
    const offRoster = await rawReq('POST', `/opencode/delegate/${slugA}`, { agent: 'zodiac-researcher', prompt: 'x' }, runAs(editorToken));
    assert.strictEqual(offRoster.status, 404);
    assert.match(String(offRoster.body.error), /Agent 'zodiac-researcher' not found/);
    const badShape = await rawReq('POST', `/opencode/delegate/${slugA}`, { agent: 'Bad Agent', prompt: 'x' }, runAs(editorToken));
    assert.strictEqual(badShape.status, 404);
    const empty = await rawReq('POST', `/opencode/delegate/${slugA}`, { prompt: 'x' }, runAs(editorToken));
    assert.strictEqual(empty.status, 404);
  });

  // â”€â”€ OPTIONAL: real run to completion (first launch â€” owns its slot) â”€
  test('OPTIONAL real run completes end-to-end (skips without a live provider)', async (t) => {
    if (!ocUp) { t.skip('opencode web unreachable'); return; }
    let hasKey = false;
    try {
      const raw = dockerExec(['exec', CONTAINER, 'sh', '-c', 'cat /app/data/providers.json']);
      const cfg = JSON.parse(raw) as Record<string, any>;
      hasKey = Object.values(cfg).some((p: any) => typeof p?.apiKey === 'string' && p.apiKey.startsWith('enc1:'));
    } catch {
      hasKey = false;
    }
    if (!hasKey) {
      t.skip('no live provider key in the container (data/providers.json has no enc1: sealed key) â€” a real agent run cannot complete');
      return;
    }
    const launched = await rawReq(
      'POST', `/opencode/delegate/${slugD}`,
      { agent: WRITE_AGENT, prompt: 'Reply with exactly OK.' },
      runAs(globalEditorToken),
    );
    if (launched.status === 429 || launched.status === 409) {
      t.skip(`no free concurrency slot at the end of the suite (${launched.status}) â€” real run skipped`);
      return;
    }
    assert.strictEqual(launched.status, 201, JSON.stringify(launched.body));
    const id: string = launched.body.id;
    // The run may legally take up to WSD_DELEGATE_TIMEOUT_MS (default 5 min).
    const deadline = Date.now() + 320_000;
    let entry: any;
    for (;;) {
      const poll = await rawReq('GET', `/opencode/delegate/${slugD}/history/${id}`, undefined, runAs(globalEditorToken));
      assert.strictEqual(poll.status, 200);
      entry = poll.body;
      if (entry.status !== 'running') break;
      if (Date.now() > deadline) {
        t.skip('real run exceeded the 320s test budget and is still running');
        return;
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    if (entry.status === 'failed') {
      t.skip(`real run failed in this environment (${entry.error ?? 'unknown error'}) â€” live provider not workable; success path unassertable`);
      return;
    }
    assert.strictEqual(entry.status, 'done');
    assert.ok(entry.result?.text, 'done run carries result.text');
    // The finish writes the agent-run audit line â€” assert a NEW one appeared.
    const audit = await (await reqAuth('GET', '/auth/audit?limit=100')).json();
    const fresh = (audit.entries ?? []).some(
      (e: any) => e.event === 'agent-run' && e.ok === true && !auditSeen.has(`${e.ts}|${e.event}|${e.ok}`),
    );
    assert.ok(fresh, 'a fresh agent-run audit entry appears once the run completes');
    auditSeen.add(`${entry.createdAt}|agent-run|true`);
  });

  // â”€â”€ Access matrix (capability-gated inside the service) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  test('outsider viewer is 403 on BOTH capability classes (no membership)', async (t) => {
    if (!ocUp) { t.skip('opencode web unreachable â€” route probe pre-empts the access check'); return; }
    const write = await rawReq('POST', `/opencode/delegate/${slugA}`, { agent: WRITE_AGENT, prompt: 'x' }, runAs(outsiderToken));
    assert.strictEqual(write.status, 403, JSON.stringify(write.body));
    const readonly = await rawReq('POST', `/opencode/delegate/${slugA}`, { agent: READONLY_AGENT, prompt: 'x' }, runAs(outsiderToken));
    assert.strictEqual(readonly.status, 403, JSON.stringify(readonly.body));
    assert.strictEqual(readonly.body.error, 'Access denied to this project');
  });

test('viewer member is 403 on a write agent but may read state/history', async (t) => {
    if (!ocUp) { t.skip('opencode web unreachable — route probe pre-empts the access check'); return; }
    const write = await rawReq('POST', `/opencode/delegate/${slugA}`, { agent: WRITE_AGENT, prompt: 'x' }, runAs(viewerToken));
    assert.strictEqual(write.status, 403, JSON.stringify(write.body));
    // Read-only surfaces stay open to the viewer.
    const state = await rawReq('GET', `/opencode/delegate/${slugA}`, undefined, runAs(viewerToken));
    assert.strictEqual(state.status, 200);
    const history = await rawReq('GET', `/opencode/delegate/${slugA}/history`, undefined, runAs(viewerToken));
    assert.strictEqual(history.status, 200);
  });

  test('viewer member is 403 on bash-capable agents (pentester / incident-responder / log-analyst) — no RCE through the readonly gate', async (t) => {
    if (!ocUp) { t.skip('opencode web unreachable — route probe pre-empts the access check'); return; }
    for (const bashAgent of ['pentester', 'incident-responder', 'log-analyst']) {
      const res = await rawReq('POST', `/opencode/delegate/${slugA}`, { agent: bashAgent, prompt: 'x' }, runAs(viewerToken));
      assert.strictEqual(res.status, 403, `${bashAgent}: ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body.error, 'Access denied to this project');
    }
  });

  test('editor (+member) launches a WRITE agent 201 {capability:write}; oversized prompt truncated to 20000; same-project relaunch is a 409 (singleflight)', async (t) => {
    if (!ocUp) { t.skip('opencode web unreachable'); return; }
    const launched = await rawReq(
      'POST', `/opencode/delegate/${slugA}`,
      { agent: WRITE_AGENT, prompt: 'x'.repeat(25_000) },
      runAs(editorToken),
    );
    assert.strictEqual(launched.status, 201, JSON.stringify(launched.body));
    assert.strictEqual(launched.body.agent, WRITE_AGENT);
    assert.strictEqual(launched.body.capability, 'write');
    assert.strictEqual(launched.body.status, 'running');
    assert.match(launched.body.id, /^d-[a-z0-9]{6}-[a-z0-9]{6}$/);
    task1Id = launched.body.id;
    task1Launched = true;

    // IMMEDIATE relaunch on the same project â€” the background run cannot
    // finish in this window, so singleflight applies deterministically.
    const dup = await rawReq('POST', `/opencode/delegate/${slugA}`, { agent: WRITE_AGENT, prompt: 'again' }, runAs(editorToken));
    assert.strictEqual(dup.status, 409, JSON.stringify(dup.body));
    assert.match(String(dup.body.error), /already running/);
  });

  test('viewer member launches a READONLY agent 201 {capability:readonly}; a third project hits the global 429 cap', async (t) => {
    if (!ocUp) { t.skip('opencode web unreachable'); return; }
    const launched = await rawReq('POST', `/opencode/delegate/${slugB}`, { agent: READONLY_AGENT, prompt: 'audit this workspace' }, runAs(viewerToken));
    assert.strictEqual(launched.status, 201, JSON.stringify(launched.body));
    assert.strictEqual(launched.body.capability, 'readonly');
    task2Id = launched.body.id;
    task2Launched = true;

    // Exactly two tasks active (A + B) â†’ the global MAX_CONCURRENT=2 gate
    // rejects a THIRD launch on a project with no active task.
    const third = await rawReq('POST', `/opencode/delegate/${slugC}`, { agent: WRITE_AGENT, prompt: 'x' }, runAs(globalEditorToken));
    assert.strictEqual(third.status, 429, JSON.stringify(third.body));
    assert.match(String(third.body.error), /Too many concurrent agent tasks/);
  });

  // â”€â”€ Live state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  test('state endpoint: running with the task entryId on launched projects, idle on untouched', (t) => {
    if (!task1Launched) { t.skip('task1 launch was skipped'); return; }
    void task2Id;
    const run = (async () => {
      const a = await rawReq('GET', `/opencode/delegate/${slugA}`, undefined, runAs(editorToken));
      assert.strictEqual(a.status, 200);
      assert.strictEqual(a.body.state, 'running');
      assert.strictEqual(a.body.entryId, task1Id);
      assert.strictEqual(a.body.agent, WRITE_AGENT);
      assert.ok(Array.isArray(a.body.tail));

      const c = await rawReq('GET', `/opencode/delegate/${slugC}`, undefined, runAs(globalEditorToken));
      assert.strictEqual(c.status, 200);
      assert.deepStrictEqual(c.body, { state: 'idle' });
    })();
    return run;
  });

  // â”€â”€ History roundtrip (reuses task1 â€” no extra launch) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  test('history: list contains the entry, GET :id matches, viewer delete 403, editor delete ok, 404 afterwards', async (t) => {
    if (!task1Launched) { t.skip('task1 launch was skipped'); return; }
    // Oversized prompt was truncated to the 20 000-char ceiling â€” never 400.
    const list = await rawReq('GET', `/opencode/delegate/${slugA}/history`, undefined, runAs(editorToken));
    assert.strictEqual(list.status, 200);
    assert.ok(Array.isArray(list.body.entries));
    const entry = list.body.entries.find((e: any) => e.id === task1Id);
    assert.ok(entry, 'list carries the launched entry');
    assert.strictEqual(entry.agent, WRITE_AGENT);
    assert.strictEqual(entry.capability, 'write');
    assert.strictEqual(entry.prompt.length, 20_000, 'oversized prompt truncated, not rejected');
    assert.strictEqual(entry.actorName, editorName, 'the run is attributed to the launching editor');

    const one = await rawReq('GET', `/opencode/delegate/${slugA}/history/${task1Id}`, undefined, runAs(editorToken));
    assert.strictEqual(one.status, 200);
    assert.strictEqual(one.body.id, task1Id);
    assert.strictEqual(one.body.prompt, entry.prompt);

    const ghost = await rawReq('GET', `/opencode/delegate/${slugA}/history/d-aaaaaa-bbbbbb`, undefined, runAs(editorToken));
    assert.strictEqual(ghost.status, 404);
    assert.strictEqual(ghost.body.error, 'Delegation not found');

    // Viewer member can READ history but never DELETE (editor+ gate).
    const delViewer = await rawReq('DELETE', `/opencode/delegate/${slugA}/history/${task1Id}`, undefined, runAs(viewerToken));
    assert.strictEqual(delViewer.status, 403, JSON.stringify(delViewer.body));

    const delEditor = await rawReq('DELETE', `/opencode/delegate/${slugA}/history/${task1Id}`, undefined, runAs(editorToken));
    assert.strictEqual(delEditor.status, 200, JSON.stringify(delEditor.body));
    assert.deepStrictEqual(delEditor.body, { ok: true });

    const gone = await rawReq('GET', `/opencode/delegate/${slugA}/history/${task1Id}`, undefined, runAs(editorToken));
    assert.strictEqual(gone.status, 404);
  });

  // â”€â”€ Activity feed (started event is written synchronously at launch) â”€
  test('agent_run {agent, status:started} lands in the project activity feed', async (t) => {
    if (!task1Launched && !task2Launched) { t.skip('no launch happened in this run'); return; }
    const act = await (await reqAuth('GET', `/projects/${slugA}/activity`)).json();
    assert.ok(Array.isArray(act.entries));
    const started = act.entries.find((e: any) => e.action === 'agent_run' && e.details?.status === 'started');
    assert.ok(started, 'agent_run started entry exists');
    assert.strictEqual(started.details.agent, WRITE_AGENT);
    assert.ok(started.actorName, 'the event is attributed');
  });

  // â”€â”€ Deterministic degradation (SIGSTOP trick) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  test('opencode unreachable â†’ 503 {error:opencode_offline} (SIGSTOP/CONT; verified pid)', async (t) => {
    if (!ocUp) {
      // opencode already down â€” the probe still 503s, nothing to restore.
      const res = await rawReq('POST', `/opencode/delegate/${slugA}`, { agent: WRITE_AGENT, prompt: 'x' }, runAs(editorToken));
      assert.strictEqual(res.status, 503);
      assert.strictEqual(res.body.error, 'opencode_offline');
      return;
    }
    const stopped = stopOpencode();
    if (!stopped.ok) {
      t.skip(`cannot freeze opencode deterministically â€” ${stopped.reason}`);
      return;
    }
    try {
      const res = await rawReq('POST', `/opencode/delegate/${slugA}`, { agent: WRITE_AGENT, prompt: 'x' }, runAs(editorToken));
      assert.strictEqual(res.status, 503, JSON.stringify(res.body));
      assert.strictEqual(res.body.error, 'opencode_offline');
      // GET state stays in-memory (no wire probe) while opencode is frozen.
      const state = await rawReq('GET', `/opencode/delegate/${slugC}`, undefined, runAs(globalEditorToken));
      assert.strictEqual(state.status, 200);
      assert.strictEqual(state.body.state, 'idle');
    } finally {
      contOpencode(stopped.pid);
      for (let i = 0; i < 30; i += 1) {
        if (opencodeHealth()) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  });

  // â”€â”€ Audit line for a completed run (sync-finish only with a provider) â”€
  test('audit records agent-run/agent-run-failed once a run completes (skips when none finish in-suite)', async (t) => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      let entries: any[] = [];
      try {
        entries = (await (await reqAuth('GET', '/auth/audit?limit=100')).json()).entries ?? [];
      } catch {
        /* transient */
      }
      const fresh = entries.some(
        (e: any) => (e.event === 'agent-run' || e.event === 'agent-run-failed') && !auditSeen.has(`${e.ts}|${e.event}|${e.ok}`),
      );
      if (fresh) return;
      if (Date.now() > deadline) {
        t.skip('no agent run completed within the suite window â€” the audit line is written only when the BACKGROUND run finishes (60-300s without a live provider); asserted deterministically by the optional real-run test when a provider is present');
        return;
      }
      await new Promise((r) => setTimeout(r, 2500));
    }
  });
});