/**
 * ws-project-scope.test.ts — the project scope a WebSocket message ACTS on must
 * be the exact value its access gate evaluated.
 *
 * Two defects, same root cause (gate value ≠ acted-on value):
 *   A. MISSING PER-MESSAGE GATE (ws-chat). The room gate at upgrade only covers
 *      the socket's OWN project ('/ws/chat/global/...' grants every
 *      authenticated user write). A message may carry its own `project`, and
 *      that value decides whose WSD_PROJECT.md goals + notes + file tree and
 *      whose BM25-retrieved SOURCE CHUNKS feed the model — with no check at all.
 *      Any authenticated user could therefore pull another project's context
 *      into a reply. The frontend never sends the field (useChatSocket's third
 *      `project` argument has no caller), so gating it costs the UI nothing.
 *   B. UNFOLDED SCOPE (ws-agent). `project` reached the editor gate only when it
 *      matched a permissive regex, so a value that failed the regex skipped the
 *      gate entirely while still being the workspace the tools executed in
 *      (`wsd-…` dot-bearing legacy slugs are real directories on disk).
 *
 * Driven through the REAL socket handlers with a fake WebSocket and a temp data
 * dir + workspace root (same offline pattern as session-revocation.test.ts):
 * both modules read their meta store and workspaces from those env vars, so no
 * container is involved. A refusal is observable as a single error frame and, more
 * importantly, as the ABSENCE of the 'started' broadcast that precedes any run.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';

register(new URL('./ts-ext-resolve.mjs', import.meta.url).href);

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsd-ws-scope-'));
const workspacesDir = path.join(dataDir, 'workspaces');
process.env.WSD_DATA_DIR = dataDir;
process.env.WSD_PROJECTS_DIR = workspacesDir;
fs.mkdirSync(path.join(dataDir, 'projects'), { recursive: true });
fs.mkdirSync(workspacesDir, { recursive: true });

const store = await import('../src/services/projects-meta.ts');
const agentStore = await import('../src/services/agent-store.ts');
const { handleChatSocket } = await import('../src/ws/ws-chat.ts');
const { handleAgentSocket } = await import('../src/ws/ws-agent.ts');

after(() => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

/** Minimal stand-in for a `ws` socket: records frames, replays `message`. */
function fakeSocket() {
  const frames: any[] = [];
  const handlers = new Map<string, Array<(arg: any) => void>>();
  const ws: any = {
    OPEN: 1,
    readyState: 1,
    send: (data: string) => { frames.push(JSON.parse(data)); },
    on: (event: string, cb: (arg: any) => void) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(cb);
    },
    close: () => { ws.readyState = 3; },
    deliver: (payload: unknown) => {
      for (const cb of handlers.get('message') || []) cb(Buffer.from(JSON.stringify(payload)));
    },
    frames,
  };
  return ws;
}

/** Let the handler's async body run — it yields before it answers. */
const settle = () => new Promise((r) => setTimeout(r, 40));

const OUTSIDER = { id: 'u-outsider', username: 'outsider', role: 'viewer' as const };

