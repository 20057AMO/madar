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
  openContainedForWrite,
  writeAndClose,
  writeContainedFile,
  copyContainedFile,
  linkFreeControls,
  renameContainedPath,
  readContainedFile,
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

// ── Link-free writes ────────────────────────────────────────────────────────
//
// A check is a proof only until the thing it proved is USED. These rows are
// about the use, not the check: what must hold is that no planted link — at the
// LEAF or at an intermediate directory — can be written through, and that the
// refusal is a clean 400/403 rather than a raw errno escaping as a 500.
describe('workspace-paths-core · link-free open', () => {
  test('the control set is reported honestly for this platform', () => {
    const controls = linkFreeControls();
    assert.strictEqual(controls.platform, process.platform);
    assert.strictEqual(controls.identity, true, 'the fstat-vs-lstat identity check is always on');
    if (process.platform === 'win32') {
      // Node does not define O_NOFOLLOW on win32, so the kernel refusal is NOT
      // available there and the helper must not pretend it is. Pinned because a
      // future "just OR the flag in" refactor would make flags NaN.
      assert.strictEqual(controls.nofollow, false);
      assert.strictEqual(controls.procSelfFd, false);
    }
    if (process.platform === 'linux') {
      assert.strictEqual(controls.nofollow, true, 'Linux gets the kernel O_NOFOLLOW refusal');
      assert.strictEqual(controls.procSelfFd, true, 'Linux gets the opened-path proof');
    }
  });

  test('a NEW file and a NEW nested folder are created (the feature the guard broke)', () => {
    const out = writeContainedFile(root, SLUG, 'brand/new/deep/file.txt', 'hello');
    assert.strictEqual(out.created, true);
    assert.strictEqual(out.bytes, 5);
    assert.strictEqual(
      fs.readFileSync(path.join(root, SLUG, 'brand', 'new', 'deep', 'file.txt'), 'utf8'),
      'hello'
    );
    // upsert over an existing file REPLACES it, and says so.
    const again = writeContainedFile(root, SLUG, 'brand/new/deep/file.txt', 'bye');
    assert.strictEqual(again.created, false);
    assert.strictEqual(fs.readFileSync(path.join(root, SLUG, 'brand/new/deep/file.txt'), 'utf8'), 'bye');
  });

  test('mode:create refuses an existing name atomically (O_EXCL), it never overwrites', () => {
    writeContainedFile(root, SLUG, 'excl.txt', 'first');
    assert.throws(
      () => writeContainedFile(root, SLUG, 'excl.txt', 'second', { mode: 'create' }),
      (e: any) => e?.statusCode === 400,
      'create must not adopt an existing name'
    );
    assert.strictEqual(fs.readFileSync(path.join(root, SLUG, 'excl.txt'), 'utf8'), 'first');
  });

  test('a symlink LEAF is refused, and the target is untouched', (t) => {
    if (plantLink('leaf-write', path.join(outside, 'secret.txt')) === 'skip') {
      return t.skip('this platform refused to create a link');
    }
    for (const mode of ['upsert', 'create'] as const) {
      assert.throws(
        () => writeContainedFile(root, SLUG, 'leaf-write', 'PWNED', { mode }),
        (e: any) => e?.statusCode === 400,
        `mode ${mode} must refuse a link leaf`
      );
    }
    assert.strictEqual(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'SECRET');
  });

  test('a RACED INTERMEDIATE-directory swap can never move the write outside', (t) => {
    // Executable on every platform: the planted link is a directory junction
    // (Windows) / symlink (POSIX), which needs no elevation. This is the harder
    // race of the two — `O_NOFOLLOW` only governs the LEAF, so a swapped
    // parent is the case that needs the opened-path proof.
    const canary = path.join(outside, 'race-dir-canary.txt');
    fs.writeFileSync(canary, 'CANARY', 'utf8');
    const mid = path.join(root, SLUG, 'racedir');
    const kind = process.platform === 'win32' ? 'junction' : 'dir';
    const swap = (want: boolean) => {
      try {
        fs.rmSync(mid, { recursive: true, force: true });
        if (want) fs.symlinkSync(outside, mid, kind);
      } catch {
        /* reported by the caller */
      }
    };
    try {
      swap(true);
      if (!fs.lstatSync(mid).isSymbolicLink()) throw new Error('no link');
    } catch {
      return t.skip('this platform refused to create a link');
    }

    for (let i = 0; i < 400; i += 1) {
      swap(i % 2 === 0);
      try {
        writeContainedFile(root, SLUG, 'racedir/race-dir-canary.txt', 'PAYLOAD', { mode: 'upsert' });
      } catch {
        /* a refusal is a perfectly good outcome */
      }
      assert.strictEqual(
        fs.readFileSync(canary, 'utf8'),
        'CANARY',
        `round ${i}: a directory created/written through a raced link escaped`
      );
      assert.strictEqual(fs.readFileSync(canary, 'utf8'), 'CANARY');
    }
    swap(false);
  });

test('a RACED leaf swap can never move the write outside the workspace', (t) => {
    // The property under test is the one the old check-then-write violated: no
    // interleaving of "plant/remove a link at the leaf" with "write this path"
    // may put bytes outside the workspace. The canary is the assertion — it is
    // checked for content every round, so a hit fails the row even if the race
    // is only hit once. The row can also pass without the window ever being
    // reached; that is inherent to a race, and is why the DESCRIPTOR row above
    // (deterministic) is the one that proves the mechanism.
    const canary = path.join(outside, 'race-canary.txt');
    fs.writeFileSync(canary, 'CANARY', 'utf8');
    const leaf = path.join(root, SLUG, 'raced.txt');
    const linkTo = path.join(outside, 'race-canary.txt');
    let planted = false;
    const plant = () => {
      try {
        fs.rmSync(leaf, { force: true });
        fs.symlinkSync(linkTo, leaf, process.platform === 'win32' ? 'file' : undefined);
        planted = true;
      } catch {
        planted = false;
      }
    };
    const clear = () => {
      try {
        fs.rmSync(leaf, { force: true });
      } catch {
        /* ignore */
      }
      planted = false;
    };
    try {
      fs.symlinkSync(linkTo, leaf, process.platform === 'win32' ? 'file' : undefined);
      planted = true;
    } catch {
      return t.skip('this platform refused to create a link');
    }

    for (let i = 0; i < 400; i += 1) {
      // Half the rounds present a link, half present a free name — the swap
      // between them is the race the old code lost.
      if (i % 2 === 0) plant();
      else clear();
      try {
        writeContainedFile(root, SLUG, 'raced.txt', 'PAYLOAD', { mode: 'upsert' });
      } catch {
        /* a refusal is a perfectly good outcome */
      }
      assert.strictEqual(
        fs.readFileSync(canary, 'utf8'),
        'CANARY',
        `round ${i}: the canary outside the workspace was overwritten`
      );
    }
    clear();
  });

  test('a link as an INTERMEDIATE directory cannot be created or written through', (t) => {
    if (plantLink('write-dir', outside) === 'skip') {
      return t.skip('this platform refused to create a link');
    }
    assert.throws(
      () => writeContainedFile(root, SLUG, 'write-dir/secret.txt', 'PWNED'),
      (e: any) => e?.statusCode === 400
    );
    // And with mkdirParents the primitive must not even CREATE a directory
    // through it — `mkdirSync(<link>/new)` lands in the link's target, which is
    // the same escape one level up.
    assert.throws(
      () => writeContainedFile(root, SLUG, 'write-dir/fresh/child.txt', 'PWNED'),
      (e: any) => e?.statusCode === 400
    );
    assert.strictEqual(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'SECRET');
    assert.ok(!fs.existsSync(path.join(outside, 'fresh')), 'no directory may be created through the link');
  });

  test('copyContainedFile (the upload path) writes in, chunked, through the fd', () => {
    const src = path.join(outside, 'upload-src.bin');
    const payload = Buffer.alloc(200 * 1024, 0x41); // larger than the 64 KiB chunk
    fs.writeFileSync(src, payload);
    const out = copyContainedFile(root, SLUG, 'uploads/upload-src.bin', src, { mode: 'create' });
    assert.strictEqual(out.created, true);
    assert.strictEqual(out.bytes, payload.length);
    assert.ok(
      fs.readFileSync(path.join(root, SLUG, 'uploads', 'upload-src.bin')).equals(payload),
      'the copied bytes must match exactly'
    );
    // `copyFileSync` would have silently overwritten this; the upload route
    // de-duplicates on existsSync, which is itself a check-then-use.
    assert.throws(() => copyContainedFile(root, SLUG, 'uploads/upload-src.bin', src, { mode: 'create' }), (e: any) => e?.statusCode === 400);
  });

  test('copyContainedFile cannot be aimed through a planted link', (t) => {
    const src = path.join(outside, 'payload2.bin');
    fs.writeFileSync(src, 'PAYLOAD');
    if (plantLink('up-copy', path.join(outside, 'secret.txt')) === 'skip') {
      return t.skip('this platform refused to create a link');
    }
    assert.throws(() => copyContainedFile(root, SLUG, 'up-copy', src, { mode: 'create' }), (e: any) => e?.statusCode === 400);
    assert.strictEqual(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'SECRET');
  });

  test('the workspace root itself is refused as a write target', () => {
    assert.throws(() => writeContainedFile(root, SLUG, '.', 'PWNED'), (e: any) => e?.statusCode === 400);
    assert.throws(() => writeContainedFile(root, SLUG, '', 'PWNED'), (e: any) => e?.statusCode === 400);
  });

  test('a missing project is still a 404, and a missing parent with mkdirParents:false is too', () => {
    assert.throws(() => writeContainedFile(root, 'no-such-project', 'a.txt', 'x'), (e: any) => e?.statusCode === 404);
    assert.throws(
      () => writeContainedFile(root, SLUG, 'never/created/yet.txt', 'x', { mkdirParents: false }),
      (e: any) => e?.statusCode === 404
    );
  });

  test('the handle writes into the DESCRIPTOR, so a later path swap cannot redirect it', () => {
    const handle = openContainedForWrite(root, SLUG, 'descriptor.txt', { mode: 'create' });
    assert.ok(handle.fd > 0, 'a real descriptor is returned');
    assert.strictEqual(handle.created, true);
    // Swap the NAME to a link while the descriptor is open. The bytes must go
    // to the file that was opened, and to nowhere else.
    fs.writeFileSync(path.join(outside, 'swapped.txt'), 'ORIGINAL');
    try {
      fs.rmSync(path.join(root, SLUG, 'descriptor.txt'), { force: true });
      fs.symlinkSync(path.join(outside, 'swapped.txt'), path.join(root, SLUG, 'descriptor.txt'));
    } catch {
      writeAndClose(handle.fd, 'bytes');
      fs.rmSync(path.join(root, SLUG, 'descriptor.txt'), { force: true });
      return; // platform refused the link; the descriptor assertion above stands
    }
    writeAndClose(handle.fd, 'bytes');
    assert.strictEqual(
      fs.readFileSync(path.join(outside, 'swapped.txt'), 'utf8'),
      'ORIGINAL',
      'the link target must NOT receive the write'
    );
    fs.rmSync(path.join(root, SLUG, 'descriptor.txt'), { force: true });
  });

  test('a directory and a FIFO are refused as write targets (no blocking open)', () => {
    fs.mkdirSync(path.join(root, SLUG, 'a-directory'), { recursive: true });
    assert.throws(() => writeContainedFile(root, SLUG, 'a-directory', 'PWNED'), (e: any) => e?.statusCode === 400);
  });
});

