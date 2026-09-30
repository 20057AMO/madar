/**
 * E2E smoke tests for the Madar web UI — runs against the live container.
 *
 * Auth: We forge a JWT locally (same secret as the server) and inject it into
 * localStorage via addInitScript, so the app treats the browser as logged in.
 *
 * Tool entry policy:
 *  - VS Code opens IN-APP at /#/ide (embedded, keep-alive, watermark on top).
 *  - opencode: sidebar/dashboard open a raw tab on :4096; the embedded page
 *    at /#/opencode is ALSO keep-alive now (session persists between visits)
 *    and keeps its picker + "Open in new tab" anchor.
 */
import { test, expect, type Page } from '@playwright/test';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const BASE = 'http://localhost:3000';

/** Minimal .env parser (no dotenv dependency). */
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

/** Forge a session token that the server will accept. */
function forgeToken(): string {
  return jwt.sign(
    { id: 'e2e-user', username: 'e2e', tv: 0 },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
}

/** Inject auth token into localStorage before any page script runs. */
async function injectAuth(page: Page): Promise<void> {
  const token = forgeToken();
  await page.addInitScript(({ t }) => {
    localStorage.setItem('wsd.token', t);
  }, { t: token });
}

/** Click a locator and capture the popup it opens, returning its URL. */
async function popupUrl(page: Page, click: () => Promise<void>): Promise<string> {
  const popupPromise = page.waitForEvent('popup');
  await click();
  const popup = await popupPromise;
  await popup.waitForLoadState('domcontentloaded');
  return popup.url();
}

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

test.describe('Madar UI — raw-tool entry points', () => {

  /* -- a. Sidebar: VS Code navigates in-app; opencode pops up -------- */
  test('a) sidebar VS Code goes in-app to #/ide; opencode pops up :4096', async ({ page }) => {
    await injectAuth(page);
    await page.goto(BASE);
    await expect(page.locator('.sidebar-nav').locator('.nav-btn').first()).toBeVisible({ timeout: 20_000 });

    await page.locator('.nav-btn', { hasText: 'VS Code' }).click();
    await expect(page).toHaveURL(/#\/ide/);
    await expect(page.locator('iframe.opencode-frame')).toBeVisible({ timeout: 20_000 });

    // The fullscreen IDE layer covers the sidebar — go back to the
    // dashboard first so the opencode button is clickable again.
    await page.evaluate(() => { window.location.hash = '/'; });
    await expect(page.locator('.nav-btn', { hasText: 'opencode' })).toBeVisible({ timeout: 15_000 });

    const ocUrl = await popupUrl(page, () =>
      page.locator('.nav-btn', { hasText: 'opencode' }).first().click()
    );
    expect(ocUrl).toMatch(/:4096/);
  });

  /* -- b. Dashboard: VS Code card in-app; OpenCode card popup -------- */
  test('b) Dashboard VS Code card goes in-app; OpenCode card pops up :4096', async ({ page }) => {
    await injectAuth(page);
    await page.goto(BASE);
    await expect(page.locator('.dash-action-card').first()).toBeVisible({ timeout: 20_000 });

    await page.locator('.dash-action-card', { hasText: 'VS Code' }).click();
    await expect(page).toHaveURL(/#\/ide/);
    await expect(page.locator('iframe.opencode-frame')).toBeVisible({ timeout: 20_000 });

    await page.evaluate(() => { window.location.hash = '/'; });
    await expect(page.locator('.dash-action-card').first()).toBeVisible({ timeout: 15_000 });

    const ocUrl = await popupUrl(page, () =>
      page.locator('.dash-action-card', { hasText: 'OpenCode' }).click()
    );
    expect(ocUrl).toMatch(/:4096/);
  });

  /* -- c. /#/ide embedded page keeps its toolbar features ------------ */
  test('c) /#/ide — "Open in new tab" anchor to :8100, picker, iframe', async ({ page }) => {
    await injectAuth(page);
    await page.goto(BASE);
    await page.evaluate(() => { window.location.hash = '/ide'; });

    const iframe = page.locator('iframe.opencode-frame');
    await expect(iframe).toBeVisible({ timeout: 20_000 });

    // Project picker is present
    await expect(page.locator('.opencode-toolbar select')).toBeVisible();

    // Anchor points at the RAW code-server URL
    const anchor = page.locator('.opencode-toolbar a', { hasText: 'Open in new tab' });
    await expect(anchor).toBeVisible();
    expect(await anchor.getAttribute('href')).toMatch(/:8100\/\?folder=/);
  });

  /* -- d. /#/opencode embedded page keeps picker + anchor ------------ */
  test('d) /#/opencode — anchor to :4096, picker restored, status, iframe', async ({ page }) => {
    await injectAuth(page);
    await page.goto(BASE);
    await page.evaluate(() => { window.location.hash = '/opencode'; });

    const iframe = page.locator('iframe.opencode-frame');
    await expect(iframe).toBeVisible({ timeout: 20_000 });

    // Project picker is back
    await expect(page.locator('.opencode-toolbar select')).toBeVisible();

    // Status line
    const statusLine = page.locator('.opencode-toolbar .term-title');
    await expect(statusLine).toBeVisible();
    expect(await statusLine.textContent()).toMatch(/opencode:\s*(running|offline|…)/);

    // Anchor points at the RAW opencode URL
    const anchor = page.locator('.opencode-toolbar a', { hasText: 'Open in new tab' });
    await expect(anchor).toBeVisible();
    expect(await anchor.getAttribute('href')).toMatch(/:4096/);

    // Keep-alive round-trip: leave and come back — the toolbar must reappear
    // instantly from the persisted layer (no remount crash, no blank state).
    await page.evaluate(() => { window.location.hash = '/'; });
    await expect(page.locator('.dash-action-card').first()).toBeVisible({ timeout: 15_000 });
    await page.evaluate(() => { window.location.hash = '/opencode'; });
    await expect(page.locator('.opencode-toolbar select')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('iframe.opencode-frame')).toBeVisible();
  });
});
