import { test, expect, type Page } from './fixtures';
import jwt from 'jsonwebtoken';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test.describe.configure({ retries: 0 });
test.setTimeout(180_000);

const BASE = 'http://localhost:3000';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PREFIX = 'e2e-tacc-';
const PASSWORD = 'E2eTermAccess123!#';

type Actor = { id: string; username: string; role: 'admin' | 'editor' | 'viewer'; tv: number };

function readEnvValue(key: string): string | null {
  const envFile = path.join(ROOT, '.env');
  if (!fs.existsSync(envFile)) return null;
  const line = fs.readFileSync(envFile, 'utf8').split(/\r?\n/).find((entry) => entry.trim().startsWith(`${key}=`));
  return line ? line.slice(line.indexOf('=') + 1).trim() : null;
}

function container(): string {
  return process.env.WSD_TEST_CONTAINER || 'wsd-pro';
}

function secret(): string {
  return readEnvValue('JWT_SECRET') ||
    execFileSync('docker', ['exec', container(), 'cat', '/app/data/jwt.secret'], { encoding: 'utf8', timeout: 15000 }).trim();
}

function signToken(actor: Actor): string {
  return jwt.sign(
    { id: actor.id, username: actor.username, role: actor.role, tv: actor.tv, jti: `tacc-${Date.now()}-${Math.random()}` },
    secret(),
    { expiresIn: '10m' },
  );
}

function adminActor(): Actor {
  const users = JSON.parse(execFileSync('docker', ['exec', container(), 'cat', '/app/data/users.json'], { encoding: 'utf8' }));
  const user = users.users?.find((entry: { role?: string; id?: string }) => entry.role === 'admin' && entry.id);
  if (!user?.id) throw new Error('No existing admin user is available in the running container');
  return { id: user.id, username: user.username, role: 'admin', tv: user.tokenVersion || 0 };
}

const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

async function apiFetch(pathname: string, token: string, init: RequestInit = {}) {
  return fetch(`${BASE}${pathname}`, { ...init, headers: { ...authHeaders(token), ...(init.headers || {}) } });
}

async function withBackoff(pathname: string, token: string, init: RequestInit, expected: number): Promise<any> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const res = await apiFetch(pathname, token, init);
    if (res.status === expected) return res.json();
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after') || '1');
      await new Promise((r) => setTimeout(r, (Number.isFinite(ra) ? ra : 1) * 1000 + 250));
      continue;
    }
    const body = await res.text().catch(() => '');
    throw new Error(`${init.method || 'GET'} ${pathname}: ${res.status} -> ${body.slice(0, 300)}`);
  }
  throw new Error(`${init.method || 'GET'} ${pathname}: persistent 429`);
}

async function purgeResidue(token: string) {
  const res = await apiFetch('/api/projects', token).catch(() => null);
  if (!res?.ok) return;
  const data = await res.json().catch(() => ({}));
  for (const project of data.projects || data || []) {
    if (typeof project.slug === 'string' && project.slug.startsWith(PREFIX)) {
      await apiFetch(`/api/projects/${project.slug}`, token, { method: 'DELETE' }).catch(() => {});
    }
  }
}

let slug: string;
let admin: Actor;
let actingAdmin: Actor;
let viewer: Actor;
let editor: Actor;
let systemEditor: Actor;
const userIds: string[] = [];
let projectCreated = false;

async function createUser(token: string, role: Actor['role'], member: boolean): Promise<Actor> {
  const username = `e2e_tacc_${role}_${Math.random().toString(36).slice(2, 7)}`;
  const created = await withBackoff('/api/users', token, {
    method: 'POST',
    body: JSON.stringify({ username, password: PASSWORD, role }),
  }, 201);
  const user: Actor = { id: created.id, username: created.username, role, tv: 0 };
  userIds.push(user.id);
  if (member) {
    await withBackoff(`/api/projects/${slug}/members`, token, {
      method: 'POST',
      body: JSON.stringify({ userId: user.id, role }),
    }, 200);
  }
  return user;
}

