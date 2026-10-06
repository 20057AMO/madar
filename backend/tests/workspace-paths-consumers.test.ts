/**
 * workspace-paths-consumers.test.ts
 * The real callers, driven against a temp data dir — every one of these modules
 * used to carry its OWN containment logic, which is how the same class of escape
 * was re-implemented five times with five different weaknesses:
 *
 *   - Files: links were followed (lstat/realpath were never consulted), so a
 *     planted `escape -> /app/data` read and wrote host files; nested creation
 *     was refused outright; deleting a link deleted its TARGET.
 *   - copyWorkspaceTree (duplicate / clone): readdir + statSync FOLLOWED links,
 *     so duplicating a project copied whatever a link pointed at into the new
 *     workspace — and a destination link could redirect the write.
 *   - agent tools: `path.resolve(base, rel)` + startsWith, lexical only, and the
 *     fallback `cwd` was built the same lax way.
 *   - project-context: the same, for the AI context scanner.
 *
 * The primitive itself is covered by workspace-paths-core.test.ts; this file
 * exists to prove each CONSUMER actually routes through it, which a unit test of
 * the primitive alone cannot.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';

register(new URL('./ts-ext-resolve.mjs', import.meta.url).href);

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsd-wcons-'));
const projectsDir = path.join(dataDir, 'projects');
const workspacesDir = path.join(dataDir, 'workspaces');
// Env BEFORE the dynamic imports: the modules capture these at import time.
process.env.WSD_DATA_DIR = dataDir;
process.env.WSD_PROJECTS_DIR = workspacesDir;
fs.mkdirSync(projectsDir, { recursive: true });
fs.mkdirSync(workspacesDir, { recursive: true });

const wf = await import('../src/services/workspace-files.ts');
const dm = await import('../src/services/docker-manager.ts');
const agents = await import('../src/services/agent-tools.ts');
const ctx = await import('../src/services/project-context.ts');
const store = await import('../src/services/projects-meta.ts');
const notesSvc = await import('../src/services/project-notes.ts');
const canvasSvc = await import('../src/services/project-canvas.ts');
const reviews = await import('../src/services/project-reviews.ts');

const { HttpError } = await import('../src/services/project-slug-core.ts');

const SECRET = 'TOP-SECRET';
let outside = '';

/** Create a project workspace dir and a live (readable) meta document for it. */
function makeProject(slug: string): string {
  const dir = path.join(workspacesDir, slug);
  fs.mkdirSync(dir, { recursive: true });
  store.saveMeta(slug, { name: slug, description: 'd', ownerId: 'u-owner', members: [] } as any);
  return dir;
}

function plantLink(t: any, linkPath: string, target: string, type: 'file' | 'dir'): boolean {
  try {
    fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : type);
    return true;
  } catch {
    t.skip(`this platform refused to create a link at ${linkPath}`);
    return false;
  }
}

before(() => {
  outside = path.join(dataDir, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), SECRET, 'utf8');
  fs.mkdirSync(path.join(outside, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(outside, 'sub', 'nested.txt'), SECRET, 'utf8');
});

