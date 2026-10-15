import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import {
  uniqueId,
  req,
  initTestAuth,
  authHeaders,
  signUserToken,
  liveUser,
  cleanupLiveUsers,
} from './helpers.ts';

/**
 * Planning suggestions (rule-based canvas/notes recommendations) — live suite.
 *
 * Exercises the real HTTP surface against the running container: route auth, the
 * viewer/editor/outsider access matrix, the rule-compute correctness, the
 * dismiss roundtrip, the accept roundtrip (a note lands via the notes store, a
 * card via the canvas store), the 404/400 boundaries, and the activity feed the
 * accept records. Mirrors project-digest.test.ts (the same helper/backoff and
 * self-cleanup contract).
 *
 * The suite owns ONE project plus a real editor + viewer member and a real
 * non-member viewer outsider, plus two short-lived THROWAWAY projects (the
 * empty_board seed-hygiene and all-done-fallback rows — the main project's
 * empty_board key is already dismissed, so a fresh project is the only honest
 * way to re-accept); after() deletes the owned users and any throwaway users
 * liveUser() created, and each throwaway row deletes its own project.
 */

interface CallResult {
  status: number;
  json: any;
}

const DAY_MS = 86_400_000;

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
      const res = await req('DELETE', path, undefined, authHeaders());
      if (res.status === 200 || res.status === 404) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

/**
 * Create the test project, honouring Retry-After: the dev container runs
 * WSD_TESTING=0 (production rate budgets), so a busy full run can 429 a create.
 */
async function createProject(body: Record<string, unknown>): Promise<CallResult> {
  let last: CallResult = { status: 0, json: {} };
  for (let i = 0; i < 10; i += 1) {
    const res = await req('POST', '/projects', body, authHeaders());
    let json: any = {};
    try {
      json = await res.json();
    } catch {
      /* non-JSON body */
    }
    last = { status: res.status, json };
    if (res.status !== 429) return last;
    const secs = Math.max(1, parseInt(String((res as any).headers?.get?.('Retry-After') || '5'), 10));
    await new Promise((r) => setTimeout(r, secs * 1000 + 250));
  }
  return last;
}

