/**
 * projects-meta.test.ts — the slug trust boundary + meta-store data loss.
 *
 * Regression coverage for two defeated bugs:
 *   A. TRAVERSAL VIA THE SLUG. `deleteMeta('..')` used `path.dirname(metaFile('..'))`
 *      = `path.join(DATA_DIR, 'projects', '..')` and rm -rf'd the ENTIRE data
 *      directory (users.json / providers.json / audit.json / jwt.secret).
 *      `resolveWorkspacePath('..', 'etc/passwd')` did the same outside
 *      /workspaces — the rel-path guard sanitized only the RELATIVE part.
 *   B. SILENT WHOLE-DOC WIPE. `loadMeta() || {}` collapsed both ABSENT and
 *      CORRUPT meta to null, and every `loadMeta(s) || {}` + `saveMeta(s, meta)`
 *      mutation persisted a FIELD-ONLY document, destroying name/description/
 *      ports/env/limits/tags/ownerId/members. Corrupt meta also tripped the
 *      legacy "no membership data ⇒ open to all" access fallback.
 *
 * Offline units (temp data dir, real modules — same pattern as
 * session-revocation.test.ts): node --test loads them with Node 22
 * type-stripping + the ts-ext-resolve.mjs hook for extensionless imports.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';

register(new URL('./ts-ext-resolve.mjs', import.meta.url).href);

// Env MUST be set before the dynamic imports — projects-meta.ts / docker-manager.ts
// capture WSD_DATA_DIR / WSD_PROJECTS_DIR at import time, like the server.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsd-meta-'));
const projectsDir = path.join(dataDir, 'projects');
const workspacesDir = path.join(dataDir, 'workspaces');
process.env.WSD_DATA_DIR = dataDir;
process.env.WSD_PROJECTS_DIR = workspacesDir;
fs.mkdirSync(projectsDir, { recursive: true });
fs.mkdirSync(workspacesDir, { recursive: true });

const store = await import('../src/services/projects-meta.ts');
const wf = await import('../src/services/workspace-files.ts');
const slugCore = await import('../src/services/project-slug-core.ts');
const access = await import('../src/services/access-core.ts');
const auth = await import('../src/middleware/auth.ts');

const { HttpError } = slugCore;

// Sentinel that a wiped DATA_DIR would silently destroy (like a real jwt.secret).
const SENTINEL = path.join(dataDir, 'sentinel.txt');
fs.writeFileSync(SENTINEL, 'must-survive');

const metaFile = (slug: string) => path.join(projectsDir, slug, 'meta.json');
const getSentinel = () => fs.existsSync(SENTINEL) && fs.readFileSync(SENTINEL, 'utf8');

after(() => {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ── slug-core rules ────────────────────────────────────────────────────────
describe('project-slug-core', () => {
  test('the canonical fold makes traversal-shaped input unusable', () => {
    assert.strictEqual(slugCore.canonicalProjectSlug('..'), '');
    assert.strictEqual(slugCore.canonicalProjectSlug('.'), '');
    assert.strictEqual(slugCore.canonicalProjectSlug('/'), '');
    assert.strictEqual(slugCore.canonicalProjectSlug('a/b'), 'a-b');
    assert.strictEqual(slugCore.canonicalProjectSlug('../x'), 'x');
    assert.strictEqual(slugCore.canonicalProjectSlug('My_Project!'), 'my-project');
    assert.strictEqual(slugCore.canonicalProjectSlug(''), '');
  });

  test('assertSafeStoreSlug refuses anything that can escape the root', () => {
    const root = path.resolve(projectsDir);
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', '..\\x', '../x', 'a/../b']) {
      assert.throws(() => slugCore.assertSafeStoreSlug(bad, root), HttpError, `expected ${JSON.stringify(bad)} to throw`);
    }
    // Dot-bearing SINGLE segments are legit store keys (legacy slugs) — the
    // containment check is what makes dots safe.
    assert.strictEqual(slugCore.assertSafeStoreSlug('my.project_2', root), 'my.project_2');
    assert.strictEqual(slugCore.assertSafeStoreSlug('..x', root), '..x');
  });
});

// ── meta store: read tri-state + hardened delete ───────────────────────────
describe('readMeta — tri-state, never conflates absent with corrupt', () => {
  test('absent → {state:"absent", meta:null}; unsafe keys are absent, never paths', () => {
    assert.deepStrictEqual(store.readMeta('nope'), { state: 'absent', meta: null });
    // The regression: a `..` key used to resolve OUTSIDE the projects dir.
    assert.deepStrictEqual(store.readMeta('..'), { state: 'absent', meta: null });
    assert.deepStrictEqual(store.readMeta(''), { state: 'absent', meta: null });
    assert.strictEqual(getSentinel(), 'must-survive', 'reading a traversal key must not touch DATA_DIR');
  });

  test('ok round-trip after saveMeta preserves every field', () => {
    store.saveMeta('alpha', { activity: [], name: 'Alpha', ports: [8200], tags: ['t1'] });
    const read = store.readMeta('alpha');
    assert.strictEqual(read.state, 'ok');
    assert.strictEqual(read.meta?.name, 'Alpha');
    assert.deepStrictEqual(read.meta?.ports, [8200]);
  });

  test('a corrupted meta.json is CORRUPT, not absent — and loadMeta keeps null', () => {
    fs.mkdirSync(path.join(projectsDir, 'torn'), { recursive: true });
    fs.writeFileSync(metaFile('torn'), '{"name": "broken', 'utf8'); // truncated JSON
    assert.deepStrictEqual(store.readMeta('torn'), { state: 'corrupt', meta: null });
    assert.strictEqual(store.loadMeta('torn'), null, 'read-only contract preserved (null on both)');
    assert.throws(() => store.loadMetaStrict('torn'), /corrupt/i);
  });
});

describe('updateMeta — the silent-wipe fix', () => {
  test('mutates the REAL document (returns the saved doc) and saves atomically', () => {
    store.saveMeta('bravo', { activity: [], name: 'Bravo', description: 'd', tags: ['a'] });
    const out = store.updateMeta('bravo', (m) => { m.tags = ['b', 'c']; });
    assert.deepStrictEqual(out.tags, ['b', 'c']);
    assert.strictEqual(out.name, 'Bravo', 'unrelated fields survive');
    assert.strictEqual(out.description, 'd');
    assert.deepStrictEqual(fs.readdirSync(path.join(projectsDir, 'bravo')), ['meta.json'], 'no .tmp residue');
  });

  test('updateMeta on a CORRUPT store throws (500) and never overwrites', () => {
    const raw = '"garbage';
    fs.writeFileSync(metaFile('torn'), raw, 'utf8');
    assert.throws(() => store.updateMeta('torn', (m) => { m.name = 'X'; }), /corrupt/i);
    assert.strictEqual(fs.readFileSync(metaFile('torn'), 'utf8'), raw, 'the damaged file stays untouched');
  });

  test('markRequestedStop (the crash pre-stop flag) tolerates a CORRUPT store', () => {
    // The stop path must never be blocked by metadata it cannot read — and a
    // store it cannot parse must NEVER be overwritten (that is the only copy of
    // the project's name/ports/env/members).
    const raw = fs.readFileSync(metaFile('torn'), 'utf8');
    assert.doesNotThrow(() => store.markRequestedStop('torn'), 'an explicit stop must survive an unreadable store');
    assert.strictEqual(fs.readFileSync(metaFile('torn'), 'utf8'), raw, 'the damaged file stays untouched');
    // A store it CAN read is still marked (the crash detector contract).
    store.saveMeta('fresh-stop', { activity: [] });
    store.markRequestedStop('fresh-stop');
    assert.strictEqual(store.readMeta('fresh-stop').meta?.requestedStop, true);
  });

  test('updateMeta on a genuinely ABSENT store seeds init (fresh project)', () => {
    const out = store.updateMeta('charlie', (m) => { m.name = 'Charlie'; }, { activity: [] });
    assert.strictEqual(out.name, 'Charlie');
    assert.deepStrictEqual(store.readMeta('charlie'), { state: 'ok', meta: out });
  });
});

describe('deleteMeta — the data-wipe regression', () => {
  test('deleteMeta("..") throws 400 and DATA_DIR survives with its sentinel', () => {
    assert.throws(() => store.deleteMeta('..'), HttpError);
    assert.strictEqual(getSentinel(), 'must-survive', 'jwt.secret would have been rm -rf\'d');
    assert.strictEqual(store.readMeta('..').state, 'absent');
  });

  test('deleteMeta refuses separator + dot-path slugs', () => {
    assert.throws(() => store.deleteMeta('a/b'), HttpError);
    assert.throws(() => store.deleteMeta('.'), HttpError);
    assert.throws(() => store.deleteMeta(''), HttpError);
  });

  test('deleteMeta removes ONLY the target project dir', () => {
    store.saveMeta('delta', { activity: [] });
    store.deleteMeta('delta');
    assert.strictEqual(store.readMeta('delta').state, 'absent');
    assert.strictEqual(getSentinel(), 'must-survive');
    assert.strictEqual(store.readMeta('alpha').state, 'ok', 'sibling project untouched');
  });
});

// ── workspace-files: the slug, not just the rel, must be sandboxed ─────────
describe('workspace-files — slug containment', () => {
  test('resolveWorkspacePath("..", "etc/passwd") is refused (was: resolved outside /workspaces)', () => {
    // The regression path: rel="etc/passwd" is CLEAN; only the slug was escaping.
    assert.throws(() => wf.resolveWorkspacePath('..', 'etc/passwd'), HttpError);
    assert.throws(() => wf.resolveWorkspacePath('../x', 'etc/passwd'), HttpError);
    assert.throws(() => wf.resolveWorkspacePath('a/b', 'x.txt'), HttpError);
    assert.throws(() => wf.resolveWorkspacePath('.', 'x.txt'), HttpError);
  });

  test('a real project resolves inside its workspace; rel traversal still 400s', () => {
    const base = path.join(workspacesDir, 'proj');
    fs.mkdirSync(path.join(base, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(base, 'file.txt'), 'hello');
    assert.strictEqual(wf.resolveWorkspacePath('proj', ''), base);
    assert.strictEqual(wf.resolveWorkspacePath('proj', 'sub'), path.join(base, 'sub'));
    assert.throws(() => wf.resolveWorkspacePath('proj', '../x'), HttpError);
    assert.throws(() => wf.resolveWorkspacePath('proj', 'file.txt/../../x'), HttpError);
  });

  test('unknown project still 404s (contract preserved)', () => {
    assert.throws(() => wf.resolveWorkspacePath('ghost-project', 'x'), (e: any) => e.statusCode === 404);
  });

  // Finding 1 — a lexically-inside path can still ESCAPE through a symlink.
  // The rel-path guard + `target.startsWith(base)` check cannot see a symlink,
  // so resolveWorkspacePath must walk each component (lstat, reject links) and
  // confirm the realpath is still inside the real base. Without this a project
  // workspace could read /app/data/jwt.secret through a planted link.
  test('a symlinked FILE inside a workspace cannot be read through', () => {
    const base = path.join(workspacesDir, 'symproj');
    fs.mkdirSync(base, { recursive: true });
    const outside = path.join(dataDir, 'outside-secret.txt');
    fs.writeFileSync(outside, 'top-secret');
    try {
      fs.symlinkSync(outside, path.join(base, 'escape.txt'), 'file');
    } catch {
      return; // symlinks unsupported on this filesystem (Windows w/o privileges) — skip
    }
    assert.throws(() => wf.resolveWorkspacePath('symproj', 'escape.txt'), HttpError);
    assert.throws(() => wf.readWorkspaceFile('symproj', 'escape.txt'), HttpError);
  });

  test('a symlinked DIRECTORY component is refused before any child resolves', () => {
    const base = path.join(workspacesDir, 'symdir');
    fs.mkdirSync(base, { recursive: true });
    const outside = path.join(dataDir, 'outside-dir');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'top-secret');
    try {
      fs.symlinkSync(outside, path.join(base, 'link'), 'dir');
    } catch {
      return; // no symlink support — skip
    }
    assert.throws(() => wf.resolveWorkspacePath('symdir', 'link/secret.txt'), HttpError);
    assert.throws(() => wf.readWorkspaceFile('symdir', 'link/secret.txt'), HttpError);
  });

  test('a symlinked workspace ROOT (the slug dir itself) is refused', () => {
    const outside = path.join(dataDir, 'outside-root');
    fs.mkdirSync(outside, { recursive: true });
    try {
      fs.symlinkSync(outside, path.join(workspacesDir, 'symroot'), 'dir');
    } catch {
      return; // no symlink support — skip
    }
    assert.throws(() => wf.resolveWorkspacePath('symroot', ''), HttpError);
    assert.throws(() => wf.resolveWorkspacePath('symroot', 'x.txt'), HttpError);
  });

  // Finding 2 — the READ itself must be bounded, not just the response, so a
  // huge workspace file can never be slurped into memory only to be sliced.
  test('readWorkspaceFile reads at most the preview budget from a huge file', () => {
    const base = path.join(workspacesDir, 'bigproj');
    fs.mkdirSync(base, { recursive: true });
    const budget = 200 * 1024;
    fs.writeFileSync(path.join(base, 'big.txt'), 'a'.repeat(budget + 500));
    const preview = wf.readWorkspaceFile('bigproj', 'big.txt');
    assert.strictEqual(preview.truncated, true);
    assert.strictEqual(preview.size, budget + 500, 'reports the TRUE file size');
    assert.ok(
      preview.content.length <= budget + 64,
      `content bounded to the budget (got ${preview.content.length})`,
    );
  });

  test('resolveProjectSubdir stays non-throwing on a junk slug (ws-terminal contract)', () => {
    const info = wf.resolveProjectSubdir('..');
    assert.strictEqual(info.hostPath, path.resolve(workspacesDir), 'falls back to the workspace ROOT, never outside');
    assert.strictEqual(info.containerPath, '/workspace');
  });
});

// ── access-core: corrupt meta must not open the legacy fallback ────────────
describe('decideProjectAccess — metaState-aware', () => {
  const viewer = 'u-viewer';
  test('corrupt (meta null + state corrupt) → viewer denied, even for minRole viewer', () => {
    assert.deepStrictEqual(access.decideProjectAccess(viewer, 'viewer', null, 'viewer', 'corrupt'), { allowed: false });
  });
  test('absent legacy project → viewer still allowed (compat contract preserved)', () => {
    assert.deepStrictEqual(access.decideProjectAccess(viewer, 'viewer', null, 'viewer', 'absent'), { allowed: true, memberRole: 'editor' });
  });
  test('real membership still decides', () => {
    const meta = { ownerId: 'u-owner', members: [{ userId: viewer, role: 'viewer' as const, addedAt: '' }] };
    assert.deepStrictEqual(access.decideProjectAccess(viewer, 'viewer', meta, 'editor'), { allowed: false, memberRole: 'viewer' });
    assert.deepStrictEqual(access.decideProjectAccess(viewer, 'viewer', meta, 'viewer'), { allowed: true, memberRole: 'viewer' });
  });
});

// Finding 3 — a corrupt `members` value (not an array) must fail CLOSED with a
// clean denial, never throw through the middleware/WS gate as a 500.
describe('access-core — a non-array members value denies instead of throwing', () => {
  test('project-level', () => {
    const meta = { ownerId: 'someone', members: 'not-an-array' } as any;
    assert.doesNotThrow(() => access.decideProjectAccess('u', 'viewer', meta, 'admin'));
    assert.strictEqual(access.decideProjectAccess('u', 'viewer', meta, 'admin').allowed, false);
    assert.strictEqual(access.decideProjectAccess('u', 'viewer', meta, 'viewer').allowed, false);
  });
  test('control-level', () => {
    const meta = { ownerId: 'someone', members: {} } as any;
    assert.doesNotThrow(() => access.decideControlAccess('u', 'editor', meta));
    assert.strictEqual(access.decideControlAccess('u', 'editor', meta).allowed, false);
  });
});

// ── the middleware itself: canonicalize-once-before-the-gate ───────────────
describe('requireProjectAccess — canonicalize once, reject junk at the boundary', () => {
  // Mocked middleware chain over the REAL middleware (real readMeta against the
  // temp data dir). The slug is decoded first — Express decodes route params
  // before the handler runs, so a real '%2E%2E' reaches the middleware as '..'.
  function run(rawSlug: string, role = 'viewer', userId = 'u-tester') {
    let slug = rawSlug;
    try { slug = decodeURIComponent(rawSlug); } catch { /* malformed % stays raw */ }
    const req: any = { params: { slug }, user: { id: userId, role } };
    let status = 0;
    let body: any = null;
    let nexted = false;
    const res: any = {
      status: (s: number) => { status = s; return res; },
      json: (b: any) => { body = b; return res; },
    };
    const next = () => { nexted = true; };
    auth.requireProjectAccess('viewer')(req, res, next);
    return { status, body, nexted, slugPassed: req.params.slug };
  }

  test('junk / traversal-shaped slugs are 400 before any gate runs', () => {
    for (const bad of ['..', '.', '', '   ', 'a/b', 'a\\b', '%2E%2E']) {
      const r = run(bad);
      assert.strictEqual(r.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
      assert.strictEqual(r.nexted, false);
    }
  });

  test('a canonical (absent) slug keeps the legacy open contract for viewers', () => {
    const r = run('whatever-new');
    assert.strictEqual(r.nexted, true);
    assert.strictEqual(r.slugPassed, 'whatever-new', 'the canonical value is assigned to req.params');
  });

  test('a project with real membership denies a non-member viewer', () => {
    store.saveMeta('locked', {
      activity: [],
      ownerId: 'u-owner',
      members: [{ userId: 'u-member', role: 'viewer', addedAt: '' }],
    });
    const r = run('locked', 'viewer', 'u-intruder');
    assert.strictEqual(r.status, 403, 'non-member viewer is denied through the REAL middleware');
    assert.strictEqual(r.nexted, false);
  });

  test('a CORRUPT meta store denies instead of opening the legacy fallback', () => {
    fs.mkdirSync(path.join(projectsDir, 'cracked'), { recursive: true });
    fs.writeFileSync(metaFile('cracked'), '{broken json', 'utf8');
    const r = run('cracked', 'viewer', 'u-tester');
    assert.strictEqual(r.status, 403, 'corrupt membership data must not read as "legacy, allow all"');
    assert.strictEqual(r.nexted, false);
  });
});

