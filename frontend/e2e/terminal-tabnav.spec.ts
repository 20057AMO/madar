import { test, expect, type Page } from './fixtures';
import { BASE, injectAuth, sessionToken } from './helpers';

test.describe.configure({ retries: 0 });
test.setTimeout(180_000);

const slug = `e2e-termtab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

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
      body: JSON.stringify({ name: 'Terminal Tabnav E2E', slug }),
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

async function openTerminal(page: Page): Promise<void> {
  await injectAuth(page);
  await page.addInitScript(() => {
    const NativeWS = window.WebSocket;

    class FakeTerminalSocket {
      static CONNECTING = NativeWS.CONNECTING;
      static OPEN = NativeWS.OPEN;
      static CLOSING = NativeWS.CLOSING;
      static CLOSED = NativeWS.CLOSED;
      url: string;
      binaryType = 'arraybuffer';
      readyState = NativeWS.OPEN;
      bufferedAmount = 0;
      extensions = '';
      protocol = '';
      onopen: any = null;
      onclose: any = null;
      onerror: any = null;
      onmessage: any = null;

      constructor(url: string) {
        this.url = url;
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
}

type TabState = {
  ids: string[];
  active: string;
  tabIndexes: number[];
  focusClose: string | null;
  focusTab: string | null;
};

function readTabState(page: Page): Promise<TabState> {
  return page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll<HTMLElement>('[data-term-tab]'));
    return {
      ids: tabs.map((element) => element.dataset.termTab || ''),
      active: tabs.find((element) => element.getAttribute('aria-selected') === 'true')?.dataset.termTab || '',
      tabIndexes: tabs.map((element) => element.tabIndex),
      focusClose: document.activeElement?.getAttribute('data-term-tab-close') || null,
      focusTab: document.activeElement?.getAttribute('data-term-tab') || null,
    };
  });
}

async function addThreeTabs(page: Page): Promise<TabState> {
  await page.evaluate(() => {
    const add = document.querySelector<HTMLButtonElement>('.term-tab-add');
    if (!add) throw new Error('add-tab button missing');
    add.click();
    add.click();
  });
  await expect.poll(() => page.locator('[data-term-tab]').count()).toBe(3);
  return readTabState(page);
}

test('closing the active tab among three restores focus to the last remaining close button', async ({ page }) => {
  await openTerminal(page);
  const before = await addThreeTabs(page);
  expect(before.active).toBe(before.ids[2]);
  const remaining = before.ids.filter((id) => id !== before.active);
  const expectedFocusId = remaining[remaining.length - 1];

  await page.locator(`[data-term-tab-close="${before.active}"]`).click();

  await expect.poll(() => page.locator('[data-term-tab]').count()).toBe(2);
  await expect.poll(() => page.evaluate(() =>
    document.activeElement?.getAttribute('data-term-tab-close') || null)).toBe(expectedFocusId);
  const after = await readTabState(page);
  expect(after.ids).toEqual(remaining);
  expect(after.active).toBe(expectedFocusId);
  expect(after.focusTab).toBeNull();
});

test('closing the active tab down to one focuses the tab element when no close button remains', async ({ page }) => {
  await openTerminal(page);
  await page.locator('.term-tab-add').click();
  await expect.poll(() => page.locator('[data-term-tab]').count()).toBe(2);
  const before = await readTabState(page);
  expect(before.active).toBe(before.ids[1]);
  const remainingId = before.ids[0];

  await page.locator(`[data-term-tab-close="${before.active}"]`).click();

  await expect.poll(() => page.locator('[data-term-tab]').count()).toBe(1);
  await expect.poll(() => page.evaluate(() =>
    document.activeElement?.getAttribute('data-term-tab') || null)).toBe(remainingId);
  expect(await page.locator('[data-term-tab-close]').count()).toBe(0);
  const after = await readTabState(page);
  expect(after.ids).toEqual([remainingId]);
  expect(after.active).toBe(remainingId);
  expect(after.focusClose).toBeNull();
});

test('focus restoration leaves the roving tabindex intact and arrow navigation working', async ({ page }) => {
  await openTerminal(page);
  const before = await addThreeTabs(page);
  await page.locator(`[data-term-tab-close="${before.active}"]`).click();
  await expect.poll(() => page.locator('[data-term-tab]').count()).toBe(2);

  const afterClose = await readTabState(page);
  expect(afterClose.tabIndexes.filter((index) => index === 0)).toHaveLength(1);
  expect(afterClose.tabIndexes.filter((index) => index === -1)).toHaveLength(1);
  expect(afterClose.tabIndexes[afterClose.ids.indexOf(afterClose.active)]).toBe(0);
  expect(await page.locator('[data-term-tab-close][role="tab"]').count()).toBe(0);
  expect(await page.locator('[data-term-tab-close][tabindex="0"]').count()).toBe(2);

  await page.locator(`[data-term-tab="${afterClose.active}"]`).focus();
  await page.keyboard.press('ArrowLeft');
  const previousId = afterClose.ids[afterClose.ids.indexOf(afterClose.active) - 1];
  await expect.poll(() => page.evaluate(() =>
    document.activeElement?.getAttribute('data-term-tab') || null)).toBe(previousId);

  const afterArrow = await readTabState(page);
  expect(afterArrow.active).toBe(previousId);
  expect(afterArrow.tabIndexes[afterArrow.ids.indexOf(previousId)]).toBe(0);
  expect(afterArrow.tabIndexes.filter((index) => index === 0)).toHaveLength(1);
});

test('two close-tab clicks in one batch leave only the survivor and keep focus', async ({ page }) => {
  await openTerminal(page);
  const before = await addThreeTabs(page);
  const [keepId, firstCloseId, secondCloseId] = before.ids;

  await page.locator(`[data-term-tab="${keepId}"]`).click();
  await expect.poll(() => page.evaluate((id) =>
    document.querySelector(`[data-term-tab="${id}"]`)?.getAttribute('aria-selected'), keepId)).toBe('true');

  await page.evaluate(({ first, second }) => {
    document.querySelector<HTMLElement>(`[data-term-tab-close="${first}"]`)?.click();
    document.querySelector<HTMLElement>(`[data-term-tab-close="${second}"]`)?.click();
  }, { first: firstCloseId, second: secondCloseId });

  await expect.poll(() => page.locator('[data-term-tab]').count()).toBe(1);
  const after = await readTabState(page);
  expect(after.ids).toEqual([keepId]);
  expect(after.active).toBe(keepId);
  expect(after.focusTab).toBe(keepId);
  expect(after.focusClose).toBeNull();
  expect(await page.locator('[data-term-tab-close]').count()).toBe(0);
});
