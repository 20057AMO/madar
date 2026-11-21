import { test, expect } from './fixtures';
import jwt from 'jsonwebtoken';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test.describe.configure({ retries: 0 });

const BASE = 'http://localhost:3000';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

type Actor = { id: string; username: string; role: string; tv: number };

function readEnvValue(key: string): string | null {
  const envFile = path.join(ROOT, '.env');
  if (!fs.existsSync(envFile)) return null;
  const line = fs.readFileSync(envFile, 'utf8').split(/\r?\n/).find((entry) => entry.trim().startsWith(`${key}=`));
  return line ? line.slice(line.indexOf('=') + 1).trim() : null;
}

function container(): string {
  return process.env.WSD_TEST_CONTAINER || 'wsd-pro';
}

function secret(): string {
  return readEnvValue('JWT_SECRET') ||
    execFileSync('docker', ['exec', container(), 'cat', '/app/data/jwt.secret'], { encoding: 'utf8', timeout: 15000 }).trim();
}

function signToken(user: Actor): string {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, tv: user.tv, jti: `wim-${Date.now()}-${Math.random()}` },
    secret(),
    { expiresIn: '10m' },
  );
}

function adminActor(): Actor {
  const users = JSON.parse(execFileSync('docker', ['exec', container(), 'cat', '/app/data/users.json'], { encoding: 'utf8' }));
  const user = users.users?.find((entry: { id?: string }) => entry.id);
  if (!user?.id) throw new Error('No existing user is available in the running container');
  return { id: user.id, username: user.username, role: user.role, tv: user.tokenVersion || 0 };
}

function fakeStatus(refreshed: boolean) {
  return {
    workspaceImage: {
      name: 'wsd/workspace:latest',
      installed: true,
      imageId: 'sha256:1111111111111111',
      buildId: 'build-e2e-111111',
      builtAt: '2026-11-20T10:00:00.000Z',
      stale: false,
      declared: { ubuntuVersionId: '26.04', nodeMajor: 24, nodeChannel: 'lts' },
      actual: {
        ubuntuVersionId: '26.04',
        nodeMajor: 24,
        nodeChannel: 'lts',
        ubuntuPrettyName: 'Ubuntu 26.04 LTS',
        node: 'v24.0.0',
        npm: '11.0.0',
        dockerCli: true,
      },
      source: 'container-marker',
      drift: 'ok',
      reasons: [],
    },
    daemon: { version: '28.0.0', apiVersion: '1.48' },
    projects: [],
    lastRefresh: refreshed
      ? {
          at: '2026-11-21T10:00:00.000Z',
          ok: true,
          durationMs: 1234,
          buildId: 'build-e2e-222222',
          errorCode: null,
        }
      : null,
    checkedAt: '2026-11-21T10:01:00.000Z',
  };
}

test('workspace image refresh announces success and restores focus to the enabled refresh button', async ({ page }) => {
  const token = signToken(adminActor());
  let statusCalls = 0;
  let refreshCalls = 0;

  await page.addInitScript((value: string) => {
    try { localStorage.setItem('wsd.token', value); } catch {}
    try { localStorage.setItem('wsd.lang', 'en'); } catch {}
  }, token);

  await page.route('**/api/workspace-image/status**', async (route) => {
    statusCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(fakeStatus(statusCalls > 1)),
    });
  });

  await page.route('**/api/workspace-image/refresh**', async (route) => {
    refreshCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'ok', lastRefresh: fakeStatus(true).lastRefresh }),
    });
  });

  await page.goto(`${BASE}/#/settings`);
  const panel = page.locator('#sec-workspace-image');
  await expect(panel).toBeVisible();
  const refreshButton = panel.getByRole('button', { name: 'Refresh image' });
  await expect(refreshButton).toBeEnabled();

  await refreshButton.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Refresh image' }).click();

  await expect(panel.locator('.wim-live[role="status"]')).toHaveText('Workspace image refreshed. Status updated.');
  await expect(refreshButton).toBeEnabled();
  await expect(refreshButton).toBeFocused();
  expect(refreshCalls).toBe(1);
  expect(statusCalls).toBe(2);
});
