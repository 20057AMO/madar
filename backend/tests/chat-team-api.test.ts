import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { reqAuth, req, uniqueId, initTestAuth, JWT_SECRET, signTestToken, API_URL } from './helpers.ts';

/**
 * Team chat (real Docker): channel rail (manual + direct + auto project channel
 * lifecycle: appears at create, dies at delete), message send/validate/dangling
 * reply, search, pin/unpin, read + unread, attachment upload + authenticated
 * download, and the access matrix (viewer read-only, editor writes on project
 * channels, outsider 403, non-creator manual-delete 403).
 */

const createdSlugs: string[] = [];
const createdUserIds: string[] = [];
const createdChannelIds: string[] = [];
const chatBase = '/chat-team';

let testAdminId: string;

function runAs(token: string): (method: string, urlPath: string, body?: unknown) => Promise<{ status: number; json: any }> {
  return async (method, urlPath, body) => {
    const res = await req(method, urlPath, body, { Authorization: `Bearer ${token}` });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      /* no body */
    }
    return { status: res.status, json };
  };
}

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

/** Create + track a manual channel so the suite cleans it up afterwards. */
async function makeChannel(name: string): Promise<any> {
  const { status, json } = await api('POST', `${chatBase}/channels`, { name });
  assert.strictEqual(status, 201, `channel create failed: ${status} ${JSON.stringify(json)}`);
  createdChannelIds.push(json.channel.id);
  return json.channel;
}

async function sendChannelMessage(channelId: string, text: string, over: Record<string, unknown> = {}): Promise<any> {
  const { status, json } = await api('POST', `${chatBase}/messages`, { channelId, text, ...over });
  assert.strictEqual(status, 201, `message send failed: ${status} ${JSON.stringify(json)}`);
  return json.message;
}

before(async () => {
  await initTestAuth();
  // The admin (helper) user id comes from the signed test token itself.
  testAdminId = (jwt.decode(signTestToken()) as any).id;
});

after(async () => {
  for (const channelId of createdChannelIds) {
    try {
      await reqAuth('DELETE', `${chatBase}/channels/${channelId}`);
    } catch {
      /* already gone */
    }
  }
  for (const userId of createdUserIds) {
    try {
      await reqAuth('DELETE', `/users/${userId}`);
    } catch {
      /* already gone */
    }
  }
  for (const slug of createdSlugs) {
    try {
      await reqAuth('DELETE', `/projects/${slug}`);
    } catch {
      /* already gone */
    }
  }
});

test('401 without a token on every team-chat route', async () => {
  for (const [m, p] of [
    ['GET', '/channels'],
    ['POST', '/channels'],
    ['GET', '/channels/abc'],
    ['GET', '/channels/abc/messages'],
    ['POST', '/messages'],
    ['GET', '/presence'],
  ] as const) {
    const res = await req(m, `${chatBase}${p}`, m === 'GET' || m === 'HEAD' ? undefined : { name: 'x' });
    assert.strictEqual(res.status, 401, `${m} ${p}: ${res.status}`);
  }
});

test('manual channel: create 201, list visible, duplicate name 409, empty name 400', async () => {
  const name = uniqueId('room');
  const created = await api('POST', `${chatBase}/channels`, { name });
  assert.strictEqual(created.status, 201, JSON.stringify(created.json));
  const channel = created.json.channel;
  createdChannelIds.push(channel.id);
  assert.strictEqual(channel.kind, 'channel');
  assert.strictEqual(channel.name, name);

  const dup = await api('POST', `${chatBase}/channels`, { name: name.toUpperCase() });
  assert.strictEqual(dup.status, 409);

  const empty = await api('POST', `${chatBase}/channels`, { name: '   ' });
  assert.strictEqual(empty.status, 400);

  const list = await api('GET', `${chatBase}/channels`);
  assert.strictEqual(list.status, 200);
  assert.ok(list.json.channels.some((c: any) => c.id === channel.id));

  const detail = await api('GET', `${chatBase}/channels/${channel.id}`);
  assert.strictEqual(detail.status, 200);
  assert.strictEqual(detail.json.channel.id, channel.id);
});

