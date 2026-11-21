import { test, expect, type Page } from './fixtures';
import { BASE, injectAuth, sessionToken } from './helpers';

test.describe.configure({ retries: 0 });
test.setTimeout(180_000);

const slug = `e2e-trec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const ROOM_LIMIT = 'Too many terminal connections. Close another terminal tab, then reconnect.';
const ROOM_LIMIT_AR = 'عدد كبير جداً من اتصالات الطرفية. أغلق تبويب طرفية آخر، ثم أعد الاتصال.';

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
      body: JSON.stringify({ name: 'Terminal Recovery E2E', slug }),
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

async function openTerminal(page: Page, lang: 'en' | 'ar' = 'en'): Promise<void> {
  await injectAuth(page);
  if (lang === 'ar') {
    await page.addInitScript(() => localStorage.setItem('wsd.lang', 'ar'));
  }
  await page.addInitScript(() => {
    const w = window as any;
    const NativeWS = window.WebSocket;
    const state = { sockets: [] as string[], current: null as any, autoReady: true };
    w.__termRecovery = state;

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
        state.sockets.push(url);
        state.current = this;
        const shouldReady = state.autoReady;
        setTimeout(() => {
          if (!shouldReady || typeof this.onmessage !== 'function') return;
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
        ws.onclose(new CloseEvent('close', { code: 1013, reason: 'too many connections for terminal', wasClean: false }));
      }
    };
    state.fireClose = (code: number, reason: string) => {
      const ws = state.current;
      if (!ws) throw new Error('no terminal socket to close');
      if (typeof ws.onclose === 'function') ws.onclose(new CloseEvent('close', { code, reason, wasClean: true }));
    };
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
  await expect(page.locator('.term-header-label')).toHaveText(
    lang === 'ar' ? 'متصل' : 'connected', { timeout: 25_000 },
  );
}

async function countLiveMutations(page: Page): Promise<number> {
  await page.evaluate(() => {
    const w = window as any;
    const live = document.querySelector('.term-header-live');
    if (!live) throw new Error('term header live region missing');
    w.__termLiveMutations = 0;
    const observer = new MutationObserver((records) => {
      for (const r of records) for (const node of r.addedNodes) {
        if (node.nodeType === 1 && (node as Element).classList?.contains('term-close-notice')) w.__termLiveMutations++;
      }
    });
    observer.observe(live, { childList: true });
    w.__termLiveObserver = observer;
  });
  await page.evaluate(() => (window as any).__termRecovery.fireRoomLimit());
  await expect(page.locator('.term-close-notice')).toBeVisible({ timeout: 10_000 });
  const count = await page.evaluate(() => {
    const w = window as any;
    w.__termLiveObserver.disconnect();
    return w.__termLiveMutations as number;
  });
  return count;
}

test('code 1013 shows the local room-limit notice without raw close details and never retries', async ({ page }) => {
  await openTerminal(page);
  const live = page.locator('.term-header-live[role="status"][aria-live="polite"]');
  await expect(live).toHaveCount(1);

  await page.evaluate(() => (window as any).__termRecovery.fireRoomLimit());

  await expect(page.locator('.term-header-label')).toHaveText('error', { timeout: 10_000 });
  await expect(page.locator('.term-close-notice')).toHaveText(ROOM_LIMIT);
  await expect(live).toContainText(ROOM_LIMIT);

  const visible = await page.evaluate(() => document.body.innerText);
  expect(visible).not.toContain('1013');
  expect(visible).not.toMatch(/too many connections for terminal/i);
  expect(visible).not.toMatch(/ws:\/\/|wss:\/\/|\/ws\/projects|token=/i);

  await page.waitForTimeout(6000);
  await expect(page.locator('.term-header-label')).toHaveText('error');
  await expect(page.locator('.term-close-notice')).toHaveText(ROOM_LIMIT);
  const sockets = await page.evaluate(() => (window as any).__termRecovery.sockets.length as number);
  expect(sockets).toBe(1);
});

test('Arabic UI shows the translated room-limit notice', async ({ page }) => {
  await openTerminal(page, 'ar');
  await page.evaluate(() => (window as any).__termRecovery.fireRoomLimit());
  await expect(page.locator('.term-header-label')).toHaveText('خطأ', { timeout: 10_000 });
  await expect(page.locator('.term-close-notice')).toHaveText(ROOM_LIMIT_AR);
  await expect(page.locator('.term-header-live')).toContainText(ROOM_LIMIT_AR);
});

test('error and close together produce a single live-region mutation', async ({ page }) => {
  await openTerminal(page);
  expect(await countLiveMutations(page)).toBe(1);
});

test('switching terminal mode clears the stale notice and work path', async ({ page }) => {
  await openTerminal(page);
  await expect(page.locator('.term-header-path')).toBeVisible();
  await page.evaluate(() => (window as any).__termRecovery.fireRoomLimit());
  await expect(page.locator('.term-close-notice')).toHaveText(ROOM_LIMIT);
  expect(await page.locator('.term-header-path').count()).toBe(1);

  await page.evaluate(() => { (window as any).__termRecovery.autoReady = false; });
  await page.locator('.term-mode-btn', { hasText: 'Control' }).click();

  await expect(page.locator('.term-header-label')).toHaveText('connecting…', { timeout: 10_000 });
  await expect(page.locator('.term-close-notice')).toHaveCount(0);
  await expect(page.locator('.term-header-path')).toHaveCount(0);
});

test('exited status dot is visually distinct from every other status', async ({ page }) => {
  await openTerminal(page);
  await page.evaluate(() => (window as any).__termRecovery.fireClose(4000, ''));
  await expect(page.locator('.term-header-label')).toHaveText('exited', { timeout: 10_000 });

  const styles = await page.evaluate(() => {
    const capture = (element: Element) => {
      const style = getComputedStyle(element);
      return [style.backgroundColor, style.borderTopWidth, style.boxShadow, style.boxSizing].join('|');
    };
    const real = document.querySelector('.term-status-dot.exited');
    if (!real) throw new Error('exited status dot missing');
    const out: Record<string, string> = { exited: capture(real) };
    for (const variant of ['ready', 'connecting', 'closed', 'read-only', 'error']) {
      const probe = document.createElement('span');
      probe.className = `term-status-dot ${variant}`;
      probe.style.position = 'absolute';
      probe.style.left = '-9999px';
      document.body.appendChild(probe);
      out[variant] = capture(probe);
      probe.remove();
    }
    return out;
  });

  for (const variant of ['ready', 'connecting', 'closed', 'read-only', 'error']) {
    expect(styles[variant]).not.toBe(styles.exited);
  }
});
