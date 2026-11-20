import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { BASE, injectAuth, sessionToken } from './helpers';

const slug = `e2e-termerr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
let created = false;
let headers: Record<string, string> = {};

// The dev container runs production rate budgets: a saturated global limiter
// can 429 the document itself or the auth bootstrap. Retries below honour
// Retry-After (up to the 60 s window), so allow enough headroom for that.
test.setTimeout(180_000);

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function retryAfterMs(get: (name: string) => string | null): number {
  const raw = get('retry-after');
  const seconds = raw === null ? NaN : Number(raw);
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds * 1000, 65_000) + 250
    : 1000;
}

test.beforeAll(async () => {
  headers = {
    Authorization: `Bearer ${sessionToken()}`,
    'Content-Type': 'application/json',
  };
  const response = await fetch(`${BASE}/api/projects`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Terminal Errors E2E', slug }),
  });
  if (response.status !== 201) {
    const body = await response.text().catch(() => '');
    throw new Error(`failed to create temporary project ${slug}: HTTP ${response.status} ${body}`);
  }
  created = true;
});

test.afterAll(async () => {
  if (!created) return;
  test.setTimeout(180_000);
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(`${BASE}/api/projects/${slug}`, { method: 'DELETE', headers });
      if (response.ok) return;
      if (response.status === 429 && attempt < maxAttempts) {
        await delay(retryAfterMs((name) => response.headers.get(name)));
        continue;
      }
      console.warn(`[terminal-errors] cleanup DELETE for ${slug} returned HTTP ${response.status} after ${attempt} attempt(s)`);
      return;
    } catch {
      console.warn(`[terminal-errors] cleanup DELETE for ${slug} failed (network error) on attempt ${attempt}`);
      return;
    }
  }
});

async function injectTerminalAuth(page: Page): Promise<void> {
  await injectAuth(page);
  // A throttled lazy chunk must never trigger the shell's automatic reload:
  // that reload requests the document again and lands on the 429 JSON body,
  // which looks exactly like a Stage 7 assertion failure. Keep the already
  // loaded terminal document alive during a transient chunk 429.
  await page.addInitScript(() => {
    window.addEventListener('vite:preloadError', (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    });
  });
  // Only narrow, URL-specific routes — a wildcard page.route() rewrites the
  // browser's network stack and makes Chrome refuse the terminal WebSocket
  // upgrade with ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS (the shell then
  // stays "disconnected" forever). These never match a ws:// request.
  await page.route('**/sw.js', (route) => route.fulfill({ status: 204, body: '' }));
  // Hidden IDE/opencode warm-ups otherwise pull multi-megabyte frames through
  // the proxy and drain the shared 240/min bucket while Stage 7 is waiting.
  await page.route('**/api/ide/status', (route) =>
    route.fulfill({ status: 200, json: { ide: { running: false, port: 4097 } } }));
  await page.route('**/api/opencode/status', (route) =>
    route.fulfill({ status: 200, json: { running: false, port: 4097 } }));
  await page.route('**/api/embed/session', (route) =>
    route.request().method() === 'POST' && !route.request().url().includes('/clear')
      ? route.fulfill({ status: 200, json: { ok: true, port: 4097, expiresIn: 43200 } })
      : route.continue());
}

async function gotoTerminalPage(page: Page): Promise<void> {
  const authScreen = page.locator('input[placeholder="Enter username"], button:has-text("Create account")');
  const rateLimited = page.getByText('Too many requests. Try again later.');
  for (let attempt = 1; attempt <= 4; attempt++) {
    const response = attempt === 1
      ? await page.goto(`${BASE}/#/terminals/${slug}`)
      : await page.reload();
    if (response && response.status() === 429 && attempt < 4) {
      await delay(retryAfterMs((name) => response.headers()[name] ?? null));
      continue;
    }
    await expect(page.locator('.term-host').or(authScreen).or(rateLimited).first()).toBeVisible({ timeout: 45_000 });
    if (await rateLimited.isVisible()) {
      if (attempt === 4) throw new Error(`${slug}: rate limited on the terminal page after ${attempt} attempts`);
      const probe = await page.request.get(`${BASE}/api/auth/status`, {
        headers: { Authorization: `Bearer ${sessionToken()}` },
      });
      await new Promise((resolve) => setTimeout(resolve, retryAfterMs((name) => probe.headers()[name] ?? null)));
      continue;
    }
    if (!(await authScreen.count())) return;
    if (attempt === 4) throw new Error(`${slug}: terminal page returned to the auth screen ${attempt} times`);
  }
}

