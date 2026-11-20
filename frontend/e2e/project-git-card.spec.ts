import { test, expect } from './fixtures';
import jwt from 'jsonwebtoken';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test.describe.configure({ retries: 0 });

const BASE = 'http://localhost:3000';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SENSITIVE_PATH = '/app/data/jwt.secret';

function readEnvValue(key: string): string | null {
  const envFile = path.join(ROOT, '.env');
  if (!fs.existsSync(envFile)) return null;
  const line = fs.readFileSync(envFile, 'utf8').split(/\r?\n/).find((entry) => entry.trim().startsWith(`${key}=`));
  return line ? line.slice(line.indexOf('=') + 1).trim() : null;
}

type Actor = { id: string; username: string; role: string; tv: number };

function container() {
  return process.env.WSD_TEST_CONTAINER || 'wsd-pro';
}

function secret(): string {
  return readEnvValue('JWT_SECRET') ||
    execFileSync('docker', ['exec', container(), 'cat', '/app/data/jwt.secret'], { encoding: 'utf8', timeout: 15000 }).trim();
}

function signToken(user: Actor): string {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, tv: user.tv, jti: `pgit-${Date.now()}-${Math.random()}` },
    secret(),
    { expiresIn: '10m' },
  );
}

function adminActor(): Actor {
  const users = JSON.parse(execFileSync('docker', ['exec', container(), 'cat', '/app/data/users.json'], { encoding: 'utf8' }));
  const user = users.users?.find((entry: { id?: string }) => entry.id);
  if (!user?.id) throw new Error('No existing user is available in the running container');
  return { id: user.id, username: user.username, role: user.role, tv: user.tokenVersion || 0 };
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

async function createProject(token: string, tag: string) {
  const slug = `e2e-pg-${tag}-${Math.random().toString(36).slice(2, 8)}`;
  await withBackoff('/api/projects', token, {
    method: 'POST',
    body: JSON.stringify({ name: `Git Card ${tag}`, slug }),
  }, 201);
  return slug;
}

async function createMember(token: string, projectSlug: string, tag: string, role: 'editor' | 'viewer'): Promise<Actor> {
  const username = `e2e_pg_${tag}_${role}_${Math.random().toString(36).slice(2, 6)}`;
  const created = await withBackoff('/api/users', token, {
    method: 'POST',
    body: JSON.stringify({ username, password: 'E2eGitPass123!#', role }),
  }, 201);
  const id = created.id as string;
  await withBackoff(`/api/projects/${projectSlug}/members`, token, {
    method: 'POST',
    body: JSON.stringify({ userId: id, role }),
  }, 200);
  return { id, username, role, tv: 0 };
}

async function cleanup(token: string, slugs: string[], users: string[]) {
  for (const s of slugs) await apiFetch(`/api/projects/${s}`, token, { method: 'DELETE' }).catch(() => {});
  for (const id of users) await apiFetch(`/api/users/${id}`, token, { method: 'DELETE' }).catch(() => {});
}

async function purgeResidue(token: string) {
  try {
    const res = await apiFetch('/api/projects', token);
    if (res.ok) {
      const data = await res.json();
      for (const p of data.projects || data || []) {
        if (typeof p.slug === 'string' && p.slug.startsWith('e2e-pg-')) {
          await apiFetch(`/api/projects/${p.slug}`, token, { method: 'DELETE' }).catch(() => {});
        }
      }
    }
  } catch {
    /* best effort */
  }
}

let admin: Actor;
test.beforeAll(async () => {
  admin = adminActor();
  await purgeResidue(signToken(admin));
});

function seed(page: import('@playwright/test').Page, token: string) {
  return page.addInitScript((t) => {
    try { localStorage.setItem('wsd.token', t); } catch { /* ignore */ }
    try { localStorage.setItem('wsd.lang', 'en'); } catch { /* ignore */ }
  }, token);
}

test('Git card sits after Project info, loads git only on open, and shows empty state', async ({ page }) => {
  const token = signToken(admin);
  const slug = await createProject(token, 'order');
  let gitCalls = 0;
  const serverErrors: string[] = [];
  page.on('response', (r) => {
    if (r.url().includes(`/api/projects/${slug}/git`)) gitCalls++;
    if (r.status() >= 500) serverErrors.push(`${r.status()} ${r.url()}`);
  });
  await page.route(`**/api/projects/${slug}/git`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ repositories: [] }) }),
  );
  await seed(page, token);
  try {
    await page.goto(`/#/project/${slug}`);
    await expect(page.locator('#ov-links')).toBeVisible();
    expect(gitCalls, 'Git endpoint must not be called at ov-links').toBe(0);

    const labels = (await page.locator('.ov-nav .ov-nav-btn').allTextContents()).map((l) => l.trim());
    const infoIdx = labels.indexOf('Project info');
    const gitIdx = labels.indexOf('Git');
    expect(infoIdx, `nav: ${JSON.stringify(labels)}`).toBeGreaterThanOrEqual(0);
    expect(gitIdx, `nav: ${JSON.stringify(labels)}`).toBe(infoIdx + 1);

    await page.getByRole('button', { name: 'Git', exact: true }).click();
    await expect(page.locator('#ov-git')).toBeVisible();
    await expect(page.locator('#ov-git .git-empty')).toContainText('No Git repository found.', { timeout: 10000 });
    expect(gitCalls, 'Git endpoint called on open').toBeGreaterThanOrEqual(1);
    expect(serverErrors, `server errors: ${serverErrors.join('; ')}`).toEqual([]);
  } finally {
    await page.close();
    await cleanup(token, [slug], []);
  }
});

