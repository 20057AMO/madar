import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  retries: 1,
  reporter: 'list',
  // Serial by design: every suite drives the same app behind a per-IP rate
  // limiter, so parallel workers burst past the global budget and get 429s
  // (the dev container runs production budgets — WSD_TESTING=0). One worker
  // keeps the run deterministic; each individual suite is still fast.
  workers: 1,
  use: {
    baseURL: 'http://localhost:3000',
    browserName: 'chromium',
    headless: true,
    // Navigation timeout generous — the app loads iframes to external services
    navigationTimeout: 30_000,
    actionTimeout: 15_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
});
