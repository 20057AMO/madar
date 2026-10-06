/**
 * chat-sessions-core.test.ts
 * Offline units for the chat session index + conversation store — the '..'
 * traversal class, driven against a temp data dir like the other offline suites.
 *
 * A client-named id used to survive the character filters VERBATIM ('..' is
 * all legal characters), so `path.join(CHATS_DIR, slug, chatId)` consumed it:
 *   - `DELETE /api/chat/sessions/..?project=global` reached
 *     `rmSync(join(chats,'global','..'))` = the whole chats directory, and
 *     `?project=..` with `chatId='..'` was `join(chats,'..','..')` = DATA_DIR
 *     itself (users.json, jwt.secret, providers.json);
 *   - the WS room `/ws/chat/global/..` appended through the same joins;
 *   - chat-store's `file()` mkdir'd and wrote at that escaped location.
 *
 * The sanitizers now fold dot-only segments, chatDirFor structurally proves
 * every rmSync target, and both fallbacks are STABLE (the old
 * `chat-${Date.now()}` produced a different key per call, so append and
 * readEvents could never agree on an empty id).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';

register(new URL('./ts-ext-resolve.mjs', import.meta.url).href);

// Env BEFORE the dynamic imports: both modules capture DATA_DIR at import time.
// The data dir sits one level down inside a private base so the pre-fix escape
// target (the PARENT of DATA_DIR) is observable and private to this run.
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wsd-chatsess-'));
const dataDir = path.join(base, 'data');
process.env.WSD_DATA_DIR = dataDir;
fs.mkdirSync(dataDir, { recursive: true });

const sessions = await import('../src/services/chat-sessions.ts');
const { ChatStore, chatStore } = await import('../src/services/chat-store.ts');

const CHATS = path.join(dataDir, 'chats');
const SENTINEL = path.join(dataDir, 'jwt.secret');

const ev = () => ({ type: 'user_message', content: 'x', timestamp: new Date().toISOString() });

before(() => {
  // Stand-in for the files DATA_DIR really holds — this must survive every row.
  fs.writeFileSync(SENTINEL, 'SECRET-KEY-MATERIAL', 'utf8');
});

after(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('chat sessions · dot ids are folded before any path join', () => {
  test('a dot-only project / chat id never survives sanitizing', () => {
    const s = sessions.touchSession('..', '..', ev());
    assert.strictEqual(s.slug, 'global', "'..' as a project folds to the default scope");
    assert.strictEqual(s.chatId, 'chat-unspecified', "'..' as a chat id folds to the stable fallback");

    const created = sessions.createSession({ project: '.', name: 'dot' });
    assert.strictEqual(created.slug, 'global');
    assert.ok(!created.chatId.includes('..'), `generated id leaked dots: ${created.chatId}`);

    // Listing a crafted scope returns only real (folded) rows.
    const rows = sessions.listSessions('..');
    assert.ok(rows.length > 0, 'the fold must map to a real scope, not an empty string');
    assert.ok(rows.every((r) => r.slug === 'global'), 'no row may carry a raw ".." slug');
  });

  test('an empty chat id maps to ONE stable key — a fresh reader sees what the writer wrote', () => {
    chatStore.append('global', '', 'user_message', 'first');
    // A fresh instance has no caches: pre-fix, append wrote to
    // `chat-<Date.now()>` and this read looked in a DIFFERENT timestamped dir.
    const fresh = new ChatStore();
    const events = fresh.readEvents('global', '');
    assert.strictEqual(events.length, 1, 'the empty-id conversation must be readable');
    assert.strictEqual(events[0].content, 'first');
    assert.ok(
      fs.existsSync(path.join(CHATS, 'global', 'chat-unspecified', 'events.jsonl')),
      'the stable key is the documented directory'
    );
  });
});

describe('chat sessions · deleteSession cannot walk out of chats/', () => {
  test("a poisoned '..' index row cannot rmSync the chats directory", () => {
    const canary = path.join(CHATS, 'other-project', 'keep-me', 'events.jsonl');
    fs.mkdirSync(path.dirname(canary), { recursive: true });
    fs.writeFileSync(canary, '{"seq":1,"type":"user_message","content":"kept","timestamp":"t"}\n');
    const indexFile = path.join(CHATS, 'sessions.json');

    // Exactly what a PRE-FIX touchSession('global','..') persisted: chatId '..'
    // verbatim in the index, so deleteSession used to find it and rmSync
    // `join(chats,'global','..')` — CHATS itself, with every conversation in it.
    //
    // Start from the state that makes the assertion meaningful: drop the LEGIT
    // `global/chat-unspecified` directory the rows above created, or backfill
    // would re-add it on load and deleteSession could (correctly) delete that
    // real two-segment session instead of reaching the guard at all.
    sessions.resetSessionsCache();
    fs.rmSync(path.join(CHATS, 'global'), { recursive: true, force: true });
    fs.writeFileSync(
      indexFile,
      JSON.stringify([
        { slug: 'global', chatId: '..', name: 'poison', createdAt: 't', updatedAt: 't', messageCount: 0, lastPreview: '' },
      ])
    );
    sessions.resetSessionsCache();

    assert.strictEqual(sessions.deleteSession('global', '..'), false, 'the crafted row must not be reachable');
    assert.ok(fs.existsSync(canary), 'the chats directory (and its conversations) must survive');
    assert.ok(fs.existsSync(indexFile), 'the index itself must survive');
    assert.strictEqual(fs.readFileSync(SENTINEL, 'utf8'), 'SECRET-KEY-MATERIAL');
  });

  test("a poisoned '..'/'..' pair cannot rmSync DATA_DIR itself", () => {
    const indexFile = path.join(CHATS, 'sessions.json');
    sessions.resetSessionsCache();
    fs.writeFileSync(
      indexFile,
      JSON.stringify([
        { slug: '..', chatId: '..', name: 'poison', createdAt: 't', updatedAt: 't', messageCount: 0, lastPreview: '' },
      ])
    );
    sessions.resetSessionsCache();

    // The DATA_DIR wipe shape: sanitizeSlug('..') folds the LOOKUP to
    // ('global','chat-unspecified'), which matches nothing, so the row is
    // unreachable and rmSync never runs — pre-fix this returned true and
    // removed users.json / jwt.secret / everything beside it.
    assert.strictEqual(sessions.deleteSession('..', '..'), false);
    assert.ok(fs.existsSync(SENTINEL), 'DATA_DIR must survive a crafted delete');
    assert.ok(fs.existsSync(path.join(CHATS, 'sessions.json')), 'the index must survive');
  });
});

describe('chat store · a crafted key stays inside chats/', () => {
  test("'..' as both key segments writes INSIDE the store, never beside DATA_DIR", () => {
    // Pre-fix: path.join(chats, '..', '..') was the PARENT of DATA_DIR —
    // mkdir + appendFileSync happily created events.jsonl there, outside the
    // data dir entirely. The base dir is private to this run, so the absence
    // is a real witness, not a coincidence.
    const escaped = path.join(base, 'events.jsonl');
    assert.ok(!fs.existsSync(escaped), 'precondition: the escape target does not exist yet');

    chatStore.append('..', '..', 'user_message', 'esc');

    assert.ok(!fs.existsSync(escaped), 'the append must not land outside the data dir');
    assert.ok(
      fs.existsSync(path.join(CHATS, 'chat-unspecified', 'chat-unspecified', 'events.jsonl')),
      'the append lands at the folded two-segment key'
    );
    const events = chatStore.readEvents('..', '..');
    assert.strictEqual(events.length, 1, 'write and read must agree on the folded key');
    assert.strictEqual(events[0].content, 'esc');
    assert.strictEqual(fs.readFileSync(SENTINEL, 'utf8'), 'SECRET-KEY-MATERIAL', 'DATA_DIR untouched');
  });
});