after(() => {
  // rmSync never follows links, so this cannot escape the temp dir.
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('workspace-files · the Files tab surface', () => {
  test('a write in a NEW nested folder is created again (the regression the old guard caused)', () => {
    const slug = 'nested-create';
    makeProject(slug);
    const out = wf.writeWorkspaceFile(slug, 'src/deep/inner/new.ts', 'export const a = 1;\n');
    assert.strictEqual(out.path, 'src/deep/inner/new.ts');
    assert.ok(fs.existsSync(path.join(workspacesDir, slug, 'src', 'deep', 'inner', 'new.ts')));
    assert.strictEqual(
      fs.readFileSync(path.join(workspacesDir, slug, 'src', 'deep', 'inner', 'new.ts'), 'utf8'),
      'export const a = 1;\n'
    );
  });

  test('rename moves a file INTO a new folder and refuses traversal', () => {
    const slug = 'rename-flow';
    const dir = makeProject(slug);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'A', 'utf8');
    wf.renameWorkspacePath(slug, 'a.txt', 'moved/b.txt');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'moved', 'b.txt'), 'utf8'), 'A');
    assert.ok(!fs.existsSync(path.join(dir, 'a.txt')), 'the source is gone after a move');
    assert.throws(() => wf.renameWorkspacePath(slug, 'moved/b.txt', '../escaped.txt'), HttpError);
    assert.throws(() => wf.renameWorkspacePath(slug, '../outside/secret.txt', 'x.txt'), HttpError);
  });

  test('rename is NOT the check-then-use the primitive replaced: a link destination never escapes', (t) => {
    // A unit test of renameContainedPath cannot show that the Files tab ROUTE
    // reaches it, and the old code did its own `mkdir -r` + path-based
    // `renameSync` here, so this row is the one that would have caught the sink.
    const slug = 'rename-link-dest';
    const dir = makeProject(slug);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'ATTACKER', 'utf8');
    if (!plantLink(t, path.join(dir, 'd'), outside, 'dir')) return;

    // The planted link is the destination's INTERMEDIATE directory, which is the
    // only part of a rename the kernel follows — a link at the leaf is replaced,
    // never written through.
    assert.throws(() => wf.renameWorkspacePath(slug, 'a.txt', 'd/secret.txt'), HttpError);
    assert.throws(() => wf.renameWorkspacePath(slug, 'a.txt', 'd/planted-by-rename.txt'), HttpError);
    assert.strictEqual(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), SECRET, 'the outside target is untouched');
    assert.ok(
      !fs.existsSync(path.join(outside, 'planted-by-rename.txt')),
      'the rename must not CREATE a file outside the workspace either'
    );

    // And the source survives every refusal, so the operation is not half-done.
    assert.strictEqual(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'ATTACKER');

    // Same source, a real destination: still works after the refusals.
    wf.renameWorkspacePath(slug, 'a.txt', 'fresh/nested/ok.txt');
    assert.strictEqual(fs.readFileSync(path.join(dir, 'fresh', 'nested', 'ok.txt'), 'utf8'), 'ATTACKER');
  });

  test('a rename refusal never answers 500 with a raw filesystem message', () => {
    const slug = 'rename-msg';
    const dir = makeProject(slug);
    fs.mkdirSync(path.join(dir, 'dir'), { recursive: true });
    // EINVAL in the kernel, an absolute path in the message.
    assert.throws(
      () => wf.renameWorkspacePath(slug, 'dir', 'dir/inner'),
      (e: any) => {
        assert.ok(e instanceof HttpError, 'the route must receive an HttpError, not a raw fs error');
        assert.ok(e.statusCode >= 400 && e.statusCode < 500, `expected a 4xx, got ${e.statusCode}`);
        assert.ok(
          !String(e.message).includes(workspacesDir) && !String(e.message).includes(os.tmpdir()),
          `the client message leaked a host path: ${e.message}`
        );
        return true;
      }
    );
  });

  test('reviews.fileExists is a containment check, not a host-file existence oracle', (t) => {
    // The last viewer-reachable lexical path check: a lexical resolve +
    // startsWith proved nothing about links and statSync FOLLOWED them, so a
    // thread pinned on `escape/secret.txt` behind a planted link answered
    // "true" for a file outside the workspace. listReviews is viewer-gated, so
    // this is a read primitive reachable by the least-privileged member.
    const slug = 'reviews-fileexists';
    const dir = makeProject(slug);
    fs.writeFileSync(path.join(dir, 'present.ts'), 'ts', 'utf8');
    if (!plantLink(t, path.join(dir, 'escape'), outside, 'dir')) return;

    const thread = (id: string, p: string) => ({
      id,
      path: p,
      status: 'open',
      createdAt: new Date().toISOString(),
      createdBy: 'u-owner',
      createdByName: 'owner',
      comments: [],
    });
    fs.writeFileSync(
      path.join(projectsDir, slug, 'reviews.json'),
      JSON.stringify([thread('r-1', 'present.ts'), thread('r-2', 'escape/secret.txt'), thread('r-3', 'escape/nope.txt')]),
      'utf8'
    );

    const listed = reviews.listReviews(slug);
    const byPath = new Map(listed.threads.map((t2: any) => [t2.path, t2.fileExists]));
    assert.strictEqual(byPath.get('present.ts'), true, 'a real file in the workspace is still reported present');
    // The link's target EXISTS on disk — the old statSync answered true here.
    assert.strictEqual(byPath.get('escape/secret.txt'), false, 'a link must never report the outside target as present');
    assert.strictEqual(byPath.get('escape/nope.txt'), false);
  });

  test('a listed link is reported as type "link" and never traversed', (t) => {
    const slug = 'list-links';
    const dir = makeProject(slug);
    fs.mkdirSync(path.join(dir, 'real'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'real', 'ok.txt'), 'ok', 'utf8');
    if (!plantLink(t, path.join(dir, 'escape'), outside, 'dir')) return;

    const listing = wf.listWorkspaceFiles(slug, '');
    const names = listing.entries.map((f: any) => f.path);
    assert.ok(names.includes('real'), 'real files are still listed');
    const link = listing.entries.find((f: any) => f.path === 'escape');
    assert.ok(link, 'a link must be VISIBLE, never silently hidden');
    assert.strictEqual(link.type, 'link', 'a link is its own type, not a dir');
    // A link is billed by the link's OWN size (lstat), never the target's — the
    // same rule storage-core follows — so a link to a 4 GiB file cannot inflate
    // or misreport this project's usage.
    const secretStat = fs.lstatSync(path.join(outside, 'secret.txt'));
    assert.notStrictEqual(link.size, undefined);
    assert.ok(link.size < 4096, `a link must bill its own entry size, got ${link.size} (target is ${secretStat.size})`);
    assert.strictEqual(listing.dirCount, 1, 'a linked dir is NOT counted as a dir');
  });

  test('deleting a link removes the LINK, never its target', (t) => {
    const slug = 'delete-link';
    const dir = makeProject(slug);
    if (!plantLink(t, path.join(dir, 'escape'), outside, 'dir')) return;

    const res = wf.deleteWorkspacePath(slug, 'escape');
    assert.strictEqual(res.type, 'link');
    assert.ok(!fs.existsSync(path.join(dir, 'escape')) || fs.lstatSync(path.join(dir, 'escape')).isSymbolicLink());
    assert.strictEqual(
      fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'),
      SECRET,
      'the link target must survive a link delete'
    );
    assert.ok(fs.existsSync(path.join(outside, 'sub')), 'a linked DIRECTORY is not removed either');
  });

  test('a write THROUGH a planted link is refused and the target is untouched', (t) => {
    const slug = 'write-escape';
    const dir = makeProject(slug);
    if (!plantLink(t, path.join(dir, 'escape'), outside, 'dir')) return;

    assert.throws(() => wf.writeWorkspaceFile(slug, 'escape/secret.txt', 'PWNED'), HttpError);
    assert.throws(() => wf.readWorkspaceFile(slug, 'escape/secret.txt'), HttpError);
    assert.throws(() => wf.deleteWorkspacePath(slug, 'escape/secret.txt'), HttpError);
    assert.strictEqual(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), SECRET, 'nothing was written');
  });

  test('a link LEAF is refused for read/write, so a link file cannot be clobbered', (t) => {
    const slug = 'leaf-escape';
    const dir = makeProject(slug);
    if (!plantLink(t, path.join(dir, 'secret.txt'), path.join(outside, 'secret.txt'), 'file')) return;
    assert.throws(() => wf.writeWorkspaceFile(slug, 'secret.txt', 'PWNED'), HttpError);
    assert.throws(() => wf.readWorkspaceFile(slug, 'secret.txt'), HttpError);
    assert.strictEqual(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), SECRET);
    // Deleting the link itself IS allowed — that is the only link-aware operation.
    assert.strictEqual(wf.deleteWorkspacePath(slug, 'secret.txt').type, 'link');
    assert.strictEqual(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), SECRET);
  });

  test('resolveProjectSubdir stays non-throwing on a junk slug (the ws-terminal contract)', () => {
    assert.doesNotThrow(() => wf.resolveProjectSubdir('..'));
    assert.doesNotThrow(() => wf.resolveProjectSubdir(''));
  });
});

