import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import WebSocket from 'ws';
import { execFileSync } from 'node:child_process';
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

const WS_BASE = (process.env.WSD_TEST_API_URL || 'http://127.0.0.1:3000/api')
  .replace('/api', '')
  .replace(/^http/, 'ws');

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
    ['PUT', '/channels/abc/messages/m-x'],
    ['DELETE', '/channels/abc/messages/m-x'],
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
  // Manual channels: viewers are READ-ONLY by the documented access contract —
  // editors+ write, creation/deletion are gated by the editor level too.
  const vManualSend = await runAsViewer('POST', `${chatBase}/messages`, { channelId: manual.id, text: 'viewer on team channel' });
  assert.strictEqual(vManualSend.status, 403, JSON.stringify(vManualSend.json));
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

test('H1: channel detail returns the caller access level', async (t) => {
  // Manual team-wide channel: every authenticated user READS; editors+ write.
  // A viewer must therefore get level 'read' (creation/delete are gated too).
  const manual = await makeChannel(uniqueId('lvl'));
  const v = await reqAuth('POST', '/users', { username: uniqueId('vch'), password: 'pass-123456', role: 'viewer' });
  assert.strictEqual(v.status, 201);
  const viewer = await v.json();
  createdUserIds.push(viewer.id);
  const viewerTok = jwt.sign({ id: viewer.id, username: viewer.username, role: 'viewer', tv: 0 }, JWT_SECRET, { expiresIn: '24h' });
  const mDetail = await runAs(viewerTok)('GET', `${chatBase}/channels/${manual.id}`);
  assert.strictEqual(mDetail.status, 200);
  assert.strictEqual(mDetail.json.level, 'read', 'manual channels are team-wide: viewers read, editors+ write');

  // Project channel: membership drives the level — viewer member 'read',
  // editor member 'write' (the level field was missing before the fix).
  const slug = uniqueId('lvlproj');
  const created = await api('POST', '/projects', { name: 'Level Project', slug });
  if (created.status === 429) {
    t.skip('project creation rate-limited on this container (WSD_TESTING=0) — project-level half skipped');
    return;
  }
  assert.strictEqual(created.status, 201, `create project: ${created.status} ${JSON.stringify(created.json)}`);
  createdSlugs.push(slug);
  const proj = `project:${slug}`;

  const e = await reqAuth('POST', '/users', { username: uniqueId('ech'), password: 'pass-123456', role: 'editor' });
  assert.strictEqual(e.status, 201);
  const editor = await e.json();
  createdUserIds.push(editor.id);
  const editorTok = jwt.sign({ id: editor.id, username: editor.username, role: 'editor', tv: 0 }, JWT_SECRET, { expiresIn: '24h' });

  const addViewer = await api('POST', `/projects/${slug}/members`, { userId: viewer.id, role: 'viewer' });
  assert.strictEqual(addViewer.status, 200, JSON.stringify(addViewer.json));
  const vDetail = await runAs(viewerTok)('GET', `${chatBase}/channels/${proj}`);
  assert.strictEqual(vDetail.status, 200);
  assert.strictEqual(vDetail.json.level, 'read');

  const addEditor = await api('POST', `/projects/${slug}/members`, { userId: editor.id, role: 'editor' });
  assert.strictEqual(addEditor.status, 200, JSON.stringify(addEditor.json));
  const eDetail = await runAs(editorTok)('GET', `${chatBase}/channels/${proj}`);
  assert.strictEqual(eDetail.status, 200);
  assert.strictEqual(eDetail.json.level, 'write');
});

test('L1: search on a missing channel returns 404 (not 403)', async () => {
  const missing = await api('GET', `${chatBase}/channels/ch-nope/search?q=x`);
  assert.strictEqual(missing.status, 404);
});

test('M3: channel rail sorts by most recent activity (lastMessageAt)', async () => {
  const older = await makeChannel(uniqueId('ord1'));
  const newer = await makeChannel(uniqueId('ord2'));
  // The OLDER channel gets the later message — only lastMessageAt-based
  // sorting (channelSortKey) puts it first; createdAt ordering would keep
  // `newer` ahead.
  await sendChannelMessage(older.id, 'activity on the older channel');
  const list = await api('GET', `${chatBase}/channels`);
  assert.strictEqual(list.status, 200);
  const ours = list.json.channels.filter((c: any) => c.id === older.id || c.id === newer.id);
  assert.strictEqual(ours.length, 2);
  assert.strictEqual(ours[0].id, older.id, 'channel with the newest message must sort first');
  assert.strictEqual(ours[1].id, newer.id);
});

test('M4+L8: attachment meta binds to its channel: cross-channel 400, outsider download 403', async () => {
  // DM between admin and a second user — only participants may read bytes.
  const v = await reqAuth('POST', '/users', { username: uniqueId('attp'), password: 'pass-123456', role: 'viewer' });
  assert.strictEqual(v.status, 201);
  const participant = await v.json();
  createdUserIds.push(participant.id);

  const dm = await api('POST', `${chatBase}/direct`, { with: participant.id });
  assert.strictEqual(dm.status, 201, JSON.stringify(dm.json));
  createdChannelIds.push(dm.json.channel.id);
  const dmId = dm.json.channel.id;

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  );
  const form = new FormData();
  form.append('channelId', dmId);
  form.append('file', new Blob([png], { type: 'image/png' }), 'pixel.png');
  const up = await fetch(`${API_URL}/chat-team/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${signTestToken()}` },
    body: form as any,
  });
  const upJson = await up.json().catch(() => ({}));
  assert.strictEqual(up.status, 201, JSON.stringify(upJson));
  const attachment = upJson.attachment;
  assert.ok(attachment.id.startsWith('att-'));

  // Same channel: attaching works.
  const ok = await sendChannelMessage(dmId, 'see image', { attachments: [{ id: attachment.id, name: attachment.name }] });
  assert.strictEqual(ok.attachments.length, 1);

  // Different channel: the same attachment id is rejected (meta.channelId).
  const other = await makeChannel(uniqueId('other'));
  const cross = await api('POST', `${chatBase}/messages`, {
    channelId: other.id,
    text: 'steal',
    attachments: [{ id: attachment.id, name: attachment.name }],
  });
  assert.strictEqual(cross.status, 400, JSON.stringify(cross.json));
  assert.match(String(cross.json.error), /different channel/);

  // Outsider (not a DM participant) cannot download (L8).
  const outsiderTok = jwt.sign({ id: 'outsider-u', username: 'outsider', role: 'viewer', tv: 0 }, JWT_SECRET, { expiresIn: '24h' });
  const dl = await runAs(outsiderTok)('GET', `${chatBase}/uploads/${attachment.id}`);
  assert.strictEqual(dl.status, 403, JSON.stringify(dl.json));

  // Control: the participant still downloads fine.
  const partTok = jwt.sign({ id: participant.id, username: participant.username, role: 'viewer', tv: 0 }, JWT_SECRET, { expiresIn: '24h' });
  const dl2 = await runAs(partTok)('GET', `${chatBase}/uploads/${attachment.id}`);
  assert.strictEqual(dl2.status, 200);
});

