import { test, expect } from '@playwright/test';
import jwt from 'jsonwebtoken';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BASE = 'http://localhost:3000';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function readEnvValue(key: string): string | null {
  const envFile = path.join(ROOT, '.env');
  if (!fs.existsSync(envFile)) return null;
  const line = fs.readFileSync(envFile, 'utf8').split(/\r?\n/).find((entry) => entry.trim().startsWith(`${key}=`));
  return line ? line.slice(line.indexOf('=') + 1).trim() : null;
}

test('canvas section creation works with a mouse click and persists', async ({ page }) => {
  const container = process.env.WSD_TEST_CONTAINER || 'wsd-pro';
  const secret = readEnvValue('JWT_SECRET') ||
    execFileSync('docker', ['exec', container, 'cat', '/app/data/jwt.secret'], { encoding: 'utf8' }).trim();
  const users = JSON.parse(execFileSync('docker', ['exec', container, 'cat', '/app/data/users.json'], { encoding: 'utf8' }));
  const user = users.users?.find((entry: { id?: string }) => entry.id);
  if (!user?.id) throw new Error('No existing user is available in the running container');
  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role, tv: user.tokenVersion || 0, jti: 'canvas-e2e' },
    secret,
    { expiresIn: '10m' }
  );
  const slug = `canvas-user-${Date.now().toString(36)}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const created = await fetch(`${BASE}/api/projects`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Canvas User Test', slug }),
  });
  expect(created.status, 'create a temporary project for the UI journey').toBe(201);
  try {
    const seeded = await fetch(`${BASE}/api/projects/${slug}/canvas`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        version: 1,
        nodes: [
          { id: 'loose-note', type: 'note', text: 'Loose note', x: 40, y: 80, w: 220, h: 100, color: 'yellow' },
          { id: 'match-one', type: 'note', text: 'Needle alpha', x: 320, y: 80, w: 220, h: 100, color: 'blue' },
          { id: 'match-two', type: 'note', text: 'Needle beta', x: 600, y: 80, w: 220, h: 100, color: 'green' },
        ],
        edges: [],
      }),
    });
    expect(seeded.status, 'seed one unassigned note').toBe(200);

    await page.addInitScript((value) => {
      localStorage.setItem('wsd.token', value);
      localStorage.setItem('wsd.lang', 'en');
    }, token);
    await page.goto(`${BASE}/#/project/${slug}?tab=canvas`);

    await page.getByRole('heading', { name: /Planning canvas/ }).waitFor({ state: 'visible' });
    const sections = page.getByRole('group', { name: 'Board sections' });
    await expect(sections).toBeVisible();
    await expect(sections.getByText('3 unassigned')).toBeVisible();
    await sections.getByRole('button', { name: 'Add your first section' }).click();
    await page.getByRole('textbox', { name: 'New section name' }).fill('Section from user test');
    await page.getByRole('button', { name: 'Create section' }).click();

    await expect(page.getByText('Section from user test', { exact: true })).toBeVisible();
    await expect(sections.locator('.cn-section-count')).toHaveText('0');
    await expect(sections.getByText('3 unassigned')).toBeVisible();
    await expect.poll(async () => {
      const response = await fetch(`${BASE}/api/projects/${slug}/canvas`, { headers });
      const canvas = await response.json();
      return canvas.sections?.map((section: { name: string }) => section.name) ?? [];
    }).toContain('Section from user test');

    await page.locator('.cn-node[data-id="match-one"]').click({ button: 'right' });
    await page.locator('.cn-ctx-select').selectOption({ label: 'Section from user test' });
    await expect(sections.locator('.cn-section-count')).toHaveText('1');
    await expect(sections.getByText('2 unassigned')).toBeVisible();
    await sections.getByRole('button', { name: 'Collapse section' }).click();
    await expect(page.locator('.cn-node[data-id="match-one"]')).toHaveCount(0);

    const search = page.getByRole('searchbox', { name: 'Find nodes' });
    await page.keyboard.press('Control+f');
    await expect(search).toBeFocused();
    await search.fill('needle');
    await expect(sections.getByText('2 matches')).toBeVisible();
    await expect(page.locator('.cn-node.cn-search-match')).toHaveCount(1);
    await expect(page.locator('.cn-node.cn-search-current')).toHaveCount(0);
    await search.press('Enter');
    await expect(page.locator('.cn-node.cn-search-current')).toHaveAttribute('data-id', 'match-one');
    await expect(page.locator('.cn-node[data-id="match-one"]')).toBeVisible();
    await expect(page.locator('.cn-node.cn-search-match')).toHaveCount(2);
    await expect(sections.getByRole('button', { name: 'Collapse section' })).toBeVisible();
    await expect(sections.getByText('1 of 2')).toBeVisible();
    await search.press('Enter');
    await expect(page.locator('.cn-node.cn-search-current')).toHaveAttribute('data-id', 'match-two');
    await search.press('Shift+Enter');
    await expect(page.locator('.cn-node.cn-search-current')).toHaveAttribute('data-id', 'match-one');

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(sections).toBeVisible();
    await expect(sections.getByText('Section from user test', { exact: true })).toBeVisible();
    await expect(search).toBeVisible();
    const mobileSearchWidth = await page.locator('.cn-board-search').evaluate((element) => element.getBoundingClientRect().width);
    expect(mobileSearchWidth).toBeGreaterThan(250);
    expect(mobileSearchWidth).toBeLessThanOrEqual(390);
    await search.press('Escape');
    await expect(search).toHaveValue('');
    await expect(page.locator('.cn-node.cn-search-match')).toHaveCount(0);
    await expect.poll(async () => {
      const response = await fetch(`${BASE}/api/projects/${slug}/canvas`, { headers });
      const canvas = await response.json();
      return {
        nodes: canvas.nodes.map((node: { id: string }) => node.id).sort(),
        section: canvas.nodes.find((node: { id: string }) => node.id === 'match-one')?.section,
      };
    }).toEqual({
      nodes: ['loose-note', 'match-one', 'match-two'],
      section: expect.any(String),
    });
  } finally {
    await fetch(`${BASE}/api/projects/${slug}`, { method: 'DELETE', headers });
  }
});