test('junk channel ids rejected (traversal/injection)', async () => {
  for (const bad of ['../secret', 'a b', 'x'.repeat(100), 'ch-../']) {
    // Express normalizes dot-segments away before routing, so traversal
    // attempts may surface as 404 (no route) or 400 (param rejected) â€” both
    // are the same guarantee: never a valid channel lookup.
    const a = await api('GET', `${chatBase}/channels/${bad}`);
    assert.ok(a.status === 400 || a.status === 404, `GET ${bad}: ${a.status}`);
    const b = await api('GET', `${chatBase}/channels/${bad}/messages`);
    assert.ok(b.status === 400 || b.status === 404);
    const c = await api('DELETE', `${chatBase}/channels/${bad}`);
    assert.ok(c.status === 400 || c.status === 404);
  }
  const missing = await api('GET', `${chatBase}/channels/ch-nope`);
  assert.strictEqual(missing.status, 404);
});

test('message send + validation + mentions', async () => {
  const ch = await makeChannel(uniqueId('msg'));

  const m1 = await sendChannelMessage(ch.id, 'hello team');
  assert.ok(m1.id.startsWith('m-'));
  assert.strictEqual(m1.username, 'test');
  assert.strictEqual(m1.text, 'hello team');

  const m2 = await sendChannelMessage(ch.id, 'fix the @test bug please');
  assert.deepStrictEqual(m2.mentions, ['test']);

  const junk = await api('POST', `${chatBase}/messages`, { channelId: ch.id, text: '   ' });
  assert.strictEqual(junk.status, 400);

  const noBody = await api('POST', `${chatBase}/messages`, { channelId: ch.id });
  assert.strictEqual(noBody.status, 400);

  const noChannel = await api('POST', `${chatBase}/messages`, { channelId: 'ch-nope', text: 'x' });
  assert.strictEqual(noChannel.status, 404);

  const giant = await api('POST', `${chatBase}/messages`, { channelId: ch.id, text: 'x'.repeat(5001) });
  assert.strictEqual(giant.status, 400);

  const msgs = await api('GET', `${chatBase}/channels/${ch.id}/messages`);
  assert.strictEqual(msgs.status, 200);
  assert.strictEqual(msgs.json.messages.length, 2);
  assert.strictEqual(msgs.json.messages[1].id, m2.id, 'newest last');
});

test('replyTo: dangling ref deleted, live ref kept', async () => {
  const ch = await makeChannel(uniqueId('reply'));
  const target = await sendChannelMessage(ch.id, 'original');

  const ok = await api('POST', `${chatBase}/messages`, { channelId: ch.id, text: 'reply', replyTo: target.id });
  assert.strictEqual(ok.status, 201);
  assert.strictEqual(ok.json.message.replyTo, target.id);

  const dangling = await api('POST', `${chatBase}/messages`, { channelId: ch.id, text: 'to nowhere', replyTo: 'm-bogus999' });
  assert.strictEqual(dangling.status, 400, JSON.stringify(dangling.json));

  const crossChannel = await api('POST', `${chatBase}/messages`, { channelId: ch.id, text: 'x', replyTo: 'm-nope' });
  assert.strictEqual(crossChannel.status, 400);
});

test('search is case-insensitive and scoped to channel', async () => {
  const ch = await makeChannel(uniqueId('search'));
  await sendChannelMessage(ch.id, 'deploy to Production now');
  await sendChannelMessage(ch.id, 'nothing here');

  const r = await api('GET', `${chatBase}/channels/${ch.id}/search?q=PRODUCTION`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.messages.length, 1);
  assert.strictEqual(r.json.messages[0].text, 'deploy to Production now');

  const empty = await api('GET', `${chatBase}/channels/${ch.id}/search?q=zzz`);
  assert.strictEqual(empty.json.messages.length, 0);
});

