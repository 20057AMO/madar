import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { register } from 'node:module';
import os from 'node:os';
import path from 'node:path';

register(new URL('./ts-ext-resolve.mjs', import.meta.url).href);

const {
  isAllowedGitPushRemote,
  listProjectGitRepositories,
  pushProjectGit,
} = await import('../src/services/project-git.ts');

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function createWorkspace(): { root: string; workspace: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'madar-project-git-'));
  temporaryRoots.push(root);
  const workspace = path.join(root, 'git-test');
  fs.mkdirSync(workspace);
  return { root, workspace };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function initRepository(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Madar Test');
  git(dir, 'config', 'user.email', 'madar-test@example.invalid');
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'original\n');
  git(dir, 'add', 'tracked.txt');
  git(dir, 'commit', '-q', '-m', 'initial');
}

test('Git status discovers a repository and reports tracked and untracked changes', async () => {
  const { root, workspace } = createWorkspace();
  initRepository(workspace);
  fs.writeFileSync(path.join(workspace, 'tracked.txt'), 'updated\n');
  fs.writeFileSync(path.join(workspace, 'new.txt'), 'new file\n');

  const repos = await listProjectGitRepositories(root, 'git-test');
  assert.strictEqual(repos.length, 1);
  assert.strictEqual(repos[0].path, '');
  assert.strictEqual(repos[0].branch, 'main');
  assert.deepStrictEqual(repos[0].changes.map((change) => change.path).sort(), ['new.txt', 'tracked.txt']);
  assert.match(repos[0].diff, /updated/);
});

test('Git status discovers a repository cloned into a workspace subdirectory', async () => {
  const { root, workspace } = createWorkspace();
  const nested = path.join(workspace, 'repository');
  initRepository(nested);

  const repos = await listProjectGitRepositories(root, 'git-test');
  assert.deepStrictEqual(repos.map((repo) => repo.path), ['repository']);
});

test('Git status returns an empty list for a workspace without repositories', async () => {
  const { root } = createWorkspace();
  assert.deepStrictEqual(await listProjectGitRepositories(root, 'git-test'), []);
});

test('Git push rejects an unsafe repository path before running Git', async () => {
  const { root } = createWorkspace();
  await assert.rejects(
    pushProjectGit(root, 'git-test', '../outside'),
    /Invalid path|outside/i,
  );
});

test('Git push remotes accept HTTPS and SSH and reject local or helper protocols', () => {
  assert.strictEqual(isAllowedGitPushRemote('https://github.com/org/repo.git'), true);
  assert.strictEqual(isAllowedGitPushRemote('ssh://git@github.com/org/repo.git'), true);
  assert.strictEqual(isAllowedGitPushRemote('git@github.com:org/repo.git'), true);
  assert.strictEqual(isAllowedGitPushRemote('file:///etc/passwd'), false);
  assert.strictEqual(isAllowedGitPushRemote('ext::sh -c whoami'), false);
  assert.strictEqual(isAllowedGitPushRemote('http://github.com/org/repo.git'), false);
  assert.strictEqual(isAllowedGitPushRemote('ssh://-oProxyCommand=invalid/repo'), false);
  assert.strictEqual(isAllowedGitPushRemote('-oProxyCommand@github.com:org/repo.git'), false);
});

test('Git push refuses a configured remote that uses a non-HTTPS/SSH transport', async () => {
  const { root, workspace } = createWorkspace();
  initRepository(workspace);
  const baseCommit = git(workspace, 'rev-parse', 'HEAD');
  git(workspace, 'remote', 'add', 'origin', 'ext::invalid-helper');
  git(workspace, 'update-ref', 'refs/remotes/origin/main', baseCommit);
  git(workspace, 'config', 'branch.main.remote', 'origin');
  git(workspace, 'config', 'branch.main.merge', 'refs/heads/main');
  fs.writeFileSync(path.join(workspace, 'tracked.txt'), 'local commit\n');
  git(workspace, 'add', 'tracked.txt');
  git(workspace, 'commit', '-q', '-m', 'local change');

  await assert.rejects(
    pushProjectGit(root, 'git-test', ''),
    /HTTPS or SSH/i,
  );
});