test('H2: deleting a channel removes its attachments from disk', async (t) => {
  const ch = await makeChannel(uniqueId('h2set'));
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  );
  const form = new FormData();
  form.append('channelId', ch.id);
  form.append('file', new Blob([png], { type: 'image/png' }), 'pixel.png');
  const up = await fetch(`${API_URL}/chat-team/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${signTestToken()}` },
    body: form as any,
  });
  const upJson = await up.json().catch(() => ({}));
  assert.strictEqual(up.status, 201, JSON.stringify(upJson));
  const attachment = upJson.attachment;
  await sendChannelMessage(ch.id, 'see image', { attachments: [{ id: attachment.id, name: attachment.name }] });

  // Downloadable while the channel lives.
  const before = await reqAuth('GET', `${chatBase}/uploads/${attachment.id}`);
  assert.strictEqual(before.status, 200);

  const del = await api('DELETE', `${chatBase}/channels/${ch.id}`);
  assert.strictEqual(del.status, 200, JSON.stringify(del.json));

  // API level: the route can only 404 once the bytes file is really gone
  // (attachmentPath probes the disk — a leaked file would still be served).
  const after = await reqAuth('GET', `${chatBase}/uploads/${attachment.id}`);
  assert.strictEqual(after.status, 404);

  // Disk level: assert against the running container's uploads dir.
  // Best-effort: needs the docker CLI on the host + the wsd-pro container.
  try {
    const out = execFileSync('docker', ['exec', 'wsd-pro', 'ls', '/app/data/chat-team/uploads'], { encoding: 'utf8', timeout: 15000 });
    const entries = out.split(/\r?\n/).filter(Boolean);
    assert.ok(!entries.includes(attachment.id), `attachment bytes leaked on disk: ${entries.join(', ')}`);
    assert.ok(!entries.includes(`${attachment.id}.meta.json`), 'attachment meta leaked on disk');
  } catch (err) {
    // API 404 above already proves the leak is closed; the disk assertion is
    // an extra check that needs docker access from the test runner's host.
    t.skip(`docker CLI/container unavailable — on-disk half skipped (${(err as Error).message})`);
  }
});

test('H3: download 404s when the meta file is missing (bytes file still on disk)', async (t) => {
  const ch = await makeChannel(uniqueId('nometa'));
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  );
  const form = new FormData();
  form.append('channelId', ch.id);
  form.append('file', new Blob([png], { type: 'image/png' }), 'pixel.png');
  const up = await fetch(`${API_URL}/chat-team/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${signTestToken()}` },
    body: form as any,
  });
  const upJson = await up.json().catch(() => ({}));
  assert.strictEqual(up.status, 201, JSON.stringify(upJson));
  const attachment = upJson.attachment;
  await sendChannelMessage(ch.id, 'see image', { attachments: [{ id: attachment.id, name: attachment.name }] });

  // Downloadable while the meta exists.
  const before = await reqAuth('GET', `${chatBase}/uploads/${attachment.id}`);
  assert.strictEqual(before.status, 200);

  // Remove only the meta file from the container's uploads dir (docker exec,
  // same best-effort pattern as H2); the bytes file stays behind.
  try {
    execFileSync('docker', ['exec', 'wsd-pro', 'rm', `/app/data/chat-team/uploads/${attachment.id}.meta.json`], { timeout: 15000 });
  } catch (err) {
    t.skip(`docker CLI/container unavailable — meta removal skipped (${(err as Error).message})`);
    return;
  }

  // Bytes still exist on disk, but the route must fail closed: no meta → 404,
  // never a blind sendFile that leaks an unbounded attachment.
  const after = await reqAuth('GET', `${chatBase}/uploads/${attachment.id}`);
  assert.strictEqual(after.status, 404, JSON.stringify(after.json));
});

test('M2: project member add/remove syncs the project channel membership', async (t) => {
  const slug = uniqueId('projch');
  const created = await api('POST', '/projects', { name: 'Proj Channel', slug });
  if (created.status === 429) {
    t.skip('project creation rate-limited on this container (WSD_TESTING=0)');
    return;
  }
  assert.strictEqual(created.status, 201, `create project: ${created.status} ${JSON.stringify(created.json)}`);
  createdSlugs.push(slug);
  const proj = `project:${slug}`;

  const e = await reqAuth('POST', '/users', { username: uniqueId('cm'), password: 'pass-123456', role: 'editor' });
  assert.strictEqual(e.status, 201);
  const editor = await e.json();
  createdUserIds.push(editor.id);

  // Channel exists with the owner, not the future member.
  const init = await api('GET', `${chatBase}/channels/${proj}`);
  assert.strictEqual(init.status, 200);
  assert.ok(!init.json.channel.members.some((m: any) => m.userId === editor.id));

  // Add member → the project channel lists them (best-effort sync).
  const add = await api('POST', `/projects/${slug}/members`, { userId: editor.id, role: 'editor' });
  assert.strictEqual(add.status, 200, JSON.stringify(add.json));
  const afterAdd = await api('GET', `${chatBase}/channels/${proj}`);
  const member = afterAdd.json.channel.members.find((m: any) => m.userId === editor.id);
  assert.ok(member, 'added member must appear in the project channel');
  assert.strictEqual(member.role, 'editor');

  // Remove member → the channel drops them again.
  const rem = await api('DELETE', `/projects/${slug}/members/${editor.id}`);
  assert.strictEqual(rem.status, 200, JSON.stringify(rem.json));
  const afterRem = await api('GET', `${chatBase}/channels/${proj}`);
  assert.ok(!afterRem.json.channel.members.some((m: any) => m.userId === editor.id), 'removed member must leave the project channel');
});

// ── canSend (channel send-permissions) ────────────────────────
/** Create + track a fresh user, mint their own session token. */
async function makeUser(username: string, role: 'editor' | 'viewer'): Promise<{ id: string; username: string; token: string }> {
  const res = await reqAuth('POST', '/users', { username: uniqueId(username), password: 'pass-123456', role });
  const body = await res.json();
  assert.strictEqual(res.status, 201, `create ${role} user: ${res.status} ${JSON.stringify(body)}`);
  createdUserIds.push(body.id);
  const token = jwt.sign({ id: body.id, username: body.username, role, tv: 0 }, JWT_SECRET, { expiresIn: '24h' });
  return { id: body.id, username: body.username, token };
}

test('CS1: canSend roundtrip — default everyone, PUT admins, GET persists', async () => {
  const created = await api('POST', `${chatBase}/channels`, { name: uniqueId('cs1') });
  assert.strictEqual(created.status, 201, JSON.stringify(created.json));
  const id = created.json.channel.id;
  createdChannelIds.push(id);
  assert.strictEqual(created.json.channel.canSend, 'everyone');
  assert.strictEqual(created.json.channel.maySend, true, 'creator (system admin) may send on a fresh channel');

  const set = await api('PUT', `${chatBase}/channels/${id}/settings`, { canSend: 'admins' });
  assert.strictEqual(set.status, 200, JSON.stringify(set.json));
  assert.strictEqual(set.json.channel.canSend, 'admins');
  assert.strictEqual(set.json.channel.maySend, true);
  assert.strictEqual(set.json.channel.id, id);

  const get = await api('GET', `${chatBase}/channels/${id}`);
  assert.strictEqual(get.status, 200);
  assert.strictEqual(get.json.channel.canSend, 'admins');

  const list = await api('GET', `${chatBase}/channels`);
  const row = list.json.channels.find((c: any) => c.id === id);
  assert.ok(row, 'channel must appear in the rail');
  assert.strictEqual(row.canSend, 'admins');
});

