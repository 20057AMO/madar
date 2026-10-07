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
    await page.addInitScript((value) => {
      localStorage.setItem('wsd.token', value);
      localStorage.setItem('wsd.lang', 'en');
    }, token);
    await page.goto(`${BASE}/#/project/${slug}?tab=canvas`);

    await page.getByRole('heading', { name: /Planning canvas/ }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Add a section (swimlane)' }).click();
    await page.getByRole('textbox', { name: 'New section name' }).fill('Section from user test');
    await page.getByRole('button', { name: 'Create section' }).click();

    await expect(page.getByText('Section from user test', { exact: true })).toBeVisible();
    await expect.poll(async () => {
      const response = await fetch(`${BASE}/api/projects/${slug}/canvas`, { headers });
      const canvas = await response.json();
      return canvas.sections?.map((section: { name: string }) => section.name) ?? [];
    }).toContain('Section from user test');
  } finally {
    await fetch(`${BASE}/api/projects/${slug}`, { method: 'DELETE', headers });
  }
});

test('canvas connect mode links the clicked target and persists the edge', async ({ page }) => {
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
  const slug = `canvas-connect-${Date.now().toString(36)}`;
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

    const beforePan = await page.locator('.cn-world').evaluate((el) => (el as HTMLElement).style.transform);
    const start = { x: (boardBox?.x ?? 0) + 32, y: (boardBox?.y ?? 0) + 32 };
    await page.keyboard.down('Space');
    await expect(page.locator('.canvas-root')).toHaveClass(/cn-panning/);
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
