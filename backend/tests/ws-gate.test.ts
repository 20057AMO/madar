/**
 * Unit tests for the project-access decision core (access-core.ts).
 *
 * This pure function is the single decision point shared by the REST
 * middleware (requireProjectAccess) and the WebSocket gate (ws-server):
 * without the WS gate, any authenticated user (even a viewer) could open a
 * terminal or logs socket for a project they are not a member of. These tests
 * pin the decision table so the gate cannot silently regress.
 *
 * Pure-core module test — runs fully offline (no Docker, no HTTP, no fs).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { decideProjectAccess, decideControlAccess } from '../src/services/access-core.ts';

// Stable fake user ids (the gate trusts the id it receives from the verified JWT).
const ADMIN = 'admin-1';
const EDITOR = 'editor-1';
const VIEWER = 'viewer-1';
const OUTSIDER = 'outsider-1';

// A project with membership data: admin owns it, editor and viewer are members.
const meta = {
  ownerId: ADMIN,
  members: [
    { userId: EDITOR, role: 'editor' as const, addedAt: '2026-01-01T00:00:00Z' },
    { userId: VIEWER, role: 'viewer' as const, addedAt: '2026-01-01T00:00:00Z' },
  ],
};

describe('decideProjectAccess — the WS/REST shared decision table', () => {
  test('system admin passes at every minRole', () => {
    assert.strictEqual(decideProjectAccess(ADMIN, 'admin', meta, 'viewer').allowed, true);
    assert.strictEqual(decideProjectAccess(ADMIN, 'admin', meta, 'editor').allowed, true);
    assert.strictEqual(decideProjectAccess(ADMIN, 'admin', meta, 'admin').allowed, true);
  });

  test('project editor passes viewer/editor gates but not the admin gate', () => {
    assert.strictEqual(decideProjectAccess(EDITOR, 'viewer', meta, 'viewer').allowed, true);
    assert.strictEqual(decideProjectAccess(EDITOR, 'viewer', meta, 'editor').allowed, true);
    assert.strictEqual(decideProjectAccess(EDITOR, 'viewer', meta, 'admin').allowed, false);
  });

  test('project viewer is rejected at editor gate (terminal) and admin gate (control)', () => {
    assert.strictEqual(decideProjectAccess(VIEWER, 'viewer', meta, 'viewer').allowed, true);
    assert.strictEqual(decideProjectAccess(VIEWER, 'viewer', meta, 'editor').allowed, false, 'viewer must not open a project terminal');
    assert.strictEqual(decideProjectAccess(VIEWER, 'viewer', meta, 'admin').allowed, false, 'viewer must not open a control shell');
  });

  test('non-members are rejected even with elevated system roles', () => {
    assert.strictEqual(decideProjectAccess(OUTSIDER, 'viewer', meta, 'viewer').allowed, false);
    assert.strictEqual(decideProjectAccess(OUTSIDER, 'editor', meta, 'admin').allowed, false, 'system editor must not get admin-level control shell');
  });

  test('owner is project-admin even as system viewer', () => {
    assert.strictEqual(decideProjectAccess(ADMIN, 'viewer', meta, 'admin').allowed, true);
  });

  test('terminal mode mapping floor: project → editor, control → admin', () => {
    // Mirrors the ws-server.ts mapping; if the mode→minRole mapping ever
    // loosens, this pins the floor.
    assert.strictEqual(decideProjectAccess(VIEWER, 'viewer', meta, 'editor').allowed, false);
    assert.strictEqual(decideProjectAccess(EDITOR, 'viewer', meta, 'admin').allowed, false, 'only admin may open a control shell');
  });

  test('legacy projects without membership stay open (compat contract)', () => {
    assert.strictEqual(decideProjectAccess(OUTSIDER, 'viewer', null, 'viewer').allowed, true);
    assert.strictEqual(decideProjectAccess(OUTSIDER, 'viewer', {}, 'editor').allowed, true);
    assert.strictEqual(decideProjectAccess(OUTSIDER, 'viewer', { members: [] }, 'editor').allowed, true);
  });

  test('control shell on legacy projects: strict — real admins only', () => {
    // The legacy open-projects bypass must never hand out a HOST shell.
    assert.strictEqual(decideControlAccess(OUTSIDER, 'viewer', {}).allowed, false);
    assert.strictEqual(decideControlAccess(OUTSIDER, 'editor', {}).allowed, false);
    assert.strictEqual(decideControlAccess(OUTSIDER, 'admin', {}).allowed, true);
    assert.strictEqual(decideControlAccess(OUTSIDER, 'admin', null).allowed, true);
    // With membership data, owner/admin-member passes, others fail.
    assert.strictEqual(decideControlAccess(ADMIN, 'viewer', meta).allowed, true);
    assert.strictEqual(decideControlAccess(EDITOR, 'viewer', meta).allowed, false);
    assert.strictEqual(decideControlAccess(OUTSIDER, 'admin', meta).allowed, true, 'system admin still passes on managed projects');
  });
});
