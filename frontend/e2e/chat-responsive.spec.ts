import { expect, test, type APIRequestContext, type Page, type Response } from '@playwright/test';
import { BASE, injectAuth, sessionToken } from './helpers';

type ChatRole = 'admin' | 'editor' | 'viewer';

interface ChatUser {
  id: string;
  username: string;
  role: ChatRole;
}

interface ChatChannel {
  id: string;
  name: string;
  kind: string;
}

interface ChatAttachment {
  id: string;
  name: string;
  kind: string;
  size: number;
}

interface ChatMessage {
  id: string;
  channelId: string;
  text: string;
  userId: string;
  attachments?: ChatAttachment[];
  replyTo?: string;
}

interface SeedData {
  stamp: string;
  channelIds: string[];
  needle: string;
  replyNeedle: string;
  attachmentName: string;
}

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const createdSeeds: SeedData[] = [];

let authToken = '';
let authHeaders: Record<string, string> = {};

type RequestFetchOptions = NonNullable<Parameters<APIRequestContext['fetch']>[1]>;
type RequestMultipart = NonNullable<RequestFetchOptions['multipart']>;

interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T;
}

const E2E_TIMEOUT_MS = 180_000;
const MAX_RATE_RETRIES = 2;
const MAX_RATE_WAIT_MS = 65_000;

function retryDelayMs(retryAfter: string | undefined): number {
  const seconds = Number(retryAfter ?? '1');
  if (!Number.isFinite(seconds) || seconds <= 0) return 1_000;
  return Math.min(seconds * 1_000, MAX_RATE_WAIT_MS);
}

async function apiCall<T>(
  request: APIRequestContext,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  options: { body?: unknown; multipart?: RequestMultipart } = {},
): Promise<ApiResult<T>> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await request.fetch(`${BASE}${path}`, {
      method,
      headers: authHeaders,
      ...(options.body !== undefined ? { data: options.body } : {}),
      ...(options.multipart !== undefined ? { multipart: options.multipart } : {}),
    });
    if (response.status() === 429 && attempt < MAX_RATE_RETRIES) {
      const waitMs = retryDelayMs(response.headers()['retry-after']);
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      continue;
    }
    const text = await response.text();
    let data: T;
    try {
      data = (text ? JSON.parse(text) : {}) as T;
    } catch {
      data = {} as T;
    }
    return { ok: response.ok(), status: response.status(), data };
  }
}

async function navigateWithRateRetry(
  page: Page,
  navigate: (attempt: number) => Promise<unknown>,
  label: string,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    let resolveRateLimit: ((waitMs: number) => void) | null = null;
    const rateLimited = new Promise<number>((resolve) => {
      resolveRateLimit = resolve;
    });
    const onResponse = (response: Response) => {
      if (response.status() !== 429 || !resolveRateLimit) return;
      resolveRateLimit(retryDelayMs(response.headers()['retry-after']));
      resolveRateLimit = null;
    };
    page.on('response', onResponse);
    try {
      await navigate(attempt);
      const settled = await Promise.race([
        page.locator('.tchat-rail').waitFor({ state: 'visible', timeout: 30_000 }).then(() => 'ready' as const),
        rateLimited.then((waitMs) => ({ waitMs } as const)),
      ]);
      if (settled === 'ready') return;
      if (attempt >= MAX_RATE_RETRIES) {
        throw new Error(`${label} remained rate-limited after ${MAX_RATE_RETRIES} retries`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, settled.waitMs));
    } finally {
      page.off('response', onResponse);
    }
  }
}

interface CreateChannelResponse {
  channel?: ChatChannel;
  error?: string;
}

interface CreateMessageResponse {
  message?: ChatMessage;
  error?: string;
}

interface UploadResponse {
  attachment?: ChatAttachment;
  error?: string;
}

interface DeleteResponse {
  ok?: boolean;
  error?: string;
}

async function getFirstUser(request: APIRequestContext): Promise<ChatUser> {
  const result = await apiCall<ChatUser[]>(request, 'GET', '/api/users');
  expect(result.ok, `GET /api/users failed: ${result.status}`).toBeTruthy();
  expect(result.data.length).toBeGreaterThan(0);
  return result.data[0];
}