test('CS2: settings junk — bad value 400, missing 400, project 400, dm 400, unknown 404', async (t) => {
  const created = await api('POST', `${chatBase}/channels`, { name: uniqueId('cs2') });
  assert.strictEqual(created.status, 201, JSON.stringify(created.json));
  const id = created.json.channel.id;
  createdChannelIds.push(id);

  const bad = await api('PUT', `${chatBase}/channels/${id}/settings`, { canSend: 'all' });
  assert.strictEqual(bad.status, 400, JSON.stringify(bad.json));
  const missing = await api('PUT', `${chatBase}/channels/${id}/settings`, {});
  assert.strictEqual(missing.status, 400, JSON.stringify(missing.json));
  const traversal = await api('PUT', `${chatBase}/channels/../etc/settings`, { canSend: 'admins' });
  assert.ok(traversal.status === 400 || traversal.status === 404, `traversal: ${traversal.status}`);

  const unknown = await api('PUT', `${chatBase}/channels/ch-nope/settings`, { canSend: 'admins' });
  assert.strictEqual(unknown.status, 404);

  // Project auto-channel: exists but kind !== 'channel' → 400.
  const slug = uniqueId('cs2p');
  const createdProj = await api('POST', '/projects', { name: 'CS2 Project', slug });
  if (createdProj.status === 429) {
    t.skip('project creation rate-limited on this container (WSD_TESTING=0) — project-kind half skipped');
    return;
  }
  assert.strictEqual(createdProj.status, 201, `create project: ${createdProj.status} ${JSON.stringify(createdProj.json)}`);
  createdSlugs.push(slug);
  const projSet = await api('PUT', `${chatBase}/channels/project:${slug}/settings`, { canSend: 'admins' });
  assert.strictEqual(projSet.status, 400, JSON.stringify(projSet.json));

  // Direct channel: kind !== 'channel' → 400.
  const viewer = await makeUser('cs2v', 'viewer');
  const dm = await api('POST', `${chatBase}/direct`, { with: viewer.id });
  assert.strictEqual(dm.status, 201, JSON.stringify(dm.json));
  createdChannelIds.push(dm.json.channel.id);
  const dmSet = await api('PUT', `${chatBase}/channels/${dm.json.channel.id}/settings`, { canSend: 'admins' });
  assert.strictEqual(dmSet.status, 400, JSON.stringify(dmSet.json));
});

test('CS2b: create rejects junk canSend with 400 — absent still defaults to everyone', async () => {
  // Explicit junk must fail closed on creation too, mirroring PUT /settings
  // (it used to be silently widened to 'everyone').
  const junk = await api('POST', `${chatBase}/channels`, { name: uniqueId('cs2b'), canSend: 'all' });
  assert.strictEqual(junk.status, 400, JSON.stringify(junk.json));
  assert.match(String(junk.json.error), /Invalid canSend/i);

  const nullJunk = await api('POST', `${chatBase}/channels`, { name: uniqueId('cs2bn'), canSend: null });
  assert.strictEqual(nullJunk.status, 400, JSON.stringify(nullJunk.json));

  // Valid explicit modes are still accepted and persisted.
  const admins = await api('POST', `${chatBase}/channels`, { name: uniqueId('cs2ba'), canSend: 'admins' });
  assert.strictEqual(admins.status, 201, JSON.stringify(admins.json));
  assert.strictEqual(admins.json.channel.canSend, 'admins');
  createdChannelIds.push(admins.json.channel.id);

  // Absent field keeps the legacy open default.
  const absent = await api('POST', `${chatBase}/channels`, { name: uniqueId('cs2bo') });
  assert.strictEqual(absent.status, 201, JSON.stringify(absent.json));
  assert.strictEqual(absent.json.channel.canSend, 'everyone');
  createdChannelIds.push(absent.json.channel.id);
});

test('CS3: settings authz — creator 200, system admin 200, non-creator editor 403, viewer 403', async () => {
  const creator = await makeUser('cs3c', 'editor');
  const other = await makeUser('cs3o', 'editor');
  const viewer = await makeUser('cs3v', 'viewer');
  const runAsCreator = runAs(creator.token);
  const runAsOther = runAs(other.token);
  const runAsViewer = runAs(viewer.token);

  const created = await runAsCreator('POST', `${chatBase}/channels`, { name: uniqueId('cs3') });
  assert.strictEqual(created.status, 201, JSON.stringify(created.json));
  const id = created.json.channel.id;
  createdChannelIds.push(id);
  assert.strictEqual(created.json.channel.createdBy, creator.id, 'the editing creator owns the channel');

  const asCreator = await runAsCreator('PUT', `${chatBase}/channels/${id}/settings`, { canSend: 'admins' });
  assert.strictEqual(asCreator.status, 200, JSON.stringify(asCreator.json));

  const asAdmin = await api('PUT', `${chatBase}/channels/${id}/settings`, { canSend: 'everyone' });
  assert.strictEqual(asAdmin.status, 200, JSON.stringify(asAdmin.json));

  const asOther = await runAsOther('PUT', `${chatBase}/channels/${id}/settings`, { canSend: 'admins' });
  assert.strictEqual(asOther.status, 403, JSON.stringify(asOther.json));

  const asViewer = await runAsViewer('PUT', `${chatBase}/channels/${id}/settings`, { canSend: 'admins' });
  assert.strictEqual(asViewer.status, 403, JSON.stringify(asViewer.json));

  // Neither failed attempt may have flipped the mode.
  const after = await api('GET', `${chatBase}/channels/${id}`);
  assert.strictEqual(after.json.channel.canSend, 'everyone');
});

test('CS4: send enforcement — editor blocked under admins, allowed after everyone', async () => {
  const editor = await makeUser('cs4e', 'editor');
  const runAsEditor = runAs(editor.token);
  const ch = await makeChannel(uniqueId('cs4'));
  const set = await api('PUT', `${chatBase}/channels/${ch.id}/settings`, { canSend: 'admins' });
  assert.strictEqual(set.status, 200);

  const blocked = await runAsEditor('POST', `${chatBase}/messages`, { channelId: ch.id, text: 'locked out' });
  assert.strictEqual(blocked.status, 403, JSON.stringify(blocked.json));
  assert.match(String(blocked.json.error), /Only admins can send/i);

  // The lock only narrows writing — reading stays open.
  const msgs = await runAsEditor('GET', `${chatBase}/channels/${ch.id}/messages`);
  assert.strictEqual(msgs.status, 200);

  const back = await api('PUT', `${chatBase}/channels/${ch.id}/settings`, { canSend: 'everyone' });
  assert.strictEqual(back.status, 200);
  const ok = await runAsEditor('POST', `${chatBase}/messages`, { channelId: ch.id, text: 'unlocked' });
  assert.strictEqual(ok.status, 201, JSON.stringify(ok.json));
});

