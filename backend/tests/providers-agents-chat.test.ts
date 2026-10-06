import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { uniqueId, req, reqAuth, initTestAuth, liveUser, cleanupLiveUsers } from './helpers.ts';

describe('Providers / Agents / Chat sessions CRUD', () => {
  before(async () => { await initTestAuth(); });

  const runId = Date.now().toString(36);
  const providerName = uniqueId('prov');
  const providerKey = `sk-${runId}-crud-test-fake`;
  let providerId = '';
  const agentName = uniqueId('agent');
  let agentId = '';

  // Provider MANAGEMENT endpoints are gated by the optional Providers Security
  // Lock. When the target server has that lock enabled we cannot know its
  // password, so provider CRUD subtests self-skip (same convention as the
  // credential-gated suites); agents/chat are never blocked by the lock.
  let lockedProbe: boolean | null = null;
  const providersLocked = async (): Promise<boolean> => {
    if (lockedProbe === null) {
      try {
        const res = await reqAuth('GET', '/providers');
        lockedProbe = res.status === 403;
      } catch {
        lockedProbe = false;
      }
    }
    return lockedProbe;
  };

  after(async () => {
    if (providerId) { try { await reqAuth('DELETE', `/providers/${providerId}`); } catch { /* best effort */ } }
    if (agentId) { try { await reqAuth('DELETE', `/agents/${agentId}`); } catch { /* best effort */ } }
  });

  // ── Providers ──────────────────────────────────────────────
  test('stale providers from earlier runs are removed', async (t) => {
    if (await providersLocked()) return t.skip('providers lock enabled on this server');
    const res = await reqAuth('GET', '/providers');
    assert.strictEqual(res.status, 200);
    const { providers } = await res.json();
    for (const p of providers as Array<{ id: string; host?: string }>) {
      if (p.host?.includes('.crud-test.invalid')) {
        await reqAuth('DELETE', `/providers/${p.id}`);
      }
    }
  });

  test('provider templates list responds', async () => {
    const res = await reqAuth('GET', '/providers/templates');
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.ok(Array.isArray(data.templates));
  });

  test('create provider (disabled, fake key) → listed', async (t) => {
    if (await providersLocked()) return t.skip('providers lock enabled on this server');
    const res = await reqAuth('POST', '/providers', {
      name: providerName,
      host: `https://${runId}.crud-test.invalid`,
      type: 'openai',
      apiKey: providerKey,
      enabled: false,
    });
    assert.ok([200, 201].includes(res.status), `create failed: ${res.status}`);
    const data = await res.json();
    providerId = data.provider?.id || '';
    assert.ok(providerId, 'created provider must have an id');

    const list = await reqAuth('GET', '/providers');
    const data2 = await list.json();
    assert.ok(data2.providers.some((p: any) => p.id === providerId));
  });

  test('update provider name → reflected', async (t) => {
    if (await providersLocked()) return t.skip('providers lock enabled on this server');
    const res = await reqAuth('PUT', `/providers/${providerId}`, { name: `${providerName}-v2` });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.provider.name, `${providerName}-v2`);
  });

  test('delete provider → gone from list', async (t) => {
    if (await providersLocked()) return t.skip('providers lock enabled on this server');
    const res = await reqAuth('DELETE', `/providers/${providerId}`);
    assert.strictEqual(res.status, 200);
    providerId = '';
    const list = await reqAuth('GET', '/providers');
    const data = await list.json();
    assert.ok(!data.providers.some((p: any) => p.id === providerId));
  });

  // ── Agents ─────────────────────────────────────────────────
  test('create agent with defaults', async () => {
    const res = await reqAuth('POST', '/agents', { name: agentName, systemPrompt: 'You are a test agent.' });
    assert.ok([200, 201].includes(res.status), `create failed: ${res.status}`);
    const data = await res.json();
    agentId = data.agent?.id || '';
    assert.ok(agentId, 'created agent must have an id');
  });

  test('agent sessions: create → rename → list → delete', async () => {
    const createRes = await reqAuth('POST', `/agents/${agentId}/sessions`, { name: 'crud-session' });
    assert.ok([200, 201].includes(createRes.status));
    const { session } = await createRes.json();
    assert.ok(session.chatId);

    const renameRes = await reqAuth('PUT', `/agents/${agentId}/sessions/${session.chatId}`, { name: 'renamed-session' });
    assert.strictEqual(renameRes.status, 200);
    assert.strictEqual((await renameRes.json()).session.name, 'renamed-session');

    const listRes = await reqAuth('GET', `/agents/${agentId}/sessions`);
    const listData = await listRes.json();
    assert.ok(listData.sessions.some((s: any) => s.chatId === session.chatId));

    const delRes = await reqAuth('DELETE', `/agents/${agentId}/sessions/${session.chatId}`);
    assert.strictEqual(delRes.status, 200);
  });

  test('delete agent → sessions endpoint returns 404', async () => {
    const res = await reqAuth('DELETE', `/agents/${agentId}`);
    assert.strictEqual(res.status, 200);
    agentId = '';
    const check = await reqAuth('GET', `/agents/missing-agent-check/sessions`);
    assert.strictEqual(check.status, 404);
  });

  // ── Chat sessions ─────────────────────────────────────────
  test('chat session lifecycle', async () => {
    const createRes = await reqAuth('POST', '/chat/sessions', { name: 'crud-chat' });
    assert.strictEqual(createRes.status, 201);
    const { session } = await createRes.json();
    assert.ok(session.chatId);

    const listRes = await reqAuth('GET', '/chat/sessions');
    const listData = await listRes.json();
    assert.ok(listData.sessions.some((s: any) => s.chatId === session.chatId));

    const renameRes = await reqAuth('PUT', `/chat/sessions/${session.chatId}`, { name: 'crud-chat-v2' });
    assert.strictEqual(renameRes.status, 200);

    const delRes = await reqAuth('DELETE', `/chat/sessions/${session.chatId}`);
    assert.strictEqual(delRes.status, 200);
    assert.strictEqual((await delRes.json()).ok, true);
  });

});