async function seedChatData(request: APIRequestContext): Promise<SeedData> {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const needle = `chat-responsive-needle-${stamp}`;
  const replyNeedle = `chat-responsive-reply-${stamp}`;
  const mainName = `e2e-chat-responsive-${stamp}`;
  const secondName = `e2e-chat-responsive-b-${stamp}`;
  const seed: SeedData = { stamp, channelIds: [], needle, replyNeedle, attachmentName: `pixel-${stamp}.png` };
  createdSeeds.push(seed);

  const main = await apiCall<CreateChannelResponse>(request, 'POST', '/api/chat-team/channels', {
    body: { name: mainName, kind: 'manual' },
  });
  expect(main.ok, `channel create failed: ${JSON.stringify(main.data)}`).toBeTruthy();
  expect(main.data.channel?.id).toBeTruthy();
  const mainId = main.data.channel?.id ?? '';
  seed.channelIds.push(mainId);

  const second = await apiCall<CreateChannelResponse>(request, 'POST', '/api/chat-team/channels', {
    body: { name: secondName, kind: 'manual' },
  });
  expect(second.ok, `second channel create failed: ${JSON.stringify(second.data)}`).toBeTruthy();
  expect(second.data.channel?.id).toBeTruthy();
  const secondId = second.data.channel?.id ?? '';
  seed.channelIds.push(secondId);

  const user = await getFirstUser(request);
  const start = await apiCall<CreateMessageResponse>(request, 'POST', '/api/chat-team/messages', {
    body: { channelId: mainId, text: needle, userId: user.id },
  });
  expect(start.ok, `needle message failed: ${JSON.stringify(start.data)}`).toBeTruthy();
  expect(start.data.message?.id).toBeTruthy();
  const needleId = start.data.message?.id ?? '';

  const reply = await apiCall<CreateMessageResponse>(request, 'POST', '/api/chat-team/messages', {
    body: { channelId: mainId, text: replyNeedle, userId: user.id, replyTo: needleId },
  });
  expect(reply.ok, `reply message failed: ${JSON.stringify(reply.data)}`).toBeTruthy();
  expect(reply.data.message?.id).toBeTruthy();

  const upload = await apiCall<UploadResponse>(request, 'POST', '/api/chat-team/upload', {
    multipart: {
      channelId: mainId,
      file: {
        name: seed.attachmentName,
        mimeType: 'image/png',
        buffer: Buffer.from(PNG_BASE64, 'base64'),
      },
    },
  });
  expect(upload.ok, `attachment upload failed: ${JSON.stringify(upload.data)}`).toBeTruthy();
  expect(upload.data.attachment?.id).toBeTruthy();
  const attached = await apiCall<CreateMessageResponse>(request, 'POST', '/api/chat-team/messages', {
    body: {
      channelId: mainId,
      text: `attachment-${stamp}`,
      userId: user.id,
      attachments: [
        { id: upload.data.attachment?.id ?? '', name: seed.attachmentName },
      ],
    },
  });
  expect(attached.ok, `attachment message failed: ${JSON.stringify(attached.data)}`).toBeTruthy();

  return seed;
}

async function cleanupSeed(request: APIRequestContext, seed: SeedData): Promise<void> {
  for (const channelId of seed.channelIds) {
    const result = await apiCall<DeleteResponse>(request, 'DELETE', `/api/chat-team/channels/${channelId}`);
    expect([200, 404], `DELETE /api/chat-team/channels/${channelId} failed: ${result.status}`).toContain(
      result.status,
    );
  }
}

async function cleanupAll(request: APIRequestContext): Promise<void> {
  while (createdSeeds.length > 0) {
    const seed = createdSeeds.pop();
    if (seed) await cleanupSeed(request, seed);
  }
}

async function openSeededChat(page: Page, seed: SeedData): Promise<void> {
  await page.addInitScript((activeId) => {
    localStorage.setItem('wsd.chat.active', activeId);
  }, seed.channelIds[0]);
  await navigateWithRateRetry(
    page,
    (attempt) => page.goto(attempt === 0 ? '/#/chat' : `/?e2eRateRetry=${attempt}#/chat`),
    'Chat navigation',
  );
}

async function reloadWithRateRetry(page: Page): Promise<void> {
  await navigateWithRateRetry(page, () => page.reload(), 'Chat reload');
}

async function selectSeededChannel(page: Page, seed: SeedData): Promise<void> {
  const viewportWidth = page.viewportSize()?.width ?? 1440;
  if (viewportWidth < 640) {
    const rail = page.locator('.tchat-rail');
    if (!(await rail.evaluate((element) => element.classList.contains('open')))) {
      await page.getByRole('button', { name: 'Toggle channel list' }).click();
      await expect(rail).toHaveClass(/open/);
    }
  }
  const row = page.locator(`.tchat-channel-row:has-text("e2e-chat-responsive-${seed.stamp}")`).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  await expect(page.locator('.tchat-textarea')).toBeVisible({ timeout: 20_000 });
}