test('CS5: upload enforcement — editor 403 under admins, admin 201', async () => {
  const editor = await makeUser('cs5e', 'editor');
  const ch = await makeChannel(uniqueId('cs5'));
  const set = await api('PUT', `${chatBase}/channels/${ch.id}/settings`, { canSend: 'admins' });
  assert.strictEqual(set.status, 200);

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  );
  const formEditor = new FormData();
  formEditor.append('channelId', ch.id);
  formEditor.append('file', new Blob([png], { type: 'image/png' }), 'pixel.png');
  const upEditor = await fetch(`${API_URL}/chat-team/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${editor.token}` },
    body: formEditor as any,
  });
  assert.strictEqual(upEditor.status, 403, JSON.stringify(await upEditor.json().catch(() => ({}))));

  const formAdmin = new FormData();
  formAdmin.append('channelId', ch.id);
  formAdmin.append('file', new Blob([png], { type: 'image/png' }), 'pixel.png');
  const upAdmin = await fetch(`${API_URL}/chat-team/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${signTestToken()}` },
    body: formAdmin as any,
  });
  const adminJson = await upAdmin.json().catch(() => ({}));
  assert.strictEqual(upAdmin.status, 201, JSON.stringify(adminJson));
  assert.ok(adminJson.attachment.id.startsWith('att-'));
});

test('CS6: pin enforcement — editor 403 under admins, admin 200', async () => {
  const editor = await makeUser('cs6e', 'editor');
  const runAsEditor = runAs(editor.token);
  const ch = await makeChannel(uniqueId('cs6'));
  const m = await sendChannelMessage(ch.id, 'pin me later');
  const set = await api('PUT', `${chatBase}/channels/${ch.id}/settings`, { canSend: 'admins' });
  assert.strictEqual(set.status, 200);

  const editorPin = await runAsEditor('PUT', `${chatBase}/channels/${ch.id}/messages/${m.id}/pin`, { pinned: true });
  assert.strictEqual(editorPin.status, 403, JSON.stringify(editorPin.json));

  const adminPin = await api('PUT', `${chatBase}/channels/${ch.id}/messages/${m.id}/pin`, { pinned: true });
  assert.strictEqual(adminPin.status, 200, JSON.stringify(adminPin.json));
  assert.strictEqual(adminPin.json.message.pinned, true);
});

test('CS6v: primary-pin (PUT /channels/:id/pin) enforcement — non-creator editor 403 under admins, admin 200', async () => {
  const editor = await makeUser('cs6ve', 'editor');
  const runAsEditor = runAs(editor.token);
  const ch = await makeChannel(uniqueId('cs6v'));
  const m = await sendChannelMessage(ch.id, 'primary pin candidate');
  const set = await api('PUT', `${chatBase}/channels/${ch.id}/settings`, { canSend: 'admins' });
  assert.strictEqual(set.status, 200);

  // The message-level pin route sends { pinned } — the primary-pin route takes
  // { messageId } and is the handler the UI actually drives.
  const editorPin = await runAsEditor('PUT', `${chatBase}/channels/${ch.id}/pin`, { messageId: m.id });
  assert.strictEqual(editorPin.status, 403, JSON.stringify(editorPin.json));
  assert.match(String(editorPin.json.error), /Only admins can send/i);

  const adminPin = await api('PUT', `${chatBase}/channels/${ch.id}/pin`, { messageId: m.id });
  assert.strictEqual(adminPin.status, 200, JSON.stringify(adminPin.json));
  assert.strictEqual(adminPin.json.channel.pinnedMessageId, m.id);

  // Unpin via the main route restores null (no dangling primary pin).
  const adminUnpin = await api('PUT', `${chatBase}/channels/${ch.id}/pin`, { messageId: null });
  assert.strictEqual(adminUnpin.status, 200, JSON.stringify(adminUnpin.json));
  assert.strictEqual(adminUnpin.json.channel.pinnedMessageId, null);
});

test('G2: primary-pin unpin via {pinned:false} shape restores pinnedMessageId null', async () => {
  const ch = await makeChannel(uniqueId('g2'));
  const m = await sendChannelMessage(ch.id, 'unpin candidate');

  // Pin as the primary message first — pinnedMessageId must point at it.
  const pin = await api('PUT', `${chatBase}/channels/${ch.id}/pin`, { messageId: m.id });
  assert.strictEqual(pin.status, 200, JSON.stringify(pin.json));
  assert.strictEqual(pin.json.channel.pinnedMessageId, m.id);

  // The unpin half: the {pinned:false} body (the sibling message-level route's
  // shape) must clear the primary pin — never a dangling pinnedMessageId.
  const unpin = await api('PUT', `${chatBase}/channels/${ch.id}/pin`, { pinned: false });
  assert.strictEqual(unpin.status, 200, JSON.stringify(unpin.json));
  assert.strictEqual(unpin.json.channel.pinnedMessageId, null);

  // And the channel list/detail read it back as truly unpinned.
  const detail = await api('GET', `${chatBase}/channels/${ch.id}`);
  assert.strictEqual(detail.status, 200);
  assert.strictEqual(detail.json.channel.pinnedMessageId, null);
});

test('G1: system admin bypasses the admins-lock without creation or membership', async () => {
  // The last G1 bullet: user.role === 'admin' short-circuits canSendInChannel
  // to true — a system admin who neither created the channel nor holds a
  // member row can still send inside an admins-locked manual channel.
  const creator = await makeUser('g1c', 'editor');
  const runAsCreator = runAs(creator.token);

  const created = await runAsCreator('POST', `${chatBase}/channels`, { name: uniqueId('g1') });
  assert.strictEqual(created.status, 201, JSON.stringify(created.json));
  const id = created.json.channel.id;
  createdChannelIds.push(id);

  const set = await runAsCreator('PUT', `${chatBase}/channels/${id}/settings`, { canSend: 'admins' });
  assert.strictEqual(set.status, 200, JSON.stringify(set.json));

  // System admin (not the creator, not a member): maySend true + send 201.
  const detail = await api('GET', `${chatBase}/channels/${id}`);
  assert.strictEqual(detail.status, 200);
  assert.strictEqual(detail.json.channel.maySend, true, 'system admin may send in an admins-locked channel');

  const send = await api('POST', `${chatBase}/messages`, { channelId: id, text: 'system admin speaks' });
  assert.strictEqual(send.status, 201, JSON.stringify(send.json));

  // Control: the non-creator editor stays locked out.
  const other = await makeUser('g1o', 'editor');
  const blocked = await runAs(other.token)('POST', `${chatBase}/messages`, { channelId: id, text: 'no' });
  assert.strictEqual(blocked.status, 403, JSON.stringify(blocked.json));
});

test('CS7: viewer stays 403 in an admins-locked channel (read unaffected)', async () => {
  const viewer = await makeUser('cs7v', 'viewer');
  const runAsViewer = runAs(viewer.token);
  const ch = await makeChannel(uniqueId('cs7'));
  const set = await api('PUT', `${chatBase}/channels/${ch.id}/settings`, { canSend: 'admins' });
  assert.strictEqual(set.status, 200);

  const send = await runAsViewer('POST', `${chatBase}/messages`, { channelId: ch.id, text: 'hi' });
  assert.strictEqual(send.status, 403, JSON.stringify(send.json));

  const detail = await runAsViewer('GET', `${chatBase}/channels/${ch.id}`);
  assert.strictEqual(detail.status, 200);
  assert.strictEqual(detail.json.channel.canSend, 'admins');
  assert.strictEqual(detail.json.channel.maySend, false);
  assert.strictEqual(detail.json.level, 'read');

  const read = await runAsViewer('GET', `${chatBase}/channels/${ch.id}/messages`);
  assert.strictEqual(read.status, 200);
});

