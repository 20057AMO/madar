import fs from 'fs';
import path from 'path';

import {
  opencodeConfigDir,
  probeOpencodeVersion,
  fetchLatestVersion,
  SUPPORTED_MAJORS,
} from './opencode-api';
import { isUpdateInProgress } from './component-updates';
// HttpError lives in docker-manager (historical); importing it here creates
// no cycle — this module is only consumed by index.ts.
import { HttpError } from './docker-manager';

/**
 * Opencode Studio backend: CRUD over the global opencode config directory
 * (~/.config/opencode) — subagents (*.md), skills (<name>/SKILL.md) and the
 * shared opencode.json — plus the version/update endpoints powering the
 * Studio Update button.
 *
 * All writes normalize CRLF and validate names; every path is resolved
 * inside the config dir (traversal-proof). Changes apply to NEW opencode
 * sessions automatically — no restart needed.
 */

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function agentsDir(): string {
  return path.join(opencodeConfigDir(), 'agents');
}

function skillsDir(): string {
  return path.join(opencodeConfigDir(), 'skills');
}

function commandsDir(): string {
  return path.join(opencodeConfigDir(), 'command');
}

function configFile(): string {
  return path.join(opencodeConfigDir(), 'opencode.json');
}

/** Resolve <base>/<name> rejecting anything that escapes base. */
function safeJoin(base: string, name: string): string {
  const resolved = path.resolve(base, name);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new HttpError(400, 'Invalid name');
  }
  return resolved;
}

function assertName(name: string): string {
  if (!NAME_RE.test(name)) {
    throw new HttpError(400, 'Name must be kebab-case ([a-z0-9-])');
  }
  return name;
}

function normalizeContent(content: string): string {
  return String(content ?? '').replace(/\r\n/g, '\n');
}

export interface StudioItem {
  name: string;
  description: string;
  mode?: string;
}

/** Pull `description` / `mode` / `agent` out of markdown frontmatter for listings. */
function frontmatterMeta(raw: string): { description: string; mode?: string; agent?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!m) return { description: '' };
  const meta: { description: string; mode?: string; agent?: string } = { description: '' };
  for (const line of m[1].split('\n')) {
    const kv = /^(\w+):\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    if (kv[1] === 'description') meta.description = kv[2].trim();
    if (kv[1] === 'mode' && ['primary', 'subagent', 'all'].includes(kv[2].trim())) {
      meta.mode = kv[2].trim();
    }
    if (kv[1] === 'agent' && NAME_RE.test(kv[2].trim())) {
      meta.agent = kv[2].trim();
    }
  }
  return meta;
}

// ── Agents ──────────────────────────────────────────────────────────────

