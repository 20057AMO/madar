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

  test('sidebar unread badge and account actions stay accessible', async ({ page }) => {
    let unread = 3;
    await page.route('**/api/chat-team/channels', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ channels: [{ unread }] }),
      })
    );
    await injectAuth(page);
    await page.setViewportSize({ width: 360, height: 640 });
    await page.goto(BASE);

    await expect(page.getByRole('button', { name: '3 unread messages: Team Chat' })).toBeVisible();
    await expect(page.locator('.nav-unread-badge')).toHaveText('3');
    await expect(page.getByRole('button', { name: 'Open profile' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

    unread = 0;
    await page.evaluate(() => window.dispatchEvent(new Event('wsd:team-chat-read')));
    await expect(page.locator('.nav-unread-badge')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth))
      .toBe(await page.evaluate(() => document.documentElement.clientWidth));
  });

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
    await expect(page.locator('.team-row .btn-ghost.icon-only').first()).toBeVisible({ timeout: 20_000 });
    for (const icon of (await page.locator('.team-row .btn-ghost.icon-only').all()).slice(0, 3)) {
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

test.describe('Team Chat navigation and search', () => {
  test('the app navigation remains clickable above the channel rail at tablet width', async ({ page }) => {
    await injectAuth(page);
    await page.setViewportSize({ width: 848, height: 742 });
    await page.goto(BASE);
    await page.evaluate(() => { window.location.hash = '/chat'; });

    const menu = page.getByRole('button', { name: 'Open menu' });
    await expect(menu).toBeVisible();
    await menu.click();
    await expect(page.locator('.sidebar.open')).toBeVisible();
  });

  test('global search reports request failures instead of showing an empty result', async ({ page }) => {
    await page.route('**/api/chat-team/search?*', (route) =>
      route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Unavailable' }) })
    );
    await injectAuth(page);
    await page.setViewportSize({ width: 900, height: 700 });
    await page.goto(BASE);
    await page.evaluate(() => { window.location.hash = '/chat'; });

    await page.getByRole('button', { name: 'Search all channels' }).click();
    await page.getByRole('textbox', { name: 'Search all channels' }).fill('unavailable');
    await expect(page.locator('.tchat-global-error')).toHaveText('Search failed. Try again.');
    await expect(page.locator('.tchat-global-empty')).toHaveCount(0);
  });

  test('the channel filter can narrow and restore the channel list', async ({ page }) => {
    await injectAuth(page);
    await page.setViewportSize({ width: 900, height: 700 });
    await page.goto(BASE);
    await page.evaluate(() => { window.location.hash = '/chat'; });

    const filter = page.getByRole('searchbox', { name: 'Filter channels' });
    await expect(filter).toBeVisible();
    const rows = page.locator('.tchat-channel-row');
    const initialCount = await rows.count();
    expect(initialCount).toBeGreaterThan(0);

    await filter.fill('channel-that-does-not-exist');
    await expect(page.locator('.tchat-channel-empty')).toHaveText('No matching channels.');
    expect(await rows.count()).toBe(0);

    await page.getByRole('button', { name: 'Clear channel filter' }).click();
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBe(initialCount);
  });

  test('the guide, code-block helper, and teammate mention picker work together', async ({ page }) => {
    await page.route('**/api/users', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ id: 'guide-teammate', username: 'teammate', role: 'editor', createdAt: '2026-01-01T00:00:00.000Z' }]),
      })
    );
    await injectAuth(page);
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(BASE);
    await page.evaluate(() => { window.location.hash = '/chat'; });

    await page.getByRole('button', { name: 'Toggle channel list' }).click();
    const projectChannel = page.locator('.tchat-channel-row').filter({ hasText: '# madar' }).first();
    await expect(projectChannel).toBeVisible({ timeout: 20_000 });
    await projectChannel.click();

    const guideButton = page.getByRole('button', { name: 'Team Chat guide' });
    await guideButton.click();
    const guide = page.getByRole('dialog', { name: 'Team Chat guide' });
    await expect(guide).toBeVisible();
    await expect(guide).toContainText('Writing and sharing code');
    await expect(guide).toContainText('Mention a teammate');
    await guide.getByRole('button', { name: 'Close guide' }).click();
    await expect(guide).toHaveCount(0);
    await expect(guideButton).toBeFocused();

    const composer = page.getByRole('textbox', { name: 'Type a message' });
    await page.getByRole('button', { name: 'Insert code block' }).click();
    await expect(composer).toHaveValue('```\n\n```');
    await composer.fill('const count = 1;');
    await composer.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(0, element.value.length));
    await page.getByRole('button', { name: 'Insert code block' }).click();
    await expect(composer).toHaveValue('```\nconst count = 1;\n```');

    await composer.fill('@team');
    const mention = page.getByRole('option', { name: /teammate @teammate/ });
    await expect(mention).toBeVisible();
    await composer.press('ArrowDown');
    await composer.press('Enter');
    await expect(composer).toHaveValue('@teammate ');
    expect(await page.evaluate(() => document.documentElement.scrollWidth))
      .toBe(await page.evaluate(() => document.documentElement.clientWidth));
  });
});