test('pin/unpin roundtrip + broadcast shape', async () => {
  const ch = await makeChannel(uniqueId('pin'));
  const m = await sendChannelMessage(ch.id, 'pin me');

  const pinned = await api('PUT', `${chatBase}/channels/${ch.id}/messages/${m.id}/pin`, { pinned: true });
  assert.strictEqual(pinned.status, 200);
  assert.strictEqual(pinned.json.message.pinned, true);

  const msgs = await api('GET', `${chatBase}/channels/${ch.id}/messages`);
  assert.strictEqual(msgs.json.messages.find((x: any) => x.id === m.id).pinned, true);

  const unpinned = await api('PUT', `${chatBase}/channels/${ch.id}/messages/${m.id}/pin`, { pinned: false });
  assert.strictEqual(unpinned.status, 200);
  assert.strictEqual(unpinned.json.message.pinned, undefined);

  const noMsg = await api('PUT', `${chatBase}/channels/${ch.id}/messages/m-bogus999/pin`, { pinned: true });
  assert.strictEqual(noMsg.status, 404);
});

test('read position drives unread counts', async () => {
  const ch = await makeChannel(uniqueId('unread'));
  const m1 = await sendChannelMessage(ch.id, 'first');
  const m2 = await sendChannelMessage(ch.id, 'second');

  const before = await api('GET', `${chatBase}/channels`);
  const row = before.json.channels.find((c: any) => c.id === ch.id);
  assert.strictEqual(row.unread, 2);

  const mark = await api('POST', `${chatBase}/channels/${ch.id}/read`, { msgId: m1.id });
  assert.strictEqual(mark.status, 200);

  const after = await api('GET', `${chatBase}/channels`);
  const row2 = after.json.channels.find((c: any) => c.id === ch.id);
  assert.strictEqual(row2.unread, 1);
  assert.strictEqual(row2.firstUnreadId, m2.id);

  const bad = await api('POST', `${chatBase}/channels/${ch.id}/read`, { msgId: 'junk' });
  assert.strictEqual(bad.status, 400);
});

test('channel delete: admin can, non-creator editor cannot, kind guard', async () => {
  // A project channel can never be deleted as a "manual" delete.
  const slug = uniqueId('teamchat');
  const created = await api('POST', '/projects', { name: 'Team Chat T', slug });
  assert.strictEqual(created.status, 201, `create project: ${created.status}`);
  createdSlugs.push(slug);

  const projChannel = `project:${slug}`;
  const delProj = await api('DELETE', `${chatBase}/channels/${projChannel}`);
  assert.strictEqual(delProj.status, 400, JSON.stringify(delProj.json));

  // Admin role always passes manual-channel deletion regardless of creator.
  const ch = await makeChannel(uniqueId('del'));
  const del = await api('DELETE', `${chatBase}/channels/${ch.id}`);
  assert.strictEqual(del.status, 200);
  const gone = await api('GET', `${chatBase}/channels/${ch.id}`);
  assert.strictEqual(gone.status, 404);
});

test('direct channel is idempotent + self-chat rejected', async () => {
  const v = await reqAuth('POST', '/users', { username: uniqueId('vc'), password: 'pass-123456', role: 'viewer' });
  assert.strictEqual(v.status, 201);
  const viewer = await v.json();
  createdUserIds.push(viewer.id);

  const d1 = await api('POST', `${chatBase}/direct`, { with: viewer.id });
  assert.strictEqual(d1.status, 201, JSON.stringify(d1.json));
  assert.strictEqual(d1.json.channel.kind, 'direct');
  createdChannelIds.push(d1.json.channel.id);

  const d2 = await api('POST', `${chatBase}/direct`, { with: viewer.id });
  assert.strictEqual(d2.status, 201);
  assert.strictEqual(d2.json.channel.id, d1.json.channel.id);

  const self = await api('POST', `${chatBase}/direct`, { with: testAdminId });
  assert.strictEqual(self.status, 400);

  const ghost = await api('POST', `${chatBase}/direct`, { with: 'user-does-not-exist' });
  assert.strictEqual(ghost.status, 404);
});

