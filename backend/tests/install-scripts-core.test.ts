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
const PROD_OVERLAY = path.join(ROOT, 'docker-compose.prod-tls.yml');
const NGINX_CONF = path.join(ROOT, 'deploy', 'nginx', 'madar.conf');
const PROD_BINDING = path.join(ROOT, 'scripts', 'check-prod-binding.sh');
const RENEW_SERVICE = path.join(ROOT, 'packaging', 'systemd', 'certbot-renew.service');
const RENEW_TIMER = path.join(ROOT, 'packaging', 'systemd', 'certbot-renew.timer');

const INSTALL_SRC = fs.readFileSync(INSTALL, 'utf8');
const UNINSTALL_SRC = fs.readFileSync(UNINSTALL, 'utf8');
const UNIT_SRC = fs.readFileSync(UNIT_TEMPLATE, 'utf8');
const PROD_OVERLAY_SRC = fs.readFileSync(PROD_OVERLAY, 'utf8');
const NGINX_CONF_SRC = fs.readFileSync(NGINX_CONF, 'utf8');
const PROD_BINDING_SRC = fs.readFileSync(PROD_BINDING, 'utf8');
const RENEW_SERVICE_SRC = fs.readFileSync(RENEW_SERVICE, 'utf8');
const RENEW_TIMER_SRC = fs.readFileSync(RENEW_TIMER, 'utf8');

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
  fs.mkdirSync(path.join(repo, 'deploy', 'nginx'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'deploy', 'certbot'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'workspaces'), { recursive: true });
  fs.copyFileSync(UNIT_TEMPLATE, path.join(repo, 'packaging', 'systemd', 'madar.service'));
  fs.copyFileSync(RENEW_SERVICE, path.join(repo, 'packaging', 'systemd', 'certbot-renew.service'));
  fs.copyFileSync(RENEW_TIMER, path.join(repo, 'packaging', 'systemd', 'certbot-renew.timer'));
  fs.writeFileSync(path.join(repo, 'scripts', 'install.sh'), '#!/usr/bin/env bash\n');
  fs.writeFileSync(path.join(repo, 'scripts', 'check-prod-binding.sh'), '#!/usr/bin/env bash\n: > .prod-binding-checked\n');
  fs.writeFileSync(path.join(repo, 'deploy', 'nginx', 'madar.conf'), [
    'server {',
    '    listen 80;',
    '    server_name madar.example.com;',
    '    root /var/www/certbot;',
    '    listen 4097 ssl;',
    '    location / { proxy_pass http://127.0.0.1:3000; }',
    '}',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(repo, 'deploy', 'certbot', 'obtain.sh'), '#!/usr/bin/env bash\n: > "$MADAR_WEBROOT/obtain-ran"\n');
  fs.writeFileSync(path.join(repo, 'deploy', 'certbot', 'renew.sh'), '#!/usr/bin/env bash\nexit 0\n');
  fs.writeFileSync(path.join(repo, '.env.example'), '# test fixture only\nJWT_SECRET=\nMADAR_TEST_SENTINEL=keep-me\n');
  fs.writeFileSync(path.join(repo, 'docker-compose.yml'), 'services: {}\n');
  fs.writeFileSync(path.join(repo, 'docker-compose.prod-tls.yml'), 'services: {}\n');
  fs.writeFileSync(path.join(repo, 'workspaces', 'canary.txt'), 'canary\n');
  return repo;
}

function prodEnv(tmp: string): Record<string, string> {
  return {
    MADAR_WEBROOT: toBashPath(path.join(tmp, 'webroot')),
    MADAR_NGINX_CONF: toBashPath(path.join(tmp, 'nginx', 'madar.conf')),
    MADAR_CERTBOT_SERVICE_UNIT: toBashPath(path.join(tmp, 'certbot-renew.service')),
    MADAR_CERTBOT_TIMER_UNIT: toBashPath(path.join(tmp, 'certbot-renew.timer')),
  };
}

type StubOpts = {
  dirty?: boolean;
  stackRunning?: boolean;
  origin?: string;
  busyPort?: string;
  root?: boolean;
  env?: Record<string, string>;
};

