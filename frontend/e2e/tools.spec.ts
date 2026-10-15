/**
 * E2E smoke tests for the Madar web UI — runs against the live container.
 *
 * Auth: shared with the other suites via ./helpers — a JWT forged locally (same
 * secret the server resolved) for a REAL user resolved from the running
 * container's data/users.json, injected into localStorage via addInitScript so
 * the app treats the browser as logged in. The UI language is pinned to English
 * so text assertions stay deterministic (first-visit default is Arabic).
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
import { test, expect, type Page } from './fixtures';
import { BASE, injectAuth } from './helpers';

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

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
