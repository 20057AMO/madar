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

interface ChatWsFrame {
  type?: string;
  channelId?: string;
  channel?: { id?: string };
  message?: { id?: string; text?: string };
}

interface ChatFrameCapture {
  frames: ChatWsFrame[];
  waitForMessage(channelId: string, messageId: string): Promise<ChatWsFrame>;
  waitForSubscribed(channelId: string): Promise<ChatWsFrame>;
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
const MAX_NAV_CONTEXT_RETRIES = 3;
const MAX_RAIL_OPEN_RETRIES = 3;
const CHAT_FRAME_TIMEOUT_MS = 20_000;

test.use({
  launchOptions: {
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  },
});

const chatFrameCaptures = new WeakMap<Page, ChatFrameCapture>();

function installChatFrameCapture(page: Page): ChatFrameCapture {
  const frames: ChatWsFrame[] = [];
  page.on('websocket', (socket) => {
    socket.on('framereceived', (event) => {
      const raw = typeof event.payload === 'string' ? event.payload : event.payload.toString();
      try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') frames.push(parsed as ChatWsFrame);
      } catch {
        // Ignore control frames and non-JSON payloads.
      }
    });
  });

  const waitForFrame = async (
    predicate: (frame: ChatWsFrame) => boolean,
    label: string,
  ): Promise<ChatWsFrame> => {
    await expect.poll(() => frames.find(predicate), { timeout: CHAT_FRAME_TIMEOUT_MS, message: label }).toBeTruthy();
    const found = frames.find(predicate);
    if (!found) throw new Error(label);
    return found;
  };

  const capture: ChatFrameCapture = {
    frames,
    waitForMessage: (channelId, messageId) =>
      waitForFrame(
        (frame) => frame.type === 'message' && frame.channel?.id === channelId && frame.message?.id === messageId,
        `Expected WS message frame for ${messageId} in ${channelId}`,
      ),
    waitForSubscribed: (channelId) =>
      waitForFrame(
        (frame) => frame.type === 'subscribed' && frame.channelId === channelId,
        `Expected WS subscribed frame for ${channelId}`,
      ),
  };
  chatFrameCaptures.set(page, capture);
  return capture;
}

function chatFrameCapture(page: Page): ChatFrameCapture {
  return chatFrameCaptures.get(page) ?? installChatFrameCapture(page);
}

async function waitForMessageResponse(page: Page, text: string): Promise<Response> {
  return page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/api\/chat-team\/messages(?:\?|$)/.test(response.url()) &&
      (response.request().postData() ?? '').includes(text),
    { timeout: CHAT_FRAME_TIMEOUT_MS },
  );
}

async function waitForChannelMessageResponse(page: Page, channelId: string): Promise<Response> {
  return page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' &&
      /\/api\/chat-team\/messages(?:\?|$)/.test(response.url()) &&
      (response.request().postData() ?? '').includes(`"channelId":"${channelId}"`),
    { timeout: CHAT_FRAME_TIMEOUT_MS },
  );
}

async function waitForUploadResponse(page: Page): Promise<Response> {
  return page.waitForResponse(
    (response) =>
      response.request().method() === 'POST' && /\/api\/chat-team\/upload(?:\?|$)/.test(response.url()),
    { timeout: CHAT_FRAME_TIMEOUT_MS },
  );
}

async function expectMessageCreated(response: Response): Promise<ChatMessage> {
  expect(response.status(), `POST /api/chat-team/messages failed: ${response.status()}`).toBe(201);
  const body = (await response.json()) as CreateMessageResponse;
  expect(body.message?.id, 'message response must carry an id').toBeTruthy();
  return body.message as ChatMessage;
}

async function waitForRetryAfter(response: Response): Promise<void> {
  const waitMs = retryDelayMs(response.headers()['retry-after']);
  const deadline = Date.now() + waitMs;
  await expect
    .poll(() => Date.now() >= deadline, {
      timeout: waitMs + 5_000,
      message: `Waiting ${waitMs}ms from Retry-After`,
    })
    .toBe(true);
}

