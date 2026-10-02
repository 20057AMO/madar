/**
 * VS Code (code-server) image hardening — the live install plus the script's
 * own enforcement, both proven against the RUNNING container.
 *
 * Why this suite exists
 * ---------------------
 * Every defect this guards against was silent and shipped green:
 *
 *   1. A delete-list of built-ins used UNPREFIXED dir names that do not match
 *      the real ones, so `ms-vscode.js-debug-companion` and
 *      `ms-vscode.vscode-js-profile-table` survived every build.
 *   2. `dpkg -i` (interactive update AND boot re-apply) restored the PRISTINE
 *      /usr/lib/code-server, resurrecting the whole Copilot payload — 127 MB of
 *      native code under `@github` alone, spawning a ~270 MB RAM sidecar on
 *      every boot.
 *   3. The first stub implementation named three `@github` packages. code-server
 *      4.138 ships a FOURTH (`@github/copilot-sdk-linux-x64`, 127 MB) that the
 *      named list never touched — /usr/lib/code-server stayed at 442 MB while
 *      every named check reported green.
 *   4. `vscode.git` declares `extensionDependencies: ["vscode.git-base"]`;
 *      deleting git-base left Source Control hanging at "Scanning folder for
 *      Git repositories..." forever.
 *
 * The synthetic-tree half drives the REAL script with `WSD_CODE_SERVER_ROOT` /
 * `WSD_IDE_BUILTIN_DIR` redirected into /tmp, so it can plant a regression, see
 * `verify` reject it, and undo it — without ever writing to the live install.
 * Nothing here touches a real project, container or workspace.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';

const CONTAINER = process.env.WSD_TEST_CONTAINER || 'wsd-pro';
const SCRIPT = '/usr/local/share/madar/ide-hardening.sh';
const CS_ROOT = '/usr/lib/code-server';
const EXT_DIR = `${CS_ROOT}/lib/vscode/extensions`;
const GITHUB_DIR = `${CS_ROOT}/lib/vscode/node_modules/@github`;
const TMP = '/tmp/madar-ide-hardening-test';
// The USER settings store. code-server runs with no --user-data-dir, so this is
// $XDG_DATA_HOME/code-server/User/settings.json — NOT ~/.config/code-server/User,
// which only holds code-server's own config.yaml. Asserting against the latter
// is how the whole managed-key sync stayed green while every key was inert.
const SETTINGS = '/root/.local/share/code-server/User/settings.json';
const DEAD_SETTINGS = '/root/.config/code-server/User/settings.json';

/**
 * The installed Todo Tree manifest, resolved by GLOB rather than a pinned
 * version: the VSIX is digest-pinned upstream but its version moves, and a
 * hardcoded `...todo-tree-0.0.215/` would turn every bump into a false failure
 * (or, worse, a stale skip). Empty when the extension is absent.
 */
const TODO_TREE_PKG = sh(
  `ls -d /root/.local/share/code-server/extensions/gruntfuggly.todo-tree-* 2>/dev/null | head -1`,
).stdout.trim();

/**
 * stdout as an exact line Set. Substring matching is unusable here and is the
 * bug this suite would otherwise ship: `todo-tree.ripgrep.ripgrepArgs`
 * CONTAINS `todo-tree.ripgrep`, so an `includes()` test for the dead key passes
 * on the corrected one — and an `includes()` test for the corrected key passes
 * when only the Args variant is present. Both directions lie.
 */
function exactLines(out: string): Set<string> {
  return new Set(
    out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
  );
}

type Outcome = { code: number | null; stdout: string; stderr: string };

/**
 * Run a command in the Madar container and report its EXIT CODE instead of
 * throwing, and return BOTH streams: the hardening script reports a failed
 * invariant on STDERR (`fail() { ... >&2; }`) while the surrounding wrapper
 * command still exits 0, so a stdout-only reader sees the invariant violation
 * vanish. `spawnSync` rather than `execFileSync` for the same reason — the
 * latter hands back stdout alone and discards stderr.
 *
 * `code: null` means we obtained NO verdict (docker missing, daemon down,
 * spawn timeout) and must never be read as success.
 */
function inContainer(args: string[], timeout = 60_000): Outcome {
  const r = spawnSync('docker', ['exec', CONTAINER, ...args], {
    encoding: 'utf8',
    timeout,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    code: typeof r.status === 'number' ? r.status : null,
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || '').trim().slice(0, 600),
  };
}

/** `bash -lc` in the container. `$` is escaped as `\$` for the TS template. */
function sh(script: string, timeout = 60_000): Outcome {
  return inContainer(['bash', '-c', script], timeout);
}