test('Git card is read-only for a viewer member and editable for an editor member', async ({ page }) => {
  const token = signToken(admin);
  const slug = await createProject(token, 'roles');
  const editor = await createMember(token, slug, 'ed', 'editor');
  const viewer = await createMember(token, slug, 'vw', 'viewer');
  const viewerToken = signToken(viewer);
  const editorToken = signToken(editor);
  const serverErrors: string[] = [];
  page.on('response', (r) => {
    if (r.status() >= 500) serverErrors.push(`${r.status()} ${r.url()}`);
  });
  try {
    await seed(page, viewerToken);
    await page.goto(`/#/project/${slug}`);
    await expect(page.locator('#ov-links')).toBeVisible();
    await page.getByRole('button', { name: 'Git', exact: true }).click();
    await expect(page.locator('#ov-git')).toBeVisible();
    await expect(page.locator('#ov-git .git-status-note')).toContainText('read-only', { timeout: 10000 });
    await expect(page.getByRole('textbox', { name: 'Clone from git' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Create branch' })).toHaveCount(0);

    await seed(page, editorToken);
    await page.reload();
    await expect(page.locator('#ov-links')).toBeVisible();
    await page.getByRole('button', { name: 'Git', exact: true }).click();
    await expect(page.locator('#ov-git')).toBeVisible();
    await expect(page.locator('#ov-git .git-status-note')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Clone from git' })).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole('button', { name: 'Create branch' })).toBeVisible();
    expect(serverErrors, `server errors: ${serverErrors.join('; ')}`).toEqual([]);
  } finally {
    await page.close();
    await cleanup(token, [slug], [editor.id, viewer.id]);
  }
});

test('Git card never leaks a sensitive server path from an error response', async ({ page }) => {
  const token = signToken(admin);
  const slug = await createProject(token, 'error');
  await page.route(`**/api/projects/${slug}/git`, (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: `ENOENT: cannot read ${SENSITIVE_PATH} and secret material` }),
    }),
  );
  await seed(page, token);
  try {
    await page.goto(`/#/project/${slug}`);
    await expect(page.locator('#ov-links')).toBeVisible();
    await page.getByRole('button', { name: 'Git', exact: true }).click();
    await expect(page.locator('#ov-git')).toBeVisible();
    await expect(page.locator('#ov-git .git-message[role="status"]').first()).toContainText('Could not load Git status.', { timeout: 10000 });
    const body = await page.locator('body').innerText();
    expect(body).not.toContain(SENSITIVE_PATH);
    expect(body).not.toContain('ENOENT');
  } finally {
    await page.close();
    await cleanup(token, [slug], []);
  }
});