test('canvas connect mode links the clicked target and persists the edge', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const container = process.env.WSD_TEST_CONTAINER || 'wsd-pro';
  const secret = readEnvValue('JWT_SECRET') ||
    execFileSync('docker', ['exec', container, 'cat', '/app/data/jwt.secret'], { encoding: 'utf8' }).trim();
  const users = JSON.parse(execFileSync('docker', ['exec', container, 'cat', '/app/data/users.json'], { encoding: 'utf8' }));
  const user = users.users?.find((entry: { id?: string }) => entry.id);
  if (!user?.id) throw new Error('No existing user is available in the running container');
  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role, tv: user.tokenVersion || 0, jti: 'canvas-connect-e2e' },
    secret,
    { expiresIn: '10m' }
  );
  const slug = `canvas-connect-${Date.now().toString(36)}-${testInfo.retry}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const created = await fetch(`${BASE}/api/projects`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Canvas Connect Test', slug }),
  });
  expect(created.status, 'create a temporary project for the UI journey').toBe(201);
  try {
    const seeded = await fetch(`${BASE}/api/projects/${slug}/canvas`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        version: 1,
        nodes: [
          { id: 'source', type: 'note', text: 'Source', x: 40, y: 80, w: 220, h: 100, color: 'yellow' },
          { id: 'target', type: 'note', text: 'Target', x: 420, y: 80, w: 220, h: 100, color: 'blue' },
        ],
        edges: [],
      }),
    });
    expect(seeded.status, 'seed two separated nodes').toBe(200);

    await page.addInitScript((value) => {
      localStorage.setItem('wsd.token', value);
      localStorage.setItem('wsd.lang', 'en');
    }, token);
    await page.goto(`${BASE}/#/project/${slug}?tab=canvas`);

    await page.getByRole('heading', { name: /Planning canvas/ }).waitFor({ state: 'visible' });
    const source = page.locator('.cn-node[data-id="source"]');
    const target = page.locator('.cn-node[data-id="target"]');
    await expect(source).toBeVisible();
    await source.click();
    await page.getByRole('button', { name: /Connect nodes/ }).click();
    await target.click();

    await expect.poll(async () => {
      const response = await fetch(`${BASE}/api/projects/${slug}/canvas`, { headers });
      const canvas = await response.json();
      return canvas.edges;
    }).toEqual([expect.objectContaining({ from: 'source', to: 'target' })]);

    const stressNodes = [
      { id: 'source', type: 'note', text: 'Source', x: 40, y: 80, w: 220, h: 100, color: 'yellow' },
      { id: 'target', type: 'note', text: 'Target', x: 420, y: 80, w: 220, h: 100, color: 'blue' },
      ...Array.from({ length: 198 }, (_, i) => ({
        id: `node-${i}`,
        type: 'note',
        text: `Stress node ${i}`,
        x: 40 + (i % 10) * 260,
        y: 260 + Math.floor(i / 10) * 160,
        w: 220,
        h: 100,
        color: 'green',
      })),
    ];
    const stressEdges = Array.from({ length: 399 }, (_, i) => {
      const from = Math.floor(i / 2);
      const to = (from + (i % 2) + 2) % stressNodes.length;
      return { id: `stress-${i}`, from: stressNodes[from].id, to: stressNodes[to].id };
    });
    const denseBoard = await fetch(`${BASE}/api/projects/${slug}/canvas`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        version: 1,
        nodes: stressNodes,
        edges: [{ id: 'source-target', from: 'source', to: 'target' }, ...stressEdges],
      }),
    });
    expect(denseBoard.status, 'seed a maximum-size canvas for the drag performance journey').toBe(200);
    await page.reload();
    await expect(page.locator('.cn-node')).toHaveCount(200);
    await expect(page.locator('.cn-edge')).toHaveCount(400);
    await page.getByRole('button', { name: /Reset view/ }).click();

    const boardSearch = page.getByRole('searchbox', { name: 'Find nodes' });
    await boardSearch.fill('Stress node 177');
    await expect(page.locator('.cn-node.cn-search-match')).toHaveCount(1);
    await boardSearch.press('Enter');
    await expect(page.locator('.cn-node.cn-search-current')).toHaveAttribute('data-id', 'node-177');
    await expect(page.locator('.cn-node')).toHaveCount(200);
    await expect(page.locator('.cn-edge')).toHaveCount(400);
    await boardSearch.press('Escape');
    await page.getByRole('button', { name: /Reset view/ }).click();

    const dragSource = page.locator('.cn-node[data-id="source"]');
    const sourceBox = await dragSource.boundingBox();
    expect(sourceBox).not.toBeNull();
    const dragStart = { x: sourceBox!.x + sourceBox!.width / 2, y: sourceBox!.y + sourceBox!.height / 2 };
    const originalGeometry = await dragSource.evaluate((el) => ({
      left: (el as HTMLElement).style.left,
      top: (el as HTMLElement).style.top,
    }));
    const hitNodeId = await page.evaluate(({ x, y }) =>
      document.elementFromPoint(x, y)?.closest('.cn-node')?.getAttribute('data-id') ?? null, dragStart);
    expect(hitNodeId).toBe('source');
    await page.mouse.move(dragStart.x, dragStart.y);
    await page.mouse.down();
    await expect(dragSource).toHaveClass(/cn-selected/);
    await page.mouse.move(dragStart.x + 32, dragStart.y + 16, { steps: 4 });
    await page.waitForTimeout(32);
    await expect.poll(() => dragSource.evaluate((el) => (el as HTMLElement).style.transform))
      .toContain('translate3d');
    const draggingGeometry = await dragSource.evaluate((el) => ({
      left: (el as HTMLElement).style.left,
      top: (el as HTMLElement).style.top,
    }));
    expect(draggingGeometry).toEqual(originalGeometry);
    await page.mouse.up();
    await expect.poll(() => dragSource.evaluate((el) => (el as HTMLElement).style.left))
      .not.toBe(originalGeometry.left);
    await expect(dragSource).toHaveCSS('transform', 'none');

    const readCanvas = async () => {
      const response = await fetch(`${BASE}/api/projects/${slug}/canvas`, { headers });
      expect(response.status).toBe(200);
      return response.json();
    };
    await expect.poll(async () => (await readCanvas()).nodes.find((node: { id: string }) => node.id === 'source')?.x)
      .not.toBe(40);
    const movedSource = (await readCanvas()).nodes.find((node: { id: string }) => node.id === 'source');
    expect(movedSource.y).not.toBe(80);

    await page.getByRole('button', { name: /Undo/ }).click();
    await expect.poll(async () => {
      const node = (await readCanvas()).nodes.find((item: { id: string }) => item.id === 'source');
      return { x: node?.x, y: node?.y };
    }).toEqual({ x: 40, y: 80 });
    await page.getByRole('button', { name: /Redo/ }).click();
    await expect.poll(async () => {
      const node = (await readCanvas()).nodes.find((item: { id: string }) => item.id === 'source');
      return { x: node?.x, y: node?.y };
    }).toEqual({ x: movedSource.x, y: movedSource.y });

    await dragSource.dblclick();
    const editor = page.locator('.cn-editor[data-id="source"]');
    await expect(editor).toBeFocused();
    await expect(page.locator('.cn-node')).toHaveCount(200);
    await editor.fill('Edited from the user journey');
    await editor.press('Enter');
    await expect.poll(async () =>
      (await readCanvas()).nodes.find((node: { id: string }) => node.id === 'source')?.text
    ).toBe('Edited from the user journey');

    await page.reload();
    await expect(page.locator('.cn-node[data-id="source"] .cn-text'))
      .toHaveText('Edited from the user journey');
    const resizedSource = page.locator('.cn-node[data-id="source"]');
    await resizedSource.click();
    const resizeHandle = resizedSource.locator('.cn-resize-handle');
    const resizeBox = await resizeHandle.boundingBox();
    expect(resizeBox).not.toBeNull();
    const originalWidth = await resizedSource.evaluate((el) => (el as HTMLElement).style.width);
    await page.mouse.move(resizeBox!.x + resizeBox!.width / 2, resizeBox!.y + resizeBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(resizeBox!.x + resizeBox!.width / 2 + 24, resizeBox!.y + resizeBox!.height / 2 + 20, { steps: 4 });
    await page.mouse.up();
    await expect.poll(() => resizedSource.evaluate((el) => (el as HTMLElement).style.width))
      .not.toBe(originalWidth);
    await expect.poll(async () =>
      (await readCanvas()).nodes.find((node: { id: string }) => node.id === 'source')?.w
    ).not.toBe(220);

    const canvasWrap = page.locator('.canvas-wrap');
    await page.getByRole('button', { name: 'Fullscreen' }).click();
    await expect(canvasWrap).toHaveClass(/cn-fullscreen/);
    await expect(page.locator('.cn-zoom-btn')).not.toHaveText('100%');
    const viewport = page.viewportSize();
    const fullscreenBox = await canvasWrap.boundingBox();
    const boardBox = await page.locator('.canvas-root').boundingBox();
    expect(viewport).not.toBeNull();
    expect(fullscreenBox?.height).toBeGreaterThanOrEqual((viewport?.height ?? 0) * 0.95);
    expect(boardBox?.height).toBeGreaterThan(400);

    const canvasRoot = page.locator('.canvas-root');
    const initialTrackpadZoom = await page.locator('.cn-zoom-btn').innerText();
    const beforeTrackpadPan = await page.locator('.cn-world').evaluate((el) => (el as HTMLElement).style.transform);
    await canvasRoot.evaluate((el) => {
      el.dispatchEvent(new WheelEvent('wheel', {
        deltaX: 36,
        deltaY: 72,
        deltaMode: WheelEvent.DOM_DELTA_PIXEL,
        bubbles: true,
        cancelable: true,
      }));
    });
    await expect.poll(() =>
      page.locator('.cn-world').evaluate((el) => (el as HTMLElement).style.transform)
    ).not.toBe(beforeTrackpadPan);
    await expect(page.locator('.cn-zoom-btn')).toHaveText(initialTrackpadZoom);

    await canvasRoot.evaluate((el) => {
      el.dispatchEvent(new WheelEvent('wheel', {
        deltaY: -30,
        deltaMode: WheelEvent.DOM_DELTA_PIXEL,
        ctrlKey: true,
        clientX: 400,
        clientY: 300,
        bubbles: true,
        cancelable: true,
      }));
    });
    await expect.poll(() => page.locator('.cn-zoom-btn').innerText()).not.toBe(initialTrackpadZoom);

    const beforeMouseWheelZoom = await page.locator('.cn-zoom-btn').innerText();
    await canvasRoot.evaluate((el) => {
      el.dispatchEvent(new WheelEvent('wheel', {
        deltaY: 1,
        deltaMode: WheelEvent.DOM_DELTA_LINE,
        bubbles: true,
        cancelable: true,
      }));
    });
    await expect.poll(() => page.locator('.cn-zoom-btn').innerText()).not.toBe(beforeMouseWheelZoom);

    const beforePixelMouseWheelZoom = await page.locator('.cn-zoom-btn').innerText();
    await canvasRoot.evaluate((el) => {
      el.dispatchEvent(new WheelEvent('wheel', {
        deltaY: -100,
        deltaMode: WheelEvent.DOM_DELTA_PIXEL,
        bubbles: true,
        cancelable: true,
      }));
    });
    await expect.poll(() => page.locator('.cn-zoom-btn').innerText()).not.toBe(beforePixelMouseWheelZoom);

    const beforePan = await page.locator('.cn-world').evaluate((el) => (el as HTMLElement).style.transform);
    const start = { x: (boardBox?.x ?? 0) + 32, y: (boardBox?.y ?? 0) + 32 };
    await page.keyboard.down('Space');
    await expect(canvasRoot).toHaveClass(/cn-panning/);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 80, start.y + 50, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.up('Space');
    await expect.poll(() =>
      page.locator('.cn-world').evaluate((el) => (el as HTMLElement).style.transform)
    ).not.toBe(beforePan);

    await page.getByRole('button', { name: 'Exit fullscreen' }).click();
    await expect(canvasWrap).not.toHaveClass(/cn-fullscreen/);
  } finally {
    await fetch(`${BASE}/api/projects/${slug}`, { method: 'DELETE', headers });
  }
});
