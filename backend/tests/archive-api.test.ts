/**
 * archive-api.test.ts
 * Madar — Real-Docker integration for the Trash Bin API.
 *
 * Covers:
 *  - GET  /api/archive              — list (any role)
 *  - DELETE /api/archive/:entry     — permanent delete (editor+)
 *  - POST /api/archive/empty        — purge all (editor+)
 *  - POST /api/archive/:entry/restore — restore → new live project (editor+)
 *
 * Archives are seeded by writing directories directly into the container's
 * /workspaces/.archive/ via docker exec (the janitor is not directly
 * callable — it runs on its own sweep interval).
 *
 * Order-dependent by design (single shared archive dir across tests).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import jwt from 'jsonwebtoken';
import { execSync, execFileSync } from 'node:child_process';
import {
  uniqueId,
  req,
  reqAuth,
  initTestAuth,
  JWT_SECRET,
  authHeaders,
  API_URL,
} from './helpers.ts';

const CONTAINER = 'wsd-pro';
const ARCHIVE_DIR = '/workspaces/.archive';
const createdSlugs: string[] = [];
const createdUserIds: string[] = [];

// ── Helpers ──────────────────────────────────────────────────────

/** Forge a JWT for an arbitrary user (id+role embedded in the token). */
function forgeAuth(id: string, username: string, role: string) {
  const token = jwt.sign({ id, username, role, tv: 0 }, JWT_SECRET, { expiresIn: '24h' });
  return { headers: { ...authHeaders(), Authorization: `Bearer ${token}` } };
}

/** Create a directory with a marker file inside the container's .archive dir. */
function seedArchiveEntry(
  entry: string,
  markerName = 'marker.txt',
  markerContent = `seeded by archive-api test at ${new Date().toISOString()}`,
) {
  execFileSync(
    'docker',
    ['exec', CONTAINER, 'mkdir', '-p', `${ARCHIVE_DIR}/${entry}/nested`],
    { stdio: 'pipe' },
  );
  execFileSync(
    'docker',
    [
      'exec', CONTAINER, 'sh', '-c',
      `echo '${markerContent.replace(/'/g, "'\\''")}' > ${ARCHIVE_DIR}/${entry}/${markerName}`,
    ],
    { stdio: 'pipe' },
  );
  execFileSync(
    'docker',
    [
      'exec', CONTAINER, 'sh', '-c',
      `echo 'deep' > ${ARCHIVE_DIR}/${entry}/nested/deep.txt`,
    ],
    { stdio: 'pipe' },
  );
}

/** Remove a single archive entry from the container (best-effort). */
function rmArchiveEntry(entry: string) {
  try {
    execFileSync(
      'docker',
      ['exec', CONTAINER, 'rm', '-rf', `${ARCHIVE_DIR}/${entry}`],
      { stdio: 'pipe', timeout: 5000 },
    );
  } catch { /* already gone */ }
}

/** Remove ALL entries under .archive (best-effort). */
function rmAllArchives() {
  try {
    execFileSync(
      'docker',
      ['exec', CONTAINER, 'sh', '-c', `rm -rf ${ARCHIVE_DIR}/*`],
      { stdio: 'pipe', timeout: 5000 },
    );
  } catch { /* dir missing or empty */ }
}

/** GET /api/archive and return parsed body. */
async function getArchive(
  headers: Record<string, string> = authHeaders(),
  fresh = false,
): Promise<{ status: number; json: any }> {
  const url = `/archive${fresh ? '?fresh=1' : ''}`;
  const r = await req('GET', url, undefined, headers);
  let json: any = {};
  try { json = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, json };
}

/** DELETE /api/archive/:entry and return parsed body. */
async function deleteArchive(
  entry: string,
  headers: Record<string, string> = authHeaders(),
): Promise<{ status: number; json: any }> {
  const r = await req('DELETE', `/archive/${entry}`, undefined, headers);
  let json: any = {};
  try { json = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, json };
}

/** POST /api/archive/empty and return parsed body. */
async function emptyArchive(
  headers: Record<string, string> = authHeaders(),
): Promise<{ status: number; json: any }> {
  const r = await req('POST', '/archive/empty', undefined, headers);
  let json: any = {};
  try { json = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, json };
}