/** Run the hardening script against a redirected (or real) tree. */
function harden(mode: 'capture' | 'apply' | 'verify', root: string, saved: string): Outcome {
  return sh(
    `WSD_CODE_SERVER_ROOT=${root} WSD_IDE_BUILTIN_DIR=${saved} ${SCRIPT} ${mode}; echo "EXIT=$?"`,
  );
}

/** The exit code the script itself printed, independent of our own wrapper. */
function hardenExit(out: Outcome): number {
  const m = out.stdout.match(/EXIT=(\d+)/);
  return m ? Number(m[1]) : -1;
}

const READY = inContainer(['test', '-x', SCRIPT]).code === 0;
const SHIPPED_TREE = inContainer(['test', '-d', EXT_DIR]).code === 0;

// ── The live install (read-only) ────────────────────────────────────────────

describe('IDE hardening — the shipped install', { skip: READY ? false : `${SCRIPT} is not installed in ${CONTAINER}` }, () => {
  test('the running image passes verify', () => {
    const out = harden('verify', CS_ROOT, '/opt/madar/ide-builtin');
    assert.strictEqual(
      hardenExit(out),
      0,
      `verify must pass on the running install; got exit ${hardenExit(out)}\n${out.stdout}\n${out.stderr}`,
    );
    assert.match(out.stdout, /verify OK/);
  });

  test('vscode.git-base — Source Control\'s only declared dependency — is present', { skip: SHIPPED_TREE ? false : 'no extensions tree' }, () => {
    const probe = sh(`jq -r '"\\(.publisher).\\(.name)@\\(.version)"' ${EXT_DIR}/git-base/package.json 2>/dev/null`);
    assert.notStrictEqual(probe.code, null, `docker never answered: ${probe.stderr}`);
    assert.strictEqual(probe.stdout.trim(), 'vscode.git-base@10.0.0');

    // and the dependency really is declared, so the closure is load-bearing
    const deps = sh(`jq -c '.extensionDependencies // []' ${EXT_DIR}/git/package.json`);
    assert.ok(
      (deps.stdout || '').includes('vscode.git-base'),
      `vscode.git must declare vscode.git-base; got ${deps.stdout.trim()}`,
    );
  });

  test('vscode.github-authentication is an explicit keep-list root with no Copilot edge', { skip: SHIPPED_TREE ? false : 'no extensions tree' }, () => {
    // It is NOT a transitive dependency (nothing declares it), so `capture` only
    // snapshots it because the keep-list names it. Both halves must hold: the
    // dir is really installed, and restoring it did not drag Copilot back.
    const probe = sh(`jq -r '"\\(.publisher).\\(.name)@\\(.version)"' ${EXT_DIR}/github-authentication/package.json 2>/dev/null`);
    assert.notStrictEqual(probe.code, null, `docker never answered: ${probe.stderr}`);
    assert.match(probe.stdout.trim(), /^vscode\.github-authentication@\d/, `the extension is not installed: ${probe.stdout.trim()}`);

    const saved = sh(`test -d /opt/madar/ide-builtin/github-authentication && echo yes || echo no`);
    assert.strictEqual(saved.stdout.trim(), 'yes', 'github-authentication must be in the captured closure, or the next dpkg -i drops it again');

    // The Copilot invariants must survive the restore: no extensionDependencies
    // edge, and no @github/Copilot reference anywhere in its bundle.
    const edge = sh(`
      echo "DEPS=$(jq -c '.extensionDependencies // []' ${EXT_DIR}/github-authentication/package.json)"
      echo "NPM=$(jq -c '.dependencies // {}' ${EXT_DIR}/github-authentication/package.json)"
      echo "HITS=$(grep -rl -e '@github/copilot' -e 'github-copilot' ${EXT_DIR}/github-authentication 2>/dev/null | wc -l)"`);
    assert.strictEqual(edge.code, 0, edge.stderr);
    assert.strictEqual(edge.stdout.match(/DEPS=(.*)/)?.[1], '[]', `it must declare no extensionDependencies: ${edge.stdout}`);
    assert.strictEqual(edge.stdout.match(/NPM=(.*)/)?.[1], '{}', `it must declare no npm dependencies: ${edge.stdout}`);
    assert.strictEqual(Number(edge.stdout.match(/HITS=(\d+)/)?.[1] ?? -1), 0, `the restored bundle references Copilot: ${edge.stdout}`);

    assert.strictEqual(inContainer(['test', '-d', `${EXT_DIR}/copilot`]).code, 1, 'restoring github-authentication must not bring the Copilot extension dir back');
    assert.strictEqual(Number(sh(`ps aux | grep -c '[g]ithub-copilot'`).stdout.trim() || '0'), 0, 'a github-copilot process is running');
  });

  test('every shipped @github package is a stub and the whole tree is tiny', { skip: SHIPPED_TREE ? false : 'no extensions tree' }, () => {
    const out = sh(`
      total=$(du -sb ${GITHUB_DIR} | cut -f1)
      echo "TOTAL=$total"
      echo "ELF=$(find ${GITHUB_DIR} -type f -exec grep -lFa -- $'\\x7fELF' {} + 2>/dev/null | wc -l)"
      for p in ${GITHUB_DIR}/*/; do
        n=$(jq -r '.name // "?"' "$p/package.json")
        k=$(jq -r 'if has("bin") then "spawned" else "imported" end' "$p/package.json")
        b=$(du -sb "$p" | cut -f1)
        echo "PKG=$n/$k/$b"
      done`);
    assert.strictEqual(out.code, 0, out.stderr);

    const total = Number(out.stdout.match(/TOTAL=(\d+)/)?.[1] ?? -1);
    assert.ok(total > 0, `could not measure ${GITHUB_DIR}: ${out.stdout}`);
    assert.ok(total < 2 * 1024 * 1024, `@github is ${total} bytes — a Copilot payload is back (132 MB before hardening)`);

    const elfs = Number(out.stdout.match(/ELF=(\d+)/)?.[1] ?? -1);
    assert.strictEqual(elfs, 0, `no ELF may survive under ${GITHUB_DIR}: ${out.stdout}`);

    // `@github/copilot-sdk` itself contains a slash, so the kind and the size
    // are parsed from the RIGHT of the line, never split on the first '/'.
    const pkgs = [...out.stdout.matchAll(/^PKG=(.+)$/gm)].map((m) => {
      const parts = m[1].split('/');
      const bytes = Number(parts.pop());
      const kind = parts.pop();
      return { name: parts.join('/'), kind, bytes };
    });
    assert.ok(pkgs.length >= 1, `expected the stubbed @github tree, got ${pkgs.length} packages`);

    // agentHostMain.js statically imports @github/copilot-sdk, so the deb that
    // ships it must keep it — as an empty export, never deleted. (@github/copilot
    // is referenced there too but is NOT in code-server 4.138's file list, so
    // nothing may invent it: stubbing what ships is the rule, not a name list.)
    const imported = pkgs.filter((p) => p.kind === 'imported').map((p) => p.name);
    assert.ok(
      imported.includes('@github/copilot-sdk'),
      `agentHost imports @github/copilot-sdk, so it must stay present as an import stub (have ${imported.join(', ') || 'nothing'})`,
    );

    for (const { name, kind, bytes } of pkgs) {
      assert.ok(bytes < 1024 * 1024, `${name} is ${bytes} bytes — the real ${kind} payload is back`);
      const idx = sh(`cat ${GITHUB_DIR}/${name.split('/').pop()}/index.js`);
      assert.match(idx.stdout, kind === 'spawned' ? /process\.exit\(0\)/ : /module\.exports=\{\}/, `${name} is not a ${kind} stub: ${idx.stdout}`);
    }
  });

  test('no Copilot extension directory and no copilot sidecar process', () => {
    assert.strictEqual(inContainer(['test', '-d', `${EXT_DIR}/copilot`]).code, 1, 'the Copilot extension directory is back');
    const procs = sh(`ps aux | grep -c '[g]ithub-copilot'`);
    assert.ok(Number(procs.stdout.trim() || '0') === 0, `a github-copilot process is running: ${procs.stdout}`);
  });

  test('the built-in tree is the pruned closure, not the full stock set', { skip: SHIPPED_TREE ? false : 'no extensions tree' }, () => {
    const out = sh(`
      n=0
      for d in ${EXT_DIR}/*/; do [ -f "$d/package.json" ] && n=$((n+1)); done
      echo "COUNT=$n"`);
    const count = Number(out.stdout.match(/COUNT=(\d+)/)?.[1] ?? -1);
    assert.ok(count > 0, `could not count built-ins: ${out.stdout}`);
    assert.ok(count >= 30 && count <= 50, `expected a slimmed keep-list + closure (30-50), found ${count}`);

    // the two dirs the old unprefixed delete-list silently missed
    for (const id of ['ms-vscode.js-debug-companion', 'ms-vscode.vscode-js-profile-table']) {
      assert.strictEqual(
        inContainer(['test', '-d', `${EXT_DIR}/${id}`]).code,
        1,
        `${id} must be pruned — the old delete-list used unprefixed names that never matched`,
      );
    }
  });

  test('the volume settings carry the managed keys and a usable ripgrep', () => {
    // `jq -e` exits non-zero when the value is false/null, so `has(k)` is an
    // EXACT existence check — no substring ambiguity between
    // `todo-tree.ripgrep` / `.ripgrep` / `.ripgrepArgs`.
    const managed = [
      'todo-tree.ripgrep.ripgrep',
      'todo-tree.ripgrep.ripgrepArgs',
      'todo-tree.filtering.includeGlobs',
      'todo-tree.regex.regex',
      'workbench.startupEditor',
      'telemetry.telemetryLevel',
      'update.mode',
      'extensions.autoUpdate',
      'extensions.autoCheckUpdates',
      'security.workspace.trust.enabled',
    ];
    for (const key of managed) {
      const has = sh(`jq -e 'has(${JSON.stringify(key)})' ${SETTINGS}`);
      assert.strictEqual(has.code, 0, `${key} is missing from the synced volume settings`);
    }
    const rg = sh(`jq -r '.["todo-tree.ripgrep.ripgrep"]' ${SETTINGS}`);
    assert.ok(rg.stdout.trim().length > 0, 'todo-tree.ripgrep.ripgrep is empty');
    const rgPath = rg.stdout.trim();
    assert.strictEqual(
      inContainer(['test', '-x', rgPath]).code,
      0,
      `todo-tree.ripgrep.ripgrep points at a non-executable path: ${rgPath}`,
    );
    // includeGlobs is a JSON ARRAY and regex.regex a STRING: written as bare
    // strings the workbench coerces or drops them, and the curated glob/regex
    // silently fall back to the extension defaults.
    for (const [key, type] of [
      ['todo-tree.filtering.includeGlobs', 'array'],
      ['todo-tree.regex.regex', 'string'],
      ['todo-tree.ripgrep.ripgrepArgs', 'string'],
    ] as const) {
      assert.strictEqual(
        sh(`jq -r '.["${key}"] | type' ${SETTINGS}`).stdout.trim(),
        type,
        `${key} must be a JSON ${type} — a bare string is coerced away and the curated value is silently dropped`,
      );
    }
  });

  test('the curated todo regex actually runs under the managed ripgrep args', () => {
    // The defect this pins, end to end and without a browser: the curated regex
    // uses look-AHEAD, which ripgrep's default engine rejects, so the workspace
    // scan died with "regex parse error: look-around ... is not supported" and
    // Todo Tree found NOTHING. `--pcre2` in ripgrepArgs is what makes it work,
    // and it is only correct while the binary can actually honour the flag.
    const rgPath = sh(`jq -r '.["todo-tree.ripgrep.ripgrep"]' ${SETTINGS}`).stdout.trim();
    const rgArgs = sh(`jq -r '.["todo-tree.ripgrep.ripgrepArgs"]' ${SETTINGS}`).stdout.trim();
    const regex = sh(`jq -r '.["todo-tree.regex.regex"]' ${SETTINGS}`).stdout.trim();
    assert.ok(regex.length > 0, 'todo-tree.regex.regex is empty');

    // A look-around in the regex makes --pcre2 load-bearing; without it the pin
    // is inert and should be revisited along with the regex.
    if (/\(\?=|\(\?<[=!]/.test(regex)) {
      assert.ok(
        rgArgs.includes('--pcre2'),
        `the curated regex needs PCRE2 look-around but ripgrepArgs omits --pcre2: ${rgArgs}`,
      );
      assert.match(
        sh(`${rgPath} --version`).stdout,
        /features:\+pcre2/,
        `${rgPath} cannot honour --pcre2, so the curated regex cannot be honoured`,
      );
    }

    // The decisive assertion: run the real binary with the real managed args over
    // a file that obviously contains a TODO. It must exit 0 AND match — this is
    // exactly the path that failed while the boot log and the settings sync both
    // reported green.
    const scratch = '/tmp/madar-todotree-regex-probe.ts';
    sh(`printf '// TODO: probe\\nexport const x = 1;\\n' > ${scratch}`);
    const run = sh(
      `${rgPath} ${rgArgs} --no-messages --vimgrep -H --column --line-number --color never -e ${JSON.stringify(regex)} ${scratch}`,
    );
    assert.strictEqual(
      run.code,
      0,
      `the curated regex does not run under the managed ripgrep args:\n${run.stderr}`,
    );
    assert.match(
      run.stdout,
      /TODO: probe/,
      `the curated regex ran but found no TODO in a file that contains one: ${run.stdout}`,
    );
    sh(`rm -f ${scratch}`);
  });

  test('the synced settings land in the store the workbench actually reads', () => {
    // The regression this pins: the sync used to write ~/.config/code-server/User,
    // which code-server never opens, so a green boot log meant nothing.
    assert.strictEqual(
      inContainer(['test', '-f', SETTINGS]).code,
      0,
      `${SETTINGS} is missing — the boot sync did not reach the user-data-dir`,
    );
    // Structural proof this IS the workbench store, independent of its content:
    // only a VS Code user-data-dir carries these three, and code-server builds it
    // at $XDG_DATA_HOME/code-server because it is started without --user-data-dir.
    for (const dir of ['workspaceStorage', 'globalStorage', 'History']) {
      assert.strictEqual(
        inContainer(['test', '-d', `/root/.local/share/code-server/User/${dir}`]).code,
        0,
        `/root/.local/share/code-server/User/${dir} is missing — that path is not the VS Code user-data-dir`,
      );
    }
    assert.match(
      sh(`jq -r 'has("workbench.startupEditor") and has("todo-tree.ripgrep.ripgrep")' ${SETTINGS}`).stdout.trim(),
      /true/,
      `${SETTINGS} is not the workbench user settings file carrying the managed keys`,
    );
    // The dead path may still exist (the baked seed, or a pre-fix volume), but it
    // must not be the only place the managed keys live — edits there do nothing.
    if (inContainer(['test', '-f', DEAD_SETTINGS]).code === 0) {
      assert.notStrictEqual(
        sh(`jq -r '.["todo-tree.ripgrep.ripgrep"] // "none"' ${DEAD_SETTINGS}`).stdout.trim(),
        'none',
        `${DEAD_SETTINGS} still carries the managed keys — the workbench reads ${SETTINGS}, so edits there are dead letters`,
      );
    }
  });

  test('the managed todo-tree keys are real contributed settings of the installed extension', () => {
    // A wrong key NAME is inert: the workbench stores it, the extension never
    // reads it, and Todo Tree falls back to its defaults without a word. Assert
    // the ids against the extension's OWN package.json rather than trusting a
    // hand-written list, and pin the type the value must have.
    assert.notStrictEqual(
      TODO_TREE_PKG,
      '',
      `Todo Tree is not installed under /root/.local/share/code-server/extensions — nothing here can be asserted`,
    );
    const probe = sh(
      `jq -r '[.contributes.configuration[]?.properties // {} | keys[]] | .[]' ${TODO_TREE_PKG}/package.json`,
    );
    assert.strictEqual(probe.code, 0, probe.stderr);
    const contributed = exactLines(probe.stdout);

    const required = [
      'todo-tree.ripgrep.ripgrep',
      'todo-tree.ripgrep.ripgrepArgs',
      'todo-tree.filtering.includeGlobs',
      'todo-tree.regex.regex',
      'todo-tree.general.tags',
      'todo-tree.highlights.defaultHighlight',
      'todo-tree.highlights.customHighlight',
    ];
    for (const key of required) {
      assert.ok(
        contributed.has(key),
        `${key} is NOT contributed by ${TODO_TREE_PKG} — it would be stored but never read`,
      );
    }
    // The three ids that shipped wrong. Exact Set membership: substring matching
    // cannot tell `todo-tree.ripgrep` from `todo-tree.ripgrep.ripgrep`, which is
    // the entire mistake.
    for (const stale of ['todo-tree.ripgrep', 'todo-tree.general.filename', 'todo-tree.regex']) {
      assert.ok(
        !contributed.has(stale),
        `${stale} unexpectedly exists as a contributed id in ${TODO_TREE_PKG}`,
      );
    }

    const types = sh(
      `jq -r '.contributes.configuration[]?.properties | to_entries[] | select(.key | test("^todo-tree\\\\.(ripgrep\\\\.ripgrep|ripgrep\\\\.ripgrepArgs|filtering\\\\.includeGlobs|regex\\\\.regex)$")) | "\\(.key)=\\(.value.type)"' ${TODO_TREE_PKG}/package.json`,
    );
    assert.match(types.stdout, /todo-tree\.ripgrep\.ripgrep=string/);
    assert.match(types.stdout, /todo-tree\.ripgrep\.ripgrepArgs=string/);
    assert.match(types.stdout, /todo-tree\.filtering\.includeGlobs=array/);
    assert.match(types.stdout, /todo-tree\.regex\.regex=string/);

    // And the value types we write must match what the extension declares, read
    // straight from the SAME manifest — the pair (synced value type, contributed
    // type) is what has to agree, and either half alone proves nothing.
    for (const [key, contributedType] of [
      ['todo-tree.ripgrep.ripgrep', 'string'],
      ['todo-tree.ripgrep.ripgrepArgs', 'string'],
      ['todo-tree.filtering.includeGlobs', 'array'],
      ['todo-tree.regex.regex', 'string'],
    ] as const) {
      const declared = sh(
        `jq -r '.contributes.configuration[]?.properties | to_entries[] | select(.key == "${key}") | .value.type' ${TODO_TREE_PKG}/package.json`,
      ).stdout.trim();
      const synced = sh(`jq -r '.["${key}"] | type' ${SETTINGS}`).stdout.trim();
      assert.strictEqual(declared, contributedType, `${key} is declared as ${declared}, not ${contributedType}`);
      assert.strictEqual(
        synced,
        declared,
        `${key} is synced as a JSON ${synced} but the extension declares it ${declared}`,
      );
    }
  });
});

// ── Enforcement, driven against synthetic trees in /tmp ─────────────────────

/**
 * A faithful mirror of the shipped tree: the real built-in package.json files
 * (so ids and declared dependencies are exactly what code-server ships), plus
 * a synthetic @github tree holding a large payload in every package shape.
 * `truncate` gives the size check something to measure without writing 400 MB.
 */
const BUILD = `
set -eu
ROOT=${TMP}/cs
SAVED=${TMP}/saved
rm -rf ${TMP}
mkdir -p "$ROOT/lib/vscode/extensions/node_modules" "$ROOT/lib/vscode/node_modules/@github" "$SAVED"
for d in ${EXT_DIR}/*/; do
  b=$(basename "$d")
  [ -f "$d/package.json" ] || continue
  mkdir -p "$ROOT/lib/vscode/extensions/$b"
  cp "$d/package.json" "$ROOT/lib/vscode/extensions/$b/package.json"
done
G="$ROOT/lib/vscode/node_modules/@github"
for p in copilot copilot-sdk; do
  mkdir -p "$G/$p"
  printf '{"name":"@github/%s","version":"1.0.0","main":"lib/index.js"}' "$p" > "$G/$p/package.json"
  truncate -s 900000 "$G/$p/lib.js"
done
mkdir -p "$G/copilot-linux-x64/bin"
printf '{"name":"@github/copilot-linux-x64","version":"1.0.0","bin":{"github-copilot":"bin/copilot"}}' > "$G/copilot-linux-x64/package.json"
truncate -s 130000000 "$G/copilot-linux-x64/bin/copilot"
mkdir -p "$G/copilot-sdk-linux-x64/definitions"
printf '{"name":"@github/copilot-sdk-linux-x64","version":"1.0.15-preview.4","os":["linux"],"cpu":["x64"]}' > "$G/copilot-sdk-linux-x64/package.json"
truncate -s 132000000 "$G/copilot-sdk-linux-x64/definitions/blob.bin"
# a built-in that is NOT in the keep-list: must be pruned
mkdir -p "$ROOT/lib/vscode/extensions/ms-python.brand-new"
printf '{"name":"brand-new","publisher":"ms-python","version":"1.0.0"}' > "$ROOT/lib/vscode/extensions/ms-python.brand-new/package.json"
echo "BUILT github=$(du -sb "$G" | cut -f1)"
`;

const ROOT = `${TMP}/cs`;
const SAVED = `${TMP}/saved`;
const GH = `${ROOT}/lib/vscode/node_modules/@github`;

describe('IDE hardening — enforcement (synthetic tree)', { skip: READY && SHIPPED_TREE ? false : 'needs the script and a shipped tree in the container' }, () => {
  before(() => {
    const out = sh(BUILD, 120_000);
    assert.strictEqual(out.code, 0, `could not build the synthetic tree: ${out.stderr}`);
    // capture must run on the PRISTINE tree, then apply + verify must settle it
    assert.strictEqual(hardenExit(harden('capture', ROOT, SAVED)), 0, 'capture must succeed on a pristine tree');
    assert.strictEqual(hardenExit(harden('apply', ROOT, SAVED)), 0, 'apply must succeed');
  });

  after(() => {
    sh(`rm -rf ${TMP}`);
  });

  test('capture computes the closure TRANSITIVELY, so vscode.git-base is included', () => {
    // rebuild the pristine tree, capture, and inspect what was saved
    // (BUILD ends in a newline, so the next command starts its own line —
    //  appending `&& ` to it is a bash parse error that silently skips
    //  everything before it)
    const out = sh(`${BUILD}WSD_CODE_SERVER_ROOT=${ROOT} WSD_IDE_BUILTIN_DIR=${SAVED} ${SCRIPT} capture && cat ${SAVED}/*/package.json | jq -r '"\\(.publisher).\\(.name)"' | sort | tr '\\n' ' '`);
    assert.strictEqual(out.code, 0, out.stderr);
    const ids = out.stdout;
    assert.match(ids, /vscode\.git\b/, `capture must keep vscode.git: ${ids}`);
    assert.match(
      ids,
      /vscode\.git-base/,
      `vscode.git declares extensionDependencies:["vscode.git-base"], so the closure must include it — this is the dependency the old delete-list removed: ${ids}`,
    );
    const count = (ids.match(/vscode\.|ms-vscode\.|ms-python\./g) || []).length;
    assert.ok(count >= 30, `expected the keep-list roots plus the closure, got ${count}: ${ids}`);

    // BUILD left a PRISTINE (unstubbed, unpruned) tree behind. Every later test
    // heals by verifying, so restore the canonical good state now — otherwise
    // they would each fail against a tree this test, not against their own
    // regression.
    const healed = harden('apply', ROOT, SAVED);
    assert.strictEqual(hardenExit(healed), 0, `could not re-apply after capture: ${healed.stdout}`);
  });

  test('apply stubs every @github package by STRUCTURE, including a name it cannot know', () => {
    const out = sh(`
      mkdir -p ${GH}/copilot-fabricated-2099
      printf '{"name":"@github/copilot-fabricated-2099","version":"9.9.9","main":"index.js"}' > ${GH}/copilot-fabricated-2099/package.json
      truncate -s 140000000 ${GH}/copilot-fabricated-2099/payload.bin
      WSD_CODE_SERVER_ROOT=${ROOT} WSD_IDE_BUILTIN_DIR=${SAVED} ${SCRIPT} apply > /dev/null || { echo "APPLY FAILED"; exit 1; }
      echo "TOTAL=$(du -sb ${GH} | cut -f1)"
      echo "FABRICATED=$(cat ${GH}/copilot-fabricated-2099/index.js)"
      echo "BIN=$(jq -c .bin ${GH}/copilot-linux-x64/package.json)"`);
    assert.strictEqual(out.code, 0, out.stderr);

    const total = Number(out.stdout.match(/TOTAL=(\d+)/)?.[1] ?? -1);
    assert.ok(
      total > 0 && total < 2 * 1024 * 1024,
      `a package the named list never knew about survived: @github is ${total} bytes (was 403 MB before apply)`,
    );
    assert.strictEqual(
      out.stdout.match(/FABRICATED=(.*)/)?.[1]?.trim(),
      'module.exports={}',
      'a package with no `bin` must be replaced by an empty-export stub',
    );
    // the REAL bin name must be preserved: a stub published under a synthesised
    // name leaves the command VS Code spawns by dangling
    assert.match(out.stdout, /"github-copilot":"index\.js"/, `the declared bin name must be kept: ${out.stdout}`);
  });

  test('apply prunes built-ins outside the keep-list, including the two the old delete-list missed', () => {
    const out = sh(`
      for id in ms-vscode.js-debug-companion ms-vscode.vscode-js-profile-table; do
        mkdir -p ${ROOT}/lib/vscode/extensions/$id
        printf '{"name":"%s","publisher":"ms-vscode","version":"1.0.0"}' "$id" > ${ROOT}/lib/vscode/extensions/$id/package.json
      done
      WSD_CODE_SERVER_ROOT=${ROOT} WSD_IDE_BUILTIN_DIR=${SAVED} ${SCRIPT} apply | tail -1
      for id in ms-vscode.js-debug-companion ms-vscode.vscode-js-profile-table ms-python.brand-new; do
        test -d ${ROOT}/lib/vscode/extensions/$id && echo "STILL=$id"
      done
      echo DONE`);
    assert.strictEqual(out.code, 0, out.stderr);
    assert.doesNotMatch(out.stdout, /STILL=/, `a non-keep built-in survived the keep-list prune: ${out.stdout}`);
    assert.match(out.stdout, /apply OK/);
  });

  test('apply is idempotent and verify stays green across repeated runs', () => {
    const first = harden('apply', ROOT, SAVED);
    const second = harden('apply', ROOT, SAVED);
    assert.strictEqual(hardenExit(first), 0, first.stdout);
    assert.strictEqual(hardenExit(second), 0, second.stdout);
    assert.strictEqual(hardenExit(harden('verify', ROOT, SAVED)), 0, 'verify must pass after repeated applies');
  });

  /** verify must REFUSE a planted regression, then be green again once undone. */
  function expectRejected(label: string, plant: string, unplant: string, invariant: RegExp) {
    test(`verify rejects: ${label}`, () => {
      const planted = sh(`${plant}\nWSD_CODE_SERVER_ROOT=${ROOT} WSD_IDE_BUILTIN_DIR=${SAVED} ${SCRIPT} verify; echo "EXIT=$?"`);
      try {
        assert.notStrictEqual(hardenExit(planted), 0, `verify accepted a broken tree: ${planted.stdout}`);
        // the script reports on STDERR, so both streams carry the verdict
        assert.match(`${planted.stdout}${planted.stderr}`, invariant, `expected ${invariant} in: ${planted.stdout}${planted.stderr}`);
      } finally {
        // Heal by re-applying, not just by undoing the plant: `apply` is
        // idempotent and restores the canonical state, so one test cannot leave
        // the next one asserting against a tree it never broke.
        const healed = sh(`${unplant}\nWSD_CODE_SERVER_ROOT=${ROOT} WSD_IDE_BUILTIN_DIR=${SAVED} ${SCRIPT} apply > /dev/null\nWSD_CODE_SERVER_ROOT=${ROOT} WSD_IDE_BUILTIN_DIR=${SAVED} ${SCRIPT} verify; echo "EXIT=$?"`);
        assert.strictEqual(hardenExit(healed), 0, `the tree did not heal after undoing "${label}": ${healed.stdout}${healed.stderr}`);
      }
    });
  }

  expectRejected(
    'an ELF payload reappears under @github',
    `mkdir -p ${GH}/copilot-linux-x64/bin && printf '\\177ELF\\002\\001\\001\\000rest' > ${GH}/copilot-linux-x64/bin/copilot`,
    `rm -rf ${GH}/copilot-linux-x64/bin`,
    /I2: an ELF executable is present/,
  );

  expectRejected(
    'an imported @github package grows past 64 KiB',
    `truncate -s 200000 ${GH}/copilot-sdk/big.js`,
    `rm -f ${GH}/copilot-sdk/big.js`,
    /I3: the imported package .* is \d+ bytes \(>= 64 KiB\)/,
  );

  expectRejected(
    'the @github tree total blows the ceiling',
    `mkdir -p ${GH}/copilot/bulk && truncate -s 3000000 ${GH}/copilot/bulk/x.bin`,
    `rm -rf ${GH}/copilot/bulk`,
    /I2: .* is \d+ bytes \(>= 2 MiB\)/,
  );

  expectRejected(
    'vscode.git-base is deleted (Source Control would hang forever)',
    `mv ${ROOT}/lib/vscode/extensions/git-base ${TMP}/git-base-away`,
    `mv ${TMP}/git-base-away ${ROOT}/lib/vscode/extensions/git-base`,
    /I4: vscode\.git depends on vscode\.git-base/,
  );

  expectRejected(
    'the Copilot extension directory is back',
    `mkdir -p ${ROOT}/lib/vscode/extensions/copilot && printf '{"name":"copilot","publisher":"GitHub","version":"1.0.0"}' > ${ROOT}/lib/vscode/extensions/copilot/package.json`,
    `rm -rf ${ROOT}/lib/vscode/extensions/copilot`,
    /I1: .*\/extensions\/copilot exists/,
  );

  expectRejected(
    '@github is deleted instead of stubbed (agentHost imports it)',
    `rm -rf ${GH}`,
    `mkdir -p ${GH}/copilot ${GH}/copilot-sdk ${GH}/copilot-linux-x64
     printf '{"name":"@github/copilot","version":"0.0.0","main":"index.js"}' > ${GH}/copilot/package.json
     printf 'module.exports={}\\n' > ${GH}/copilot/index.js
     printf '{"name":"@github/copilot-sdk","version":"0.0.0","main":"index.js"}' > ${GH}/copilot-sdk/package.json
     printf 'module.exports={}\\n' > ${GH}/copilot-sdk/index.js
     printf '{"name":"@github/copilot-linux-x64","version":"0.0.0","main":"index.js","bin":{"github-copilot":"index.js"}}' > ${GH}/copilot-linux-x64/package.json
     printf '#!/usr/bin/env node\\nprocess.exit(0)\\n' > ${GH}/copilot-linux-x64/index.js`,
    /I2: .*@github is missing/,
  );

  test('verify exits 0 and writes NOTHING when the extensions tree is absent', () => {
    // component-updates.test.ts installs fake code-server debs whose payload is
    // a single `version` file, so a legitimate `dpkg -i` WIPES this tree.
    // Hardening must be unable to break that flow, nor a boot on an install
    // that does not carry this layer.
    const out = sh(`
      mv ${ROOT}/lib/vscode/extensions ${TMP}/ext-away
      for mode in capture apply verify; do
        WSD_CODE_SERVER_ROOT=${ROOT} WSD_IDE_BUILTIN_DIR=${SAVED} ${SCRIPT} $mode
        echo "$mode EXIT=$?"
      done
      mv ${TMP}/ext-away ${ROOT}/lib/vscode/extensions`);
    assert.strictEqual(out.code, 0, out.stderr);
    for (const mode of ['capture', 'apply', 'verify']) {
      assert.match(out.stdout, new RegExp(`${mode} EXIT=0`), `${mode} must no-op on an absent tree: ${out.stdout}`);
    }
    assert.match(out.stdout, /absent/i, 'the no-op must say so: ' + out.stdout);
  });
});