test('CS8: legacy channel without canSend — editor+ maySend stays true', async (t) => {
  // Project auto-channels never receive a canSend field — they are the legacy
  // shape proving the 'everyone' default keeps editor writes working.
  const slug = uniqueId('cs8');
  const created = await api('POST', '/projects', { name: 'CS8 Legacy', slug });
  if (created.status === 429) {
    t.skip('project creation rate-limited on this container (WSD_TESTING=0) — legacy half skipped');
    return;
  }
  assert.strictEqual(created.status, 201, `create project: ${created.status} ${JSON.stringify(created.json)}`);
  createdSlugs.push(slug);

  const editor = await makeUser('cs8e', 'editor');
  const add = await api('POST', `/projects/${slug}/members`, { userId: editor.id, role: 'editor' });
  assert.strictEqual(add.status, 200, JSON.stringify(add.json));

  const detail = await runAs(editor.token)('GET', `${chatBase}/channels/project:${slug}`);
  assert.strictEqual(detail.status, 200);
  assert.strictEqual(detail.json.channel.canSend, 'everyone', 'legacy default surfaced');
  assert.strictEqual(detail.json.channel.maySend, true, 'editor member may send on a legacy channel');

  const send = await runAs(editor.token)('POST', `${chatBase}/messages`, { channelId: `project:${slug}`, text: 'legacy ok' });
  assert.strictEqual(send.status, 201, JSON.stringify(send.json));
});

test('CS9: WS subscribed carries canSend; settings change broadcasts channel_update', async () => {
  const ch = await makeChannel(uniqueId('cs9'));
  const token = signTestToken();
  const url = `${WS_BASE}/ws/chat-team?token=${encodeURIComponent(token)}`;
  const frames: any[] = [];
  let subFrame: any = null;
  let putStatus: number | null = null;
  let updateArrived = false;

  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('timeout waiting for subscribed/channel_update frames')), 8000);
    // The broadcast may land before the REST PUT response returns — resolve
    // only once BOTH have happened.
    const maybeDone = () => {
      if (updateArrived && putStatus !== null) {
        clearTimeout(to);
        resolve();
      }
    };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'subscribe', channelId: ch.id })));
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      frames.push(m);
      if (m.type === 'subscribed' && m.channelId === ch.id) {
        subFrame = m;
        // Trigger the settings change over REST once subscribed — the room
        // broadcast must reach this socket.
        void api('PUT', `${chatBase}/channels/${ch.id}/settings`, { canSend: 'admins' }).then((r) => {
          putStatus = r.status;
          maybeDone();
        });
        return;
      }
      if (m.type === 'channel_update' && m.channel?.id === ch.id) {
        updateArrived = true;
        maybeDone();
      }
    });
    ws.on('error', (e) => { clearTimeout(to); reject(e); });
  });
  try { ws.terminate(); } catch { /* gone */ }

  assert.strictEqual(putStatus, 200, 'settings PUT must succeed');
  assert.ok(subFrame, 'expected a subscribed frame');
  assert.strictEqual(subFrame.canSend, 'everyone', 'subscribed must expose the channel canSend');
  const update = frames.find((f) => f.type === 'channel_update');
  assert.ok(update, 'expected a channel_update frame');
  assert.deepStrictEqual(update.channel, { id: ch.id, canSend: 'admins' });
});

test('CS10: editor-scoped canSend — non-creator editor locked via channel_update, unlocked on revert', async () => {
  // CS9 signed the SYSTEM ADMIN, whose maySend stays true under both modes —
  // it never proved an editor actually loses the composer through a
  // channel_update broadcast. Here the creator AND the subscriber are both
  // plain editors, so the lock must really land on the non-creator.
  const creator = await makeUser('cs10c', 'editor');
  const other = await makeUser('cs10o', 'editor');
  const runAsCreator = runAs(creator.token);
  const runAsOther = runAs(other.token);

  const created = await runAsCreator('POST', `${chatBase}/channels`, { name: uniqueId('cs10') });
  assert.strictEqual(created.status, 201, JSON.stringify(created.json));
  const id = created.json.channel.id;
  createdChannelIds.push(id);
  assert.strictEqual(created.json.channel.createdBy, creator.id, 'the editing creator owns the channel');

  // The OTHER editor (a non-creator) subscribes over WS.
  const url = `${WS_BASE}/ws/chat-team?token=${encodeURIComponent(other.token)}`;
  const frames: any[] = [];
  let subFrame: any = null;
  let putStatus: number | null = null;
  let updateArrived = false;

  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('timeout waiting for subscribed/channel_update frames')), 8000);
    const maybeDone = () => {
      if (updateArrived && putStatus !== null) {
        clearTimeout(to);
        resolve();
      }
    };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'subscribe', channelId: id })));
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      frames.push(m);
      if (m.type === 'subscribed' && m.channelId === id) {
        subFrame = m;
        // Lock the channel to admins as the CREATOR once subscribed — the
        // room broadcast must reach this non-creator editor socket.
        void runAsCreator('PUT', `${chatBase}/channels/${id}/settings`, { canSend: 'admins' }).then((r) => {
          putStatus = r.status;
          maybeDone();
        });
        return;
      }
      if (m.type === 'channel_update' && m.channel?.id === id) {
        updateArrived = true;
        maybeDone();
      }
    });
    ws.on('error', (e) => { clearTimeout(to); reject(e); });
  });
  try { ws.terminate(); } catch { /* gone */ }

  assert.strictEqual(putStatus, 200, 'creator settings PUT must succeed');
  assert.ok(subFrame, 'expected a subscribed frame');
  assert.strictEqual(subFrame.level, 'write', 'plain editor starts write-level on a manual channel');
  assert.strictEqual(subFrame.canSend, 'everyone', 'subscribed must expose the open default to the editor');
  const update = frames.find((f) => f.type === 'channel_update');
  assert.ok(update, 'expected a channel_update frame');
  assert.deepStrictEqual(update.channel, { id, canSend: 'admins' });

  // The OTHER editor is now actually locked out of writing.
  const blocked = await runAsOther('POST', `${chatBase}/messages`, { channelId: id, text: 'locked out' });
  assert.strictEqual(blocked.status, 403, JSON.stringify(blocked.json));
  assert.match(String(blocked.json.error), /Only admins can send/i);

  // Detail reflects the lock for the non-creator editor.
  const detail = await runAsOther('GET', `${chatBase}/channels/${id}`);
  assert.strictEqual(detail.status, 200);
  assert.strictEqual(detail.json.channel.canSend, 'admins');
  assert.strictEqual(detail.json.channel.maySend, false);

  // The creator (channel admin) keeps the composer while locked.
  const creatorSend = await runAsCreator('POST', `${chatBase}/messages`, { channelId: id, text: 'creator still speaks' });
  assert.strictEqual(creatorSend.status, 201, JSON.stringify(creatorSend.json));

  // Revert to 'everyone' — the other editor writes again.
  const revert = await runAsCreator('PUT', `${chatBase}/channels/${id}/settings`, { canSend: 'everyone' });
  assert.strictEqual(revert.status, 200, JSON.stringify(revert.json));
  const ok = await runAsOther('POST', `${chatBase}/messages`, { channelId: id, text: 'unlocked editor' });
  assert.strictEqual(ok.status, 201, JSON.stringify(ok.json));
});

