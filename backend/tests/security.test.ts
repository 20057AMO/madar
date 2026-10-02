import { test, describe, before } from 'node:test';
import assert from 'node:assert';
import { uniqueId, reqAuth, signTestToken, API_URL, firstProjectSlug, initTestAuth } from './helpers.ts';

describe('Security hardening', () => {
  before(async () => { await initTestAuth(); });

  const slug = uniqueId('sec');

  test('file read rejects path traversal', async () => {
    const res = await reqAuth('GET', `/projects/${slug}/file?path=${encodeURIComponent('../../etc/passwd')}`);
    assert.ok(res.status >= 400, `expected rejection, got ${res.status}`);
  });

  test('files listing rejects traversal paths', async () => {
    const res = await reqAuth('GET', `/projects/${slug}/files?path=${encodeURIComponent('../')}`);
    if (res.status === 200) {
      const data = await res.json();
      const text = JSON.stringify(data);
      assert.ok(!text.includes('../'), 'listing must not leak parent paths');
    } else {
      assert.ok(res.status >= 400 && res.status < 500, `unexpected ${res.status}`);
    }
  });

  test('traversal upload path is sanitized, never escapes workspace', async () => {
    const target = await firstProjectSlug();
    if (!target) return; // nothing to probe against

    const form = new FormData();
    form.append('paths', JSON.stringify({ 'evil.txt': '../../escaped-by-upload.txt' }));
    form.append('files', new Blob([new Uint8Array([1, 2, 3])]), 'evil.txt');
    const res = await fetch(`${API_URL}/projects/${target}/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${signTestToken()}` },
      body: form,
    });

    if (res.status === 201) {
      const data = await res.json();
      for (const f of data.files || []) {
        assert.ok(!f.path.includes('..'), `uploaded path escaped workspace: ${f.path}`);
        // cleanup whatever landed
        await reqAuth('DELETE', `/projects/${target}/file?path=${encodeURIComponent(f.path)}`);
      }
    } else {
      assert.ok(res.status >= 400 && res.status < 500, `unexpected ${res.status}`);
    }
  });

  test('unknown API route returns 404', async () => {
    const res = await reqAuth('GET', '/definitely-not-a-real-route');
    assert.strictEqual(res.status, 404);
  });

  test('malformed Authorization header is rejected', async () => {
    for (const value of ['', 'Bearer', 'Bearer ', 'Basic dXNlcjpwYXNz', 'Bearer a.b.c']) {
      const res = await fetch(`${API_URL}/projects`, {
        headers: value ? { Authorization: value } : {},
      });
      assert.strictEqual(res.status, 401, `expected 401 for "${value}", got ${res.status}`);
    }
  });

  test('traversal-shaped SLUGS are rejected at the boundary, never resolved to a path', async () => {
// The regression pair: rel="etc/passwd" is clean and the parameterized
    // `:slug` would happily capture '..', '../..', 'a/b' - the old sanitizers
    // only cleaned the RELATIVE part, so `resolveWorkspacePath('..','etc/passwd')`
    // escaped /workspaces and `deleteMeta('..')` rm -rf'd the whole data dir.
    // The invariant asserted here is rejection - never 200, never a path
    // resolved outside the workspace - and the EXACT status per shape, because a
    // loose 4xx bound is what let the slug filter keep stripping separators
    // (`a%2Fb` → 'ab', `..%2F..%2Fetc` → '....etc') and looking up a made-up
    // project instead of refusing the value. Each shape is asserted against what
    // actually answers, which is deliberately NOT uniform:
    //   - `%2E%2E` → the HTTP client normalizes the dot segment away before the
    //     request leaves, so the server never sees a route for it at all (404).
    //   - a decoded separator (`%2F`) reaching the gate → 400 "Project slug is
    //     invalid", refused BEFORE any workspace lookup.
    //   - a bare `%2E` decodes to `/projects/./file`, which Express resolves to
    //     the PROJECT route with slug "file" — a different resource, so it is
    //     the honest 404 "Project not found", never a slug rejection.
    const token = `Bearer ${signTestToken()}`;
    const paths: Array<[string, number]> = [
      ['/projects/%2E%2E/file?path=etc/passwd', 404],
      ['/projects/%2E%2E%2F%2E%2E%2Fetc%2Fpasswd/file?path=x', 400],
      ['/projects/a%2Fb/file?path=x', 400],
      ['/projects/%2E/file?path=x', 404],
    ];
    for (const [p, expected] of paths) {
      const res = await fetch(`${API_URL}${p}`, { headers: { Authorization: token } });
      assert.strictEqual(res.status, expected, `${p} must be ${expected}, got ${res.status}`);
      const body = await res.text();
      assert.ok(!body.includes('/etc/') && !body.includes('..\\'), `${p} must not leak a resolved path`);
    }
  });

});

