import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import {
  uniqueId,
  req,
  reqAuth,
  initTestAuth,
  authHeaders,
  signUserToken,
  liveUser,
  cleanupLiveUsers,
  API_URL,
} from './helpers.ts';

/**
 * Project intelligence digests (scheduled AI summaries) — live-container suite.
 *
 * Exercises the real HTTP surface of the digest feature against the running
 * container: route auth, the member/editor/outsider access matrix, the config
 * round-trip + validation, the honest "generate now" contract (201 and a
 * terminal entry, or an explicit 503 — never 500), delete, and the activity
 * feed it records. Mirrors project-snapshots-auto.test.ts (schedule/config +
 * member/viewer access matrix + self-cleanup) and team-access.test.ts.
 *
 * The suite owns ONE project plus a real editor + viewer member and a real
 * non-member viewer outsider; after() deletes all of them and any throwaway
 * users liveUser() created.
 */

interface CallResult {
  status: number;
  json: any;
}

/** Small fetch wrapper that always yields {status,json}; retries transient 429. */
async function call(
  method: string,
  path: string,
  headers: Record<string, string> = authHeaders(),
  body?: unknown,
): Promise<CallResult> {
  const res = await req(method, path, body, headers);
  let json: any = {};
  try {
    json = await res.json();
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, json };
}

/** Run as a specific (real) user by overriding the Authorization header. */
function asUser(token: string): Record<string, string> {
  return { ...authHeaders(), Authorization: `Bearer ${token}` };
}

/** DELETE with retry/backoff so cleanup survives a busy full-suite run. */
async function deleteRobust(path: string, attempts = 12): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await reqAuth('DELETE', path);
      if (res.status === 200 || res.status === 404) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

const UNKNOWN_ID = 'g-abcdef-abcdef';

