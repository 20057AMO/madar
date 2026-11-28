/**
 * project-notes.test.ts
 * Per-project developer notes (ideas / bugs / goals):
 *   - CRUD via GET/PUT /api/projects/:slug/notes
 *   - Validation (junk body, oversized text, unknown kinds normalized)
 *   - Smart-context injection: notes surface in GET /api/chat/context
 *     as "Developer notes" and in the 'all' brief as per-project counts
 *
 * Runs against the live container on port 3000.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { uniqueId, reqAuth, initTestAuth } from './helpers.ts';

const DOCKER_SKIP = process.env.WSD_TEST_DOCKER === '1' ? false : 'requires WSD_TEST_DOCKER=1 (real Docker container)';

describe('Project Notes', { skip: DOCKER_SKIP }, () => {
  before(async () => { await initTestAuth(); });

  const slug = uniqueId('notes-test');
  let created = false;

  const NOTES = [
    {
      id: 'n-bug-1',
      text: 'Login returns 500 when email contains uppercase',
      kind: 'bug',
      done: false,
      createdAt: '2026-01-01T10:00:00.000Z',
    },
    {
      id: 'n-goal-1',
      text: 'Ship public beta by end of quarter',
      kind: 'goal',
      done: false,
      createdAt: '2026-01-02T10:00:00.000Z',
    },
    {
      id: 'n-idea-1',
      text: 'Add dark/light toggle to settings',
      kind: 'idea',
      done: true,
      createdAt: '2026-01-03T10:00:00.000Z',
    },
  ];

  after(async () => {
    if (!created) return;
    await reqAuth('DELETE', `/projects/${slug}`).catch(() => {});
  });

  test('create scratch project', async () => {
    const send = () =>
      reqAuth('POST', '/projects', {
        name: 'Notes Test Project',
        slug,
        description: 'temporary — notes suite',
      });
    let res = await send();
    // One retry on transient docker hiccups (raw dockerode errors surface as
    // err.statusCode → 400/5xx). A real 409 conflict fails fast either way.
    if (res.status !== 201 && res.status !== 409) {
      await new Promise((r) => setTimeout(r, 2500));
      res = await send();
    }
    let detail = '';
    if (res.status !== 201) {
      const body = await res.json().catch(() => null);
      detail = ` ${JSON.stringify(body?.error ?? body ?? '')}`;
    }
    assert.strictEqual(res.status, 201, `create failed: ${res.status}${detail}`);
    created = true;
  });

  test('GET notes starts empty', async () => {
    const res = await reqAuth('GET', `/projects/${slug}/notes`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.deepStrictEqual(data.items, []);
  });

  test('PUT saves the full document and echoes it back', async () => {
    const res = await reqAuth('PUT', `/projects/${slug}/notes`, { items: NOTES });
    assert.strictEqual(res.status, 200, `save failed: ${res.status}`);
    const data = await res.json();
    assert.strictEqual(data.items.length, 3);
    assert.strictEqual(data.items[0].kind, 'bug');
    assert.strictEqual(data.items[1].kind, 'goal');
    assert.strictEqual(data.items[2].done, true);
  });

  test('GET persists across requests', async () => {
    const res = await reqAuth('GET', `/projects/${slug}/notes`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.items.length, 3);
    assert.ok(data.items.some((n: any) => n.text.includes('500')));
  });

  test('PUT rejects a body without items array', async () => {
    const res = await reqAuth('PUT', `/projects/${slug}/notes`, { hello: true });
    assert.strictEqual(res.status, 400);
  });

  test('PUT rejects more than MAX_ITEMS entries', async () => {
    const flood = Array.from({ length: 301 }, (_, i) => ({
      id: `x${i}`,
      text: `note ${i}`,
      kind: 'idea',
    }));
    const res = await reqAuth('PUT', `/projects/${slug}/notes`, { items: flood });
    assert.strictEqual(res.status, 400);
  });

  test('oversized text is truncated, junk rows dropped, bad kinds normalized', async () => {
    const weird = [
      { text: 'x'.repeat(5000), kind: 'bug' }, // truncated to 2000
      { text: '   ', kind: 'idea' }, // empty after trim → dropped
      { noText: true }, // dropped
      { text: 'kindless note' }, // kind defaults to idea
    ];
    const res = await reqAuth('PUT', `/projects/${slug}/notes`, { items: weird });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.items.length, 2);
    assert.ok(data.items[0].text.length <= 2000);
    assert.strictEqual(data.items[1].kind, 'idea');
  });

  test('context injection: Developer notes section appears with bugs/goals/ideas order', async () => {
    // restore the canonical three-note set
    await reqAuth('PUT', `/projects/${slug}/notes`, { items: NOTES });
    // workspace scan caches for 60s keyed on files+notes sig; new project → fresh build
    const res = await reqAuth('GET', `/chat/context?project=${encodeURIComponent(slug)}`);
    assert.strictEqual(res.status, 200, `context failed: ${res.status}`);
    const data = await res.json();
    assert.match(data.text, /\[Developer notes\]/);
    assert.match(data.text, /### Known issues \(open\)[\s\S]*Login returns 500/);
    assert.match(data.text, /### Active goals[\s\S]*public beta/);
    assert.ok(!data.text.includes('dark/light toggle'), 'done ideas must be omitted');
    assert.match(data.text, /1 completed note\(s\) omitted/);
  });

  test("'all' brief shows per-project open counts", async () => {
    const res = await reqAuth('GET', '/chat/context?project=all');
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.match(data.text, new RegExp(`${slug}[^\\n]*notes: 1 open bug\\(s\\), 1 active goal\\(s\\)`));
  });
});
