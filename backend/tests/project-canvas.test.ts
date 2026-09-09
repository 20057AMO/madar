import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { req, reqAuth, uniqueId, initTestAuth, JWT_SECRET } from './helpers.ts';
import type { CanvasNode, ProjectCanvas } from '../src/services/project-canvas.ts';

/**
 * Project canvas (visual planning): fresh empty doc, PUT/GET roundtrip with
 * positions/colors/done preserved, junk normalization + numeric clamps,
 * payload 400s (missing arrays / over caps / non-object), access control
 * (member viewer read-only, editor writes, outsider 403), canvasEditedAt on
 * the project list, and the pure context formatter.
 */

const createdSlugs: string[] = [];

const node = (id: string, text: string, over: Partial<CanvasNode> = {}): CanvasNode => ({
  id,
  type: 'note',
  text,
  x: 40,
  y: 80,
  w: 220,
  h: 100,
  color: 'yellow',
  ...over,
});

const edge = (id: string, from: string, to: string) => ({ id, from, to });

const canvasDoc = (nodes: CanvasNode[], edges = []): ProjectCanvas => ({
  version: 1,
  nodes,
  edges,
  updatedAt: null,
});

async function api(method: string, urlPath: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await reqAuth(method, urlPath, body);
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, json };
}

before(async () => {
  await initTestAuth();
});

after(async () => {
  for (const slug of createdSlugs) {
    try {
      await reqAuth('DELETE', `/projects/${slug}`);
    } catch {
      /* already gone */
    }
  }
});

async function createTestProject(prefix: string): Promise<string> {
  const slug = uniqueId(prefix);
  const created = await api('POST', '/projects', { name: prefix.toUpperCase(), slug });
  assert.strictEqual(created.status, 201, `create ${slug}: ${created.status}`);
  createdSlugs.push(slug);
  return slug;
}

test('fresh project: empty canvas with default shape and null updatedAt', async () => {
  const slug = await createTestProject('canvas-empty');
  const { status, json } = await api('GET', `/projects/${slug}/canvas`);
  assert.strictEqual(status, 200);
  assert.strictEqual(json.version, 1);
  assert.deepStrictEqual(json.nodes, []);
  assert.deepStrictEqual(json.edges, []);
  assert.strictEqual(json.updatedAt, null);
});

test('save canvas: valid document roundtrips, positions/colors/done preserved, updatedAt stamped', async () => {
  const slug = await createTestProject('canvas-roundtrip');
  const doc = canvasDoc(
    [
      node('note-1', 'Sticky note text'),
      node('card-1', 'Task card', { type: 'card', done: true, color: 'blue', shape: 'diamond', x: 400, y: 300, w: 280, h: 160 }),
    ],
    [edge('e-1', 'note-1', 'card-1')]
  );
  const { status, json } = await api('PUT', `/projects/${slug}/canvas`, doc);
  assert.strictEqual(status, 200, `put: ${JSON.stringify(json)}`);
  assert.strictEqual(json.nodes.length, 2);
  assert.strictEqual(json.edges.length, 1);
  assert.ok(json.updatedAt, 'updatedAt stamped on save');

  const got = await api('GET', `/projects/${slug}/canvas`);
  assert.strictEqual(got.json.nodes.length, 2);
  assert.strictEqual(got.json.nodes[1].type, 'card');
  assert.strictEqual(got.json.nodes[1].done, true);
  assert.strictEqual(got.json.nodes[1].color, 'blue');
  assert.strictEqual(got.json.nodes[1].shape, 'diamond');
  assert.strictEqual(got.json.nodes[1].x, 400);
  assert.strictEqual(got.json.nodes[1].y, 300);
  assert.strictEqual(got.json.edges[0].from, 'note-1');
  assert.strictEqual(got.json.edges[0].to, 'card-1');
  assert.strictEqual(got.json.updatedAt, json.updatedAt);
});