async function waitForSeededMessage(page: Page, needle: string): Promise<void> {
  await expect(page.locator('.tchat-msg').filter({ hasText: needle }).first()).toBeVisible({
    timeout: 20_000,
  });
}

async function startReplyToSeededMessage(page: Page, needle: string): Promise<void> {
  const message = page.locator('.tchat-msg').filter({ hasText: needle }).first();
  await expect(message).toBeVisible();
  await message.getByRole('button', { name: 'Message options' }).click();
  await page.getByRole('menuitem', { name: 'Reply' }).click();
  await expect(page.locator('.tchat-composer-reply')).toBeVisible({ timeout: 20_000 });
}

async function openRailOnPhone(page: Page): Promise<void> {
  const viewportWidth = page.viewportSize()?.width ?? 1440;
  if (viewportWidth >= 640) return;
  const rail = page.locator('.tchat-rail');
  if (!(await rail.evaluate((element) => element.classList.contains('open')))) {
    await page.getByRole('button', { name: 'Toggle channel list' }).click();
    await expect(rail).toHaveClass(/open/);
  }
}

async function closePhoneDrawerByBackdrop(page: Page): Promise<void> {
  const backdrop = page.locator('.tchat-backdrop.open');
  await expect(backdrop).toBeVisible();
  await backdrop.click({ position: { x: 340, y: 300 } });
  await expect(page.locator('.tchat-rail')).not.toHaveClass(/open/);
}

async function performSearch(page: Page, needle: string): Promise<void> {
  const toggle = page.getByRole('button', { name: 'Search messages in this channel' });
  await toggle.click();
  const input = page.getByRole('textbox', { name: 'Search messages' });
  await expect(input).toBeVisible({ timeout: 20_000 });
  await input.fill(needle);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.locator('.tchat-search-result').first()).toBeVisible({ timeout: 20_000 });
}

async function openImageLightbox(page: Page, seed: SeedData): Promise<void> {
  const imageButton = page
    .locator('.tchat-msg')
    .filter({ hasText: `attachment-${seed.stamp}` })
    .locator('.tchat-img-btn')
    .first();
  await expect(imageButton).toBeVisible({ timeout: 20_000 });
  await imageButton.click();
  await expect(page.locator('.lightbox-overlay')).toBeVisible({ timeout: 20_000 });
}

async function closeImageLightbox(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await expect(page.locator('.lightbox-overlay')).toHaveCount(0);
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const sizes = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(sizes.scrollWidth).toBe(sizes.clientWidth);
}

async function assertCoarsePointer(page: Page, expected: boolean): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => window.matchMedia('(hover: none) and (pointer: coarse)').matches),
    )
    .toBe(expected);
}

interface Rect {
  x: number;
  width: number;
  height: number;
}

async function expectMinSize(locator: ReturnType<Page['locator']>, width: number, height: number): Promise<void> {
  const box = await locator.boundingBox();
  expect(box, 'expected a visible bounding box').not.toBeNull();
  expect(box?.width ?? 0).toBeGreaterThanOrEqual(width);
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(height);
}

async function railRect(page: Page): Promise<Rect> {
  const box = await page.locator('.tchat-rail').boundingBox();
  expect(box, 'expected rail bounding box').not.toBeNull();
  return { x: box?.x ?? 0, width: box?.width ?? 0, height: box?.height ?? 0 };
}

let requestContext: APIRequestContext;
let seed: SeedData;

test.beforeEach(async () => {
  test.setTimeout(E2E_TIMEOUT_MS);
});

test.beforeAll(async ({ playwright }) => {
  test.setTimeout(E2E_TIMEOUT_MS);
  authToken = sessionToken();
  authHeaders = { Authorization: `Bearer ${authToken}` };
  requestContext = await playwright.request.newContext({ baseURL: BASE, extraHTTPHeaders: authHeaders });
  seed = await seedChatData(requestContext);
});

test.afterAll(async () => {
  test.setTimeout(E2E_TIMEOUT_MS);
  if (requestContext) await cleanupAll(requestContext);
  if (requestContext) await requestContext.dispose();
});