describe('copyWorkspaceTree · duplicate / clone', () => {
  test('a planted link in the source is SKIPPED, never copied as a file', (t) => {
    const src = path.join(dataDir, 'copy-src');
    const dst = path.join(dataDir, 'copy-dst');
    fs.mkdirSync(path.join(src, 'real'), { recursive: true });
    fs.writeFileSync(path.join(src, 'real', 'ok.txt'), 'ok', 'utf8');
    fs.writeFileSync(path.join(src, 'top.txt'), 'top', 'utf8');
    if (!plantLink(t, path.join(src, 'escape'), outside, 'dir')) return;

    dm.copyWorkspaceTree(src, dst);

    assert.ok(fs.existsSync(path.join(dst, 'real', 'ok.txt')), 'real files are copied');
    assert.strictEqual(fs.readFileSync(path.join(dst, 'top.txt'), 'utf8'), 'top');
    assert.ok(!fs.existsSync(path.join(dst, 'escape')), 'the link is NOT recreated in the copy');
    // The decisive assertion: the old statSync-followed-links version copied the
    // target's CONTENT into the new workspace (an exfiltration primitive).
    const copied = fs.existsSync(path.join(dst, 'secret.txt')) || fs.existsSync(path.join(dst, 'escape', 'secret.txt'));
    assert.strictEqual(copied, false, 'no target content may be materialised in the copy');
  });

  test('a link in the DESTINATION is refused, never followed', (t) => {
    const src = path.join(dataDir, 'copy-src2');
    const dst = path.join(dataDir, 'copy-dst2');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'payload.txt'), 'payload', 'utf8');
    if (!plantLink(t, dst, outside, 'dir')) return;

    assert.throws(() => dm.copyWorkspaceTree(src, dst), HttpError, 'writing into a linked destination must be refused');
    assert.strictEqual(
      fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'),
      SECRET,
      'the link target is untouched'
    );
    assert.ok(!fs.existsSync(path.join(outside, 'payload.txt')), 'nothing was written through the destination link');
  });
});