// ── F1: the project gate on chat context + chat sessions ────────────────────
//
// Both surfaces are keyed by PROJECT, yet both were open to any authenticated
// user while the WebSocket that consumes the same data was member-gated
// (ws-chat: read=viewer, write=editor). Every row here proves the HTTP gate
// matches that contract — and that the canonical fold happens BEFORE the gate,
// so a near-miss slug cannot walk the legacy no-meta fallback into access.
describe('Chat context & sessions · project access gate (F1)', () => {
  before(async () => { await initTestAuth(); });

  const createdSlugs: string[] = [];
  let slug = '';
  let memberToken = '';
  let outsiderToken = '';

  after(async () => {
    for (const s of createdSlugs) {
      try { await reqAuth('DELETE', `/projects/${s}`); } catch { /* best effort */ }
    }
    await cleanupLiveUsers();
  });

  const authz = (token: string) => ({ Authorization: `Bearer ${token}` });

  test('GET /api/chat/context is member-gated, folded before the gate', async () => {
    slug = uniqueId('f1g');
    assert.ok(!/[^a-z0-9-]/.test(slug) && slug.length <= 24, `fixture slug must be canonical as-is: ${slug}`);
    const created = await reqAuth('POST', '/projects', { name: 'F1 Gate', slug });
    assert.strictEqual(created.status, 201, `create project: ${created.status}`);
    createdSlugs.push(slug);

    // Real throwaway accounts: verifyToken refuses invented ids, so an
    // "outsider" has to exist to measure 403s instead of 401s.
    const member = await liveUser('viewer', 'f1-member');
    const outsider = await liveUser('viewer', 'f1-outsider');
    memberToken = member.token;
    outsiderToken = outsider.token;
    const add = await reqAuth('POST', `/projects/${slug}/members`, { userId: member.id, role: 'viewer' });
    assert.strictEqual(add.status, 200, `add member: ${add.status}`);

    // Admin: full context of the project.
    const adminRes = await reqAuth('GET', `/chat/context?project=${slug}`);
    assert.strictEqual(adminRes.status, 200);
    const adminBody = await adminRes.json();
    assert.ok(adminBody.text.includes(slug), 'the 200 really is THIS project\'s context');

    // Member viewer: read is enough (mirrors ws-chat's read level).
    const memberRes = await req('GET', `/chat/context?project=${slug}`, undefined, authz(memberToken));
    assert.strictEqual(memberRes.status, 200, 'a member viewer may read the context');

    // Outsider viewer: refused, and the refusal carries no context at all.
    const outsiderRes = await req('GET', `/chat/context?project=${slug}`, undefined, authz(outsiderToken));
    assert.strictEqual(outsiderRes.status, 403, 'a non-member must not read the context');
    const outsiderBody = await outsiderRes.json();
    assert.strictEqual(outsiderBody.error, 'Access denied to this project');
    assert.ok(!outsiderBody.text, 'a refused answer carries no context payload');

    // Canonicalize-before-the-gate: near-miss forms fold to the SAME slug and
    // are refused identically (the /api/opencode/open invariant).
    for (const nearMiss of [`${slug}!`, slug.toUpperCase(), ` ${slug} `]) {
      const res = await req(
        'GET',
        `/chat/context?project=${encodeURIComponent(nearMiss)}`,
        undefined,
        authz(outsiderToken)
      );
      assert.strictEqual(res.status, 403, `near-miss ${JSON.stringify(nearMiss)} must fold, then be refused`);
    }

    // Junk that folds to '' is 400 (the caller decides malformed-vs-missing).
    const junk = await req('GET', '/chat/context?project=%21%21%21', undefined, authz(outsiderToken));
    assert.strictEqual(junk.status, 400);
    assert.strictEqual((await junk.json()).error, 'Project slug is invalid');

    // Missing project keeps its documented 400.
    const none = await req('GET', '/chat/context', undefined, authz(outsiderToken));
    assert.strictEqual(none.status, 400);

    // 'all' stays open to every authenticated user (the Agents page contract:
    // brief lines are tail-only, and /api/projects is already world-readable).
    const all = await req('GET', '/chat/context?project=all', undefined, authz(outsiderToken));
    assert.strictEqual(all.status, 200);

    // Unknown-but-well-formed slug: the legacy ABSENT-meta fallback answers
    // 200 with an honest "workspace not found" block — documented behavior,
    // asserted so the gate can never quietly change it into a 404.
    const ghost = await req('GET', '/chat/context?project=f1-no-such-proj', undefined, authz(outsiderToken));
    assert.strictEqual(ghost.status, 200, 'unknown slug keeps the documented legacy fallback');
    assert.match((await ghost.json()).text, /workspace not found/);
  });

  test('chat sessions: reads are viewer-gated, mutations editor-gated, per project', async () => {
    assert.ok(slug, 'the fixture project from the previous test');
    const canRead = await req('GET', `/chat/sessions?project=${slug}`, undefined, authz(outsiderToken));
    assert.strictEqual(canRead.status, 403, 'an outsider must not list another project\'s history');
    assert.ok(!(await canRead.json()).sessions, 'the refusal carries no rows');

    const memberList = await req('GET', `/chat/sessions?project=${slug}`, undefined, authz(memberToken));
    assert.strictEqual(memberList.status, 200, 'a member viewer may read the list');
    assert.ok(Array.isArray((await memberList.json()).sessions));

    // Mutations are editor-level — a member VIEWER is refused too.
    const memberPost = await req('POST', '/chat/sessions', { name: 'f1', project: slug }, authz(memberToken));
    assert.strictEqual(memberPost.status, 403, 'a member viewer must not create');
    const outsiderPost = await req('POST', '/chat/sessions', { name: 'f1', project: slug }, authz(outsiderToken));
    assert.strictEqual(outsiderPost.status, 403, 'an outsider must not create');
    const outsiderPut = await req('PUT', `/chat/sessions/nope?project=${slug}`, { name: 'x' }, authz(outsiderToken));
    assert.strictEqual(outsiderPut.status, 403, 'refused BEFORE any lookup (no existence oracle)');
    const outsiderDel = await req('DELETE', `/chat/sessions/nope?project=${slug}`, undefined, authz(outsiderToken));
    assert.strictEqual(outsiderDel.status, 403, 'an outsider must not delete');

    // Admin (editor+) can run the full mutation cycle, scoped to the project.
    const create = await reqAuth('POST', '/chat/sessions', { name: 'f1-gate-sess', project: slug });
    assert.strictEqual(create.status, 201, `session create: ${create.status}`);
    const { session } = await create.json();
    const rename = await reqAuth('PUT', `/chat/sessions/${session.chatId}?project=${slug}`, { name: 'f1-gate-sess-2' });
    assert.strictEqual(rename.status, 200);
    const del = await reqAuth('DELETE', `/chat/sessions/${session.chatId}?project=${slug}`);
    assert.strictEqual(del.status, 200);
    assert.strictEqual((await del.json()).ok, true);
  });

  test('a ".." project never reaches the store — 400 before any filesystem work', async () => {
    // `project=..` sits in the QUERY string (URL parsers leave queries alone),
    // so this is the shape that used to reach listSessions/createSession and
    // turn into path.join(chats, '..', ...).
    const list = await req('GET', '/chat/sessions?project=..', undefined, authz(outsiderToken));
    assert.strictEqual(list.status, 400);
    assert.strictEqual((await list.json()).error, 'Project slug is invalid');

    const post = await req('POST', '/chat/sessions', { name: 'dot', project: '..' }, authz(outsiderToken));
    assert.strictEqual(post.status, 400);

    const del = await req('DELETE', '/chat/sessions/x?project=..', undefined, authz(outsiderToken));
    assert.strictEqual(del.status, 400);

    // Control: with no project the global rows stay open to any authenticated
    // user (documented contract — the Agents page's unscoped history).
    const globalCreate = await req('POST', '/chat/sessions', { name: 'f1-global' }, authz(outsiderToken));
    assert.strictEqual(globalCreate.status, 201, 'global rows remain ungated');
    const g = (await globalCreate.json()).session;
    const globalList = await req('GET', '/chat/sessions', undefined, authz(outsiderToken));
    assert.strictEqual(globalList.status, 200);
    assert.ok(((await globalList.json()).sessions as any[]).some((s) => s.chatId === g.chatId));
    const globalDel = await req('DELETE', `/chat/sessions/${g.chatId}`, undefined, authz(outsiderToken));
    assert.strictEqual(globalDel.status, 200);
  });
});