async function recordAndSendVoiceNote(
  page: Page,
  channelId: string,
): Promise<{ attachment: ChatAttachment; message: ChatMessage }> {
  for (let attempt = 0; ; attempt += 1) {
    const uploadPromise = waitForUploadResponse(page);
    const messagePromise = waitForChannelMessageResponse(page, channelId);
    void messagePromise.catch(() => {});

    const mic = page.getByRole('button', { name: 'Record a voice note' });
    await expect(mic).toBeEnabled();
    await mic.click();
    await expect(page.locator('.tchat-recording-time')).toHaveText('0:01');
    await page.getByRole('button', { name: 'Stop and send' }).click();

    const uploadResponse = await uploadPromise;
    if (uploadResponse.status() === 429 && attempt < MAX_RATE_RETRIES) {
      await waitForRetryAfter(uploadResponse);
      continue;
    }

    expect(uploadResponse.status(), `POST /api/chat-team/upload failed: ${uploadResponse.status()}`).toBe(201);
    const uploaded = (await uploadResponse.json()) as UploadResponse;
    expect(uploaded.attachment?.id, 'upload response must carry an attachment id').toBeTruthy();
    const message = await expectMessageCreated(await messagePromise);
    return { attachment: uploaded.attachment as ChatAttachment, message };
  }
}

async function capturedTextSend(
  page: Page,
  channelId: string,
  text: string,
  send: () => Promise<void>,
): Promise<{ message: ChatMessage; frame: ChatWsFrame }> {
  const responsePromise = waitForMessageResponse(page, text);
  await send();
  const message = await expectMessageCreated(await responsePromise);
  const frame = await chatFrameCapture(page).waitForMessage(channelId, message.id);
  return { message, frame };
}

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
  installChatFrameCapture(page);
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

function isNavigationContextLoss(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Execution context was destroyed|frame was detached/i.test(message);
}

function isRailInteractionRetryable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    isNavigationContextLoss(error) || /element was detached|navigation to finish|navigated to/i.test(message)
  );
}

