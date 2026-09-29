/**
 * embedded-access.test.ts
 * Madar — live-container contract for the embedded IDE / opencode surfaces
 * after the reliability + permission round.
 *
 * Three contracts are locked down here:
 *
 *  1. `GET /api/ide/status` → `200 {ide:{running, port, workspace, lanReachable}}`.
 *     The `password` key is GONE. code-server runs `--auth none`, so the
 *     secret protected nothing — it was still minted, written to
 *     `data/ide-password` and shipped to every authenticated client. We assert
 *     the key is ABSENT (not merely unused) and that the RAW response text
 *     never contains the substring `password` at all. `?fresh=1` bypasses the
 *     4s TTL probe cache and must serve the identical shape.
 *     `workspace` is the workspaces bind-mount verdict and `lanReachable` says
 *     whether the port is published off-host: `running` describes the PROCESS,
 *     and a running IDE serving a broken/empty mount is precisely the silent
 *     failure this pair of fields exists to make visible.
 *
 *  2. `GET /api/opencode/status` → `200 {running, port, workspace, lanReachable}`.
 *     The probe moved from an HTTP fetch (1.5s) to a shared plain TCP-connect
 *     probe (`EMBEDDED_PROBE_TIMEOUT_MS = 3000`) because a measured 1.85s cold
 *     answer made the view report a FALSE "offline". The budget itself is
 *     asserted STRUCTURALLY (offline, from the module constant) — proving the
 *     live probe actually re-times out would mean stopping opencode, which is
 *     not this suite's job.
 *
 *  3. `POST /api/opencode/open` — THE SECURITY FIX, and the reason this suite
 *     exists. The gate moved viewer → **editor** because
 *     `ensureOpencodeSession()` seeds the workspace (`git init` + a
 *     `.git/opencode` project-id file). Before the fix a viewer-level caller
 *     could force that to materialise in a project it cannot write to. The
 *     route carries the slug in the BODY, not in params, so
 *     `requireProjectAccess` cannot be used as middleware — the gate is
 *     explicit inside the handler, which is exactly why it needs a test.
 *
 *     This suite does not stop at status codes: it proves the ABSENCE OF THE
 *     SIDE EFFECT. The workspace `.git` is removed, the viewer call is made,
 *     and the real path inside the Madar container is re-inspected.
 *
 * TWO RULES KEEP THESE ASSERTIONS HONEST (a false pass is worse than no test,
 * because it reads as coverage):
 *
 *  - A container probe is TRI-STATE: present / absent / NO ANSWER. `docker exec`
 *    exiting non-zero because the daemon is gone must never read as "the file
 *    does not exist", so every filesystem row SKIPS when docker cannot answer.
 *  - Every side-effect row checks the PRECONDITION that produced it (the 403
 *    really happened, the strip really succeeded). If the row that sets that
 *    precondition skipped, so does the dependent — never a silent pass.
 *  - A precondition that is REACHABLE but unsatisfiable HARD-FAILS instead of
 *    skipping. Skipping there used to continue on a polluted workspace and let
 *    an ABSOLUTE count blame a pre-existing session on the refused call, which
 *    reads exactly like a privilege-escalation bug. Such a row now measures a
 *    DELTA around the refused request, and an unclean pre-state is a failure.
 *
 * Requires the running container (`docker ps` → `wsd-pro`); the filesystem
 * evidence needs `docker exec`, mirroring archive-api.test.ts / project-activity.
 * Creates exactly ONE project + ONE editor + ONE viewer, and deletes all three
 * in after(). The dev container runs WSD_TESTING=0 (production rate budgets),
 * so setup self-skips on 429 instead of burning the run.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import jwt from 'jsonwebtoken';
import {
  uniqueId,
  reqAuth,
  initTestAuth,
  JWT_SECRET,
  authHeaders,
  API_URL,
} from './helpers.ts';
import { EMBEDDED_PROBE_TIMEOUT_MS } from '../src/services/embedded-status-probe.ts';

// ── Container / filesystem helpers (the repo's docker-exec convention) ──────

const CONTAINER = process.env.WSD_TEST_CONTAINER || 'wsd-pro';
/** Inside the Madar container: WSD_PROJECTS_DIR (docker-manager.ts). */
const WORKSPACES_ROOT = '/workspaces';
/** opencode web listens here inside the container (index.ts OPENCODE_PORT). */
const OPENCODE_API = 'http://127.0.0.1:4096';

function workspaceDir(slug: string): string {
  return `${WORKSPACES_ROOT}/${slug}`;
}
function gitDir(slug: string): string {
  return `${workspaceDir(slug)}/.git`;
}

