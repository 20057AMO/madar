import { test, describe } from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INSTALL = path.join(ROOT, 'scripts', 'install.sh');
const UNINSTALL = path.join(ROOT, 'scripts', 'uninstall.sh');
const UNIT_TEMPLATE = path.join(ROOT, 'packaging', 'systemd', 'madar.service');
const README = path.join(ROOT, 'README.md');
const INSTALL_DOC = path.join(ROOT, 'docs', 'INSTALL.md');

const INSTALL_SRC = fs.readFileSync(INSTALL, 'utf8');
const UNINSTALL_SRC = fs.readFileSync(UNINSTALL, 'utf8');
const UNIT_SRC = fs.readFileSync(UNIT_TEMPLATE, 'utf8');

function toBashPath(p: string): string {
  const normalized = p.replace(/\\/g, '/');
  const drive = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  return drive ? `/mnt/${drive[1].toLowerCase()}/${drive[2]}` : normalized;
}

function bashQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function bashAvailable(): boolean {
  return !spawnSync('bash', ['--version'], { stdio: 'ignore', timeout: 10_000 }).error;
}

function runBash(script: string, args: string[] = []) {
  return spawnSync('bash', [toBashPath(script), ...args], {
    cwd: path.dirname(script),
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function cleanupTemp(tmp: string): void {
  // The stubbed scripts run under WSL bash, which creates files inside this
  // Windows temp dir that Win32 cannot always unlink (EPERM). Let WSL remove
  // what it owns first, then do a best-effort Win32 cleanup of the empty shell.
  spawnSync('bash', ['-c', `rm -rf -- '${toBashPath(tmp)}'`], { stdio: 'ignore', timeout: 10_000 });
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    // A file still held by the WSL mount may resist Win32 deletion; leaving a
    // uniquely-named temp dir behind is preferable to failing an otherwise-green test.
  }
}

function withTemp<T>(fn: (tmp: string) => T): T {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsd-install-scripts-'));
  try {
    return fn(tmp);
  } finally {
    cleanupTemp(tmp);
  }
}

function makeRepo(tmp: string): string {
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'packaging', 'systemd'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'workspaces'), { recursive: true });
  fs.copyFileSync(UNIT_TEMPLATE, path.join(repo, 'packaging', 'systemd', 'madar.service'));
  fs.writeFileSync(path.join(repo, 'scripts', 'install.sh'), '#!/usr/bin/env bash\n');
  fs.writeFileSync(path.join(repo, '.env.example'), '# test fixture only\nJWT_SECRET=\nMADAR_TEST_SENTINEL=keep-me\n');
  fs.writeFileSync(path.join(repo, 'docker-compose.yml'), 'services: {}\n');
  fs.writeFileSync(path.join(repo, 'workspaces', 'canary.txt'), 'canary\n');
  return repo;
}

type StubOpts = {
  dirty?: boolean;
  stackRunning?: boolean;
  origin?: string;
  busyPort?: string;
  env?: Record<string, string>;
};

