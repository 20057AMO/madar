/**
 * workspace-paths-core.test.ts
 * Offline units for the shared workspace-containment primitive — the sandbox
 * every Files / upload / copy / agent / context path now goes through.
 *
 * Link cases are asserted with JUNCTIONS on Windows (no elevation needed) and
 * real symlinks elsewhere; `t.skip` marks a platform that cannot create one,
 * so a row can never pass vacuously by returning early.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';

// The modules under test import each other extensionless (correct for the
// compiled output, unresolvable by node's ESM loader) — see
// tests/ts-ext-resolve.mjs. Static imports are hoisted and resolved BEFORE
// register() runs, so the hook must be installed first and the module under
// test pulled in dynamically (same pattern as embed-proxy.test.ts).
register(new URL('./ts-ext-resolve.mjs', import.meta.url).href);

const {
  realWorkspaceRoot,
  resolveWorkspaceBase,
  resolveContainedPath,
  tryResolveContainedPath,
  workspaceLinkAt,
  parseUploadPaths,
  uploadRelativePath,
} = await import('../src/services/workspace-paths-core.ts');

let root = '';
let outside = '';
const SLUG = 'demo';

function plantLink(linkName: string, target: string): 'ok' | 'skip' {
  const linkPath = path.join(root, SLUG, linkName);
  try {
    // 'junction' is the Windows form that needs no elevation; on POSIX the
    // type argument is ignored and this is a plain symlink.
    fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    return 'ok';
  } catch {
    return 'skip';
  }
}

before(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wsd-wpaths-'));
  root = path.join(base, 'workspaces');
  outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, SLUG, 'real-dir'), { recursive: true });
  fs.mkdirSync(path.join(root, SLUG, 'real-dir', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(root, SLUG, 'real-dir', 'nested', 'a.txt'), 'inside', 'utf8');
  fs.writeFileSync(path.join(root, SLUG, 'top.txt'), 'top', 'utf8');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET', 'utf8');
});

after(() => {
  // rmSync does not follow links, so this cannot escape the temp dir.
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe('workspace-paths-core · root + slug', () => {
  test('the root is realpath-ed, not taken from the env value', () => {
    assert.strictEqual(realWorkspaceRoot(root), fs.realpathSync(root));
  });

  test('a slug with a separator / dot-path is refused (400)', () => {
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', '../etc', null, undefined, 'has space/x']) {
      assert.throws(
        () => resolveWorkspaceBase(root, bad),
        (e: any) => e?.statusCode === 400,
        `slug ${JSON.stringify(bad)} must be refused`
      );
    }
  });

  test('a legacy dotted slug still resolves (dots are storage-legal)', () => {
    const base = resolveWorkspaceBase(root, 'my.project_2');
    assert.ok(base.startsWith(fs.realpathSync(root)));
    assert.ok(base.endsWith('my.project_2'));
  });

  test('a missing project dir is 404, not a silent pass', () => {
    assert.throws(
      () => resolveContainedPath(root, 'no-such-project'),
      (e: any) => e?.statusCode === 404
    );
  });
});

describe('workspace-paths-core · traversal', () => {
  test('a relative path cannot climb out', () => {
    for (const bad of ['../secret.txt', 'real-dir/../../secret.txt', '..\\secret.txt']) {
      assert.throws(
        () => resolveContainedPath(root, SLUG, bad),
        (e: any) => e?.statusCode === 400,
        `path ${bad} must be refused`
      );
    }
  });

  test('a leading-slash path is read as workspace-relative, never as an absolute one', () => {
    // Documented contract: leading slashes are stripped, so '/etc/passwd' means
    // <workspace>/etc/passwd. What matters is that it can never resolve to the
    // host's /etc/passwd — a missing in-workspace path is a 404, not a 200.
    assert.throws(
      () => resolveContainedPath(root, SLUG, '/etc/passwd'),
      (e: any) => e?.statusCode === 404
    );
    assert.strictEqual(
      resolveContainedPath(root, SLUG, '/top.txt', { mustExist: false }),
      path.join(root, SLUG, 'top.txt')
    );
  });

  test('a missing target is 404 by default and allowed for create flows', () => {
    assert.throws(
      () => resolveContainedPath(root, SLUG, 'nope.txt'),
      (e: any) => e?.statusCode === 404
    );
    const created = resolveContainedPath(root, SLUG, 'brand/new/file.txt', { mustExist: false });
    assert.strictEqual(created, path.join(root, SLUG, 'brand', 'new', 'file.txt'));
  });

  test('"file.txt/child.txt" is an invalid path, never a later mkdir 500', () => {
    assert.throws(
      () => resolveContainedPath(root, SLUG, 'top.txt/child.txt', { mustExist: false }),
      (e: any) => e?.statusCode === 400
    );
  });
});

describe('workspace-paths-core · symlinks / junctions', () => {
  test('a link in the middle of a path is refused even though it points INSIDE', (t) => {
    if (plantLink('inside-link', path.join(root, SLUG, 'real-dir')) === 'skip') {
      return t.skip('this platform refused to create a link');
    }
    assert.ok(fs.lstatSync(path.join(root, SLUG, 'inside-link')).isSymbolicLink());
    assert.throws(
      () => resolveContainedPath(root, SLUG, 'inside-link/nested/a.txt'),
      (e: any) => e?.statusCode === 400,
      'an in-workspace link must still be refused'
    );
  });

  test('a link pointing OUTSIDE cannot be walked or created through', (t) => {
    if (plantLink('escape', outside) === 'skip') {
      return t.skip('this platform refused to create a link');
    }
    for (const rel of ['escape/secret.txt', 'escape/new.txt', 'escape/deep/new.txt']) {
      assert.throws(
        () => resolveContainedPath(root, SLUG, rel, { mustExist: false }),
        (e: any) => e?.statusCode === 400,
        `${rel} must be refused`
      );
    }
  });

  test('a link as the FINAL component is refused unless the caller allows the leaf', (t) => {
    if (plantLink('leaf', path.join(outside, 'secret.txt')) === 'skip') {
      return t.skip('this platform refused to create a link');
    }
    assert.throws(
      () => resolveContainedPath(root, SLUG, 'leaf', { mustExist: false }),
      (e: any) => e?.statusCode === 400
    );
    // Delete-the-link-itself is the one legitimate use.
    const leaf = resolveContainedPath(root, SLUG, 'leaf', { mustExist: false, allowLinkLeaf: true });
    assert.strictEqual(leaf, path.join(root, SLUG, 'leaf'));
    assert.ok(fs.lstatSync(leaf).isSymbolicLink());
  });

  test('workspaceLinkAt reports links without throwing on junk', (t) => {
    if (plantLink('leaf2', path.join(outside, 'secret.txt')) === 'skip') {
      return t.skip('this platform refused to create a link');
    }
    assert.strictEqual(workspaceLinkAt(root, SLUG, 'leaf2'), true);
    assert.strictEqual(workspaceLinkAt(root, SLUG, 'top.txt'), false);
    assert.strictEqual(workspaceLinkAt(root, SLUG, '../escape'), false);
    assert.strictEqual(workspaceLinkAt(root, SLUG, 'nope'), false);
  });

  test('a link that is the project dir itself is refused', (t) => {
    const linkedSlug = 'linked-project';
    const linkPath = path.join(root, linkedSlug);
    try {
      fs.symlinkSync(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return t.skip('this platform refused to create a link');
    }
    assert.throws(
      () => resolveContainedPath(root, linkedSlug, 'secret.txt'),
      (e: any) => e?.statusCode === 400,
      'the workspace base must never itself be a link'
    );
  });
});

describe('workspace-paths-core · non-throwing adapter', () => {
  test('tryResolveContainedPath maps every refusal to null', () => {
    assert.strictEqual(tryResolveContainedPath(root, SLUG, '../x'), null);
    assert.strictEqual(tryResolveContainedPath(root, SLUG, 'missing'), null);
    assert.strictEqual(tryResolveContainedPath(root, 'nope-project'), null);
    assert.strictEqual(
      tryResolveContainedPath(root, SLUG, 'top.txt'),
      path.join(root, SLUG, 'top.txt')
    );
  });
});

// The upload `paths` field was dead code: multer delivers it as a JSON STRING and
// the route indexed it as an object, so every folder upload silently landed in
// the workspace root. These rows pin the parsing that makes the Files-tab folder
// feature real — and, because the subdirectory is now client-influenced input,
// the pair (uploadRelativePath -> resolveContainedPath) that contains it.
describe('workspace-paths-core · upload paths', () => {
  test('a JSON text field is parsed (the form multer actually delivers)', () => {
    assert.deepStrictEqual(
      parseUploadPaths('{"a.txt":"docs/a.txt","b.png":"assets/img/b.png"}'),
      { 'a.txt': 'docs/a.txt', 'b.png': 'assets/img/b.png' }
    );
    // A numeric-looking FILENAME is the case that proved the old code wrong:
    // indexing the raw string by '0' returned a character, not a path.
    assert.deepStrictEqual(parseUploadPaths('{"0":"logs/0.log"}'), { '0': 'logs/0.log' });
  });

  test('junk degrades to {} instead of failing the upload', () => {
    for (const junk of [undefined, null, '', 'not json', '[1,2]', '"str"', '{"a":1}', 'x'.repeat(70 * 1024)]) {
      assert.deepStrictEqual(parseUploadPaths(junk), {}, `${String(junk).slice(0, 20)} must degrade`);
    }
    assert.deepStrictEqual(parseUploadPaths('{"a":{"deep":"x"},"b":["y"],"c":"ok"}'), { c: 'ok' }, 'only string values survive');
  });

  test('uploadRelativePath normalises separators and refuses escaping shapes', () => {
    assert.strictEqual(uploadRelativePath('docs\\notes\\a.txt'), 'docs/notes/a.txt');
    assert.strictEqual(uploadRelativePath('  /a.txt  '), 'a.txt', 'leading slashes are stripped, trimmed');
    for (const bad of ['../x', 'a/../../x', 'a/..', '..', '', '.', '   ', 'a\0b', null, undefined, {}]) {
      assert.strictEqual(uploadRelativePath(bad), null, `${JSON.stringify(bad)} must be refused`);
    }
    assert.strictEqual(uploadRelativePath('a'.repeat(2000))!.length, 1024, 'length is capped, not dropped');
  });

  test('a normalised folder path still cannot traverse a planted link', (t) => {
    // uploadRelativePath is a SHAPE filter; containment comes from the primitive.
    // Proving the pair is the point: a client-chosen folder must not open the door.
    if (plantLink('updir', outside) === 'skip') {
      return t.skip('this platform refused to create a link');
    }
    const rel = uploadRelativePath('updir/secret.txt')!;
    assert.strictEqual(rel, 'updir/secret.txt', 'the shape is perfectly valid');
    assert.throws(
      () => resolveContainedPath(root, SLUG, rel, { mustExist: false }),
      (e: any) => e?.statusCode === 400,
      'the primitive must still refuse it'
    );
    assert.strictEqual(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'SECRET', 'the target is untouched');
  });
});