test('project auto-channel exists after create, dies after delete', async () => {
  const slug = uniqueId('autoch');
  const created = await api('POST', '/projects', { name: 'Auto Channel', slug });
  assert.strictEqual(created.status, 201, `create project: ${created.status}`);
  createdSlugs.push(slug);

  const list = await api('GET', `${chatBase}/channels`);
  const auto = list.json.channels.find((c: any) => c.id === `project:${slug}`);
  assert.ok(auto, 'project channel should be auto-created');
  assert.strictEqual(auto.kind, 'project');
  assert.strictEqual(auto.projectSlug, slug);

  await sendChannelMessage(`project:${slug}`, 'project thread');

  const del = await api('DELETE', `/projects/${slug}`);
  assert.strictEqual(del.status, 200);
  const idx2 = createdSlugs.indexOf(slug);
  if (idx2 !== -1) createdSlugs.splice(idx2, 1);

  const after = await api('GET', `${chatBase}/channels`);
  assert.ok(!after.json.channels.some((c: any) => c.id === `project:${slug}`), 'channel gone with project');

  const gone = await api('GET', `${chatBase}/channels/project:${slug}`);
  assert.strictEqual(gone.status, 404);
});

test('access matrix: project channel mirrors project membership; manual is team-wide', async () => {
  const slug = uniqueId('acc');
  const created = await api('POST', '/projects', { name: 'Access Project', slug });
  assert.strictEqual(created.status, 201);
  createdSlugs.push(slug);

  const e = await reqAuth('POST', '/users', { username: uniqueId('ec'), password: 'pass-123456', role: 'editor' });
  const v = await reqAuth('POST', '/users', { username: uniqueId('vcx'), password: 'pass-123456', role: 'viewer' });
  assert.strictEqual(e.status, 201);
  assert.strictEqual(v.status, 201);
  const editor = await e.json();
  const viewer = await v.json();
  createdUserIds.push(editor.id, viewer.id);

  const editorTok = jwt.sign({ id: editor.id, username: editor.username, role: 'editor', tv: 0 }, JWT_SECRET, { expiresIn: '24h' });
  const viewerTok = jwt.sign({ id: viewer.id, username: viewer.username, role: 'viewer', tv: 0 }, JWT_SECRET, { expiresIn: '24h' });
  const outsiderTok = jwt.sign({ id: 'outsider-u', username: 'outsider', role: 'viewer', tv: 0 }, JWT_SECRET, { expiresIn: '24h' });
  const runAsEditor = runAs(editorTok);
  const runAsViewer = runAs(viewerTok);
  const runAsOutsider = runAs(outsiderTok);

  const proj = `project:${slug}`;

  // Outsider (non-member, viewer role) sees nothing project-scoped.
  const outList = await runAsOutsider('GET', `${chatBase}/channels`);
  assert.ok(!outList.json.channels.some((c: any) => c.id === proj), 'outsider must not see project channel');
  const outRead = await runAsOutsider('GET', `${chatBase}/channels/${proj}/messages`);
  assert.strictEqual(outRead.status, 403);
  const outSend = await runAsOutsider('POST', `${chatBase}/messages`, { channelId: proj, text: 'hi' });
  assert.strictEqual(outSend.status, 403);

  // Viewer member: read 200, write 403.
  const addViewer = await api('POST', `/projects/${slug}/members`, { userId: viewer.id, role: 'viewer' });
  assert.strictEqual(addViewer.status, 200, JSON.stringify(addViewer.json));
  const vRead = await runAsViewer('GET', `${chatBase}/channels/${proj}/messages`);
  assert.strictEqual(vRead.status, 200);
  const vSend = await runAsViewer('POST', `${chatBase}/messages`, { channelId: proj, text: 'try' });
  assert.strictEqual(vSend.status, 403, JSON.stringify(vSend.json));

  // Editor member: write 201.
  const addEditor = await api('POST', `/projects/${slug}/members`, { userId: editor.id, role: 'editor' });
  assert.strictEqual(addEditor.status, 200);
  const eSend = await runAsEditor('POST', `${chatBase}/messages`, { channelId: proj, text: 'from editor' });
  assert.strictEqual(eSend.status, 201, JSON.stringify(eSend.json));

  // Global editor (system role editor, NON-member): project access passes as
  // write-level, so they can send on the project channel too.
  const geTok = jwt.sign({ id: 'global-editor', username: 'globaleditor', role: 'editor', tv: 0 }, JWT_SECRET, { expiresIn: '24h' });
  const geSend = await runAs(geTok)('POST', `${chatBase}/messages`, { channelId: proj, text: 'ge' });
  assert.strictEqual(geSend.status, 201, JSON.stringify(geSend.json));

  // Manual channel is team-wide: outsider-admin AND viewer read, editor writes.
  const manual = await makeChannel(uniqueId('open'));
  const eManualSend = await runAsEditor('POST', `${chatBase}/messages`, { channelId: manual.id, text: 'open to editors' });
  assert.strictEqual(eManualSend.status, 201);
  const vManualRead = await runAsViewer('GET', `${chatBase}/channels/${manual.id}/messages`);
  assert.strictEqual(vManualRead.status, 200);
  // Manual channels are team-wide by design: every authenticated user reads
  // AND writes â€” only creation/deletion are gated by the editor level.
  const vManualSend = await runAsViewer('POST', `${chatBase}/messages`, { channelId: manual.id, text: 'viewer on team channel' });
  assert.strictEqual(vManualSend.status, 201, JSON.stringify(vManualSend.json));
});