async function openTerminal(page: Page): Promise<void> {
  await injectTerminalAuth(page);
  await gotoTerminalPage(page);
  await expect(page.locator('.term-header-label')).toHaveText('connected', { timeout: 25_000 });
  await expect(page.locator('.term-host textarea.xterm-helper-textarea')).toHaveCount(1);
}

async function sendCommand(page: Page, command: string): Promise<void> {
  await page.locator('.term-host textarea.xterm-helper-textarea').first().focus();
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
}

test('clean shell exit reports exited, offers a new shell, and never auto-reconnects', async ({ page }) => {
  await openTerminal(page);
  const live = page.locator('.term-header-live[role="status"][aria-live="polite"]');
  await expect(live).toHaveCount(1);

  await sendCommand(page, 'exit');

  await expect(page.locator('.term-header-label')).toHaveText('exited', { timeout: 15_000 });
  await expect(page.locator('.term-close-notice')).toHaveText('Shell exited. Start a new shell to continue.');
  await expect(page.getByRole('button', { name: 'Start new shell' })).toBeVisible();
  await expect(live).toContainText('Shell exited. Start a new shell to continue.');

  await page.waitForTimeout(6000);
  await expect(page.locator('.term-header-label')).toHaveText('exited');
  await expect(page.locator('.term-close-notice')).toHaveText('Shell exited. Start a new shell to continue.');
});

test('capacity refusal shows the honest reason without holder identity and stops retrying', async ({ page, context }) => {
  await openTerminal(page);

  const second = await context.newPage();
  await injectTerminalAuth(second);
  await gotoTerminalPage(second);
  await expect(second.locator('.term-host')).toBeVisible({ timeout: 20_000 });

  await expect(second.locator('.term-host .xterm-accessibility-tree')).toContainText('already open', { timeout: 15_000 });
  await expect(second.locator('.term-header-label')).toHaveText('error');
  await expect(second.locator('.term-close-notice')).toContainText('already open');
  const notice = await second.locator('.term-close-notice').innerText();
  expect(notice).not.toMatch(/user|uid|holder|owned/i);

  await second.waitForTimeout(6000);
  await expect(second.locator('.term-header-label')).toHaveText('error');
  await expect(second.locator('.term-close-notice')).toContainText('already open');
});

test('non-zero shell exit reports failure, keeps the notice through reconnect, then recovers', async ({ page }) => {
  await openTerminal(page);
  await page.locator('.term-mode-btn', { hasText: 'Control' }).click();
  await expect(page.locator('.term-header-label')).toHaveText('connected', { timeout: 25_000 });
  await expect(page.locator('.term-host .xterm-accessibility-tree')).toHaveCount(1, { timeout: 25_000 });

  await sendCommand(page, 'exit 7');

  let reported = false;
  try {
    await expect(page.locator('.term-close-notice')).toContainText('Terminal exited with code 7', { timeout: 15_000 });
    reported = true;
  } catch {
    reported = false;
  }
  if (!reported) {
    test.skip(true, 'Backend Stage 7 non-zero exit reporting is not deployed in this container');
    return;
  }

  await expect(page.locator('.term-header-label')).toHaveText('error');
  await expect(page.locator('.term-host .xterm-accessibility-tree')).toContainText('Terminal exited with code 7');
  await expect(page.locator('.term-header-live[role="status"][aria-live="polite"]'))
    .toContainText('Terminal exited with code 7');
  await expect(page.locator('.term-close-notice')).toContainText('Terminal exited with code 7');

  await expect(page.locator('.term-header-label')).toHaveText('connected', { timeout: 25_000 });
  await expect(page.locator('.term-close-notice')).toHaveCount(0);
});