describe('agent-tools · file + tree + cwd', () => {
  // The agent tools answer with STRINGS, never throws — "no such file" instead of
  // a 500 is their documented contract. So the security assertion is that the
  // refusal marker comes back AND the target's content never does.
  test('a read through a planted link returns the not-found marker, never the target', (t) => {
    const slug = 'agent-escape';
    const dir = makeProject(slug);
    fs.writeFileSync(path.join(dir, 'ok.txt'), 'ok', 'utf8');
    if (!plantLink(t, path.join(dir, 'escape'), outside, 'dir')) return;

    const viaLink = agents.readFile(slug, 'escape/secret.txt');
    assert.ok(!viaLink.includes(SECRET), 'the link target content must never be returned');
    assert.match(viaLink, /not found|invalid/i);

    const viaTraversal = agents.readFile(slug, '../outside/secret.txt');
    assert.ok(!viaTraversal.includes(SECRET), 'traversal must never return the target');
    assert.match(viaTraversal, /not found|invalid/i);

    assert.strictEqual(agents.writeFile(slug, 'escape/secret.txt', 'PWNED'), 'Invalid path');
    assert.strictEqual(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), SECRET, 'nothing was written');
    assert.ok(agents.readFile(slug, 'ok.txt').includes('ok'), 'legitimate reads still work');
  });

  test('writeFile CREATES a new file and a new nested folder again (the 0-of-5000 regression)', () => {
    // `writeFile` is the primary tool of every `edit: allow` subagent, and
    // resolving its path with the READ default (mustExist) made every create
    // answer "Invalid path" — measured 0 successful writes in 5000 calls. A
    // file and a folder that do not exist yet are the normal case for this
    // tool, so this row is the regression guard, not a nicety.
    const slug = 'agent-create';
    const dir = makeProject(slug);
    assert.match(agents.writeFile(slug, 'src/index.ts', 'export const a = 1;\n'), /^Wrote /);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'src', 'index.ts'), 'utf8'), 'export const a = 1;\n');

    // A NESTED path whose folders do not exist yet — the Files-tab regression
    // that had to be restored once already.
    assert.match(agents.writeFile(slug, 'deep/a/b/c/new.txt', 'nested'), /^Wrote /);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'deep', 'a', 'b', 'c', 'new.txt'), 'utf8'), 'nested');

    // Overwriting an existing file keeps working.
    assert.match(agents.writeFile(slug, 'src/index.ts', 'v2'), /^Wrote /);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'src', 'index.ts'), 'utf8'), 'v2');
    assert.match(agents.readFile(slug, 'src/index.ts'), /v2/);
  });

  test('writeFile refuses a planted link, and reports it as a MARKER rather than throwing', (t) => {
    const slug = 'agent-write-link';
    const dir = makeProject(slug);
    fs.writeFileSync(path.join(outside, 'agent-canary.txt'), 'CANARY', 'utf8');
    if (!plantLink(t, path.join(dir, 'agent-canary.txt'), path.join(outside, 'agent-canary.txt'), 'file')) {
      // Windows cannot create an unelevated FILE link; the directory form
      // below covers the same primitive, so only fall through when neither
      // shape can be made.
      if (!plantLink(t, path.join(dir, 'agentdir'), outside, 'dir')) return;
      const viaDir = agents.writeFile(slug, 'agentdir/agent-canary.txt', 'PWNED');
      assert.strictEqual(fs.readFileSync(path.join(outside, 'agent-canary.txt'), 'utf8'), 'CANARY');
      assert.ok(!viaDir.includes('PWNED'), 'a refusal must not report a successful write');
      assert.match(viaDir, /Invalid path|Cannot write|refus/i);
      return;
    }

    const result = agents.writeFile(slug, 'agent-canary.txt', 'PWNED');
    // The tool contract is a STRING, like readFile's `[File not found: …]`.
    assert.strictEqual(typeof result, 'string');
    assert.match(result, /Invalid path|Cannot write|refus/i, 'a refusal is reported, not thrown');
    assert.strictEqual(
      fs.readFileSync(path.join(outside, 'agent-canary.txt'), 'utf8'),
      'CANARY',
      'the link target must be untouched'
    );
  });

  test('writeFile reports a MISSING project as a marker, never a raw ENOENT', () => {
    // 748 of 5000 calls threw a raw ENOENT straight out of writeFile: the tool
    // promises a string (readFile answers "[File not found: …]"), so an
    // unhandled throw escaped to the dispatcher and surfaced as a tool crash
    // rather than a sentence the model can act on.
    let result: string | null = null;
    assert.doesNotThrow(() => {
      result = agents.writeFile('no-such-project-at-all', 'a.txt', 'x');
    });
    assert.strictEqual(typeof result, 'string');
    assert.ok(!/^Wrote/.test(result!), `a missing project must not report a write: ${result}`);
  });

  test('the tree omits links and their targets', (t) => {
    const slug = 'agent-tree';
    const dir = makeProject(slug);
    fs.writeFileSync(path.join(dir, 'ok.txt'), 'ok', 'utf8');
    if (!plantLink(t, path.join(dir, 'escape'), outside, 'dir')) return;

    const tree = agents.getProjectTree(slug, 3);
    assert.ok(tree.includes('ok.txt'), 'real entries are listed');
    assert.ok(!tree.includes(SECRET), 'a link must never surface the target content');
    assert.ok(!tree.includes('escape/secret.txt'), 'a link must not be walked');
  });
});