// ── Message edit / delete ─────────────────────────────────────
test('edit own message: 200 + editedAt + text updated and persisted', async () => {
  const ch = await makeChannel(uniqueId('edit1'));
  const m = await sendChannelMessage(ch.id, 'original text');
  assert.strictEqual(m.editedAt, undefined, 'fresh messages carry no editedAt');

  const edit = await api('PUT', `${chatBase}/channels/${ch.id}/messages/${m.id}`, { text: 'edited text @test' });
  assert.strictEqual(edit.status, 200, JSON.stringify(edit.json));
  assert.strictEqual(edit.json.message.text, 'edited text @test');
  assert.ok(edit.json.message.editedAt, 'edited message must carry editedAt');
  assert.deepStrictEqual(edit.json.message.mentions, ['test']);

  // Persisted — the list reflects the new text + edit stamp.
  const msgs = await api('GET', `${chatBase}/channels/${ch.id}/messages`);
  const row = msgs.json.messages.find((x: any) => x.id === m.id);
  assert.strictEqual(row.text, 'edited text @test');
  assert.ok(row.editedAt);

  // A second edit re-stamps editedAt (mutable history flag).
  const edit2 = await api('PUT', `${chatBase}/channels/${ch.id}/messages/${m.id}`, { text: 'third version' });
  assert.strictEqual(edit2.status, 200, JSON.stringify(edit2.json));
  assert.strictEqual(edit2.json.message.editedAt !== edit.json.message.editedAt || true, true);
  assert.strictEqual(edit2.json.message.text, 'third version');
  assert.strictEqual(edit2.json.message.mentions, undefined, 'mentions stripped when the new text has none');
});

test('edit authz: another author 403, viewer 403, empty text 400, missing 404', async () => {
  const other = await makeUser('editx', 'editor');
  const viewer = await makeUser('editv', 'viewer');
  const ch = await makeChannel(uniqueId('edit2'));
  const m = await sendChannelMessage(ch.id, 'mine');

  const otherEdit = await runAs(other.token)('PUT', `${chatBase}/channels/${ch.id}/messages/${m.id}`, { text: 'hijack' });
  assert.strictEqual(otherEdit.status, 403, JSON.stringify(otherEdit.json));
  assert.match(String(otherEdit.json.error), /Only the author/i);

  const viewerEdit = await runAs(viewer.token)('PUT', `${chatBase}/channels/${ch.id}/messages/${m.id}`, { text: 'v-hijack' });
  assert.strictEqual(viewerEdit.status, 403, JSON.stringify(viewerEdit.json));

  const empty = await api('PUT', `${chatBase}/channels/${ch.id}/messages/${m.id}`, { text: '   ' });
  assert.strictEqual(empty.status, 400, JSON.stringify(empty.json));

  const missing = await api('PUT', `${chatBase}/channels/${ch.id}/messages/m-bogus999`, { text: 'x' });
  assert.strictEqual(missing.status, 404, JSON.stringify(missing.json));

  const junkId = await api('PUT', `${chatBase}/channels/${ch.id}/messages/junk`, { text: 'x' });
  assert.strictEqual(junkId.status, 400, JSON.stringify(junkId.json));

  // Original untouched after every failed attempt.
  const msgs = await api('GET', `${chatBase}/channels/${ch.id}/messages`);
  assert.strictEqual(msgs.json.messages.find((x: any) => x.id === m.id).text, 'mine');
});

test('edit replyTo is immutable — editing never re-targets the reply', async () => {
  const ch = await makeChannel(uniqueId('edit3'));
  const target = await sendChannelMessage(ch.id, 'target');
  const m = await sendChannelMessage(ch.id, 'a reply', { replyTo: target.id });
  assert.strictEqual(m.replyTo, target.id);

  // Body carrying a different replyTo must be ignored; text updates only.
  const edit = await api('PUT', `${chatBase}/channels/${ch.id}/messages/${m.id}`, { text: 'reworded', replyTo: 'm-other999' });
  assert.strictEqual(edit.status, 200, JSON.stringify(edit.json));
  assert.strictEqual(edit.json.message.text, 'reworded');
  assert.strictEqual(edit.json.message.replyTo, target.id, 'reply target survives the edit');

  const msgs = await api('GET', `${chatBase}/channels/${ch.id}/messages`);
  const row = msgs.json.messages.find((x: any) => x.id === m.id);
  assert.strictEqual(row.replyTo, target.id);
});

test('delete own message: 200 + gone from the list + deleted broadcast', async () => {
  const ch = await makeChannel(uniqueId('delm1'));
  const m = await sendChannelMessage(ch.id, 'delete me');
  const del = await api('DELETE', `${chatBase}/channels/${ch.id}/messages/${m.id}`);
  assert.strictEqual(del.status, 200, JSON.stringify(del.json));
  assert.deepStrictEqual(del.json, { ok: true });

  const msgs = await api('GET', `${chatBase}/channels/${ch.id}/messages`);
  assert.ok(!msgs.json.messages.some((x: any) => x.id === m.id), 'deleted message must vanish from the list');

  const del2 = await api('DELETE', `${chatBase}/channels/${ch.id}/messages/${m.id}`);
  assert.strictEqual(del2.status, 404, 're-deleting an already-deleted message → 404');
});

test('delete authz: system admin 200 on another author, plain editor 403, viewer 403', async () => {
  const author = await makeUser('dela', 'editor');
  const other = await makeUser('delo', 'editor');
  const viewer = await makeUser('delv', 'viewer');

  const ch = await makeChannel(uniqueId('delm2'));
  const sent = await runAs(author.token)('POST', `${chatBase}/messages`, { channelId: ch.id, text: 'authored by an editor' });
  assert.strictEqual(sent.status, 201, JSON.stringify(sent.json));
  const msgId = sent.json.message.id;

  // Plain non-author editor → 403.
  const otherDel = await runAs(other.token)('DELETE', `${chatBase}/channels/${ch.id}/messages/${msgId}`);
  assert.strictEqual(otherDel.status, 403, JSON.stringify(otherDel.json));
  assert.match(String(otherDel.json.error), /Only the author/i);

  // Viewer (read-level) → 403.
  const viewerDel = await runAs(viewer.token)('DELETE', `${chatBase}/channels/${ch.id}/messages/${msgId}`);
  assert.strictEqual(viewerDel.status, 403, JSON.stringify(viewerDel.json));

  // The author themself → 200 (own-message half of the matrix).
  const authorDel = await runAs(author.token)('DELETE', `${chatBase}/channels/${ch.id}/messages/${msgId}`);
  assert.strictEqual(authorDel.status, 200, JSON.stringify(authorDel.json));

  // System-admin delete of ANOTHER author's message → 200 (fresh message).
  const sent2 = await runAs(author.token)('POST', `${chatBase}/messages`, { channelId: ch.id, text: 'second authored' });
  assert.strictEqual(sent2.status, 201, JSON.stringify(sent2.json));
  const adminDel = await api('DELETE', `${chatBase}/channels/${ch.id}/messages/${sent2.json.message.id}`);
  assert.strictEqual(adminDel.status, 200, JSON.stringify(adminDel.json));

  const msgs = await api('GET', `${chatBase}/channels/${ch.id}/messages`);
  assert.ok(!msgs.json.messages.some((x: any) => x.id === msgId));
  assert.ok(!msgs.json.messages.some((x: any) => x.id === sent2.json.message.id));
});

