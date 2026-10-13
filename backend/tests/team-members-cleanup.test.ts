/**
 * team-members-cleanup.test.ts
 * Three backend fixes on the team/membership surface, live against the container:
 *
 *  F5 — deleting a user must remove their row from EVERY project's
 *       `meta.members`. The row used to survive as an orphan and the member
 *       list rendered it as `username: 'unknown'` forever (the feed keeps the
 *       history by design; the membership list is governance, not history).
 *
 *  F13 — `user-deleted` (and `user-role-changed`) must be audited WITH the
 *       `details` bag, so the security log names the target username/role
 *       instead of only the id. Covered two ways: the delete entry for the
 *       real throwaway above, and a full role-change roundtrip driven by a
 *       throwaway ADMIN whose own password satisfies the sudo gate — so this
 *       runs on every execution with no env secret and no mutation of the
 *       real account.
 *
 *  F14 — `POST /api/projects/:slug/members` used to answer a misleading 404
 *       ("Project not found") for a legacy project whose meta carries neither
 *       `ownerId` nor `members`, even though the project exists. That guard
 *       rejected the FIRST member write, so a legacy project could never grow
 *       a membership at all. It must answer 200 and land the row.
 *
 * Style mirrors team-page.test.ts / project-activity.test.ts: forged JWT via
 * helpers, real throwaway users, self-cleaning after(), and docker-cli meta
 * surgery with an honest t.skip when the CLI is unavailable.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  uniqueId, reqAuth, req, initTestAuth, testUserId,
  liveUser, cleanupLiveUsers, LIVE_USER_PASSWORD,
} from './helpers.ts';

const CONTAINER = process.env.WSD_TEST_CONTAINER || 'wsd-pro';

describe('Team member lifecycle: user-delete cleanup + legacy first member (F5 / F14)', () => {
  before(async () => { await initTestAuth(); });

  const f5Slug = uniqueId('f5clean');
  const f5LegacySlug = uniqueId('f5legacy');
  const f14Slug = uniqueId('f14legacy');
  const tempName = `f5_${Date.now().toString(36)}`;
  const tempPw = 'f5-cleanup-pass-123';

  let tempId = '';
  let deletedId = '';
  let tempDeleted = false;
  let f5Created = false;
  let f5LegacyCreated = false;
  let f14Created = false;

  const metaPath = (slug: string) => `/app/data/projects/${slug}/meta.json`;

  /** Run a command inside the server container (best-effort: caller skips on failure). */
  function dockerExec(cmd: string, ...args: string[]): string {
    return execFileSync('docker', ['exec', CONTAINER, cmd, ...args], { timeout: 15000, encoding: 'utf8' });
  }

  function readMeta(slug: string): Record<string, any> {
    return JSON.parse(dockerExec('cat', metaPath(slug)));
  }

  function writeMeta(slug: string, meta: Record<string, any>): void {
    const tmp = path.join(os.tmpdir(), `meta-${slug}-${process.pid}.json`);
    fs.writeFileSync(tmp, JSON.stringify(meta));
    try {
      execFileSync('docker', ['cp', tmp, `${CONTAINER}:${metaPath(slug)}`], { timeout: 15000 });
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  /** POST /users sits behind the admin user-provisioning limiter (20/min in
   *  production), so back off on 429 rather than reporting a limit as a failure. */
  async function createUserWithBackoff(username: string, password: string, role: string) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const res = await reqAuth('POST', '/users', { username, password, role });
      if (res.status !== 429) return res;
      const secs = Math.max(1, parseInt(String(res.headers.get('Retry-After') || '5'), 10));
      await new Promise((r) => setTimeout(r, secs * 1000 + 250));
    }
    throw new Error('user creation kept returning 429');
  }

  async function membersOf(slug: string): Promise<any[]> {
    const res = await reqAuth('GET', `/projects/${slug}/members`);
    assert.strictEqual(res.status, 200, `members list: ${res.status}`);
    const body = await res.json();
    assert.ok(Array.isArray(body.members), 'members is an array');
    return body.members;
  }

  after(async () => {
    if (f14Created) await reqAuth('DELETE', `/projects/${f14Slug}`).catch(() => {});
    if (f5Created) await reqAuth('DELETE', `/projects/${f5Slug}`).catch(() => {});
    if (f5LegacyCreated) await reqAuth('DELETE', `/projects/${f5LegacySlug}`).catch(() => {});
    if (tempId && !tempDeleted) await reqAuth('DELETE', `/users/${tempId}`).catch(() => {});
    await cleanupLiveUsers().catch(() => {});
  });

  test('F5: deleting a user drops their row from the project member list', async (t) => {
    const prj = await reqAuth('POST', '/projects', { name: 'F5 Member Cleanup', slug: f5Slug, description: 'temp' });
    if (prj.status !== 201) {
      t.skip(`project creation failed (${prj.status}) — F5 cleanup roundtrip not run`);
      return;
    }
    f5Created = true;

    const created = await createUserWithBackoff(tempName, tempPw, 'editor');
    if (created.status !== 201) {
      t.skip(`throwaway user creation failed (${created.status}) — F5 cleanup roundtrip not run`);
      return;
    }
    tempId = (await created.json()).id;
    assert.ok(tempId, 'throwaway user id resolved');

    // F5 guard, planted BEFORE the delete below so it is swept by the very same
    // cleanup: a LEGACY probe project (no `ownerId`, no `members` key) that does
    // NOT carry a row for the throwaway user. The cleanup must skip it entirely.
    // The decisive witness is the `members` key's ABSENCE after the delete: the
    // pre-fix unconditional `updateMeta` -> `writableMemberList` injected
    // `members: []` into such a store, which silently DISABLES the legacy
    // no-membership access fallback (`access-core.ts`). A key-absence check is
    // robust against the unrelated crash-watch sweep (`setCrashWatch` rewrites
    // meta but never adds `members`), so it cannot flake.
    let probeLegacyOk = false;
    try {
      const probe = await reqAuth('POST', '/projects', { name: 'F5 Legacy Probe', slug: f5LegacySlug, description: 'temp' });
      if (probe.status !== 201) {
        // Rate-limited or otherwise unavailable — skip only the probe, not the F5 roundtrip.
      } else {
        f5LegacyCreated = true;
        const probeMeta = readMeta(f5LegacySlug);
        assert.ok('ownerId' in probeMeta, 'probe meta starts with ownerId (precondition)');
        assert.ok(Array.isArray(probeMeta.members), 'probe meta starts with a members array (precondition)');
        delete probeMeta.ownerId;
        delete probeMeta.members;
        writeMeta(f5LegacySlug, probeMeta);
        const legacyOnDisk = readMeta(f5LegacySlug);
        assert.ok(!('ownerId' in legacyOnDisk), 'probe is legacy-shaped on disk (no ownerId)');
        assert.ok(!('members' in legacyOnDisk), 'probe is legacy-shaped on disk (no members key)');
        probeLegacyOk = true;
      }
    } catch (err) {
      // An assertion failure is a REAL failure — never swallow it (that would
      // make every probe check vacuous). Only a docker CLI/container failure
      // (not an AssertionError) degrades to "probe unavailable, skip".
      if (err instanceof assert.AssertionError) throw err;
    }

    const added = await reqAuth('POST', `/projects/${f5Slug}/members`, { userId: tempId, role: 'editor' });
    assert.strictEqual(added.status, 200, `add member: ${added.status}`);

    // Sanity: the row is really there BEFORE the delete (so its absence after
    // cannot be explained by the add having never happened).
    const before = await membersOf(f5Slug);
    assert.ok(
      before.some((m) => m.userId === tempId && m.username === tempName),
      'throwaway row present before the delete'
    );

    const del = await reqAuth('DELETE', `/users/${tempId}`);
    assert.strictEqual(del.status, 200, `delete user: ${del.status} ${JSON.stringify(await del.json().catch(() => null))}`);
    deletedId = tempId;
    tempDeleted = true;

    const afterMembers = await membersOf(f5Slug);
    assert.ok(
      !afterMembers.some((m) => m.userId === deletedId),
      `deleted user's membership row must be gone (rows: ${JSON.stringify(afterMembers.map((m) => m.userId))})`
    );
    // Without F5 the orphan survives and the enrichment answers 'unknown'.
    assert.ok(
      !afterMembers.some((m) => m.username === 'unknown'),
      'no orphaned membership renders as the "unknown" fallback'
    );
    // Control: the creator's own admin row survives the sweep — the list is
    // not empty for some unrelated reason.
    const adminId = testUserId();
    assert.ok(adminId, 'adopted test identity is known');
    assert.ok(
      afterMembers.some((m) => m.userId === adminId),
      'the project owner/admin row is untouched by the cleanup'
    );

    // F5 guard: the legacy probe (no row for the deleted user) must NOT have
    // been rewritten into a membership-bearing store. `members: []` injected
    // here is the exact pre-fix regression: it turns a legacy project into a
    // "zero members" project, closing the open-access fallback.
    if (probeLegacyOk) {
      const probeAfter = readMeta(f5LegacySlug);
      assert.ok(
        !('members' in probeAfter),
        `cleanup must not inject a members key into a row-less legacy store (got: ${JSON.stringify(probeAfter.members)})`
      );
      assert.ok(
        !('ownerId' in probeAfter),
        'cleanup must not inject an ownerId into a row-less legacy store'
      );
      t.diagnostic('F5 legacy probe verified: cleanup injected neither members nor ownerId');
    }
  });

  test('F5/F13: the user-deleted audit entry carries details.username for THIS delete', async () => {
    assert.ok(tempDeleted, 'preceding test deleted the throwaway user');
    assert.ok(deletedId, 'the deleted user id is known');

    const res = await reqAuth('GET', '/auth/audit?limit=100');
    assert.strictEqual(res.status, 200);
    const entries: any[] = (await res.json()).entries || [];
    const mine = entries.filter((e) => e.event === 'user-deleted' && e.userId === deletedId);
    assert.ok(mine.length > 0, 'a user-deleted audit entry exists for the throwaway account');

    // Every entry for THIS delete must carry the details bag (F13) — matching
    // on the username value, not merely on the event name, so a pre-fix entry
    // from an earlier run can never satisfy the assertion.
    const named = mine.filter((e) => e.details?.username === tempName);
    assert.ok(
      named.length > 0,
      `user-deleted carries details.username === '${tempName}' (got: ${JSON.stringify(mine.map((e) => e.details))})`
    );
    for (const e of mine) {
      assert.strictEqual(typeof e.details?.username, 'string', 'details.username is a string');
      assert.ok(String(e.details?.username).length > 0, 'details.username is non-empty');
    }
  });

  test('F13: a successful role change is audited with details.role and details.username', async (t) => {
    // The sudo gate verifies the ACTING admin's own password, so a throwaway
    // admin created by liveUser() (password known to the suite) can pass it:
    // no env secret, no real-login dependency, no mutation of the real account.
    let sudo: Awaited<ReturnType<typeof liveUser>>;
    let target: Awaited<ReturnType<typeof liveUser>>;
    try {
      sudo = await liveUser('admin', 'f13sudo');
      target = await liveUser('viewer', 'f13target');
    } catch (err) {
      t.skip(`throwaway admin creation failed — role-change audit roundtrip not run (${(err as Error).message})`);
      return;
    }
    const headers = { Authorization: `Bearer ${sudo.token}` };

    const t0 = new Date().toISOString();
    const patch = await req('PATCH', `/users/${target.id}/role`, { role: 'editor', accountPassword: LIVE_USER_PASSWORD }, headers);
    const patchBody = await patch.json().catch(() => null);
    assert.strictEqual(
      patch.status, 200,
      `role change with the acting admin's own password must succeed: ${patch.status} ${JSON.stringify(patchBody)}`
    );

    const audit = await req('GET', '/auth/audit?limit=100', undefined, headers);
    assert.strictEqual(audit.status, 200, 'the acting admin can read the security log');
    const entries: any[] = (await audit.json()).entries || [];

    // Scoped to THIS change: fresh target id (cannot appear in an older entry)
    // plus a t0 captured before the write, so a pre-existing entry can never
    // satisfy the assertion.
    const mine = entries.filter((e) => e.event === 'user-role-changed' && e.userId === target.id && e.ts >= t0);
    assert.ok(
      mine.length > 0,
      `a user-role-changed entry was recorded for this change (events seen: ${JSON.stringify(entries.slice(0, 8).map((e) => `${e.event}:${e.userId}`))})`
    );
    assert.ok(
      mine.some((e) => e.details?.role === 'editor'),
      `user-role-changed carries details.role === 'editor' (got: ${JSON.stringify(mine.map((e) => e.details))})`
    );
    assert.ok(
      mine.every((e) => e.details?.username === target.username),
      `every entry names the target username '${target.username}' (got: ${JSON.stringify(mine.map((e) => e.details?.username))})`
    );

    // The write really landed (an audit entry without a persisted role would
    // be theatre).
    const roster = await (await req('GET', '/users/with-memberships', undefined, headers)).json();
    const row = (roster.users as any[]).find((u) => u.id === target.id);
    assert.strictEqual(row?.role, 'editor', 'role persisted after the sudo-gated change');
  });

  test('F14: POST /members on a legacy project (no ownerId, no members) answers 200, not 404', async (t) => {
    const prj = await reqAuth('POST', '/projects', { name: 'F14 Legacy Project', slug: f14Slug, description: 'temp' });
    if (prj.status !== 201) {
      t.skip(`project creation failed (${prj.status}) — F14 legacy roundtrip not run`);
      return;
    }
    f14Created = true;

    let stripped: Record<string, any>;
    try {
      stripped = readMeta(f14Slug);
    } catch (err) {
      t.skip(`docker CLI/container unavailable — legacy first-member roundtrip not run (${(err as Error).message})`);
      return;
    }
    assert.ok('ownerId' in stripped, 'fresh meta carries ownerId (precondition for the surgery)');
    assert.ok(Array.isArray(stripped.members), 'fresh meta carries a members array (precondition)');

    delete stripped.ownerId;
    delete stripped.members;
    try {
      writeMeta(f14Slug, stripped);
    } catch (err) {
      t.skip(`docker CLI/container unavailable — legacy first-member roundtrip not run (${(err as Error).message})`);
      return;
    }

    // Prove the request is issued against a document that satisfies EXACTLY the
    // condition the removed guard tested (`!meta.ownerId && !meta.members`).
    const legacy = readMeta(f14Slug);
    assert.ok(!('ownerId' in legacy), 'ownerId stripped on disk');
    assert.ok(!('members' in legacy), 'members key absent on disk');

    // And the same legacy shape is what the API serves (the project exists —
    // this is the state that used to produce the misleading "Project not found").
    const list = await reqAuth('GET', `/projects/${f14Slug}/members`);
    assert.strictEqual(list.status, 200, 'legacy project is readable');
    assert.deepStrictEqual((await list.json()).members, [], 'legacy project starts with no members');

    const adminId = testUserId();
    assert.ok(adminId, 'adopted test identity is known');

    const res = await reqAuth('POST', `/projects/${f14Slug}/members`, { userId: adminId, role: 'editor' });
    const body = await res.json().catch(() => null);
    assert.strictEqual(
      res.status, 200,
      `legacy first member must be accepted: ${res.status} ${JSON.stringify(body)}`
    );
    assert.strictEqual(body?.member?.userId, adminId);
    assert.strictEqual(body?.member?.role, 'editor');

    // Non-vacuity: the document we mutated was still legacy-shaped at write
    // time — ownerId is not restored by the handler, so a 200 that came from
    // the pre-fix guard is impossible.
    const afterMeta = readMeta(f14Slug);
    assert.ok(!('ownerId' in afterMeta), 'ownerId still absent after the write');
    assert.ok(
      Array.isArray(afterMeta.members) && afterMeta.members.some((m) => m.userId === adminId),
      'the first member row landed in meta.members'
    );

    const readBack = await membersOf(f14Slug);
    assert.ok(readBack.some((m) => m.userId === adminId && m.role === 'editor'), 'row visible through the API');
  });
});
