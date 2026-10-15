/**
 * Shared Playwright fixtures for the Madar e2e suites.
 *
 * Why this exists: every test would otherwise get a fresh browser context, and
 * a fresh context has an empty HTTP cache — so each navigation re-downloads the
 * whole Vite bundle (measured: 24 network requests, 14 of them scripts). The
 * app sits behind a per-IP rate limiter with production budgets in this
 * container (240 req/min, WSD_TESTING=0), so a full run of cold boots bursts
 * past it and every suite starts seeing 429s.
 *
 * We therefore share ONE browser context per worker (its HTTP cache persists —
 * /assets/* is served `immutable`, so warm boots drop to ~7 network requests)
 * while still handing each test a FRESH page, so document state (route,
 * mounted keep-alive layers, iframes) stays isolated exactly as before.
 */
import { test as base, expect, type Page, type BrowserContext } from '@playwright/test';

export const test = base.extend<{ page: Page }, { sharedContext: BrowserContext }>({
  sharedContext: [
    async ({ browser }, use) => {
      const context = await browser.newContext();
      await use(context);
      await context.close();
    },
    { scope: 'worker' },
  ],
  page: async ({ sharedContext }, use) => {
    const page = await sharedContext.newPage();
    await use(page);
    await page.close();
  },
});

export { expect };
export type { Page };