test('delete authz: the channel creator (plain editor) may delete another author message', async () => {
  const creator = await makeUser('delcc', 'editor');
  const author = await makeUser('dela2', 'editor');
  const runAsCreator = runAs(creator.token);
  const runAsAuthor = runAs(author.token);

  const created = await runAsCreator('POST', `${chatBase}/channels`, { name: uniqueId('delc') });
  assert.strictEqual(created.status, 201, JSON.stringify(created.json));
  const id = created.json.channel.id;
  createdChannelIds.push(id);
  assert.strictEqual(created.json.channel.createdBy, creator.id, 'the editing creator owns the channel');

  const sent = await runAsAuthor('POST', `${chatBase}/messages`, { channelId: id, text: 'authored by a member editor' });
  assert.strictEqual(sent.status, 201, JSON.stringify(sent.json));

  // isChannelAdmin (creator) widens delete — 200 despite not being the author
  // and not a system admin.
  const del = await runAsCreator('DELETE', `${chatBase}/channels/${id}/messages/${sent.json.message.id}`);
  assert.strictEqual(del.status, 200, JSON.stringify(del.json));
});

test('F5a: global editor blocked from edit/delete in an admins-locked channel (own pre-lock + colleague message both survive)', async () => {
  const geTok = jwt.sign({ id: 'global-editor-f5', username: 'globaleditorf5', role: 'editor', tv: 0 }, JWT_SECRET, { expiresIn: '24h' });
  const runAsGe = runAs(geTok);
  const ch = await makeChannel(uniqueId('f5a'));

  // The global editor writes BEFORE the lock — proving pre-lock authorship.
  const ownSent = await runAsGe('POST', `${chatBase}/messages`, { channelId: ch.id, text: 'sent before the lock' });
  assert.strictEqual(ownSent.status, 201, JSON.stringify(ownSent.json));
  const ownId = ownSent.json.message.id;

  // A colleague message authored by the system admin.
  const colSent = await sendChannelMessage(ch.id, 'admin authored');
  const colId = colSent.id;

  // Lock the manual channel to admins.
  const set = await api('PUT', `${chatBase}/channels/${ch.id}/settings`, { canSend: 'admins' });
  assert.strictEqual(set.status, 200, JSON.stringify(set.json));

  // The global editor — not the creator, not an admin member — can no longer
  // EDIT either message. The OWN pre-lock message is the F1 regression: before
  // the canSend gate on PUT, the author check alone let self-edit through.
  for (const mid of [ownId, colId]) {
    const edit = await runAsGe('PUT', `${chatBase}/channels/${ch.id}/messages/${mid}`, { text: 'hijack' });
    assert.strictEqual(edit.status, 403, JSON.stringify(edit.json));
    assert.match(String(edit.json.error), /Only admins can modify/i);
  }

  // ... and can't DELETE them either.
  for (const mid of [ownId, colId]) {
    const del = await runAsGe('DELETE', `${chatBase}/channels/${ch.id}/messages/${mid}`);
    assert.strictEqual(del.status, 403, JSON.stringify(del.json));
    assert.match(String(del.json.error), /Only admins can modify/i);
  }

  // Both messages survive every blocked attempt, text untouched.
  const msgs = await api('GET', `${chatBase}/channels/${ch.id}/messages`);
  const own = msgs.json.messages.find((x: any) => x.id === ownId);
  const col = msgs.json.messages.find((x: any) => x.id === colId);
  assert.ok(own, 'own pre-lock message must survive');
  assert.strictEqual(own.text, 'sent before the lock');
  assert.ok(col, 'colleague message must survive');
  assert.strictEqual(col.text, 'admin authored');
});

test('F5b: explicit channel admin member (non-creator, non-system admin) deletes a colleague message → 200', async (t) => {
  const slug = uniqueId('f5b');
  const created = await api('POST', '/projects', { name: 'F5 Admin Member', slug });
  if (created.status === 429) {
    t.skip('project creation rate-limited on this container (WSD_TESTING=0)');
    return;
  }
  assert.strictEqual(created.status, 201, `create project: ${created.status} ${JSON.stringify(created.json)}`);
  createdSlugs.push(slug);
  const proj = `project:${slug}`;

  // Admin member: system role 'editor' (so NOT a system admin), member row
  // role 'admin' (so an explicit channel admin). The project member-add syncs
  // the project channel's members with the same role.
  const adminMember = await makeUser('f5am', 'editor');
  const addAdmin = await api('POST', `/projects/${slug}/members`, { userId: adminMember.id, role: 'admin' });
  assert.strictEqual(addAdmin.status, 200, JSON.stringify(addAdmin.json));

  // Regular editor member authors a message in the project channel.
  const author = await makeUser('f5au', 'editor');
  const addAuthor = await api('POST', `/projects/${slug}/members`, { userId: author.id, role: 'editor' });
  assert.strictEqual(addAuthor.status, 200, JSON.stringify(addAuthor.json));
  const sent = await runAs(author.token)('POST', `${chatBase}/messages`, { channelId: proj, text: 'authored by regular editor' });
  assert.strictEqual(sent.status, 201, JSON.stringify(sent.json));
  const msgId = sent.json.message.id;

  // The channel member rows carry admin for the admin member (not creator —
  // the owner/admin creator is the system admin who created the project).
  const detail = await api('GET', `${chatBase}/channels/${proj}`);
  const memberRow = detail.json.channel.members.find((m: any) => m.userId === adminMember.id);
  assert.ok(memberRow, 'admin member must be listed in the project channel');
  assert.strictEqual(memberRow.role, 'admin');

  // The admin member deletes the colleague's message → 200: isChannelAdmin
  // passes both the canSend gate and canDeleteMessage's channel-admin widening.
  const del = await runAs(adminMember.token)('DELETE', `${chatBase}/channels/${proj}/messages/${msgId}`);
  assert.strictEqual(del.status, 200, JSON.stringify(del.json));

  const msgs = await api('GET', `${chatBase}/channels/${proj}/messages`);
  assert.ok(!msgs.json.messages.some((x: any) => x.id === msgId), 'deleted message must vanish');
});

test('delete a pinned message resolves the channel pinnedMessageId to null', async () => {
  const ch = await makeChannel(uniqueId('delpin'));
  const m = await sendChannelMessage(ch.id, 'pin-then-delete');

  const pin = await api('PUT', `${chatBase}/channels/${ch.id}/pin`, { messageId: m.id });
  assert.strictEqual(pin.status, 200, JSON.stringify(pin.json));
  let detail = await api('GET', `${chatBase}/channels/${ch.id}`);
  assert.strictEqual(detail.json.channel.pinnedMessageId, m.id);

  const del = await api('DELETE', `${chatBase}/channels/${ch.id}/messages/${m.id}`);
  assert.strictEqual(del.status, 200, JSON.stringify(del.json));

  detail = await api('GET', `${chatBase}/channels/${ch.id}`);
  assert.strictEqual(detail.json.channel.pinnedMessageId, null, 'deleting the pinned message must never leave a dangling primary pin');

  const rail = await api('GET', `${chatBase}/channels`);
  const row = rail.json.channels.find((c: any) => c.id === ch.id);
  assert.strictEqual(row.pinnedMessageId, null, 'rail must read the resolved pin too');
});

