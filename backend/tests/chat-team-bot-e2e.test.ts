import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { reqAuth, req, uniqueId, initTestAuth, JWT_SECRET } from './helpers.ts';

/**
 * @madar bot (real container, self-cleaning).
 *
 * The e2e surface is the DEGRADED path — no LLM provider is guaranteed to be
 * reachable, so @madar must fall back to a single friendly 'unavailable'
 * notice instead of failing the POST. It also proves the REST surface keeps
 * working with bot messages around (list channels / read history), that a
 * write-level channel creator can delete a bot message, and that the 'madar'
 * username is reserved against human accounts.
 */

const chatBase = '/chat-team';
const createdChannelIds: string[] = [];
const createdUserIds: string[] = [];

const BOT_USER_ID = 'bot-madar';
const BOT_USERNAME = 'madar';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll message history until a bot message appears (up to 60s — a degraded
 *  run posts its notice within seconds; a live LLM may take longer). */
async function waitForBotMessage(channelId: string): Promise<any[]> {
  const start = Date.now();
  for (;;) {
    const res = await reqAuth('GET', `${chatBase}/channels/${channelId}/messages?limit=100`);
    if (res.ok) {
      const messages = (await res.json()).messages || [];
      const bot = messages.filter((m: any) => m.userId === BOT_USER_ID);
      if (bot.length > 0) return bot;
    }
    if (Date.now() - start > 60_000) {
      throw new Error(`timed out waiting for a bot message in ${channelId}`);
    }
    await sleep(500);
  }
}

async function makeEditor(): Promise<{ id: string; username: string; token: string }> {
  const username = uniqueId('bot-edit');
  const res = await reqAuth('POST', '/users', { username, password: 'pass-123456', role: 'editor' });
  assert.ok(res.ok, `editor create failed: ${res.status}`);
  const body = await res.json();
  const token = jwt.sign({ id: body.id, username: body.username, role: 'editor', tv: 0 }, JWT_SECRET, {
    expiresIn: '24h',
  });
  createdUserIds.push(body.id);
  return { id: body.id, username: body.username, token };
}

async function asUser(token: string, method: string, urlPath: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await req(method, urlPath, body, { Authorization: `Bearer ${token}` });
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
});

test('degraded @madar run: mention returns 201 and lands exactly ONE bot message', async () => {
  const editor = await makeEditor();

  const create = await asUser(editor.token, 'POST', `${chatBase}/channels`, { name: uniqueId('Madar Bot') });
  assert.strictEqual(create.status, 201, `channel create failed: ${create.status} ${JSON.stringify(create.json)}`);
  const channelId = create.json.channel.id as string;
  createdChannelIds.push(channelId);

  // The POST itself must never 500 — fire-and-forget bot even with no provider.
  const send = await asUser(editor.token, 'POST', `${chatBase}/messages`, {
    channelId,
    text: '@madar hello from e2e',
  });
  assert.strictEqual(send.status, 201, `mention send failed: ${send.status} ${JSON.stringify(send.json)}`);

  const [botMsg] = await waitForBotMessage(channelId);
  assert.ok(botMsg, 'a bot message must appear in history');
  assert.strictEqual(botMsg.userId, BOT_USER_ID);
  assert.strictEqual(botMsg.username, BOT_USERNAME);
  assert.ok(String(botMsg.text).length > 0, 'the degraded reply is a short notice');
  assert.ok(String(botMsg.text).length < 300, 'notices are short');

  // Exactly one bot message — the notice cooldown + reply guard hold.
  const history = await reqAuth('GET', `${chatBase}/channels/${channelId}/messages?limit=100`);
  const botRows = ((await history.json()).messages || []).filter((m: any) => m.userId === BOT_USER_ID);
  assert.strictEqual(botRows.length, 1, 'exactly one bot message after a single mention');
});

test('the REST rail keeps working with bot messages present', async () => {
  const editor = await makeEditor();

  const create = await asUser(editor.token, 'POST', `${chatBase}/channels`, { name: uniqueId('Madar Rail') });
  assert.strictEqual(create.status, 201);
  const channelId = create.json.channel.id as string;
  createdChannelIds.push(channelId);

  await asUser(editor.token, 'POST', `${chatBase}/messages`, { channelId, text: '@madar rail check' });
  await waitForBotMessage(channelId);

  const rail = await asUser(editor.token, 'GET', `${chatBase}/channels`);
  assert.strictEqual(rail.status, 200);
  assert.ok(rail.json.channels.some((c: any) => c.id === channelId));

  const msgs = await asUser(editor.token, 'GET', `${chatBase}/channels/${channelId}/messages`);
  assert.strictEqual(msgs.status, 200);
  assert.ok(Array.isArray(msgs.json.messages));
  assert.ok(msgs.json.messages.some((m: any) => m.userId === BOT_USER_ID));
});

test('a write-level channel creator deletes a bot message via REST', async () => {
  const editor = await makeEditor();

  const create = await asUser(editor.token, 'POST', `${chatBase}/channels`, { name: uniqueId('Madar Del') });
  assert.strictEqual(create.status, 201);
  const channelId = create.json.channel.id as string;
  createdChannelIds.push(channelId);

  await asUser(editor.token, 'POST', `${chatBase}/messages`, { channelId, text: '@madar delete me please' });
  const [botMsg] = await waitForBotMessage(channelId);

  const del = await asUser(editor.token, 'DELETE', `${chatBase}/channels/${channelId}/messages/${botMsg.id}`);
  assert.strictEqual(del.status, 200, `bot message delete failed: ${del.status} ${JSON.stringify(del.json)}`);

  const after = await asUser(editor.token, 'GET', `${chatBase}/channels/${channelId}/messages`);
  assert.strictEqual((after.json.messages || []).some((m: any) => m.id === botMsg.id), false);
});

test("the 'madar' username is reserved for the bot (POST /api/users → 400)", async () => {
  for (const name of ['Madar', ' madar ', 'MADAR']) {
    const res = await reqAuth('POST', '/users', { username: name, password: 'pass-123456', role: 'editor' });
    assert.strictEqual(res.status, 400, `username '${name}' must be rejected`);
    const body = await res.json().catch(() => ({}));
    assert.ok(/reserved/i.test(String(body.error || '')), `expected a reserved error, got ${JSON.stringify(body)}`);
  }
});