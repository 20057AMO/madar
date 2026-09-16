import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import WebSocket from 'ws';
import { reqAuth, req, uniqueId, initTestAuth, JWT_SECRET, signTestToken, API_URL } from './helpers.ts';

/**
 * chat-team-bump.test.ts
 * Real-Docker coverage for `broadcastChatBump` (backend/src/ws/ws-chat-team.ts)
 * over the live /ws/chat-team socket.
 *
 * Contract under test (UX chat bump): every connected team-chat socket whose
 * user can access the channel gets a compact `chat_bump` mini-notification
 * when a message lands there — EXCEPT the sender's own sockets, and clients
 * whose `canAccessChannel` is 'none'. The bump preview is the message text
 * folded (whitespace runs → one space) and capped at 80 chars; it never
 * carries attachments or comments — the full rich payload only travels in the
 * subscriber-scoped `message` frame.
 *
 * A PROJECT channel is the fixture: it is the only kind where a non-member
 * viewer resolves to 'none' (manual/direct channels would legitimately
 * broadcast to outsiders by design, so they cannot prove the filter).
 */
const chatBase = '/chat-team';
const WS_BASE = (process.env.WSD_TEST_API_URL || 'http://127.0.0.1:3000/api')
  .replace('/api', '')
  .replace(/^http/, 'ws');

const createdSlugs: string[] = [];
const createdUserIds: string[] = [];
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
  return runAs(signTestToken())(method, urlPath, body);
}

/** Create + track a real user, mint their own session token. */
async function makeUser(username: string, role: 'editor' | 'viewer'): Promise<{ id: string; username: string; token: string }> {
  const res = await reqAuth('POST', '/users', { username: uniqueId(username), password: 'pass-123456', role });
  const body = await res.json();
  assert.strictEqual(res.status, 201, `create ${role} user: ${res.status} ${JSON.stringify(body)}`);
  createdUserIds.push(body.id);
  const token = jwt.sign({ id: body.id, username: body.username, role, tv: 0 }, JWT_SECRET, { expiresIn: '24h' });
  return { id: body.id, username: body.username, token };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Open a chat-team socket; optionally auto-subscribe to a channel. */
function openChatSocket(token: string, subscribeTo?: string) {
  const frames: any[] = [];
  const ws = new WebSocket(`${WS_BASE}/ws/chat-team?token=${encodeURIComponent(token)}`);
  const opened = new Promise<void>((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
  });
  ws.on('message', (d) => frames.push(JSON.parse(d.toString())));

  const waitFrame = async (pred: (f: any) => boolean, timeoutMs = 8000): Promise<any> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const hit = frames.find(pred);
      if (hit) return hit;
      await sleep(25);
    }
    throw new Error(`timed out after ${timeoutMs}ms waiting for frame; got: ${JSON.stringify(frames)}`);
  };

  const waitSubscribed = async (channelId: string) => {
    await opened;
    ws.send(JSON.stringify({ type: 'subscribe', channelId }));
    return waitFrame((f) => f.type === 'subscribed' && f.channelId === channelId);
  };

  return {
    ws,
    frames,
    opened,
    send: (obj: unknown) => ws.send(JSON.stringify(obj)),
    waitFrame,
    subscribed: subscribeTo ? waitSubscribed(subscribeTo) : null,
    close: () => {
      try {
        ws.terminate();
      } catch {
        /* already gone */
      }
    },
  };
}

before(async () => {
  await initTestAuth();
  testAdminId = (jwt.decode(signTestToken()) as any).id;
});

