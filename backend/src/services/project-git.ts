import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { canonicalProjectSlug } from './project-slug-core';
import { resolveContainedPath } from './workspace-paths-core';

const MAX_REPOSITORIES = 20;
const MAX_SCANNED_DIRECTORIES = 300;
const MAX_DIFF_BYTES = 48 * 1024;
const COMMAND_TIMEOUT_MS = 15_000;
const PUSH_TIMEOUT_MS = 120_000;
const SKIP_DIRECTORIES = new Set([
  '.archive', '.git', '.next', '.venv', 'build', 'dist', 'node_modules', 'target', 'vendor',
]);
const GIT_CONFIG_ARGS = [
  '-c', 'core.fsmonitor=false',
  '-c', 'core.untrackedCache=false',
  '-c', 'protocol.allow=never',
  '-c', 'protocol.https.allow=always',
  '-c', 'protocol.ssh.allow=always',
];

export interface ProjectGitChange {
  path: string;
  status: string;
}

export interface ProjectGitRepository {
  path: string;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: ProjectGitChange[];
  diff: string;
  diffTruncated: boolean;
}

export class ProjectGitError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'ProjectGitError';
    this.statusCode = statusCode;
  }
}

interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

function commandEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_') && key !== 'GIT_SSH_AUTH_SOCK') delete env[key];
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

function gitArgs(args: string[]): string[] {
  return [...GIT_CONFIG_ARGS, ...args];
}

function runGit(
  cwd: string,
  args: string[],
  options: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<GitResult> {
  const maxBytes = options.maxBytes ?? 16 * 1024;
  const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    const proc = spawn('git', gitArgs(args), {
      cwd,
      env: commandEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, timeoutMs);

    const collect = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      const current = target === 'stdout' ? stdoutBytes : stderrBytes;
      const available = Math.max(0, maxBytes - current);
      const accepted = chunk.subarray(0, available);
      if (accepted.length < chunk.length) truncated = true;
      if (target === 'stdout') {
        stdout += accepted.toString('utf8');
        stdoutBytes += accepted.length;
      } else {
        stderr += accepted.toString('utf8');
        stderrBytes += accepted.length;
      }
    };

    proc.stdout.on('data', (chunk: Buffer) => collect('stdout', chunk));
    proc.stderr.on('data', (chunk: Buffer) => collect('stderr', chunk));
    proc.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ProjectGitError(503, `Git could not be started: ${err.message}`));
    });
    proc.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, truncated });
    });
  });
}

function inside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
}

