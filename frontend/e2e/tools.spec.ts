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
 *  - The sidebar opencode button ALSO opens IN-APP at /#/opencode — no
 *    popup, no raw proxy origin (that 401s for a viewer, since the embed
 *    cookie is editor+ only; the page itself shows the honest needsEditor
 *    state instead).
 *  - Dashboard quick-action tiles navigate IN-APP (/#/ide, /#/opencode).
 *  - Both embedded pages keep their project picker, honest status line and
 *    an "Open in new tab" anchor pointing at the proxy — never a raw
 *    upstream port.
 */
import { test, expect } from './fixtures';
import { BASE, injectAuth } from './helpers';
import { pickedFolderSlug } from '../src/lib/tool-picker';

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

test.describe('Madar UI — tool entry points', () => {

  /* -- a. Sidebar: BOTH tool buttons navigate in-app (no popups) --------- */
  test('a) sidebar VS Code → #/ide; opencode → in-app #/opencode (no popup)', async ({ page }) => {
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

    await page.locator('.nav-btn', { hasText: 'opencode' }).first().click();
    await expect(page).toHaveURL(/#\/opencode$/);
    await expect(page.locator('#oc-project-select')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('iframe.opencode-frame[title="Madar opencode"]')).toBeVisible({ timeout: 20_000 });

    // In-app means in-app: the click must never spawn a second page.
    expect(page.context().pages().length).toBe(1);
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

  /* -- e. /#/ide?folder=… — the picker names the folder actually open ----- */
  test('e) /#/ide?folder=… — picker follows the open folder; a sibling name is not a match', async ({ page }) => {
    await injectAuth(page);
    await page.goto(BASE);
    await page.evaluate(() => { window.location.hash = '/ide'; });

    // WHICH project this admin sees is read from the rendered picker, so the
    // suite never hard-codes a slug that may have been deleted meanwhile.
    const select = page.locator('#ide-project-select');
    await expect(select).toBeVisible({ timeout: 20_000 });
    const firstOption = select.locator('option').nth(1);
    await expect(firstOption).toBeAttached({ timeout: 15_000 });
    const slug = (await firstOption.getAttribute('value')) || '';
    expect(slug).not.toBe('');

    // A DEEP folder (a sub-path inside the project) still names that project.
    // The old prefix-strip put "<slug>/src" into the select value, so the
    // toolbar showed no selection at all while the IDE was open on it.
    const deep = `/workspaces/${slug}/src`;
    await page.evaluate((f) => { window.location.hash = `/ide?folder=${encodeURIComponent(f)}`; }, deep);
    await expect(select).toHaveValue(slug, { timeout: 10_000 });
    // …and the address bar keeps naming the folder that is really open.
    await expect.poll(() => page.url()).toContain(`folder=${encodeURIComponent(deep)}`);

    // A SIBLING is not a match: a project "my-app" must never be reported for
    // /workspaces/my-app-2 — the picker falls back to "All projects" rather
    // than claiming a project the folder does not name.
    const sibling = `/workspaces/${slug}-zz-e2e/src`;
    await page.evaluate((f) => { window.location.hash = `/ide?folder=${encodeURIComponent(f)}`; }, sibling);
    await expect(select).toHaveValue('', { timeout: 10_000 });
    await expect.poll(() => page.url()).toContain(`folder=${encodeURIComponent(sibling)}`);

    // A ?folder= we will not open is stripped, not left claiming in the address
    // bar to be the open folder.
    await page.evaluate(() => { window.location.hash = `/ide?folder=${encodeURIComponent('C:\\Users')}`; });
    await expect.poll(() => page.url()).not.toContain('folder=');
  });

  /* -- f. /#/opencode?project=<unknown> — honest notice, no dead link ---- */
  test('f) /#/opencode?project=<unknown> — honest notice, param stripped, no request', async ({ page }) => {
    await injectAuth(page);
    const opens: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/opencode/open')) opens.push(r.url());
    });
    await page.goto(BASE);
    await page.evaluate(() => { window.location.hash = '/opencode?project=e2e-ghost-project'; });

    // The link names a project this account cannot open: say so instead of
    // silently doing nothing (the old code returned without a word).
    const notice = page.getByRole('status').filter({ hasText: 'e2e-ghost-project' });
    await expect(notice).toBeVisible({ timeout: 20_000 });
    await expect(notice).toContainText('not available to open');

    // The dead param is stripped, so a refresh or a copied link cannot lead
    // straight back into the same silent dead end.
    await expect.poll(() => page.url()).not.toContain('project=');

    // Nothing was requested: an unopenable project must never reach the
    // endpoint that seeds the workspace.
    expect(opens).toHaveLength(0);
    await expect(page.locator('#oc-project-select')).toHaveValue('');
  });
});

/* ------------------------------------------------------------------ */
/*  Pure helpers — imported directly (no second test framework)        */
/* ------------------------------------------------------------------ */

test.describe('tool picker helpers (pure)', () => {
  const roster = ['my-app', 'my-app-2', 'alpha'];

  test('pickedFolderSlug: first segment only, whole-segment match', () => {
    expect(pickedFolderSlug('/workspaces/my-app/src', roster)).toBe('my-app');
    expect(pickedFolderSlug('/workspaces/my-app', roster)).toBe('my-app');
    // A longer sibling is not a match for the shorter name — the trap a
    // startsWith-based lookup falls into.
    expect(pickedFolderSlug('/workspaces/my-app-2/src', roster)).toBe('my-app-2');
    expect(pickedFolderSlug('/workspaces/my-app-2/src', ['my-app'])).toBe(null);
    // Not a workspace path, the bare root, an empty folder, or a slug the
    // roster does not render → no selection at all.
    expect(pickedFolderSlug('/workspaces', roster)).toBe(null);
    expect(pickedFolderSlug('/workspaces/', roster)).toBe(null);
    expect(pickedFolderSlug('/', roster)).toBe(null);
    expect(pickedFolderSlug('', roster)).toBe(null);
    expect(pickedFolderSlug('/workspaces/ghost', roster)).toBe(null);
    expect(pickedFolderSlug('/workspaces/ghost', [])).toBe(null);
  });
});