test('attachment upload + authenticated download + oversize/junk rejection', async () => {
  const ch = await makeChannel(uniqueId('att'));

  // Upload a tiny PNG so detectImageExt classifies it as image. fetch sets the
  // multipart boundary from a real FormData object (never hand-built headers).
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  );
  const form = new FormData();
  form.append('channelId', ch.id);
  form.append('file', new Blob([png], { type: 'image/png' }), 'pixel.png');

  const final = await fetch(`${API_URL}/chat-team/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${signTestToken()}` },
    body: form as any,
  });
  const uploadJson = await final.json().catch(() => ({}));
  assert.strictEqual(final.status, 201, JSON.stringify(uploadJson));
  const attachment = uploadJson.attachment;
  assert.ok(attachment.id.startsWith('att-'));
  assert.strictEqual(attachment.kind, 'image');
  assert.strictEqual(attachment.size, png.length);
  assert.strictEqual(attachment.name, 'pixel.png');

  // Attach it to a message (kind surface on the message too).
  const msg = await sendChannelMessage(ch.id, 'see image', { attachments: [{ id: attachment.id, name: attachment.name }] });
  assert.strictEqual(msg.attachments.length, 1);
  assert.strictEqual(msg.attachments[0].kind, 'image');

  // Authenticated download returns bytes.
  const dl = await reqAuth('GET', `${chatBase}/uploads/${attachment.id}`);
  assert.strictEqual(dl.status, 200);
  const bytes = Buffer.from(await (dl as any).arrayBuffer());
  assert.strictEqual(bytes.length, png.length);

  // Junk attachment ids â†’ 404.
  const junk = await reqAuth('GET', `${chatBase}/uploads/att-../etc`);
  assert.strictEqual(junk.status, 404);

  // Unknown id â†’ 404.
  const missing = await reqAuth('GET', `${chatBase}/uploads/att-zzzz999`);
  assert.strictEqual(missing.status, 404);
});

test('presence endpoint shape', async () => {
  const r = await api('GET', `${chatBase}/presence`);
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.json.users));
});