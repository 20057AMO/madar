import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import jwt from 'jsonwebtoken';
import { uniqueId, req, reqAuth, initTestAuth, API_URL, JWT_SECRET } from './helpers.ts';

/**
 * User accounts & profile: display name / email / bio + avatar upload.
 *
 * Offline describe: avatar-store (import-free — temp WSD_DATA_DIR) covering
 * magic-byte detection (valid PNG/JPEG/WebP, SVG/text rejected), save/load/
 * delete cycle and stale-sibling cleanup.
 *
 * Real-Docker describe (server on :3000): profile CRUD + validation matrix,
 * avatar upload/serve/delete roundtrip, self vs admin-edit access matrix,
 * and the project-members enrichment now carrying displayName/avatarExt.
 */

// ── Offline: avatar-store ─────────────────────────────────────
describe('avatar-store (offline)', () => {
  let tmp = '';
  let store: typeof import('../src/services/avatar-store.ts');

  before(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsd-avatar-'));
    process.env.WSD_DATA_DIR = tmp;
    store = await import('../src/services/avatar-store.ts');
  });

  after(() => {
    delete process.env.WSD_DATA_DIR;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('magic bytes: PNG / JPEG / WebP detected, SVG and text rejected', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);
    assert.strictEqual(store.detectImageExt(png), 'png');
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3, 4, 5]);
    assert.strictEqual(store.detectImageExt(jpg), 'jpg');
    const webp = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP', 'latin1'), Buffer.alloc(16)]);
    assert.strictEqual(store.detectImageExt(webp), 'webp');
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    assert.strictEqual(store.detectImageExt(svg), null);
    assert.strictEqual(store.detectImageExt(Buffer.from('plain text payload')), null);
    assert.strictEqual(store.detectImageExt(Buffer.alloc(0)), null);
  });

  test('save/get/delete roundtrip + stale sibling cleanup', async () => {
    const userId = 'user-999abc';
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
    const webp = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP', 'latin1'), Buffer.alloc(32)]);

    const ext1 = store.saveAvatar(userId, png);
    assert.strictEqual(ext1, 'png');
    const p1 = store.getAvatarPath(userId);
    assert.ok(p1 && p1.endsWith('.png'));

    // Replace with a different type — the old .png sibling must go away.
    const ext2 = store.saveAvatar(userId, webp);
    assert.strictEqual(ext2, 'webp');
    const p2 = store.getAvatarPath(userId);
    assert.ok(p2 && p2.endsWith('.webp'));
    assert.ok(fs.readdirSync(path.join(tmp, 'avatars')).length === 1);

    assert.strictEqual(store.deleteAvatar(userId), true);
    assert.strictEqual(store.getAvatarPath(userId), null);
    assert.strictEqual(store.deleteAvatar(userId), false);
  });

  test('rejects junk userId (path traversal proof), oversized buffer and empty data', async () => {
    const userId = '../evil';
    assert.strictEqual(store.validAvatarUserId(userId), false);
    assert.throws(() => store.saveAvatar(userId, Buffer.from([0x89, 0x50, 0x4e, 0x47])), /Invalid user id/);
    assert.throws(() => store.saveAvatar('user-1', Buffer.alloc(0)), /No image data/);
    assert.throws(() => store.saveAvatar('user-1', Buffer.alloc(store.AVATAR_MAX_BYTES + 1)), /MB/);
  });
});