test.describe('team chat responsive + touch @360', () => {
  test.use({ viewport: { width: 360, height: 640 }, isMobile: true, hasTouch: true });
  test.beforeEach(async ({ page }) => {
    await injectAuth(page);
    await openSeededChat(page, seed);
    await selectSeededChannel(page, seed);
    await waitForSeededMessage(page, seed.needle);
  });

  test('starts off-screen and opens the channel drawer with a scrim', async ({ page }) => {
    await assertCoarsePointer(page, true);
    await expect(page.locator('.tchat-conn-open').first()).toBeVisible();
    await expect
      .poll(async () => {
        const closed = await railRect(page);
        return closed.x + closed.width;
      })
      .toBeLessThanOrEqual(1);

    await page.getByRole('button', { name: 'Toggle channel list' }).click();
    await expect(page.locator('.tchat-rail')).toHaveClass(/open/);
    await expect(page.locator('.tchat-backdrop')).toHaveClass(/open/);
    const backdropColor = await page
      .locator('.tchat-backdrop')
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(backdropColor).toBe('rgba(0, 0, 0, 0.58)');
    await expect
      .poll(async () => Math.abs((await railRect(page)).x))
      .toBeLessThanOrEqual(1);

    await closePhoneDrawerByBackdrop(page);
    await page.getByRole('button', { name: 'Toggle channel list' }).click();
    await expect(page.locator('.tchat-rail')).toHaveClass(/open/);
    const row = page.locator(`.tchat-channel-row:has-text("e2e-chat-responsive-${seed.stamp}")`).first();
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.locator('.tchat-rail')).not.toHaveClass(/open/);
    await expect(page.locator('.tchat-textarea')).toBeVisible();
  });

  test('keeps touch controls at 44px and shows a search hit', async ({ page }) => {
    await openRailOnPhone(page);
    const row = page.locator('.tchat-channel-row').filter({ hasText: `e2e-chat-responsive-${seed.stamp}` }).first();
    await expect(row).toBeVisible();
    await expectMinSize(row, 0, 56);
    await expectMinSize(page.locator('.tchat-channel-filter'), 0, 36);
    await expectMinSize(page.getByRole('button', { name: 'Toggle channel list' }), 44, 44);
    if (await page.locator('.tchat-rail').evaluate((element) => element.classList.contains('open'))) {
      await page.keyboard.press('Escape');
      await expect(page.locator('.tchat-rail')).not.toHaveClass(/open/);
    }

    await startReplyToSeededMessage(page, seed.needle);
    const seededMessage = page.locator('.tchat-msg').filter({ hasText: seed.needle }).first();
    await expectMinSize(seededMessage.locator('.tchat-msg-action'), 44, 44);
    await expectMinSize(page.locator('.tchat-composer-reply'), 0, 34);
    await expectMinSize(page.locator('.tchat-send-fab'), 46, 46);

    const textarea = page.locator('.tchat-textarea');
    await expect(textarea).toHaveCSS('font-size', '16px');
    await expectMinSize(textarea, 0, 40);
    await textarea.fill('x'.repeat(4900));
    await expect(page.locator('.tchat-char-counter')).toHaveText('4900/5000');

    await performSearch(page, seed.needle);
    const result = page.locator('.tchat-search-result').filter({ hasText: seed.needle }).first();
    await expect(result).toBeVisible();
    await expectMinSize(result, 0, 44);
    await expect(result.locator('mark.tchat-search-hit')).toHaveText(seed.needle);
  });

  test('opens a touch-sized image lightbox and keeps the page width contained', async ({ page }) => {
    await openImageLightbox(page, seed);
    const overlay = page.locator('.lightbox-overlay');
    await expect(overlay).toHaveCSS('position', 'fixed');
    await expect(overlay).toHaveCSS('z-index', '220');
    await expect(overlay).toHaveCSS('background-color', 'rgba(0, 0, 0, 0.88)');
    await expectMinSize(page.getByRole('button', { name: 'Close preview' }), 44, 44);
    await closeImageLightbox(page);
    await expectNoHorizontalOverflow(page);
  });
});