// ── checkProjectAccess: a gate must never fold the value it is given ───────
// The direct callers (ws-chat / ws-agent / opencode-delegate / chat-team-access)
// are NOT middleware, so nothing folds the slug for them: `checkProjectAccess`
// used to fold internally, which meant the gate evaluated 'secret-plan' while
// the caller acted on 'secret.plan' (or the reverse). Folding silently is worse
// than refusing — it makes the decision about a project nobody asked about.
describe('checkProjectAccess — fails closed on an unfolded slug', () => {
  test('a dot-bearing store key is DENIED (the internal fold used to hide it behind the legacy fallback)', () => {
    store.saveMeta('secret.plan', {
      activity: [],
      ownerId: 'u-owner',
      members: [{ userId: 'u-dotted-member', role: 'viewer', addedAt: '' }],
    });
    // `u-dotted-member` is only a VIEWER of the real project 'secret.plan'. The
    // fold resolved it to 'secret-plan', which has no store → the legacy
    // "no membership data ⇒ editor" fallback handed out editor-level access.
    assert.deepStrictEqual(
      auth.checkProjectAccess('u-dotted-member', 'viewer', 'secret.plan', 'editor'),
      { allowed: false },
      'an unfolded slug must be refused, never re-resolved',
    );
    assert.deepStrictEqual(
      auth.checkProjectAccess('u-dotted-member', 'viewer', 'secret.plan', 'viewer'),
      { allowed: false },
      'refusal is not minRole-dependent: there is no store entry to reason about',
    );
  });

  test('after the caller canonicalizes, ONE value gates and acts', () => {
    store.saveMeta('secret-plan', {
      activity: [],
      ownerId: 'u-owner',
      members: [{ userId: 'u-can-member', role: 'editor', addedAt: '' }],
    });
    const canonical = slugCore.canonicalProjectSlug('secret.plan');
    assert.strictEqual(canonical, 'secret-plan');
    // Real membership decides, for the value both the gate and the downstream
    // workspace/meta lookup now use.
    assert.strictEqual(auth.checkProjectAccess('u-intruder', 'viewer', canonical, 'viewer').allowed, false);
    assert.strictEqual(auth.checkProjectAccess('u-can-member', 'viewer', canonical, 'editor').allowed, true);
    // Idempotence is what makes "gate value === acted-on value" structural.
    assert.strictEqual(slugCore.canonicalProjectSlug(canonical), canonical);
  });

  test('a junk / empty slug is refused outright', () => {
    for (const junk of ['', '   ', '.', '..', 'a/b', 'a\\b', '../x']) {
      assert.deepStrictEqual(auth.checkProjectAccess('u-tester', 'viewer', junk, 'viewer'), { allowed: false }, JSON.stringify(junk));
    }
  });
});