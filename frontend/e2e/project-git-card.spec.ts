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

function seed(page: import('@playwright/test').Page, token: string, lang = 'en') {
  return page.addInitScript(({ t, l }) => {
    try { localStorage.setItem('wsd.token', t); } catch { /* ignore */ }
    try { localStorage.setItem('wsd.lang', l); } catch { /* ignore */ }
  }, { t: token, l: lang });
}

function mockRepo(overrides: Record<string, unknown> = {}) {
  return {
    path: '/workspace',
    branch: 'main',
    branches: ['main'],
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    changes: [],
    diff: '',
    diffTruncated: false,
    ...overrides,
  };
}

async function cssVarRgb(page: import('@playwright/test').Page, name: string): Promise<string> {
  const raw = await page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);
  const compact = raw.replace('#', '');
  const hex = compact.length === 3 ? compact.split('').map((c) => c + c).join('') : compact;
  const value = parseInt(hex, 16);
  return `rgb(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255})`;
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
    await expect(page.getByRole('button', { name: 'Git', exact: true })).toHaveAttribute('aria-current', 'location');
    await expect(page.locator('#ov-git h3')).toContainText('Git changes');
    await expect(page.locator('#ov-git .git-message[role="status"][aria-live="polite"]')).toHaveCount(2);
    await expect(page.locator('#ov-git .git-empty')).toContainText('No Git repository found.', { timeout: 10000 });
    const cloneCta = page.getByRole('button', { name: 'Clone into this project', exact: true });
    await expect(cloneCta).toBeVisible();
    await cloneCta.click();
    await expect(page.getByRole('textbox', { name: 'Clone from git' })).toBeFocused();
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
  let repos: ReturnType<typeof mockRepo>[] = [];
  await page.route(`**/api/projects/${slug}/git`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ repositories: repos }) }),
  );
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
    await expect(page.getByRole('button', { name: 'Clone into this project', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Create branch' })).toHaveCount(0);

    await seed(page, editorToken);
    await page.reload();
    await expect(page.locator('#ov-links')).toBeVisible();
    await page.getByRole('button', { name: 'Git', exact: true }).click();
    await expect(page.locator('#ov-git')).toBeVisible();
    await expect(page.locator('#ov-git .git-status-note')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Clone into this project', exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Clone from git' })).toBeVisible({ timeout: 10000 });
    repos = [mockRepo({ ahead: 1 })];
    await page.reload();
    await expect(page.locator('#ov-links')).toBeVisible();
    await page.getByRole('button', { name: 'Git', exact: true }).click();
    await expect(page.locator('#ov-git')).toBeVisible();
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
    const message = page.locator('#ov-git .git-message[role="status"]').first();
    await expect(message).toContainText('Could not load Git status.', { timeout: 10000 });
    await expect(message).toHaveClass(/git-message err/);
    expect(await message.evaluate((el) => getComputedStyle(el).color)).toBe(await cssVarRgb(page, '--red'));
    const body = await page.locator('body').innerText();
    expect(body).not.toContain(SENSITIVE_PATH);
    expect(body).not.toContain('ENOENT');
  } finally {
    await page.close();
    await cleanup(token, [slug], []);
  }
});

