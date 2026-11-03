import { test, describe } from 'node:test';
import assert from 'node:assert';
import { isUserPermissions, sanitizeUserPermissions } from '../src/services/user-permissions-core.ts';

describe('user permission normalization', () => {
  test('defaults missing or malformed permissions to disabled', () => {
    assert.deepStrictEqual(sanitizeUserPermissions(undefined), { projectWrite: false, projectTeam: false });
    assert.deepStrictEqual(sanitizeUserPermissions(null), { projectWrite: false, projectTeam: false });
    assert.deepStrictEqual(sanitizeUserPermissions('true'), { projectWrite: false, projectTeam: false });
  });

  test('only explicit booleans are enabled', () => {
    assert.deepStrictEqual(
      sanitizeUserPermissions({ projectWrite: true, projectTeam: 'true' }),
      { projectWrite: true, projectTeam: false }
    );
  });

  test('API shape requires exactly both boolean permission fields', () => {
    assert.strictEqual(isUserPermissions({ projectWrite: true, projectTeam: false }), true);
    assert.strictEqual(isUserPermissions({ projectWrite: true }), false);
    assert.strictEqual(isUserPermissions({ projectWrite: true, projectTeam: false, admin: true }), false);
    assert.strictEqual(isUserPermissions(null), false);
  });
});
