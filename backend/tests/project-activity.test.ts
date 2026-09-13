/**
 * project-activity.test.ts
 * Per-project activity feed ("من قام بماذا ومتى") live-container roundtrip:
 *   - Every wired write point lands an attributed entry (userId + actorName).
 *   - The project LIST/detail carries the same feed (lastTouched consumers).
 *   - Pagination is newest-first with an honest total.
 *   - Access matrix: 401 anonymous / 403 non-member viewer / 200 member
 *     viewer / 200 editor; 404 unknown slug and 404 after project deletion.
 *
 * Runs against the running container on port 3000 (serial suite).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import jwt from 'jsonwebtoken';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { uniqueId, reqAuth, req, initTestAuth, JWT_SECRET } from './helpers.ts';

describe('Project activity feed', () => {
  before(async () => { await initTestAuth(); });

  const slug = uniqueId('activity-test');
  const extraSlugs: string[] = [];
  let created = false;
  let tempUser: { id: string; username: string } | null = null;

  async function feed(): Promise<any> {
    const res = await reqAuth('GET', `/projects/${slug}/activity?limit=200`);
    return res.json();
  }

  async function byAction(act: string): Promise<any> {
    const data = await feed();
    return (data.entries || []).find((e: any) => e.action === act) || null;
  }

  function tokenFor(id: string, username: string, role: string): string {
    return jwt.sign({ id, username, role, tv: 0, jti: 'activity-test-session' }, JWT_SECRET, { expiresIn: '24h' });
  }

  /** Run a command inside the server container (best-effort: caller skips on failure). */
  function dockerExec(cmd: string, ...args: string[]): string {
    return execFileSync('docker', ['exec', 'wsd-pro', cmd, ...args], { timeout: 15000, encoding: 'utf8' });
  }

  after(async () => {
    if (created) await reqAuth('DELETE', `/projects/${slug}`).catch(() => {});
    for (const s of extraSlugs) await reqAuth('DELETE', `/projects/${s}`).catch(() => {});
    if (tempUser) await reqAuth('DELETE', `/users/${tempUser.id}`).catch(() => {});
  });

  test('create scratch project', async () => {
    const send = () => reqAuth('POST', '/projects', { name: 'Activity Test Project', slug });
    let res = await send();
    if (res.status !== 201 && res.status !== 409) {
      await new Promise((r) => setTimeout(r, 2500));
      res = await send();
    }
    assert.strictEqual(res.status, 201, `create failed: ${res.status} ${JSON.stringify(await res.json().catch(() => null))}`);
    created = true;
  });

  test('created event is recorded and attributed', async () => {
    const entry = await byAction('created');
    assert.ok(entry, 'created action recorded');
    assert.ok(entry.id && /^a-[a-z0-9]{6}-[a-z0-9]{6}$/.test(entry.id), `id format: ${entry.id}`);
    assert.ok(!Number.isNaN(Date.parse(entry.at)), 'timestamp valid');
    assert.ok(entry.userId, 'created event carries the acting user id');
    assert.ok(entry.actorName, 'created event carries an actor label');
  });

  test('project detail list carries the same feed (oldest→newest, lastTouched-ready)', async () => {
    const res = await reqAuth('GET', `/projects/${slug}`);
    assert.strictEqual(res.status, 200);
    const project = (await res.json()).project;
    assert.ok(Array.isArray(project.activity), 'project.activity is a list');
    const last = project.activity[project.activity.length - 1];
    assert.strictEqual(last.action, 'created', 'created stays the newest (append order)');
    assert.ok(!Number.isNaN(Date.parse(last.at)), 'lastTouched at is parseable');
  });

  test('stop/start land stopped/started with the actor', async () => {
    // The project is created RUNNING, so stop FIRST — a start on an already
    // running container is a Docker "no-op" answered with 304 Not Modified,
    // which dockerode surfaces as err.statusCode and the route forwards
    // (pre-existing contract: create → start, start → stop → start).
    const stop = await reqAuth('POST', `/projects/${slug}/stop`);
    assert.strictEqual(stop.status, 200, `stop: ${stop.status}`);
    const start = await reqAuth('POST', `/projects/${slug}/start`);
    assert.strictEqual(start.status, 200, `start: ${start.status}`);

    const stopped = await byAction('stopped');
    const started = await byAction('started');
    assert.ok(stopped && stopped.userId, 'stopped attributed');
    assert.ok(started && started.userId, 'started attributed');
    assert.ok(Date.parse(started.at) >= Date.parse(stopped.at), 'started after stopped');
  });

  test('metadata/env/tags edits record updated/env_updated/tags_updated', async () => {
    const patch = await reqAuth('PATCH', `/projects/${slug}`, { name: 'Activity Test Project v2' });
    assert.strictEqual(patch.status, 200);
    const env = await reqAuth('PUT', `/projects/${slug}/env`, { env: { FOO: 'bar' } });
    assert.strictEqual(env.status, 200);
    const tags = await reqAuth('PUT', `/projects/${slug}/tags`, { tags: ['alpha', 'beta'] });
    assert.strictEqual(tags.status, 200);

    const updated = await byAction('updated');
    assert.ok(updated && updated.userId, 'updated recorded with actor');
    const envEntry = await byAction('env_updated');
    assert.ok(envEntry, 'env_updated recorded');
    assert.strictEqual(envEntry.details?.count, 1);
    const tagsEntry = await byAction('tags_updated');
    assert.ok(tagsEntry, 'tags_updated recorded');
    assert.deepStrictEqual(tagsEntry.details?.tags, ['alpha', 'beta']);
  });

  test('notes/canvas saves record notes_saved/canvas_saved with counts', async () => {
    const notes = await reqAuth('PUT', `/projects/${slug}/notes`, {
      items: [{ id: 'n1', text: 'Ship the feed', kind: 'goal', done: false, createdAt: '2026-09-01T00:00:00.000Z' }],
    });
    assert.strictEqual(notes.status, 200, `notes: ${notes.status}`);
    const saved = await byAction('notes_saved');
    assert.ok(saved, 'notes_saved recorded');
    assert.strictEqual(saved.details?.count, 1);

    const canvas = await reqAuth('PUT', `/projects/${slug}/canvas`, {
      version: 1,
      nodes: [
        { id: 'n-1', type: 'note', text: 'Plan', x: 40, y: 80, w: 220, h: 100, color: 'yellow' },
        { id: 'n-2', type: 'note', text: 'Ship', x: 300, y: 80, w: 220, h: 100, color: 'green' },
      ],
      edges: [{ id: 'e-1', from: 'n-1', to: 'n-2' }],
      updatedAt: null,
    });
    assert.strictEqual(canvas.status, 200, `canvas: ${canvas.status}`);
    const canvasEntry = await byAction('canvas_saved');
    assert.ok(canvasEntry, 'canvas_saved recorded');
    assert.strictEqual(canvasEntry.details?.nodes, 2);
    assert.strictEqual(canvasEntry.details?.edges, 1);
  });

  test('snapshot automation records snapshot_config / snapshot_captured / snapshot_deleted', async () => {
    const cfg = await reqAuth('PUT', `/projects/${slug}/snapshots/config`, { enabled: true, intervalMin: 24 * 60, keep: 3 });
    assert.strictEqual(cfg.status, 200, `snapshots/config: ${cfg.status}`);
    const cfgEntry = await byAction('snapshot_config');
    assert.ok(cfgEntry, 'snapshot_config recorded');
    assert.strictEqual(cfgEntry.details?.intervalMin, 24 * 60);
    assert.strictEqual(cfgEntry.details?.keep, 3);

    const cap = await reqAuth('POST', `/projects/${slug}/snapshots`);
    assert.strictEqual(cap.status, 201, `capture now: ${cap.status}`);
    const captured = await byAction('snapshot_captured');
    assert.ok(captured, 'snapshot_captured recorded');
    assert.match(captured.details?.file || '', /^madar-/);
    assert.ok(captured.details?.size > 0, 'captured entry has a size');

    const del = await reqAuth('DELETE', `/projects/${slug}/snapshots/${captured.details.file}`);
    assert.strictEqual(del.status, 200, `snapshot delete: ${del.status}`);
    const deleted = await byAction('snapshot_deleted');
    assert.ok(deleted && deleted.details?.file === captured.details.file, 'snapshot_deleted recorded with the file');
  });

  test('ports/limits edits record ports_updated/limits_updated', async () => {
    // Pick a high, likely-free port; on a 409 conflict retry with a fresh one.
    let status = 0;
    let chosen = 0;
    const attempts = new Set<number>();
    while (status !== 200 && attempts.size < 4) {
      chosen = 40000 + Math.floor(Math.random() * 20000);
      if (attempts.has(chosen)) continue;
      attempts.add(chosen);
      const res = await reqAuth('PUT', `/projects/${slug}/ports`, { ports: [chosen] });
      status = res.status;
    }
    assert.strictEqual(status, 200, `ports edit succeeded on a free port`);
    const portsEntry = await byAction('ports_updated');
    assert.ok(portsEntry, 'ports_updated recorded');
    assert.deepStrictEqual(portsEntry.details?.ports, [String(chosen)]);

    const limits = await reqAuth('PUT', `/projects/${slug}/limits`, { cpu: '500m' });
    assert.strictEqual(limits.status, 200, `limits: ${limits.status}`);
    const limitsEntry = await byAction('limits_updated');
    assert.ok(limitsEntry, 'limits_updated recorded');
    assert.strictEqual(limitsEntry.details?.cpu, '500m', 'limits details carry the canonical cpu');
  });

  test('membership events record member_added / member_role_changed / member_removed', async () => {
    const u = await reqAuth('POST', '/users', { username: uniqueId('act-member'), password: 'member-pass-123', role: 'viewer' });
    assert.strictEqual(u.status, 201, `temp user: ${u.status}`);
    const uBody = await u.json();
    tempUser = { id: uBody.id, username: uBody.username };

    const add = await reqAuth('POST', `/projects/${slug}/members`, { userId: tempUser.id, role: 'viewer' });
    assert.strictEqual(add.status, 200, `member add: ${add.status}`);
    const added = await byAction('member_added');
    assert.ok(added, 'member_added recorded');
    assert.strictEqual(added.details?.targetUserId, tempUser.id);
    assert.strictEqual(added.details?.username, tempUser.username);
    assert.strictEqual(added.details?.role, 'viewer');

    const reAdd = await reqAuth('POST', `/projects/${slug}/members`, { userId: tempUser.id, role: 'editor' });
    assert.strictEqual(reAdd.status, 200, `member role change: ${reAdd.status}`);
    const changed = await byAction('member_role_changed');
    assert.ok(changed, 'member_role_changed recorded');
    assert.strictEqual(changed.details?.role, 'editor');

    // The viewer member can read the feed (viewer+ access).
    const asViewer = await req('GET', `/projects/${slug}/activity`, undefined, {
      Authorization: `Bearer ${tokenFor(tempUser.id, tempUser.username, 'viewer')}`,
    });
    assert.strictEqual(asViewer.status, 200, `viewer member feed read: ${asViewer.status}`);

    const rem = await reqAuth('DELETE', `/projects/${slug}/members/${tempUser.id}`);
    assert.strictEqual(rem.status, 200, `member remove: ${rem.status}`);
    const removed = await byAction('member_removed');
    assert.ok(removed, 'member_removed recorded');
    assert.strictEqual(removed.details?.targetUserId, tempUser.id);
  });

  test('access matrix: 401 anonymous / 403 non-member viewer / 404 unknown slug', async () => {
    const anon = await req('GET', `/projects/${slug}/activity`);
    assert.strictEqual(anon.status, 401, 'anonymous blocked');

    const outsider = await req('GET', `/projects/${slug}/activity`, undefined, {
      Authorization: `Bearer ${tokenFor('some-other-user', 'outsider', 'viewer')}`,
    });
    assert.strictEqual(outsider.status, 403, 'non-member viewer blocked');

    const unknown = await reqAuth('GET', `/projects/${uniqueId('nope')}/activity`);
    assert.strictEqual(unknown.status, 404, 'unknown slug 404');
  });

  test('pagination: newest-first, limit + honest total', async () => {
    const res = await reqAuth('GET', `/projects/${slug}/activity?limit=3&offset=0`);
    assert.strictEqual(res.status, 200);
    const one = await res.json();
    assert.ok(one.entries.length <= 3, 'limit respected');
    assert.ok(one.total >= one.entries.length, 'total is whole-feed honest');

    const resOff = await reqAuth('GET', `/projects/${slug}/activity?limit=3&offset=2`);
    assert.strictEqual(resOff.status, 200);
    const off = await resOff.json();
    assert.ok(off.entries.length <= 3);
    assert.strictEqual(off.total, one.total, 'total is page-independent');

    const times = one.entries.map((e: any) => Date.parse(e.at));
    for (let i = 1; i < times.length; i++) {
      assert.ok(times[i - 1] >= times[i], `monotonically non-increasing: idx ${i}`);
    }
  });

  test('legacy meta.activity survives a recreate (forced backfill before the meta wipe)', async (t) => {
    const legacySlug = uniqueId('act-legacy');
    const create = await reqAuth('POST', '/projects', { name: 'Legacy Activity Project', slug: legacySlug });
    if (create.status !== 201) {
      t.skip(`project creation failed (${create.status}) — legacy backfill roundtrip not run`);
      return;
    }
    extraSlugs.push(legacySlug);

    // Simulate the pre-migration state: meta.json carries the legacy activity
    // array and activity.json does not exist yet.
    const metaPath = `/app/data/projects/${legacySlug}/meta.json`;
    let meta: Record<string, any>;
    try {
      meta = JSON.parse(dockerExec('cat', metaPath));
    } catch (err) {
      t.skip(`docker CLI/container unavailable — legacy backfill roundtrip not run (${(err as Error).message})`);
      return;
    }
    meta.activity = [
      { action: 'started', at: '2026-01-05T10:00:00.000Z' },
      { action: 'stopped', at: '2026-01-06T10:00:00.000Z' },
    ];
    const tmp = path.join(os.tmpdir(), `meta-${legacySlug}.json`);
    fs.writeFileSync(tmp, JSON.stringify(meta));
    try {
      execFileSync('docker', ['cp', tmp, `wsd-pro:${metaPath}`], { timeout: 15000 });
      dockerExec('rm', '-f', `/app/data/projects/${legacySlug}/activity.json`);
    } catch (err) {
      t.skip(`docker CLI/container unavailable — legacy backfill roundtrip not run (${(err as Error).message})`);
      return;
    } finally {
      fs.rmSync(tmp, { force: true });
    }

    // Recreate — createProject must migrate meta.activity into activity.json
    // BEFORE wiping the meta field, or the pre-migration history is lost.
    const rec = await reqAuth('POST', `/projects/${legacySlug}/recreate`);
    assert.strictEqual(rec.status, 200, `recreate: ${rec.status} ${JSON.stringify(await rec.json().catch(() => null))}`);

    const res = await reqAuth('GET', `/projects/${legacySlug}/activity?limit=200`);
    assert.strictEqual(res.status, 200);
    const entries = (await res.json()).entries || [];
    const idx = (act: string) => entries.findIndex((e: any) => e.action === act);
    const createdIdx = idx('created');
    const recreatedIdx = idx('recreated');
    const startedIdx = idx('started');
    const stoppedIdx = idx('stopped');

    assert.ok(createdIdx >= 0 && recreatedIdx >= 0, 'created + recreated are present');
    assert.ok(startedIdx >= 0 && stoppedIdx >= 0, 'legacy started/stopped survived the recreate');
    // Newest-first list: the migrated legacy rows must sit AFTER the new
    // created/recreated rows (i.e. predate them — the record was not lost).
    assert.ok(startedIdx > createdIdx && stoppedIdx > createdIdx, 'legacy events predate the new created event');
    assert.ok(startedIdx > stoppedIdx, 'started (older) sorts after stopped (newer)');
    assert.strictEqual(entries[startedIdx].at, '2026-01-05T10:00:00.000Z', 'legacy started timestamp preserved');
    assert.strictEqual(entries[stoppedIdx].at, '2026-01-06T10:00:00.000Z', 'legacy stopped timestamp preserved');
  });

  test('after project deletion the feed 404s (store dies with the project)', async () => {
    const del = await reqAuth('DELETE', `/projects/${slug}`);
    assert.strictEqual(del.status, 200, `delete: ${del.status}`);
    created = false;
    const gone = await reqAuth('GET', `/projects/${slug}/activity`);
    assert.strictEqual(gone.status, 404, 'activity 404 after delete');
  });
});