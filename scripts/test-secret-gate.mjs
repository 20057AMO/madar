#!/usr/bin/env node
// Offline proofs for the local secret gate. Uses throwaway repos outside this checkout.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { REPO_ROOT, CONFIG_NAME, GateError, binPaths, verifyInstalled, runScan } from './check-secrets.mjs';

const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'madar-secret-gate-test-'));
const SOURCE = {
  config: path.join(REPO_ROOT, CONFIG_NAME),
  script: path.join(REPO_ROOT, 'scripts', 'check-secrets.mjs'),
  hook: path.join(REPO_ROOT, '.githooks', 'pre-commit'),
};

function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
}

function makeRepo(name) {
  const dir = path.join(TEMP_ROOT, name);
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.githooks'), { recursive: true });
  fs.copyFileSync(SOURCE.config, path.join(dir, CONFIG_NAME));
  fs.copyFileSync(SOURCE.script, path.join(dir, 'scripts', 'check-secrets.mjs'));
  fs.copyFileSync(SOURCE.hook, path.join(dir, '.githooks', 'pre-commit'));
  fs.chmodSync(path.join(dir, '.githooks', 'pre-commit'), 0o755);
  for (const call of [
    ['init', '-q'],
    ['config', 'user.email', 'gate-test@example.invalid'],
    ['config', 'user.name', 'Gate Test'],
    ['config', 'core.hooksPath', '.githooks'],
  ]) {
    const result = git(call, dir);
    assert.equal(result.status, 0, 'git ' + call[0] + ' failed in temp repo: ' + (result.stderr || '').trim());
  }
  return dir;
}

