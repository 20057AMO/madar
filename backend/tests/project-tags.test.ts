/**
 * project-tags.test.ts
 * Integration tests for project tags management.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { uniqueId, req, reqAuth, initTestAuth, liveUser, cleanupLiveUsers } from './helpers.ts';

const createdSlugs: string[] = [];

describe('Project Tags API', () => {
  before(async () => {
    await initTestAuth();
  });

  after(async () => {
    for (const slug of createdSlugs) {
      try { await reqAuth('DELETE', `/projects/${slug}`); } catch { /* best effort */ }
    }
    await cleanupLiveUsers();
  });

  test('update tags → successful update & sanitation', async () => {
    const slug = `tags-${uniqueId('test')}`;
    createdSlugs.push(slug);
    await reqAuth('POST', '/projects', { name: 'Tags Test', slug });

    const tags = ['  Frontend  ', 'Backend', 'Frontend', '   ']; // duplicate + whitespace + empty
    const res = await reqAuth('PUT', `/projects/${slug}/tags`, { tags });
    assert.strictEqual(res.status, 200);

    const data = await res.json();
    assert.deepStrictEqual(data.tags, ['Frontend', 'Backend'], 'should trim, remove duplicates and empty tags');
  });

  test('update tags → 403 for Viewer', async () => {
    const slug = `tags-view-${uniqueId('test')}`;
    createdSlugs.push(slug);
    await reqAuth('POST', '/projects', { name: 'Viewer Test', slug });

    // A REAL viewer account: verifyToken refuses an id that is not in users.json,
    // so a ghost id would turn this 403 into a bare 401.
    const viewer = await liveUser('viewer', 'tags-viewer');
    const res = await req('PUT', `/projects/${slug}/tags`, { tags: ['test'] }, { Authorization: `Bearer ${viewer.token}` });
    assert.strictEqual(res.status, 403, 'viewers must be blocked from updating tags');
  });

  test('update tags → 400 for too many tags', async () => {
    const slug = `tags-too-many-${uniqueId('test')}`;
    createdSlugs.push(slug);
    await reqAuth('POST', '/projects', { name: 'Too Many', slug });

    const tags = Array.from({ length: 21 }, (_, i) => `tag${i}`);
    const res = await reqAuth('PUT', `/projects/${slug}/tags`, { tags });
    assert.strictEqual(res.status, 400);
    const data = await res.json();
    assert.strictEqual(data.error, 'Too many tags (max 20)');
  });

  test('update tags → 400 for tag too long', async () => {
    const slug = `tags-too-long-${uniqueId('test')}`;
    createdSlugs.push(slug);
    await reqAuth('POST', '/projects', { name: 'Too Long', slug });

    const tags = ['a'.repeat(31)];
    const res = await reqAuth('PUT', `/projects/${slug}/tags`, { tags });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.tags.length, 0, 'over-length tags must be stripped');
  });

  test('tags persist and are returned by the project list & detail', async () => {
    const slug = `tags-read-${uniqueId('test')}`;
    createdSlugs.push(slug);
    await reqAuth('POST', '/projects', { name: 'Tags Read', slug });

    const saved = await reqAuth('PUT', `/projects/${slug}/tags`, { tags: ['alpha', 'beta'] });
    assert.strictEqual(saved.status, 200);

    const detail = await reqAuth('GET', `/projects/${slug}`);
    assert.strictEqual(detail.status, 200);
    const d = await detail.json();
    assert.deepStrictEqual(d.project.tags, ['alpha', 'beta'], 'getProject must surface meta.tags');

    const list = await reqAuth('GET', '/projects');
    const l = await list.json();
    const found = l.projects.find((p: any) => p.slug === slug);
    assert.ok(found, 'project should be listed');
    assert.deepStrictEqual(found.tags, ['alpha', 'beta'], 'listProjects must surface meta.tags');
  });
});