async function waitForChatShellReady(page: Page): Promise<void> {
  await expect(page).toHaveURL(/#\/chat$/);
  await expect
    .poll(() => page.evaluate(() => document.readyState), {
      timeout: 20_000,
      message: 'chat document reached readyState complete',
    })
    .toBe('complete');
  await expect(page.locator('.tchat-textarea')).toBeVisible({ timeout: 20_000 });
}

async function railHasOpenClass(page: Page): Promise<boolean> {
  const rail = page.locator('.tchat-rail');
  for (let attempt = 0; ; attempt += 1) {
    try {
      await expect(rail).toBeVisible({ timeout: 20_000 });
      const className = (await rail.getAttribute('class', { timeout: 20_000 })) ?? '';
      return className.split(/\s+/).includes('open');
    } catch (error) {
      if (!isNavigationContextLoss(error) || attempt >= MAX_NAV_CONTEXT_RETRIES) throw error;
    }
  }
}

async function openPhoneRail(page: Page): Promise<void> {
  const rail = page.locator('.tchat-rail');
  const toggle = page.getByRole('button', { name: 'Toggle channel list' });
  await waitForChatShellReady(page);
  for (let attempt = 0; ; attempt += 1) {
    if (await railHasOpenClass(page)) return;
    try {
      await toggle.click({ timeout: 5_000 });
      await expect(rail).toHaveClass(/open/, { timeout: 5_000 });
      return;
    } catch (error) {
      if (!isRailInteractionRetryable(error) || attempt >= MAX_RAIL_OPEN_RETRIES) throw error;
    }
  }
}

async function selectSeededChannel(page: Page, seed: SeedData): Promise<void> {
  const viewportWidth = page.viewportSize()?.width ?? 1440;
  if (viewportWidth < 640) {
    await openPhoneRail(page);
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
  await openPhoneRail(page);
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

async function expectMinSize(locator: ReturnType<Page['locator']>, minWidth: number, minHeight: number): Promise<void> {
  const box = await locator.boundingBox();
  expect(box, 'expected a visible bounding box').not.toBeNull();
  expect(Math.round((box?.width ?? 0) * 100) / 100, `expected width >= ${minWidth}`).toBeGreaterThanOrEqual(minWidth);
  expect(Math.round((box?.height ?? 0) * 100) / 100, `expected height >= ${minHeight}`).toBeGreaterThanOrEqual(minHeight);
}

async function railRect(page: Page): Promise<Rect> {
  const box = await page.locator('.tchat-rail').boundingBox();
  expect(box, 'expected rail bounding box').not.toBeNull();
  return { x: box?.x ?? 0, width: box?.width ?? 0, height: box?.height ?? 0 };
}

async function expectRailOffCanvas(page: Page, offCanvas: boolean): Promise<void> {
  await expect
    .poll(() =>
      page.locator('.tchat-rail').evaluate((element) => ({
        inert: element.hasAttribute('inert'),
        ariaHidden: element.getAttribute('aria-hidden'),
      })),
    )
    .toEqual({ inert: offCanvas, ariaHidden: offCanvas ? 'true' : null });
}

async function expectUniqueSearchLabel(page: Page, needle: string): Promise<void> {
  const result = page.locator('.tchat-search-result').filter({ hasText: needle }).first();
  await expect(result).toBeVisible();
  const username = (await result.locator('span.dim').textContent())?.trim() ?? '';
  expect(username.length).toBeGreaterThan(0);
  const label = `Jump to message from ${username}: ${needle}`;
  await expect(result).toHaveAttribute('aria-label', label);
  await expect(page.getByRole('button', { name: label, exact: true })).toHaveCount(1);
  await expect(result.locator('mark.tchat-search-hit')).toHaveText(needle);
}

interface JwtIdentity {
  id?: string;
  username?: string;
}

function signedInIdentity(): JwtIdentity {
  const payload = authToken.split('.')[1] ?? '';
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as JwtIdentity;
}

async function findOtherUser(request: APIRequestContext): Promise<ChatUser | null> {
  const result = await apiCall<ChatUser[]>(request, 'GET', '/api/users');
  expect(result.ok, `GET /api/users failed: ${result.status}`).toBeTruthy();
  const meId = signedInIdentity().id ?? '';
  return result.data.find((user) => user.id && user.id !== meId) ?? null;
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

    await openPhoneRail(page);
    await expect(page.locator('.tchat-backdrop')).toHaveClass(/open/);
    const backdropColor = await page
      .locator('.tchat-backdrop')
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(backdropColor).toBe('rgba(0, 0, 0, 0.58)');
    await expect
      .poll(async () => Math.abs((await railRect(page)).x))
      .toBeLessThanOrEqual(1);

    await closePhoneDrawerByBackdrop(page);
    await openPhoneRail(page);
    const row = page.locator(`.tchat-channel-row:has-text("e2e-chat-responsive-${seed.stamp}")`).first();
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.locator('.tchat-rail')).not.toHaveClass(/open/);
    await expect(page.locator('.tchat-textarea')).toBeVisible();
  });

  test('moves focus into the drawer and restores it on Escape and backdrop close', async ({ page }) => {
    await assertCoarsePointer(page, true);
    const rail = page.locator('.tchat-rail');
    const toggle = page.getByRole('button', { name: 'Toggle channel list' });
    await expectRailOffCanvas(page, true);
    await expect(rail).not.toHaveAttribute('role', 'dialog');
    await toggle.focus();
    await toggle.click();
    await expect(rail).toHaveClass(/open/);
    await expect(rail).toHaveAttribute('role', 'dialog');
    await expect(rail).toHaveAttribute('aria-modal', 'true');
    await expect(rail).toHaveAttribute('aria-label', 'Chat channels');
    await expectRailOffCanvas(page, false);
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.classList.contains('tchat-channel-row')))
      .toBe(true);

    await page.keyboard.press('Escape');
    await expect(rail).not.toHaveClass(/open/);
    await expectRailOffCanvas(page, true);
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label')))
      .toBe('Toggle channel list');

    await toggle.click();
    await expect(rail).toHaveClass(/open/);
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.classList.contains('tchat-channel-row')))
      .toBe(true);
    await closePhoneDrawerByBackdrop(page);
    await expectRailOffCanvas(page, true);
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label')))
      .toBe('Toggle channel list');
  });

  test('keeps touch controls at 44px and shows a search hit', async ({ page }) => {
    await openRailOnPhone(page);
    const row = page.locator('.tchat-channel-row').filter({ hasText: `e2e-chat-responsive-${seed.stamp}` }).first();
    await expect(row).toBeVisible();
    await expectMinSize(row, 0, 56);
    const seededItem = page
      .locator('.tchat-channel-item')
      .filter({ hasText: `e2e-chat-responsive-${seed.stamp}` })
      .first();
    const deleteBtn = seededItem.locator('.tchat-delete-btn');
    await expect(deleteBtn).toBeVisible();
    await expectMinSize(deleteBtn, 44, 44);
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
    await expectMinSize(page.locator('.tchat-pill-btn[aria-label="Emoji"]'), 44, 44);
    await expectMinSize(page.locator('.tchat-send-fab'), 46, 46);

    const textarea = page.locator('.tchat-textarea');
    await expect(textarea).toHaveCSS('font-size', '16px');
    await expectMinSize(textarea, 0, 40);
    await textarea.fill('x'.repeat(4900));
    await expect(page.locator('.tchat-char-counter')).toHaveText('4900/5000');

    await performSearch(page, seed.needle);
    await expectUniqueSearchLabel(page, seed.needle);
    const result = page.locator('.tchat-search-result').filter({ hasText: seed.needle }).first();
    await expectMinSize(result, 0, 44);
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
    await expectRailOffCanvas(page, false);
    await expect(page.locator('.tchat-burger')).toBeHidden();

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
    await expectRailOffCanvas(page, true);
    await expect(page.locator('.tchat-burger')).toBeVisible();
    await expect(page.locator('.tchat-burger')).toBeFocused();

    await reloadWithRateRetry(page);
    await expect(page.locator('.tchat-rail')).toHaveClass(/collapsed/);
    await expectRailOffCanvas(page, true);
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
    await expectRailOffCanvas(page, false);
    await expect(page.locator('.tchat-burger')).toBeHidden();
    await page.locator('.tchat-rail').evaluate((element) => {
      element.style.removeProperty('transition');
    });

    await reloadWithRateRetry(page);
    await expect(page.locator('.tchat-rail')).not.toHaveClass(/collapsed/);
    await expectRailOffCanvas(page, false);
    await expect(page.locator('.tchat-burger')).toBeHidden();
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('wsd.chat.railCollapsed')))
      .toBe('0');
  });

  test('keeps touch-sized controls, search results and lightbox close', async ({ page }) => {
    await assertCoarsePointer(page, true);
    const seededRow = page.locator('.tchat-channel-row').filter({ hasText: `e2e-chat-responsive-${seed.stamp}` }).first();
    await expect(seededRow).toBeVisible();
    const seededItem = page
      .locator('.tchat-channel-item')
      .filter({ hasText: `e2e-chat-responsive-${seed.stamp}` })
      .first();
    const deleteBtn = seededItem.locator('.tchat-delete-btn');
    await expect(deleteBtn).toBeVisible();
    await expectMinSize(deleteBtn, 44, 44);
    await expectMinSize(page.locator('.tchat-channel-filter'), 0, 36);
    await expectMinSize(seededRow, 0, 56);
    await expectMinSize(page.locator('.tchat-pill-btn[aria-label="Emoji"]'), 44, 44);
    await startReplyToSeededMessage(page, seed.needle);
    const seededMessage = page.locator('.tchat-msg').filter({ hasText: seed.needle }).first();
    await expectMinSize(seededMessage.locator('.tchat-msg-action'), 44, 44);
    await expectMinSize(page.locator('.tchat-composer-reply'), 0, 34);
    await expectMinSize(page.locator('.tchat-send-fab'), 46, 46);
    const textarea = page.locator('.tchat-textarea');
    await expect(textarea).toHaveCSS('font-size', '16px');

    await performSearch(page, seed.needle);
    await expectUniqueSearchLabel(page, seed.needle);
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
    await expectRailOffCanvas(page, false);
    await expect(page.locator('.tchat-burger')).toBeHidden();

    await performSearch(page, seed.needle);
    await expectUniqueSearchLabel(page, seed.needle);
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

  test('keeps the desktop rail expanded despite a stale tablet collapse preference', async ({ page }) => {
    await page.evaluate(() => localStorage.setItem('wsd.chat.railCollapsed', '1'));
    await reloadWithRateRetry(page);
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem('wsd.chat.railCollapsed')))
      .toBe('1');

    const rail = page.locator('.tchat-rail');
    await expect(rail).toBeVisible();
    await expect(rail).not.toHaveClass(/collapsed/);
    await expectRailOffCanvas(page, false);
    const collapse = page.locator('.tchat-collapse-btn');
    await expect(collapse).toBeVisible();
    await expect(page.getByRole('button', { name: 'Collapse channel list', exact: true })).toBeVisible();
    await expect(collapse).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.tchat-burger')).toBeHidden();
  });

  test('uses 640px as the last phone width and 641px as the first tablet width', async ({ page }) => {
    const rail = page.locator('.tchat-rail');
    const burger = page.locator('.tchat-burger');
    await page.setViewportSize({ width: 641, height: 900 });
    await page.evaluate(() => localStorage.setItem('wsd.chat.railCollapsed', '0'));
    await reloadWithRateRetry(page);
    await expect(rail).toBeVisible({ timeout: 30_000 });
    await expect(rail).not.toHaveClass(/collapsed/);
    await expect(rail).not.toHaveClass(/open/);

    for (const width of [640, 639]) {
      await page.setViewportSize({ width, height: 900 });
      await expect
        .poll(() => page.evaluate(() => window.matchMedia('(max-width: 640px)').matches))
        .toBe(true);
      await expect
        .poll(() => page.evaluate(() => window.matchMedia('(min-width: 641px)').matches))
        .toBe(false);
      await expect(burger).toBeVisible();
      await expect(rail).not.toHaveClass(/open/);
      await expectRailOffCanvas(page, true);
      await expect.poll(async () => (await railRect(page)).x + (await railRect(page)).width).toBeLessThanOrEqual(1);
    }

    await page.setViewportSize({ width: 641, height: 900 });
    await expect
      .poll(() => page.evaluate(() => window.matchMedia('(max-width: 640px)').matches))
      .toBe(false);
    await expect
      .poll(() => page.evaluate(() => window.matchMedia('(min-width: 641px)').matches))
      .toBe(true);
    await expect(burger).toBeHidden();
    await expectRailOffCanvas(page, false);
    await expect.poll(async () => (await railRect(page)).x).toBeLessThanOrEqual(1);
    await expect.poll(async () => (await railRect(page)).width).toBeGreaterThanOrEqual(300);
  });

  test('marks the search toggle active and restores focus when search closes', async ({ page }) => {
    const toggle = page.getByRole('button', { name: 'Search messages in this channel' });
    const initialBorder = await toggle.evaluate((element) => getComputedStyle(element).borderColor);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(() => toggle.evaluate((element) => getComputedStyle(element).borderColor)).not.toBe(initialBorder);
    await expect(page.getByRole('textbox', { name: 'Search messages' })).toBeVisible();

    await page.getByRole('button', { name: 'Close search' }).click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect.poll(() => toggle.evaluate((element) => getComputedStyle(element).borderColor)).toBe(initialBorder);
    await expect(toggle).toBeFocused();
  });

  test('inserts an emoji at the caret and keeps composer focus', async ({ page }) => {
    const textarea = page.getByRole('textbox', { name: 'Type a message' });
    await textarea.fill('ab');
    await textarea.evaluate((element) => {
      const input = element as HTMLTextAreaElement;
      input.focus();
      input.setSelectionRange(1, 1);
    });

    await page.locator('.tchat-pill-btn[aria-label="Emoji"]').click();
    await expect(page.getByRole('dialog', { name: 'Insert emoji' })).toBeVisible();
    await page.locator('.tchat-emoji-cell[aria-label="😂"]').click();

    await expect
      .poll(() =>
        textarea.evaluate((element) => {
          const input = element as HTMLTextAreaElement;
          return {
            value: input.value,
            start: input.selectionStart,
            end: input.selectionEnd,
            focused: document.activeElement === input,
          };
        }),
      )
      .toEqual({ value: 'a😂b', start: 3, end: 3, focused: true });
  });

  test('caps composer auto-grow at 120px', async ({ page }) => {
    const textarea = page.getByRole('textbox', { name: 'Type a message' });
    await textarea.fill('short');
    const shortHeight = await textarea.evaluate((element) =>
      Math.round((element as HTMLTextAreaElement).getBoundingClientRect().height),
    );
    expect(shortHeight).toBeLessThan(120);

    await textarea.fill(Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n'));
    await expect
      .poll(() =>
        textarea.evaluate((element) => Math.round((element as HTMLTextAreaElement).getBoundingClientRect().height)),
      )
      .toBe(120);
  });

  test('returns focus to the composer after a message is sent', async ({ page }) => {
    const textarea = page.getByRole('textbox', { name: 'Type a message' });
    const text = `composer-focus-${seed.stamp}`;
    await textarea.fill(text);

    await capturedTextSend(page, seed.channelIds[0], text, async () => {
      await textarea.press('Enter');
    });

    await expect(page.locator('.tchat-msg').filter({ hasText: text })).toHaveCount(1);
    await expect(textarea).toHaveValue('');
    await expect.poll(() => textarea.evaluate((element) => document.activeElement === element)).toBe(true);
  });

  test('focuses the composer from the empty-channel call to action', async ({ page }) => {
    const secondRow = page.locator(`.tchat-channel-row:has-text("e2e-chat-responsive-b-${seed.stamp}")`).first();
    await expect(secondRow).toBeVisible();
    await secondRow.click();
    await chatFrameCapture(page).waitForSubscribed(seed.channelIds[1]);

    await expect(page.locator('.tchat-empty-msg')).toBeVisible();
    const cta = page.getByRole('button', { name: 'Write the first message' });
    await expect(cta).toBeVisible();
    await cta.click();

    const textarea = page.getByRole('textbox', { name: 'Type a message' });
    await expect
      .poll(() =>
        textarea.evaluate((element) => ({
          focused: document.activeElement === element,
          visible: !!element.getClientRects().length,
        })),
      )
      .toEqual({ focused: true, visible: true });
  });

  test('does not render a message sent to a channel that was left mid-send', async ({ page }) => {
    const firstChannelId = seed.channelIds[0];
    const secondChannelId = seed.channelIds[1];
    const text = `switch-mid-send-${seed.stamp}`;
    const textarea = page.getByRole('textbox', { name: 'Type a message' });

    let markRequestSeen: () => void = () => {};
    const requestArrived = new Promise<void>((resolve) => {
      markRequestSeen = resolve;
    });
    let releaseSend: () => void = () => {};
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });

    const heldResponse = waitForChannelMessageResponse(page, firstChannelId);
    await page.route('**/api/chat-team/messages', async (route) => {
      if ((route.request().postData() ?? '').includes(text)) {
        markRequestSeen();
        await sendGate;
      }
      await route.continue();
    });

    await textarea.fill(text);
    await textarea.press('Enter');
    await requestArrived;

    const secondRow = page.locator(`.tchat-channel-row:has-text("e2e-chat-responsive-b-${seed.stamp}")`).first();
    await expect(secondRow).toBeVisible();
    await secondRow.click();
    await chatFrameCapture(page).waitForSubscribed(secondChannelId);

    const meId = signedInIdentity().id ?? '';
    expect(meId, 'JWT must carry a user id').toBeTruthy();
    const sentinel = `switch-sentinel-${seed.stamp}`;
    const posted = await apiCall<CreateMessageResponse>(requestContext, 'POST', '/api/chat-team/messages', {
      body: { channelId: secondChannelId, text: sentinel, userId: meId },
    });
    expect(posted.ok, `sentinel message failed: ${JSON.stringify(posted.data)}`).toBeTruthy();
    expect(posted.data.message?.id, 'sentinel message must carry an id').toBeTruthy();
    await expect(page.locator('.tchat-msg').filter({ hasText: sentinel })).toBeVisible();

    releaseSend();
    const held = await heldResponse;
    expect(held.request().postData(), 'the original POST must still target the first channel').toContain(
      `"channelId":"${firstChannelId}"`,
    );
    await expectMessageCreated(held);

    const syncText = `switch-sync-${seed.stamp}`;
    await capturedTextSend(page, secondChannelId, syncText, async () => {
      await textarea.fill(syncText);
      await textarea.press('Enter');
    });
    await expect(page.locator('.tchat-msg').filter({ hasText: syncText })).toHaveCount(1);
    await expect(page.locator('.tchat-msg').filter({ hasText: text })).toHaveCount(0);
    await page.unroute('**/api/chat-team/messages');
  });

  test('dismisses mention suggestions before the reply chip on Escape', async ({ page }) => {
    const other = await findOtherUser(requestContext);
    if (!other) {
      test.skip(true, 'No second user exists; mention suggestions cannot be asserted non-vacuously');
      return;
    }

    await startReplyToSeededMessage(page, seed.needle);
    const textarea = page.getByRole('textbox', { name: 'Type a message' });
    await textarea.fill('@');
    await expect(page.locator('#tchat-mention-list')).toBeVisible();
    await expect(page.locator('#tchat-mention-list')).toContainText(`@${other.username}`);
    await expect(textarea).toHaveAttribute('aria-expanded', 'true');

    await textarea.press('Escape');
    await expect(page.locator('#tchat-mention-list')).toHaveCount(0);
    await expect(textarea).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.tchat-composer-reply')).toBeVisible();

    await textarea.press('Escape');
    await expect(page.locator('.tchat-composer-reply')).toHaveCount(0);
  });
});

test.describe('team chat voice send dedupe @1440', () => {
  test.use({
    viewport: { width: 1440, height: 900 },
    isMobile: false,
    hasTouch: false,
    permissions: ['microphone'],
  });
  test.beforeEach(async ({ page }) => {
    await injectAuth(page);
    await openSeededChat(page, seed);
    await selectSeededChannel(page, seed);
    await waitForSeededMessage(page, seed.needle);
  });

  test('renders a recorded voice note once after the REST and socket echoes', async ({ page }) => {
    const channelId = seed.channelIds[0];
    const baseline = await page.locator('.tchat-msg').count();

    const { attachment, message } = await recordAndSendVoiceNote(page, channelId);
    expect(
      message.attachments?.some((item) => item.id === attachment.id),
      'sent message must reference the uploaded voice note',
    ).toBe(true);
    await chatFrameCapture(page).waitForMessage(channelId, message.id);

    await expect(page.locator('.tchat-msg:has(.vn-player)')).toHaveCount(1);
    await expect(page.locator('.tchat-msg')).toHaveCount(baseline + 1);
  });
});