function stubPrelude(tmp: string, log: string, opts: StubOpts): string {
  const envLines = Object.entries(opts.env ?? {})
    .map(([key, value]) => `export ${key}=${bashQuote(value)}`)
    .join('\n');
  return [
    `XDG_RUNTIME_DIR=${bashQuote(toBashPath(tmp))}`,
    `TMPDIR=${bashQuote(toBashPath(tmp))}`,
    `STUB_LOG=${bashQuote(toBashPath(log))}`,
    `STUB_DIRTY=${opts.dirty ? '1' : '0'}`,
    `STUB_STACK_RUNNING=${opts.stackRunning === false ? '0' : '1'}`,
    `STUB_BUSY_PORT=${bashQuote(opts.busyPort ?? '')}`,
    `MADAR_SYSTEMD_PID1_DIR=${bashQuote(toBashPath(path.join(tmp, 'systemd-pid1')))}`,
    `MADAR_SYSTEMD_UNIT=${bashQuote(toBashPath(path.join(tmp, 'systemd-unit', 'madar.service')))}`,
    envLines,
    "stublog() { printf '%s\\n' \"$*\" >> \"$STUB_LOG\"; }",
    'git() {',
    '  stublog "git $*"',
    '  case "$*" in',
    `    *'config --get'*) printf '%s\\n' ${bashQuote(opts.origin ?? 'https://github.com/20057AMO/madar.git')} ;;`,
    "    *'status --porcelain'*) if [[ \"$STUB_DIRTY\" == '1' ]]; then printf '%s\\n' ' M src/file.ts'; fi ;;",
    '  esac',
    '}',
    'docker() {',
    '  stublog "docker $*"',
    '  case "$*" in',
    "    'compose version'*) ;;",
    "    'compose ps --status'*) if [[ \"$STUB_STACK_RUNNING\" == '1' ]]; then printf '%s\\n' 'app'; fi ;;",
    '  esac',
    '}',
    "curl() { stublog \"curl $*\"; printf '%s\\n' '{\"status\":\"ok\"}'; }",
    'systemctl() { stublog "systemctl $*"; }',
    "id() { stublog \"id $*\"; printf '%s\\n' '1000'; }",
    'ss() {',
    '  stublog "ss $*"',
    '  if [[ -n "$STUB_BUSY_PORT" ]]; then',
    "    printf 'LISTEN 0 0 0.0.0.0:%s 0.0.0.0:*\\n' \"$STUB_BUSY_PORT\"",
    '  fi',
    '  return 0',
    '}',
    'lsof() { stublog "lsof $*"; return 1; }',
    'mktemp() {',
    '  local t="$1"',
    '  local out="${t%XXXXXX}stubbed.service"',
    '  : > "$out"',
    "  printf '%s\\n' \"$out\"",
    '}',
  ].filter(Boolean).join('\n') + '\n';
}