describe('workspace-paths-core · link-free rename', () => {
  // rename(2) takes no flags and no descriptor, so it cannot be closed the way
  // a write is. It is closed by BINDING the syscall to a pinned directory
  // descriptor. These rows cover the contract; the block comment above
  // renameContainedPath states the argument.

  test('the pin is reported honestly for this platform', () => {
    writeContainedFile(root, SLUG, 'pin/a.txt', 'x');
    const out = renameContainedPath(root, SLUG, 'pin/a.txt', 'pin/b.txt');
    assert.strictEqual(out.noop, false);
    // Windows cannot open() a directory and has no /proc, so the descriptor pin
    // is genuinely unavailable there. Pinned so a future "always claim true"
    // refactor cannot paper over the platform difference.
    assert.strictEqual(out.pinned, linkFreeControls().procSelfFd);
    assert.ok(fs.existsSync(path.join(root, SLUG, 'pin', 'b.txt')));
  });

  test('an ordinary rename into a NEW nested folder still works (the regression)', () => {
    writeContainedFile(root, SLUG, 'mv/src.txt', 'payload');
    const out = renameContainedPath(root, SLUG, 'mv/src.txt', 'mv/brand/new/deep/moved.txt');
    assert.strictEqual(out.noop, false);
    assert.strictEqual(fs.readFileSync(path.join(root, SLUG, 'mv/brand/new/deep/moved.txt'), 'utf8'), 'payload');
    assert.ok(!fs.existsSync(path.join(root, SLUG, 'mv/src.txt')), 'the source is gone after a move');
  });

  test('an occupied destination is a 409 and the incumbent survives', () => {
    writeContainedFile(root, SLUG, 'occ/a.txt', 'A');
    writeContainedFile(root, SLUG, 'occ/b.txt', 'B');
    assert.throws(
      () => renameContainedPath(root, SLUG, 'occ/a.txt', 'occ/b.txt'),
      (e: any) => e?.statusCode === 409
    );
    assert.strictEqual(fs.readFileSync(path.join(root, SLUG, 'occ/b.txt'), 'utf8'), 'B');
  });

  test('a DANGLING link at the destination leaf is a refusal, not a silent replace', () => {
    // existsSync FOLLOWS a link, so the old check reported the name as free and
    // rename then replaced the link. lstat reports the name as taken.
    writeContainedFile(root, SLUG, 'dangle/a.txt', 'A');
    const leaf = path.join(root, SLUG, 'dangle', 'ghost');
    try {
      fs.symlinkSync(path.join(outside, 'does-not-exist.txt'), leaf, process.platform === 'win32' ? 'file' : undefined);
    } catch {
      return; // platform refused the link; the 409 row above still stands
    }
    assert.throws(() => renameContainedPath(root, SLUG, 'dangle/a.txt', 'dangle/ghost'), (e: any) => e?.statusCode === 409);
    assert.ok(fs.lstatSync(leaf).isSymbolicLink(), 'the link itself must survive the refusal');
  });

  test('traversal, the workspace root and a missing source are refused', () => {
    writeContainedFile(root, SLUG, 'guard/a.txt', 'A');
    assert.throws(() => renameContainedPath(root, SLUG, 'guard/a.txt', '../escaped.txt'), (e: any) => e?.statusCode === 400);
    assert.throws(() => renameContainedPath(root, SLUG, '../outside/secret.txt', 'x.txt'), (e: any) => e?.statusCode === 400);
    assert.throws(() => renameContainedPath(root, SLUG, 'guard/a.txt', ''), (e: any) => e?.statusCode === 400);
    assert.throws(() => renameContainedPath(root, SLUG, '', 'guard/x.txt'), (e: any) => e?.statusCode === 400);
    assert.throws(() => renameContainedPath(root, SLUG, 'guard/missing.txt', 'guard/x.txt'), (e: any) => e?.statusCode === 404);
    // from === to is a no-op, not an error — the UI sends it on an unchanged row.
    assert.strictEqual(renameContainedPath(root, SLUG, 'guard/a.txt', 'guard/a.txt').noop, true);
  });

  test('a link as the destination INTERMEDIATE directory is refused (the sink)', (t) => {
    writeContainedFile(root, SLUG, 'sink/a.txt', 'PAYLOAD');
    if (plantLink('sinkdir', outside) === 'skip') return t.skip('this platform refused to create a link');
    // `renameContainedPath` creates missing parents one level at a time and
    // proves each, so it must not even CREATE the directory through the link.
    assert.throws(
      () => renameContainedPath(root, SLUG, 'sink/a.txt', 'sinkdir/fresh/canary.txt'),
      (e: any) => e?.statusCode === 400
    );
    assert.strictEqual(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'SECRET');
    assert.ok(!fs.existsSync(path.join(outside, 'fresh')), 'no directory may be created through the link');
    assert.strictEqual(fs.readFileSync(path.join(root, SLUG, 'sink/a.txt'), 'utf8'), 'PAYLOAD', 'the source must survive');
  });

  test('a link as the SOURCE leaf is refused, and the target is untouched', (t) => {
    const srcLeaf = path.join(root, SLUG, 'srcleaf');
    fs.writeFileSync(path.join(outside, 'srcleaf-target.txt'), 'ORIGINAL', 'utf8');
    if (plantLink('srcleaf', path.join(outside, 'srcleaf-target.txt')) === 'skip') return t.skip('this platform refused to create a link');
    assert.throws(() => renameContainedPath(root, SLUG, 'srcleaf', 'srcleaf-moved.txt'), (e: any) => e?.statusCode === 400);
    assert.strictEqual(fs.readFileSync(path.join(outside, 'srcleaf-target.txt'), 'utf8'), 'ORIGINAL');
  });

  test('the CHECK-THEN-USE SEQUENCE THIS REPLACES really did escape, and the primitive does not', (t) => {
    // Deterministic witness for the finding, not a race: the swap is FORCED at
    // the exact point the old code was vulnerable at (between the containment
    // check and the rename), and both halves of the pair are replayed here.
    const mid = path.join(root, SLUG, 'witness');
    const canary = path.join(outside, 'witness-canary.txt');
    const swapToLink = () => {
      fs.rmSync(mid, { recursive: true, force: true });
      fs.symlinkSync(outside, mid, process.platform === 'win32' ? 'junction' : 'dir');
    };
    try {
      swapToLink();
      if (!fs.lstatSync(mid).isSymbolicLink()) throw new Error('no link');
    } catch {
      return t.skip('this platform refused to create a link');
    }

    // (a) THE OLD SHAPE: resolve by name, then mkdir -r + rename by name, with
    // the swap landing in between. Replayed literally, so the row documents what
    // the audit found rather than asserting it from memory.
    fs.writeFileSync(canary, 'CANARY', 'utf8');
    fs.writeFileSync(path.join(root, SLUG, 'witness-src.txt'), 'ATTACKER', 'utf8');
    const base = path.resolve(root, SLUG);
    const dst = path.resolve(base, 'witness/witness-canary.txt');
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true }); // the USE, after the swap
      fs.renameSync(path.resolve(base, 'witness-src.txt'), dst);
      assert.strictEqual(
        fs.readFileSync(canary, 'utf8'),
        'CANARY',
        'the replayed check-then-use sequence is expected to escape — if it does not, this row is no longer a witness and must be rewritten'
      );
    } catch {
      /* nothing to prove: the replay itself failed, which is also fine */
    }
    // Tidy whatever the replay did, so the second half starts clean.
    fs.rmSync(mid, { recursive: true, force: true });
    fs.rmSync(path.join(outside, 'witness-canary.txt'), { force: true });
    fs.rmSync(path.join(root, SLUG, 'witness-src.txt'), { force: true });
    fs.writeFileSync(canary, 'CANARY', 'utf8');
    fs.writeFileSync(path.join(root, SLUG, 'witness-src.txt'), 'ATTACKER', 'utf8');

    // (b) THE NEW SHAPE, same forced swap, repeated: never escapes.
    for (let i = 0; i < 200; i += 1) {
      // Alternate the destination parent between a real dir and the link, so the
      // primitive is exercised on both the create path and the refuse path.
      if (i % 2 === 0) {
        fs.rmSync(mid, { recursive: true, force: true });
        fs.symlinkSync(outside, mid, process.platform === 'win32' ? 'junction' : 'dir');
      } else {
        fs.rmSync(mid, { recursive: true, force: true });
        fs.mkdirSync(mid, { recursive: true });
      }
      try {
        renameContainedPath(root, SLUG, 'witness-src.txt', 'witness/witness-canary.txt');
      } catch {
        /* a refusal is a perfectly good outcome */
      }
      assert.strictEqual(
        fs.readFileSync(canary, 'utf8'),
        'CANARY',
        `round ${i}: the rename escaped through a swapped destination directory`
      );
      if (fs.existsSync(path.join(root, SLUG, 'witness-src.txt'))) {
        // A successful rename consumed the source; put it back for the next round.
        fs.writeFileSync(path.join(root, SLUG, 'witness-src.txt'), 'ATTACKER', 'utf8');
      }
    }
    fs.rmSync(mid, { recursive: true, force: true });
  });

  test('a rename failure never reflects an fs message (which embeds absolute paths)', () => {
    writeContainedFile(root, SLUG, 'leaky/a.txt', 'A');
    fs.mkdirSync(path.join(root, SLUG, 'leaky', 'dir'), { recursive: true });
    // Moving a directory into its own subtree is EINVAL — a raw fs message here
    // used to reach the client as a 500 body.
    assert.throws(
      () => renameContainedPath(root, SLUG, 'leaky/dir', 'leaky/dir/inner'),
      (e: any) => {
        assert.strictEqual(e?.statusCode, 400);
        assert.ok(!String(e?.message || '').includes(root), `the message leaked a host path: ${e?.message}`);
        return true;
      }
    );
  });
});