test('canvas normalization: junk rows dropped, bad edges removed, numeric clamps applied', async () => {
  const slug = await createTestProject('canvas-normalize');
  const { status } = await api('PUT', `/projects/${slug}/canvas`, {
    version: 1,
    nodes: [
      node('note-1', 'kept'),
      { id: '', text: '', x: 'inf', y: null, w: 3, h: 99999, color: 'purple', type: null },
      42,
      null,
      { id: 'note-2', text: 'ok', x: 0, y: 0, w: 50, h: 30, color: 'green', type: 'card', done: true },
    ],
    edges: [
      edge('e-1', 'note-1', 'note-2'),
      edge('e-bad', 'note-1', 'missing-node'),
      edge('e-self', 'x', 'x'),
      { id: 'e-garbage', from: 5, to: undefined },
    ],
  });
  assert.strictEqual(status, 200);
  const { json } = await api('GET', `/projects/${slug}/canvas`);
  assert.strictEqual(json.nodes.length, 3, 'junk object is kept as an empty note (regenerated id)');
  const ids = json.nodes.map((n: any) => n.id);
  assert.ok(ids.includes('note-1') && ids.includes('note-2'), 'valid nodes preserved');
  assert.deepStrictEqual(json.edges.map((e: any) => e.id), ['e-1']);
  const n2 = json.nodes.find((n: any) => n.id === 'note-2');
  assert.strictEqual(n2.w, 60, 'tiny width floored');
  assert.strictEqual(n2.h, 40, 'small height floored');
  assert.strictEqual(n2.textX, 10, 'text x defaults inside the node');
  assert.strictEqual(n2.textY, 10, 'text y defaults inside the node');
  assert.strictEqual(n2.textSize, 14, 'text size defaults safely');
  assert.strictEqual(n2.textAlign, 'left', 'text alignment defaults safely');
  assert.strictEqual(n2.textBold, false, 'bold defaults safely');
  assert.strictEqual(n2.textItalic, false, 'italic defaults safely');
  assert.strictEqual(n2.shape, 'rectangle', 'shape defaults safely');
  assert.strictEqual(n2.color, 'green');
  assert.strictEqual(n2.type, 'card');
  const n1 = json.nodes.find((n: any) => n.id === 'note-1');
  assert.strictEqual(n1.x, 40, 'position preserved');
  const junk = json.nodes.find((n: any) => n.id !== 'note-1' && n.id !== 'note-2');
  assert.strictEqual(junk.text, '', 'junk text emptied but node kept');
  assert.strictEqual(junk.x, 0, 'non-numeric x defaults to 0');
  assert.strictEqual(junk.w, 60, 'tiny width floored');
  assert.strictEqual(junk.h, 900, 'huge height capped');
  assert.strictEqual(junk.textX, 10, 'text x remains inside the node');
  assert.strictEqual(junk.textY, 10, 'text y remains inside the node');
  assert.strictEqual(junk.color, 'yellow', 'unknown color normalizes');
  assert.strictEqual(junk.type, 'note', 'unknown type normalizes');
});

test('canvas rejected: missing arrays, oversized payload, non-object body all 400', async () => {
  const slug = await createTestProject('canvas-reject');
  const bad: unknown[] = [
    { nodes: 'x', edges: [] },
    { nodes: [], edges: {} },
    null,
    { nodes: new Array(201).fill(node('n', 'x')), edges: [] },
    { nodes: [], edges: new Array(401).fill(edge('e', 'a', 'b')) },
  ];
  for (const body of bad) {
    const { status } = await api('PUT', `/projects/${slug}/canvas`, body);
    assert.strictEqual(status, 400, `expected 400 for ${JSON.stringify(body)?.slice(0, 60)}`);
  }
});