function runStubbed(script: string, args: string[], tmp: string, log: string, opts: StubOpts = {}) {
  fs.mkdirSync(path.join(tmp, 'systemd-pid1'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'systemd-unit'), { recursive: true });
  const combined = path.join(tmp, `with-stubs-${path.basename(script)}.sh`);
  fs.writeFileSync(combined, stubPrelude(tmp, log, opts) + fs.readFileSync(script, 'utf8'));
  return spawnSync('bash', [toBashPath(combined), ...args], {
    cwd: tmp,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function logLines(log: string): string[] {
  return fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean);
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function mentionsTlsBoth(text: string): boolean {
  return text.split(/\r?\n/).some((line) =>
    /\bTLS\b/i.test(line) && /\b3000\b/.test(line) && /\b4097\b/.test(line) && /معًا|both/i.test(line));
}

describe('Madar install/uninstall scripts (offline)', () => {
  test('bash -n parses both shipped scripts', (t) => {
    if (!bashAvailable()) {
      t.skip('bash is not available on this host');
      return;
    }
    for (const script of [INSTALL, UNINSTALL]) {
      const result = spawnSync('bash', ['-n', toBashPath(script)], { encoding: 'utf8', timeout: 10_000 });
      assert.strictEqual(result.status, 0, `${script}: ${result.stderr}`);
    }
  });

  test('--help exits 0 and lists every documented flag', (t) => {
    if (!bashAvailable()) {
      t.skip('bash is not available on this host');
      return;
    }
    const install = runBash(INSTALL, ['--help']);
    assert.strictEqual(install.status, 0, install.stderr);
    for (const flag of ['--dir', '--branch', '--no-systemd', '--help']) {
      assert.ok(install.stdout.includes(flag), `install --help is missing ${flag}`);
    }
    const uninstall = runBash(UNINSTALL, ['--help']);
    assert.strictEqual(uninstall.status, 0, uninstall.stderr);
    for (const flag of ['--dir', '--remove-data', '--help']) {
      assert.ok(uninstall.stdout.includes(flag), `uninstall --help is missing ${flag}`);
    }
  });

  test('an unknown flag fails with a clear error before any preflight', (t) => {
    if (!bashAvailable()) {
      t.skip('bash is not available on this host');
      return;
    }
    for (const script of [INSTALL, UNINSTALL]) {
      const result = runBash(script, ['--definitely-not-a-flag']);
      assert.strictEqual(result.status, 1, script);
      assert.match(result.stderr, /خيار غير معروف/);
      assert.strictEqual(result.stdout, '');
    }
  });

  test('default install dir is derived from the script location, never $HOME/madar', () => {
    for (const src of [INSTALL_SRC, UNINSTALL_SRC]) {
      assert.ok(!src.includes('$HOME/madar'), 'the old HOME default survived');
      assert.match(src, /SCRIPT_DIR="\$\(cd -- "\$\(dirname -- "\$\{BASH_SOURCE\[0\]\}"\)" && pwd -P\)"/);
      assert.match(src, /REPO_DEFAULT="\$\(cd -- "\$SCRIPT_DIR\/\.\." && pwd -P\)"/);
      assert.match(src, /\$\{MADAR_DIR:-\$REPO_DEFAULT\}|looks_like_repo "\$REPO_DEFAULT"/);
      assert.match(src, /\$\{MADAR_DIR:-\$PWD\}|looks_like_repo "\$PWD"/);
    }
    assert.match(INSTALL_SRC, /require_repo_layout "\$DIR"/);
    assert.match(INSTALL_SRC, /docker-compose\.yml.*scripts\/install\.sh/);
    assert.match(UNINSTALL_SRC, /require_repo_layout "\$DIR"/);
    assert.match(UNINSTALL_SRC, /docker-compose\.yml.*scripts\/install\.sh/);
  });

  test('a fresh install renders a unit with the resolved absolute directory and no secrets or raw ports', (t) => {
    if (!bashAvailable()) {
      t.skip('bash is not available on this host');
      return;
    }
    withTemp((tmp) => {
      const repo = makeRepo(tmp);
      const log = path.join(tmp, 'stub.log');
      fs.writeFileSync(log, '');
      const result = runStubbed(INSTALL, ['--dir', toBashPath(repo)], tmp, log);
      assert.strictEqual(result.status, 0, `${result.stderr}\n${result.stdout}`);

      const calls = logLines(log);
      assert.ok(calls.some((line) => line.startsWith('docker compose up')), 'compose up was never called');
      assert.ok(calls.some((line) => line.startsWith('curl -fsS')), 'health probe was never called');
      assert.ok(calls.some((line) => line.startsWith('systemctl')) === false, 'non-root branch must not call systemctl directly');

      const unitFile = path.join(tmp, 'madar.service.stubbed.service');
      const unit = fs.readFileSync(unitFile, 'utf8');
      const working = /^WorkingDirectory=(.+)$/m.exec(unit);
      assert.ok(working, 'the rendered unit has no WorkingDirectory');
      assert.ok(path.isAbsolute(working[1]), `WorkingDirectory is not absolute: ${working[1]}`);
      assert.strictEqual(working[1], toBashPath(repo));
      assert.ok(!unit.includes('@MADAR_DIR@'), 'the template placeholder survived rendering');
      assert.doesNotMatch(unit, /JWT_SECRET|WSD_TRUST_PROXY|8100|4096|secret|password/i);
      assert.match(unit, /^ExecStart=\/usr\/bin\/docker compose up -d$/m);
      assert.match(unit, /^ExecStop=\/usr\/bin\/docker compose down$/m);
      assert.ok(!unit.includes('--build'), 'the oneshot unit must not rebuild on every boot');
    });
  });

  test('repeat installs preserve .env byte-for-byte and the script never assigns JWT_SECRET', (t) => {
    if (!bashAvailable()) {
      t.skip('bash is not available on this host');
      return;
    }
    withTemp((tmp) => {
      const repo = makeRepo(tmp);
      const log = path.join(tmp, 'stub.log');
      const envFile = path.join(repo, '.env');
      fs.writeFileSync(log, '');

      const first = runStubbed(INSTALL, ['--dir', toBashPath(repo)], tmp, log);
      assert.strictEqual(first.status, 0, `${first.stderr}\n${first.stdout}`);
      assert.ok(fs.existsSync(envFile), 'install did not create .env from .env.example');
      assert.match(fs.readFileSync(envFile, 'utf8'), /MADAR_TEST_SENTINEL=keep-me/);
      const before = sha256(envFile);

      fs.writeFileSync(log, '');
      const second = runStubbed(INSTALL, ['--dir', toBashPath(repo)], tmp, log);
      assert.strictEqual(second.status, 0, `${second.stderr}\n${second.stdout}`);
      assert.match(second.stdout, /ملف \.env موجود؛ لم يتم تغييره/);
      assert.strictEqual(sha256(envFile), before, 'a repeat install rewrote .env');
      assert.match(fs.readFileSync(envFile, 'utf8'), /MADAR_TEST_SENTINEL=keep-me/);

      assert.doesNotMatch(INSTALL_SRC, /(?:^|[^\w.])JWT_SECRET\s*=/);
      assert.doesNotMatch(INSTALL_SRC, /WSD_TRUST_PROXY\s*=/);
    });
  });

  test('a dirty worktree is refused before any compose, health probe or .env write', (t) => {
    if (!bashAvailable()) {
      t.skip('bash is not available on this host');
      return;
    }
    withTemp((tmp) => {
      const repo = makeRepo(tmp);
      const log = path.join(tmp, 'stub.log');
      fs.writeFileSync(log, '');
      const result = runStubbed(INSTALL, ['--dir', toBashPath(repo)], tmp, log, { dirty: true });
      assert.strictEqual(result.status, 1, result.stdout);
      assert.match(result.stderr, /تغييرات غير محفوظة/);
      assert.match(result.stderr, /لم يُنفَّذ أي أمر Compose/);

      const calls = logLines(log);
      assert.ok(calls.some((line) => line.includes('status --porcelain')), 'the dirty-check stub was not reached');
      assert.ok(!calls.some((line) => line.startsWith('docker compose up')), calls.join('\n'));
      assert.ok(!calls.some((line) => line.startsWith('curl')), calls.join('\n'));
      assert.ok(!fs.existsSync(path.join(repo, '.env')), 'a refused update still created .env');
    });
  });

  test('--no-systemd installs Madar now and never renders a boot unit', (t) => {
    if (!bashAvailable()) {
      t.skip('bash is not available on this host');
      return;
    }
    withTemp((tmp) => {
      const repo = makeRepo(tmp);
      const log = path.join(tmp, 'stub.log');
      fs.writeFileSync(log, '');
      const result = runStubbed(INSTALL, ['--no-systemd', '--dir', toBashPath(repo)], tmp, log);
      assert.strictEqual(result.status, 0, `${result.stderr}\n${result.stdout}`);
      assert.match(result.stdout, /--no-systemd/);
      assert.ok(!fs.existsSync(path.join(tmp, 'madar.service.stubbed.service')), 'a unit was rendered despite --no-systemd');
      assert.ok(!logLines(log).some((line) => line.startsWith('systemctl')), 'non-root branch must not call systemctl directly');
    });
  });

  test('missing real systemd is warned about in Arabic and skips only the boot unit', (t) => {
    if (!bashAvailable()) {
      t.skip('bash is not available on this host');
      return;
    }
    withTemp((tmp) => {
      const repo = makeRepo(tmp);
      const log = path.join(tmp, 'stub.log');
      fs.writeFileSync(log, '');
      const result = runStubbed(INSTALL, ['--dir', toBashPath(repo)], tmp, log, {
        env: { MADAR_SYSTEMD_PID1_DIR: toBashPath(path.join(tmp, 'no-systemd-here')) },
      });
      assert.strictEqual(result.status, 0, `${result.stderr}\n${result.stdout}`);
      assert.match(result.stderr, /لم يتم اكتشاف systemd كعملية رقم 1/);
      assert.ok(logLines(log).some((line) => line.startsWith('docker compose up')), 'Madar itself was not installed');
      assert.ok(!fs.existsSync(path.join(tmp, 'madar.service.stubbed.service')), 'a boot unit was installed without systemd');
    });
  });

  test('the shipped unit has no restart directives and is hardened for a root-run service', () => {
    assert.doesNotMatch(UNIT_SRC, /^Restart=/m);
    assert.doesNotMatch(UNIT_SRC, /^RestartSec=/m);
    assert.match(UNIT_SRC, /^NoNewPrivileges=true$/m);
    assert.doesNotMatch(UNIT_SRC, /EnvironmentFile|JWT_SECRET|WSD_TRUST_PROXY|8100|4096/i);
  });

  test('canonical origin spellings are all accepted without echoing the raw remote', (t) => {
    if (!bashAvailable()) {
      t.skip('bash is not available on this host');
      return;
    }
    const origins = [
      'https://github.com/20057AMO/madar.git',
      'https://github.com/20057AMO/madar',
      'http://github.com/20057AMO/madar/',
      'git@github.com:20057AMO/madar.git',
      'github.com/20057AMO/madar',
    ];
    for (const origin of origins) {
      withTemp((tmp) => {
        const repo = makeRepo(tmp);
        const log = path.join(tmp, 'stub.log');
        fs.writeFileSync(log, '');
        const result = runStubbed(INSTALL, ['--dir', toBashPath(repo)], tmp, log, { origin });
        assert.strictEqual(result.status, 0, `${origin}: ${result.stderr}\n${result.stdout}`);
      });
    }
  });

  test('a foreign origin is refused before compose and the raw URL is never printed', (t) => {
    if (!bashAvailable()) {
      t.skip('bash is not available on this host');
      return;
    }
    withTemp((tmp) => {
      const repo = makeRepo(tmp);
      const log = path.join(tmp, 'stub.log');
      fs.writeFileSync(log, '');
      const hostile = 'https://evil.example/attacker/madar.git';
      const result = runStubbed(INSTALL, ['--dir', toBashPath(repo)], tmp, log, { origin: hostile });
      assert.strictEqual(result.status, 1, result.stdout);
      assert.match(result.stderr, /النسخة الرسمية 20057AMO\/madar/);
      assert.ok(!result.stderr.includes('evil.example'), 'raw remote URL leaked into the refusal');
      assert.ok(!logLines(log).some((line) => line.startsWith('docker compose up')), 'compose ran before the origin check');
    });
  });

  test('control characters in --dir or MADAR_DIR are refused before any work', (t) => {
    if (!bashAvailable()) {
      t.skip('bash is not available on this host');
      return;
    }
    withTemp((tmp) => {
      const repo = makeRepo(tmp);
      const log = path.join(tmp, 'stub.log');
      fs.writeFileSync(log, '');
      const bad = `${toBashPath(repo)}\nrm -rf /`;
      const viaArg = runStubbed(INSTALL, ['--dir', bad], tmp, log);
      assert.strictEqual(viaArg.status, 1, viaArg.stdout);
      assert.match(viaArg.stderr, /أحرف تحكم/);
      assert.strictEqual(logLines(log).length, 0, 'a control-char path reached the stubs');

      fs.writeFileSync(log, '');
      const viaEnv = runStubbed(INSTALL, [], tmp, log, { env: { MADAR_DIR: bad } });
      assert.strictEqual(viaEnv.status, 1, viaEnv.stdout);
      assert.match(viaEnv.stderr, /أحرف تحكم/);
      assert.strictEqual(logLines(log).length, 0, 'a control-char MADAR_DIR reached the stubs');
    });
  });

  test('install refuses a systemd unit pointing at another Madar install before compose', (t) => {
    if (!bashAvailable()) {
      t.skip('bash is not available on this host');
      return;
    }
    withTemp((tmp) => {
      const repo = makeRepo(tmp);
      const log = path.join(tmp, 'stub.log');
      fs.writeFileSync(log, '');
      fs.mkdirSync(path.join(tmp, 'systemd-unit'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'systemd-unit', 'madar.service'), '[Service]\nWorkingDirectory=/some/other/madar\n');
      const result = runStubbed(INSTALL, ['--dir', toBashPath(repo)], tmp, log);
      assert.strictEqual(result.status, 1, result.stdout);
      assert.match(result.stderr, /وحدة واحدة فقط على كل مضيف|مسار تثبيت آخر/);
      assert.ok(!logLines(log).some((line) => line.startsWith('docker compose up')), 'compose ran despite the collision');
    });
  });

  test('uninstall refuses to delete a systemd unit pointing at another Madar install', (t) => {
    if (!bashAvailable()) {
      t.skip('bash is not available on this host');
      return;
    }
    withTemp((tmp) => {
      const repo = makeRepo(tmp);
      const log = path.join(tmp, 'stub.log');
      fs.writeFileSync(log, '');
      fs.mkdirSync(path.join(tmp, 'systemd-unit'), { recursive: true });
      const unitPath = path.join(tmp, 'systemd-unit', 'madar.service');
      const unit = '[Service]\nWorkingDirectory=/some/other/madar\n';
      fs.writeFileSync(unitPath, unit);
      const result = runStubbed(UNINSTALL, ['--dir', toBashPath(repo)], tmp, log);
      assert.strictEqual(result.status, 1, result.stdout);
      assert.match(result.stderr, /لن تُحذف وحدة تخص تثبيتًا آخر/);
      assert.strictEqual(fs.readFileSync(unitPath, 'utf8'), unit);
      assert.ok(!logLines(log).some((line) => line.startsWith('docker')), 'compose ran despite the collision');
    });
  });

  test('a .env directory is rejected clearly instead of being overwritten', (t) => {
    if (!bashAvailable()) {
      t.skip('bash is not available on this host');
      return;
    }
    withTemp((tmp) => {
      const repo = makeRepo(tmp);
      const log = path.join(tmp, 'stub.log');
      fs.writeFileSync(log, '');
      fs.mkdirSync(path.join(repo, '.env'));
      const result = runStubbed(INSTALL, ['--dir', toBashPath(repo)], tmp, log);
      assert.strictEqual(result.status, 1, result.stdout);
      assert.match(result.stderr, /ليس ملفًا عاديًا/);
      assert.ok(!logLines(log).some((line) => line.startsWith('docker compose up')), 'compose ran with a .env directory');
    });
  });

  test('a dangling .env symlink is rejected before writing through the link', (t) => {
    if (!bashAvailable()) {
      t.skip('bash is not available on this host');
      return;
    }
    withTemp((tmp) => {
      const repo = makeRepo(tmp);
      const envPath = path.join(repo, '.env');
      const target = path.join(tmp, 'outside.env');
      try {
        fs.symlinkSync(target, envPath, 'file');
      } catch (err) {
        t.skip(`symlink creation is not permitted on this host: ${(err as Error).message}`);
        return;
      }
      const log = path.join(tmp, 'stub.log');
      fs.writeFileSync(log, '');
      const result = runStubbed(INSTALL, ['--dir', toBashPath(repo)], tmp, log);
      assert.strictEqual(result.status, 1, result.stdout);
      assert.match(result.stderr, /ليس ملفًا عاديًا/);
      assert.ok(fs.lstatSync(envPath).isSymbolicLink(), 'the guard replaced the symlink');
      assert.ok(!fs.existsSync(target), 'the guard wrote through the dangling symlink');
      assert.ok(!logLines(log).some((line) => line.startsWith('docker compose up')), 'compose ran with a dangling .env symlink');
      assert.ok(!fs.existsSync(path.join(tmp, 'madar.service.stubbed.service')), 'the boot unit was rendered despite the guard');
    });
  });

  test('port preflight reads the effective WSD_EMBED_PROXY_PORT from .env', (t) => {
    if (!bashAvailable()) {
      t.skip('bash is not available on this host');
      return;
    }
    withTemp((tmp) => {
      const repo = makeRepo(tmp);
      const log = path.join(tmp, 'stub.log');
      fs.writeFileSync(log, '');
      fs.writeFileSync(path.join(repo, '.env'), 'WSD_EMBED_PROXY_PORT=4321 # custom\n');
      const result = runStubbed(INSTALL, ['--dir', toBashPath(repo)], tmp, log, {
        stackRunning: false,
        busyPort: '4321',
      });
      assert.strictEqual(result.status, 1, result.stdout);
      assert.match(result.stderr, /المنفذ 4321 مستخدم بالفعل/);
      assert.ok(!logLines(log).some((line) => line.startsWith('docker compose up')), 'compose ran on a busy effective port');
    });
  });

  test('port preflight falls back to 4097 when .env has no embed port', (t) => {
    if (!bashAvailable()) {
      t.skip('bash is not available on this host');
      return;
    }
    withTemp((tmp) => {
      const repo = makeRepo(tmp);
      const log = path.join(tmp, 'stub.log');
      fs.writeFileSync(log, '');
      fs.writeFileSync(path.join(repo, '.env'), 'MADAR_TEST_SENTINEL=keep-me\n');
      const result = runStubbed(INSTALL, ['--dir', toBashPath(repo)], tmp, log, {
        stackRunning: false,
        busyPort: '4097',
      });
      assert.strictEqual(result.status, 1, result.stdout);
      assert.match(result.stderr, /المنفذ 4097 مستخدم بالفعل/);
    });
  });

  test('health polling enforces the 120s deadline and clamps each curl timeout', () => {
    assert.match(INSTALL_SRC, /SECONDS \+ 120/);
    assert.match(INSTALL_SRC, /remaining=\$\(\( deadline - SECONDS \)\)/);
    assert.match(INSTALL_SRC, /\(\( remaining > 0 \)\) \|\| return 1/);
    assert.match(INSTALL_SRC, /--max-time "\$timeout"/);
    assert.match(INSTALL_SRC, /\(\( SECONDS < deadline \)\) \|\| return 1/);
  });

  test('temp unit is created with mktemp, cleaned via trap and installed with 0644', () => {
    assert.match(INSTALL_SRC, /mktemp "\$\{XDG_RUNTIME_DIR:-\$\{TMPDIR:-\/tmp\}\}\/madar\.service\.XXXXXX"/);
    assert.match(INSTALL_SRC, /trap 'rm -f "\$unit_tmp"' EXIT/);
    assert.match(INSTALL_SRC, /install -m 0644 "\$unit_tmp" "\$SYSTEMD_UNIT"/);
    assert.match(INSTALL_SRC, /trap - EXIT/);
  });

  test('default uninstall keeps volumes, compose file and workspaces untouched', (t) => {
    if (!bashAvailable()) {
      t.skip('bash is not available on this host');
      return;
    }
    withTemp((tmp) => {
      const repo = makeRepo(tmp);
      const log = path.join(tmp, 'stub.log');
      fs.writeFileSync(log, '');
      const envFile = path.join(repo, '.env');
      fs.writeFileSync(envFile, 'JWT_SECRET=\nMADAR_TEST_SENTINEL=keep-me\n');

      const result = runStubbed(UNINSTALL, ['--dir', toBashPath(repo)], tmp, log);
      assert.strictEqual(result.status, 0, `${result.stderr}\n${result.stdout}`);
      assert.match(result.stdout, /الاحتفاظ بالبيانات/);
      assert.match(result.stdout, /لم تُلمس/);
      assert.match(result.stdout, /لم تُحذف/);

      const calls = logLines(log);
      assert.ok(calls.includes('docker compose down'), calls.join('\n'));
      assert.ok(!calls.includes('docker compose down -v'), calls.join('\n'));
      assert.ok(!calls.some((line) => line.startsWith('systemctl')), 'non-root branch must not call systemctl directly');
      assert.ok(fs.existsSync(envFile), 'uninstall removed .env');
      assert.ok(fs.existsSync(path.join(repo, 'docker-compose.yml')), 'uninstall removed compose file');
      assert.match(fs.readFileSync(path.join(repo, 'workspaces', 'canary.txt'), 'utf8'), /canary/);
    });
  });

  test('--remove-data refuses without a TTY before any unit or compose operation', (t) => {
    if (!bashAvailable()) {
      t.skip('bash is not available on this host');
      return;
    }
    withTemp((tmp) => {
      const repo = makeRepo(tmp);
      const log = path.join(tmp, 'stub.log');
      fs.writeFileSync(log, '');
      const result = runStubbed(UNINSTALL, ['--remove-data', '--dir', toBashPath(repo)], tmp, log);
      assert.strictEqual(result.status, 1, result.stdout);
      assert.match(result.stderr, /تأكيد تفاعلي/);
      assert.match(result.stderr, /لم يُحذف أي شيء/);
      assert.strictEqual(logLines(log).length, 0, 'a refused destructive uninstall touched systemd or compose');

      const lines = UNINSTALL_SRC.split(/\r?\n/);
      const ttyIdx = lines.findIndex((line) => line.includes('-t 0'));
      const readIdx = lines.findIndex((line) => line.includes('read -r -p'));
      const confirmIdx = lines.findIndex((line) => /yes\|YES\|Yes\|نعم/.test(line));
      const guardIdx = lines.findIndex((line) => line.includes("unit_wd=\"$(awk"));
      const destructiveIdx = lines.findIndex((line) => line.trim() === 'docker compose down -v');
      const defaultIdx = lines.findIndex((line) => line.trim() === 'docker compose down');
      assert.ok(ttyIdx >= 0 && readIdx > ttyIdx, 'the TTY guard must precede the confirmation prompt');
      assert.ok(confirmIdx > readIdx, 'the yes branch must follow the prompt');
      assert.ok(guardIdx > confirmIdx, 'the confirmation must precede the systemd unit guard');
      assert.ok(destructiveIdx > guardIdx, 'down -v must live after the unit guard');
      assert.ok(defaultIdx > destructiveIdx, 'the non-destructive default must remain the fallback');
    });
  });

  test('README documents the hardened install contract', () => {
    const readme = fs.readFileSync(README, 'utf8');
    assert.match(readme, /لا يحتاج جهازك Node\.js/);
    assert.match(readme, /داخل Docker/);
    assert.match(readme, /bash scripts\/install\.sh/);
    assert.match(readme, /bash scripts\/uninstall\.sh/);
    assert.match(readme, /--remove-data/);
    assert.match(readme, /\b3000\b/);
    assert.match(readme, /\b4097\b/);
    assert.ok(mentionsTlsBoth(readme), 'README must require TLS in front of 3000 and 4097 together');
    assert.match(readme, /### التثبيت اليدوي — Manual/);
    assert.match(readme, /docker compose up -d --build/);
    assert.match(readme, /سحب `--ff-only` ثم إعادة بناء وفحص صحة وتحديث وحدة systemd/);
    assert.match(readme, /systemd هو العملية رقم 1 فعليًا/);
    assert.match(readme, /WSL2/);
    assert.match(readme, /--no-systemd/);
    assert.match(readme, /تثبيت Madar واحد فقط على كل مضيف/);
    assert.match(readme, /WorkingDirectory/);
    assert.match(readme, /NoNewPrivileges=true/);
    assert.match(readme, /لا يسحب كودًا جديدًا/);
  });

  test('docs/INSTALL.md documents the same hardened contract', () => {
    const doc = fs.readFileSync(INSTALL_DOC, 'utf8');
    assert.match(doc, /لا يحتاج جهازك Node\.js/);
    assert.match(doc, /داخل Docker/);
    assert.match(doc, /bash scripts\/install\.sh/);
    assert.match(doc, /uninstall\.sh --remove-data/);
    assert.match(doc, /\b3000\b/);
    assert.match(doc, /\b4097\b/);
    assert.ok(mentionsTlsBoth(doc), 'docs/INSTALL.md must require TLS in front of 3000 and 4097 together');
    assert.match(doc, /## التثبيت اليدوي — Manual/);
    assert.match(doc, /docker compose up -d --build/);
    assert.match(doc, /`awk` و`grep` و`cut` و`tr`/);
    assert.match(doc, /systemd حقيقي كعملية رقم 1/);
    assert.match(doc, /--no-systemd/);
    assert.match(doc, /WSD_EMBED_PROXY_PORT/);
    assert.match(doc, /تثبيت Madar واحد فقط على كل مضيف/);
    assert.match(doc, /WorkingDirectory/);
    assert.match(doc, /NoNewPrivileges=true/);
    assert.match(doc, /لم يُحذف أي شيء/);
    assert.match(doc, /سحب `--ff-only` ثم إعادة بناء وفحص صحة وتحديث وحدة systemd/);
  });
});