test.describe('team chat responsive + touch @768', () => {
  test.use({ viewport: { width: 768, height: 1024 }, isMobile: true, hasTouch: true });
  test.beforeEach(async ({ page }) => {
    await injectAuth(page);
    await openSeededChat(page, seed);
    await selectSeededChannel(page, seed);
    await waitForSeededMessage(page, seed.needle);
  });

  test('pins the rail open and collapses it on touch', async ({ page }) => {
    await assertCoarsePointer(page, true);
    await expect(page.locator('.tchat-conn-open').first()).toBeVisible();
    await page.evaluate(() => localStorage.setItem('wsd.chat.railCollapsed', '0'));
    await reloadWithRateRetry(page);
    await expect(page.locator('.tchat-rail')).toBeVisible({ timeout: 30_000 });

    const initial = await railRect(page);
    expect(initial.x).toBeGreaterThanOrEqual(-1);
    expect(initial.x).toBeLessThanOrEqual(1);
    expect(initial.width).toBeGreaterThanOrEqual(300);
    expect(initial.width).toBeLessThanOrEqual(320);

    await page.locator('.tchat-rail').evaluate((element) => {
      element.style.transition = 'none';
    });
    const collapse = page.locator('.tchat-collapse-btn');
    await expect(collapse).toBeVisible();
    await expectMinSize(collapse, 24, 24);
    await collapse.click();
    await expect(page.locator('.tchat-rail')).toHaveClass(/collapsed/);
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('wsd.chat.railCollapsed')))
      .toBe('1');
    await expect
      .poll(async () => (await railRect(page)).x + (await railRect(page)).width)
      .toBeLessThanOrEqual(1);

    await reloadWithRateRetry(page);
    await expect(page.locator('.tchat-rail')).toHaveClass(/collapsed/);
    await page.locator('.tchat-rail').evaluate((element) => {
      element.style.transition = 'none';
    });
    const burger = page.getByRole('button', { name: 'Toggle channel list' });
    await burger.click();
    await expect(page.locator('.tchat-rail')).not.toHaveClass(/collapsed/);
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('wsd.chat.railCollapsed')))
      .toBe('0');
    await expect.poll(async () => (await railRect(page)).x).toBeLessThanOrEqual(1);
    await page.locator('.tchat-rail').evaluate((element) => {
      element.style.removeProperty('transition');
    });

    await reloadWithRateRetry(page);
    await expect(page.locator('.tchat-rail')).not.toHaveClass(/collapsed/);
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('wsd.chat.railCollapsed')))
      .toBe('0');
  });

  test('keeps touch-sized controls, search results and lightbox close', async ({ page }) => {
    await expectMinSize(page.locator('.tchat-channel-filter'), 0, 36);
    await expectMinSize(page.locator('.tchat-channel-row').first(), 0, 56);
    await startReplyToSeededMessage(page, seed.needle);
    const seededMessage = page.locator('.tchat-msg').filter({ hasText: seed.needle }).first();
    await expectMinSize(seededMessage.locator('.tchat-msg-action'), 44, 44);
    await expectMinSize(page.locator('.tchat-composer-reply'), 0, 34);
    await expectMinSize(page.locator('.tchat-send-fab'), 46, 46);
    const textarea = page.locator('.tchat-textarea');
    await expect(textarea).toHaveCSS('font-size', '16px');

    await performSearch(page, seed.needle);
    const result = page.locator('.tchat-search-result').filter({ hasText: seed.needle }).first();
    await expectMinSize(result, 0, 44);

    await openImageLightbox(page, seed);
    await expectMinSize(page.getByRole('button', { name: 'Close preview' }), 44, 44);
    await closeImageLightbox(page);
    await expectNoHorizontalOverflow(page);
  });
});

test.describe('team chat responsive @1440 fine pointer', () => {
  test.use({ viewport: { width: 1440, height: 900 }, isMobile: false, hasTouch: false });
  test.beforeEach(async ({ page }) => {
    await injectAuth(page);
    await openSeededChat(page, seed);
    await selectSeededChannel(page, seed);
    await waitForSeededMessage(page, seed.needle);
  });

  test('uses the desktop rail and fine-pointer control sizes', async ({ page }) => {
    await assertCoarsePointer(page, false);
    const rail = await page.locator('.tchat-rail').evaluate((element) => ({
      position: getComputedStyle(element).position,
      width: getComputedStyle(element).width,
    }));
    expect(rail.position).toBe('static');
    expect(rail.width).toBe('300px');
    await expect(page.locator('.tchat-burger')).toBeHidden();

    await performSearch(page, seed.needle);
    const result = page.locator('.tchat-search-result').filter({ hasText: seed.needle }).first();
    await expectMinSize(result, 0, 34);
    const send = page.locator('.tchat-send-fab');
    const sendBox = await send.boundingBox();
    expect(sendBox, 'expected send button bounding box').not.toBeNull();
    expect(sendBox?.width).toBe(42);
    expect(sendBox?.height).toBe(42);

    await openImageLightbox(page, seed);
    const closeBox = await page.getByRole('button', { name: 'Close preview' }).boundingBox();
    expect(closeBox, 'expected lightbox close bounding box').not.toBeNull();
    expect(closeBox?.width).toBe(40);
    expect(closeBox?.height).toBe(40);
    await closeImageLightbox(page);
    await expectNoHorizontalOverflow(page);
  });
});