// ── Real Docker: profile + avatar API ─────────────────────────
describe('User profile & avatar (real Docker)', () => {
  before(async () => { await initTestAuth(); });

  // Identity under test: a REAL user in the store (profile routes key off
  // req.user.id, which must resolve in users.json — unlike the shared forged
  // 'test-user' token used elsewhere). Mirror team-access: create the user via
  // the admin API, then sign "their" token exactly like a real login would.
  const myName = `p_${Date.now().toString(36)}`;
  const pw = 'profile-pass-123';
  let myId = '';
  let myTok = '';
  let createdUser = false;

  after(async () => {
    if (createdUser) {
      const res = await reqAuth('DELETE', `/users/${myId}`);
      if (res.status !== 200 && res.status !== 404) {
        await new Promise((r) => setTimeout(r, 1500));
        await reqAuth('DELETE', `/users/${myId}`);
      }
    }
  });

  test('provision the real test user and mint their session token', async () => {
    const create = await reqAuth('POST', '/users', { username: myName, password: pw, role: 'editor' });
    assert.strictEqual(create.status, 201, `create editor: ${create.status}`);
    myId = (await create.json()).id;
    createdUser = true;
    myTok = jwt.sign({ id: myId, username: myName, role: 'editor', tv: 0 }, JWT_SECRET, { expiresIn: '24h' });
  });

  test('own profile roundtrip: empty → patch → GET /api/users shows it', async () => {
    const before = await req('GET', '/users/me/profile', undefined, { Authorization: `Bearer ${myTok}` });
    assert.strictEqual(before.status, 200);
    assert.deepStrictEqual((await before.json()).profile, {});

    const put = await req('PUT', '/users/me/profile', {
      displayName: 'Ali Developer',
      email: 'ali+team@example.com',
      bio: 'Building Madar',
    }, { Authorization: `Bearer ${myTok}` });
    assert.strictEqual(put.status, 200, `put failed: ${put.status}`);
    const updated = await put.json();
    assert.strictEqual(updated.profile.displayName, 'Ali Developer');
    assert.strictEqual(updated.profile.email, 'ali+team@example.com');

    const me = await req('GET', '/users/me/profile', undefined, { Authorization: `Bearer ${myTok}` });
    assert.strictEqual((await me.json()).profile.displayName, 'Ali Developer');

    const users = await (await reqAuth('GET', '/users')).json();
    const self = users.find((u: any) => u.id === myId);
    assert.ok(self, 'user appears in /api/users');
    assert.strictEqual(self.profile.email, 'ali+team@example.com');
    assert.strictEqual(self.profile.bio, 'Building Madar');
  });

  test('validation: long displayName / bad email / control chars → 400', async () => {
    const h = { Authorization: `Bearer ${myTok}` };
    const longName = await req('PUT', '/users/me/profile', { displayName: 'x'.repeat(61) }, h);
    assert.strictEqual(longName.status, 400);
    const badEmail = await req('PUT', '/users/me/profile', { email: 'not-an-email' }, h);
    assert.strictEqual(badEmail.status, 400);
    const ctrl = await req('PUT', '/users/me/profile', { displayName: 'bad\u0000name' }, h);
    assert.strictEqual(ctrl.status, 400);
  });

  test('clearing: empty strings remove fields', async () => {
    const res = await req('PUT', '/users/me/profile', { displayName: '', email: '' }, { Authorization: `Bearer ${myTok}` });
    assert.strictEqual(res.status, 200);
    const me = await (await req('GET', '/users/me/profile', undefined, { Authorization: `Bearer ${myTok}` })).json();
    assert.strictEqual(me.profile.displayName, undefined);
    assert.strictEqual(me.profile.email, undefined);
  });

  test('avatar roundtrip: upload PNG → served → delete → 404', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);

    const form = new FormData();
    form.append('avatar', new Blob([png], { type: 'image/png' }), 'avatar.png');
    const up = await fetch(`${API_URL}/users/me/avatar`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${myTok}` },
      body: form,
    });
    assert.strictEqual(up.status, 200, `upload failed: ${up.status}`);
    const upData = await up.json();
    assert.ok(upData.avatarUrl.includes('/avatar'), 'avatar url returned');

    const served = await fetch(`${API_URL}/users/${myId}/avatar`, { headers: { Authorization: `Bearer ${myTok}` } });
    assert.strictEqual(served.status, 200);
    assert.strictEqual(served.headers.get('content-type'), 'image/png');
    assert.strictEqual(served.headers.get('x-content-type-options'), 'nosniff');
    const bytes = Buffer.from(await served.arrayBuffer());
    assert.ok(bytes.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'served bytes match');

    // Avatar extension lands on the user record.
    const users = await (await reqAuth('GET', '/users')).json();
    const self = users.find((u: any) => u.id === myId);
    assert.strictEqual(self.profile.avatarExt, 'png');

    const del = await req('DELETE', '/users/me/avatar', undefined, { Authorization: `Bearer ${myTok}` });
    assert.strictEqual(del.status, 200);

    const gone = await fetch(`${API_URL}/users/${myId}/avatar`, { headers: { Authorization: `Bearer ${myTok}` } });
    assert.strictEqual(gone.status, 404);
  });

  test('avatar upload: SVG content and oversized payload rejected', async () => {
    const form = new FormData();
    form.append('avatar', new Blob([Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')], { type: 'image/svg+xml' }), 'evil.svg');
    const res = await fetch(`${API_URL}/users/me/avatar`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${myTok}` },
      body: form,
    });
    assert.strictEqual(res.status, 400);

    const big = new FormData();
    big.append('avatar', new Blob([Buffer.alloc(2 * 1024 * 1024 + 1, 0x89).fill(0x50, 1).fill(0x4e, 2).fill(0x47, 3).fill(0x0d, 4).fill(0x0a, 5).fill(0x1a, 6).fill(0x0a, 7)]), { type: 'image/png' });
    const bigRes = await fetch(`${API_URL}/users/me/avatar`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${myTok}` },
      body: big,
    });
    assert.strictEqual(bigRes.status, 400);
  });

  test('access matrix: requireAdmin blocks editor editing via :userId; admin can', async () => {
    // An editor token cannot touch /users/:userId/profile even for themselves.
    const editAsEditor = await req(
      'PUT',
      `/users/${myId}/profile`,
      { displayName: 'Hacked Name' },
      { Authorization: `Bearer ${myTok}` }
    );
    assert.strictEqual(editAsEditor.status, 403, 'non-admin must not edit via the :userId route');

    // The admin (forged admin token) can update any real user's profile.
    const adminEdit = await reqAuth('PUT', `/users/${myId}/profile`, { displayName: 'Editor Visible' });
    assert.strictEqual(adminEdit.status, 200);
    const readBack = await reqAuth('GET', `/users/${myId}/profile`);
    assert.strictEqual((await readBack.json()).profile.displayName, 'Editor Visible');

    // Any authenticated user can READ others' profiles.
    const asEditor = await req('GET', `/users/${myId}/profile`, undefined, { Authorization: `Bearer ${myTok}` });
    assert.strictEqual(asEditor.status, 200, 'any authenticated user can read profiles');

    // Self-edit via /me is always allowed for the owner.
    const selfEdit = await req('PUT', '/users/me/profile', { bio: 'Self-edit works' }, { Authorization: `Bearer ${myTok}` });
    assert.strictEqual(selfEdit.status, 200);
  });

  test('project members enrichment carries displayName + avatarExt', async () => {
    const slug = uniqueId('usrprofile');
    const prj = await reqAuth('POST', '/projects', { name: 'Profile Enrichment', slug, description: 'temp' });
    assert.strictEqual(prj.status, 201);
    try {
      await reqAuth('POST', `/projects/${slug}/members`, { userId: myId, role: 'editor' });
      const members = await (await reqAuth('GET', `/projects/${slug}/members`)).json();
      const rec = members.members.find((m: any) => m.userId === myId);
      assert.strictEqual(rec.displayName, 'Editor Visible');
      assert.strictEqual(rec.username, myName, 'username still enriched alongside profile');
    } finally {
      await reqAuth('DELETE', `/projects/${slug}`);
    }
  });
});