describe('Planning suggestions (real Docker container)', () => {
  let slug = '';
  let missingSlug = '';
  let editorId = '';
  let viewerId = '';
  let editorToken = '';
  let viewerToken = '';
  let outsiderToken = '';
  let created = false;

  const GOAL_TEXT = 'Ship the planning suggestions feature';
  const BUG_TEXT = 'Login is slow';
  const IDEA_TEXT = 'Add a dark mode toggle';

  const listUrl = (s = slug) => `/projects/${s}/suggestions`;
  const dismissUrl = (s = slug) => `/projects/${s}/suggestions/dismiss`;
  const acceptUrl = (s = slug) => `/projects/${s}/suggestions/accept`;

  /** The first current suggestion of a given kind (via the read route). */
  async function suggestionOfKind(kind: string, s = slug): Promise<any | null> {
    const r = await call('GET', listUrl(s), authHeaders());
    assert.strictEqual(r.status, 200, `list for kind ${kind}: ${r.status}`);
    const items: any[] = Array.isArray(r.json.items) ? r.json.items : [];
    return items.find((x) => x.kind === kind) || null;
  }

  before(async () => {
    await initTestAuth();
    slug = uniqueId('suggest-test');
    missingSlug = uniqueId('suggest-missing');

    const createdRes = await createProject({ name: 'Suggest Test', slug, description: 'temporary project for planning-suggestion testing' });
    assert.strictEqual(createdRes.status, 201, `project create: ${createdRes.status} — ${JSON.stringify(createdRes.json)}`);
    created = true;

    // Seed notes so the rules have deterministic subjects: an open goal with no
    // card (goal_without_task), a stale open bug (stale_bug), and an open idea
    // absent from the board (untracked_idea). The canvas stays empty, which also
    // makes empty_board fire.
    const notesRes = await call('PUT', `/projects/${slug}/notes`, authHeaders(), {
      items: [
        { id: 'g1', text: GOAL_TEXT, kind: 'goal', done: false, createdAt: new Date().toISOString() },
        { id: 'b1', text: BUG_TEXT, kind: 'bug', done: false, createdAt: new Date(Date.now() - 20 * DAY_MS).toISOString() },
        { id: 'i1', text: IDEA_TEXT, kind: 'idea', done: false, createdAt: new Date().toISOString() },
      ],
    });
    assert.strictEqual(notesRes.status, 200, `seed notes: ${notesRes.status} — ${JSON.stringify(notesRes.json)}`);

    // A real editor and a real viewer member (verifyToken refuses ids that are
    // not in users.json, so an invented identity would prove nothing).
    const editorName = uniqueId('sug-editor').replace(/[^a-z0-9-]/g, '');
    const viewerName = uniqueId('sug-viewer').replace(/[^a-z0-9-]/g, '');
    const e = await call('POST', '/users', authHeaders(), { username: editorName, password: 'suggest-pw-2026', role: 'editor' });
    assert.strictEqual(e.status, 201, `create editor: ${e.status} — ${JSON.stringify(e.json)}`);
    editorId = e.json.id;
    const v = await call('POST', '/users', authHeaders(), { username: viewerName, password: 'suggest-pw-2026', role: 'viewer' });
    assert.strictEqual(v.status, 201, `create viewer: ${v.status} — ${JSON.stringify(v.json)}`);
    viewerId = v.json.id;

    editorToken = signUserToken({ id: editorId, username: editorName, role: 'editor' });
    viewerToken = signUserToken({ id: viewerId, username: viewerName, role: 'viewer' });

    const addEditor = await call('POST', `/projects/${slug}/members`, authHeaders(), { userId: editorId, role: 'editor' });
    assert.strictEqual(addEditor.status, 200, `add editor member: ${addEditor.status} — ${JSON.stringify(addEditor.json)}`);
    const addViewer = await call('POST', `/projects/${slug}/members`, authHeaders(), { userId: viewerId, role: 'viewer' });
    assert.strictEqual(addViewer.status, 200, `add viewer member: ${addViewer.status} — ${JSON.stringify(addViewer.json)}`);

    outsiderToken = (await liveUser('viewer', 'suggest-outsider')).token;
  });

  after(async () => {
    if (created) await deleteRobust(`/projects/${slug}`);
    if (viewerId) await deleteRobust(`/users/${viewerId}`);
    if (editorId) await deleteRobust(`/users/${editorId}`);
    await cleanupLiveUsers();
  });

  test('every suggestions route requires a token (401)', async () => {
    const noAuth: Record<string, string> = {};
    const rows: Array<[string, string, unknown]> = [
      ['GET', listUrl(), undefined],
      ['POST', dismissUrl(), { key: 'x' }],
      ['POST', acceptUrl(), { key: 'x' }],
    ];
    for (const [method, path, body] of rows) {
      const r = await call(method, path, noAuth, body);
      assert.strictEqual(r.status, 401, `${method} ${path} without a token should be 401, got ${r.status}`);
    }
  });

  test('compute is correct: the seeded subjects yield the expected rule kinds', async () => {
    const r = await call('GET', listUrl(), authHeaders());
    assert.strictEqual(r.status, 200, `list: ${r.status}`);
    assert.ok(Array.isArray(r.json.items), 'the list carries an items array');
    assert.strictEqual(r.json.total, r.json.items.length, 'total is honest');

    const items: any[] = r.json.items;
    const kinds = items.map((s) => s.kind);
    assert.ok(kinds.includes('goal_without_task'), `expected goal_without_task (kinds: ${kinds.join(',')})`);
    assert.ok(kinds.includes('stale_bug'), `expected stale_bug (kinds: ${kinds.join(',')})`);
    assert.ok(kinds.includes('untracked_idea'), `expected untracked_idea (kinds: ${kinds.join(',')})`);

    for (const s of items) {
      assert.match(s.id, /^s-[a-z0-9]{6}-[a-z0-9]{6}$/, `suggestion id shape: ${s.id}`);
      assert.ok(typeof s.key === 'string' && s.key.length > 0, 'every suggestion carries a non-empty key');
      assert.ok(s.target === 'note' || s.target === 'canvas', `target must be note|canvas, got ${s.target}`);
    }

    const goal = items.find((s) => s.kind === 'goal_without_task');
    assert.strictEqual(goal.target, 'canvas', 'a goal without a task card is landed as a canvas card');
    assert.strictEqual(goal.payload.text, GOAL_TEXT, 'the payload carries the goal text');

    const bug = items.find((s) => s.kind === 'stale_bug');
    assert.strictEqual(bug.target, 'note', 'a stale bug is landed as a note');
    assert.strictEqual(bug.payload.text, BUG_TEXT, 'the payload carries the bug text');
  });

  test('access matrix: viewer reads, editor writes, outsider denied, unknown project 404', async () => {
    // ── Member viewer: read-only ────────────────────────────────
    const viewerList = await call('GET', listUrl(), asUser(viewerToken));
    assert.strictEqual(viewerList.status, 200, 'viewer may list suggestions');
    const viewerDismiss = await call('POST', dismissUrl(), asUser(viewerToken), { key: 'x' });
    assert.strictEqual(viewerDismiss.status, 403, 'viewer cannot dismiss');
    const viewerAccept = await call('POST', acceptUrl(), asUser(viewerToken), { key: 'x' });
    assert.strictEqual(viewerAccept.status, 403, 'viewer cannot accept');

    // ── Member editor: the write gate opens (404 for the unknown key proves
    // the request passed the gate; a 403 would mean it was denied) ──────────
    const editorAcceptBogus = await call('POST', acceptUrl(), asUser(editorToken), { key: 'no-such::key' });
    assert.strictEqual(editorAcceptBogus.status, 404, `editor clears the write gate: ${editorAcceptBogus.status}`);

    // ── Non-member viewer outsider: denied on all three ─────────
    const outRows: Array<[string, string, unknown, string]> = [
      ['GET', listUrl(), undefined, 'list'],
      ['POST', dismissUrl(), { key: 'x' }, 'dismiss'],
      ['POST', acceptUrl(), { key: 'x' }, 'accept'],
    ];
    for (const [method, path, body, label] of outRows) {
      const r = await call(method, path, asUser(outsiderToken), body);
      assert.strictEqual(r.status, 403, `non-member viewer must be denied ${label}, got ${r.status}`);
    }

    // ── Unknown project: all three 404 (canonical, but absent) ──
    const unknownRows: Array<[string, string, unknown, string]> = [
      ['GET', listUrl(missingSlug), undefined, 'list'],
      ['POST', dismissUrl(missingSlug), { key: 'x' }, 'dismiss'],
      ['POST', acceptUrl(missingSlug), { key: 'x' }, 'accept'],
    ];
    for (const [method, path, body, label] of unknownRows) {
      const r = await call(method, path, authHeaders(), body);
      assert.strictEqual(r.status, 404, `unknown project ${label} must 404, got ${r.status}`);
    }
  });

  test('dismiss roundtrip: dismissals survive recompute, unknown key 404, junk 400', async () => {
    const target = await suggestionOfKind('untracked_idea');
    assert.ok(target, 'expected an untracked_idea suggestion to dismiss');
    const key = target.key as string;

    // The editor writes (the admin token is not the point of this row).
    const dismissed = await call('POST', dismissUrl(), asUser(editorToken), { key });
    assert.strictEqual(dismissed.status, 200, `dismiss: ${dismissed.status} — ${JSON.stringify(dismissed.json)}`);
    assert.strictEqual(dismissed.json.ok, true);

    // GET recomputes the list live each time; the dismissal must persist across
    // BOTH reads (it is the only thing the store holds).
    for (let i = 0; i < 2; i += 1) {
      const after = await call('GET', listUrl(), authHeaders());
      assert.strictEqual(after.status, 200);
      const keys = (after.json.items as any[]).map((s) => s.key);
      assert.ok(!keys.includes(key), `the dismissed key must stay absent on recompute #${i + 1}`);
    }

    // Unknown key → 404 (symmetric with accept), missing key → 400.
    const unknown = await call('POST', dismissUrl(), asUser(editorToken), { key: 'untracked_idea::no-such-subject' });
    assert.strictEqual(unknown.status, 404, 'a key matching no current suggestion is 404');
    const junk = await call('POST', dismissUrl(), asUser(editorToken), {});
    assert.strictEqual(junk.status, 400, 'a missing key is 400');
  });

  test('accept roundtrip: a note lands via notes, a card via the canvas (unknown key 404, junk 400)', async () => {
    // ── target:'canvas' — goal_without_task lands a card ────────
    const goal = await suggestionOfKind('goal_without_task');
    assert.ok(goal, 'expected a goal_without_task suggestion');
    const goalAccept = await call('POST', acceptUrl(), asUser(editorToken), { key: goal.key });
    assert.strictEqual(goalAccept.status, 200, `accept goal: ${goalAccept.status} — ${JSON.stringify(goalAccept.json)}`);
    assert.strictEqual(goalAccept.json.ok, true);
    assert.strictEqual(goalAccept.json.landed.target, 'canvas', 'the goal lands on the canvas');
    assert.ok(typeof goalAccept.json.landed.id === 'string' && goalAccept.json.landed.id.length > 0);

    const canvasRes = await call('GET', `/projects/${slug}/canvas`, authHeaders());
    assert.strictEqual(canvasRes.status, 200, `canvas read: ${canvasRes.status}`);
    const nodes: any[] = Array.isArray(canvasRes.json.nodes) ? canvasRes.json.nodes : [];
    assert.ok(
      nodes.some((n) => n.type === 'card' && n.text === GOAL_TEXT),
      `the accepted goal must appear as a card (nodes: ${JSON.stringify(nodes.map((n) => n.text))})`,
    );

    // ── target:'note' — stale_bug lands a note ──────────────────
    const bug = await suggestionOfKind('stale_bug');
    assert.ok(bug, 'expected a stale_bug suggestion');
    const notesBefore = await call('GET', `/projects/${slug}/notes`, authHeaders());
    const beforeCount = Array.isArray(notesBefore.json.items) ? notesBefore.json.items.length : 0;

    const bugAccept = await call('POST', acceptUrl(), asUser(editorToken), { key: bug.key });
    assert.strictEqual(bugAccept.status, 200, `accept bug: ${bugAccept.status} — ${JSON.stringify(bugAccept.json)}`);
    assert.strictEqual(bugAccept.json.landed.target, 'note', 'the stale bug lands as a note');

    const notesAfter = await call('GET', `/projects/${slug}/notes`, authHeaders());
    const items: any[] = Array.isArray(notesAfter.json.items) ? notesAfter.json.items : [];
    assert.strictEqual(items.length, beforeCount + 1, 'accepting a note suggestion appends one note');
    assert.ok(items.some((n) => n.text === BUG_TEXT), 'the accepted note carries the suggestion text');

    // ── Boundaries: unknown key 404, missing key 400 ────────────
    const unknownKey = await call('POST', acceptUrl(), authHeaders(), { key: 'goal_without_task::no-such-subject' });
    assert.strictEqual(unknownKey.status, 404, 'a key matching no current suggestion is 404');
    const missingKey = await call('POST', acceptUrl(), authHeaders(), {});
    assert.strictEqual(missingKey.status, 400, 'a missing key is 400');
  });

  test('empty_board accept seeds one card per open note (never a blank card)', async () => {
    // Clear the board so `empty_board` fires again (accepting it is the only
    // way to make the rule go away, so re-emptying is the honest setup).
    const cleared = await call('PUT', `/projects/${slug}/canvas`, authHeaders(), { nodes: [], edges: [] });
    assert.strictEqual(cleared.status, 200, `clear canvas: ${cleared.status}`);

    const board = await suggestionOfKind('empty_board');
    assert.ok(board, 'expected an empty_board suggestion with notes present and no nodes');
    assert.strictEqual(board.payload.text, '', 'the rule itself carries no text');

    const openNotes = await call('GET', `/projects/${slug}/notes`, authHeaders());
    const openTexts: string[] = (Array.isArray(openNotes.json.items) ? openNotes.json.items : [])
      .filter((n: any) => n.done !== true)
      .map((n: any) => n.text);
    assert.ok(openTexts.length > 0, 'there must be open notes to seed from');

    const accept = await call('POST', acceptUrl(), asUser(editorToken), { key: board.key });
    assert.strictEqual(accept.status, 200, `accept empty_board: ${accept.status} — ${JSON.stringify(accept.json)}`);
    assert.strictEqual(accept.json.landed.target, 'canvas');
    assert.ok(typeof accept.json.landed.id === 'string' && accept.json.landed.id.length > 0);

    const canvasRes = await call('GET', `/projects/${slug}/canvas`, authHeaders());
    const cards: any[] = (Array.isArray(canvasRes.json.nodes) ? canvasRes.json.nodes : []).filter(
      (n: any) => n.type === 'card',
    );
    assert.strictEqual(cards.length, openTexts.length, `one card per open note (cards: ${cards.length})`);
    assert.ok(cards.every((c) => typeof c.text === 'string' && c.text.length > 0), 'no blank card is ever landed');
    for (const text of openTexts) {
      assert.ok(cards.some((c) => c.text === text), `the seeded card carries the note text: ${text}`);
    }
    assert.ok(cards.some((c) => c.id === accept.json.landed.id), 'landed.id names the first seeded card');
    assert.ok(!(await suggestionOfKind('empty_board')), 'empty_board no longer fires once the board is seeded');
  });

  test('activity feed records suggestion_accepted', async () => {
    const res = await call('GET', `/projects/${slug}/activity`, authHeaders());
    assert.strictEqual(res.status, 200, `activity: ${res.status}`);
    const entries: any[] = Array.isArray(res.json.entries) ? res.json.entries : [];
    const actions = entries.map((e) => e.action);
    assert.ok(
      actions.includes('suggestion_accepted'),
      `activity must record suggestion_accepted (actions: ${actions.join(',')})`,
    );
  });

  test('empty_board accept chains the seeded cards and auto-dismisses only the self-created duplicate_item keys', async () => {
    // A dedicated throwaway project: the main project's empty_board key is
    // already dismissed (accepting it is the only way to make the rule go
    // away), so a fresh project is the honest way to re-accept.
    const boardSlug = uniqueId('suggest-m1');
    const createdRes = await createProject({
      name: 'Suggest M1',
      slug: boardSlug,
      description: 'throwaway for empty-board seed hygiene',
    });
    assert.strictEqual(createdRes.status, 201, `m1 project create: ${createdRes.status} — ${JSON.stringify(createdRes.json)}`);
    try {
      const seedTexts = ['Draft the API contract', 'Wire the database schema', 'Ship the first milestone'];
      const nowIso = new Date().toISOString();
      const seedItems = seedTexts.map((text, i) => ({
        id: `m1-${i + 1}`,
        text,
        kind: 'idea',
        done: false,
        createdAt: nowIso,
      }));
      const notesRes = await call('PUT', `/projects/${boardSlug}/notes`, authHeaders(), { items: seedItems });
      assert.strictEqual(notesRes.status, 200, `m1 seed notes: ${notesRes.status} — ${JSON.stringify(notesRes.json)}`);

      const board = await suggestionOfKind('empty_board', boardSlug);
      assert.ok(board, 'expected an empty_board suggestion on the fresh project');
      const accept = await call('POST', `/projects/${boardSlug}/suggestions/accept`, authHeaders(), { key: board.key });
      assert.strictEqual(accept.status, 200, `accept m1 empty_board: ${accept.status} — ${JSON.stringify(accept.json)}`);

      // (a) the seeded cards are CHAINED: N cards carry N-1 edges and every
      // card id is an edge endpoint, so the next recompute cannot fire
      // orphan_card on the board this accept just created.
      const canvasRes = await call('GET', `/projects/${boardSlug}/canvas`, authHeaders());
      assert.strictEqual(canvasRes.status, 200, `m1 canvas read: ${canvasRes.status}`);
      const nodes: any[] = Array.isArray(canvasRes.json.nodes) ? canvasRes.json.nodes : [];
      const cards: any[] = nodes.filter((n: any) => n.type === 'card');
      assert.strictEqual(cards.length, seedTexts.length, `one card per seeded note (cards: ${cards.length})`);
      const edges: any[] = Array.isArray(canvasRes.json.edges) ? canvasRes.json.edges : [];
      assert.strictEqual(edges.length, cards.length - 1, `a chain of ${cards.length} cards carries ${cards.length - 1} edges`);
      const endpoints = new Set<string>(edges.flatMap((e: any) => [e.from, e.to]));
      for (const c of cards) {
        assert.ok(endpoints.has(c.id), `seeded card ${c.id} must be touched by the chain (a zero-edge card re-fires orphan_card)`);
      }

      // (b) the next GET carries no orphan_card and no duplicate_item that
      // references a seeded card (the note↔card dups the seeding created were
      // auto-dismissed inside the accept's lock).
      const list = await call('GET', `/projects/${boardSlug}/suggestions`, authHeaders());
      assert.strictEqual(list.status, 200, `m1 list: ${list.status}`);
      const items: any[] = Array.isArray(list.json.items) ? list.json.items : [];
      const orphans = items.filter((s) => s.kind === 'orphan_card');
      assert.deepStrictEqual(orphans, [], `the seeded cards must not re-suggest as orphans: ${JSON.stringify(orphans)}`);
      const cardIds = new Set<string>(cards.map((c) => c.id));
      const seededDups = items.filter(
        (s) => s.kind === 'duplicate_item' && (s.refs as string[]).some((r) => cardIds.has(r)),
      );
      assert.deepStrictEqual(seededDups, [], `the self-created duplicate_item keys must be auto-dismissed: ${JSON.stringify(seededDups)}`);

      // Non-vacuity + selectivity: the duplicate RULE is live on this project
      // (two fresh duplicate notes fire exactly one note↔note key) and that
      // unrelated key — touching no seeded card — SURVIVES the auto-dismiss.
      const ctrlRes = await call('PUT', `/projects/${boardSlug}/notes`, authHeaders(), {
        items: [
          ...seedItems,
          { id: 'm1-4', text: 'Write the deployment guide', kind: 'idea', done: false, createdAt: nowIso },
          { id: 'm1-5', text: '  write   THE deployment   guide ', kind: 'idea', done: false, createdAt: nowIso },
        ],
      });
      assert.strictEqual(ctrlRes.status, 200, `m1 control notes: ${ctrlRes.status}`);
      const list2 = await call('GET', `/projects/${boardSlug}/suggestions`, authHeaders());
      assert.strictEqual(list2.status, 200, `m1 list after control: ${list2.status}`);
      const items2: any[] = Array.isArray(list2.json.items) ? list2.json.items : [];
      const ctrlDups = items2.filter((s) => s.kind === 'duplicate_item');
      assert.strictEqual(ctrlDups.length, 1, `only the unrelated control duplicate remains: ${JSON.stringify(ctrlDups)}`);
      assert.deepStrictEqual([...(ctrlDups[0].refs as string[])].sort(), ['m1-4', 'm1-5'], 'the surviving duplicate is the note↔note control pair');
      assert.ok(!(ctrlDups[0].refs as string[]).some((r) => cardIds.has(r)), 'the surviving duplicate touches no seeded card');
      assert.deepStrictEqual(items2.filter((s) => s.kind === 'orphan_card'), [], 'still no orphan_card after the control notes');
    } finally {
      await deleteRobust(`/projects/${boardSlug}`);
    }
  });

  test('empty_board accept falls back to done notes when no note is open', async () => {
    const fbSlug = uniqueId('suggest-m2');
    const createdRes = await createProject({
      name: 'Suggest M2',
      slug: fbSlug,
      description: 'throwaway for the empty-board all-done fallback',
    });
    assert.strictEqual(createdRes.status, 201, `m2 project create: ${createdRes.status} — ${JSON.stringify(createdRes.json)}`);
    try {
      const texts = ['Closed task alpha', 'Closed task beta'];
      const notesRes = await call('PUT', `/projects/${fbSlug}/notes`, authHeaders(), {
        items: texts.map((text, i) => ({
          id: `m2-${i + 1}`,
          text,
          kind: 'idea',
          done: true,
          createdAt: new Date().toISOString(),
        })),
      });
      assert.strictEqual(notesRes.status, 200, `m2 seed notes: ${notesRes.status} — ${JSON.stringify(notesRes.json)}`);

      const board = await suggestionOfKind('empty_board', fbSlug);
      assert.ok(board, 'ruleEmptyBoard counts done notes too, so the suggestion fires with every note done');

      const accept = await call('POST', `/projects/${fbSlug}/suggestions/accept`, authHeaders(), { key: board.key });
      assert.strictEqual(accept.status, 200, `accept m2 empty_board: ${accept.status} — ${JSON.stringify(accept.json)}`);
      assert.strictEqual(accept.json.landed.target, 'canvas', 'the fallback still lands on the canvas');

      const canvasRes = await call('GET', `/projects/${fbSlug}/canvas`, authHeaders());
      assert.strictEqual(canvasRes.status, 200, `m2 canvas read: ${canvasRes.status}`);
      const cards: any[] = (Array.isArray(canvasRes.json.nodes) ? canvasRes.json.nodes : []).filter(
        (n: any) => n.type === 'card',
      );
      assert.strictEqual(cards.length, texts.length, `the all-done fallback seeds one card per done note (cards: ${cards.length})`);
      for (const text of texts) {
        assert.ok(cards.some((c) => c.text === text), `the fallback card carries the done note's text: ${text}`);
      }
    } finally {
      await deleteRobust(`/projects/${fbSlug}`);
    }
  });
});