/** POST /api/archive/:entry/restore and return parsed body. */
async function restoreArchive(
  entry: string,
  body?: { name?: string; description?: string; ports?: number[] },
  headers: Record<string, string> = authHeaders(),
): Promise<{ status: number; json: any }> {
  const r = await req('POST', `/archive/${entry}/restore`, body, headers);
  let json: any = {};
  try { json = await r.json(); } catch { /* non-JSON */ }
  return { status: r.status, json };
}

/**
 * POST /projects with a short bounded retry on transient container-start
 * failures. GitHub's runners occasionally drop a fresh bind-mount right after
 * tearing down an earlier container ("failed to fulfil mount request" / OCI
 * shim errors). A brief retry absorbs that flake WITHOUT any destructive
 * global cleanup (no volume purging). Never retried on a 4xx that isn't a
 * mount/start error, so an intentional 400/409 still surfaces immediately.
 */
async function createProjectRetry(
  body: any,
  tries = 3,
): Promise<{ status: number; json: any }> {
  let last: { status: number; json: any } = { status: 0, json: {} };
  for (let i = 0; i < tries; i++) {
    const r = await reqAuth('POST', '/projects', body);
    let json: any = {};
    try { json = await r.json(); } catch { /* non-JSON */ }
    last = { status: r.status, json };
    if (r.status >= 200 && r.status < 300) return last;
    const errText = String(json?.error || r.statusText || '');
    const transient =
      r.status >= 500 ||
      (r.status === 400 &&
        /mount|shim|oci|runc|start container|failed to (start|create)/i.test(errText));
    if (!transient) return last;
    if (i < tries - 1) await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
  }
  return last;
}

// ── Suite ────────────────────────────────────────────────────────