describe('ws-chat — a per-message project scope needs its own gate', () => {
  // Another team's project, with real content: if the scope were honoured without
  // a gate, this text would end up in the model's context.
  const victim = 'other-project';
  store.saveMeta(victim, { activity: [], ownerId: 'u-owner', members: [] });
  fs.mkdirSync(path.join(workspacesDir, victim), { recursive: true });
  fs.writeFileSync(path.join(workspacesDir, victim, 'secret.txt'), 'OTHER-TEAM-SECRET');
  fs.writeFileSync(path.join(workspacesDir, victim, 'WSD_PROJECT.md'), '# Other team\n\nTheir private roadmap.');

  test('the global room refuses a scope the caller has no access to', async () => {
    const ws = fakeSocket();
    // 'global' is not a project: every authenticated user may write in it.
    handleChatSocket(ws as any, 'global', 'probe-a', { ...OUTSIDER }, () => {});
    ws.deliver({ type: 'prompt', text: 'summarise it', project: victim });
    await settle();
    const errors = ws.frames.filter((f) => f.type === 'error');
    assert.ok(
      errors.some((e) => e.message === 'Project access denied'),
      `expected a refusal, got ${JSON.stringify(ws.frames)}`,
    );
    assert.strictEqual(ws.frames.some((f) => f.type === 'started'), false, 'no run may start on an ungated scope');
  });

  test('a non-canonical spelling of a real project is refused before any run', async () => {
    store.saveMeta('victim.plan', {
      activity: [],
      ownerId: 'u-owner',
      members: [{ userId: 'u-dotted-owner', role: 'admin', addedAt: '' }],
    });
    const ws = fakeSocket();
    handleChatSocket(ws as any, 'global', 'probe-b', { ...OUTSIDER }, () => {});
    ws.deliver({ type: 'prompt', text: 'hi', project: 'victim.plan' });
    await settle();
    // The value cannot be a slug, so it is refused rather than folded — the
    // caller cannot tell our canonical `victim-plan` from a project of its own.
    assert.deepStrictEqual(
      ws.frames.filter((f) => f.type === 'error').map((f) => f.message),
      ['Invalid project scope'],
    );
    assert.strictEqual(ws.frames.some((f) => f.type === 'started'), false);
  });

  test('a member keeps their own scope (the gate must not over-block)', async () => {
    store.saveMeta('mine', {
      activity: [],
      ownerId: 'u-mine',
      members: [{ userId: 'u-member', role: 'viewer', addedAt: '' }],
    });
    const ws = fakeSocket();
    // A member VIEWER of 'mine' may read its context: the scope is read-gated.
    handleChatSocket(ws as any, 'global', 'probe-c', { id: 'u-member', username: 'member', role: 'viewer' }, () => {});
    ws.deliver({ type: 'prompt', text: 'hi', project: 'mine' });
    await settle();
    assert.ok(
      !ws.frames.some((f) => f.type === 'error' && f.message === 'Project access denied'),
      `a member must not be refused: ${JSON.stringify(ws.frames)}`,
    );
  });
});

describe('ws-agent — the scope is gated on the value the tools execute in', () => {
  const agent = agentStore.createAgent({ name: 'Scope probe', systemPrompt: 'probe', toolsEnabled: false });

  test('a canonical scope on a project the caller cannot reach is refused', async () => {
    store.saveMeta('secret-plan', {
      activity: [],
      ownerId: 'u-owner',
      members: [{ userId: 'u-member', role: 'viewer', addedAt: '' }],
    });
    const ws = fakeSocket();
    handleAgentSocket(ws as any, agent.id, 'probe-d', { ...OUTSIDER }, () => {});
    ws.deliver({ type: 'prompt', text: 'list the files', project: 'secret-plan' });
    await settle();
    const errors = ws.frames.filter((f) => f.type === 'error');
    assert.ok(
      errors.some((e) => e.message === 'Project access denied'),
      `expected a refusal, got ${JSON.stringify(ws.frames)}`,
    );
    assert.strictEqual(ws.frames.some((f) => f.type === 'started'), false, 'no run may start');
  });

  test('a dot-bearing scope never reaches the tools', async () => {
    const ws = fakeSocket();
    handleAgentSocket(ws as any, agent.id, 'probe-f', { ...OUTSIDER }, () => {});
    ws.deliver({ type: 'prompt', text: 'list the files', project: 'secret.plan' });
    await settle();
    assert.deepStrictEqual(
      ws.frames.filter((f) => f.type === 'error').map((f) => f.message),
      ['Invalid project scope'],
      'a non-canonical scope is refused, never folded into the gated value',
    );
    assert.strictEqual(ws.frames.some((f) => f.type === 'started'), false);
  });

  test('a scope longer than the old 32-char regex can no longer skip the gate', async () => {
    const long = 'a'.repeat(40);
    store.saveMeta(long.slice(0, 32), {
      activity: [],
      ownerId: 'u-owner',
      members: [{ userId: 'u-member', role: 'viewer', addedAt: '' }],
    });
    const ws = fakeSocket();
    handleAgentSocket(ws as any, agent.id, 'probe-e', { ...OUTSIDER }, () => {});
    ws.deliver({ type: 'prompt', text: 'list the files', project: long });
    await settle();
    // Both spellings name the same canonical project, so neither may run: a
    // value that "looks invalid" is never a free pass — it is a refusal.
    assert.deepStrictEqual(
      ws.frames.filter((f) => f.type === 'error').map((f) => f.message),
      ['Invalid project scope'],
    );
    assert.strictEqual(ws.frames.some((f) => f.type === 'started'), false);
  });
});