after(async () => {
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

/** Project channel with an editor member, a viewer member and a non-member. */
async function setupProjectChannel(t: any): Promise<{ slug: string; channelId: string } | null> {
  const slug = uniqueId('bump');
  const created = await api('POST', '/projects', { name: 'Bump Matrix', slug });
  if (created.status === 429) {
    t.skip('project creation rate-limited on this container (WSD_TESTING=0)');
    return null;
  }
  assert.strictEqual(created.status, 201, `create project: ${created.status} ${JSON.stringify(created.json)}`);
  createdSlugs.push(slug);
  return { slug, channelId: `project:${slug}` };
}

test('chat_bump fan-out matrix: members get bump after message, outsider and sender second tab never do', async (t) => {
  const rig = await setupProjectChannel(t);
  if (!rig) return;
  const { channelId } = rig;
  const editor = await makeUser('bumpE', 'editor');
  const viewer = await makeUser('bumpV', 'viewer');
  const outsider = await makeUser('bumpO', 'viewer');
  for (const [u, role] of [[editor, 'editor'], [viewer, 'viewer']] as const) {
    const add = await api('POST', `/projects/${rig.slug}/members`, { userId: u.id, role });
    assert.strictEqual(add.status, 200, JSON.stringify(add.json));
  }
  // The outsider stays a non-member (role viewer) — canAccessChannel → 'none'.

  const senderTab2 = openChatSocket(signTestToken()); // sender's OTHER tab: not subscribed, must be skipped
  const outsiderSock = openChatSocket(outsider.token);
  const editorSock = openChatSocket(editor.token, channelId);
  const viewerSock = openChatSocket(viewer.token, channelId);
  await Promise.all([editorSock.subscribed, viewerSock.subscribed]);

  // The outsider CANNOT subscribe to the project channel (the same
  // canAccessChannel gate the bump relies on).
  outsiderSock.send({ type: 'subscribe', channelId });
  const denied = await outsiderSock.waitFrame((f) => f.type === 'error');
  assert.strictEqual(denied.message, 'Access denied');

  // Send as the system admin (a THIRD identity whose socket is the second tab).
  const sent = await api('POST', `${chatBase}/messages`, { channelId, text: 'hello bump world' });
  assert.strictEqual(sent.status, 201, JSON.stringify(sent.json));
  const message = sent.json.message;

  // Both members: full `message` frame first, then the compact bump.
  for (const sock of [editorSock, viewerSock]) {
    const msgFrame = await sock.waitFrame((f) => f.type === 'message' && f.message?.id === message.id);
    const bump = await sock.waitFrame((f) => f.type === 'chat_bump' && f.channelId === channelId);
    assert.strictEqual(msgFrame.message.id, message.id);
    assert.strictEqual(bump.channelId, channelId);
    assert.strictEqual(bump.message.id, message.id);
    assert.strictEqual(bump.message.userId, testAdminId);
    assert.strictEqual(bump.message.username, 'test');
    assert.strictEqual(bump.message.text, 'hello bump world');
    assert.ok(bump.message.createdAt);
    assert.ok(!('attachments' in bump.message), 'bump is a compact preview, never the rich payload');
    const iMsg = sock.frames.findIndex((f) => f.type === 'message' && f.message?.id === message.id);
    const iBump = sock.frames.findIndex((f) => f.type === 'chat_bump' && f.channelId === channelId);
    assert.ok(iMsg < iBump, 'bump must follow the message frame on the same socket');
  }

  // Settling window: outsider and the sender's second tab must stay bump-free.
  await sleep(400);
  assert.ok(
    !outsiderSock.frames.some((f) => f.type === 'chat_bump'),
    'non-member outsider must never receive a chat_bump'
  );
  assert.ok(
    !senderTab2.frames.some((f) => f.type === 'chat_bump'),
    "the sender's own second tab must never receive a bump about its own message"
  );
  assert.ok(
    !senderTab2.frames.some((f) => f.type === 'message' && f.message?.id === message.id),
    "the sender's unsubscribed tab must not receive the full message frame either"
  );

  for (const s of [editorSock, viewerSock, outsiderSock, senderTab2]) s.close();
});

test('chat_bump preview: 80-char cap with whitespace folding, attachment ids never leak', async (t) => {
  const rig = await setupProjectChannel(t);
  if (!rig) return;
  const { channelId } = rig;
  const editor = await makeUser('bumpT', 'editor');
  const add = await api('POST', `/projects/${rig.slug}/members`, { userId: editor.id, role: 'editor' });
  assert.strictEqual(add.status, 200, JSON.stringify(add.json));

  // Upload an attachment (system admin token) so the message carries one.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
  );
  const form = new FormData();
  form.append('channelId', channelId);
  form.append('file', new Blob([png], { type: 'image/png' }), 'pixel.png');
  const up = await fetch(`${API_URL}/chat-team/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${signTestToken()}` },
    body: form as any,
  });
  const upJson = await up.json().catch(() => ({}));
  assert.strictEqual(up.status, 201, JSON.stringify(upJson));
  const attachment = upJson.attachment;

  // A >80-char text with space AND newline runs (sanitizePlain preserves \n,
  // strips control chars — tabs would never reach the preview to fold).
  const chunk = 'word  with   spaced\n\nruns   folding here ';
  const long = (chunk + 'pad ').repeat(4); // 180 chars, whitespace folds to ~150
  const expectedPreview = long.replace(/\s+/g, ' ').trim().slice(0, 80);

  const sock = openChatSocket(editor.token, channelId);
  await sock.subscribed;

  const sent = await api('POST', `${chatBase}/messages`, { channelId, text: long, attachments: [{ id: attachment.id, name: attachment.name }] });
  assert.strictEqual(sent.status, 201, JSON.stringify(sent.json));
  const message = sent.json.message;

  // Subscriber still gets the FULL payload: untruncated text + attachment.
  const msgFrame = await sock.waitFrame((f) => f.type === 'message' && f.message?.id === message.id);
  assert.strictEqual(msgFrame.message.text, long.trim(), 'full message frame keeps the unchanged text');
  assert.ok(Array.isArray(msgFrame.message.attachments));
  assert.strictEqual(msgFrame.message.attachments[0].id, attachment.id);
  assert.strictEqual(msgFrame.message.attachments[0].kind, 'image');

  // The bump is the folded, capped preview — exactly 80 chars.
  const bump = await sock.waitFrame((f) => f.type === 'chat_bump' && f.message?.id === message.id);
  assert.strictEqual(bump.message.text.length, 80, 'preview must never exceed 80 chars');
  assert.strictEqual(bump.message.text, expectedPreview, 'whitespace runs folded to single spaces before capping');

  // Attachment ids (and byte payloads) never leak into the preview.
  assert.ok(!('attachments' in bump.message), 'bump never carries attachment ids');
  assert.deepStrictEqual(
    Object.keys(bump.message).sort(),
    ['createdAt', 'id', 'text', 'userId', 'username'],
    'bump message is exactly the compact shape'
  );

  sock.close();
});