test.beforeAll(async () => {
  admin = adminActor();
  const token = signToken(admin);
  await purgeResidue(token);
  slug = `${PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  await withBackoff('/api/projects', token, {
    method: 'POST',
    body: JSON.stringify({ name: 'Terminal Access E2E', slug }),
  }, 201);
  projectCreated = true;
  actingAdmin = await createUser(token, 'admin', false);
  viewer = await createUser(token, 'viewer', true);
  editor = await createUser(token, 'editor', true);
  systemEditor = await createUser(token, 'editor', false);
});

test.afterAll(async () => {
  test.setTimeout(180_000);
  const token = signToken(admin);
  if (projectCreated) await withBackoff(`/api/projects/${slug}`, token, { method: 'DELETE' }, 200).catch(() => {});
  for (const id of userIds) await withBackoff(`/api/users/${id}`, token, { method: 'DELETE' }, 200).catch(() => {});
});

async function openTerminals(page: Page, actor: Actor): Promise<string[]> {
  const sockets: string[] = [];
  page.on('websocket', (ws) => {
    if (ws.url().includes(`/ws/projects/${slug}/terminal`)) sockets.push(ws.url());
  });
  await page.addInitScript((token) => {
    localStorage.setItem('wsd.token', token);
    localStorage.setItem('wsd.lang', 'en');
  }, signToken(actor));
  await page.route('**/sw.js', (route) => route.fulfill({ status: 204, body: '' }));
  await page.route('**/api/ide/status', (route) =>
    route.fulfill({ status: 200, json: { ide: { running: false, port: 4097 } } }));
  await page.route('**/api/opencode/status', (route) =>
    route.fulfill({ status: 200, json: { running: false, port: 4097 } }));
  await page.route('**/api/embed/session', (route) =>
    route.request().method() === 'POST' && !route.request().url().includes('/clear')
      ? route.fulfill({ status: 200, json: { ok: true, port: 4097, expiresIn: 43200 } })
      : route.continue());
  await page.goto(`${BASE}/#/terminals/${slug}`);
  await expect(page.locator('.term-host')).toBeVisible({ timeout: 45_000 });
  return sockets;
}

function socketModes(sockets: string[]): string[] {
  return sockets.map((url) => new URL(url).searchParams.get('mode') || '<none>');
}

async function expectDenied(page: Page, mode: 'project' | 'control', title: string): Promise<void> {
  const panel = page.locator(`.term-access-panel[data-term-access-denied="${mode}"]`);
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(title);
  await expect(panel.locator('button')).toHaveCount(0);
  await expect(page.locator('.term-header-label')).toHaveText('read-only');
  await expect(page.locator('.term-host textarea.xterm-helper-textarea')).toHaveCount(0);
}

async function expectAllowed(page: Page): Promise<void> {
  await expect(page.locator('.term-access-panel')).toHaveCount(0);
  await expect(page.locator('.term-host textarea.xterm-helper-textarea')).toHaveCount(1, { timeout: 25_000 });
}

test('viewer member sees the denied project panel and opens no terminal socket', async ({ page }) => {
  const sockets = await openTerminals(page, viewer);
  await expectDenied(page, 'project', 'Editor access required');
  await expect(page.locator('.term-tab-add')).toHaveCount(0);
  await expect(page.locator('.term-mode-btn')).toHaveCount(2);
  await expect(page.locator('.term-mode-btn').first()).toBeEnabled();
  await expect(page.locator('.term-mode-btn').last()).toBeEnabled();
  await expect(page.locator('.term-mode-btn').first()).not.toHaveAttribute('aria-disabled');
  await expect(page.locator('.term-mode-btn').last()).not.toHaveAttribute('aria-disabled');
  await page.locator('.term-mode-btn', { hasText: 'Control' }).click();
  await expectDenied(page, 'control', 'Admin access required');
  await page.waitForTimeout(3500);
  expect(socketModes(sockets)).toEqual([]);
});

test('viewer with stored projectWrite gets a project shell but no control socket', async ({ page }) => {
  await withBackoff(`/api/users/${viewer.id}/permissions`, signToken(actingAdmin), {
    method: 'PATCH',
    body: JSON.stringify({ permissions: { projectWrite: true, projectTeam: false }, accountPassword: PASSWORD }),
  }, 200);
  const sockets = await openTerminals(page, viewer);
  await expectAllowed(page);
  expect(socketModes(sockets)).toContain('project');
  await page.locator('.term-mode-btn', { hasText: 'Control' }).click();
  await expectDenied(page, 'control', 'Admin access required');
  await page.waitForTimeout(3500);
  expect(socketModes(sockets)).not.toContain('control');
  expect(socketModes(sockets).filter((mode) => mode === 'project')).toHaveLength(1);
});

test('editor member gets a project shell but no control socket', async ({ page }) => {
  const sockets = await openTerminals(page, editor);
  await expectAllowed(page);
  expect(socketModes(sockets)).toContain('project');
  await page.locator('.term-mode-btn', { hasText: 'Control' }).click();
  await expectDenied(page, 'control', 'Admin access required');
  await page.waitForTimeout(3500);
  expect(socketModes(sockets)).not.toContain('control');
});

test('system editor gets a project shell but no control socket', async ({ page }) => {
  const sockets = await openTerminals(page, systemEditor);
  await expectAllowed(page);
  expect(socketModes(sockets)).toContain('project');
  await page.locator('.term-mode-btn', { hasText: 'Control' }).click();
  await expectDenied(page, 'control', 'Admin access required');
  await page.waitForTimeout(3500);
  expect(socketModes(sockets)).not.toContain('control');
});

test('admin owner opens both project and control shells without a denied panel', async ({ page }) => {
  const sockets = await openTerminals(page, admin);
  await expectAllowed(page);
  expect(socketModes(sockets)).toContain('project');
  await page.locator('.term-mode-btn', { hasText: 'Control' }).click();
  await expectAllowed(page);
  expect(socketModes(sockets)).toContain('control');
  await expect(page.locator('.term-access-panel')).toHaveCount(0);
});