test('canvas access control: member viewer read-only, editor writes, outsider 403', async () => {
  const slug = await createTestProject('canvas-acl');

  // Members must be real users (the members route validates existence).
  const mkUser = async (name: string, role: string): Promise<{ id: string; username: string }> => {
    const create = await reqAuth('POST', '/users', { username: name, password: 'canvas-test-pw' });
    assert.strictEqual(create.status, 201, `create user ${name}: ${create.status}`);
    const u = (await create.json()) as { id: string; username: string };
    return { id: u.id, username: u.username };
  };
  const viewer = await mkUser(uniqueId('canvas-viewer'), 'viewer');
  const editor = await mkUser(uniqueId('canvas-editor'), 'editor');
  const outsiderUser = await mkUser(uniqueId('canvas-outsider'), 'editor');

  const tokenFor = (u: { id: string; username: string }, role: string) =>
    jwt.sign({ id: u.id, username: u.username, role, tv: 0 }, JWT_SECRET, { expiresIn: '24h' });

  const addMember = async (userId: string, role: string) => {
    const r = await reqAuth('POST', `/projects/${slug}/members`, { userId, role });
    assert.strictEqual(r.status, 200, `add member ${userId} (${role}): ${r.status}`);
  };
  await addMember(viewer.id, 'viewer');
  await addMember(editor.id, 'editor');

  // Outsider (real user, not a member): 403 even for read.
  const outsiderRes = await req('GET', `/projects/${slug}/canvas`, undefined, {
    Authorization: `Bearer ${tokenFor(outsiderUser, 'editor')}`,
  });
  assert.strictEqual(outsiderRes.status, 403, 'outsider cannot even read');

  // Member viewer: read 200, write 403, write never persisted.
  const viewerGet = await req('GET', `/projects/${slug}/canvas`, undefined, {
    Authorization: `Bearer ${tokenFor(viewer, 'viewer')}`,
  });
  assert.strictEqual(viewerGet.status, 200, 'member viewer can read');
  const viewerPut = await req('PUT', `/projects/${slug}/canvas`, canvasDoc([node('n', 'should not save')]), {
    Authorization: `Bearer ${tokenFor(viewer, 'viewer')}`,
  });
  assert.strictEqual(viewerPut.status, 403, 'member viewer cannot write');
  const afterViewerPut = await api('GET', `/projects/${slug}/canvas`);
  assert.strictEqual(afterViewerPut.json.nodes.length, 0, 'viewer write never persisted');

  // Member editor: can write.
  const editorPut = await req('PUT', `/projects/${slug}/canvas`, canvasDoc([node('note-1', 'by editor')]), {
    Authorization: `Bearer ${tokenFor(editor, 'editor')}`,
  });
  assert.strictEqual(editorPut.status, 200, 'member editor can write');
  const afterEditorPut = await api('GET', `/projects/${slug}/canvas`);
  assert.strictEqual(afterEditorPut.json.nodes.length, 1);
  assert.strictEqual(afterEditorPut.json.nodes[0].text, 'by editor');

  // Cleanup temp users.
  const delUser = async (u: { id: string }) => {
    try {
      await reqAuth('DELETE', `/users/${u.id}`);
    } catch {
      /* ignore */
    }
  };
  await delUser(viewer);
  await delUser(editor);
  await delUser(outsiderUser);
});

test('canvasEditedAt is exposed on the project list after a save', async () => {
  const slug = await createTestProject('canvas-list');
  const { status } = await api('PUT', `/projects/${slug}/canvas`, canvasDoc([node('n', 'recent')]));
  assert.strictEqual(status, 200);
  const res = await reqAuth('GET', '/projects');
  const list = (await res.json()).projects as any[];
  const p = list.find((x) => x.slug === slug);
  assert.ok(p, 'created project listed');
  assert.ok(p.canvasEditedAt, 'canvasEditedAt populated after a save');
});

test('canvas summary is injected into the AI chat context (server-side)', async () => {
  const slug = await createTestProject('canvas-context');
  const emptyCtx = await api('GET', `/chat/context?project=${slug}`);
  assert.strictEqual(emptyCtx.status, 200);
  assert.ok(
    !(emptyCtx.json.text || '').includes('[Planning canvas]'),
    'no canvas section injected while the canvas is empty'
  );

  await api('PUT', `/projects/${slug}/canvas`, canvasDoc([
    node('a', 'Ship auth'),
    node('b', 'Review the login flow', { type: 'card', done: true, color: 'green', w: 260, h: 120 }),
    node('c', '', { type: 'card' }),
  ]));

  const ctx = await api('GET', `/chat/context?project=${slug}`);
  assert.strictEqual(ctx.status, 200);
  assert.match(ctx.json.text, /\[Planning canvas\]/);
  assert.match(ctx.json.text, /- \[note\] Ship auth/);
  assert.match(ctx.json.text, /- \[done\] Review the login flow/);
  assert.match(ctx.json.text, /1 completed card\(s\)/);
  assert.ok(!/\[note\]\s*$/.test(ctx.json.text.split('\n').find((l: string) => l.startsWith('- [note]')) || ''), 'empty placeholder omitted');
});

