import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const MANAGER_PATH = path.join(ROOT, 'backend/src/services/docker-manager.ts');
const SECURITY_PATH = path.join(ROOT, 'SECURITY.md');
const BASE_COMPOSE_PATH = path.join(ROOT, 'docker-compose.yml');
const SOCKET_PROXY_OVERLAY_PATH = path.join(ROOT, 'docker-compose.socket-proxy.yml');
const SRC_ROOT = path.join(ROOT, 'backend/src');

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function extractBalanced(source: string, marker: string): string {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing ${marker}`);
  const open = source.indexOf('{', start);
  assert.notEqual(open, -1, `missing body for ${marker}`);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  assert.fail(`unbalanced body for ${marker}`);
}

function extractFunction(source: string, signature: string): string {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, `missing signature ${signature}`);
  const open = source.indexOf('{', start + signature.length);
  assert.notEqual(open, -1, `missing body for ${signature}`);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail(`unbalanced body for ${signature}`);
}

function requiredMatch(source: string, regex: RegExp): string {
  const match = regex.exec(source);
  assert.ok(match, `missing ${regex}`);
  return match[0];
}

function numericConst(source: string, name: string): number {
  const match = new RegExp(`const ${name} = (\\d+);`).exec(source);
  assert.ok(match, `missing ${name}`);
  return Number(match[1]);
}

function walkTs(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walkTs(full));
    else if (entry.name.endsWith('.ts')) files.push(full);
  }
  return files;
}

function toPosix(file: string): string {
  return path.relative(ROOT, file).replace(/\\/g, '/');
}

const managerRaw = fs.readFileSync(MANAGER_PATH, 'utf8');
const manager = stripComments(managerRaw);
const resolverFn = extractFunction(
  manager,
  requiredMatch(manager, /export function resolveProjectPidsLimit\(raw: unknown\): number/),
);
const hostConfigFn = extractFunction(
  manager,
  requiredMatch(manager, /export function buildProjectHostConfig\(opts: \{[\s\S]*?\n\}\)/),
);
const createOptions = extractBalanced(manager, 'await docker.createContainer(');

describe('project container hardening', () => {
  test('project containers are created through one hardened HostConfig builder', () => {
    assert.equal((manager.match(/docker\.createContainer\(/g) || []).length, 1);
    assert.match(createOptions, /HostConfig:\s*buildProjectHostConfig\(\{/);
    assert.doesNotMatch(createOptions, /HostConfig:\s*\{/);

    const createSites = walkTs(SRC_ROOT).filter((file) =>
      /docker\.createContainer\(/.test(stripComments(fs.readFileSync(file, 'utf8'))),
    );
    assert.deepEqual(createSites.map(toPosix), ['backend/src/services/docker-manager.ts']);
  });

  test('HostConfig blocks privilege escalation and the Docker socket, keeps CPU/RAM', () => {
    assert.match(hostConfigFn, /Privileged:\s*false/);
    assert.match(hostConfigFn, /SecurityOpt:\s*\['no-new-privileges:true'\]/);
    assert.match(hostConfigFn, /PidsLimit:\s*resolveProjectPidsLimit\(process\.env\.WSD_PROJECT_PIDS_LIMIT\)/);
    assert.match(hostConfigFn, /Binds:\s*\[`\$\{opts\.bindSource\}:\/workspace`\]/);
    assert.match(hostConfigFn, /Memory:\s*parseMemory\(opts\.limits\.memory\)!\.bytes/);
    assert.match(hostConfigFn, /NanoCpus:\s*parseCpu\(opts\.limits\.cpu\)!\.nano/);
    assert.match(hostConfigFn, /MemorySwap:\s*parseMemory\(opts\.limits\.memory\)!\.bytes/);
    assert.match(hostConfigFn, /RestartPolicy:\s*\{\s*Name:\s*'unless-stopped'\s*\}/);

    assert.doesNotMatch(hostConfigFn, /Privileged:\s*true/);
    assert.doesNotMatch(hostConfigFn, /docker\.sock/i);
    assert.doesNotMatch(createOptions, /docker\.sock/i);
    assert.doesNotMatch(hostConfigFn, /CapAdd|CapDrop/);
    assert.doesNotMatch(createOptions, /CapAdd|CapDrop/);
  });

  test('WSD_PROJECT_PIDS_LIMIT defaults safely and accepts only a sane range', () => {
    assert.equal(numericConst(manager, 'PROJECT_PIDS_LIMIT_DEFAULT'), 512);
    assert.equal(numericConst(manager, 'PROJECT_PIDS_LIMIT_MIN'), 64);
    assert.equal(numericConst(manager, 'PROJECT_PIDS_LIMIT_MAX'), 4096);

    const warnings: unknown[][] = [];
    const js = resolverFn
      .replace(/^export\s+/, '')
      .replace('resolveProjectPidsLimit(raw: unknown): number', 'resolveProjectPidsLimit(raw)');
    const resolve = new Function(
      'PROJECT_PIDS_LIMIT_DEFAULT',
      'PROJECT_PIDS_LIMIT_MIN',
      'PROJECT_PIDS_LIMIT_MAX',
      'console',
      `${js}\nreturn resolveProjectPidsLimit;`,
    )(
      512,
      64,
      4096,
      { warn: (...args: unknown[]) => warnings.push(args) },
    ) as (raw: unknown) => number;

    assert.equal(resolve(undefined), 512);
    assert.equal(resolve(null), 512);
    assert.equal(resolve(''), 512);
    assert.equal(resolve('  512  '), 512);
    assert.equal(resolve(64), 64);
    assert.equal(resolve('4096'), 4096);
    assert.equal(resolve('junk'), 512);
    assert.equal(resolve('63'), 512);
    assert.equal(resolve('4097'), 512);
    assert.equal(resolve(-1), 512);
    assert.equal(warnings.length, 4);
  });

  test('create, recreate, duplicate, restore and import all converge on createProject', () => {
    const consumers = [
      { file: 'backend/src/index.ts', min: 1 },
      { file: 'backend/src/services/docker-manager.ts', min: 2 },
      { file: 'backend/src/services/project-snapshots.ts', min: 1 },
      { file: 'backend/src/services/archive-manager.ts', min: 1 },
    ];
    for (const consumer of consumers) {
      const source = stripComments(fs.readFileSync(path.join(ROOT, consumer.file), 'utf8'));
      const calls = (source.match(/await createProject\(\{/g) || []).length;
      assert.ok(calls >= consumer.min, `${consumer.file}: expected >= ${consumer.min} createProject calls, saw ${calls}`);
    }
  });

  test('SECURITY.md documents the socket proxy as opt-in while base compose leaves it off', () => {
    const doc = fs.readFileSync(SECURITY_PATH, 'utf8');
    assert.match(doc, /Supported versions/i);
    assert.match(doc, /Reporting vulnerabilities/i);
    assert.match(doc, /Threat model/i);
    assert.match(doc, /docker\.sock/i);
    assert.match(doc, /single-instance/i);
    assert.match(doc, /TLS/i);
    assert.match(doc, /socket proxy/i);

    const proxyDoc = requiredMatch(doc, /### Optional socket proxy[\s\S]*$/);
    assert.match(proxyDoc, /opt-in Docker socket proxy is available/i);
    assert.match(proxyDoc, /docker-compose\.socket-proxy\.yml/);
    assert.match(proxyDoc, /DOCKER_HOST=tcp:\/\/docker-proxy:2375/);
    assert.match(proxyDoc, /EXEC=1/i);
    assert.doesNotMatch(proxyDoc, /\b(?:on|enabled|shipped|implemented)\s+by default\b/i);
    assert.doesNotMatch(proxyDoc, /\bdefault(?:ly)?\s+(?:on|enabled|shipped|implemented)\b/i);

    assert.ok(fs.existsSync(SOCKET_PROXY_OVERLAY_PATH), 'missing docker-compose.socket-proxy.yml');
    const overlay = fs.readFileSync(SOCKET_PROXY_OVERLAY_PATH, 'utf8');
    assert.match(overlay, /^\s*docker-proxy:\s*$/m);
    assert.match(overlay, /image:\s*tecnativa\/docker-socket-proxy:/);
    assert.match(overlay, /DOCKER_HOST:\s*tcp:\/\/docker-proxy:2375/);
    assert.match(overlay, /EXEC:\s*["']?1["']?/);

    const baseCompose = fs.readFileSync(BASE_COMPOSE_PATH, 'utf8');
    assert.doesNotMatch(baseCompose, /DOCKER_HOST\s*[:=]\s*tcp:\/\/docker-proxy:2375/i);
    assert.doesNotMatch(baseCompose, /\b(?:docker-proxy|socket[-_]proxy)\b/i);
  });
});