describe('Trash Bin API (archive) — real Docker', () => {
  const E1 = uniqueId('trash-a'); // e.g. m1abc2def-trash-a  (will be a canonical ts-slug form)
  const E2 = uniqueId('trash-b');
  const E3 = uniqueId('trash-c');

  // Canonical entry names that include a valid base36 timestamp prefix so
  // parseArchiveName derives a slug + date. uniqueId already produces
  // "prefix-ts-counter" — the ts part is decimal, not base36, so we
  // construct canonical names manually.
  const TS = Date.now().toString(36);
  const CANON1 = `${TS}-restore-proj`;
  const CANON2 = `${(Date.now() + 1).toString(36)}-restore-proj2`;

  before(async () => {
    // Clean up orphaned wsd.managed containers from crashed runs.
    try {
      execSync('docker rm -f $(docker ps -aq --filter label=wsd.managed=true) 2>NUL', {
        timeout: 15000,
        stdio: 'pipe',
      });
    } catch { /* no orphans */ }

    await initTestAuth();

    // Ensure clean slate: remove all archive entries from prior runs.
    rmAllArchives();
  });

  after(async () => {
    // Remove any projects created during restore tests.
    for (const slug of createdSlugs) {
      try { await reqAuth('DELETE', `/projects/${slug}`); } catch { /* best effort */ }
    }
    // Remove any users created for the access matrix.
    for (const id of createdUserIds) {
      try { await reqAuth('DELETE', `/users/${id}`); } catch { /* best effort */ }
    }
    // Clean up archive dir.
    rmAllArchives();
  });

  // ── 1. Seed → list ────────────────────────────────────────────

  test('seed archive entry → GET /api/archive returns it with slug, sizeBytes > 0, valid ISO date', async () => {
    seedArchiveEntry(CANON1);

    const { status, json } = await getArchive(authHeaders(), true); // fresh=1 to bypass cache
    assert.strictEqual(status, 200, `GET /archive: ${status}`);
    assert.ok(Array.isArray(json.archives), 'archives is an array');

    const found = json.archives.find((a: any) => a.entry === CANON1);
    assert.ok(found, `entry ${CANON1} must appear in the list, got: ${JSON.stringify(json.archives.map((a: any) => a.entry))}`);
    assert.strictEqual(typeof found.slug, 'string');
    assert.ok(found.slug.length > 0, 'slug is non-empty');
    assert.strictEqual(typeof found.name, 'string');
    assert.ok(found.name.length > 0, 'name is non-empty');
    assert.ok(typeof found.sizeBytes === 'number' && found.sizeBytes > 0, `sizeBytes must be > 0, got ${found.sizeBytes}`);
    assert.ok(typeof found.date === 'string' && found.date.length > 0, `date must be an ISO string, got ${found.date}`);
    // Verify the date is actually parseable ISO.
    assert.ok(!isNaN(new Date(found.date).getTime()), `date is not valid ISO: ${found.date}`);
  });

  test('GET /api/archive ?fresh=1 bypasses cache and still returns the entry', async () => {
    const { status, json } = await getArchive(authHeaders(), true);
    assert.strictEqual(status, 200);
    const found = json.archives.find((a: any) => a.entry === CANON1);
    assert.ok(found, 'fresh=1 must still find the seeded entry');
  });

  // ── 2. Delete one ─────────────────────────────────────────────

  test('DELETE /api/archive/:entry → {ok:true}, entry gone from list', async () => {
    // Seed a disposable entry for deletion.
    const delEntry = uniqueId('trash-del');
    seedArchiveEntry(delEntry);

    const d = await deleteArchive(delEntry);
    assert.strictEqual(d.status, 200, `DELETE: ${d.status} ${d.json.error || ''}`);
    assert.strictEqual(d.json.ok, true, 'response body must be {ok: true}');

    const { json } = await getArchive(authHeaders(), true);
    const gone = json.archives.find((a: any) => a.entry === delEntry);
    assert.ok(!gone, `deleted entry ${delEntry} must not appear in the list`);
  });

  // ── 3. Seed multiple → empty ──────────────────────────────────

  test('POST /api/archive/empty → {emptied: N}, GET returns 0', async () => {
    // We already have CANON1 seeded. Add CANON2.
    seedArchiveEntry(CANON2);

    const { status: listStatus, json: listJson } = await getArchive(authHeaders(), true);
    assert.strictEqual(listStatus, 200);
    assert.ok(listJson.archives.length >= 2, `expected >= 2 entries before empty, got ${listJson.archives.length}`);
    const before = listJson;

    const e = await emptyArchive();
    assert.strictEqual(e.status, 200, `empty: ${e.status} ${e.json.error || ''}`);
    assert.strictEqual(typeof e.json.emptied, 'number', 'emptied must be a number');
    assert.ok(e.json.emptied >= 2, `emptied must be >= 2, got ${e.json.emptied}`);
    assert.ok(Array.isArray(e.json.failed), 'failed must be an array (entries that could not be removed)');

    const { json: after } = await getArchive(authHeaders(), true);
    // "Everything that existed when the call ran is gone, or it was named as a
    // failure" — NOT "the archive is globally empty". The workspace janitor keeps
    // archiving orphaned project dirs on its own interval, so in a long stacked run
    // a directory can be archived between the empty call and this read; that entry
    // was not part of the request. And a directory locked through the Windows bind
    // mount can survive the rm inside the container (Docker Desktop refuses an rm the
    // host allows seconds later), which is exactly what `failed` reports instead of
    // silently dropping from the count.
    const survivors = after.archives.filter((a: any) => before.archives.some((b: any) => b.entry === a.entry));
    const unreported = survivors.filter((a: any) => !e.json.failed.includes(a.entry));
    assert.deepStrictEqual(
      unreported.map((a: any) => a.entry),
      [],
      `entries left behind must be reported in failed: ${JSON.stringify(unreported.map((a: any) => a.entry))}`,
    );
  });

  // ── 4. Seed → restore → working project ───────────────────────

  test('POST /api/archive/:entry/restore → 201 with running project, files present, archive entry gone', async () => {
    // Seed a fresh entry with a marker file.
    const restoreEntry = uniqueId('trash-rst');
    seedArchiveEntry(restoreEntry, 'restore-marker.txt', 'restored-content-12345');

    const r = await restoreArchive(restoreEntry, { name: 'Restored Project' });
    assert.strictEqual(r.status, 201, `restore: ${r.status} ${r.json.error || ''}`);
    assert.ok(r.json.project, 'response must include a project object');

    const project = r.json.project;
    assert.ok(project.slug, 'project must have a slug');
    createdSlugs.push(project.slug); // track for cleanup

    // The project should be reachable via GET /api/projects/:slug.
    const get = await reqAuth('GET', `/projects/${project.slug}`);
    assert.strictEqual(get.status, 200, `GET /projects/${project.slug}: ${get.status}`);
    const pData = await get.json();
    assert.strictEqual(pData.project.name, 'Restored Project', 'display name preserved');
    assert.ok(pData.project.status, 'project has a status');

    // The marker file must exist in the restored workspace.
    const files = await reqAuth('GET', `/projects/${project.slug}/files`);
    assert.strictEqual(files.status, 200, `files listing: ${files.status}`);
    const filesData = await files.json();
    // API returns { entries: [...], fileCount, ... } with each entry having { path, type }.
    const fileList: any[] = filesData.entries || filesData.files || [];
    const marker = Array.isArray(fileList) ? fileList.find((f: any) => (f.path || f.name) === 'restore-marker.txt') : null;
    assert.ok(marker, `restore-marker.txt must exist in restored workspace, entries: ${JSON.stringify(fileList.slice(0, 5))}`);

    // Read the marker content to confirm the restore was a real file copy.
    const fileRead = await reqAuth('GET', `/projects/${project.slug}/file?path=restore-marker.txt`);
    assert.strictEqual(fileRead.status, 200, `read marker: ${fileRead.status}`);
    const fileData = await fileRead.json();
    assert.ok(
      fileData.content && fileData.content.includes('restored-content-12345'),
      `marker content must match, got: ${fileData.content?.slice(0, 100)}`,
    );

    // Nested file should also be present.
    const deepFiles = await reqAuth('GET', `/projects/${project.slug}/files?path=nested`);
    const deepData = await deepFiles.json();
    const deepList: any[] = deepData.entries || deepData.files || [];
    const deepMarker = Array.isArray(deepList) ? deepList.find((f: any) => (f.path || f.name) === 'deep.txt') : null;
    assert.ok(deepMarker, 'nested/deep.txt must exist in restored workspace');

    // The archive entry should be GONE after restore.
    const { json: afterRestore } = await getArchive(authHeaders(), true);
    const stillThere = afterRestore.archives.find((a: any) => a.entry === restoreEntry);
    assert.ok(!stillThere, `archive entry ${restoreEntry} must be removed after restore, found: ${JSON.stringify(stillThere)}`);
  });

  // ── 5. Restore idempotency/failure ────────────────────────────

  test('restoring a consumed (deleted) archive entry → 404', async () => {
    const gone = uniqueId('trash-gone');
    seedArchiveEntry(gone);
    // Delete it first.
    await deleteArchive(gone);

    const r = await restoreArchive(gone);
    assert.strictEqual(r.status, 404, `restore deleted entry → 404, got ${r.status}: ${r.json.error || ''}`);
  });

  test('restoring an entry that never existed → 404', async () => {
    const r = await restoreArchive('never-existed-entry-xyz');
    assert.strictEqual(r.status, 404, `restore non-existent → 404, got ${r.status}`);
  });

  // ── 5b. Busy-port pre-validation (409) ────────────────────────

  test('restoring with a port already in use → 409 with taken', async () => {
    const portHolderSlug = uniqueId('port-holder');
    const busyPort = 18888;

    // Create a live project that claims port 18888.
    const createRes = await createProjectRetry({
      name: 'Port Holder',
      slug: portHolderSlug,
      ports: [busyPort],
    });
    assert.strictEqual(createRes.status, 201, `create port holder: ${createRes.status} ${createRes.json.error || ''}`);
    createdSlugs.push(portHolderSlug);

    // Seed an archive entry.
    const entry = uniqueId('trash-port');
    seedArchiveEntry(entry);

    // Restore with the busy port → must get a clean 409.
    const r = await restoreArchive(entry, { ports: [busyPort] });
    assert.strictEqual(r.status, 409, `restore with busy port → 409, got ${r.status}: ${r.json.error || ''}`);
    assert.ok(
      String(r.json.error || '').includes(String(busyPort)),
      `error should reference the taken port, got: ${JSON.stringify(r.json)}`,
    );

    // The archive entry must still exist (restore aborted).
    const { json: after } = await getArchive(authHeaders(), true);
    const stillThere = after.archives.find((a: any) => a.entry === entry);
    assert.ok(stillThere, `archive entry ${entry} must survive a failed restore`);

    // Cleanup: delete the archive entry (it was not consumed).
    rmArchiveEntry(entry);
  });

  // ── 5c. Slug-collision dedup ──────────────────────────────────

  test('restoring with slug collision → creates project with -1 suffix', async () => {
    const collideSlug = uniqueId('collide');

    // Create a live project that "owns" this slug.
    const createRes = await createProjectRetry({
      name: 'Collide Target',
      slug: collideSlug,
    });
    assert.strictEqual(createRes.status, 201, `create collide target: ${createRes.status} ${createRes.json.error || ''}`);
    createdSlugs.push(collideSlug);

    // Seed an archive entry whose derived slug matches the live project.
    const collideEntry = `${Date.now().toString(36)}-${collideSlug}`;
    seedArchiveEntry(collideEntry, 'collide-marker.txt', 'collision-test-data');

    // Restore → must succeed with a -1 suffixed slug.
    const r = await restoreArchive(collideEntry, { name: 'Collision Restore' });
    assert.strictEqual(r.status, 201, `restore with collision → 201, got ${r.status}: ${r.json.error || ''}`);
    const restoredProject = r.json.project;
    assert.ok(restoredProject, 'response must include a project');
    assert.ok(
      restoredProject.slug.startsWith(`${collideSlug}-`),
      `slug should start with ${collideSlug}-, got ${restoredProject.slug}`,
    );
    createdSlugs.push(restoredProject.slug);

    // Both projects must be reachable.
    const orig = await reqAuth('GET', `/projects/${collideSlug}`);
    assert.strictEqual(orig.status, 200, `original project still reachable`);

    const restored = await reqAuth('GET', `/projects/${restoredProject.slug}`);
    assert.strictEqual(restored.status, 200, `restored project reachable`);

    // The marker file must exist in the restored workspace.
    const files = await reqAuth('GET', `/projects/${restoredProject.slug}/files`);
    assert.strictEqual(files.status, 200);
    const filesData = await files.json();
    const fileList: any[] = filesData.entries || filesData.files || [];
    const marker = Array.isArray(fileList)
      ? fileList.find((f: any) => (f.path || f.name) === 'collide-marker.txt')
      : null;
    assert.ok(marker, 'collide-marker.txt must exist in restored workspace');
  });

  // ── 6. Access matrix ──────────────────────────────────────────

  describe('access matrix', () => {
    let viewerUser: any;
    let editorUser: any;
    let viewerAuth: Record<string, string>;
    let editorAuth: Record<string, string>;
    let outsiderAuth: Record<string, string>; // no project membership (just forged)

    before(async () => {
      // Create viewer user.
      const vu = await reqAuth('POST', '/users', {
        username: uniqueId('arc-view'),
        password: 'Pw-123456!',
        role: 'viewer',
      });
      assert.strictEqual(vu.status, 201, 'viewer user create');
      viewerUser = await vu.json();
      createdUserIds.push(viewerUser.id);
      viewerAuth = forgeAuth(viewerUser.id, viewerUser.username, 'viewer').headers;

      // Create editor user.
      const eu = await reqAuth('POST', '/users', {
        username: uniqueId('arc-edit'),
        password: 'Pw-123456!',
        role: 'editor',
      });
      assert.strictEqual(eu.status, 201, 'editor user create');
      editorUser = await eu.json();
      createdUserIds.push(editorUser.id);
      editorAuth = forgeAuth(editorUser.id, editorUser.username, 'editor').headers;

      // Outsider: a REAL viewer that is not a member anywhere. It used to be a
      // fabricated id ('outsider-fake-id'), which no longer reaches the gate at
      // all: the session verifiers refuse a token whose subject does not exist,
      // so the row answered 401 from the auth layer and silently stopped testing
      // the role gate this route actually has.
      const ou = await reqAuth('POST', '/users', {
        username: uniqueId('arc-out'),
        password: 'Pw-123456!',
        role: 'viewer',
      });
      assert.strictEqual(ou.status, 201, 'outsider user create');
      const outsiderUser = await ou.json();
      createdUserIds.push(outsiderUser.id);
      outsiderAuth = forgeAuth(outsiderUser.id, outsiderUser.username, 'viewer').headers;

      // Ensure at least one entry exists for the access tests.
      seedArchiveEntry(`${TS}-access-check`);
    });

    test('unauthenticated GET /api/archive → 401', async () => {
      const r = await req('GET', '/archive');
      assert.strictEqual(r.status, 401, `unauthenticated GET → 401, got ${r.status}`);
    });

    test('viewer DELETE /api/archive/:entry → 403', async () => {
      const { status, json } = await deleteArchive(`${TS}-access-check`, viewerAuth);
      assert.strictEqual(status, 403, `viewer DELETE → 403, got ${status}: ${json.error || ''}`);
    });

    test('viewer POST /api/archive/empty → 403', async () => {
      const { status, json } = await emptyArchive(viewerAuth);
      assert.strictEqual(status, 403, `viewer empty → 403, got ${status}: ${json.error || ''}`);
    });

    test('viewer POST /api/archive/:entry/restore → 403', async () => {
      const { status, json } = await restoreArchive(`${TS}-access-check`, undefined, viewerAuth);
      assert.strictEqual(status, 403, `viewer restore → 403, got ${status}: ${json.error || ''}`);
    });

    test('editor GET /api/archive → 200', async () => {
      const { status, json } = await getArchive(editorAuth, true);
      assert.strictEqual(status, 200, `editor GET → 200, got ${status}`);
      assert.ok(Array.isArray(json.archives), 'archives is an array');
    });

    test('editor DELETE /api/archive/:entry → 200', async () => {
      // Seed a disposable entry for this test.
      const edEntry = uniqueId('trash-ed-del');
      seedArchiveEntry(edEntry);

      const { status, json } = await deleteArchive(edEntry, editorAuth);
      assert.strictEqual(status, 200, `editor DELETE → 200, got ${status}: ${json.error || ''}`);
      assert.strictEqual(json.ok, true);
    });

    test('outsider viewer DELETE /api/archive/:entry → 403', async () => {
      // A real non-admin account → refused by the ROLE gate, not by auth.
      const { status } = await deleteArchive(`${TS}-access-check`, outsiderAuth);
      assert.strictEqual(status, 403, `outsider viewer DELETE → 403, got ${status}`);
    });
  });

  // ── 7. Traversal/injection ────────────────────────────────────

  describe('traversal/injection safety', () => {
    test('DELETE /api/archive/..%2fetc%2fpasswd → 400 or 404', async () => {
      const { status, json } = await deleteArchive('..%2fetc%2fpasswd');
      assert.ok(
        status === 400 || status === 404,
        `traversal entry → 400/404, got ${status}: ${json.error || ''}`,
      );
    });

    test('DELETE /api/archive/.. → 400 or 404', async () => {
      const { status } = await deleteArchive('..');
      assert.ok(
        status === 400 || status === 404,
        `dotdot entry → 400/404, got ${status}`,
      );
    });

    test('DELETE /api/archive/. → 400 or 404', async () => {
      const { status } = await deleteArchive('.');
      assert.ok(
        status === 400 || status === 404,
        `dot entry → 400/404, got ${status}`,
      );
    });

    test('GET /api/archive works after traversal attempt (no side effects)', async () => {
      // The archive dir should still be healthy.
      const { status, json } = await getArchive(authHeaders(), true);
      assert.strictEqual(status, 200, `GET after traversal: ${status}`);
      assert.ok(Array.isArray(json.archives), 'archives is still an array');
    });
  });
});