describe('project-notes · project-canvas · the STORE key', () => {
  // Both stores wrote `path.join(<data>/projects, slug, 'notes.json' | 'canvas.json')`
  // behind a dot-preserving filter. Dots are deliberately KEPT so legacy project
  // dirs (`my.project_2`) stay addressable on disk — which means `..` survived the
  // very filter meant to sanitize the slug, and the join walked out of the store
  // root. Only the ROUTE's slug canonicalization stood in the way, and routing
  // is not containment: any future caller that reaches a store service without
  // that middleware inherits the escape.
  const STORE_DIR = path.join(dataDir, 'projects');

  test('notes refuses a `..` store slug instead of writing beside the store', () => {
    makeProject('store-safe');
    assert.throws(
      () => notesSvc.saveNotes('..', { items: [{ text: 'escaped', kind: 'idea' }] }),
      HttpError,
      'a `..` slug must never resolve to <data>/notes.json'
    );
    assert.ok(!fs.existsSync(path.join(dataDir, 'notes.json')), 'nothing may be written beside the store root');
    // The ordinary case still round-trips.
    const saved = notesSvc.saveNotes('store-safe', { items: [{ text: 'in the store', kind: 'goal' }] });
    assert.strictEqual(saved.items.length, 1);
    assert.ok(fs.existsSync(path.join(STORE_DIR, 'store-safe', 'notes.json')));
  });

  test('canvas refuses a `..` store slug for both the document and the workspace mirror', () => {
    makeProject('canvas-safe');
    assert.throws(() => canvasSvc.saveCanvas('..', { nodes: [{ id: 'n1', x: 1, y: 2, text: 'escaped' }], edges: [] }), HttpError);
    assert.ok(!fs.existsSync(path.join(dataDir, 'canvas.json')), 'nothing may be written beside the store root');
    assert.ok(!fs.existsSync(path.join(workspacesDir, '..', 'WSD_CANVAS.md')) || !fs.existsSync(path.join(dataDir, 'WSD_CANVAS.md')), 'no mirror may escape either');
    // And the ordinary case still writes BOTH the document and the fixed mirror.
    canvasSvc.saveCanvas('canvas-safe', { nodes: [{ id: 'n1', x: 1, y: 2, text: 'plan' }], edges: [] });
    assert.ok(fs.existsSync(path.join(STORE_DIR, 'canvas-safe', 'canvas.json')));
    assert.ok(
      fs.existsSync(path.join(workspacesDir, 'canvas-safe', 'WSD_CANVAS.md')),
      'the mirror keeps its FIXED basename, derived from the workspace slug'
    );
  });

  test('a LEGACY dotted slug still resolves on disk (dots are not a security control)', () => {
    // The complement of the row above: hardening the store key must NOT stop
    // addressing an existing `my.project_2` directory, or every legacy
    // project's notes and canvas would appear to vanish.
    const slug = 'my.project_2';
    fs.mkdirSync(path.join(workspacesDir, slug), { recursive: true });
    notesSvc.saveNotes(slug, { items: [{ text: 'legacy', kind: 'idea' }] });
    assert.ok(fs.existsSync(path.join(STORE_DIR, slug, 'notes.json')), 'a dotted legacy slug stays addressable');
    canvasSvc.saveCanvas(slug, { nodes: [{ id: 'n1', x: 0, y: 0, text: 'legacy board' }], edges: [] });
    assert.ok(fs.existsSync(path.join(STORE_DIR, slug, 'canvas.json')));
    assert.strictEqual(canvasSvc.canvasNodeCount(slug), 1);
  });

  test('the canvas mirror cannot be written through a planted link (link-free, fixed name)', (t) => {
    const slug = 'canvas-mirror-link';
    const dir = makeProject(slug);
    fs.writeFileSync(path.join(outside, 'mirror-canary.txt'), 'CANARY', 'utf8');
    if (!plantLink(t, path.join(dir, 'WSD_CANVAS.md'), path.join(outside, 'mirror-canary.txt'), 'file')) return;

    // The name is FIXED (never client-supplied), so this is exactly the shape a
    // workspace can reach: a user drops a link called WSD_CANVAS.md, then any
    // later save would write through it with the plan text.
    canvasSvc.saveCanvas(slug, { nodes: [{ id: 'n1', x: 0, y: 0, text: 'the plan' }], edges: [] });
    canvasSvc.applyCanvasOps(slug, [{ op: 'node-patch', id: 'n1', patch: { text: 'revised' } }]);

    assert.strictEqual(
      fs.readFileSync(path.join(outside, 'mirror-canary.txt'), 'utf8'),
      'CANARY',
      'the mirror write must not land on the link target'
    );
  });
});

