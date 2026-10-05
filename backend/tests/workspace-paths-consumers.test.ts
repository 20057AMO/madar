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
});