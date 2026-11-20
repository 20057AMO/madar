import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { BASE, injectAuth, sessionToken } from './helpers';

const slug = `e2e-a11y-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
let created = false;
let headers: Record<string, string> = {};

test.beforeAll(async () => {
  headers = {
    Authorization: `Bearer ${sessionToken()}`,
    'Content-Type': 'application/json',
  };
  const response = await fetch(`${BASE}/api/projects`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Terminal A11y E2E', slug }),
  });
  if (response.status !== 201) {
    const body = await response.text().catch(() => '');
    throw new Error(`failed to create temporary project ${slug}: HTTP ${response.status} ${body}`);
  }
  created = true;
});

test.afterAll(async () => {
  if (!created) return;
  try {
    const response = await fetch(`${BASE}/api/projects/${slug}`, { method: 'DELETE', headers });
    if (!response.ok) {
      console.warn(`[terminal-a11y] cleanup DELETE for ${slug} returned HTTP ${response.status}`);
    }
  } catch {
    console.warn(`[terminal-a11y] cleanup DELETE for ${slug} failed (network error)`);
  }
});

async function openTerminal(page: Page): Promise<void> {
  await injectAuth(page);
  await page.goto(`${BASE}/#/terminals/${slug}`);
  await expect(page.locator('.term-host')).toBeVisible({ timeout: 20_000 });
}

async function waitForStableLayout(page: Page, selector: string): Promise<void> {
  const token = `__terminalA11yStable_${Math.random().toString(36).slice(2)}`;
  await page.waitForFunction(
    ({ target, key }) => {
      const el = document.querySelector(target);
      if (!el) return false;
      const rect = el.getBoundingClientRect();
      const signature = `${rect.x}|${rect.y}|${rect.width}|${rect.height}`;
      const state = Reflect.get(window, key) as { signature: string; frames: number } | undefined;
      if (!state || state.signature !== signature) {
        Reflect.set(window, key, { signature, frames: 1 });
      } else {
        state.frames += 1;
      }
      return (Reflect.get(window, key) as { frames: number }).frames >= 6;
    },
    { target: selector, key: token },
    { timeout: 20_000, polling: 'raf' },
  );
}

test.describe('Terminal focus ring (fine pointer)', () => {
  test.use({ viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false });

  test('Terminal focus ring is visible on desktop without layout shift', async ({ page }) => {
    await openTerminal(page);
    const host = page.locator('.term-host');
    await waitForStableLayout(page, '.term-host');
    const before = await host.boundingBox();
    expect(before).not.toBeNull();
    expect(await host.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('none');

    await page.locator('.term-host textarea.xterm-helper-textarea').first().focus();

    const outline = await host.evaluate((el) => {
      const s = getComputedStyle(el);
      return { style: s.outlineStyle, width: s.outlineWidth, color: s.outlineColor, offset: s.outlineOffset };
    });
    expect(outline).toEqual({ style: 'solid', width: '2px', color: 'rgb(255, 255, 255)', offset: '-2px' });

    const after = await host.boundingBox();
    expect(after).not.toBeNull();
    expect(after!.x).toBeCloseTo(before!.x, 1);
    expect(after!.y).toBeCloseTo(before!.y, 1);
    expect(after!.width).toBeCloseTo(before!.width, 1);
    expect(after!.height).toBeCloseTo(before!.height, 1);
  });

  test('fine pointer does not force 44px terminal targets', async ({ page }) => {
    await openTerminal(page);
    expect(await page.evaluate(() => matchMedia('(hover: none) and (pointer: coarse)').matches)).toBe(false);
    const box = await page.locator('.term-ctrl-btn').first().boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeLessThan(44);
  });

  test('Stage 6A terminal accessibility guard stays intact', async ({ page }) => {
    await openTerminal(page);
    const panel = page.locator('.term-host[role="tabpanel"]');
    await expect(panel).toHaveAttribute('aria-labelledby', /\S/);
    await expect(page.getByRole('button', { name: 'Release Tab and Escape to the browser' }))
      .toHaveAttribute('aria-pressed', /^(true|false)$/);
    await expect(page.locator('.term-host .xterm-accessibility-tree')).toHaveCount(1);
    await expect(page.locator('.term-host textarea.xterm-helper-textarea')).toHaveCount(1);
  });
});

test.describe('Terminal touch targets (coarse pointer, 360px)', () => {
  test.use({ viewport: { width: 360, height: 640 }, isMobile: true, hasTouch: true });

  test('coarse pointer gives terminal controls 44px targets', async ({ page }) => {
    await openTerminal(page);
    expect(await page.evaluate(() => matchMedia('(hover: none) and (pointer: coarse)').matches)).toBe(true);

    await waitForStableLayout(page, '.term-tab-add');
    const addBox = await page.locator('.term-tab-add').first().boundingBox();
    expect(addBox, '.term-tab-add is rendered and measurable').not.toBeNull();
    expect(addBox!.width, '.term-tab-add min width').toBeGreaterThanOrEqual(44);
    expect(addBox!.height, '.term-tab-add min height').toBeGreaterThanOrEqual(44);

    await page.locator('.term-tab-add').click();
    await expect(page.locator('.term-tab-close').first()).toBeVisible();
    await waitForStableLayout(page, '.term-tab-close');

    const selectors = ['.term-tab-close', '.term-ctrl-btn', '.term-quick-btn', '.term-mode-btn'];
    for (const selector of selectors) {
      const box = await page.locator(selector).first().boundingBox();
      expect(box, `${selector} is rendered and measurable`).not.toBeNull();
      expect(box!.width, `${selector} min width`).toBeGreaterThanOrEqual(44);
      expect(box!.height, `${selector} min height`).toBeGreaterThanOrEqual(44);
    }
  });

  test('terminal controls do not overflow at 360px', async ({ page }) => {
    await openTerminal(page);
    expect(await page.evaluate(() => matchMedia('(hover: none) and (pointer: coarse)').matches)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth))
      .toBe(await page.evaluate(() => document.documentElement.clientWidth));
  });
});