test('all-brief reports the canvas board size once a board exists', async () => {
  const slug = await createTestProject('canvas-allbrief');
  const before = await api('GET', '/chat/context?project=all');
  assert.strictEqual(before.status, 200);
  const freshLine = (before.json.text as string).split('\n').find((l) => l.includes(`[${slug}]`)) || '';
  assert.ok(!freshLine.includes('board:'), 'fresh project has no board marker');

  await api('PUT', `/projects/${slug}/canvas`, canvasDoc([node('a', 'One idea'), node('b', 'Two ideas')]));

  const after = await api('GET', '/chat/context?project=all');
  assert.strictEqual(after.status, 200);
  const line = (after.json.text as string).split('\n').find((l) => l.includes(`[${slug}]`)) || '';
  assert.match(line, /board: 2 nodes/);
});

test('saving a board mirrors a flat WSD_CANVAS.md into the workspace (removed when it empties)', async () => {
  const slug = await createTestProject('canvas-mirror');

  const empty = await api('GET', `/projects/${slug}/file?path=WSD_CANVAS.md`);
  assert.strictEqual(empty.status, 404, 'no mirror before the board has content');

  await api('PUT', `/projects/${slug}/canvas`, canvasDoc([
    node('m1', 'Mirror this idea'),
    node('m2', 'And this card', { type: 'card' }),
  ]));

  const mirror = await api('GET', `/projects/${slug}/file?path=WSD_CANVAS.md`);
  assert.strictEqual(mirror.status, 200, 'mirror written after board save');
  assert.match(mirror.json.content, /WSD Project Canvas/);
  assert.match(mirror.json.content, /- \[note\] Mirror this idea/);
  assert.match(mirror.json.content, /- \[task\] And this card/);

  await api('PUT', `/projects/${slug}/canvas`, canvasDoc([]));
  const gone = await api('GET', `/projects/${slug}/file?path=WSD_CANVAS.md`);
  assert.strictEqual(gone.status, 404, 'empty board removes the stale mirror');
});

test('swimlane sections: persist, normalize dangling refs, and tag the canvas mirror', async () => {
  const slug = await createTestProject('canvas-sections');

  const doc = {
    version: 1,
    nodes: [
      node('s1', 'Planned in backend', { section: 'sec-backend' }),
      node('s2', 'Planned in frontend', { section: 'sec-frontend' }),
      node('s3', 'Unassigned'),
    ],
    edges: [],
    sections: [
      { id: 'sec-backend', name: 'Backend', color: 'blue' },
      { id: 'sec-frontend', name: 'Frontend', color: 'green' },
    ],
    updatedAt: null,
  };

  const put = await api('PUT', `/projects/${slug}/canvas`, doc);
  assert.strictEqual(put.status, 200, `save sections failed: ${put.status}`);
  assert.strictEqual(put.json.sections.length, 2, 'sections persisted');
  assert.strictEqual(put.json.nodes[0].section, 'sec-backend');

  const get = await api('GET', `/projects/${slug}/canvas`);
  assert.strictEqual(get.status, 200);
  assert.strictEqual(get.json.sections.length, 2);

  // Dangling section refs are dropped on the way back.
  const dirty = {
    version: 1,
    nodes: [
      node('d1', 'Ref dangling', { section: 'ghost' }),
      node('d2', 'Fine'),
    ],
    edges: [],
    sections: [],
    updatedAt: null,
  };
  const dirtyPut = await api('PUT', `/projects/${slug}/canvas`, dirty);
  assert.strictEqual(dirtyPut.status, 200);
  assert.strictEqual(dirtyPut.json.nodes[0].section, undefined, 'dangling section ref removed');

  // Re-add a real section + assignment, then verify the mirror tags the line.
  await api('PUT', `/projects/${slug}/canvas`, {
    version: 1,
    nodes: [
      node('r1', 'Planned in infra', { section: 'sec-0' }),
    ],
    edges: [],
    sections: [{ id: 'sec-0', name: 'Infra', color: 'blue' }],
    updatedAt: null,
  });
  const mirror = await api('GET', `/projects/${slug}/file?path=WSD_CANVAS.md`);
  assert.strictEqual(mirror.status, 200, 'mirror exists with a sectioned board');
  assert.match(mirror.json.content, /- \[note\] \[Infra\] Planned in infra/);
});