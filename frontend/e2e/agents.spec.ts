/**
 * E2E tests for agent CRUD — edit + delete flow against the live container.
 *
 * API calls go through page.evaluate so they carry the browser's auth token.
 */
import { test, expect, type Page } from '@playwright/test';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const BASE = 'http://localhost:3000';

function parseDotEnv(filePath: string): Record<string, string> {
  const raw = fs.readFileSync(filePath, 'utf8');
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
  }
  return out;
}

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..', '..');
const env = parseDotEnv(path.join(repoRoot, '.env'));
const JWT_SECRET = env.JWT_SECRET;

if (!JWT_SECRET) {
  throw new Error(
    'JWT_SECRET not found in .env — the server no longer has a public default to share, ' +
    'so set a long random JWT_SECRET in .env (the server then uses that same value) before running e2e',
  );
}

function forgeToken(): string {
  return jwt.sign({ id: 'e2e-user', username: 'e2e', tv: 0 }, JWT_SECRET, { expiresIn: '24h' });
}

async function injectAuth(page: Page): Promise<void> {
  const token = forgeToken();
  await page.addInitScript(({ t }) => {
    localStorage.setItem('wsd.token', t);
  }, { t: token });
}

async function apiCall(page: Page, method: string, apiPath: string, body?: any): Promise<any> {
  return page.evaluate(async ({ method, apiPath, body, base }) => {
    const token = localStorage.getItem('wsd.token');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const opts: RequestInit = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${base}${apiPath}`, opts);
    const json = await res.json().catch(() => null);
    return { status: res.status, ok: res.ok, data: json };
  }, { method, apiPath, body, base: BASE });
}

// Permission select: the only select.modern-input that does NOT have chat-sel class
const PERM_SELECT = '.agent-settings-modal select.modern-input:not(.chat-sel)';

test.describe('Agent CRUD E2E', () => {

  test('create → edit permission → delete agent', async ({ page }) => {
    await injectAuth(page);
    await page.goto(`${BASE}/#/agents`);
    await page.waitForSelector('.agents-sidebar', { timeout: 10000 });

    // Cleanup any leftover E2E agents
    const list = await apiCall(page, 'GET', '/api/agents');
    for (const a of (list.data.agents || []).filter((a: any) => a.name.startsWith('E2E'))) {
      await apiCall(page, 'DELETE', `/api/agents/${a.id}`);
    }

    // 1. Create agent
    const createRes = await apiCall(page, 'POST', '/api/agents', {
      name: 'E2E Test Agent',
      icon: '🧪',
      description: 'Temporary agent for E2E testing',
      systemPrompt: 'You are a test agent.',
      toolsEnabled: true,
      permission: 'read',
    });
    expect(createRes.ok).toBeTruthy();
    const created = createRes.data.agent;
    expect(created.name).toBe('E2E Test Agent');
    expect(created.permission).toBe('read');

    // 2. Reload and select agent
    await page.reload();
    await page.waitForSelector('.agents-sidebar', { timeout: 10000 });

    const agentBtn = page.locator('.agent-nav-btn', { hasText: 'E2E Test Agent' }).first();
    await expect(agentBtn).toBeVisible({ timeout: 5000 });
    await agentBtn.click();
    await page.waitForTimeout(500);

    // 3. Open settings
    const settingsBtn = page.locator('.agents-topbar-right .btn-ghost').filter({ hasText: '⚙' });
    await settingsBtn.click();
    await page.waitForSelector('.agent-settings-modal', { timeout: 5000 });

    // 4. Verify permission = read
    const permSelect = page.locator(PERM_SELECT);
    await expect(permSelect).toBeVisible();
    await expect(permSelect).toHaveValue('read');

    // 5. Change to full
    await permSelect.selectOption('full');
    await page.waitForTimeout(200);

    // 6. Save
    await page.locator('.agent-settings-footer button.btn-primary').click();
    await page.waitForTimeout(1000);

    // 7. Verify via API
    const getRes = await apiCall(page, 'GET', '/api/agents');
    const found = getRes.data.agents.find((a: any) => a.id === created.id);
    expect(found.permission).toBe('full');

    // 8. Re-open settings and delete
    await settingsBtn.click();
    await page.waitForSelector('.agent-settings-modal', { timeout: 5000 });
    await page.locator('.agent-settings-footer button.btn-danger').click();
    await page.waitForSelector('.reauth-card', { timeout: 3000 });
    await page.locator('.reauth-card button.btn-danger').click();
    await page.waitForTimeout(1500);

    // 9. Verify deleted
    const getRes2 = await apiCall(page, 'GET', '/api/agents');
    expect(getRes2.data.agents.find((a: any) => a.id === created.id)).toBeUndefined();
  });

  test('permission dropdown is readable on dark theme', async ({ page }) => {
    await injectAuth(page);
    await page.goto(`${BASE}/#/agents`);
    await page.waitForSelector('.agents-sidebar', { timeout: 10000 });

    const createRes = await apiCall(page, 'POST', '/api/agents', {
      name: 'E2E Perm Test',
      icon: '🎨',
      description: 'Test permission UI',
      systemPrompt: 'Test.',
      toolsEnabled: true,
      permission: 'bash',
    });
    const created = createRes.data.agent;

    await page.reload();
    await page.waitForSelector('.agents-sidebar', { timeout: 10000 });

    const agentBtn = page.locator('.agent-nav-btn', { hasText: 'E2E Perm Test' }).first();
    await agentBtn.click();
    await page.waitForTimeout(500);

    const settingsBtn = page.locator('.agents-topbar-right .btn-ghost').filter({ hasText: '⚙' });
    await settingsBtn.click();
    await page.waitForSelector('.agent-settings-modal', { timeout: 5000 });

    const permSelect = page.locator(PERM_SELECT);
    await expect(permSelect).toBeVisible();
    await expect(permSelect).toHaveValue('bash');

    // Text must NOT be black on dark theme
    const color = await permSelect.evaluate((el) => getComputedStyle(el).color);
    expect(color).not.toBe('rgb(0, 0, 0)');

    await apiCall(page, 'DELETE', `/api/agents/${created.id}`);
  });

  test('toggle toolsEnabled off hides permission selector', async ({ page }) => {
    await injectAuth(page);
    await page.goto(`${BASE}/#/agents`);
    await page.waitForSelector('.agents-sidebar', { timeout: 10000 });

    const createRes = await apiCall(page, 'POST', '/api/agents', {
      name: 'E2E Toggle Test',
      icon: '🔄',
      description: 'Test toggle',
      systemPrompt: 'Test.',
      toolsEnabled: true,
      permission: 'full',
    });
    const created = createRes.data.agent;

    await page.reload();
    await page.waitForSelector('.agents-sidebar', { timeout: 10000 });

    const agentBtn = page.locator('.agent-nav-btn', { hasText: 'E2E Toggle Test' }).first();
    await agentBtn.click();
    await page.waitForTimeout(500);

    const settingsBtn = page.locator('.agents-topbar-right .btn-ghost').filter({ hasText: '⚙' });
    await settingsBtn.click();
    await page.waitForSelector('.agent-settings-modal', { timeout: 5000 });

    const toolsToggle = page.locator('.agent-settings-modal input[type="checkbox"]');
    await expect(toolsToggle).toBeChecked();

    const permSelect = page.locator(PERM_SELECT);
    await expect(permSelect).toBeVisible();
    await expect(permSelect).toHaveValue('full');

    // Toggle off → permission selector hides
    await toolsToggle.click();
    await page.waitForTimeout(300);
    await expect(permSelect).not.toBeVisible();

    // Save
    await page.locator('.agent-settings-footer button.btn-primary').click();
    await page.waitForTimeout(1000);

    // Verify via API
    const getRes = await apiCall(page, 'GET', '/api/agents');
    const found = getRes.data.agents.find((a: any) => a.id === created.id);
    expect(found.toolsEnabled).toBe(false);
    expect(found.permission).toBe('none');

    await apiCall(page, 'DELETE', `/api/agents/${created.id}`);
  });
});