function stubPrelude(tmp: string, log: string, opts: StubOpts): string {
  const envLines = Object.entries(opts.env ?? {})
    .map(([key, value]) => `export ${key}=${bashQuote(value)}`)
    .join('\n');
  const uid = opts.root ? '0' : '1000';
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
    `id() { stublog "id $*"; printf '%s\\n' '${uid}'; }`,
    'ip() { stublog "ip $*"; return 0; }',
    'nginx() { stublog "nginx $*"; return 0; }',
    'certbot() { stublog "certbot $*"; return 0; }',
    'bash() { stublog "bash $*"; command bash "$@"; }',
    'install() { stublog "install $*"; command install "$@"; }',
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

const COMPOSE_UP = /^docker compose\b.*\bup -d --build(?:\s|$)/;

function hasComposeUp(lines: string[]): boolean {
  return lines.some((line) => COMPOSE_UP.test(line));
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
    for (const flag of ['--dir', '--branch', '--no-systemd', '--prod-tls', '--domain', '--email', '--lan-ip', '--help']) {
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
      assert.ok(calls.includes('docker compose -f docker-compose.yml up -d --build'), 'dev compose up was never called');
      assert.ok(calls.some((line) => COMPOSE_UP.test(line)), 'compose up was never called');
      assert.ok(calls.some((line) => line.startsWith('curl -fsS')), 'health probe was never called');
      assert.ok(calls.some((line) => line.startsWith('systemctl')) === false, 'non-root branch must not call systemctl directly');

      const unitFile = path.join(tmp, 'madar.service.stubbed.service');
      const unit = fs.readFileSync(unitFile, 'utf8');
      const working = /^WorkingDirectory=(.+)$/m.exec(unit);
      assert.ok(working, 'the rendered unit has no WorkingDirectory');
      assert.strictEqual(working[1], `"${toBashPath(repo)}"`);
      assert.match(working[1].replace(/^"|"$/g, ''), /^\//, `WorkingDirectory is not an absolute POSIX path: ${working[1]}`);
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
      assert.match(INSTALL_SRC, /env_trust_proxy\(\)[\s\S]*?grep -m1 -E '\^\[\[:space:\]\]\*WSD_TRUST_PROXY='/);
      assert.match(INSTALL_SRC, /trust_value="\$\(env_trust_proxy "\$PWD\/\.env"\)"/);
      assert.match(INSTALL_SRC, /لا تضبط WSD_TRUST_PROXY في \.env/);
      assert.doesNotMatch(INSTALL_SRC, /^[[:space:]]*(?:export[[:space:]]+)?WSD_TRUST_PROXY[[:space:]]*=/m);
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
      assert.ok(!calls.some((line) => COMPOSE_UP.test(line)), calls.join('\n'));
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
      assert.ok(hasComposeUp(logLines(log)), 'Madar itself was not installed');
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
      assert.ok(!hasComposeUp(logLines(log)), 'compose ran before the origin check');
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
      assert.ok(!hasComposeUp(logLines(log)), 'compose ran despite the collision');
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
      assert.ok(!hasComposeUp(logLines(log)), 'compose ran with a .env directory');
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
      assert.ok(!hasComposeUp(logLines(log)), 'compose ran with a dangling .env symlink');
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
      assert.ok(!hasComposeUp(logLines(log)), 'compose ran on a busy effective port');
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

  test('temp unit and prod files are registered for cleanup and installed with 0644', () => {
    assert.match(INSTALL_SRC, /TEMP_FILES=\(\)/);
    assert.match(INSTALL_SRC, /cleanup\(\)\s*\{[\s\S]*?for file in "\$\{TEMP_FILES\[@\]\}"/);
    assert.match(INSTALL_SRC, /trap cleanup EXIT/);
    assert.match(INSTALL_SRC, /mktemp "\$\{XDG_RUNTIME_DIR:-\$\{TMPDIR:-\/tmp\}\}\/madar\.service\.XXXXXX"/);
    assert.match(INSTALL_SRC, /TEMP_FILES\+=\("\$unit_tmp"\)/);
    assert.match(INSTALL_SRC, /install -m 0644 "\$unit_tmp" "\$SYSTEMD_UNIT"/);
    assert.match(INSTALL_SRC, /TEMP_FILES\+=\("\$bootstrap_conf" "\$final_conf"\)/);
    assert.match(INSTALL_SRC, /TEMP_FILES\+=\("\$renew_service_tmp" "\$renew_timer_tmp"\)/);
    assert.match(INSTALL_SRC, /install -m 0644 "\$renew_service_tmp" "\$CERTBOT_SERVICE_UNIT"/);
    assert.match(INSTALL_SRC, /install -m 0644 "\$renew_timer_tmp" "\$CERTBOT_TIMER_UNIT"/);
    assert.match(INSTALL_SRC, /trap - EXIT/);
    assert.doesNotMatch(INSTALL_SRC, /trap 'rm -f "\$unit_tmp"' EXIT/);
  });

  test('prod overlay pins the app to loopback and trusts exactly one proxy hop', () => {
    assert.match(PROD_OVERLAY_SRC, /ports:\s*!override/);
    for (const bind of ['"127.0.0.1:3000:3000"', '"127.0.0.1:4097:4097"']) {
      assert.ok(PROD_OVERLAY_SRC.includes(bind), `prod overlay lost the loopback bind ${bind}`);
    }
    assert.doesNotMatch(PROD_OVERLAY_SRC, /"0\.0\.0\.0:/);
    assert.match(PROD_OVERLAY_SRC, /WSD_TRUST_PROXY:\s*"1"/);
    assert.match(PROD_OVERLAY_SRC, /WSD_EMBED_PROXY_PORT:\s*"4097"/);
    assert.match(PROD_OVERLAY_SRC, /WSD_EMBEDDED_PUBLISH_HOST:\s*"127\.0\.0\.1"/);
    assert.match(PROD_OVERLAY_SRC, /restart:\s*unless-stopped/);
    assert.match(PROD_OVERLAY_SRC, /max-size:\s*"10m"/);
    assert.match(PROD_OVERLAY_SRC, /healthcheck:/);
  });

  test('nginx template logs sanitized URIs and proxies both TLS surfaces', () => {
    assert.match(NGINX_CONF_SRC, /log_format\s+madar_safe\s+'[^']*"\$uri"[^']*'/);
    assert.doesNotMatch(NGINX_CONF_SRC, /\$request_uri/);
    assert.match(NGINX_CONF_SRC, /client_max_body_size 256m;/);
    assert.match(NGINX_CONF_SRC, /location \/\.well-known\/acme-challenge\//);
    assert.match(NGINX_CONF_SRC, /proxy_pass http:\/\/127\.0\.0\.1:3000;/);
    assert.match(NGINX_CONF_SRC, /proxy_pass http:\/\/127\.0\.0\.1:4097;/);
    assert.match(NGINX_CONF_SRC, /proxy_set_header X-Forwarded-Proto https;/);
    assert.match(NGINX_CONF_SRC, /proxy_set_header Upgrade \$http_upgrade;/);
  });

  test('prod binding guard rejects every drift from loopback-only binds and WSD_TRUST_PROXY=1', () => {
    for (const guard of [
      'BAD_HOST', 'INCOMPLETE_BINDING', 'TARGET_MISMATCH', 'UNEXPECTED_PORT',
      'BINDING_COUNT', 'PORT_SET', 'WSD_TRUST_PROXY', 'RUNTIME_BINDING_COUNT', 'RUNTIME_PORT_SET',
    ]) {
      assert.ok(PROD_BINDING_SRC.includes(guard), `binding guard lost the ${guard} check`);
    }
    assert.match(PROD_BINDING_SRC, /ok: app ports 3000 and 4097 are bound to 127\.0\.0\.1 and WSD_TRUST_PROXY=1/);
    assert.match(PROD_BINDING_SRC, /exit 1/);
  });

  test('certbot renewal unit runs through /bin/sh and the timer is persistent', () => {
    assert.match(RENEW_SERVICE_SRC, /^ExecStart=\/bin\/sh "@MADAR_DIR@\/deploy\/certbot\/renew\.sh"$/m);
    assert.doesNotMatch(RENEW_SERVICE_SRC, /ExecStart=.*\.\/deploy\/certbot\/renew\.sh/);
    assert.match(RENEW_SERVICE_SRC, /NoNewPrivileges=true/);
    assert.match(RENEW_TIMER_SRC, /^OnCalendar=/m);
    assert.match(RENEW_TIMER_SRC, /^Persistent=true$/m);
    assert.match(RENEW_TIMER_SRC, /^Unit=certbot-renew\.service$/m);
  });

  test('systemd template keeps dev and prod commands mutually exclusive and renders each branch', () => {
    assert.match(UNIT_SRC, /@DEV_ONLY@ExecStart=\/usr\/bin\/docker compose up -d$/m);
    assert.match(UNIT_SRC, /@PROD_TLS@ExecStart=\/usr\/bin\/docker compose -f docker-compose\.yml -f docker-compose\.prod-tls\.yml up -d --remove-orphans$/m);
    assert.match(UNIT_SRC, /@PROD_TLS@ExecStartPre=.*check-prod-binding\.sh/m);
    assert.match(INSTALL_SRC, /\[\[ "\$line" == @DEV_ONLY@\* \]\] && continue/);
    assert.match(INSTALL_SRC, /\[\[ "\$line" == @PROD_TLS@\* \]\] && line="\$\{line#@PROD_TLS@\}"/);
    assert.match(INSTALL_SRC, /\[\[ "\$line" == @PROD_TLS@\* \]\] && continue/);
    assert.match(INSTALL_SRC, /\[\[ "\$line" == @DEV_ONLY@\* \]\] && line="\$\{line#@DEV_ONLY@\}"/);
    assert.match(INSTALL_SRC, /systemctl enable --now certbot-renew\.timer/);
  });

  test('--prod-tls installs the TLS stack end to end without touching the dev surface', (t) => {
    if (!bashAvailable()) {
      t.skip('bash is not available on this host');
      return;
    }
    withTemp((tmp) => {
      const repo = makeRepo(tmp);
      const log = path.join(tmp, 'stub.log');
      fs.writeFileSync(log, '');
      const result = runStubbed(
        INSTALL,
        ['--dir', toBashPath(repo), '--prod-tls', '--domain', 'madar.example.test', '--email', 'admin@madar.example.test', '--lan-ip', '203.0.113.10'],
        tmp,
        log,
        { root: true, env: prodEnv(tmp) },
      );
      assert.strictEqual(result.status, 0, `${result.stderr}\n${result.stdout}`);

      const calls = logLines(log);
      const prodUp = 'docker compose -f docker-compose.yml -f docker-compose.prod-tls.yml up -d --build --remove-orphans';
      const devUp = 'docker compose -f docker-compose.yml up -d --build';
      const configCheck = 'docker compose -f docker-compose.yml -f docker-compose.prod-tls.yml config --quiet';
      assert.ok(calls.includes(prodUp), `prod compose up was never called:\n${calls.join('\n')}`);
      assert.strictEqual(calls.filter((line) => COMPOSE_UP.test(line)).length, 1, 'more than one compose up ran');
      assert.ok(!calls.includes(devUp), 'the dev compose up ran in prod mode');
      assert.ok(calls.indexOf(configCheck) >= 0 && calls.indexOf(configCheck) < calls.indexOf(prodUp), 'prod compose config did not precede up');
      assert.ok(calls.includes('bash deploy/certbot/obtain.sh'), 'certificate acquisition never ran');
      assert.strictEqual(calls.filter((line) => line === 'nginx -t').length, 2, 'both nginx config checks must run');
      assert.ok(calls.includes('systemctl enable --now certbot-renew.timer'), 'renewal timer was not enabled');
      assert.ok(
        calls.includes(`bash scripts/check-prod-binding.sh --dir ${toBashPath(repo)} --check-running`),
        'the running binding guard was not invoked',
      );
      assert.ok(fs.existsSync(path.join(tmp, 'webroot', 'obtain-ran')), 'obtain.sh did not run');
      assert.ok(fs.existsSync(path.join(repo, '.prod-binding-checked')), 'the binding guard did not run');

      const unit = fs.readFileSync(path.join(tmp, 'systemd-unit', 'madar.service'), 'utf8');
      assert.match(unit, /^ExecStart=\/usr\/bin\/docker compose -f docker-compose\.yml -f docker-compose\.prod-tls\.yml up -d --remove-orphans$/m);
      assert.doesNotMatch(unit, /^ExecStart=\/usr\/bin\/docker compose up -d$/m);
      assert.match(unit, /^ExecStartPre=.*check-prod-binding\.sh/m);
      assert.doesNotMatch(unit, /@MADAR_/);

      const renew = fs.readFileSync(path.join(tmp, 'certbot-renew.service'), 'utf8');
      assert.match(renew, /^Environment=MADAR_DOMAIN=madar\.example\.test$/m);
      assert.match(renew, /^Environment=MADAR_EMAIL=admin@madar\.example\.test$/m);
      assert.ok(renew.includes(`Environment=MADAR_WEBROOT=${toBashPath(path.join(tmp, 'webroot'))}`));
      assert.ok(renew.includes(`Environment=MADAR_NGINX_CONF=${toBashPath(path.join(tmp, 'nginx', 'madar.conf'))}`));
      assert.doesNotMatch(renew, /@MADAR_/);
      const timer = fs.readFileSync(path.join(tmp, 'certbot-renew.timer'), 'utf8');
      assert.match(timer, /^Persistent=true$/m);

      const finalConf = fs.readFileSync(path.join(tmp, 'nginx', 'madar.conf'), 'utf8');
      assert.match(finalConf, /server_name madar\.example\.test;/);
      assert.ok(finalConf.includes('listen 203.0.113.10:4097 ssl;'));
      assert.ok(finalConf.includes(`root ${toBashPath(path.join(tmp, 'webroot'))};`));
      assert.doesNotMatch(finalConf, /madar\.example\.com/);

      assert.match(result.stdout, /اللوحة: https:\/\/madar\.example\.test/);
      assert.match(result.stdout, /https:\/\/madar\.example\.test:4097/);
      assert.ok(result.stdout.includes('203.0.113.10:4097'), 'the public TLS port was not reported');
    });
  });

  test('unsafe prod-TLS inputs are refused before compose or certificate side effects', (t) => {
    if (!bashAvailable()) {
      t.skip('bash is not available on this host');
      return;
    }
    const valid = ['--prod-tls', '--domain', 'madar.example.test', '--email', 'admin@madar.example.test', '--lan-ip', '203.0.113.10'];
    const cases = [
      { label: 'missing domain', args: ['--prod-tls', '--email', 'admin@madar.example.test', '--lan-ip', '203.0.113.10'], error: /قيمة --domain غير صالحة/ },
      { label: 'placeholder domain', args: ['--prod-tls', '--domain', 'madar.example.com', '--email', 'admin@madar.example.test', '--lan-ip', '203.0.113.10'], error: /قيمة --domain غير صالحة/ },
      { label: 'placeholder email', args: ['--prod-tls', '--domain', 'madar.example.test', '--email', 'admin@madar.example.com', '--lan-ip', '203.0.113.10'], error: /قيمة --email غير صالحة/ },
      { label: 'loopback LAN IP', args: ['--prod-tls', '--domain', 'madar.example.test', '--email', 'admin@madar.example.test', '--lan-ip', '127.0.0.1'], error: /تعذّر تحديد عنوان IPv4 عام صالح/ },
      { label: 'trusted proxy in .env', args: valid, envFile: 'WSD_TRUST_PROXY=1\n', error: /لا تضبط WSD_TRUST_PROXY في \.env/ },
      { label: 'non-root', args: valid, root: false, error: /يحتاج صلاحيات root/ },
      { label: '--no-systemd', args: [...valid, '--no-systemd'], error: /الوضع --prod-tls يحتاج systemd/ },
    ];
    for (const c of cases) {
      withTemp((tmp) => {
        const repo = makeRepo(tmp);
        if (c.envFile) fs.writeFileSync(path.join(repo, '.env'), c.envFile);
        const log = path.join(tmp, 'stub.log');
        fs.writeFileSync(log, '');
        const result = runStubbed(INSTALL, ['--dir', toBashPath(repo), ...c.args], tmp, log, {
          root: c.root ?? true,
          env: prodEnv(tmp),
        });
        assert.strictEqual(result.status, 1, `${c.label}: ${result.stdout}`);
        assert.match(result.stderr, c.error, c.label);
        assert.ok(!hasComposeUp(logLines(log)), `${c.label}: compose up ran before the refusal`);
        assert.ok(!fs.existsSync(path.join(tmp, 'webroot', 'obtain-ran')), `${c.label}: a certificate was obtained`);
        assert.ok(!fs.existsSync(path.join(repo, '.prod-binding-checked')), `${c.label}: the binding guard ran`);
      });
    }
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
    for (const fact of [
      /127\.0\.0\.1:3000/,
      /127\.0\.0\.1:4097/,
      /نسخة تطبيق واحدة فقط/,
      /docker-compose\.prod-tls\.yml/,
      /--prod-tls/,
      /--domain/,
      /--email/,
      /--lan-ip/,
      /WSD_TRUST_PROXY=1/,
      /client_max_body_size 256m/,
      /\$uri/,
      /check-prod-binding\.sh/,
      /certbot-renew\.timer/,
    ]) {
      assert.match(doc, fact, `docs/INSTALL.md is missing prod-TLS fact: ${fact}`);
    }
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
