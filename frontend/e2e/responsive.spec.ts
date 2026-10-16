/**
 * Phone-width (360px) layout guards for the Madar web UI — runs against the
 * live container.
 *
 * Context (2026-10 audit): a 360×640 sweep of every authenticated route found
 * exactly ONE layout bug — the Agents page's toolbar forced the whole document
 * to 431px (scrollWidth 431 vs clientWidth 360), because .agents-topbar-right
 * keeps the flexbox default `min-width: auto`, so the two quick-select labels'
 * min-content sized the wrapper to 417px and everything downstream scaled off
 * that phantom width (the "new agent" button hung off-screen). The fix is
 * `min-width: 0` + selects that fill their labels, bounded to ≤700px.
 *
 * The same sweep found icon-only controls under the WCAG 2.5.8 24px floor —
 * and this repo's own house standard for those at phone width is 44px
 * (see the .btn-ghost.sm.icon-only block and tchat.css's touch-target block),
 * so they follow it.
 *
 * Auth: shared with the other suites via ./helpers — a JWT forged locally
 * (same secret the server resolved) for a REAL admin user, injected into
 * localStorage via addInitScript so the app treats the browser as logged in.
 * The UI language is pinned to English so text assertions stay deterministic.
 *
 * Deliberately NOT covered here (documented, not forgotten):
 *  - .crash-dismiss (Projects) only renders once a project has a recorded
 *    crash, so an assertion would be vacuous on a clean server. Verified
 *    manually at 360×640: all 8 buttons 17×44 → 44×44, no overflow.
 *  - .tchat-presence-avatar (Team chat) only renders while presence is
 *    non-empty, and it stays at 24px rather than 44px because it is a -6px
 *    overlap stack that a 44px box would spread apart. Verified manually:
 *    22×44 → 24×44, no overflow.
 *  - .lang-btn (91×26) / .nav-icon-btn (26×26) already meet the 24px floor.
 */
import { test, expect } from './fixtures';
import { BASE, injectAuth } from './helpers';

test.describe('Phone-width layout (360px)', () => {

  /* -- a. Agents toolbar: the wrapper holds its 100% basis --------------- */

  test('a) Agents toolbar does not force sideways scrolling at 360px', async ({ page }) => {
    await injectAuth(page);
    await page.goto(BASE);
    await page.evaluate(() => { window.location.hash = '/agents'; });
    const right = page.locator('.agents-topbar-right');
    await expect(right).toBeVisible({ timeout: 20_000 });

    // Above the breakpoint the desktop layout applies and never overflowed —
    // the fix is bounded to phones (700px), not "every narrow window".
    await page.setViewportSize({ width: 900, height: 700 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    // At 360px the toolbar no longer sizes the document from its min-content
    // (it used to: the wrapper resolved to 417px, scrollWidth 431 vs 360).
    await page.setViewportSize({ width: 360, height: 640 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth))
      .toBe(await page.evaluate(() => document.documentElement.clientWidth));

    const box = await right.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(360);

    // …and the provider/model selects fill their labels instead of imposing
    // a 90px min-content floor on the whole toolbar.
    const select = right.locator('.quick-select select').first();
    const selBox = await select.boundingBox();
    expect(selBox).not.toBeNull();
    expect(selBox!.width).toBeGreaterThan(90);
  });

  /* -- b. Icon-only controls meet the touch-target floor ----------------- */

  test('b) icon-only controls meet the 44px touch target at 360px', async ({ page }) => {
    await injectAuth(page);
    await page.setViewportSize({ width: 360, height: 640 });

    // Team — the per-row "Remove user" icon (16×44 before the fix).
    await page.goto(BASE);
    await page.evaluate(() => { window.location.hash = '/team'; });
    await expect(page.locator('.team-row .btn-icon').first()).toBeVisible({ timeout: 20_000 });
    for (const icon of (await page.locator('.team-row .btn-icon').all()).slice(0, 3)) {
      const box = await icon.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    // Opencode Studio — the per-row copy/delete actions (21×44 before).
    await page.evaluate(() => { window.location.hash = '/opencode-studio'; });
    await expect(page.locator('.studio-action').first()).toBeVisible({ timeout: 20_000 });
    for (const action of (await page.locator('.studio-action').all()).slice(0, 3)) {
      const box = await action.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });
});
