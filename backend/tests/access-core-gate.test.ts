/**
 * access-core-gate.test.ts
 * Offline regression pin for the F14 removal of the legacy-project 404 guard.
 *
 * F14 removed `if (!meta.ownerId && !meta.members) throw 404` from
 * `POST /api/projects/:slug/members`, so a legacy project (meta with neither
 * `ownerId` nor `members`) can now accept its FIRST member. With the route
 * guard gone, the admin-only guarantee rests ENTIRELY on `decideProjectAccess`'s
 * legacy fallback cap in `access-core.ts`:
 *
 *     return { allowed: minRole !== 'admin', memberRole: 'editor' };   // ~line 69
 *
 * The legacy fallback answers for EVERY authenticated user at EDITOR level
 * (compat contract), but an `minRole: 'admin'` route (add member / manage team /
 * transfer owner / delete) must stay closed to anyone who is not a system
 * administrator.
 *
 * Why a dedicated file: `ws-gate.test.ts` exercises the legacy fallback only at
 * viewer/editor level (lines ~66-70) — a regression that dropped the cap would
 * still answer `allowed: true` there and the suite would stay green. This file
 * pins the cap itself, so returning `{ allowed: true }` for the admin gate fails.
 *
 * Pure-core module test — runs fully offline (no Docker, no HTTP, no fs).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { decideProjectAccess, type AccessRole } from '../src/services/access-core.ts';

// Stable fake user ids (the gate trusts the id it receives from the verified JWT).
const SYS_ADMIN = 'sys-admin';
const GLOBAL_EDITOR = 'global-editor';
const VIEWER = 'viewer';

interface LegacyShape {
  label: string;
  meta: { ownerId?: string; members?: any[] } | null;
  state?: 'ok' | 'absent' | 'corrupt';
}

// Every shape that legally means "legacy, membership-free" to the fallback at
// access-core.ts:68 — including the exact F14 state (meta exists on disk but
// carries neither ownerId nor members), which defaults to metaState 'ok'.
const LEGACY_SHAPES: LegacyShape[] = [
  { label: 'null meta (default absent state)', meta: null },
  { label: 'null meta (explicit absent state)', meta: null, state: 'absent' },
  { label: 'empty meta object (the F14 legacy shape)', meta: {} },
  { label: 'meta with only an empty members array', meta: { members: [] } },
  { label: 'meta with a non-membership key only', meta: { name: 'legacy' } },
];

/** Call the gate, forwarding the explicit metaState only when a shape sets one. */
function gate(
  userId: string,
  userRole: AccessRole,
  shape: LegacyShape,
  minRole: AccessRole
): { allowed: boolean; memberRole?: AccessRole } {
  return shape.state
    ? decideProjectAccess(userId, userRole, shape.meta, minRole, shape.state)
    : decideProjectAccess(userId, userRole, shape.meta, minRole);
}

describe('decideProjectAccess — legacy-project admin gate (the F14 cap)', () => {
  test('system admin is allowed through the admin gate on every legacy shape', () => {
    for (const shape of LEGACY_SHAPES) {
      const res = gate(SYS_ADMIN, 'admin', shape, 'admin');
      assert.strictEqual(res.allowed, true, `system admin must pass on ${shape.label}`);
    }
  });

  test('global editor (system role editor) is REFUSED the admin gate on every legacy shape', () => {
    // The regression this file exists for: without the `minRole !== 'admin'` cap
    // the fallback returns allowed:true here, opening add-member/team-management
    // to every global editor on a legacy project.
    for (const shape of LEGACY_SHAPES) {
      const res = gate(GLOBAL_EDITOR, 'editor', shape, 'admin');
      assert.strictEqual(
        res.allowed,
        false,
        `global editor must NOT reach the admin gate on ${shape.label}`
      );
    }
  });

  test('system viewer is REFUSED the admin gate on every legacy shape', () => {
    for (const shape of LEGACY_SHAPES) {
      const res = gate(VIEWER, 'viewer', shape, 'admin');
      assert.strictEqual(
        res.allowed,
        false,
        `viewer must NOT reach the admin gate on ${shape.label}`
      );
    }
  });

  test('contrast: the same legacy fallback stays open at editor/viewer level', () => {
    // The cap only blocks the admin gate — it must not over-tighten the compat
    // contract that keeps legacy projects open to all authenticated users.
    for (const shape of LEGACY_SHAPES) {
      assert.strictEqual(
        gate(GLOBAL_EDITOR, 'editor', shape, 'editor').allowed,
        true,
        `global editor keeps editor-level access on ${shape.label}`
      );
      assert.strictEqual(
        gate(VIEWER, 'viewer', shape, 'editor').allowed,
        true,
        `viewer keeps editor-level access on ${shape.label}`
      );
      assert.strictEqual(
        gate(VIEWER, 'viewer', shape, 'viewer').allowed,
        true,
        `viewer keeps viewer-level access on ${shape.label}`
      );
    }
  });

  test('contrast: corrupt meta is NOT legacy and never opens the admin gate to non-admins', () => {
    // The fallback is gated on `metaState !== 'corrupt'`; a corrupt store must
    // not be laundered into the legacy open-anything branch. System admin still
    // short-circuits (rule 1), so this pins the non-admin side.
    const corrupt: LegacyShape = { label: 'corrupt store', meta: {}, state: 'corrupt' };
    assert.strictEqual(gate(SYS_ADMIN, 'admin', corrupt, 'admin').allowed, true);
    assert.strictEqual(gate(GLOBAL_EDITOR, 'editor', corrupt, 'admin').allowed, false);
    assert.strictEqual(gate(VIEWER, 'viewer', corrupt, 'editor').allowed, false);
    assert.strictEqual(gate(VIEWER, 'viewer', corrupt, 'admin').allowed, false);
  });
});
