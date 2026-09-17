import fs from 'fs';
import path from 'path';
import { execSync, type ExecSyncOptions } from 'child_process';

/** Same convention as project-context/canvas/reviews: resolve locally. */
const WORKSPACES_ROOT = process.env.WSD_PROJECTS_DIR || '/workspaces';

const MAX_OUTPUT = 50000;
const EXEC_TIMEOUT = 30000;
const MAX_FILE_READ = 200000;
const MAX_FILE_WRITE = 500000;
const MAX_CMD_LENGTH = 1000;
const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.nuxt',
  '.cache', '__pycache__', '.venv', 'venv', 'target', 'coverage',
]);

// Allowlist of permitted shell command prefixes (case-insensitive).
// Anything not starting with one of these is rejected.
const SAFE_CMD_PREFIXES = new Set([
  'git', 'npm', 'npx', 'yarn', 'pnpm', 'bun',
  'node', 'python', 'python3', 'pip', 'pip3',
  'ls', 'cat', 'head', 'tail', 'grep', 'find', 'rg', 'fd',
  'wc', 'sort', 'uniq', 'diff', 'file', 'stat',
  'mkdir', 'touch', 'cp', 'mv', 'ln', 'echo', 'printf',
  'pwd', 'which', 'whoami', 'env', 'date',
  'tar', 'zip', 'unzip', 'gzip', 'gunzip',
  'curl', 'wget',
  'docker', 'docker-compose', 'podman',
  'make', 'cmake',
  'sh', 'bash', 'zsh',
  'go', 'cargo', 'rustc', 'gcc', 'g++',
  'java', 'javac',
  'sed', 'awk', 'tr', 'cut', 'xargs',
  'tree',
]);

// Commands that are always blocked regardless of prefix check.
const BLOCKED_CMD_PREFIXES = new Set([
  'rm', 'dd', 'mkfs', 'format', 'chmod', 'chown',
  'shutdown', 'reboot', 'halt', 'poweroff',
  'sudo', 'su', 'passwd', 'kill', 'killall', 'pkill',
  'nc', 'ncat', 'netcat', 'nohup',
  'systemctl', 'service', 'journalctl',
  'iptables', 'ufw', 'firewall-cmd',
]);

function safeSlug(slug: string): string {
  return String(slug).replace(/[^a-z0-9._-]+/gi, '').slice(0, 32);
}

function safePath(slug: string, rel: string): string | null {
  const clean = safeSlug(slug);
  const base = path.resolve(WORKSPACES_ROOT, clean);
  if (!fs.existsSync(base)) return null;

  const relClean = String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!relClean || relClean === '.') return base;

  const normalized = path.posix.normalize(relClean);
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) return null;

  const target = path.resolve(base, normalized);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

export function readFile(slug: string, rel: string): string {
  const target = safePath(slug, rel);
  if (!target || !fs.existsSync(target)) return `[File not found: ${rel}]`;
  const buf = fs.readFileSync(target);
  if (buf.length > 0 && buf.subarray(0, 8192).includes(0)) return `[Binary file: ${rel}]`;
  let text = buf.toString('utf8');
  if (text.length > MAX_FILE_READ) text = text.slice(0, MAX_FILE_READ) + '\n…(truncated)';
  return text;
}

export function writeFile(slug: string, rel: string, content: string): string {
  const target = safePath(slug, rel);
  if (!target) return 'Invalid path';
  if (content.length > MAX_FILE_WRITE) return `[Blocked] Content too large (${content.length} bytes, max ${MAX_FILE_WRITE})`;
  const dir = path.dirname(target);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
  return `Wrote ${content.length} bytes to ${rel}`;
}

export function listFiles(slug: string, rel: string): string {
  const target = safePath(slug, rel);
  if (!target || !fs.existsSync(target)) return `[Directory not found: ${rel}]`;
  let stat: fs.Stats;
  try { stat = fs.statSync(target); } catch { return `[Cannot read: ${rel}]`; }
  if (!stat.isDirectory()) return `[Not a directory: ${rel}]`;

  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(target, { withFileTypes: true }); } catch { return `[Cannot list: ${rel}]`; }

  const lines: string[] = [];
  entries
    .filter((e) => !IGNORED_DIRS.has(e.name))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .slice(0, 200)
    .forEach((e) => {
      lines.push(e.isDirectory() ? `${e.name}/` : e.name);
    });
  return lines.join('\n') || '(empty)';
}