test('Git card shows feedback tone, one prioritized reason note, and select-all', async ({ page }) => {
  const token = signToken(admin);
  const slug = await createProject(token, 'ux');
  const changes = [
    { path: 'src/app.ts', status: 'M', staged: false, unstaged: true },
    { path: 'README.md', status: '??', staged: false, unstaged: true },
  ];
  let repos = [mockRepo({ ahead: 2, changes, diff: 'diff --git a/src/app.ts b/src/app.ts\n+change\n' })];
  await page.route(`**/api/projects/${slug}/git`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ repositories: repos }) }),
  );
  await page.route(`**/api/projects/${slug}/git/stage`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ paths: changes.map((c) => c.path) }) }),
  );
  await seed(page, token);
  try {
    await page.goto(`/#/project/${slug}`);
    await expect(page.locator('#ov-links')).toBeVisible();
    await page.getByRole('button', { name: 'Git', exact: true }).click();
    await expect(page.locator('#ov-git')).toBeVisible();

    const reason = page.locator('#ov-git .git-status-note[title]');
    await expect(reason).toHaveCount(1);
    await expect(reason).toHaveText('Uncommitted edits are not included in a push.');
    await expect(reason).toHaveAttribute('title', 'Uncommitted edits are not included in a push.');
    await expect(page.locator('#ov-git .git-status-row ~ .git-message')).toHaveCount(1);
    await expect(page.locator('#ov-git ul[role="list"]')).toHaveCount(1);

    const selectAll = page.getByRole('checkbox', { name: 'Select all changed files' });
    await expect(selectAll).toBeVisible();
    await selectAll.check();
    await expect(page.getByRole('checkbox', { name: 'Select src/app.ts' })).toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'Select README.md' })).toBeChecked();
    await expect(selectAll).toBeChecked();
    await expect(page.locator('#ov-git .git-file-actions .git-status-note')).toContainText('2 selected');
    await selectAll.uncheck();
    await expect(page.getByRole('checkbox', { name: 'Select src/app.ts' })).not.toBeChecked();

    await selectAll.check();
    await page.getByRole('button', { name: 'Stage selected', exact: true }).click();
    const message = page.locator('#ov-git .git-message[role="status"]').first();
    await expect(message).toHaveClass(/git-message ok/);
    await expect(message).toContainText('Staged 2 files.');
    expect(await message.evaluate((el) => getComputedStyle(el).color)).toBe(await cssVarRgb(page, '--green'));

    const refresh = page.getByRole('button', { name: 'Refresh Git status' });
    repos = [mockRepo({ upstream: null, behind: 3, changes, ahead: 0 })];
    await refresh.click();
    await expect(reason).toHaveCount(1);
    await expect(reason).toHaveText('No upstream branch is configured.');
    await expect(reason).toHaveAttribute('title', 'No upstream branch is configured.');

    repos = [mockRepo({ upstream: 'origin/main', behind: 2, changes, ahead: 5 })];
    await refresh.click();
    await expect(reason).toHaveCount(1);
    await expect(reason).toHaveText('Pull the remote changes before pushing.');
    await expect(reason).toHaveAttribute('title', 'Pull the remote changes before pushing.');

    repos = [mockRepo({ upstream: 'origin/main', behind: 0, changes: [], ahead: 0 })];
    await refresh.click();
    await expect(reason).toHaveCount(1);
    await expect(reason).toHaveText('Everything is up to date — nothing to push.');
    await expect(reason).toHaveAttribute('title', 'Everything is up to date — nothing to push.');

    repos = [mockRepo({ upstream: 'origin/main', behind: 0, changes: [], ahead: 3 })];
    await refresh.click();
    await expect(reason).toHaveCount(0);
    await expect(page.locator('#ov-git .git-message[role="status"][aria-live="polite"]')).toHaveCount(2);
  } finally {
    await page.close();
    await cleanup(token, [slug], []);
  }
});

test('Git card Arabic labels keep the diff LTR and fit a 360px viewport', async ({ page }) => {
  const token = signToken(admin);
  const slug = await createProject(token, 'rtl');
  let repos = [mockRepo({
    ahead: 2,
    changes: [{ path: 'src/app.ts', status: 'M', staged: true, unstaged: false }],
    diff: 'diff --git a/src/app.ts b/src/app.ts\n+change\n',
  })];
  await page.route(`**/api/projects/${slug}/git`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ repositories: repos }) }),
  );
  await seed(page, token, 'ar');
  try {
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto(`/#/project/${slug}`);
    await expect(page.locator('#ov-links')).toBeVisible();
    await page.getByRole('button', { name: 'Git', exact: true }).click();
    const panel = page.locator('#ov-git');
    await expect(panel).toBeVisible();

    await expect(panel.getByRole('heading', { name: 'تغييرات Git' })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'تحديث حالة Git' })).toBeVisible();
    await expect(panel.getByRole('checkbox', { name: 'تحديد جميع الملفات المتغيرة' })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'سحب' })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'دفع' })).toBeVisible();
    await expect(panel.getByRole('textbox', { name: 'استنساخ من git' })).toBeVisible();
    const reason = panel.locator('.git-status-note[title]');
    await expect(reason).toHaveText('التعديلات غير المحفوظة في commit لا تُضمّن عند الدفع.');
    await expect(reason).toHaveAttribute('title', 'التعديلات غير المحفوظة في commit لا تُضمّن عند الدفع.');

    await panel.locator('.git-diff summary').click();
    const pre = panel.locator('.git-diff pre');
    await expect(pre).toBeVisible();
    expect(await pre.evaluate((el) => getComputedStyle(el).direction)).toBe('ltr');
    expect(await pre.evaluate((el) => getComputedStyle(el).textAlign)).toBe('left');

    const dims = await page.evaluate(() => {
      const el = document.querySelector('#ov-git');
      return {
        scroll: document.documentElement.scrollWidth,
        inner: window.innerWidth,
        panelScroll: el?.scrollWidth ?? 0,
        panelClient: el?.clientWidth ?? 0,
      };
    });
    expect(dims.scroll, `document overflow: ${JSON.stringify(dims)}`).toBeLessThanOrEqual(dims.inner + 1);
    expect(dims.panelScroll, `panel overflow: ${JSON.stringify(dims)}`).toBeLessThanOrEqual(dims.panelClient + 1);

    repos = [];
    await panel.getByRole('button', { name: 'تحديث حالة Git' }).click();
    await expect(panel.locator('.git-empty')).toContainText('لم يُعثر على مستودع Git');
    const cta = panel.getByRole('button', { name: 'استنساخ إلى هذا المشروع', exact: true });
    await expect(cta).toBeVisible();
    await cta.click();
    await expect(panel.getByRole('textbox', { name: 'استنساخ من git' })).toBeFocused();
  } finally {
    await page.close();
    await cleanup(token, [slug], []);
  }
});

