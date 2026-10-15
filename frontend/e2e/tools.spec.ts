/**
 * E2E smoke tests for the Madar web UI — runs against the live container.
 *
 * Auth: We forge a JWT locally (same secret as the server) for a REAL user
 * resolved from the running container's data/users.json and inject it into
 * localStorage via addInitScript, so the app treats the browser as logged in.
 * A fabricated user id is refused server-side (verifyToken returns null for
 * unknown ids → the app bounces to /login). The UI language is pinned to
 * English so text assertions stay deterministic (first-visit default is
 * Arabic).
 *
 * Tool entry policy (current reality):
 *  - The raw surfaces (code-server / opencode web) bind loopback INSIDE the
 *    container; the only published route is the authenticated embed proxy
 *    on :4097.
 *  - VS Code opens IN-APP at /#/ide (embedded, keep-alive).
 *  - The sidebar opencode button pops up the PROXY root (:4097).
 *  - Dashboard quick-action tiles navigate IN-APP (/#/ide, /#/opencode).
 *  - Both embedded pages keep their project picker, honest status line and
 *    an "Open in new tab" anchor pointing at the proxy — never a raw
 *    upstream port.
 */
import { test, expect, type Page } from '@playwright/test';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

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

/** Resolve a session token for a REAL user that exists in the running container. */
let cachedToken: string | null = null;
function sessionToken(): string {
  if (cachedToken) return cachedToken;
  const container = process.env.WSD_TEST_CONTAINER || 'wsd-pro';
  const users = JSON.parse(
    execFileSync('docker', ['exec', container, 'cat', '/app/data/users.json'], { encoding: 'utf8' }),
  );
  const list: Array<{ id?: string; username?: string; role?: string; tokenVersion?: number }> = users.users || [];
  const user = list.find((entry) => entry.role === 'admin') || list.find((entry) => entry.id);
  if (!user?.id) {
    throw new Error('No existing user is available in the running container');
  }
  cachedToken = jwt.sign(
    { id: user.id, username: user.username, role: user.role, tv: user.tokenVersion || 0, jti: 'tools-e2e' },
    JWT_SECRET,
    { expiresIn: '24h' },
  );
  return cachedToken;
}

/** Inject auth token + English UI into localStorage before any page script runs. */
async function injectAuth(page: Page): Promise<void> {
  const token = sessionToken();
  await page.addInitScript((value) => {
    localStorage.setItem('wsd.token', value);
    localStorage.setItem('wsd.lang', 'en');
  }, token);
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

test.describe('Madar UI — tool entry points', () => {

  /* -- a. Sidebar: VS Code navigates in-app; opencode pops up the proxy -- */
  test('a) sidebar VS Code goes in-app to #/ide; opencode pops up the proxy :4097', async ({ page }) => {
    await injectAuth(page);
    await page.goto(BASE);
    await expect(page.locator('.sidebar-nav').locator('.nav-btn').first()).toBeVisible({ timeout: 20_000 });

    await page.locator('.nav-btn', { hasText: 'VS Code' }).click();
    await expect(page).toHaveURL(/#\/ide/);
    await expect(page.locator('iframe.opencode-frame[title="Madar VS Code"]')).toBeVisible({ timeout: 20_000 });

    // The fullscreen IDE layer covers the sidebar — go back to the
    // dashboard first so the opencode button is clickable again.
    await page.evaluate(() => { window.location.hash = '/'; });
    await expect(page.locator('.nav-btn', { hasText: 'opencode' })).toBeVisible({ timeout: 15_000 });

    const ocUrl = await popupUrl(page, () =>
      page.locator('.nav-btn', { hasText: 'opencode' }).first().click()
    );
    expect(ocUrl).toMatch(/^http:\/\/localhost:4097\/?/);
  });

  /* -- b. Dashboard tiles: both navigate IN-APP (no popups) -------------- */
  test('b) Dashboard tiles go in-app — VS Code to #/ide, Opencode to #/opencode', async ({ page }) => {
    await injectAuth(page);
    await page.goto(BASE);
    await expect(page.locator('.qa-tile').first()).toBeVisible({ timeout: 20_000 });

    await page.locator('.qa-tile', { hasText: 'VS Code' }).click();
    await expect(page).toHaveURL(/#\/ide/);
    await expect(page.locator('iframe.opencode-frame[title="Madar VS Code"]')).toBeVisible({ timeout: 20_000 });

    await page.evaluate(() => { window.location.hash = '/'; });
    await expect(page.locator('.qa-tile').first()).toBeVisible({ timeout: 15_000 });

    await page.locator('.qa-tile', { hasText: 'Opencode' }).click();
    await expect(page).toHaveURL(/#\/opencode/);
    await expect(page.locator('#oc-project-select')).toBeVisible({ timeout: 10_000 });
    // The IDE keep-alive layer is still mounted from the first hop — scope by
    // the frame title so the assertion names the opencode surface specifically.
    await expect(page.locator('iframe.opencode-frame[title="Madar opencode"]')).toBeVisible({ timeout: 20_000 });
  });

  /* -- c. /#/ide embedded page keeps its toolbar features ---------------- */
  test('c) /#/ide — "Open in new tab" anchor to the proxy /ide route, picker, iframe', async ({ page }) => {
    await injectAuth(page);
    await page.goto(BASE);
    await page.evaluate(() => { window.location.hash = '/ide'; });

    const iframe = page.locator('iframe.opencode-frame[title="Madar VS Code"]');
    await expect(iframe).toBeVisible({ timeout: 20_000 });

    // Project picker is present
    await expect(page.locator('#ide-project-select')).toBeVisible();

    // Anchor points at the authenticated PROXY route for code-server
    const anchor = page.locator('.opencode-toolbar a', { hasText: 'Open in new tab' });
    await expect(anchor).toBeVisible();
    expect(await anchor.getAttribute('href')).toMatch(/^http:\/\/localhost:4097\/ide\/\?folder=/);
  });

  /* -- d. /#/opencode embedded page keeps picker + anchor --------------- */
  test('d) /#/opencode — proxy anchor, picker, status, iframe, keep-alive return', async ({ page }) => {
    await injectAuth(page);
    await page.goto(BASE);
    await page.evaluate(() => { window.location.hash = '/opencode'; });

    const iframe = page.locator('iframe.opencode-frame[title="Madar opencode"]');
    await expect(iframe).toBeVisible({ timeout: 20_000 });

    // Project picker is present
    await expect(page.locator('#oc-project-select')).toBeVisible();

    // Status line — the honest frame-state machine (loading / running /
    // did not load / offline), never a stale "running" while loading.
    const statusLine = page.locator('.opencode-toolbar span.term-title[role="status"]');
    await expect(statusLine).toBeVisible();
    expect(await statusLine.textContent()).toMatch(/^opencode:\s*(loading…|running|did not load|offline)$/);

    // Anchor points at the authenticated PROXY root for opencode
    const anchor = page.locator('.opencode-toolbar a', { hasText: 'Open in new tab' });
    await expect(anchor).toBeVisible();
    expect(await anchor.getAttribute('href')).toMatch(/^http:\/\/localhost:4097\/?$/);

    // Keep-alive round-trip: leave and come back — the toolbar must reappear
    // instantly from the persisted layer (no remount crash, no blank state).
    await page.evaluate(() => { window.location.hash = '/'; });
    await expect(page.locator('.qa-tile').first()).toBeVisible({ timeout: 15_000 });
    await page.evaluate(() => { window.location.hash = '/opencode'; });
    await expect(page.locator('#oc-project-select')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('iframe.opencode-frame[title="Madar opencode"]')).toBeVisible();
  });
});