export function isDangerousCommand(cmd: string): string | null {
  if (cmd.length > MAX_CMD_LENGTH) return 'Command too long (max 1000 characters)';

  // Block shell chain operators that could hide malicious commands.
  // Allows only simple single-command execution.
  if (/(\|\||&&|;|\|`|`|\$\(|\$\{)/.test(cmd)) {
    return 'Shell chain operators (&&, ||, ;, |, backticks, $()) are not allowed';
  }

  // Block redirection to system directories.
  if (/[>]\s*\/(etc|var|usr|root|boot|sys|proc)\//i.test(cmd)) {
    return 'Write redirect to system directory is not allowed';
  }

  // Fork bomb pattern.
  if (/:\(\)\s*\{/.test(cmd)) return 'Fork bomb pattern blocked';

  // Pipe to shell.
  if (/\|\s*(ba)?sh/i.test(cmd)) return 'Piping to shell is not allowed';

  // Extract the first token (command name) after stripping leading whitespace.
  const trimmed = cmd.trim();
  const match = trimmed.match(/^(\S+)/);
  if (!match) return 'Empty command';
  const cmdName = match[1].split('/').pop()!; // handle /usr/bin/git → git

  // Block explicitly dangerous commands.
  if (BLOCKED_CMD_PREFIXES.has(cmdName.toLowerCase())) {
    return `Blocked command: ${cmdName}`;
  }

  // Allowlist check: command must start with a known-safe prefix.
  if (!SAFE_CMD_PREFIXES.has(cmdName.toLowerCase())) {
    return `Unknown command '${cmdName}' — not in the allowed list`;
  }

  return null;
}

/**
 * `execCommand` tool: runs INSIDE the project's container via docker exec.
 *
 * Historically this ran on the backend host (child_process.execSync in
 * /workspaces/<slug>) — any valid token could execute host commands and the
 * sync call blocked the event loop. Commands now execute under the project
 * container's own filesystem / PID / network isolation.
 *
 * Set WSD_AGENT_LOCAL_FALLBACK=1 ONLY to restore legacy host-side execution
 * for deployments without per-project containers — it is inherently unsafe.
 */
export async function execCommand(slug: string, cmd: string): Promise<string> {
  const clean = safeSlug(slug);
  const danger = isDangerousCommand(cmd);
  if (danger) return `[Blocked] ${danger}`;

  if (process.env.WSD_AGENT_LOCAL_FALLBACK === '1') {
    const cwd = path.resolve(WORKSPACES_ROOT, clean);
    if (!fs.existsSync(cwd)) return `Workspace not found: ${slug}`;
    const opts: ExecSyncOptions = {
      cwd,
      timeout: EXEC_TIMEOUT,
      maxBuffer: MAX_OUTPUT,
      encoding: 'utf8',
      shell: '/bin/bash',
    };
    try {
      const stdout = execSync(cmd, opts);
      const str = stdout ? stdout.toString('utf8') : '';
      const trimmed = str.length > MAX_OUTPUT ? str.slice(0, MAX_OUTPUT) + '\n…(truncated)' : str;
      return trimmed || '(no output)';
    } catch (err: any) {
      const stderr = err.stderr || '';
      const stdout = err.stdout || '';
      const msg = err.message || String(err);
      return [stdout, stderr, msg].filter(Boolean).join('\n').slice(0, MAX_OUTPUT);
    }
  }

  try {
    const { execInProjectContainer } = await import('./docker-manager.js');
    const res = await execInProjectContainer(clean, cmd, { timeoutMs: EXEC_TIMEOUT, maxOutput: MAX_OUTPUT });
    return res.output || '(no output)';
  } catch (err: any) {
    return `[Command failed] ${err?.message || String(err)}`;
  }
}

export function getProjectTree(slug: string, maxDepth = 3): string {
  const clean = safeSlug(slug);
  const base = path.resolve(WORKSPACES_ROOT, clean);
  if (!fs.existsSync(base)) return '(workspace not found)';

  const lines: string[] = [];
  const stack: { rel: string; depth: number }[] = [{ rel: '', depth: 0 }];

  while (stack.length > 0 && lines.length < 300) {
    const { rel, depth } = stack.pop()!;
    const dir = rel ? path.join(base, rel) : base;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }

    entries
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      .forEach((e) => {
        if (lines.length >= 300) return;
        if (e.isDirectory()) {
          if (IGNORED_DIRS.has(e.name)) return;
          if (depth < maxDepth) {
            const child = rel ? `${rel}/${e.name}` : e.name;
            lines.push(`${'  '.repeat(depth)}${e.name}/`);
            stack.push({ rel: child, depth: depth + 1 });
          }
        } else {
          lines.push(`${'  '.repeat(depth)}${e.name}`);
        }
      });
  }
  return lines.join('\n') || '(empty workspace)';
}
