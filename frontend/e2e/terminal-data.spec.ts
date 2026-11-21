import { test, expect, type Page } from './fixtures';
import { BASE, injectAuth, sessionToken } from './helpers';

test.describe.configure({ retries: 0 });
test.setTimeout(180_000);

const slug = `e2e-termdata-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const FONT_KEY = 'wsd.term.fontSize';
const HISTORY_KEY = `wsd.term.history.${slug}.project`;

let headers: Record<string, string> = {};
let created = false;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function retryAfterMs(get: (name: string) => string | null): number {
  const raw = get('retry-after');
  const seconds = raw === null ? NaN : Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 65_000) + 250 : 1000;
}

async function apiWithRetry(pathname: string, init: RequestInit, expected: number): Promise<void> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const response = await fetch(`${BASE}${pathname}`, { ...init, headers });
    if (response.status === expected) return;
    if (response.status === 429 && attempt < 5) {
      await delay(retryAfterMs((name) => response.headers.get(name)));
      continue;
    }
    const body = await response.text().catch(() => '');
    throw new Error(`${init.method || 'GET'} ${pathname}: HTTP ${response.status} ${body.slice(0, 200)}`);
  }
}

test.beforeAll(async () => {
  headers = { Authorization: `Bearer ${sessionToken()}`, 'Content-Type': 'application/json' };
  try {
    await apiWithRetry('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'Terminal Data E2E', slug }),
    }, 201);
    created = true;
  } finally {
    if (!created) headers = {};
  }
});

test.afterAll(async () => {
  test.setTimeout(180_000);
  try {
    if (created) await apiWithRetry(`/api/projects/${slug}`, { method: 'DELETE' }, 200);
  } finally {
    created = false;
    headers = {};
  }
});

type Seed = {
  fontSize?: string;
  historyRaw?: string;
};

async function openTerminal(page: Page, seed: Seed = {}): Promise<void> {
  await injectAuth(page);
  await page.addInitScript((s: Seed & { fontKey: string; histKey: string }) => {
    // The worker shares one browser context, so localStorage survives between
    // tests. Reset BOTH keys on every navigation so a seed can never leak.
    if (s.fontSize === undefined) localStorage.removeItem(s.fontKey);
    else localStorage.setItem(s.fontKey, s.fontSize);
    if (s.historyRaw === undefined) localStorage.removeItem(s.histKey);
    else localStorage.setItem(s.histKey, s.historyRaw);

    const NativeWS = window.WebSocket;
    const state = { sent: [] as string[], sockets: [] as string[] };
    (window as any).__termData = state;

    class FakeTerminalSocket {
      static CONNECTING = NativeWS.CONNECTING;
      static OPEN = NativeWS.OPEN;
      static CLOSING = NativeWS.CLOSING;
      static CLOSED = NativeWS.CLOSED;
      url: string;
      binaryType = 'arraybuffer';
      readyState: number = NativeWS.OPEN;
      bufferedAmount = 0;
      extensions = '';
      protocol = '';
      onopen: any = null;
      onclose: any = null;
      onerror: any = null;
      onmessage: any = null;

      constructor(url: string) {
        this.url = url;
        state.sockets.push(url);
        setTimeout(() => {
          if (typeof this.onmessage !== 'function') return;
          this.onmessage(new MessageEvent('message', {
            data: JSON.stringify({ type: 'path', subdir: 'src/app' }),
          }));
          this.onmessage(new MessageEvent('message', { data: JSON.stringify({ type: 'ready' }) }));
        }, 0);
      }

      send(data: any) {
        state.sent.push(typeof data === 'string' ? data : new TextDecoder().decode(data));
      }
      close() { this.readyState = NativeWS.CLOSED; }
      addEventListener() {}
      removeEventListener() {}
      dispatchEvent() { return true; }
    }

    const Wrapped = function (url: string | URL, protocols?: string | string[]) {
      const target = String(url);
      if (target.includes('/ws/projects/') && target.includes('/terminal')) {
        return new FakeTerminalSocket(target);
      }
      return protocols === undefined ? new NativeWS(url as any) : new NativeWS(url as any, protocols as any);
    } as any;
    Wrapped.prototype = NativeWS.prototype;
    Wrapped.CONNECTING = NativeWS.CONNECTING;
    Wrapped.OPEN = NativeWS.OPEN;
    Wrapped.CLOSING = NativeWS.CLOSING;
    Wrapped.CLOSED = NativeWS.CLOSED;
    window.WebSocket = Wrapped;
  }, { ...seed, fontKey: FONT_KEY, histKey: HISTORY_KEY });

  await page.addInitScript(() => {
    window.addEventListener('vite:preloadError', (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    });
  });

  await page.route('**/sw.js', (route) => route.fulfill({ status: 204, body: '' }));
  await page.route('**/api/ide/status', (route) =>
    route.fulfill({ status: 200, json: { ide: { running: false, port: 4097 } } }));
  await page.route('**/api/opencode/status', (route) =>
    route.fulfill({ status: 200, json: { running: false, port: 4097 } }));
  await page.route('**/api/embed/session', (route) =>
    route.request().method() === 'POST' && !route.request().url().includes('/clear')
      ? route.fulfill({ status: 200, json: { ok: true, port: 4097, expiresIn: 43200 } })
      : route.continue());

  await page.goto(`${BASE}/#/terminals/${slug}`);
  await expect(page.locator('.term-host')).toBeVisible({ timeout: 45_000 });
  await expect(page.locator('.term-header-label')).toHaveText('connected', { timeout: 25_000 });
  await expect(page.locator('.term-host textarea.xterm-helper-textarea')).toHaveCount(1);
}