describe('project-context · the AI context scanner', () => {
  test('a linked workspace BASE is refused instead of being scanned', (t) => {
    const linkedSlug = 'ctx-linked';
    if (!plantLink(t, path.join(workspacesDir, linkedSlug), outside, 'dir')) return;
    // resolveWorkspaceBase alone passes this: the slug is a safe single segment
    // lexically inside the real root. Only the base lstat refuses it, because
    // everything below would then walk the LINK'S TARGET and feed those files
    // into the AI context block.
    assert.throws(
      () => ctx.safeWorkspaceDir(linkedSlug),
      /not a real directory|invalid/i,
      'a project whose base is a link must not produce AI context'
    );
  });

  test('a project workspace that does not exist yet is still not an error', () => {
    // The contract must survive: create-in-flight has no directory yet.
    assert.strictEqual(ctx.safeWorkspaceDir('ctx-not-created-yet'), path.join(fs.realpathSync(workspacesDir), 'ctx-not-created-yet'));
  });

  test('a real project still resolves and scans', () => {
    const slug = 'ctx-real';
    const dir = makeProject(slug);
    fs.writeFileSync(path.join(dir, 'README.md'), '# Hi', 'utf8');
    assert.strictEqual(ctx.safeWorkspaceDir(slug), dir);
    assert.ok(typeof ctx.getProjectContext === 'function');
  });

  test('a planted WSD_PROJECT.md link never reaches the AI context — refused, not followed', async (t) => {
    // F2: the goals read was a bare existsSync+readFileSync, both of which
    // FOLLOW a link, so `WSD_PROJECT.md -> /app/data/jwt.secret` was pasted
    // into every prompt with no race at all.
    const slug = 'ctx-goals-link';
    const dir = makeProject(slug);
    const secretText = 'LEAK-TOKEN-9271';
    fs.writeFileSync(path.join(outside, 'ctx-secret.txt'), secretText, 'utf8');
    if (!plantLink(t, path.join(dir, 'WSD_PROJECT.md'), path.join(outside, 'ctx-secret.txt'), 'file')) return;

    // The naive read this replaced follows the link wherever the platform can
    // resolve one. Where it resolves, this witness proves the row is a real
    // leak the primitive had to close; where it cannot (Windows file links),
    // the refusal marker below is still the honest regression guard — the old
    // code silently DROPPED the section instead of reporting the refusal.
    let naive = '';
    try {
      naive = fs.readFileSync(path.join(dir, 'WSD_PROJECT.md'), 'utf8');
    } catch {
      t.diagnostic('platform cannot resolve a file link — refusal asserted, follow-witness skipped');
    }

    // Deterministic: no docker inspect roundtrip in an offline suite.
    ctx.setContextDockerSource({
      listProjects: async () => [],
      getProject: async () => null,
      projectLogs: async () => '',
    });
    try {
      const out = await ctx.getProjectContext(slug);
      assert.ok(!out.text.includes(secretText), 'the planted link must never reach the AI context');
      assert.match(
        out.text,
        /refused — not a regular file/,
        'a refused goals file must be reported explicitly, never silently dropped'
      );
      if (naive === secretText) {
        t.diagnostic('follow-witness: the naive read DID see the target, the context did not');
      }
      assert.strictEqual(fs.readFileSync(path.join(outside, 'ctx-secret.txt'), 'utf8'), secretText, 'the link target is untouched');
    } finally {
      ctx.setContextDockerSource(null);
    }
  });
});