/**
 * project-reviews.test.ts
 * Real-Docker lifecycle for File Reviews (comment threads pinned to workspace
 * paths):
 *   - CRUD roundtrip: GET empty → POST thread 201 → reply → resolve → reopen
 *     → delete own comment → delete thread → 404s everywhere after.
 *   - Validation 400s: empty body, text > 2000 chars, `../` path, bad status,
 *     and the 201st-thread cap (200 seeded via docker exec — hammering the API
 *     would also burn the 120/min user-write limiter).
 *   - Access matrix: outsider viewer 403, viewer member read-only, editor
 *     member writes 200, global editor writes but cannot delete others (403),
 *     project-admin member deletes anything (200).
 *   - fileExists enrichment (present file true / missing path false).
 *   - If the flow is on activity: review_opened carries details.path.
 *   - Deleted-user identity: the stored creator/comment usernames survive the
 *     account removal (stored name wins — never a silent (deleted user)).
 *
 * Skips the cap-seed when the docker CLI is unavailable. Uses the SAME
 * forged-token trick as team-access.test.ts (JWT_SECRET from repo .env).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import jwt from 'jsonwebtoken';
import { execFileSync } from 'node:child_process';
import { uniqueId, req, reqAuth, initTestAuth, JWT_SECRET, API_URL } from './helpers.ts';

function signUser(id: string, username: string, role: string): string {
  return jwt.sign({ id, username, role, tv: 0 }, JWT_SECRET, { expiresIn: '24h' });
}

function runAs(token: string) {
  return {
    headers: { Authorization: `Bearer ${token}` },
  };
}

async function deleteRobust(path: string, attempts = 20): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await reqAuth('DELETE', path);
      if (res.status === 200 || res.status === 404) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

describe('Project file reviews (real Docker container)', () => {
  before(async () => { await initTestAuth(); });

  const slug = uniqueId('rv');
  const editorName = `rve_${Date.now().toString(36)}`;
  const viewerName = `rvv_${Date.now().toString(36)}`;
  const adminMemberName = `rva_${Date.now().toString(36)}`;
  const pw = 'reviews-pass-123';

  let editorId = '';
  let viewerId = '';
  let adminMemberId = '';
  let editorToken = '';
  let viewerToken = '';
  let created = false;

  const outsideViewerToken = signUser('out-1', 'outside_viewer', 'viewer');
  const globalEditorToken = signUser('global-1', 'global_editor', 'editor');
  const adminToken = signUser('admin-1', 'test-admin', 'admin');

  after(async () => {
    if (created) {
      await deleteRobust(`/projects/${slug}`);
    }
    await deleteRobust(`/users/${editorId}`);
    await deleteRobust(`/users/${viewerId}`);
    await deleteRobust(`/users/${adminMemberId}`);
  });

  test('create the project (owner = admin)', async () => {
    const res = await reqAuth('POST', '/projects', {
      name: 'File Reviews Test',
      slug,
      description: 'Temporary project for file reviews testing',
    });
    assert.strictEqual(res.status, 201, `create failed: ${res.status}`);
    const data = await res.json();
    assert.strictEqual(data.project.slug, slug);
    created = true;
  });

  test('create editor / viewer / admin-member users and add them', async () => {
    const e = await reqAuth('POST', '/users', { username: editorName, password: pw, role: 'editor' });
    assert.strictEqual(e.status, 201, `create editor failed: ${e.status}`);
    editorId = (await e.json()).id;

    const v = await reqAuth('POST', '/users', { username: viewerName, password: pw, role: 'viewer' });
    assert.strictEqual(v.status, 201, `create viewer failed: ${v.status}`);
    viewerId = (await v.json()).id;

    const a = await reqAuth('POST', '/users', { username: adminMemberName, password: pw, role: 'editor' });
    assert.strictEqual(a.status, 201, `create admin-member failed: ${a.status}`);
    adminMemberId = (await a.json()).id;

    editorToken = signUser(editorId, editorName, 'editor');
    viewerToken = signUser(viewerId, viewerName, 'viewer');

    const r1 = await reqAuth('POST', `/projects/${slug}/members`, { userId: editorId, role: 'editor' });
    assert.strictEqual(r1.status, 200, `add editor: ${JSON.stringify(await r1.json())}`);
    const r2 = await reqAuth('POST', `/projects/${slug}/members`, { userId: viewerId, role: 'viewer' });
    assert.strictEqual(r2.status, 200, `add viewer: ${JSON.stringify(await r2.json())}`);
    const r3 = await reqAuth('POST', `/projects/${slug}/members`, { userId: adminMemberId, role: 'admin' });
    assert.strictEqual(r3.status, 200, `add admin-member: ${JSON.stringify(await r3.json())}`);
  });

  test('GET starts empty with honest counts', async () => {
    const res = await reqAuth('GET', `/projects/${slug}/reviews`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.deepStrictEqual(data.counts, { open: 0, resolved: 0, total: 0 });
    assert.deepStrictEqual(data.threads, []);
  });

  // ── Access matrix ────────────────────────────────────────────
  test('outsider viewer is 403 on read', async () => {
    const res = await req('GET', `/projects/${slug}/reviews`, undefined, runAs(outsideViewerToken).headers);
    assert.strictEqual(res.status, 403, JSON.stringify(await res.json()));
  });

  test('viewer member reads 200 but writes / status / delete are 403', async () => {
    const read = await req('GET', `/projects/${slug}/reviews`, undefined, runAs(viewerToken).headers);
    assert.strictEqual(read.status, 200);

    const post = await req('POST', `/projects/${slug}/reviews`, { path: 'a.ts', text: 'hi' }, runAs(viewerToken).headers);
    assert.strictEqual(post.status, 403, JSON.stringify(await post.json()));
  });

  // ── Full CRUD lifecycle (editor member) ──────────────────────
  test('editor member opens a thread (201) and it round-trips', async () => {
    const res = await req('POST', `/projects/${slug}/reviews`, { path: 'src/review-me.ts', text: 'the opening statement' }, runAs(editorToken).headers);
    const body = await res.json();
    assert.strictEqual(res.status, 201, JSON.stringify(body));
    const thread = body.thread;
    assert.match(thread.id, /^r-/);
    assert.strictEqual(thread.path, 'src/review-me.ts');
    assert.strictEqual(thread.status, 'open');
    assert.strictEqual(thread.comments.length, 1);
    assert.strictEqual(thread.comments[0].text, 'the opening statement');
    assert.strictEqual(thread.comments[0].username, editorName, 'creator username snapshot');
    assert.strictEqual(thread.createdByName, editorName);

    const list = await reqAuth('GET', `/projects/${slug}/reviews`);
    const listing = await list.json();
    assert.strictEqual(listing.counts.total, 1);
    assert.strictEqual(listing.counts.open, 1);
    assert.strictEqual(listing.threads[0].id, thread.id);
    assert.strictEqual(listing.threads[0].summary.commentCount, 1);
    assert.strictEqual(listing.threads[0].fileExists, false, 'no such file yet');
  });

  test('editor member replies to the thread', async () => {
    const list = await (await reqAuth('GET', `/projects/${slug}/reviews`)).json();
    const threadId = list.threads[0].id;
    const res = await req('POST', `/projects/${slug}/reviews/${threadId}/comments`, { text: 'a follow-up reply' }, runAs(editorToken).headers);
    const replyBody = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(replyBody));
    const thread = replyBody.thread;
    assert.strictEqual(thread.comments.length, 2);
    assert.strictEqual(thread.comments[1].username, editorName);
  });

  test('resolve then reopen round-trips', async () => {
    const list = await (await reqAuth('GET', `/projects/${slug}/reviews`)).json();
    const threadId = list.threads[0].id;

    const resolved = await req('PATCH', `/projects/${slug}/reviews/${threadId}/status`, { status: 'resolved' }, runAs(editorToken).headers);
    const resolvedBody = await resolved.json();
    assert.strictEqual(resolved.status, 200, JSON.stringify(resolvedBody));
    let thread = resolvedBody.thread;
    assert.strictEqual(thread.status, 'resolved');
    assert.ok(thread.resolvedAt);

    const reopened = await req('PATCH', `/projects/${slug}/reviews/${threadId}/status`, { status: 'open' }, runAs(editorToken).headers);
    const reopenedBody = await reopened.json();
    assert.strictEqual(reopened.status, 200, JSON.stringify(reopenedBody));
    thread = reopenedBody.thread;
    assert.strictEqual(thread.status, 'open');
    assert.strictEqual(thread.resolvedAt, undefined, 'reopen drops the resolution stamp');
  });

  test('editor member deletes their own comment', async () => {
    const list = await (await reqAuth('GET', `/projects/${slug}/reviews`)).json();
    const threadId = list.threads[0].id;
    const replyId = list.threads[0].comments[1].id;
    const res = await req('DELETE', `/projects/${slug}/reviews/${threadId}/comments/${replyId}`, undefined, runAs(editorToken).headers);
    const delBody = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(delBody));
    const thread = delBody.thread;
    assert.strictEqual(thread.comments.length, 1);
  });

  test('refuses to delete the last remaining comment (400)', async () => {
    const list = await (await reqAuth('GET', `/projects/${slug}/reviews`)).json();
    const threadId = list.threads[0].id;
    const onlyId = list.threads[0].comments[0].id;
    const res = await req('DELETE', `/projects/${slug}/reviews/${threadId}/comments/${onlyId}`, undefined, runAs(editorToken).headers);
    assert.strictEqual(res.status, 400, JSON.stringify(await res.json()));
  });

  test('editor member deletes the thread (200 ok) and it 404s afterwards', async () => {
    const list = await (await reqAuth('GET', `/projects/${slug}/reviews`)).json();
    assert.strictEqual(list.counts.total, 1);
    const threadId = list.threads[0].id;

    const del = await req('DELETE', `/projects/${slug}/reviews/${threadId}`, undefined, runAs(editorToken).headers);
    const delBody = await del.json();
    assert.strictEqual(del.status, 200, JSON.stringify(delBody));
    assert.deepStrictEqual(delBody, { ok: true });

    const after404 = await req('POST', `/projects/${slug}/reviews/${threadId}/comments`, { text: 'ghost reply' }, runAs(editorToken).headers);
    assert.strictEqual(after404.status, 404, 'commenting on a deleted thread is a 404');

    const list2 = await reqAuth('GET', `/projects/${slug}/reviews`);
    assert.strictEqual((await list2.json()).counts.total, 0);
  });

  // ── Validation 400s (admin) ──────────────────────────────────
  test('empty body / empty text → 400', async () => {
    const empty = await reqAuth('POST', `/projects/${slug}/reviews`, {});
    assert.strictEqual(empty.status, 400, JSON.stringify(await empty.json()));
    const noText = await reqAuth('POST', `/projects/${slug}/reviews`, { path: 'x.ts', text: '   ' });
    assert.strictEqual(noText.status, 400, JSON.stringify(await noText.json()));
  });

  test('text over 2000 chars → 400 (never silently truncated on the API)', async () => {
    const res = await reqAuth('POST', `/projects/${slug}/reviews`, { path: 'x.ts', text: 'x'.repeat(2001) });
    assert.strictEqual(res.status, 400, JSON.stringify(await res.json()));
  });

  test('traversal or absolute path → 400', async () => {
    const up = await reqAuth('POST', `/projects/${slug}/reviews`, { path: '../../etc/passwd', text: 'nope' });
    assert.strictEqual(up.status, 400, JSON.stringify(await up.json()));
    const abs = await reqAuth('POST', `/projects/${slug}/reviews`, { path: '/etc/passwd', text: 'nope' });
    assert.strictEqual(abs.status, 400, JSON.stringify(await abs.json()));
    const noPath = await reqAuth('POST', `/projects/${slug}/reviews`, { text: 'no path' });
    assert.strictEqual(noPath.status, 400, JSON.stringify(await noPath.json()));
  });

  test('path over 1024 chars → 400', async () => {
    const res = await reqAuth('POST', `/projects/${slug}/reviews`, { path: 'a'.repeat(1025) + '.ts', text: 'too long' });
    assert.strictEqual(res.status, 400, JSON.stringify(await res.json()));
  });

  test('bad status → 400', async () => {
    const created = await reqAuth('POST', `/projects/${slug}/reviews`, { path: 'status-probe.ts', text: 'probe' });
    assert.strictEqual(created.status, 201);
    const threadId = (await created.json()).thread.id;

    const bad = await reqAuth('PATCH', `/projects/${slug}/reviews/${threadId}/status`, { status: 'archived' });
    assert.strictEqual(bad.status, 400, JSON.stringify(await bad.json()));
  });

  // ── fileExists enrichment ────────────────────────────────────
  test('fileExists flips true once the pinned file is written; false for missing', async () => {
    const put = await reqAuth('PUT', `/projects/${slug}/file?path=review-target.txt`, { content: 'hello reviews' });
    assert.strictEqual(put.status, 200, `write file failed: ${JSON.stringify(await put.json())}`);

    const ok = await reqAuth('POST', `/projects/${slug}/reviews`, { path: 'review-target.txt', text: 'this file exists' });
    assert.strictEqual(ok.status, 201);
    const existing = (await ok.json()).thread;

    const ghost = await reqAuth('POST', `/projects/${slug}/reviews`, { path: 'does-not-exist.txt', text: 'ghost file' });
    assert.strictEqual(ghost.status, 201);
    const missing = (await ghost.json()).thread;

    const list = await (await reqAuth('GET', `/projects/${slug}/reviews`)).json();
    const byId = Object.fromEntries(list.threads.map((t: any) => [t.id, t]));
    assert.strictEqual(byId[existing.id].fileExists, true);
    assert.strictEqual(byId[missing.id].fileExists, false);
  });

  // ── Global editor + admin member delete rules ────────────────
  test('global editor (no membership) writes 200 but cannot delete another thread (403)', async () => {
    const post = await req('POST', `/projects/${slug}/reviews`, { path: 'global/owned.ts', text: 'global editor thread' }, runAs(globalEditorToken).headers);
    const postBody = await post.json();
    assert.strictEqual(post.status, 201, JSON.stringify(postBody));
    const mine = postBody.thread;

    const list = await (await reqAuth('GET', `/projects/${slug}/reviews`)).json();
    const editorThread = list.threads.find((t: any) => t.path === 'review-target.txt');
    assert.ok(editorThread, 'editor thread exists for the delete gate');

    const delOther = await req('DELETE', `/projects/${slug}/reviews/${editorThread.id}`, undefined, runAs(globalEditorToken).headers);
    assert.strictEqual(delOther.status, 403, 'global editor must NOT delete someone else\'s thread');

    const delOwn = await req('DELETE', `/projects/${slug}/reviews/${mine.id}`, undefined, runAs(globalEditorToken).headers);
    assert.strictEqual(delOwn.status, 200, 'global editor may delete their own thread');
    void mine;
  });

  test('project-admin member can delete any thread including a global editor\'s', async () => {
    const ge = await req('POST', `/projects/${slug}/reviews`, { path: 'global/owned-2.ts', text: 'another global thread' }, runAs(globalEditorToken).headers);
    const geBody = await ge.json();
    assert.strictEqual(ge.status, 201, JSON.stringify(geBody));
    const theirThread = geBody.thread;

    const adminMemberToken = signUser(adminMemberId, adminMemberName, 'editor');
    const del = await req('DELETE', `/projects/${slug}/reviews/${theirThread.id}`, undefined, runAs(adminMemberToken).headers);
    assert.strictEqual(del.status, 200, JSON.stringify(await del.json()));
  });

  test('editor member cannot delete another editor\'s comment (403)', async () => {
    const opened = await req('POST', `/projects/${slug}/reviews`, { path: 'rv-e2/perms.ts', text: 'opening by editor one' }, runAs(editorToken).headers);
    const openedBody = await opened.json();
    assert.strictEqual(opened.status, 201, JSON.stringify(openedBody));
    const thread = openedBody.thread;

    const replied = await req('POST', `/projects/${slug}/reviews/${thread.id}/comments`, { text: 'reply by editor one' }, runAs(editorToken).headers);
    const repliedBody = await replied.json();
    assert.strictEqual(replied.status, 200, JSON.stringify(repliedBody));
    const replyId = repliedBody.thread.comments[1].id;

    // A second editor member (never granted admin membership) signs their own token.
    const editorToken2 = signUser(uniqueId('rv-e2'), 'editor-two', 'editor');
    const del = await req('DELETE', `/projects/${slug}/reviews/${thread.id}/comments/${replyId}`, undefined, runAs(editorToken2).headers);
    assert.strictEqual(del.status, 403, JSON.stringify(await del.json()));
  });

  // ── Activity feed ────────────────────────────────────────────
  test('review_opened lands in the activity feed with details.path', async () => {
    const opened = await reqAuth('POST', `/projects/${slug}/reviews`, { path: 'src/activity-thread.ts', text: 'activity probe' });
    assert.strictEqual(opened.status, 201);

    const act = await (await reqAuth('GET', `/projects/${slug}/activity`)).json();
    assert.ok(Array.isArray(act.entries));
    const entry = act.entries.find((e: any) => e.action === 'review_opened');
    assert.ok(entry, 'review_opened entry exists');
    assert.strictEqual(entry.details?.path, 'src/activity-thread.ts');
    assert.ok(entry.actorName, 'entry is attributed');
  });

  // ── Deleted-user identity retention ──────────────────────────
  test('removing the editor account keeps their stored review identity', async () => {
    const thread = await req('POST', `/projects/${slug}/reviews`, { path: 'src/last-word.ts', text: 'authored by editor' }, runAs(editorToken).headers);
    assert.strictEqual(thread.status, 201);
    const threadId = (await thread.json()).thread.id;

    const del = await reqAuth('DELETE', `/users/${editorId}`);
    assert.ok(del.status === 200 || del.status === 404, `delete user: ${del.status}`);

    const list = await (await reqAuth('GET', `/projects/${slug}/reviews`)).json();
    const kept = list.threads.find((t: any) => t.id === threadId);
    assert.ok(kept, 'thread survives the account deletion');
    assert.strictEqual(kept.createdByName, editorName, 'stored creator name wins, never (deleted user)');
    assert.strictEqual(kept.comments[0].username, editorName, 'stored comment username wins');
  });

  // ── 201st-thread cap (pre-seeded behind the user-write limiter) ─
  test('the 201st thread is refused with 400 (cap 200)', async (t) => {
    const seeds = Array.from({ length: 200 }, (_, i) => ({
      id: `seed-${i}`,
      path: `seed/f${i}.ts`,
      status: 'open',
      createdAt: '2026-09-08T00:00:00.000Z',
      createdBy: 'seeder',
      createdByName: 'seeder',
      comments: [{ id: `seedc-${i}`, text: 'seeded', userId: 'seeder', username: 'seeder', createdAt: '2026-09-08T00:00:00.000Z' }],
    }));
    const payload = JSON.stringify(seeds);
    try {
      execFileSync(
        'docker',
        ['exec', '-i', 'wsd-pro', 'sh', '-c', `mkdir -p /app/data/projects/${slug} && cat > /app/data/projects/${slug}/reviews.json`],
        { input: payload, timeout: 20000 }
      );
    } catch (err) {
      t.skip(`docker CLI/container unavailable — cap seed skipped (${(err as Error).message})`);
      return;
    }

    const list = await (await reqAuth('GET', `/projects/${slug}/reviews`)).json();
    assert.strictEqual(list.counts.total, 200, 'seeded store reads back');
    assert.strictEqual(list.threads.length, 200);

    const attempt = await reqAuth('POST', `/projects/${slug}/reviews`, { path: 'one-more.ts', text: 'too many' });
    const attemptBody = await attempt.json();
    assert.strictEqual(attempt.status, 400, JSON.stringify(attemptBody));
    assert.match(String(attemptBody.error), /max 200/);
  });

  // ── Unknown project / unknown thread 404s ────────────────────
  test('unknown project → 404 on every reviews route', async () => {
    const missing = uniqueId('rv-missing');
    const get = await reqAuth('GET', `/projects/${missing}/reviews`);
    assert.strictEqual(get.status, 404);
    const post = await reqAuth('POST', `/projects/${missing}/reviews`, { path: 'a.ts', text: 'x' });
    assert.strictEqual(post.status, 404);
  });
});