/** Run a command inside the Madar container; throws on non-zero exit. */
function inContainer(args: string[], timeout = 15_000): string {
  return execFileSync('docker', ['exec', CONTAINER, ...args], {
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Run a command in the Madar container and report its EXIT CODE instead of
 * throwing. `execFileSync` throws on every non-zero exit, which conflates
 * "the container answered no" with "docker never answered at all" — and that
 * conflation is exactly what turns a broken daemon into a green assertion.
 */
function execStatus(
  args: string[],
  timeout = 15_000,
): { code: number | null; detail: string; stdout: string } {
  try {
    const stdout = execFileSync('docker', ['exec', CONTAINER, ...args], {
      encoding: 'utf8',
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, detail: '', stdout };
  } catch (e: any) {
    return {
      // `null` = we never got a verdict (docker binary missing, daemon down,
      // spawn timeout, …) as opposed to a real exit code.
      code: typeof e?.status === 'number' ? e.status : null,
      detail: String(e?.stderr || e?.message || e).trim().slice(0, 200),
      stdout: String(e?.stdout || ''),
    };
  }
}

/**
 * The answer to "does this path exist in the container", with a THIRD state.
 *
 *   {ok:true, exists:true}  — docker ran `test -e` and the path is there
 *   {ok:true, exists:false} — docker ran `test -e` and the path is NOT there
 *   {ok:false, error}        — we have NO answer (daemon down, container gone,
 *                             127 = no `test` binary, …) and must not pretend
 *
 * `test -e` is tri-state by POSIX convention (0 = present, 1 = absent), so exit
 * codes 0/1 are verdicts and anything else is a failure to obtain one.
 */
type PathProbe = { ok: true; exists: boolean } | { ok: false; error: string };

function containerHas(absPath: string): PathProbe {
  const { code, detail } = execStatus(['test', '-e', absPath]);
  if (code === 0) return { ok: true, exists: true };
  if (code === 1) return { ok: true, exists: false };
  return {
    ok: false,
    error: `docker exec test -e ${absPath} → exit ${code} (${detail || 'no stderr'})`,
  };
}

/** Same tri-state contract for a file's CONTENTS (used by the seeding proof). */
type FileProbe = { ok: true; value: string | null } | { ok: false; error: string };

function containerFile(absPath: string): FileProbe {
  const r = execStatus(['cat', absPath]);
  // `cat` on a missing file exits 1 — that is a real "absent" verdict.
  if (r.code === 0) return { ok: true, value: r.stdout };
  if (r.code === 1) return { ok: true, value: null };
  return { ok: false, error: `docker exec cat ${absPath} → exit ${r.code} (${r.detail || 'no stderr'})` };
}

/** Bounded poll for a path to APPEAR — docker losing the thread aborts the wait. */
async function waitForPath(
  absPath: string,
  timeoutMs = 20_000,
): Promise<{ ok: true; appeared: boolean } | { ok: false; error: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const p = containerHas(absPath);
    if (!p.ok) return p; // docker broke mid-poll → "unknown", never "absent"
    if (p.exists) return { ok: true, appeared: true };
    if (Date.now() >= deadline) return { ok: true, appeared: false };
    await new Promise((r) => setTimeout(r, 400));
  }
}

/** Bounded poll for a file to become readable — same abort-on-no-verdict rule. */
async function waitForFile(
  absPath: string,
  timeoutMs = 15_000,
): Promise<{ ok: true; value: string | null } | { ok: false; error: string }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const p = containerFile(absPath);
    if (!p.ok) return p;
    if (p.value !== null) return p;
    if (Date.now() >= deadline) return { ok: true, value: null };
    await new Promise((r) => setTimeout(r, 400));
  }
}

/**
 * opencode sessions registered for a workspace directory — tri-state for the
 * same reason as `containerHas`: a failed `curl` must NOT read as "no
 * sessions", or the "a refused call created no session" row would pass for
 * the wrong reason.
 */
type SessionProbe = { ok: true; sessions: Array<{ id?: string }> } | { ok: false; error: string };

function opencodeSessions(slug: string): SessionProbe {
  const r = execStatus([
    'curl', '-sS', '--max-time', '5',
    `${OPENCODE_API}/session?directory=${encodeURIComponent(workspaceDir(slug))}`,
  ]);
  if (r.code !== 0) {
    return { ok: false, error: `opencode session list → exit ${r.code} (${r.detail || 'no stderr'})` };
  }
  try {
    const parsed = JSON.parse(r.stdout);
    if (!Array.isArray(parsed)) {
      return { ok: false, error: `opencode session list is not an array (${parsed === null ? 'null' : typeof parsed})` };
    }
    return { ok: true, sessions: parsed };
  } catch (e: any) {
    return { ok: false, error: `opencode session list is not JSON: ${String(e?.message || e)}` };
  }
}

/**
 * Make the workspace genuinely un-seeded: no `.git` AND no opencode session.
 * Both matter. `ensureOpencodeSession()` short-circuits when a session already
 * exists for the directory (opencode-api.ts:130), so a leftover session would
 * mean the editor's accepted call never reaches `git init` and the positive half
 * of the privilege assertion could not be proven at all. Emptied up front, it
 * also PROVES that the rejected viewer calls created no session.
 *
 * `createProject` itself seeds the repo (docker-manager.ts registerOpencodeProject),
 * so the pre-state is established here explicitly and then re-VERIFIED.
 *
 * Returns `ok:false` when the pre-state could not be established or verified,
 * flagged with WHICH kind of failure it was:
 *   - `unreachable: true`  — no answer from docker/opencode at all. A genuine
 *     environment precondition, so the caller SKIPS (never treats it as clean).
 *   - `unreachable: false` — the pre-state is REACHABLE and still polluted
 *     (a `.git` or a session survived). That is a real, reportable defect, so
 *     the caller FAILS LOUDLY: continuing would silently weaken every
 *     side-effect row below, which is exactly how this suite used to be flaky.
 */
type StripResult =
  | { ok: true }
  | { ok: false; unreachable: boolean; error: string };

function stripWorkspace(slug: string): StripResult {
  const rm = execStatus(['rm', '-rf', gitDir(slug)]);
  if (rm.code !== 0) {
    return {
      ok: false,
      // A real exit code means the command RAN and failed; no verdict at all
      // (`null`) means docker never answered.
      unreachable: rm.code === null,
      error: `rm -rf ${gitDir(slug)} → exit ${rm.code} (${rm.detail || 'no stderr'})`,
    };
  }
  for (let i = 0; i < 8; i += 1) {
    const listed = opencodeSessions(slug);
    if (!listed.ok) return { ...listed, unreachable: true };
    if (listed.sessions.length === 0) break;
    for (const s of listed.sessions) {
      if (!s?.id) continue;
      try {
        inContainer(['curl', '-sS', '--max-time', '5', '-X', 'DELETE', `${OPENCODE_API}/session/${encodeURIComponent(s.id)}`]);
      } catch { /* retried by the next pass */ }
    }
  }
  const git = containerHas(gitDir(slug));
  if (!git.ok) return { ...git, unreachable: true };
  if (git.exists) return { ok: false, unreachable: false, error: `${gitDir(slug)} still present after stripping` };
  const after = opencodeSessions(slug);
  if (!after.ok) return { ...after, unreachable: true };
  if (after.sessions.length > 0) return { ok: false, unreachable: false, error: `${after.sessions.length} opencode session(s) survived the strip` };
  return { ok: true };
}

/** sha1 of the directory BASENAME — what seedOpencodeProjectId() writes. */
function seededProjectId(slug: string): string {
  return crypto.createHash('sha1').update(slug).digest('hex');
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

/**
 * Sign a session-looking JWT. Real users are re-resolved against the store
 * server-side (so `role`/`tv` must match the record); an UNKNOWN id keeps the
 * role embedded in the token — which is how the cheap global-editor and
 * non-member rows work, and how team-access.test.ts forges its outsiders.
 */
function signUser(id: string, username: string, role: string): string {
  return jwt.sign({ id, username, role, tv: 0 }, JWT_SECRET, { expiresIn: '24h' });
}

function asUser(token: string): Record<string, string> {
  return { ...authHeaders(), Authorization: `Bearer ${token}` };
}

interface Raw {
  status: number;
  text: string;
  json: any;
}

/** Raw fetch (text in hand) with the repo's 429 Retry-After backoff. */
async function rawReq(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<Raw> {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (res.status !== 429 || attempt >= 3) {
      let json: any = null;
      try { json = JSON.parse(text); } catch { /* non-JSON body */ }
      return { status: res.status, text, json };
    }
    const secs = Math.max(1, parseInt(String(res.headers.get('Retry-After') || '2'), 10));
    await new Promise((r) => setTimeout(r, secs * 1000 + 250));
  }
}

/** Delete with retry/backoff so cleanup survives a transient 429. */
async function deleteRobust(path: string, attempts = 12): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await reqAuth('DELETE', path);
      if (res.status === 200 || res.status === 404) return true;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

// ── Suite state (ONE project, reused by the whole matrix) ───────────────────

const slug = uniqueId('emb-access');
const editorName = `ea_ed_${Date.now().toString(36)}`;
const viewerName = `ea_vw_${Date.now().toString(36)}`;
const userPassword = 'emb-access-pass-123';

let editorId = '';
let viewerId = '';
let editorToken = '';
let viewerToken = '';
let outsiderToken = '';
let projectCreated = false;
let usersCreated = false;
/** Newest-first audit entries are only meaningful against a recent window. */
let auditWindowStart = 0;
/** Set by the setup strip; gates the seeding-dependent positive rows. */
let workspaceStripped = false;

/**
 * PRECONDITION FLAGS.
 *
 * A side-effect assertion ("the refused call created no .git") only means
 * anything if the refusal actually happened AND we can actually look at the
 * filesystem. Both facts are recorded here, and every dependent row SKIPS when
 * its precondition is missing. A row that cannot verify its own precondition
 * must skip — reporting it as passed is a false pass, which is worse than no
 * test because it reads as coverage.
 */
/** `docker exec <container> true` succeeded — the filesystem is observable. */
let dockerReachable = false;
/** The viewer-member call really returned 403 (not skipped, not 429'd). */
let viewerRefusalMade = false;
/** The non-member call really returned 403. */
let nonMemberRefusalMade = false;
/** The editor-member call really returned 200 — prerequisite for "it seeded". */
let editorAccepted = false;
/**
 * Session count read IMMEDIATELY before the refused viewer call (null = we got
 * no answer). The "refusal registered no session" row asserts a DELTA against
 * it: an absolute count cannot tell a session the refused call created from one
 * that was already there, and that confusion is what turned a pre-existing
 * session into a fake "privilege escalation" report.
 */
let sessionCountBeforeRefusal: number | null = null;

// ═══════════════════════════════════════════════════════════════════════════

describe('Embedded surfaces — IDE / opencode status + opencode/open gate (live container)', () => {
  before(async () => {
    auditWindowStart = Date.now();
    await initTestAuth();
  });

  after(async () => {
    // Unconditional: `slug` is always set and `deleteRobust` treats 404 as
    // done, so a create that succeeded server-side but whose response threw
    // before `projectCreated` was set still gets torn down.
    await deleteRobust(`/projects/${slug}`);
    // Per-id, never a single "both were created" flag: if the viewer creation
    // 429s and self-skips, `usersCreated` stays false while `editorId` is a
    // real account — gating on the flag would leak the editor for good.
    if (viewerId) await deleteRobust(`/users/${viewerId}`);
    if (editorId) await deleteRobust(`/users/${editorId}`);
  });

  // ── 401 before anything else: a broken auth path must fail loudly ─────────
  describe('auth gate — no Authorization header is 401', () => {
    test('GET /api/ide/status without a token is 401', async () => {
      const res = await rawReq('GET', '/ide/status');
      assert.strictEqual(res.status, 401, `unauthenticated ide/status: ${res.status} -> ${res.text}`);
      assert.match(String(res.json?.error || ''), /authentication required/i);
    });

    test('GET /api/opencode/status without a token is 401', async () => {
      const res = await rawReq('GET', '/opencode/status');
      assert.strictEqual(res.status, 401, `unauthenticated opencode/status: ${res.status} -> ${res.text}`);
      assert.match(String(res.json?.error || ''), /authentication required/i);
    });

    test('GET /api/ide/status?fresh=1 without a token is 401 (the bypass is not an auth bypass)', async () => {
      const res = await rawReq('GET', '/ide/status?fresh=1');
      assert.strictEqual(res.status, 401, `unauthenticated ide/status?fresh=1: ${res.status}`);
    });

    test('GET /api/opencode/status?fresh=1 without a token is 401 (the bypass is not an auth bypass)', async () => {
      const res = await rawReq('GET', '/opencode/status?fresh=1');
      assert.strictEqual(res.status, 401, `unauthenticated opencode/status?fresh=1: ${res.status}`);
    });

    test('POST /api/opencode/open without a token is 401 (no body, no seeding)', async () => {
      const res = await rawReq('POST', '/opencode/open', {}, undefined);
      assert.strictEqual(res.status, 401, `unauthenticated opencode/open: ${res.status} -> ${res.text}`);
    });
  });

  // ── /api/ide/status: the removed password ─────────────────────────────────
  describe('GET /api/ide/status — exact shape, password removed', () => {
    test('reports exactly {running, port, workspace, lanReachable} and has NO password key', async () => {
      const res = await rawReq('GET', '/ide/status', authHeaders());
      assert.strictEqual(res.status, 200, `ide/status: ${res.status} -> ${res.text}`);
      assert.deepStrictEqual(
        Object.keys(res.json).sort(),
        ['ide'],
        'ide/status must wrap exactly one key: ide'
      );
      assert.deepStrictEqual(
        Object.keys(res.json.ide).sort(),
        ['lanReachable', 'port', 'running', 'workspace'],
        `ide payload keys changed: ${Object.keys(res.json.ide).join(',')}`
      );
      assert.strictEqual(typeof res.json.ide.running, 'boolean');
      assert.strictEqual(typeof res.json.ide.port, 'number');
      assert.ok(Number.isInteger(res.json.ide.port) && res.json.ide.port > 0 && res.json.ide.port <= 65535);
    });

    test('the mount verdict is present and honest (state + hint), never a bare running:true', async () => {
      const res = await rawReq('GET', '/ide/status', authHeaders());
      assert.strictEqual(res.status, 200);
      const ws = res.json.ide.workspace;
      assert.ok(ws, 'ide/status must carry a workspace mount verdict');
      assert.ok(
        ['ok', 'missing', 'not_a_directory', 'unreadable', 'unresolved'].includes(ws.state),
        `unexpected workspace.state: ${JSON.stringify(ws.state)}`
      );
      assert.ok(['env', 'mountinfo', null].includes(ws.source), `unexpected workspace.source: ${ws.source}`);
      assert.ok(['proved', 'refuted', 'unknown'].includes(ws.verification), `unexpected verification: ${ws.verification}`);
      assert.strictEqual(typeof ws.hint, 'string');
      // A non-ok mount must always carry a sentence naming the cause.
      if (ws.state !== 'ok') assert.ok(ws.hint.length > 10, `empty hint for state ${ws.state}`);
      // running describes the PROCESS only: a live IDE on a broken mount is
      // exactly the case this field exists for, so never assert the two agree.
      assert.strictEqual(typeof res.json.ide.lanReachable, 'boolean');
    });

    // The absolute host path of the checkout is operator information (it
    // discloses the machine's directory layout and username) and BOTH status
    // routes are readable by any authenticated user, so it is admin-only. The
    // verdict itself must survive redaction — an operator diagnosing a broken
    // mount still needs state/reason/verification.
    test('the host path is admin-only; a non-admin gets the redacted verdict, not the path', async () => {
      const admin = await rawReq('GET', '/ide/status', authHeaders());
      assert.strictEqual(admin.status, 200);
      const asEditor = await rawReq('GET', '/ide/status', asUser(signUser(uniqueId('ea-redact'), 'ea-redact', 'editor')));
      assert.strictEqual(asEditor.status, 200);

      const adminWs = admin.json.ide.workspace;
      const editorWs = asEditor.json.ide.workspace;
      assert.deepStrictEqual(Object.keys(editorWs).sort(), Object.keys(adminWs).sort(), 'redaction must not change the payload shape');
      assert.strictEqual(editorWs.state, adminWs.state);
      assert.strictEqual(editorWs.verification, adminWs.verification);
      assert.strictEqual(editorWs.source, adminWs.source);
      assert.strictEqual(typeof editorWs.hint, 'string');
      if (adminWs.hostPath) {
        assert.notStrictEqual(editorWs.hostPath, adminWs.hostPath);
        assert.ok(!asEditor.text.includes(adminWs.hostPath), 'the raw body leaked the host path to a non-admin');
        assert.ok(!editorWs.hint.includes(adminWs.hostPath), 'the ok hint embeds the path — it must be scrubbed too');
      }
      // The same redaction on the opencode status route.
      const ocViewer = await rawReq('GET', '/opencode/status', asUser(signUser(uniqueId('ea-redact'), 'ea-redact2', 'viewer')));
      assert.strictEqual(ocViewer.status, 200);
      assert.deepStrictEqual(
        Object.keys(ocViewer.json.workspace).sort(),
        Object.keys(adminWs).sort(),
        'redaction must not change the opencode payload shape'
      );
      if (adminWs.hostPath) assert.ok(!ocViewer.text.includes(adminWs.hostPath), '/opencode/status leaked the host path');
    });

    test("Object.hasOwn(ide,'password') is false — the secret is ABSENT, not just unused", async () => {
      const res = await rawReq('GET', '/ide/status', authHeaders());
      assert.strictEqual(res.status, 200);
      assert.strictEqual(
        Object.hasOwn(res.json.ide, 'password'),
        false,
        `ide payload still carries a password field: ${res.text}`
      );
    });

    test('the RAW ide/status body never contains the substring "password"', async () => {
      const res = await rawReq('GET', '/ide/status', authHeaders());
      assert.strictEqual(res.status, 200);
      assert.ok(
        !res.text.toLowerCase().includes('password'),
        `ide/status leaked a password-bearing field: ${res.text}`
      );
    });

    test('?fresh=1 is served with the identical shape and still leaks no password', async () => {
      const res = await rawReq('GET', '/ide/status?fresh=1', authHeaders());
      assert.strictEqual(res.status, 200, `ide/status?fresh=1: ${res.status} -> ${res.text}`);
      assert.deepStrictEqual(Object.keys(res.json).sort(), ['ide']);
      assert.deepStrictEqual(Object.keys(res.json.ide).sort(), ['lanReachable', 'port', 'running', 'workspace']);
      assert.strictEqual(Object.hasOwn(res.json.ide, 'password'), false);
      assert.ok(!res.text.toLowerCase().includes('password'), `?fresh=1 leaked: ${res.text}`);
    });

    test('?fresh=true is honoured as the same bypass alias (and still shape-correct)', async () => {
      const res = await rawReq('GET', '/ide/status?fresh=true', authHeaders());
      assert.strictEqual(res.status, 200, `ide/status?fresh=true: ${res.status} -> ${res.text}`);
      assert.deepStrictEqual(Object.keys(res.json.ide).sort(), ['lanReachable', 'port', 'running', 'workspace']);
      assert.ok(!res.text.toLowerCase().includes('password'));
    });

    test('the reported port is the container-configured WSD_IDE_PORT (structure cross-check)', async (t) => {
      // Deliberately NOT a timing assertion: the TTL/singleflight rules are
      // unit-tested offline in embedded-status-core.test.ts, and probe frequency
      // is not observable from outside. What IS observable is that the reported
      // port really is the configured one.
      let expected: string | null = null;
      try {
        const env = inContainer(['env']);
        expected = env.split(/\r?\n/).find((l) => l.startsWith('WSD_IDE_PORT='))?.split('=')[1] || null;
      } catch {
        return t.skip(`container '${CONTAINER}' not reachable via docker exec`);
      }
      const res = await rawReq('GET', '/ide/status', authHeaders());
      assert.strictEqual(res.status, 200);
      if (expected) {
        assert.strictEqual(
          res.json.ide.port,
          Number(expected),
          `ide/status port ${res.json.ide.port} != container WSD_IDE_PORT ${expected}`
        );
      } else {
        assert.strictEqual(res.json.ide.port, 8100, 'WSD_IDE_PORT unset in the container → the 8100 default');
      }
    });
  });

  // ── /api/opencode/status: the widened probe budget ────────────────────────
  describe('GET /api/opencode/status — exact shape + the widened probe budget', () => {
    test('reports exactly {running, port, workspace, lanReachable}', async () => {
      const res = await rawReq('GET', '/opencode/status', authHeaders());
      assert.strictEqual(res.status, 200, `opencode/status: ${res.status} -> ${res.text}`);
      assert.deepStrictEqual(
        Object.keys(res.json).sort(),
        ['lanReachable', 'port', 'running', 'workspace'],
        `opencode/status payload keys changed: ${Object.keys(res.json).join(',')}`
      );
      assert.strictEqual(typeof res.json.running, 'boolean');
      assert.strictEqual(typeof res.json.port, 'number');
      assert.ok(Number.isInteger(res.json.port) && res.json.port > 0 && res.json.port <= 65535);
      assert.ok(
        ['ok', 'missing', 'not_a_directory', 'unreadable', 'unresolved'].includes(res.json.workspace?.state),
        `unexpected workspace.state: ${JSON.stringify(res.json.workspace?.state)}`
      );
      assert.strictEqual(typeof res.json.workspace.hint, 'string');
      assert.strictEqual(typeof res.json.lanReachable, 'boolean');
    });

    test('?fresh=1 is served with the identical shape (cache-bypass path answers)', async () => {
      // Honest scope: this asserts the CONTRACT of the bypass (200 + same shape),
      // NOT that a re-probe happened. Probe frequency is not observable from the
      // outside, and the pure bypass rule is already unit-tested offline with an
      // injected clock in embedded-status-core.test.ts — a timing assertion here
      // would only be flaky.
      const res = await rawReq('GET', '/opencode/status?fresh=1', authHeaders());
      assert.strictEqual(res.status, 200, `opencode/status?fresh=1: ${res.status} -> ${res.text}`);
      assert.deepStrictEqual(Object.keys(res.json).sort(), ['lanReachable', 'port', 'running', 'workspace']);
      assert.strictEqual(typeof res.json.running, 'boolean');
    });

    test('back-to-back reads are stable and self-consistent (cached or fresh, same answer)', async () => {
      const a = await rawReq('GET', '/opencode/status', authHeaders());
      const b = await rawReq('GET', '/opencode/status?fresh=1', authHeaders());
      assert.strictEqual(a.status, 200);
      assert.strictEqual(b.status, 200);
      assert.strictEqual(a.json.port, b.json.port, 'the port cannot change between the two reads');
    });

    test('the probe ceiling stays above the measured 1.85s cold answer (structural)', () => {
      // INTENTIONAL TRIPWIRE, kept deliberately: this compares one constant to
      // another, so on its own it is a change-detector, not behaviour. It earns
      // its place because the REAL behaviour it guards is unit-tested offline in
      // embedded-status-core.test.ts ("probeEmbeddedPort" with a net.Server that
      // accepts but never responds must resolve false AT the timeout, and must
      // not leak a socket/timer). Those units cover the mechanism; this row
      // pins the production NUMBER to the measurement that motivated it, so
      // someone lowering the budget trips here first and reads why.
      assert.ok(
        EMBEDDED_PROBE_TIMEOUT_MS >= 1_850,
        `probe budget ${EMBEDDED_PROBE_TIMEOUT_MS}ms can still misread a 1.85s cold start as offline`
      );
      assert.ok(
        EMBEDDED_PROBE_TIMEOUT_MS <= 10_000,
        `probe budget ${EMBEDDED_PROBE_TIMEOUT_MS}ms is no longer bounded against a wedged process`
      );
    });
  });

  // ── POST /api/opencode/open: validation, before any project exists ────────
  describe('POST /api/opencode/open — input contract (owner/admin caller)', () => {
    test('a request with NO body at all is 400 (slug lives in the body, not params)', async () => {
      const res = await rawReq('POST', '/opencode/open', authHeaders());
      assert.strictEqual(res.status, 400, `bodyless open: ${res.status} -> ${res.text}`);
      assert.match(String(res.json?.error || ''), /slug required/i);
    });

    test('an empty slug is 400', async () => {
      const res = await rawReq('POST', '/opencode/open', authHeaders(), { slug: '' });
      assert.strictEqual(res.status, 400, `empty slug: ${res.status} -> ${res.text}`);
      assert.match(String(res.json?.error || ''), /slug required/i);
    });

    test('a falsy non-string slug (null / 0 / []) is 400', async () => {
      for (const slug of [null, 0, [], false]) {
        const res = await rawReq('POST', '/opencode/open', authHeaders(), { slug });
        assert.strictEqual(res.status, 400, `falsy slug ${JSON.stringify(slug)}: ${res.status} -> ${res.text}`);
        assert.match(String(res.json?.error || ''), /slug required/i);
      }
    });

    test('a truthy non-string slug is coerced to a name, then 404s (never a 500, never a write)', async () => {
      // Documented: the route does `String(req.body?.slug || '')`, so a junk
      // truthy value becomes the project name "[object Object]" and simply
      // misses. Harmless — the access gate and the existence check both still
      // run, and nothing is written.
      for (const slug of [{ evil: true }, 12345, [1, 2]]) {
        const res = await rawReq('POST', '/opencode/open', authHeaders(), { slug });
        assert.strictEqual(res.status, 404, `junk slug ${JSON.stringify(slug)}: ${res.status} -> ${res.text}`);
        assert.match(String(res.json?.error || ''), /not found/i);
      }
    });

    test('an unknown project is 404 for a caller that passes the gate', async () => {
      const res = await rawReq('POST', '/opencode/open', authHeaders(), { slug: uniqueId('emb-missing') });
      assert.strictEqual(res.status, 404, `unknown project: ${res.status} -> ${res.text}`);
      assert.match(String(res.json?.error || ''), /not found/i);
    });

    test('a whitespace-only slug is 404, not 400 — the route never trims (documented)', async () => {
      // Documented deviation from an ideal contract: `String(req.body?.slug || '')`
      // is not trimmed (index.ts:2086), so "   " is truthy, clears the !slug gate
      // and is then treated as a project name. Harmless (no such project can
      // exist, and the access gate still runs first), but it means the 400
      // "missing slug" contract covers only falsy values, not blank ones.
      const res = await rawReq('POST', '/opencode/open', authHeaders(), { slug: '   ' });
      assert.strictEqual(res.status, 404, `whitespace slug: ${res.status} -> ${res.text}`);
      assert.match(String(res.json?.error || ''), /not found/i);
    });
  });

  // ── Setup: one project, one editor, one viewer ────────────────────────────
  describe('setup — one project + an editor and a viewer member', () => {
    test('the Madar container is reachable for the filesystem assertions', async (t) => {
      const r = execStatus(['true']);
      if (r.code !== 0) {
        return t.skip(
          `container '${CONTAINER}' is not answering (docker exec → exit ${r.code}: ${r.detail || 'no stderr'}) — ` +
            'the .git side-effect proof needs a live docker exec, so every filesystem row below will skip',
        );
      }
      dockerReachable = true;
    });

    test('create the project (owner = admin)', async (t) => {
      const res = await reqAuth('POST', '/projects', {
        name: 'Embedded Access Test',
        slug,
        description: 'Temporary project for embedded IDE / opencode gate testing',
      });
      if (res.status === 429) return t.skip('rate limited (429) creating the project — run the suite container with WSD_TESTING=1');
      const body = await res.json();
      assert.strictEqual(res.status, 201, `create project: ${res.status} -> ${JSON.stringify(body)}`);
      projectCreated = true;
    });

    test('create an editor and a viewer user', async (t) => {
      const e = await reqAuth('POST', '/users', { username: editorName, password: userPassword, role: 'editor' });
      if (e.status === 429) return t.skip('rate limited (429) creating the editor user');
      const eBody = await e.json();
      assert.strictEqual(e.status, 201, `create editor: ${e.status} -> ${JSON.stringify(eBody)}`);
      editorId = eBody.id;

      const v = await reqAuth('POST', '/users', { username: viewerName, password: userPassword, role: 'viewer' });
      if (v.status === 429) return t.skip('rate limited (429) creating the viewer user');
      const vBody = await v.json();
      assert.strictEqual(v.status, 201, `create viewer: ${v.status} -> ${JSON.stringify(vBody)}`);
      viewerId = vBody.id;

      editorToken = signUser(editorId, editorName, 'editor');
      viewerToken = signUser(viewerId, viewerName, 'viewer');
      // A non-member: a distinct principal (unknown id → the token's own role
      // 'viewer') never added to the project. No extra user record needed, same
      // convention as team-access.test.ts.
      outsiderToken = signUser(`emb-outsider-${slug}`, 'emb-outsider', 'viewer');
      usersCreated = true;
    });

    test('add the editor (editor) and the viewer (viewer) as project members', async (t) => {
      if (!projectCreated || !usersCreated) return t.skip('setup did not complete');
      const e = await reqAuth('POST', `/projects/${slug}/members`, { userId: editorId, role: 'editor' });
      const eBody = await e.json();
      assert.strictEqual(e.status, 200, `add editor member: ${e.status} -> ${JSON.stringify(eBody)}`);
      const v = await reqAuth('POST', `/projects/${slug}/members`, { userId: viewerId, role: 'viewer' });
      const vBody = await v.json();
      assert.strictEqual(v.status, 200, `add viewer member: ${v.status} -> ${JSON.stringify(vBody)}`);
    });

    test('the membership really is editor/viewer (the matrix would be vacuous otherwise)', async (t) => {
      if (!projectCreated || !usersCreated) return t.skip('setup did not complete');
      const res = await reqAuth('GET', `/projects/${slug}/members`);
      assert.strictEqual(res.status, 200);
      const members = (await res.json()).members as any[];
      assert.strictEqual(members.find((m) => m.userId === editorId)?.role, 'editor');
      assert.strictEqual(members.find((m) => m.userId === viewerId)?.role, 'viewer');
    });

    test('strip the workspace: no .git and no opencode session (documents the pre-state)', async (t) => {
      if (!projectCreated) return t.skip('project was not created');
      if (!dockerReachable) return t.skip('docker is not answering — the pre-state cannot be established or verified');
      const ws = containerHas(workspaceDir(slug));
      if (!ws.ok) return t.skip(`docker gave no answer: ${ws.error}`);
      if (!ws.exists) return t.skip(`workspace ${workspaceDir(slug)} is not mounted in the container`);
      // createProject itself seeds the repo (docker-manager.ts registerOpencodeProject),
      // so the pre-state is established here explicitly, never assumed.
      const stripped = stripWorkspace(slug);
      if (!stripped.ok) {
        if (stripped.unreachable) {
          return t.skip(
            `precondition unreachable — the un-seeded pre-state cannot be established or verified: ${stripped.error}`,
          );
        }
        // Hard-fail, NOT a skip. A reachable-but-polluted workspace used to
        // skip through here, after which the suite continued on a known-dirty
        // pre-state and blamed the DIRTY state on the row that followed.
        assert.fail(
          'the un-seeded pre-state was NOT established and is reachable, so continuing would ' +
            `silently weaken every side-effect row below: ${stripped.error}`,
        );
      }
      // Re-verify independently of the helper that produced it.
      const git = containerHas(gitDir(slug));
      if (!git.ok) return t.skip(`docker gave no answer: ${git.error}`);
      assert.strictEqual(git.exists, false, `${gitDir(slug)} still present after stripping`);
      const sessions = opencodeSessions(slug);
      if (!sessions.ok) return t.skip(`docker gave no answer: ${sessions.error}`);
      assert.strictEqual(sessions.sessions.length, 0, 'an opencode session survived the strip');
      workspaceStripped = true;
    });
  });

  // ── The privilege fix: negative rows FIRST (401 → 403 → 200) ──────────────
  describe('POST /api/opencode/open — the editor gate (security fix)', () => {
    test('a VIEWER MEMBER is refused with 403 (the row the fix changed)', async (t) => {
      if (!projectCreated || !usersCreated) return t.skip('setup did not complete');
      // Taken as close to the request as possible, so the row below can measure
      // a DELTA rather than an absolute count.
      const before = opencodeSessions(slug);
      sessionCountBeforeRefusal = before.ok ? before.sessions.length : null;
      const res = await rawReq('POST', '/opencode/open', asUser(viewerToken), { slug });
      if (res.status === 429) return t.skip('rate limited (429)');
      assert.strictEqual(res.status, 403, `viewer member open: ${res.status} -> ${res.text}`);
      assert.match(String(res.json?.error || ''), /access denied/i);
      // Only NOW is the precondition true: the two rows below are meaningless
      // unless a 403 really was returned here.
      viewerRefusalMade = true;
    });

    test('a VIEWER MEMBER refusal did NOT create .git in the workspace (regression guard)', async (t) => {
      if (!viewerRefusalMade) {
        return t.skip('the viewer-403 precondition never happened (setup or the refusal row skipped) — nothing to check');
      }
      if (!dockerReachable) return t.skip('docker is not answering — absence of .git cannot be observed');
      // The direct proof for the fixed hole: seedOpencodeProjectId() would have
      // run `git init -q` with cwd=<workspace> before the gate existed.
      const p = containerHas(gitDir(slug));
      if (!p.ok) return t.skip(`docker gave no answer, so "absent" is UNKNOWN: ${p.error}`);
      assert.strictEqual(
        p.exists,
        false,
        `${gitDir(slug)} exists after a REFUSED viewer call — the viewer gate regressed`
      );
    });

    test('a VIEWER MEMBER refusal did NOT register an opencode session either', async (t) => {
      if (!viewerRefusalMade) {
        return t.skip('the viewer-403 precondition never happened (setup or the refusal row skipped) — nothing to check');
      }
      if (sessionCountBeforeRefusal === null) {
        return t.skip(
          'the session count immediately before the refused call was unreadable, so no DELTA can be ' +
            'computed — and an absolute count would blame whatever was already there',
        );
      }
      const p = opencodeSessions(slug);
      if (!p.ok) return t.skip(`docker gave no answer, so "no NEW session" is UNKNOWN: ${p.error}`);
      // DELTA, not absolute: a refused call that creates nothing is proven even
      // when sessions already exist for the directory.
      assert.strictEqual(
        p.sessions.length - sessionCountBeforeRefusal,
        0,
        `a refused viewer call registered an opencode session for the workspace ` +
          `(${sessionCountBeforeRefusal} before the call → ${p.sessions.length} after it)`,
      );
    });

    test('a NON-MEMBER viewer is refused with 403', async (t) => {
      if (!projectCreated) return t.skip('project was not created');
      const res = await rawReq('POST', '/opencode/open', asUser(outsiderToken), { slug });
      if (res.status === 429) return t.skip('rate limited (429)');
      assert.strictEqual(res.status, 403, `non-member open: ${res.status} -> ${res.text}`);
      assert.match(String(res.json?.error || ''), /access denied/i);
      nonMemberRefusalMade = true;
    });

    test('the non-member refusal ALSO left the workspace without .git', async (t) => {
      if (!nonMemberRefusalMade) {
        return t.skip('the non-member-403 precondition never happened (setup or the refusal row skipped) — nothing to check');
      }
      if (!dockerReachable) return t.skip('docker is not answering — absence of .git cannot be observed');
      const p = containerHas(gitDir(slug));
      if (!p.ok) return t.skip(`docker gave no answer, so "absent" is UNKNOWN: ${p.error}`);
      assert.strictEqual(
        p.exists,
        false,
        `${gitDir(slug)} exists after a REFUSED non-member call`
      );
    });

    test('a refused caller never learns the workspace path', async (t) => {
      if (!projectCreated) return t.skip('project was not created');
      const res = await rawReq('POST', '/opencode/open', asUser(outsiderToken), { slug });
      assert.notStrictEqual(res.status, 200);
      assert.ok(!res.text.includes(workspaceDir(slug)), 'the refusal leaked the workspace path');
    });

    test('a non-member viewer is 403 on a real project but 404 on a fabricated slug (documented, no workspace written)', async (t) => {
      if (!projectCreated) return t.skip('project was not created');
      // Characterisation test for the legacy-open compat rule
      // (access-core.ts:48 — no meta ⇒ every authenticated user is editor-level).
      // A fabricated slug therefore clears the gate and is rejected by the
      // EXISTENCE check, so a non-member viewer can tell "exists" (403) from
      // "does not exist" (404). This mirrors every other project route
      // (GET /projects/:slug also 404s a viewer for a missing slug), so it is
      // platform-wide, NOT introduced by this round. What matters — and what is
      // asserted below — is that the loose gate cannot become a WRITE
      // primitive: getProject() 404s BEFORE ensureOpencodeSession() runs
      // (index.ts:2096 vs 2101), so no workspace is ever materialised.
      const real = await rawReq('POST', '/opencode/open', asUser(outsiderToken), { slug });
      const fakeSlug = uniqueId('emb-fabricated');
      const fake = await rawReq('POST', '/opencode/open', asUser(outsiderToken), { slug: fakeSlug });
      assert.strictEqual(real.status, 403, `real slug: ${real.status} -> ${real.text}`);
      assert.strictEqual(fake.status, 404, `fabricated slug: ${fake.status} -> ${fake.text}`);
      if (!dockerReachable) return t.skip('docker is not answering — the "no workspace written" check needs it');
      const ws = containerHas(workspaceDir(slug));
      if (!ws.ok) return t.skip(`docker gave no answer: ${ws.error}`);
      if (!ws.exists) return t.skip('workspace not mounted in the container');
      const fabricated = containerHas(workspaceDir(fakeSlug));
      if (!fabricated.ok) return t.skip(`docker gave no answer, so "absent" is UNKNOWN: ${fabricated.error}`);
      assert.strictEqual(
        fabricated.exists,
        false,
        `the 404 path created ${workspaceDir(fakeSlug)} — a viewer reached the seeding code`
      );
    });
  });

  // ── The positive row: the editor path really does seed ────────────────────
  describe('POST /api/opencode/open — an editor MEMBER is accepted and seeds the workspace', () => {
    test('an EDITOR MEMBER gets 200 with {ok:true, directory:"/workspaces/<slug>"}', async (t) => {
      if (!projectCreated || !usersCreated) return t.skip('setup did not complete');
      const res = await rawReq('POST', '/opencode/open', asUser(editorToken), { slug });
      if (res.status === 429) return t.skip('rate limited (429)');
      assert.strictEqual(res.status, 200, `editor member open: ${res.status} -> ${res.text}`);
      assert.strictEqual(res.json.ok, true);
      assert.strictEqual(
        res.json.directory,
        `/workspaces/${slug}`,
        `directory must be the workspace root: ${res.text}`
      );
      editorAccepted = true;
    });

    test('the accepted editor call DID seed the workspace (a .git now exists)', async (t) => {
      if (!projectCreated) return t.skip('project was not created');
      if (!editorAccepted) return t.skip('the editor-200 precondition never happened — nothing was seeded to look for');
      if (!workspaceStripped) return t.skip('the un-seeded pre-state was not established — seeding proof would be vacuous');
      if (!dockerReachable) return t.skip('docker is not answering — the .git appearance cannot be observed');
      // Proves the positive half: the seeding the viewer path is now blocked from
      // really happens for an editor — the gate is a permission, not a no-op.
      const appeared = await waitForPath(gitDir(slug), 20_000);
      if (!appeared.ok) return t.skip(`docker stopped answering during the poll: ${appeared.error}`);
      assert.ok(appeared.appeared, `${gitDir(slug)} never appeared — the editor path did not seed the workspace`);
    });

    test('the seeded project id is sha1 of the slug (the request path seeded it, not the boot sync)', async (t) => {
      if (!projectCreated) return t.skip('project was not created');
      if (!editorAccepted) return t.skip('the editor-200 precondition never happened — nothing was seeded to look for');
      if (!workspaceStripped) return t.skip('the un-seeded pre-state was not established — seeding proof would be vacuous');
      if (!dockerReachable) return t.skip('docker is not answering — the seeded id cannot be read');
      // seedOpencodeProjectId() writes sha1(basename(dir)); the entrypoint's boot
      // sync writes sha1(FULL dir). Seeing the slug form proves this call did it.
      const appeared = await waitForFile(`${gitDir(slug)}/opencode`, 15_000);
      if (!appeared.ok) return t.skip(`docker stopped answering during the poll: ${appeared.error}`);
      assert.notStrictEqual(appeared.value, null, 'the seeded .git/opencode project-id file never appeared');
      const reread = containerFile(`${gitDir(slug)}/opencode`);
      if (!reread.ok) return t.skip(`docker gave no answer: ${reread.error}`);
      assert.strictEqual(
        (reread.value ?? '').trim(),
        seededProjectId(slug),
        'the .git/opencode id does not match sha1(slug) — it was not written by seedOpencodeProjectId'
      );
    });

    test('an opencode session is now registered for the workspace', async (t) => {
      if (!projectCreated) return t.skip('project was not created');
      if (!editorAccepted) return t.skip('the editor-200 precondition never happened — nothing was seeded to look for');
      const deadline = Date.now() + 20_000;
      for (;;) {
        const p = opencodeSessions(slug);
        if (!p.ok) return t.skip(`docker gave no answer, so "no session" is UNKNOWN: ${p.error}`);
        if (p.sessions.length > 0) return;
        if (Date.now() >= deadline) break;
        await new Promise((r) => setTimeout(r, 400));
      }
      assert.fail('the accepted editor call registered no opencode session');
    });

    test('a global editor (system role editor, no membership) is accepted too (200)', async (t) => {
      if (!projectCreated) return t.skip('project was not created');
      // Cheap row: a forged system-editor token needs no user record (same
      // convention as team-access.test.ts) — global editors are write-level
      // everywhere, so the editor gate must open for them.
      const globalEditor = signUser(`emb-global-editor-${slug}`, 'emb-global-editor', 'editor');
      const res = await rawReq('POST', '/opencode/open', asUser(globalEditor), { slug });
      if (res.status === 429) return t.skip('rate limited (429)');
      assert.strictEqual(res.status, 200, `global editor open: ${res.status} -> ${res.text}`);
      assert.strictEqual(res.json.directory, `/workspaces/${slug}`);
    });

    test('repeat calls by the same editor stay 200 (the write limiter is not over-tight)', async (t) => {
      if (!projectCreated || !usersCreated) return t.skip('setup did not complete');
      // The userWriteLimiter (120/min per user id) is asserted STRUCTURALLY by
      // wiring, not behaviourally: tripping it on purpose would poison the run
      // for every later suite. Three quick calls prove the normal path is fine.
      for (let i = 0; i < 3; i += 1) {
        const res = await rawReq('POST', '/opencode/open', asUser(editorToken), { slug });
        if (res.status === 429) return t.skip(`rate limited (429) on repeat call #${i + 1}`);
        assert.strictEqual(res.status, 200, `repeat editor open #${i + 1}: ${res.status} -> ${res.text}`);
      }
    });

    test('a viewer is STILL refused after the workspace has been seeded (order independence)', async (t) => {
      if (!projectCreated || !usersCreated) return t.skip('setup did not complete');
      // The gate is on the caller, not on workspace state: once .git exists a
      // viewer must still get 403 (the hole was never "seed only if missing").
      const res = await rawReq('POST', '/opencode/open', asUser(viewerToken), { slug });
      if (res.status === 429) return t.skip('rate limited (429)');
      assert.strictEqual(res.status, 403, `viewer open on a seeded workspace: ${res.status} -> ${res.text}`);
    });
  });

  // ── Audit trail ──────────────────────────────────────────────────────────
  describe('audit trail for opencode/open', () => {
    /** Read the ADMIN-ONLY global security log: GET /api/auth/audit (index.ts:414). */
    async function findAudit(match: (e: any) => boolean): Promise<any | null> {
      for (let i = 0; i < 6; i += 1) {
        const res = await reqAuth('GET', '/auth/audit?limit=100');
        if (res.status === 200) {
          const hit = ((await res.json()).entries as any[]).find(match);
          if (hit) return hit;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      return null;
    }

    test('the refused viewer call is recorded as opencode-open-failed (ok:false) against the viewer', async (t) => {
      if (!projectCreated || !usersCreated) return t.skip('setup did not complete');
      // The account-scoped twin is /api/auth/me/activity, but the global log is
      // the one Settings → Security Activity renders, so that is what we assert.
      const hit = await findAudit(
        (e) => e.event === 'opencode-open-failed' && e.ok === false
          && e.userId === viewerId
          && Date.parse(e.ts) >= auditWindowStart - 60_000,
      );
      assert.ok(hit, `no opencode-open-failed audit entry for viewer ${viewerId}`);
      assert.strictEqual(hit.event, 'opencode-open-failed');
      assert.strictEqual(hit.ok, false);
    });

    test('the accepted editor call is recorded as opencode-open (ok:true) against the editor', async (t) => {
      if (!projectCreated || !usersCreated) return t.skip('setup did not complete');
      const hit = await findAudit(
        (e) => e.event === 'opencode-open' && e.ok === true
          && e.userId === editorId
          && Date.parse(e.ts) >= auditWindowStart - 60_000,
      );
      assert.ok(hit, `no successful opencode-open audit entry for editor ${editorId}`);
      assert.strictEqual(hit.event, 'opencode-open');
      assert.strictEqual(hit.ok, true);
    });
  });
});