function writeFile(repo, rel, content) {
  const target = path.join(repo, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}

// Generated in memory, never printed and never a real credential.
function fakeAwsKey() {
  return 'AKIA' + crypto.randomBytes(12).toString('hex').toUpperCase();
}
function retiredPublicLiteral(sourceRel, index) {
  const source = fs.readFileSync(path.join(REPO_ROOT, sourceRel), 'utf8');
  const values = [...new Set(Array.from(source.matchAll(/'(wsd-pro-(?:insecure-default|default-secret-change-me))'/g), function (match) { return match[1]; }))];
  assert.ok(values.length >= 2, 'expected two retired public literals in ' + sourceRel);
  return values[index];
}

after(function () {
  fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
});
test('installed gitleaks binary is present and verified', function () {
  assert.doesNotThrow(function () { verifyInstalled(); });
});

test('a generated fake secret is rejected by the pre-commit hook', function () {
  const repo = makeRepo('reject');
  writeFile(repo, 'leak.txt', 'api_key = "' + fakeAwsKey() + '"\n');
  assert.equal(git(['add', 'leak.txt'], repo).status, 0);
  const commit = git(['commit', '-m', 'gate should refuse this'], repo);
  assert.notEqual(commit.status, 0, 'the hook allowed a generated secret');
  assert.match((commit.stdout || '') + (commit.stderr || ''), /Secret gate blocked the commit|gitleaks/i);
});

test('a clean file is accepted by the pre-commit hook', function () {
  const repo = makeRepo('accept');
  writeFile(repo, 'notes.txt', 'ordinary content\n');
  assert.equal(git(['add', 'notes.txt'], repo).status, 0);
  const commit = git(['commit', '-m', 'clean content'], repo);
  assert.equal(commit.status, 0, 'clean commit was refused');
  assert.match((commit.stdout || '') + (commit.stderr || ''), /Secret gate passed/);
});

test('a normal git commit -a succeeds through the installed hook', function () {
  const repo = makeRepo('plain-a');
  writeFile(repo, 'tracked.txt', 'first line\n');
  assert.equal(git(['add', 'tracked.txt'], repo).status, 0);
  assert.equal(git(['commit', '-m', 'seed'], repo).status, 0);
  writeFile(repo, 'tracked.txt', 'first line\nsecond line\n');
  const commit = git(['commit', '-a', '-m', 'ordinary edit'], repo);
  assert.equal(commit.status, 0, 'clean commit was refused');
  assert.match((commit.stdout || '') + (commit.stderr || ''), /Secret gate passed/);
});

test('an allowlisted path is not a blanket exemption', function () {
  const repo = makeRepo('allowlist');
  writeFile(repo, 'backend/src/services/jwt-secret-core.ts', 'const key = "' + fakeAwsKey() + '";\n');
  assert.equal(git(['add', 'backend/src/services/jwt-secret-core.ts'], repo).status, 0);
  const commit = git(['commit', '-m', 'must be refused'], repo);
  assert.notEqual(commit.status, 0, 'a real-looking secret in an allowlisted path was allowed');
});
test('retired public JWT literals are allowed only at their exact paths', function () {
  const fixtures = [
    { rel: 'backend/src/services/jwt-secret-core.ts', index: 0 },
    { rel: 'backend/tests/jwt-secret.test.ts', index: 1 },
  ];

  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let genericValue = '';
  for (let i = 0; i < 32; i += 1) {
    genericValue += alphabet[crypto.randomInt(alphabet.length)];
  }
  const controlRepo = makeRepo('public-literal-control');
  writeFile(controlRepo, fixtures[0].rel, 'api_key = "' + genericValue + '"\n');
  assert.equal(git(['add', fixtures[0].rel], controlRepo).status, 0);
  const controlCommit = git(['commit', '-m', 'must be refused'], controlRepo);
  assert.notEqual(controlCommit.status, 0, 'a generic-api-key value in an allowlisted path was accepted');

  const repo = makeRepo('public-literal-allowlist');
  for (const fixture of fixtures) {
    const value = retiredPublicLiteral(fixture.rel, fixture.index);
    writeFile(repo, fixture.rel, 'api_key = "' + value + '"\n');
  }
  assert.equal(git(['add', ...fixtures.map(function (fixture) { return fixture.rel; })], repo).status, 0);
  const commit = git(['commit', '-m', 'public fixtures allowed by exact match'], repo);
  assert.equal(commit.status, 0, 'a retired public literal was refused in its allowlisted path');
  assert.match((commit.stdout || '') + (commit.stderr || ''), /Secret gate passed/);
});
test('a missing tool fails closed', function () {
  const repo = makeRepo('missing-tool');
  const installDir = path.join(TEMP_ROOT, 'absent-install');
  assert.throws(
    function () { runScan({ installDir, repoRoot: repo }); },
    function (error) { return error instanceof GateError && /missing/i.test(error.message); }
  );
});

test('a tampered tool fails closed', function () {
  const repo = makeRepo('tampered-tool');
  const installDir = path.join(TEMP_ROOT, 'tampered-install');
  fs.mkdirSync(installDir, { recursive: true });
  const target = binPaths(installDir);
  fs.copyFileSync(binPaths().binary, target.binary);
  fs.writeFileSync(target.state, JSON.stringify({ version: '8.28.0', binarySha256: '0'.repeat(64) }));
  assert.throws(
    function () { runScan({ installDir, repoRoot: repo }); },
    function (error) { return error instanceof GateError && /integrity/i.test(error.message); }
  );
});

test('a fake tool with a matching record fails closed', function () {
  const repo = makeRepo('fake-tool');
  const installDir = path.join(TEMP_ROOT, 'fake-install');
  fs.mkdirSync(installDir, { recursive: true });
  const paths = binPaths(installDir);
  const bytes = Buffer.from('this is not gitleaks\n', 'utf8');
  fs.writeFileSync(paths.binary, bytes);
  fs.writeFileSync(paths.state, JSON.stringify({
    version: '8.28.0',
    binarySha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  }));
  assert.throws(
    function () { runScan({ installDir, repoRoot: repo }); },
    function (error) { return error instanceof GateError && /gitleaks/i.test(error.message); }
  );
});
