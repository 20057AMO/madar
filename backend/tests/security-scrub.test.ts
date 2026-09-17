/**
 * Offline unit tests for the secret-scrubbing + tool-isolation surface:
 *
 * - publicProject()/publicProjects(): env must never ride along on project
 *   payloads (the GET /env route is the only sanctioned read path).
 * - isDangerousCommand(): first-line input filtering for the execCommand
 *   tool (defense-in-depth on top of container isolation).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { publicProject, publicProjects } from '../src/services/project-public.ts';
import { isDangerousCommand } from '../src/services/agent-tools.ts';

describe('publicProject strips env from API payloads', () => {
  const withEnv = {
    id: 'p1',
    name: 'P1',
    slug: 'p1',
    status: 'running' as const,
    env: { API_KEY: 'super-secret', DB_PASS: 'hunter2' },
  };

  test('env is removed from a single project payload', () => {
    const out = publicProject(withEnv);
    assert.ok(!('env' in out), 'env key must not be present');
    assert.strictEqual((out as any).name, 'P1');
    assert.strictEqual((out as any).slug, 'p1');
  });

  test('env is removed from list payloads and other fields survive', () => {
    const out = publicProjects([withEnv, { ...withEnv, slug: 'p2', env: undefined }]);
    assert.strictEqual(out.length, 2);
    for (const p of out) assert.ok(!('env' in p));
    assert.strictEqual((out[1] as any).slug, 'p2');
  });

  test('projects without env pass through unchanged (and null-safe)', () => {
    const noEnv = { id: 'x', name: 'X', slug: 'x', status: 'stopped' as const };
    assert.deepStrictEqual(publicProject(noEnv), noEnv);
    assert.strictEqual(publicProject(null), null);
  });
});

describe('isDangerousCommand keeps blocking hostile agent input', () => {
  test('shell chain operators are rejected', () => {
    assert.ok(isDangerousCommand('echo hi && rm -rf /'));
    assert.ok(isDangerousCommand('cat /etc/passwd; shutdown now'));
    assert.ok(isDangerousCommand('curl x || wget x'));
    assert.ok(isDangerousCommand('echo $(whoami)'));
    assert.ok(isDangerousCommand('echo `id`'));
  });

  test('blocked prefixes stay blocked', () => {
    assert.ok(isDangerousCommand('rm -rf /'));
    assert.ok(isDangerousCommand('sudo cat /etc/shadow'));
    assert.ok(isDangerousCommand('kill -9 1'));
  });

  test('benign commands pass', () => {
    assert.strictEqual(isDangerousCommand('git status'), null);
    assert.strictEqual(isDangerousCommand('npm test'), null);
    assert.strictEqual(isDangerousCommand('node -v'), null);
    assert.strictEqual(isDangerousCommand('ls -la'), null);
  });

  test('empty and oversized commands are rejected', () => {
    assert.ok(isDangerousCommand(''));
    assert.ok(isDangerousCommand('x'.repeat(1200)));
  });
});