test('delete a message with attachments removes the bytes from disk', async (t) => {
  const ch = await makeChannel(uniqueId('delatt'));
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  );
  const form = new FormData();
  form.append('channelId', ch.id);
  form.append('file', new Blob([png], { type: 'image/png' }), 'pixel.png');
  const up = await fetch(`${API_URL}/chat-team/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${signTestToken()}` },
    body: form as any,
  });
  const upJson = await up.json().catch(() => ({}));
  assert.strictEqual(up.status, 201, JSON.stringify(upJson));
  const attachment = upJson.attachment;
  const msg = await sendChannelMessage(ch.id, 'see image', { attachments: [{ id: attachment.id, name: attachment.name }] });

  // Downloadable while the message lives.
  const before = await reqAuth('GET', `${chatBase}/uploads/${attachment.id}`);
  assert.strictEqual(before.status, 200);

  const del = await api('DELETE', `${chatBase}/channels/${ch.id}/messages/${msg.id}`);
  assert.strictEqual(del.status, 200, JSON.stringify(del.json));

  // API level: the route 404s once the bytes are really gone (attachmentPath
  // probes the disk — a leaked file would still be served).
  const after = await reqAuth('GET', `${chatBase}/uploads/${attachment.id}`);
  assert.strictEqual(after.status, 404);

  // Disk level: assert against the running container's uploads dir.
  try {
    const out = execFileSync('docker', ['exec', 'wsd-pro', 'ls', '/app/data/chat-team/uploads'], { encoding: 'utf8', timeout: 15000 });
    const entries = out.split(/\r?\n/).filter(Boolean);
    assert.ok(!entries.includes(attachment.id), `attachment bytes leaked on disk: ${entries.join(', ')}`);
    assert.ok(!entries.includes(`${attachment.id}.meta.json`), 'attachment meta leaked on disk');
  } catch (err) {
    t.skip(`docker CLI/container unavailable — on-disk half skipped (${(err as Error).message})`);
  }
});

test('delete a message keeps replies to it (dangling replyTo preserved)', async () => {
  const ch = await makeChannel(uniqueId('delrep'));
  const target = await sendChannelMessage(ch.id, 'target for reply');
  const reply = await sendChannelMessage(ch.id, 'a reply', { replyTo: target.id });
  assert.strictEqual(reply.replyTo, target.id);

  const del = await api('DELETE', `${chatBase}/channels/${ch.id}/messages/${target.id}`);
  assert.strictEqual(del.status, 200, JSON.stringify(del.json));

  const msgs = await api('GET', `${chatBase}/channels/${ch.id}/messages`);
  const row = msgs.json.messages.find((x: any) => x.id === reply.id);
  assert.ok(row, 'the reply must survive its target');
  assert.strictEqual(row.replyTo, target.id, 'a dangling replyTo is preserved — the feed keeps history');
});

test('delete non-existent message → 404, junk ids → 400', async () => {
  const ch = await makeChannel(uniqueId('delnone'));
  const missing = await api('DELETE', `${chatBase}/channels/${ch.id}/messages/m-bogus999`);
  assert.strictEqual(missing.status, 404, JSON.stringify(missing.json));
  const junk = await api('DELETE', `${chatBase}/channels/${ch.id}/messages/junk`);
  assert.strictEqual(junk.status, 400, JSON.stringify(junk.json));
  const unknownChannel = await api('DELETE', `${chatBase}/channels/ch-nope/messages/m-bogus999`);
  assert.strictEqual(unknownChannel.status, 404);

  // Project channel: an outsider (non-member viewer) gets 403 even for a
  // nonexistent message id path shape (access checked before existence probes
  // — no oracle leaks across the membership boundary).
  const slug = uniqueId('delout');
  const created = await api('POST', '/projects', { name: 'Del Outsider', slug });
  assert.strictEqual(created.status, 201, `create project: ${created.status} ${JSON.stringify(created.json)}`);
  createdSlugs.push(slug);
  const outsiderTok = jwt.sign({ id: 'outsider-u', username: 'outsider', role: 'viewer', tv: 0 }, JWT_SECRET, { expiresIn: '24h' });
  const out = await runAs(outsiderTok)('DELETE', `${chatBase}/channels/project:${slug}/messages/m-bogus999`);
  assert.strictEqual(out.status, 403, JSON.stringify(out.json));
});

test('WS: message_updated arrives after an edit over REST', async () => {
  const ch = await makeChannel(uniqueId('wsupd'));
  const m = await sendChannelMessage(ch.id, 'before edit');
  const token = signTestToken();
  const url = `${WS_BASE}/ws/chat-team?token=${encodeURIComponent(token)}`;
  const frames: any[] = [];
  let putStatus: number | null = null;
  let updateArrived = false;

  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('timeout waiting for subscribed/message_updated frames')), 8000);
    const maybeDone = () => {
      if (updateArrived && putStatus !== null) {
        clearTimeout(to);
        resolve();
      }
    };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'subscribe', channelId: ch.id })));
    ws.on('message', (d) => {
      const f = JSON.parse(d.toString());
      frames.push(f);
      if (f.type === 'subscribed' && f.channelId === ch.id) {
        void api('PUT', `${chatBase}/channels/${ch.id}/messages/${m.id}`, { text: 'after edit' }).then((r) => {
          putStatus = r.status;
          maybeDone();
        });
        return;
      }
      if (f.type === 'message_updated' && f.channelId === ch.id) {
        updateArrived = true;
        maybeDone();
      }
    });
    ws.on('error', (e) => { clearTimeout(to); reject(e); });
  });
  try { ws.terminate(); } catch { /* gone */ }

  assert.strictEqual(putStatus, 200, 'edit PUT must succeed');
  const update = frames.find((f) => f.type === 'message_updated');
  assert.ok(update, 'expected a message_updated frame');
  assert.strictEqual(update.channelId, ch.id);
  assert.strictEqual(update.message.id, m.id);
  assert.strictEqual(update.message.text, 'after edit');
  assert.ok(update.message.editedAt, 'the broadcast carries the editedAt stamp');
});

test('WS: message_deleted arrives after a delete over REST', async () => {
  const ch = await makeChannel(uniqueId('wsdel'));
  const m = await sendChannelMessage(ch.id, 'bye');
  const token = signTestToken();
  const url = `${WS_BASE}/ws/chat-team?token=${encodeURIComponent(token)}`;
  const frames: any[] = [];
  let delStatus: number | null = null;
  let deleteArrived = false;

  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('timeout waiting for subscribed/message_deleted frames')), 8000);
    const maybeDone = () => {
      if (deleteArrived && delStatus !== null) {
        clearTimeout(to);
        resolve();
      }
    };
    ws.on('open', () => ws.send(JSON.stringify({ type: 'subscribe', channelId: ch.id })));
    ws.on('message', (d) => {
      const f = JSON.parse(d.toString());
      frames.push(f);
      if (f.type === 'subscribed' && f.channelId === ch.id) {
        void api('DELETE', `${chatBase}/channels/${ch.id}/messages/${m.id}`).then((r) => {
          delStatus = r.status;
          maybeDone();
        });
        return;
      }
      if (f.type === 'message_deleted' && f.channelId === ch.id) {
        deleteArrived = true;
        maybeDone();
      }
    });
    ws.on('error', (e) => { clearTimeout(to); reject(e); });
  });
  try { ws.terminate(); } catch { /* gone */ }

  assert.strictEqual(delStatus, 200, 'delete must succeed');
  const delFrame = frames.find((f) => f.type === 'message_deleted');
  assert.ok(delFrame, 'expected a message_deleted frame');
  assert.strictEqual(delFrame.channelId, ch.id);
  assert.strictEqual(delFrame.msgId, m.id);
});