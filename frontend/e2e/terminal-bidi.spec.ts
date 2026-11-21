import { test, expect, type Page } from './fixtures';
import { BASE, injectAuth, sessionToken } from './helpers';
import { ar } from '../src/i18n/ar';

test.describe.configure({ retries: 0 });
test.setTimeout(180_000);

const slug = `e2e-termbidi-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const LRI = '\u2066';
const PDI = '\u2069';

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
      body: JSON.stringify({ name: 'Terminal Bidi E2E', slug }),
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

const CONTRACT: Array<{ key: string; actual: string; expected: string; tokens: string[] }> = [
  { key: 'terminal.tabs.first', actual: ar.terminal.tabs.first, expected: 'الطرفية \u20661\u2069', tokens: ['1'] },
  { key: 'terminal.access.projectTitle', actual: ar.terminal.access.projectTitle, expected: 'صلاحية \u2066editor\u2069 مطلوبة', tokens: ['editor'] },
  { key: 'terminal.access.projectBody', actual: ar.terminal.access.projectBody, expected: 'تحتاج إلى صلاحية \u2066editor\u2069 لهذا المشروع لفتح طرفيته. اطلب الوصول من مسؤول المشروع.', tokens: ['editor'] },
  { key: 'terminal.access.controlTitle', actual: ar.terminal.access.controlTitle, expected: 'صلاحية \u2066admin\u2069 مطلوبة', tokens: ['admin'] },
  { key: 'terminal.access.controlBody', actual: ar.terminal.access.controlBody, expected: 'يتطلب فتح طرفية التحكم صلاحية \u2066admin\u2069 لهذا المشروع. أداة \u2066docker CLI\u2069 غير متاحة للمشاهدين أو المحررين.', tokens: ['admin', 'docker CLI'] },
  { key: 'terminal.action.zoomOut', actual: ar.terminal.action.zoomOut, expected: 'تصغير الخط \u2066(Ctrl+Scroll)\u2069', tokens: ['(Ctrl+Scroll)'] },
  { key: 'terminal.action.zoomIn', actual: ar.terminal.action.zoomIn, expected: 'تكبير الخط \u2066(Ctrl+Scroll)\u2069', tokens: ['(Ctrl+Scroll)'] },
  { key: 'terminal.action.a11yKeys', actual: ar.terminal.action.a11yKeys, expected: 'تحرير \u2066Tab\u2069 و \u2066Escape\u2069 للمتصفح', tokens: ['Tab', 'Escape'] },
  { key: 'terminal.action.modeControl', actual: ar.terminal.action.modeControl, expected: 'طرفية في حاوية التطبيق \u2066(git + docker CLI)\u2069', tokens: ['(git + docker CLI)'] },
  { key: 'terminal.notice.connectionLost', actual: ar.terminal.notice.connectionLost, expected: 'انقطع الاتصال \u2066({code})\u2069. أعد الاتصال للمتابعة.', tokens: ['({code})'] },
];

test('Arabic terminal dictionary keeps balanced LRI/PDI isolates and leaves roomLimit untouched', async () => {
  expect(CONTRACT).toHaveLength(10);
  for (const { key, actual, expected, tokens } of CONTRACT) {
    expect(actual, key).toBe(expected);
    expect(actual.split(LRI).length - 1, `${key} LRI count`).toBe(tokens.length);
    expect(actual.split(PDI).length - 1, `${key} PDI count`).toBe(tokens.length);
    expect(actual, key).not.toMatch(/[\u2067\u2068]/);
    const found = [...actual.matchAll(/\u2066([^\u2066\u2069]*)\u2069/g)].map((match) => match[1]);
    expect(found, key).toEqual(tokens);
    expect(found.every((token) => token.length > 0), `${key} empty isolate`).toBe(true);
  }

  expect(ar.terminal.notice.roomLimit).toBe('عدد كبير جداً من اتصالات الطرفية. أغلق تبويب طرفية آخر، ثم أعد الاتصال.');
  expect(ar.terminal.notice.roomLimit).not.toMatch(/[\u2066-\u2069]/);
});

async function openArabicTerminal(page: Page): Promise<void> {
  await injectAuth(page);
  await page.addInitScript(() => localStorage.setItem('wsd.lang', 'ar'));
  await page.addInitScript(() => {
    const NativeWS = window.WebSocket;
    const state: { current: any; fireRoomLimit?: () => void } = { current: null as any };
    (window as any).__termBidi = state;

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
        state.current = this;
        setTimeout(() => {
          if (typeof this.onmessage !== 'function') return;
          this.onmessage(new MessageEvent('message', {
            data: JSON.stringify({ type: 'path', subdir: 'src/app' }),
          }));
          this.onmessage(new MessageEvent('message', { data: JSON.stringify({ type: 'ready' }) }));
        }, 0);
      }

      send() {}
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

    state.fireRoomLimit = () => {
      const ws = state.current;
      if (!ws) throw new Error('no terminal socket to close');
      if (typeof ws.onerror === 'function') ws.onerror(new Event('error'));
      if (typeof ws.onclose === 'function') {
        ws.onclose(new CloseEvent('close', {
          code: 1013,
          reason: 'too many connections for terminal',
          wasClean: false,
        }));
      }
    };
  });

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
  await expect(page.locator('.term-header-label')).toHaveText('متصل', { timeout: 25_000 });
}

test('Arabic terminal DOM shows isolated Latin tokens in textContent, title and aria-label', async ({ page }) => {
  await openArabicTerminal(page);
  expect(await page.evaluate(() => document.documentElement.dir)).toBe('rtl');

  const tabLabel = await page.locator('.term-tab-label').first().textContent();
  expect(tabLabel).toContain(LRI + '1' + PDI);
  expect(tabLabel).not.toContain('\u2067');
  expect(tabLabel).not.toContain('\u2068');

  const fontButtons = page.locator('.term-font-controls').first().locator('.term-ctrl-btn');
  const zoomOutTitle = await fontButtons.nth(0).getAttribute('title');
  const zoomInTitle = await fontButtons.nth(1).getAttribute('title');
  expect(zoomOutTitle).toContain(LRI + '(Ctrl+Scroll)' + PDI);
  expect(zoomInTitle).toContain(LRI + '(Ctrl+Scroll)' + PDI);

  const a11yButton = page.locator('.term-font-controls').nth(1).locator('.term-ctrl-btn');
  const a11yTitle = await a11yButton.getAttribute('title');
  expect(a11yTitle).toContain(LRI + 'Tab' + PDI);
  expect(a11yTitle).toContain(LRI + 'Escape' + PDI);
  const a11yLabel = await a11yButton.getAttribute('aria-label');
  expect(a11yLabel).toContain('\u2066Tab\u2069');
  expect(a11yLabel).toContain('\u2066Escape\u2069');

  const modeTitle = await page.locator('.term-mode-btn').nth(1).getAttribute('title');
  expect(modeTitle).toContain(LRI + '(git + docker CLI)' + PDI);

  await page.evaluate(() => (window as any).__termBidi.fireRoomLimit());
  await expect(page.locator('.term-close-notice')).toBeVisible({ timeout: 10_000 });
  const notice = await page.locator('.term-close-notice').textContent();
  expect(notice).toBe(ar.terminal.notice.roomLimit);
  expect(notice).not.toMatch(/[\u2066-\u2069]/);
});