export function listAgents(): StudioItem[] {
  try {
    return fs
      .readdirSync(agentsDir())
      .filter((f) => f.endsWith('.md'))
      .map((f) => {
        const raw = fs.readFileSync(path.join(agentsDir(), f), 'utf8');
        return { name: f.slice(0, -3), ...frontmatterMeta(raw) };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export function getAgent(name: string): { name: string; content: string } {
  assertName(name);
  const file = safeJoin(agentsDir(), `${name}.md`);
  if (!fs.existsSync(file)) throw new HttpError(404, `Agent '${name}' not found`);
  return { name, content: fs.readFileSync(file, 'utf8') };
}

export function saveAgent(name: string, content: string): void {
  assertName(name);
  fs.mkdirSync(agentsDir(), { recursive: true });
  fs.writeFileSync(
    safeJoin(agentsDir(), `${name}.md`),
    normalizeContent(content),
    'utf8',
  );
}

export function deleteAgent(name: string): void {
  getAgent(name); // 404 when missing
  fs.rmSync(safeJoin(agentsDir(), `${name}.md`));
}

// ── Skills ──────────────────────────────────────────────────────────────

export function listSkills(): StudioItem[] {
  try {
    return fs
      .readdirSync(skillsDir(), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const skillFile = path.join(skillsDir(), d.name, 'SKILL.md');
        if (!fs.existsSync(skillFile)) return null;
        const raw = fs.readFileSync(skillFile, 'utf8');
        return { name: d.name, ...frontmatterMeta(raw) };
      })
      .filter((x): x is StudioItem => x !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export function getSkill(name: string): { name: string; content: string } {
  assertName(name);
  const file = safeJoin(skillsDir(), path.join(name, 'SKILL.md'));
  if (!fs.existsSync(file)) throw new HttpError(404, `Skill '${name}' not found`);
  return { name, content: fs.readFileSync(file, 'utf8') };
}

export function saveSkill(name: string, content: string): void {
  assertName(name);
  fs.mkdirSync(safeJoin(skillsDir(), name), { recursive: true });
  fs.writeFileSync(
    safeJoin(skillsDir(), path.join(name, 'SKILL.md')),
    normalizeContent(content),
    'utf8',
  );
}

export function deleteSkill(name: string): void {
  getSkill(name); // 404 when missing
  fs.rmSync(safeJoin(skillsDir(), name), { recursive: true });
}

// ── Commands (slash commands, <name>.md) ────────────────────────────────

export function listCommands(): StudioItem[] {
  try {
    return fs
      .readdirSync(commandsDir())
      .filter((f) => f.endsWith('.md'))
      .map((f) => {
        const raw = fs.readFileSync(path.join(commandsDir(), f), 'utf8');
        return { name: f.slice(0, -3), ...frontmatterMeta(raw) };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export function getCommand(name: string): { name: string; content: string } {
  assertName(name);
  const file = safeJoin(commandsDir(), `${name}.md`);
  if (!fs.existsSync(file)) throw new HttpError(404, `Command '${name}' not found`);
  return { name, content: fs.readFileSync(file, 'utf8') };
}

export function saveCommand(name: string, content: string): void {
  assertName(name);
  // A command without frontmatter still works in opencode (body = template),
  // but require at least the --- markers so Studio listings stay meaningful.
  if (!/^---\r?\n[\s\S]*?\r?\n---/.test(normalizeContent(content))) {
    throw new HttpError(400, 'Command file must start with YAML frontmatter (---)');
  }
  fs.mkdirSync(commandsDir(), { recursive: true });
  fs.writeFileSync(
    safeJoin(commandsDir(), `${name}.md`),
    normalizeContent(content),
    'utf8',
  );
}

export function deleteCommand(name: string): void {
  getCommand(name); // 404 when missing
  fs.rmSync(safeJoin(commandsDir(), `${name}.md`));
}

// ── Shared config (opencode.json) ───────────────────────────────────────

const PROTECTED_KEYS = ['$schema'];

export function getConfig(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch {
    return {};
  }
}

export function updateConfig(patch: Record<string, unknown>): Record<string, unknown> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new HttpError(400, 'Config patch must be a JSON object');
  }
  for (const k of PROTECTED_KEYS) delete patch[k];
  const merged = { ...getConfig(), ...patch };
  // Never let a bad write brick opencode's config loader.
  JSON.parse(JSON.stringify(merged));
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return merged;
}

// ── Version & update ────────────────────────────────────────────────────

export interface StudioVersionInfo {
  current: string;
  latest: string | null;
  upToDate: boolean | null; // null = unknown (registry unreachable)
  channelUnlocked: boolean;
  supportedMajors: number[];
  updateRunning: boolean;
}

export async function getVersionInfo(): Promise<StudioVersionInfo> {
  const [cur, reg] = await Promise.all([probeOpencodeVersion(), fetchLatestVersion()]);
  const upToDate =
    cur.version === 'unknown' || !reg.latest ? null : cur.version === reg.latest;
  return {
    current: cur.version,
    latest: reg.latest,
    upToDate,
    channelUnlocked: reg.channelUnlocked,
    supportedMajors: [...SUPPORTED_MAJORS],
    updateRunning: isUpdateInProgress(),
  };
}