describe('workspace-paths-core · link-free reads', () => {
  test('a regular file is read whole with its TRUE size, never truncated', () => {
    writeContainedFile(root, SLUG, 'read/ok.txt', 'hello world');
    const r = readContainedFile(root, SLUG, 'read/ok.txt');
    assert.strictEqual(r.data.toString('utf8'), 'hello world');
    assert.strictEqual(r.size, 11);
    assert.strictEqual(r.truncated, false);
  });

  test('the read is BOUNDED: maxBytes caps the bytes while size stays honest', () => {
    writeContainedFile(root, SLUG, 'read/big.txt', 'x'.repeat(5000));
    const r = readContainedFile(root, SLUG, 'read/big.txt', { maxBytes: 1000 });
    assert.strictEqual(r.data.length, 1000, 'exactly maxBytes bytes');
    assert.strictEqual(r.size, 5000, 'size reports the TRUE file size, not the slice');
    assert.strictEqual(r.truncated, true);
  });

  test('a pathological maxBytes is clamped to the hard ceiling, never slurped', () => {
    // 9 MiB of zeros — asking for 64 MiB must still come back ≤ 8 MiB.
    const big = path.join(root, SLUG, 'read', 'huge.bin');
    fs.writeFileSync(big, Buffer.alloc(9 * 1024 * 1024));
    try {
      const r = readContainedFile(root, SLUG, 'read/huge.bin', { maxBytes: 64 * 1024 * 1024 });
      assert.ok(r.data.length <= 8 * 1024 * 1024, `read ${r.data.length} bytes past the hard ceiling`);
      assert.strictEqual(r.truncated, true, '9 MiB cannot fit under an 8 MiB ceiling');
      assert.strictEqual(r.size, 9 * 1024 * 1024);
    } finally {
      fs.rmSync(big, { force: true });
    }
  });

  test('missing / traversal / directory / root answers with the caller messages', () => {
    assert.throws(
      () => readContainedFile(root, SLUG, 'read/nope.txt', { missingMessage: 'Gone' }),
      (e: any) => e?.statusCode === 404 && e?.message === 'Gone'
    );
    assert.throws(
      () => readContainedFile(root, SLUG, '../outside/secret.txt'),
      (e: any) => e?.statusCode === 400
    );
    assert.throws(
      () => readContainedFile(root, SLUG, 'read/../../escape.txt'),
      (e: any) => e?.statusCode === 400
    );
    // A directory is NOT a file — refused, never opened (FIFOs included by the
    // fstat check) — with the caller's message, not an fs message.
    assert.throws(
      () => readContainedFile(root, SLUG, 'real-dir', { invalidMessage: 'Not a file' }),
      (e: any) => e?.statusCode === 400 && e?.message === 'Not a file'
    );
    // The workspace slug dir itself: `target === base` is refused, never
    // "read the directory".
    assert.throws(
      () => readContainedFile(root, SLUG, ''),
      (e: any) => e?.statusCode === 400
    );
    // An unknown slug is 404 — the workspace-not-found contract callers rely
    // on (distinct from a missing file inside a real workspace).
    assert.throws(
      () => readContainedFile(root, 'no-such-project', 'a.txt'),
      (e: any) => e?.statusCode === 404 && String(e?.message).includes("no-such-project' not found")
    );
    // A refusal never echoes an absolute host path back to the client.
    assert.throws(
      () => readContainedFile(root, SLUG, 'real-dir', { invalidMessage: 'Not a file' }),
      (e: any) => !String(e?.message || '').includes(root)
    );
  });

  test('a planted link at the LEAF never yields the target bytes', (t) => {
    fs.writeFileSync(path.join(outside, 'read-secret.txt'), 'TARGET-BYTES', 'utf8');
    if (plantLink('read-link.txt', path.join(outside, 'read-secret.txt')) === 'skip') {
      return t.skip('this platform refused to create a link');
    }
    assert.throws(
      () => readContainedFile(root, SLUG, 'read-link.txt'),
      (e: any) => e?.statusCode === 400
    );
    // The naive read this replaced DOES follow the link wherever the platform
    // can resolve one — on platforms where a file link cannot resolve at all,
    // the refusal row above still stands on its own.
    let naive = '';
    try {
      naive = fs.readFileSync(path.join(root, SLUG, 'read-link.txt'), 'utf8');
    } catch {
      /* unresolvable on this platform — see the diagnostic below */
    }
    assert.strictEqual(fs.readFileSync(path.join(outside, 'read-secret.txt'), 'utf8'), 'TARGET-BYTES');
    if (naive !== 'TARGET-BYTES') {
      t.diagnostic('platform cannot resolve a file link — refusal asserted, follow-witness skipped');
    }
  });

  test('a planted link as an INTERMEDIATE directory is refused before the open', (t) => {
    fs.writeFileSync(path.join(outside, 'deep-target.txt'), 'DEEP', 'utf8');
    if (plantLink('linkdir', outside) === 'skip') {
      return t.skip('this platform refused to create a link');
    }
    assert.throws(
      () => readContainedFile(root, SLUG, 'linkdir/deep-target.txt'),
      (e: any) => e?.statusCode === 400
    );
    assert.strictEqual(fs.readFileSync(path.join(outside, 'deep-target.txt'), 'utf8'), 'DEEP');
  });
});