function repositoryMarker(dir: string): boolean {
  try {
    const stat = fs.lstatSync(path.join(dir, '.git'));
    return !stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

function parseChanges(raw: string): ProjectGitChange[] {
  const fields = raw.split('\0');
  const changes: ProjectGitChange[] = [];
  for (let i = 0; i < fields.length; i++) {
    const row = fields[i];
    if (!row || row.length < 4) continue;
    const status = row.slice(0, 2).trim() || '??';
    const name = row.slice(3);
    changes.push({ path: name, status });
    if (/[RC]/.test(row.slice(0, 2))) i++;
  }
  return changes;
}

function positiveCount(raw: string): number {
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

async function gitOutput(cwd: string, args: string[]): Promise<string | null> {
  const result = await runGit(cwd, args);
  if (result.code !== 0 || result.timedOut) return null;
  return result.stdout.trim();
}

async function repositoryStatus(root: string, repoPath: string, dir: string): Promise<ProjectGitRepository | null> {
  const top = await gitOutput(dir, ['rev-parse', '--show-toplevel']);
  const gitDir = await gitOutput(dir, ['rev-parse', '--absolute-git-dir']);
  if (!top || !gitDir || !inside(root, gitDir)) return null;

  const realTop = fs.realpathSync(top);
  const realDir = fs.realpathSync(dir);
  if (realTop !== realDir || !inside(root, realTop)) return null;

  const branchName = await gitOutput(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = branchName && branchName !== 'HEAD' ? branchName : null;
  const remoteName = branch
    ? await gitOutput(dir, ['config', '--get', `branch.${branch}.remote`])
    : null;
  const mergeRef = branch
    ? await gitOutput(dir, ['config', '--get', `branch.${branch}.merge`])
    : null;
  const upstream = remoteName && mergeRef?.startsWith('refs/heads/')
    ? `${remoteName}/${mergeRef.slice('refs/heads/'.length)}`
    : null;

  let ahead = 0;
  let behind = 0;
  if (upstream) {
    const counts = await gitOutput(dir, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']);
    const match = counts?.match(/^(\d+)\s+(\d+)$/);
    if (match) {
      ahead = positiveCount(match[1]);
      behind = positiveCount(match[2]);
    }
  }

  const status = await runGit(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (status.code !== 0 || status.timedOut) {
    throw new ProjectGitError(500, 'Unable to read Git status for this repository');
  }

  const hasHead = (await runGit(dir, ['rev-parse', '--verify', 'HEAD'])).code === 0;
  const diffArgs = hasHead
    ? ['diff', '--no-ext-diff', '--no-textconv', '--unified=2', 'HEAD', '--']
    : ['diff', '--no-ext-diff', '--no-textconv', '--cached', '--unified=2', '--'];
  const diff = await runGit(dir, diffArgs, { maxBytes: MAX_DIFF_BYTES });
  if ((diff.code !== 0 && diff.code !== 1) || diff.timedOut) {
    throw new ProjectGitError(500, 'Unable to read Git changes for this repository');
  }

  return {
    path: repoPath,
    branch,
    upstream,
    ahead,
    behind,
    changes: parseChanges(status.stdout),
    diff: diff.stdout,
    diffTruncated: diff.truncated || diff.timedOut,
  };
}

function findRepositoryDirectories(
  workspacesRoot: string,
  slug: string,
  projectRoot: string,
): Array<{ path: string; dir: string }> {
  const found: Array<{ path: string; dir: string }> = [];
  const queue: Array<{ dir: string; relative: string; depth: number }> = [{ dir: projectRoot, relative: '', depth: 0 }];
  let scanned = 0;

  while (queue.length && found.length < MAX_REPOSITORIES && scanned < MAX_SCANNED_DIRECTORIES) {
    const current = queue.shift()!;
    scanned++;
    if (repositoryMarker(current.dir)) {
      found.push({ path: current.relative, dir: current.dir });
      continue;
    }
    if (current.depth >= 3) continue;

    const entries = fs.readdirSync(current.dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !SKIP_DIRECTORIES.has(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (scanned + queue.length >= MAX_SCANNED_DIRECTORIES) break;
      const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      const contained = resolveContainedPath(workspacesRoot, slug, relative, { mustExist: true });
      const stat = fs.lstatSync(contained);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      queue.push({ dir: contained, relative, depth: current.depth + 1 });
    }
  }

  return found;
}

export async function listProjectGitRepositories(
  workspacesRoot: string,
  rawSlug: unknown,
): Promise<ProjectGitRepository[]> {
  const slug = canonicalProjectSlug(rawSlug);
  if (!slug) throw new ProjectGitError(400, 'Invalid project slug');
  const projectRoot = resolveContainedPath(workspacesRoot, slug, '', { mustExist: true });
  return Promise.all(
    findRepositoryDirectories(workspacesRoot, slug, projectRoot).map(({ path: repoPath, dir }) =>
      repositoryStatus(projectRoot, repoPath, dir),
    ),
  ).then((rows) => rows.filter((row): row is ProjectGitRepository => row !== null));
}

export function isAllowedGitPushRemote(url: string): boolean {
  const value = url.trim();
  if (!value || /[\s\0]/.test(value)) return false;
  if (/^(https|ssh):\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      const username = decodeURIComponent(parsed.username);
      return (parsed.protocol === 'https:' || parsed.protocol === 'ssh:')
        && Boolean(parsed.hostname)
        && parsed.pathname.length > 1
        && !parsed.hostname.startsWith('-')
        && (!username || /^[A-Za-z0-9._][A-Za-z0-9._-]*$/.test(username));
    } catch {
      return false;
    }
  }
  return /^[A-Za-z0-9._][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*:[^\s:][^\s]*$/.test(value);
}

export async function pushProjectGit(
  workspacesRoot: string,
  rawSlug: unknown,
  rawRepoPath: unknown,
): Promise<{ branch: string; upstream: string; output: string }> {
  const slug = canonicalProjectSlug(rawSlug);
  if (!slug) throw new ProjectGitError(400, 'Invalid project slug');
  if (typeof rawRepoPath !== 'string' || rawRepoPath.length > 512 || rawRepoPath.includes('\0')) {
    throw new ProjectGitError(400, 'Invalid repository path');
  }

  const projectRoot = resolveContainedPath(workspacesRoot, slug, '', { mustExist: true });
  const repoPath = rawRepoPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const dir = resolveContainedPath(workspacesRoot, slug, repoPath, { mustExist: true });
  if (!repositoryMarker(dir)) throw new ProjectGitError(404, 'Git repository not found');
  const status = await repositoryStatus(projectRoot, repoPath, dir);
  if (!status || !status.branch) throw new ProjectGitError(409, 'This repository has no current branch to push');
  if (!status.upstream) throw new ProjectGitError(409, 'Configure an upstream branch before pushing');
  if (status.behind > 0) throw new ProjectGitError(409, 'Pull the upstream changes before pushing');
  if (status.ahead === 0) throw new ProjectGitError(409, 'There are no committed changes to push');

  const branch = status.branch;
  const remoteName = await gitOutput(dir, ['config', '--get', `branch.${branch}.remote`]);
  const branchMerge = await gitOutput(dir, ['config', '--get', `branch.${branch}.merge`]);
  const mergeRef = branchMerge || '';
  if (!remoteName || !/^[A-Za-z0-9._-]+$/.test(remoteName) || !mergeRef.startsWith('refs/heads/') || mergeRef.includes('..')) {
    throw new ProjectGitError(400, 'The upstream branch configuration is invalid');
  }
  const refCheck = await runGit(dir, ['check-ref-format', mergeRef]);
  if (refCheck.code !== 0) throw new ProjectGitError(400, 'The upstream branch configuration is invalid');

  const pushUrls = await runGit(dir, ['remote', 'get-url', '--push', '--all', remoteName]);
  const urls = pushUrls.stdout.split(/\r?\n/).map((url) => url.trim()).filter(Boolean);
  if (pushUrls.code !== 0 || urls.length !== 1 || !isAllowedGitPushRemote(urls[0])) {
    throw new ProjectGitError(400, 'Push supports one HTTPS or SSH remote only');
  }

  const pushed = await runGit(dir, [
    '-c', 'core.sshCommand=ssh -F /dev/null',
    '-c', 'push.recurseSubmodules=no',
    '-c', 'credential.helper=',
    'push', '--no-verify', '--porcelain', '--', remoteName, `HEAD:${mergeRef}`,
  ], { maxBytes: 16 * 1024, timeoutMs: PUSH_TIMEOUT_MS });
  if (pushed.timedOut) throw new ProjectGitError(504, 'Git push timed out');
  if (pushed.code !== 0) {
    throw new ProjectGitError(502, `Git push failed (exit ${pushed.code ?? 'unknown'}). Check remote access and credentials.`);
  }

  return {
    branch,
    upstream: status.upstream,
    output: pushed.stdout.slice(0, 4000),
  };
}