/** Captured stdin frames, minus blank/init frames and the periodic resize frames the terminal emits. */
function commandFrames(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const sent = (window as any).__termData.sent as string[];
    return sent.filter((s) => s.trim().length > 0 && !s.startsWith('{"type":"resize"'));
  });
}

function readStoredHistory(page: Page): Promise<unknown> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    if (raw === null) return [];
    try {
      return JSON.parse(raw);
    } catch {
      return '__corrupt__';
    }
  }, HISTORY_KEY);
}

for (const [label, value, expected] of [
  ['non-numeric', 'abc', '13px'],
  ['empty', '', '13px'],
  ['zero', '0', '9px'],
  ['huge', '999', '24px'],
] as const) {
  test(`corrupt persisted fontSize (${label}) is clamped on load`, async ({ page }) => {
    await openTerminal(page, { fontSize: value });
    await expect(page.locator('.term-font-label')).toHaveText(expected);
  });
}

test('font zoom keeps a clamped value inside the 9–24 range', async ({ page }) => {
  await openTerminal(page, { fontSize: '999' });
  await expect(page.locator('.term-font-label')).toHaveText('24px');

  const controls = page.locator('.term-font-controls').first().locator('.term-ctrl-btn');
  await controls.nth(1).click(); // zoom in past the ceiling
  await expect(page.locator('.term-font-label')).toHaveText('24px');
  expect(await page.evaluate((key) => localStorage.getItem(key), FONT_KEY)).toBe('24');

  await controls.nth(2).click(); // reset
  await expect(page.locator('.term-font-label')).toHaveText('13px');
  expect(await page.evaluate((key) => localStorage.getItem(key), FONT_KEY)).toBe('13');
});

test('corrupt history JSON is ignored and the terminal still renders', async ({ page }) => {
  await openTerminal(page, { historyRaw: '{not-json' });
  await expect(page.locator('.term-host textarea.xterm-helper-textarea')).toHaveCount(1);
  await expect(page.locator('.term-font-label')).toBeVisible();

  await page.locator('.term-host textarea.xterm-helper-textarea').first().focus();
  await page.keyboard.press('ArrowUp');
  const frames = await commandFrames(page);
  expect(frames.filter((frame) => frame.startsWith('\x1b[2K\r'))).toEqual([]);

  const body = await page.evaluate(() => document.body.innerText);
  expect(body).not.toContain('[object Object]');
  expect(body).not.toContain('not-json');
});

test('polluted history is filtered and each entry truncated on read', async ({ page }) => {
  await openTerminal(page, {
    historyRaw: JSON.stringify(['ok', 42, { evil: true }, 'x'.repeat(5000), null, true]),
  });
  const textarea = page.locator('.term-host textarea.xterm-helper-textarea').first();
  await textarea.focus();
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(120);
  await page.keyboard.press('ArrowUp');

  const frames = await commandFrames(page);
  expect(frames).toHaveLength(2);
  expect(frames[0]).toBe('\x1b[2K\r' + 'x'.repeat(2000));
  expect(frames[1]).toBe('\x1b[2K\rok');

  const joined = frames.join('|');
  expect((joined.match(/x/g) || []).length).toBe(2000);
  expect(joined).not.toContain('[object Object]');
  expect(joined).not.toContain('5000');
  expect(joined).not.toMatch(/(?:^|\W)(?:42|true|null)(?:\W|$)/);

  const noOverflow = await page.evaluate(() =>
    document.documentElement.scrollWidth <= window.innerWidth + 1);
  expect(noOverflow).toBe(true);
});

test('control-character history entries never reach the terminal stdin', async ({ page }) => {
  await openTerminal(page, {
    historyRaw: JSON.stringify(['\r echo injected', '\x1b[31mred', 'good']),
  });
  const textarea = page.locator('.term-host textarea.xterm-helper-textarea').first();
  await textarea.focus();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');

  const frames = await commandFrames(page);
  expect(frames).toEqual([
    '\x1b[2K\rgood', '\x1b[2K\rgood', '\x1b[2K\rgood',
  ]);
  expect(frames.join('|')).not.toContain('echo injected');
  expect(frames.join('|')).not.toContain('\x1b[31m');
});

test('quick command persists sanitized history capped at the newest 100 entries', async ({ page }) => {
  const seeded = Array.from({ length: 100 }, (_, i) => `cmd-${i + 1}`);
  await openTerminal(page, { historyRaw: JSON.stringify(seeded) });

  await page.locator('.term-quick-btn').first().click();
  await expect.poll(() => readStoredHistory(page)).toEqual([...seeded.slice(1), 'git status']);

  await page.locator('.term-quick-btn').nth(1).click();
  await expect.poll(() => readStoredHistory(page)).toEqual([
    ...seeded.slice(2), 'git status', 'git log --oneline -10',
  ]);

  const stored = (await readStoredHistory(page)) as string[];
  expect(stored).toHaveLength(100);
  expect(stored.every((item) => typeof item === 'string' && item.length <= 2000)).toBe(true);
});
