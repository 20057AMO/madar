import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import { uniqueId, reqAuth, req, initTestAuth } from './helpers.ts';

describe('Madar API Smoke Tests', () => {
  before(async () => { await initTestAuth(); });

  const testProjectSlug = uniqueId('smoke-test');

  test('GET /health - should return status ok', async () => {
    const res = await req('GET', '/health');
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.status, 'ok');
  });

  test('CORS is opt-in - no wildcard ACAO header leaks to any origin', async () => {
    const res = await req('GET', '/health');
    assert.strictEqual(res.headers.get('access-control-allow-origin'), null, 'wildcard CORS must be off by default');
  });

  test('GET /projects - should list projects', async () => {
    const res = await reqAuth('GET', '/projects');
    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
    const data = await res.json();
    assert.ok(Array.isArray(data.projects), 'Expected projects array');
  });

  test('GET /chat/info - should return the chat model', async () => {
    const res = await reqAuth('GET', '/chat/info');
    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
    const data = await res.json();
    assert.strictEqual(typeof data.model, 'string');
  });

  test('GET /ide/status - should report the unified IDE', async () => {
    const res = await reqAuth('GET', '/ide/status');
    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
    const data = await res.json();
    assert.strictEqual(typeof data.ide.running, 'boolean');
    assert.strictEqual(typeof data.ide.port, 'number');
    assert.strictEqual('password' in data.ide, false, 'code-server runs with --auth none — no IDE password exists');
  });

  test('GET /opencode/status - should report the opencode web UI', async () => {
    const res = await reqAuth('GET', '/opencode/status');
    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
    const data = await res.json();
    assert.strictEqual(typeof data.running, 'boolean');
    assert.strictEqual(typeof data.port, 'number');
  });

  test('POST /projects - should create a new test project', async () => {
    const res = await reqAuth('POST', '/projects', {
      name: 'Smoke Test Project',
      slug: testProjectSlug,
      description: 'Temporary project for smoke testing',
    });
    assert.strictEqual(res.status, 201, `Failed to create project: ${res.status}`);
    const data = await res.json();
    assert.strictEqual(data.project.slug, testProjectSlug);
    assert.strictEqual(data.project.status, 'running');
  });

  test('GET /projects/:slug - should fetch the created project', async () => {
    const res = await reqAuth('GET', `/projects/${testProjectSlug}`);
    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
    const data = await res.json();
    assert.strictEqual(data.project.slug, testProjectSlug);
  });

  test('DELETE /projects/:slug - should clean up the test project', async () => {
    const res = await reqAuth('DELETE', `/projects/${testProjectSlug}`);
    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
    const data = await res.json();
    assert.strictEqual(data.ok, true);
  });

});