describe('Project intelligence digests (real Docker container)', () => {
  let slug = '';
  let missingSlug = '';
  let editorId = '';
  let viewerId = '';
  let editorToken = '';
  let viewerToken = '';
  let outsiderToken = '';
  let created = false;

  // Set by the generate test: the entry created by a successful POST, and
  // whether a generation actually happened (vs an honest 503).
  let digestId = '';
  let generated = false;

  const listUrl = () => `/projects/${slug}/digests`;
  const configUrl = () => `/projects/${slug}/digests/config`;
  const entryUrl = (id: string) => `/projects/${slug}/digests/${encodeURIComponent(id)}`;

  /** Poll one entry until it leaves `running`, bounded. Returns the last read. */
  async function waitTerminal(id: string, maxMs = 20_000): Promise<any> {
    const deadline = Date.now() + maxMs;
    let last: any = null;
    while (Date.now() < deadline) {
      const r = await call('GET', entryUrl(id), authHeaders());
      if (r.status === 200) {
        last = r.json;
        if (last.status !== 'running') return last;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    return last;
  }

  before(async () => {
    await initTestAuth();
    slug = uniqueId('digest-test');
    missingSlug = uniqueId('digest-missing');

    const createdRes = await reqAuth('POST', '/projects', {
      name: 'Digest Test',
      slug,
      description: 'temporary project for digest testing',
    });
    assert.strictEqual(createdRes.status, 201, `project create: ${createdRes.status} — ${JSON.stringify(await createdRes.json().catch(() => ({})))}`);
    created = true;

    // Give the project a durable digest signal (a workspace file + a note) so a
    // scheduled sweep would have something to summarise; the manual POST route
    // does not require it.
    await reqAuth('PUT', `/projects/${slug}/file?path=README.md`, { content: '# Digest test project' });
    await reqAuth('PUT', `/projects/${slug}/notes`, {
      items: [{ id: 'd1', text: 'digest suite note', kind: 'goal', done: false, createdAt: new Date().toISOString() }],
    });

    // A real editor and a real viewer member (verifyToken refuses ids that are
    // not in users.json, so an invented identity would prove nothing).
    const editorName = uniqueId('dig-editor').replace(/[^a-z0-9-]/g, '');
    const viewerName = uniqueId('dig-viewer').replace(/[^a-z0-9-]/g, '');
    const e = await call('POST', '/users', authHeaders(), { username: editorName, password: 'digest-pw-2026', role: 'editor' });
    assert.strictEqual(e.status, 201, `create editor: ${e.status} — ${JSON.stringify(e.json)}`);
    editorId = e.json.id;
    const v = await call('POST', '/users', authHeaders(), { username: viewerName, password: 'digest-pw-2026', role: 'viewer' });
    assert.strictEqual(v.status, 201, `create viewer: ${v.status} — ${JSON.stringify(v.json)}`);
    viewerId = v.json.id;

    editorToken = signUserToken({ id: editorId, username: editorName, role: 'editor' });
    viewerToken = signUserToken({ id: viewerId, username: viewerName, role: 'viewer' });

    const addEditor = await reqAuth('POST', `/projects/${slug}/members`, { userId: editorId, role: 'editor' });
    assert.strictEqual(addEditor.status, 200, `add editor member: ${addEditor.status} — ${JSON.stringify(await addEditor.json().catch(() => ({})))}`);
    const addViewer = await reqAuth('POST', `/projects/${slug}/members`, { userId: viewerId, role: 'viewer' });
    assert.strictEqual(addViewer.status, 200, `add viewer member: ${addViewer.status} — ${JSON.stringify(await addViewer.json().catch(() => ({})))}`);

    outsiderToken = (await liveUser('viewer', 'digest-outsider')).token;
  });

  after(async () => {
    if (created) await deleteRobust(`/projects/${slug}`);
    if (viewerId) await deleteRobust(`/users/${viewerId}`);
    if (editorId) await deleteRobust(`/users/${editorId}`);
    await cleanupLiveUsers();
  });

  test('every digest route requires a token (401)', async () => {
    const noAuth: Record<string, string> = {};
    const rows: Array<[string, string, unknown]> = [
      ['GET', listUrl(), undefined],
      ['GET', configUrl(), undefined],
      ['PUT', configUrl(), { enabled: true }],
      ['POST', listUrl(), {}],
      ['GET', entryUrl(UNKNOWN_ID), undefined],
      ['DELETE', entryUrl(UNKNOWN_ID), undefined],
    ];
    for (const [method, path, body] of rows) {
      const r = await call(method, path, noAuth, body);
      assert.strictEqual(r.status, 401, `${method} ${path} without a token should be 401, got ${r.status}`);
    }
  });

  test('a fresh project has the default disabled schedule and no stored digests', async () => {
    const list = await call('GET', listUrl(), authHeaders());
    assert.strictEqual(list.status, 200, `list: ${list.status}`);
    assert.deepStrictEqual(list.json.entries, []);
    assert.strictEqual(list.json.total, 0);

    const cfg = await call('GET', configUrl(), authHeaders());
    assert.strictEqual(cfg.status, 200, `config: ${cfg.status}`);
    assert.strictEqual(cfg.json.enabled, false);
    assert.strictEqual(cfg.json.intervalMin, 1440);
    assert.strictEqual(cfg.json.lastDigestAt, null);
  });

  test('config round-trips: valid values merge, junk interval does not win, partial update preserves the other key', async () => {
    // Full valid update.
    const enabled = await call('PUT', configUrl(), authHeaders(), { enabled: true, intervalMin: 60 });
    assert.strictEqual(enabled.status, 200, `enable: ${enabled.status}`);
    assert.strictEqual(enabled.json.enabled, true);
    assert.strictEqual(enabled.json.intervalMin, 60);

    // Junk interval (not in the whitelist) must NOT win — it falls back to the
    // previously stored value.
    const junk = await call('PUT', configUrl(), authHeaders(), { intervalMin: 999 });
    assert.strictEqual(junk.status, 200, `junk interval: ${junk.status}`);
    assert.strictEqual(junk.json.intervalMin, 60, 'junk intervalMin falls back to the previous value');

    // Partial update: only `enabled` changes; intervalMin survives.
    const partial = await call('PUT', configUrl(), authHeaders(), { enabled: false });
    assert.strictEqual(partial.status, 200, `partial: ${partial.status}`);
    assert.strictEqual(partial.json.enabled, false);
    assert.strictEqual(partial.json.intervalMin, 60, 'omitted intervalMin survives a partial update');

    // The persisted read agrees with the last write.
    const readBack = await call('GET', configUrl(), authHeaders());
    assert.strictEqual(readBack.status, 200);
    assert.strictEqual(readBack.json.enabled, false);
    assert.strictEqual(readBack.json.intervalMin, 60);
  });

  test('generate is honest: 201 + a terminal entry, or an explicit 503 — never 500', async () => {
    const res = await call('POST', listUrl(), authHeaders(), {});
    assert.notStrictEqual(res.status, 500, `generate must never 500: body ${JSON.stringify(res.json)}`);
    assert.ok(
      [201, 409, 429, 503].includes(res.status),
      `unexpected generate status ${res.status}: ${JSON.stringify(res.json)}`,
    );

    if (res.status === 201) {
      generated = true;
      digestId = res.json.digest.id;
      assert.match(digestId, /^g-[a-z0-9]{6}-[a-z0-9]{6}$/, 'digest id shape');
      assert.strictEqual(res.json.digest.status, 'running', 'POST returns the running entry');

      // It must settle (done or failed) — never stay running forever.
      const settled = await waitTerminal(digestId);
      assert.ok(settled, 'the created entry must be readable');
      assert.notStrictEqual(settled.status, 'running', `entry must reach a terminal state, still running after the poll: ${JSON.stringify(settled)}`);
      assert.ok(['done', 'failed'].includes(settled.status), `terminal status must be done|failed, got ${settled.status}`);
      if (settled.status === 'failed') {
        assert.ok(typeof settled.error === 'string' && settled.error.length > 0, 'a failed digest must carry a non-empty error');
      } else {
        assert.strictEqual(typeof settled.summary, 'string', 'a done digest carries a summary string');
      }
    } else if (res.status === 503) {
      // No usable provider — an explicit, honest refusal. No entry is created.
      assert.ok(res.json.error, '503 must explain the refusal');
      const list = await call('GET', listUrl(), authHeaders());
      assert.strictEqual(list.status, 200);
      assert.strictEqual(list.json.entries.length, 0, 'a refused generate persists no entry');
    }
    // 409 (already running) / 429 (global concurrency) are honest, non-500
    // outcomes under contention and leave no assertion to make here.
  });

  test('access matrix: viewer reads, editor writes, outsider denied, unknown project mutates 404', async () => {
    // ── Member viewer: read-only ────────────────────────────────
    const viewerList = await call('GET', listUrl(), asUser(viewerToken));
    assert.strictEqual(viewerList.status, 200, 'viewer may list digests');

    const viewerCfg = await call('GET', configUrl(), asUser(viewerToken));
    assert.strictEqual(viewerCfg.status, 200, 'viewer may read the schedule');

    const viewerEntryId = digestId || UNKNOWN_ID;
    const viewerEntry = await call('GET', entryUrl(viewerEntryId), asUser(viewerToken));
    if (digestId) {
      assert.strictEqual(viewerEntry.status, 200, 'viewer may read one stored digest');
    } else {
      // No entry could be created (503 environment): the gate still passed, so
      // the honest answer is 404 — never 401/403.
      assert.strictEqual(viewerEntry.status, 404, 'viewer passes the gate; unknown id is 404');
    }

    const viewerPut = await call('PUT', configUrl(), asUser(viewerToken), { enabled: true });
    assert.strictEqual(viewerPut.status, 403, 'viewer cannot change the schedule');
    const viewerPost = await call('POST', listUrl(), asUser(viewerToken), {});
    assert.strictEqual(viewerPost.status, 403, 'viewer cannot generate a digest');
    const viewerDelete = await call('DELETE', entryUrl(viewerEntryId), asUser(viewerToken));
    assert.strictEqual(viewerDelete.status, 403, 'viewer cannot delete a digest');

    // ── Member editor: writes pass the gate ─────────────────────
    const editorPut = await call('PUT', configUrl(), asUser(editorToken), { enabled: false, intervalMin: 360 });
    assert.strictEqual(editorPut.status, 200, 'editor may change the schedule');
    assert.strictEqual(editorPut.json.intervalMin, 360);

    const editorPost = await call('POST', listUrl(), asUser(editorToken), {});
    assert.notStrictEqual(editorPost.status, 403, 'editor passes the generate gate');
    assert.notStrictEqual(editorPost.status, 500, `editor generate must never 500: ${JSON.stringify(editorPost.json)}`);

    const editorDelete = await call('DELETE', entryUrl(UNKNOWN_ID), asUser(editorToken));
    assert.strictEqual(editorDelete.status, 404, 'editor passes the gate; unknown digest id is 404');

    // ── Non-member viewer outsider: denied on everything ────────
    const outRows: Array<[string, string, unknown, string]> = [
      ['GET', listUrl(), undefined, 'list'],
      ['GET', configUrl(), undefined, 'config'],
      ['PUT', configUrl(), { enabled: true }, 'config write'],
      ['POST', listUrl(), {}, 'generate'],
      ['GET', entryUrl(digestId || UNKNOWN_ID), undefined, 'entry read'],
      ['DELETE', entryUrl(digestId || UNKNOWN_ID), undefined, 'delete'],
    ];
    for (const [method, path, body, label] of outRows) {
      const r = await call(method, path, asUser(outsiderToken), body);
      assert.strictEqual(r.status, 403, `non-member viewer must be denied ${label}, got ${r.status}`);
    }

    // ── Unknown project: mutations 404 (canonical, but absent) ──
    const unknownPut = await call('PUT', `/projects/${missingSlug}/digests/config`, authHeaders(), { enabled: true });
    assert.strictEqual(unknownPut.status, 404, `unknown project config PUT: ${unknownPut.status}`);
    const unknownPost = await call('POST', `/projects/${missingSlug}/digests`, authHeaders(), {});
    assert.strictEqual(unknownPost.status, 404, `unknown project generate: ${unknownPost.status}`);
    const unknownDelete = await call('DELETE', `/projects/${missingSlug}/digests/${UNKNOWN_ID}`, authHeaders());
    assert.strictEqual(unknownDelete.status, 404, `unknown project delete: ${unknownDelete.status}`);
  });

  test('activity feed records the digest config change and, when it ran, a generation', async () => {
    const res = await call('GET', `/projects/${slug}/activity`, authHeaders());
    assert.strictEqual(res.status, 200, `activity: ${res.status}`);
    const entries: any[] = Array.isArray(res.json.entries) ? res.json.entries : [];
    const actions = entries.map((e) => e.action);
    assert.ok(actions.includes('digest_config'), `activity must record digest_config (actions: ${actions.join(',')})`);
    if (generated) {
      assert.ok(actions.includes('digest_generated'), `activity must record digest_generated (actions: ${actions.join(',')})`);
    }
  });

  test('delete removes an entry (200 → GET 404); an unknown id is 404', async () => {
    if (digestId) {
      const del = await call('DELETE', entryUrl(digestId), authHeaders());
      assert.strictEqual(del.status, 200, `delete: ${del.status}`);
      assert.strictEqual(del.json.ok, true);

      const gone = await call('GET', entryUrl(digestId), authHeaders());
      assert.strictEqual(gone.status, 404, 'a deleted digest is gone');
      digestId = '';
    }

    const unknown = await call('DELETE', entryUrl(UNKNOWN_ID), authHeaders());
    assert.strictEqual(unknown.status, 404, `delete unknown id: ${unknown.status}`);
  });
});