test.describe('Git card accessibility (partial state + coarse pointer)', () => {
  test('select-all exposes indeterminate state, descriptions, and 375px touch targets', async ({ browser }) => {
    const token = signToken(admin);
    const slug = await createProject(token, 'a11y');
    const changes = [
      { path: 'src/app.ts', status: 'M', staged: false, unstaged: true },
      { path: 'README.md', status: '??', staged: false, unstaged: true },
    ];
    const repos = [mockRepo({ ahead: 2, behind: 1, changes })];
    const context = await browser.newContext({
      viewport: { width: 375, height: 812 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await context.newPage();
    await page.route(`**/api/projects/${slug}/git`, (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ repositories: repos }) }),
    );
    await seed(page, token);
    try {
      await page.goto(`/#/project/${slug}`);
      await expect(page.locator('#ov-links')).toBeVisible();
      await page.getByRole('button', { name: 'Git', exact: true }).click();
      const panel = page.locator('#ov-git');
      await expect(panel).toBeVisible();
      expect(await page.evaluate(() => matchMedia('(hover: none) and (pointer: coarse)').matches)).toBe(true);

      const selectAll = panel.getByRole('checkbox', { name: 'Select all changed files' });
      await expect(selectAll).toBeVisible();
      const descId = await selectAll.getAttribute('aria-describedby');
      expect(descId).toBe('git-selected-count');
      await expect(panel.locator(`#${descId}`)).toHaveCount(1);

      await panel.getByRole('checkbox', { name: 'Select src/app.ts' }).check();
      expect(await selectAll.evaluate((el: HTMLInputElement) => el.indeterminate)).toBe(true);
      expect(await selectAll.getAttribute('aria-checked')).toBeNull();

      await selectAll.check();
      expect(await selectAll.evaluate((el: HTMLInputElement) => el.indeterminate)).toBe(false);
      await expect(panel.getByRole('checkbox', { name: 'Select README.md' })).toBeChecked();
      await expect(panel.locator('#git-selected-count')).toContainText('2 selected');

      await selectAll.uncheck();
      expect(await selectAll.evaluate((el: HTMLInputElement) => el.indeterminate)).toBe(false);
      await expect(panel.getByRole('checkbox', { name: 'Select src/app.ts' })).not.toBeChecked();

      const push = panel.getByRole('button', { name: 'Push', exact: true });
      const pull = panel.getByRole('button', { name: 'Pull', exact: true });
      await expect(push).toHaveAttribute('aria-describedby', 'git-push-block-reason');
      await expect(pull).toHaveAttribute('aria-describedby', 'git-push-block-reason');
      await expect(panel.locator('#git-push-block-reason')).toHaveCount(1);

      const bounds = await page.evaluate(() => {
        const label = document.querySelector('#ov-git .git-select-all') as HTMLElement;
        const input = label.querySelector('input') as HTMLInputElement;
        const lr = label.getBoundingClientRect();
        const ir = input.getBoundingClientRect();
        return { labelH: lr.height, inputW: ir.width, inputH: ir.height };
      });
      expect(bounds.labelH, JSON.stringify(bounds)).toBeGreaterThanOrEqual(44);
      expect(bounds.inputW, JSON.stringify(bounds)).toBeGreaterThanOrEqual(24);
      expect(bounds.inputH, JSON.stringify(bounds)).toBeGreaterThanOrEqual(24);
    } finally {
      await context.close();
      await cleanup(token, [slug], []);
    }
  });
});
