/**
 * index.ts
 * Madar — Work Space Development Pro v2
 * Docker-compose app: dashboard + unified code-server IDE + opencode + chat.
 * Each project = isolated container with durable workspace.
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import http from 'http';
import multer from 'multer';

import {
  createProject,
  getProject,
  startProject,
  stopProject,
  removeProject,
  projectLogs,
  getProjectStats,
  checkProjectPorts,
  recreateProject,
  runProjectScript,
  cloneIntoWorkspace,
  duplicateProject,
  validatePortSet,
  updateProjectPorts,
  updateProjectLimits,
  ensureOpencodeSession,
  HttpError,
  WORKSPACES_ROOT,
} from './services/docker-manager';
import { type ProjectLimits, getHostInfo } from './services/project-limits';
import { startJanitor } from './services/workspace-janitor';
import * as studio from './services/opencode-studio';
import { listWorkspaceFiles, readWorkspaceFile, writeWorkspaceFile, renameWorkspacePath, deleteWorkspacePath, resolveProjectSubdir, streamWorkspaceFile } from './services/workspace-files';
import { loadMeta, saveMeta, listMetaSlugs } from './services/projects-meta';

import { exportProjectSnapshot, importProjectSnapshot } from './services/project-snapshots';
import { exportProjectZip } from './services/project-zip';
import * as snapAuto from './services/project-snapshots-auto';
import { getIdeStatus } from './services/ide-service';
import { detectIp } from './services/server-info';
import { getChatConfig, updateChatConfig, listModels, type ChatConfig } from './services/chat-config';
import {
  listProviders,
  updateProvider,
  getProviderConfig,
  getProviderMeta,
  createProvider,
  deleteProvider,
  findDuplicateByKeyOrHost,
  KNOWN_TEMPLATES,
} from './services/provider-store';
import { detectProvider, checkProvider } from './services/providers-detect';
import { getProjectContext, listProjectsBrief, capText } from './services/project-context';
import * as notes from './services/project-notes';
import * as canvas from './services/project-canvas';
import { getIndexStats, retrieveProject, formatRetrievedChunks } from './services/project-index';
import {
  listWebhooks,
  getWebhook,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  toPublic,
} from './services/webhooks-store';
import { sendWebhook } from './services/webhook-sender';
import { startAlertsAutomation, manualClearCrash } from './services/project-alerts';
import { serveStatus, startServeProcess, stopServeProcess } from './services/project-serve';
import { sanitizeServeConfig } from './services/serve-core';
import { getStorageMetrics, invalidateStorageCache } from './services/storage-metrics';
import { getCachedProjects, invalidateProjectsCache } from './services/projects-cache';
import { cleanupStorage } from './services/storage-cleanup';
import {
  listArchives,
  deleteArchive,
  emptyTrash,
  restoreArchive,
  setOwner as setArchiveOwner,
} from './services/archive-manager';
import {
  listSessions,
  createSession,
  renameSession,
  deleteSession,
} from './services/chat-sessions';
import {
  setup,
  login,
  signLoginSession,
  changePassword,
  hasUser,
  getUserCount,
  listUsers,
  getUserInfo,
  createUser,
  updateUserRole,
  deleteUser,
  updateUserProfile,
  setUserAvatarExt,
  verifyToken,
  hasProvidersPassword,
  setProvidersPassword,
  removeProvidersPassword,
  issueUnlockToken,
  verifyUnlockToken,
  verifyAccountPassword,
  revokeAllSessions,
  revokeProvidersUnlocks,
  isTotpEnabled,
  beginTotpSetup,
  enableTotp,
  disableTotp,
  verifyTotpCode,
  verifyPending2faToken,
  getUserByUsername,
} from './services/user-store';
import { otpauthUri } from './services/totp';
import { buildBackup, restoreFromBackup } from './services/settings-export';
import { recordAudit, listAudit, listUserActivity } from './services/audit-store';
import { checkUserWrite, sweepUserWriteBuckets } from './services/user-write-limiter';
import { authMiddleware, requireAdmin, requireRole, requireProjectAccess, checkProjectAccess } from './middleware/auth';
import { attachWebSockets } from './ws/ws-server';
import { getPresence } from './ws/ws-presence';
import { saveAvatar, deleteAvatar, getAvatarPath, validAvatarUserId } from './services/avatar-store';

dotenv.config();

// Loud, unmissable warning when the deployment runs on a publicly-known
// signing secret — tokens would be forgeable by anyone with the repo.
const INSECURE_SECRETS = new Set([
  'wsd-pro-insecure-default',
  'wsd-pro-default-secret-change-me',
  'change-me',
]);
if (!process.env.JWT_SECRET || INSECURE_SECRETS.has(process.env.JWT_SECRET)) {
  console.warn('┌──────────────────────────────────────────────────────────────┐');
  console.warn('│  ⚠ SECURITY WARNING: JWT_SECRET is missing or uses a known   │');
  console.warn('│  default. Session tokens are forgeable. Set a long random    │');
  console.warn('│  JWT_SECRET in your .env and restart immediately.            │');
  console.warn('└──────────────────────────────────────────────────────────────┘');
}

const app = express();
// Trust exactly one reverse-proxy hop ONLY when explicitly enabled — with
// the port published directly, a hardcoded trust would let clients spoof
// X-Forwarded-For and defeat every per-IP limiter and the unlock cooldown.
if (process.env.WSD_TRUST_PROXY === '1' || process.env.WSD_TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}
app.disable('x-powered-by');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// Helmet (CSP off — the UI is served from the same origin)
app.use(helmet({ contentSecurityPolicy: false }));
// Compression — registered BEFORE routes so gzip applies to API JSON too,
// not just the static/SPA fallback (Express runs middleware in order).
app.use(compression());
// CORS is opt-in via WSD_CORS_ORIGINS (comma-separated). The UI is always
// same-origin (served by this server; vite dev proxies /api and /ws), so the
// wildcard default of `cors()` would hand every website read access to the
// authenticated API. With no env set no ACAO headers are emitted at all.
const corsOrigins = String(process.env.WSD_CORS_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
if (corsOrigins.length > 0) {
  app.use(
    cors({
      origin(origin, cb) {
        cb(null, !origin || corsOrigins.includes(origin));
      },
    })
  );
}

app.use(express.json({ limit: '10mb' }));

// ── Rate limiting (simple in-memory, per IP, per scope) ───────
// Fixed-window counters, namespaced per scope so the global limit and the
// stricter dangerous-endpoint limit never contaminate each other's budget.
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
const RATE_WINDOW = 60_000; // 1 minute

// Ceilings are env-tunable. Under WSD_TESTING=1 (the compose default for the
// automated-suite container) the global/strict/agent-write/user-admin budgets
// are relaxed so multi-suite teardown never trips them — while the
// auth/unlock/totp brute-force scopes stay at their real values (that's what
// security suites actually assert). Production should keep WSD_TESTING=0/absent.
function rateCeil(envKey: string, dflt: number, testValue: number): number {
  const raw = process.env[envKey];
  const n = raw ? Number(raw) : NaN;
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return process.env.WSD_TESTING === '1' ? testValue : dflt;
}
const RATE_MAX = rateCeil('WSD_RATE_MAX', 240, 4000); // req/min global
const RATE_STRICT_MAX = rateCeil('WSD_RATE_STRICT_MAX', 10, 400); // dangerous endpoints
const RATE_AUTH_MAX = 10; // password-verification endpoints (brute-force guard)
const RATE_USER_ADMIN_MAX = rateCeil('WSD_RATE_USER_ADMIN_MAX', 20, 2000); // admin user provisioning
const RATE_USER_WRITE_MAX = 120; // per-user write budget (write-heavy endpoints)

// Per-user write limiter — keyed on the authenticated user id (falling back to
// the shared IP when no user is present). For NAT-shared deployments a single
// runaway agent can't starve every other user behind the same public IP.
const userWriteLimiter = (req: any, res: any, next: any) => {
  const retryAfter = checkUserWrite(req?.user?.id, req?.ip, RATE_WINDOW, RATE_USER_WRITE_MAX);
  if (retryAfter > 0) {
    res.set('Retry-After', String(retryAfter));
    return res.status(429).json({ error: 'Too many requests. Try again later.' });
  }
  next();
};

function rateLimit(scope: string, windowMs: number, max: number) {
  return (req: any, res: any, next: any) => {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    const key = `${scope}:${ip}`;
    const entry = rateBuckets.get(key);
    if (!entry || entry.resetAt <= now) {
      rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count > max) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((entry.resetAt - now) / 1000))));
      return res.status(429).json({ error: 'Too many requests. Try again later.' });
    }
    next();
  };
}

// Clean up stale buckets every 2 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateBuckets) {
    if (entry.resetAt <= now) rateBuckets.delete(key);
  }
  sweepUserWriteBuckets();
}, 120_000);

// ── Health check (exempt from rate limiting) ─────────────────
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'Madar',
    version: 'BETA',
    timestamp: new Date().toISOString(),
  });
});

// Global rate limit
app.use(rateLimit('global', RATE_WINDOW, RATE_MAX));

// Dedicated brute-force guard for every endpoint that verifies a password.
// Separate scope so login attempts never consume the general API budget
// (and vice versa). 10 attempts/min is far above human usage.
const authLimiter = rateLimit('auth', RATE_WINDOW, RATE_AUTH_MAX);

// Providers unlock gets its OWN budget so lock-picking attempts can neither
// starve legit logins nor have their counting poisoned by them. The
// progressive cooldown below adds the real teeth on top of this.
const unlockLimiter = rateLimit('unlock', RATE_WINDOW, 15);

// User provisioning (admin-gated, so NOT a public brute-force surface — only
// an authenticated admin can spend this budget). Separate from `auth` so the
// suite's user creation never drains the real login-attack budget.
const userAdminLimiter = rateLimit('user-admin', RATE_WINDOW, RATE_USER_ADMIN_MAX);

// Avatar uploads are rare and memory-bound (2 MB buffers) — a dedicated
// low budget keeps one user's uploads from draining the shared write budget.
const avatarLimiter = rateLimit('avatar', RATE_WINDOW, 10);

// ── Uploads (files into an existing project workspace) ────────
const UPLOADS_TMP = '/tmp/wsd-uploads';
fs.mkdirSync(UPLOADS_TMP, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_TMP),
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${file.originalname}`),
  }),
  limits: { fileSize: 200 * 1024 * 1024, files: 50 },
});

// Avatar uploads are tiny and validated by magic bytes — keep in memory.
const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024, files: 1 },
});

// ── Auth: setup / login / status / change-password ───────────
app.get('/api/auth/status', (req: any, res) => {
  const exists = hasUser();
  if (!exists) return res.json({ hasUser: false });
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const decoded = token ? verifyToken(token) : null;
  const user = decoded ? getUserInfo(decoded.id) : null;
  res.json({ hasUser: true, user });
});

app.post('/api/auth/setup', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
    const result = await setup(String(username), String(password));
    recordAudit('setup', true, req.ip, result.id);
    res.status(201).json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  // Resolve the attempted account up front so both the 2FA branch and failures
  // tag the correct userId — Account Activity needs "Sign in failed" to land
  // on the target account, not just on the global admin log.
  const auditUser = req.body && typeof req.body.username === 'string' ? getUserByUsername(req.body.username) : undefined;
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
    const result = await login(String(username), String(password));
    if ('requires2fa' in result) {
      // TOTP is enabled for THIS user — no session until the code verifies.
      // Record the accepted-password step so a correct password that stops at
      // the authenticator still leaves a trace in the account activity log.
      recordAudit('login', true, req.ip, auditUser?.id);
      return res.json(result);
    }
    recordAudit('login', true, req.ip, auditUser?.id);
    res.json(result);
  } catch (err: any) {
    recordAudit('login-failed', false, req.ip, auditUser?.id);
    res.status(401).json({ error: err.message });
  }
});

// Second login factor for 2FA accounts: exchange a pending token plus a
// valid authenticator code for a real session. Tight dedicated budget —
// 6-digit codes must never be guessable at speed.
const totpLimiter = rateLimit('totp', RATE_WINDOW, 8);

app.post('/api/auth/login/verify', totpLimiter, (req: any, res) => {
  const { pendingToken, code } = req.body || {};
  const pendingUserId = verifyPending2faToken(typeof pendingToken === 'string' ? pendingToken : null);
  if (!pendingUserId || !isTotpEnabled(pendingUserId)) {
    return res.status(401).json({ error: 'Login session expired. Sign in again.' });
  }
  const user = getUserInfo(pendingUserId);
  if (!user || !verifyTotpCode(String(code || ''), pendingUserId)) {
    recordAudit('login-2fa-failed', false, req.ip, pendingUserId);
    return res.status(401).json({ error: 'Invalid authenticator code.' });
  }
  const result = signLoginSession(pendingUserId);
  recordAudit('login', true, req.ip, pendingUserId);
  res.json(result);
});

// ── User avatars (public by design: <img> tags carry no auth header) ──
app.get('/api/users/:userId/avatar', (req: any, res) => {
  if (!validAvatarUserId(req.params.userId)) return res.status(404).json({ error: 'No avatar' });
  const p = getAvatarPath(req.params.userId);
  if (!p) return res.status(404).json({ error: 'No avatar' });
  const ext = p.endsWith('.png') ? 'png' : p.endsWith('.webp') ? 'webp' : 'jpeg';
  res.setHeader('Content-Type', `image/${ext}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(p);
});

// ── Auth middleware (protect everything below) ────────────────
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  authMiddleware(req, res, next);
});

// Global security activity log — ADMIN ONLY. Regular users get the
// account-scoped view at /api/auth/me/activity (Profile → Account Activity).
app.get('/api/auth/audit', requireAdmin, (req: any, res) => {
  const limit = Math.min(Math.max(parseInt(String(req.query.limit || '50'), 10) || 50, 1), 100);
  const offset = Math.max(parseInt(String(req.query.offset || '0'), 10) || 0, 0);
  res.json(listAudit(limit, offset));
});

// Account Activity: the authenticated user's OWN events (logins, security
// changes, profile edits). Mints only userId-tagged entries — never the
// global log, so a viewer can't read admins' or other users' activity.
app.get('/api/auth/me/activity', (req: any, res) => {
  const limit = Math.min(Math.max(parseInt(String(req.query.limit || '50'), 10) || 50, 1), 100);
  const offset = Math.max(parseInt(String(req.query.offset || '0'), 10) || 0, 0);
  res.json(listUserActivity(req.user?.id, limit, offset));
});

// ── Two-factor authentication (TOTP) ──────────────────────────
app.get('/api/auth/2fa/status', (req: any, res) => {
  res.json({ enabled: isTotpEnabled(req.user?.id) });
});

// Enrollment step 1: generate a fresh pending secret. Safe to re-run while
// still unverified — it simply replaces the not-yet-enabled secret.
app.post('/api/auth/2fa/setup', authLimiter, (req: any, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required.' });
    const { secret } = beginTotpSetup(userId);
    const user = getUserInfo(userId);
    res.json({ secret, uri: otpauthUri(secret, user?.username || 'owner') });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Enrollment step 2: activate once the app proves it can produce valid codes.
app.post('/api/auth/2fa/enable', authLimiter, (req: any, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Authentication required.' });
  const { code } = req.body || {};
  if (enableTotp(String(code || ''), userId)) {
    recordAudit('2fa-enabled', true, req.ip, userId);
    return res.json({ ok: true });
  }
  recordAudit('2fa-enabled-failed', false, req.ip, userId);
  res.status(400).json({ error: 'Invalid authenticator code.' });
});

// Turning 2FA off is dangerous → account-password re-auth required.
app.post('/api/auth/2fa/disable', authLimiter, async (req: any, res) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: 'Authentication required.' });
  const { accountPassword } = req.body || {};
  if (!accountPassword) return res.status(400).json({ error: 'Account password is required.' });
  if (!(await verifyAccountPassword(String(accountPassword), userId))) {
    recordAudit('2fa-disabled-failed', false, req.ip, userId);
    return res.status(401).json({ error: 'Account password is incorrect.' });
  }
  disableTotp(userId);
  recordAudit('2fa-disabled', true, req.ip, userId);
  res.json({ ok: true });
});

app.post('/api/auth/change-password', authLimiter, async (req: any, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Current and new password are required.' });
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Authentication required.' });
    const { token } = await changePassword(String(currentPassword), String(newPassword), userId);
    recordAudit('password-change', true, req.ip, userId);
    res.json({ ok: true, token });
  } catch (err: any) {
    recordAudit('password-change-failed', false, req.ip, req.user?.id);
    res.status(400).json({ error: err.message });
  }
});

// Logout everywhere: invalidate every issued session token.
app.post('/api/auth/logout-all', authLimiter, async (req: any, res) => {
  try {
    const { accountPassword } = req.body || {};
    if (!accountPassword) return res.status(400).json({ error: 'Account password is required.' });
    await revokeAllSessions(String(accountPassword));
    recordAudit('logout-all', true, req.ip, req.user?.id);
    res.json({ ok: true });
  } catch (err: any) {
    recordAudit('logout-all-failed', false, req.ip, req.user?.id);
    res.status(err?.status || 400).json({ error: err.message });
  }
});

// ── Providers lock (optional second-layer password) ───────────
app.get('/api/providers-lock', (_req, res) => {
  res.json({ enabled: hasProvidersPassword() });
});

// Unlock verifies a password — brute-force guard (dedicated unlock limiter +
// progressive cooldown) + audit trail apply here.
app.post('/api/providers/unlock', unlockLimiter, async (req: any, res) => {
  const ip = String(req.ip || 'unknown');
  const cd = unlockCooldownRemainingSec(ip);
  if (cd > 0) {
    res.set('Retry-After', String(cd));
    return res.status(429).json({ error: `Too many failed unlock attempts. Try again in ${Math.ceil(cd / 60)} minute(s).` });
  }
  const { password } = req.body || {};
  if (!hasProvidersPassword()) return res.json({ ok: true, unlocked: true });
  const result = await issueUnlockToken(String(password || ''), String(req.user?.jti || ''));
  if (!result) {
    const st = unlockFails.get(ip) || { count: 0, until: 0 };
    st.count += 1;
    if (st.count >= UNLOCK_FAIL_LIMIT) {
      st.until = Date.now() + UNLOCK_COOLDOWN_MS;
      st.count = 0;
      recordAudit('providers-unlock-cooldown', false, req.ip, req.user?.id);
    }
    unlockFails.set(ip, st);
    recordAudit('providers-unlock-failed', false, req.ip, req.user?.id);
    return res.status(401).json({ error: 'Incorrect providers password.' });
  }
  unlockFails.delete(ip);
  recordAudit('providers-unlock', true, req.ip, req.user?.id);
  res.json({ ok: true, unlockToken: result.unlockToken, expiresInSec: result.expiresInSec });
});

// "Lock now" — invalidate every outstanding unlock token across all
// tabs/devices. Main-JWT auth only; no password re-entry needed because
// locking is the defensive direction.
app.post('/api/providers/relock', (req: any, res) => {
  if (!hasProvidersPassword()) return res.json({ ok: true, locked: false });
  revokeProvidersUnlocks();
  recordAudit('providers-relock', true, req.ip, req.user?.id);
  res.json({ ok: true, locked: true });
});

// Set or change the providers lock password — requires account re-auth.
// On success the response carries a ready-to-use unlock token so the
// current session does not get locked out of the page it just protected.
app.post('/api/auth/providers-password', authLimiter, async (req: any, res) => {
  try {
    const { accountPassword, newPassword } = req.body || {};
    if (!accountPassword || !newPassword) {
      return res.status(400).json({ error: 'Account password and new providers password are required.' });
    }
    await setProvidersPassword(String(accountPassword), String(newPassword), req.user?.id);
    recordAudit('providers-lock-change', true, req.ip, req.user?.id);
    const unlock = await issueUnlockToken(String(newPassword), String(req.user?.jti || ''));
    res.json({
      ok: true,
      enabled: true,
      ...(unlock ? { unlockToken: unlock.unlockToken, expiresInSec: unlock.expiresInSec } : {}),
    });
  } catch (err: any) {
    recordAudit('providers-lock-change-failed', false, req.ip, req.user?.id);
    res.status(err?.message?.includes('incorrect') ? 401 : 400).json({ error: err.message });
  }
});

// Remove the providers lock entirely — requires account re-auth.
app.delete('/api/auth/providers-password', authLimiter, async (req: any, res) => {
  try {
    const { accountPassword } = req.body || {};
    if (!accountPassword) return res.status(400).json({ error: 'Account password is required.' });
    await removeProvidersPassword(String(accountPassword), req.user?.id);
    recordAudit('providers-lock-change', true, req.ip, req.user?.id);
    res.json({ ok: true, enabled: false });
  } catch (err: any) {
    recordAudit('providers-lock-change-failed', false, req.ip, req.user?.id);
    res.status(err?.message?.includes('not enabled') ? 409 : 401).json({ error: err.message });
  }
});

// ── Settings backup (export / import) ─────────────────────────
// Admin-only. Both operations require account re-auth. Exports never contain
// API keys.

app.post('/api/settings/export', requireAdmin, authLimiter, async (req: any, res) => {
  const accountPassword = String((req.body?.accountPassword) || '');
  if (!(await verifyAccountPassword(accountPassword, req.user?.id))) {
    return res.status(401).json({ error: 'Account password is incorrect.' });
  }
  try {
    recordAudit('backup-export', true, req.ip, req.user?.id);
    const backup = buildBackup('BETA');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="madar-backup-${new Date().toISOString().slice(0, 10)}.json"`
    );
    res.json(backup);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/settings/import', requireAdmin, authLimiter, async (req: any, res) => {
  try {
    const { accountPassword, backup } = req.body || {};
    if (!accountPassword) return res.status(400).json({ error: 'Account password is required.' });
    if (!(await verifyAccountPassword(String(accountPassword), req.user?.id))) {
      return res.status(401).json({ error: 'Account password is incorrect.' });
    }
    const result = restoreFromBackup(backup);
    recordAudit('backup-import', true, req.ip, req.user?.id);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    res.status(err?.status || 500).json({ error: err.message });
  }
});

// ── User management (admin only) ──────────────────────────────

app.get('/api/users', (req: any, res) => {
  res.json(listUsers());
});

// Team overview — every user + their project memberships (owner/admin/editor/
// viewer). Admin-only roster for the admin Team page; the project-level Team
// tab stays served by the open GET /api/users route (members may view it).
app.get('/api/users/with-memberships', requireAdmin, (req: any, res) => {
  const users = listUsers();
  const memberships = new Map<string, Array<{ slug: string; name: string; role: string; isOwner: boolean }>>();
  for (const slug of listMetaSlugs()) {
    const meta = loadMeta(slug);
    if (!meta) continue;
    const ownerId = meta.ownerId;
    const projectName = meta.name || slug;
    const seen = new Set<string>([ownerId || '']);
    if (ownerId) {
      const list = memberships.get(ownerId) || [];
      list.push({ slug, name: projectName, role: 'admin', isOwner: true });
      memberships.set(ownerId, list);
    }
    for (const m of meta.members || []) {
      if (!m.userId || seen.has(m.userId)) continue;
      seen.add(m.userId);
      const list = memberships.get(m.userId) || [];
      list.push({ slug, name: projectName, role: m.role, isOwner: false });
      memberships.set(m.userId, list);
    }
  }
  const enriched = users.map((u) => ({
    ...u,
    memberships: (memberships.get(u.id) || []).slice(0, 50),
  }));
  res.json({ users: enriched });
});

app.post('/api/users', requireAdmin, userAdminLimiter, async (req: any, res) => {
  try {
    const { username, password, role } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
    const result = await createUser(String(username), String(password), (role as any) || 'editor', req.user?.id);
    recordAudit('user-created', true, req.ip, result.id);
    res.status(201).json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/users/:userId/role', requireAdmin, authLimiter, async (req: any, res) => {
  const { role, accountPassword } = req.body || {};
  if (!['admin', 'editor', 'viewer'].includes(String(role))) {
    return res.status(400).json({ error: 'Invalid role. Must be admin, editor, or viewer.' });
  }
  // An admin must never demote their own system role — the platform would be
  // left without an admin (mirrors the self-delete guard below).
  if (req.params.userId === req.user?.id && String(role) !== 'admin') {
    return res.status(400).json({ error: 'Cannot change your own role.' });
  }
  // Role changes are sudo ops: the acting admin must re-confirm the account
  // password (rate-limited via authLimiter to protect the new credential check).
  if (!accountPassword || !String(accountPassword).length) {
    return res.status(400).json({ error: 'Account password is required to change roles.' });
  }
  if (!(await verifyAccountPassword(String(accountPassword), req.user?.id))) {
    recordAudit('user-role-change-failed', false, req.ip, req.user?.id);
    return res.status(401).json({ error: 'Account password is incorrect.' });
  }
  const ok = updateUserRole(req.params.userId, role as any);
  if (!ok) return res.status(404).json({ error: 'User not found.' });
  recordAudit('user-role-changed', true, req.ip, req.params.userId);
  res.json({ ok: true });
});

app.delete('/api/users/:userId', requireAdmin, userAdminLimiter, (req: any, res) => {
  // Prevent admin from deleting themselves
  if (req.params.userId === req.user?.id) {
    return res.status(400).json({ error: 'Cannot delete your own account.' });
  }
  const ok = deleteUser(req.params.userId);
  if (!ok) return res.status(404).json({ error: 'User not found.' });
  deleteAvatar(req.params.userId); // best-effort avatar cleanup
  recordAudit('user-deleted', true, req.ip, req.params.userId);
  res.json({ ok: true });
});

// ── User profile & avatars ────────────────────────────────────

app.get('/api/users/me/profile', (req: any, res) => {
  const info = getUserInfo(req.user?.id);
  if (!info) return res.status(404).json({ error: 'User not found' });
  res.json({ profile: info.profile || {} });
});

app.get('/api/users/:userId/profile', (req: any, res) => {
  if (!validAvatarUserId(req.params.userId)) return res.status(404).json({ error: 'User not found' });
  const info = getUserInfo(req.params.userId);
  if (!info) return res.status(404).json({ error: 'User not found' });
  res.json({ profile: info.profile || {} });
});

app.put('/api/users/me/profile', userWriteLimiter, (req: any, res) => {
  try {
    const { displayName, email, bio } = req.body || {};
    const updated = updateUserProfile(req.user?.id, { displayName, email, bio });
    if (!updated) return res.status(404).json({ error: 'User not found.' });
    recordAudit('profile-update', true, req.ip, req.user?.id);
    res.json(updated);
  } catch (err: any) {
    recordAudit('profile-update', false, req.ip, req.user?.id);
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/users/:userId/profile', requireAdmin, userWriteLimiter, (req: any, res) => {
  try {
    if (!validAvatarUserId(req.params.userId)) return res.status(404).json({ error: 'User not found' });
    const { displayName, email, bio } = req.body || {};
    const updated = updateUserProfile(req.params.userId, { displayName, email, bio });
    if (!updated) return res.status(404).json({ error: 'User not found.' });
    recordAudit('profile-update', true, req.ip, req.params.userId);
    res.json(updated);
  } catch (err: any) {
    recordAudit('profile-update', false, req.ip, req.params.userId);
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/users/me/avatar', avatarLimiter, userWriteLimiter, avatarUpload.single('avatar'), (req: any, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image file provided.' });
    const ext = saveAvatar(req.user?.id, req.file.buffer);
    if (!setUserAvatarExt(req.user?.id, ext)) return res.status(404).json({ error: 'User not found.' });
    recordAudit('avatar-upload', true, req.ip, req.user?.id);
    res.json({ avatarUrl: `/api/users/${req.user?.id}/avatar` });
  } catch (err: any) {
    recordAudit('avatar-upload', false, req.ip, req.user?.id);
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/users/me/avatar', userWriteLimiter, (req: any, res) => {
  try {
    if (deleteAvatar(req.user?.id)) {
      setUserAvatarExt(req.user?.id, null);
      recordAudit('avatar-remove', true, req.ip, req.user?.id);
    }
    res.json({ ok: true });
  } catch (err: any) {
    recordAudit('avatar-remove', false, req.ip, req.user?.id);
    res.status(400).json({ error: err.message });
  }
});

// ── Server info / networking ─────────────────────────────────
app.get('/api/server/info', async (_req, res) => {
  const ips = detectIp();
  const host = await getHostInfo();
  res.json({
    version: 'BETA',
    lanIp: ips.lanIp,
    tailscaleIp: ips.tailscaleIp,
    basePort: PORT,
    hostCpu: host.cpu,
    hostMemBytes: host.memBytes,
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// ── Chatbot info ─────────────────────────────────────────────
app.get('/api/chat/info', async (_req, res) => {
  const cfg = getChatConfig();
  const models = await listModels(cfg.provider);
  const providers = listProviders().map((p) => ({ id: p.id, name: p.name, type: p.type, enabled: p.enabled }));
  res.json({ ...cfg, models, providers });
});

// Update chat configuration (provider / model / language / system prompt / temperature)
app.post('/api/chat/config', (req, res) => {
  try {
    const { provider, model, systemPrompt, language, temperature } = req.body || {};
    const patch: Partial<ChatConfig> = {};
    if (typeof provider === 'string' && provider.trim() && getProviderMeta(provider)) {
      patch.provider = provider;
    }
    if (typeof model === 'string' && model.trim()) patch.model = model.trim().slice(0, 200);
    if (typeof systemPrompt === 'string') patch.systemPrompt = systemPrompt.slice(0, 20000);
    if (language === 'auto' || language === 'ar' || language === 'en') patch.language = language;
    if (typeof temperature === 'number' && temperature >= 0 && temperature <= 2) patch.temperature = temperature;
    res.json(updateChatConfig(patch));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// List models available from a provider (any configured provider id)
app.get('/api/chat/models', async (req, res) => {
  const requested = String(req.query.provider || '');
  const provider = requested && getProviderMeta(requested) ? requested : getChatConfig().provider;
  const models = await listModels(provider);
  res.json({ models });
});

// Preview the project-awareness context that will be injected into the model
app.get('/api/chat/context', async (req, res) => {
  const project = String(req.query.project || '').trim();
  if (!project) {
    return res.status(400).json({ error: 'Missing project query (use "all" or a project slug)' });
  }
  try {
    const ctx = project === 'all' ? await listProjectsBrief() : await getProjectContext(project);
    let indexStats;
    if (project !== 'all') {
      indexStats = getIndexStats(project);
      const query = String(req.query.query || '').trim();
      if (query) {
        const ret = await retrieveProject(project, query, 6);
        const block = formatRetrievedChunks(ret);
        if (block) ctx.text = capText(`${ctx.text}\n\n${block}`, 24000).text;
      }
    }
    res.json({ ...ctx, indexStats });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── Chat sessions (per-project conversation history) ──────────
app.get('/api/chat/sessions', (_req, res) => {
  const project = String(_req.query.project || '').trim() || undefined;
  res.json({ sessions: listSessions(project) });
});

app.post('/api/chat/sessions', userWriteLimiter, (req, res) => {
  const { name, project } = req.body || {};
  res.status(201).json({ session: createSession({ project, name }) });
});

app.put('/api/chat/sessions/:chatId', (req, res) => {
  const project = String(req.query.project || '').trim() || undefined;
  const name = String(req.body?.name || '').trim();
  const session = renameSession(project, req.params.chatId, name);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({ session });
});

app.delete('/api/chat/sessions/:chatId', (req, res) => {
  const project = String(req.query.project || '').trim() || undefined;
  if (!deleteSession(project, req.params.chatId)) {
    return res.status(404).json({ error: 'Session not found' });
  }
  res.json({ ok: true });
});

// ── Providers (API key management, protected by authMiddleware) ──

// Optional second-layer lock: when a providers password is configured, all
// management endpoints require a short-lived scoped unlock token. Chat and
// agent LLM calls are server-side and unaffected.
function providersLockMiddleware(req: any, res: any, next: any) {
  if (!hasProvidersPassword()) return next();
  const token = String(req.headers['x-providers-unlock'] || '');
  // Unlock tokens are bound to the requesting session's jti — a stolen
  // token replayed from another session (or without one) is rejected.
  const sid = String(req.user?.jti || '');
  if (verifyUnlockToken(token, sid)) return next();
  res.status(403).json({ error: 'providers_locked' });
}

// Progressive brute-force cooldown for providers unlock failures:
// UNLOCK_FAIL_LIMIT consecutive wrong passwords from one IP triggers a
// silent-to-attacker cooldown window on top of the dedicated unlock limiter.
const UNLOCK_FAIL_LIMIT = 5;
const UNLOCK_COOLDOWN_MS = 15 * 60 * 1000;
const unlockFails = new Map<string, { count: number; until: number }>();

function unlockCooldownRemainingSec(ip: string): number {
  const st = unlockFails.get(ip);
  if (!st?.until) return 0;
  const remainMs = st.until - Date.now();
  if (remainMs <= 0) {
    unlockFails.delete(ip);
    return 0;
  }
  return Math.ceil(remainMs / 1000);
}

// Lightweight picker list for dropdowns (Agents modal etc.) — no secrets,
// stays reachable even when the providers lock is enabled.
app.get('/api/providers/options', (_req, res) => {
  const options = listProviders().map((p) => ({ id: p.id, name: p.name, type: p.type, enabled: p.enabled }));
  res.json({ providers: options });
});

app.get('/api/providers/templates', (_req, res) => {
  res.json({ templates: KNOWN_TEMPLATES });
});

const providersManagement: Array<(req: any, res: any, next: any) => void> = [providersLockMiddleware];

app.get('/api/providers', requireAdmin, providersManagement, (_req: any, res: any) => {
  res.json({ providers: listProviders() });
});

app.post('/api/providers/detect', requireAdmin, providersManagement, async (req: any, res: any) => {
  try {
    const { apiKey, host } = req.body || {};
    const result = await detectProvider({ apiKey, host });
    res.json(result);
  } catch (err: any) {
    res.status(err?.status || 500).json({ error: err.message });
  }
});

app.post('/api/providers', requireAdmin, providersManagement, async (req: any, res: any) => {
  try {
    const { name, host, type, apiKey, enabled, auth } = req.body || {};
    const key = typeof apiKey === 'string' ? apiKey.trim() : '';

    let finalHost = typeof host === 'string' ? host.trim() : '';
    let finalType = type;
    if (finalHost) {
      const dup = findDuplicateByKeyOrHost(key, finalHost, type);
      if (dup) {
        res.status(409).json({ error: `A provider with this ${key ? 'API key' : 'host'} already exists (${dup.name})` });
        return;
      }
    } else {
      // No host → detect everything from the API key in the background.
      const result = await detectProvider({ apiKey: key });
      if (!result.provider) {
        res.status(400).json({
          error: 'detection_required',
          message: 'Could not auto-detect a provider from this API key. Pick a template or enter the host manually.',
          tried: result.tried,
        });
        return;
      }
      const dup = findDuplicateByKeyOrHost(key);
      if (dup) {
        res.status(409).json({ error: `A provider with this API key already exists (${dup.name})` });
        return;
      }
      finalHost = result.provider.host;
      finalType = result.provider.type;
    }

    const provider = createProvider({ name, host: finalHost, type: finalType, apiKey: key, enabled, auth });
    res.status(201).json({ provider });
  } catch (err: any) {
    res.status(err?.status || 500).json({ error: err.message });
  }
});

app.put('/api/providers/:id', requireAdmin, providersManagement, (req: any, res: any) => {
  try {
    const id = String(req.params.id || '');
    if (!getProviderMeta(id)) {
      res.status(404).json({ error: 'Unknown provider' });
      return;
    }
    const { name, host, apiKey, enabled, type, auth } = req.body || {};
    if (typeof apiKey === 'string' && apiKey.trim()) {
      const dup = findDuplicateByKeyOrHost(apiKey.trim());
      if (dup && dup.id !== id) {
        res.status(409).json({ error: `A provider with this API key already exists (${dup.name})` });
        return;
      }
    }
    const provider = updateProvider(id, { name, host, apiKey, enabled, type, auth });
    res.json({ provider });
  } catch (err: any) {
    res.status(err?.status || 500).json({ error: err.message });
  }
});

app.delete('/api/providers/:id', requireAdmin, providersManagement, (req: any, res: any) => {
  try {
    const id = String(req.params.id || '');
    deleteProvider(id);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(err?.status || 500).json({ error: err.message });
  }
});

app.post('/api/providers/:id/test', requireAdmin, providersManagement, async (req: any, res: any) => {
  const id = String(req.params.id || '');
  if (!getProviderMeta(id)) {
    res.status(404).json({ error: 'Unknown provider' });
    return;
  }
  const cfg = getProviderConfig(id);
  const r = await checkProvider(cfg.type, cfg.host, cfg.apiKey, cfg.auth);
  res.json({ ok: r.ok, status: r.status, modelCount: r.modelCount, verified: r.verified, error: r.error });
});

// ── Unified Web IDE status (port + password) ─────────────────
app.get('/api/ide/status', async (_req, res) => {
  try {
    res.json({ ide: await getIdeStatus() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ── opencode web status ──────────────────────────────────────
const OPENCODE_PORT = Number(process.env.WSD_OPENCODE_PORT) || 4096;

async function opencodeRunning(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${OPENCODE_PORT}`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

app.get('/api/opencode/status', async (_req, res) => {
  res.json({ running: await opencodeRunning(), port: OPENCODE_PORT });
});


// ── Agents API ────────────────────────────────────────────────
import {
  listAllAgents,
  getAgent,
  createAgent,
  updateAgent,
  deleteAgent,
  listAgentSessions,
  createAgentSession,
  deleteAgentSession,
  renameAgentSession,
} from './services/agent-store';

const agentWriteLimiter = rateLimit('agent-write', RATE_WINDOW, rateCeil('WSD_RATE_AGENT_WRITE_MAX', 60, 1000));

app.get('/api/agents', (_req, res) => {
  res.json({ agents: listAllAgents() });
});

app.post('/api/agents', agentWriteLimiter, (req, res) => {
  const body = req.body as any;
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'Name is required' });
  try {
    const agent = createAgent({
      name: name.slice(0, 100),
      icon: String(body.icon || '🤖').slice(0, 10),
      description: String(body.description || '').trim().slice(0, 500),
      systemPrompt: String(body.systemPrompt || '').trim().slice(0, 50000),
      provider: typeof body.provider === 'string' ? body.provider : undefined,
      model: typeof body.model === 'string' ? body.model : undefined,
      toolsEnabled: typeof body.toolsEnabled === 'boolean' ? body.toolsEnabled : undefined,
      permission: ['none', 'read', 'bash', 'full'].includes(body.permission) ? body.permission : undefined,
    });
    res.json({ agent });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to create agent' });
  }
});

app.put('/api/agents/:id', (req, res) => {
  const body = req.body as any;
  const patch: any = {};
  if (typeof body.name === 'string') patch.name = body.name.trim().slice(0, 100);
  if (typeof body.icon === 'string') patch.icon = body.icon.slice(0, 10);
  if (typeof body.description === 'string') patch.description = body.description.trim().slice(0, 500);
  if (typeof body.systemPrompt === 'string') patch.systemPrompt = body.systemPrompt.trim().slice(0, 50000);
  if (typeof body.provider === 'string') patch.provider = body.provider;
  if (typeof body.model === 'string') patch.model = body.model;
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
  if (typeof body.toolsEnabled === 'boolean') patch.toolsEnabled = body.toolsEnabled;
  if (['none', 'read', 'bash', 'full'].includes(body.permission)) patch.permission = body.permission;
  const agent = updateAgent(req.params.id, patch);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json({ agent });
});

app.delete('/api/agents/:id', (req, res) => {
  if (!deleteAgent(req.params.id)) return res.status(404).json({ error: 'Agent not found' });
  res.json({ ok: true });
});

app.get('/api/agents/:id/sessions', (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json({ sessions: listAgentSessions(req.params.id) });
});

app.post('/api/agents/:id/sessions', agentWriteLimiter, (req, res) => {
  const agent = getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  try {
    const session = createAgentSession(req.params.id, (req.body as any)?.name);
    res.json({ session });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Failed to create session' });
  }
});

app.delete('/api/agents/:id/sessions/:chatId', (req, res) => {
  if (!deleteAgentSession(req.params.id, req.params.chatId)) {
    return res.status(404).json({ error: 'Session not found' });
  }
  res.json({ ok: true });
});

app.put('/api/agents/:id/sessions/:chatId', (req, res) => {
  const name = (req.body as any)?.name;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Name is required' });
  }
  const session = renameAgentSession(req.params.id, req.params.chatId, name.trim());
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({ session });
});

// ── Projects API ─────────────────────────────────────────────

// List all projects — served from the TTL cache + singleflight wrapper
// (services/projects-cache.ts) so Dashboard polls never fan out to raw Docker
// listContainers + per-project meta/canvas file I/O per request.
app.get('/api/projects', async (_req, res) => {
  try {
    res.json({ projects: await getCachedProjects() });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Disk-usage visibility (read-only): per-project workspace size, snapshot
// archives, data-directory footprint and Docker-level aggregates. Server-side
// TTL cache + singleflight keep the filesystem/Docker scan to one pass.
app.get('/api/storage', async (req: any, res) => {
  try {
    const fresh = req.query?.fresh === '1' || req.query?.fresh === 'true';
    res.json(await getStorageMetrics({ fresh }));
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to compute storage metrics' });
  }
});

// Disk-usage cleanup (editor+): archive/purge orphaned workspaces, purge
// snapshot archives, remove stale orphan containers, optional Docker build-cache prune.
app.post('/api/storage/cleanup', requireRole('editor'), rateLimit('strict', RATE_WINDOW, RATE_STRICT_MAX), async (req: any, res) => {
  try {
    const docker = req.body?.docker === true;
    res.json(await cleanupStorage({ docker }));
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Cleanup failed' });
  }
});

// ── Trash Bin (./.archive management) ─────────────────────────────
// List archived (deleted-project) workspaces. Read-only, any authenticated role.
app.get('/api/archive', async (req: any, res) => {
  try {
    const fresh = req.query?.fresh === '1' || req.query?.fresh === 'true';
    res.json({ archives: await listArchives(fresh) });
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Failed to list archive' });
  }
});

// Permanently delete a single archive entry (editor+).
app.delete('/api/archive/:entry', requireRole('editor'), rateLimit('strict', RATE_WINDOW, RATE_STRICT_MAX), async (req: any, res) => {
  try {
    await deleteArchive(req.params.entry);
    recordAudit('archive-delete', true, req.ip);
    res.json({ ok: true });
  } catch (err: any) {
    recordAudit('archive-delete', false, req.ip);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Empty the trash: permanently delete every archive entry (editor+).
app.post('/api/archive/empty', requireRole('editor'), rateLimit('strict', RATE_WINDOW, RATE_STRICT_MAX), async (req: any, res) => {
  try {
    const emptied = await emptyTrash();
    recordAudit('archive-empty', true, req.ip);
    res.json({ emptied });
  } catch (err: any) {
    recordAudit('archive-empty', false, req.ip);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Restore an archived project as a NEW live project (editor+).
app.post('/api/archive/:entry/restore', requireRole('editor'), userWriteLimiter, async (req: any, res) => {
  try {
    const { name, description, ports } = req.body || {};
    const project = await restoreArchive(req.params.entry, {
      name,
      description,
      ports,
    }, req.user?.id);
    // The restoring user becomes the owner (matches import/duplicate).
    const userId = req.user?.id;
    if (userId) setArchiveOwner(project.slug, userId);
    recordAudit('archive-restore', true, req.ip);
    res.status(201).json({ project });
  } catch (err: any) {
    recordAudit('archive-restore', false, req.ip);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Create a new project (provisions container + workspace).
app.post('/api/projects', async (req: any, res) => {
  try {
    const { name, slug, description, image, ports, env, limits } = req.body || {};
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Project name is required' });
    }
    const project = await createProject({
      name: String(name).trim(),
      slug,
      description,
      image,
      ports,
      env,
      limits: limits && typeof limits === 'object' && !Array.isArray(limits) ? limits : undefined,
    }, req.user?.id);
    // Set owner to the creating user
    const userId = req.user?.id;
    if (userId) {
      const meta = loadMeta(project.slug) || { activity: [] };
      meta.ownerId = userId;
      meta.members = [{ userId, role: 'admin', addedAt: new Date().toISOString() }];
      saveMeta(project.slug, meta);
    }
    invalidateStorageCache();
    invalidateProjectsCache();
    res.status(201).json({ project });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Duplicate an existing project: new project inheriting image/env/ports,
// plus a copy of the source workspace files and developer notes. Requires
// editor+ access (a viewer remains read-only and cannot forge a writable copy).
app.post('/api/projects/:slug/duplicate', requireProjectAccess('editor'), async (req: any, res) => {
  try {
    const { name, slug, description, ports } = req.body || {};
    // Defense-in-depth: mirror validateProjectSpec's port rules (privileged +
    // reserved + dedup) so the route never relies solely on downstream checks.
    const PORT = Number(process.env.PORT) || 3000;
    const IDE_PORT = Number(process.env.WSD_IDE_PORT) || 8100;
    const OPENCODE_PORT = Number(process.env.WSD_OPENCODE_PORT) || 4096;
    const seen = new Set<number>();
    const cleanPorts =
      Array.isArray(ports)
        ? ports
            .map(Number)
            .filter((n: number) => {
              if (!Number.isInteger(n) || n < 1024 || n > 65535) return false;
              if (n === PORT || n === IDE_PORT || n === OPENCODE_PORT) return false;
              if (seen.has(n)) return false;
              seen.add(n);
              return true;
            })
        : undefined;
    const project = await duplicateProject(req.params.slug, {
      name,
      slug,
      description: description !== undefined ? String(description) : undefined,
      ports: cleanPorts,
    }, req.user?.id);
    // The duplicating user becomes the owner of the copy.
    const userId = req.user?.id;
    if (userId) {
      const meta = loadMeta(project.slug) || { activity: [] };
      meta.ownerId = userId;
      meta.members = [{ userId, role: 'admin', addedAt: new Date().toISOString() }];
      saveMeta(project.slug, meta);
    }
    invalidateStorageCache();
    invalidateProjectsCache();
    res.status(201).json({ project });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Export a project as a downloadable snapshot: tar.gz of workspace + notes +
// meta (name / description / image / ports / env). Editor+ access — a viewer
// is read-only and cannot strip data out of the server.
app.get('/api/projects/:slug/export', requireProjectAccess('editor'), (req: any, res) => {
  let snapshot;
  try {
    snapshot = exportProjectSnapshot(req.params.slug);
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${snapshot.filename}"`);
  snapshot.stream.on('error', (err: any) => {
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.destroy(err);
  });
  snapshot.stream.pipe(res);
  recordAudit('snapshot-export', true, req.ip);
});

// Download the project's workspace as a ZIP archive (editor+ — data leaves
// the server). Same permissiveness as snapshot export; files only, meta is
// NOT baked in (that's what snapshots/tar.gz are for).
app.get('/api/projects/:slug/zip', requireProjectAccess('editor'), (req: any, res) => {
  let zip;
  try {
    zip = exportProjectZip(req.params.slug);
  } catch (err: any) {
    return res.status(err.statusCode || 500).json({ error: err.message });
  }
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zip.filename}"`);
  zip.stream.on('error', (err: any) => {
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.destroy(err);
  });
  zip.stream.pipe(res);
  recordAudit('project-zip', true, req.ip);
});

// Restore a snapshot upload as a NEW project (never overwrites an existing one).
// Editor+ since it creates a project from arbitrary binary input.
app.post('/api/projects/import', requireRole('editor'), upload.single('file'), async (req: any, res) => {
  if (!req.file) return res.status(400).json({ error: 'Please attach a snapshot file (.tar.gz)' });
  try {
    const project = await importProjectSnapshot(req.file.path, req.user?.id);
    // The restoring user becomes the owner of the recreated copy.
    const userId = req.user?.id;
    if (userId) {
      const meta = loadMeta(project.slug) || { activity: [] };
      meta.ownerId = userId;
      meta.members = [{ userId, role: 'admin', addedAt: new Date().toISOString() }];
      saveMeta(project.slug, meta);
    }
    invalidateStorageCache();
    invalidateProjectsCache();
    recordAudit('snapshot-import', true, req.ip);
    res.status(201).json({ project });
  } catch (err: any) {
    recordAudit('snapshot-import', false, req.ip);
    res.status(err.statusCode || 400).json({ error: err.message });
  } finally {
    if (req.file?.path) {
      try {
        fs.rmSync(req.file.path, { force: true });
      } catch {
        /* temp upload cleanup is best-effort */
      }
    }
  }
});

// Get single project
app.get('/api/projects/:slug', requireProjectAccess('viewer'), async (req, res) => {
  try {
    const project = await getProject(req.params.slug);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json({ project });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Project notes (ideas / bugs / goals) — read + full-document save
app.get('/api/projects/:slug/notes', requireProjectAccess('viewer'), (req, res) => {
  try {
    res.json(notes.loadNotes(req.params.slug));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});
app.put('/api/projects/:slug/notes', requireProjectAccess('editor'), (req, res) => {
  try {
    res.json(notes.saveNotes(req.params.slug, req.body));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/projects/:slug/tags', requireProjectAccess('editor'), (req, res) => {
  try {
    const { tags } = req.body || {};
    if (!Array.isArray(tags)) throw new HttpError(400, 'Tags must be an array of strings');
    if (tags.length > 20) throw new HttpError(400, 'Too many tags (max 20)');

    const sanitized = tags
      .map((t) => String(t || '').trim())
      .filter((t) => t.length > 0 && t.length <= 30)
      .filter((t, i, a) => a.indexOf(t) === i);

    const meta = loadMeta(req.params.slug) || { activity: [] };
    meta.tags = sanitized;
    saveMeta(req.params.slug, meta);
    recordAudit('project-tags', true, req.ip);
    res.json({ tags: sanitized });
  } catch (err: any) {
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

// ── Project canvas (visual planning) — read + full-document save ────────
app.get('/api/projects/:slug/canvas', requireProjectAccess('viewer'), (req, res) => {
  try {
    res.json(canvas.loadCanvas(req.params.slug));
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});
app.put('/api/projects/:slug/canvas', requireProjectAccess('editor'), (req, res) => {
  try {
    const doc = canvas.saveCanvas(req.params.slug, req.body);
    recordAudit('canvas-save', true, req.ip);
    res.json(doc);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ── Snapshot automation (scheduled server-side backups) ──────────────
// Sophisticated copy of the manual export/import flow: captures tar.gz
// archives on a per-project schedule, stores them next to the meta store and
// exposes list / config / capture-now / download / delete / restore.

// List stored snapshots (viewer+ — read-only filenames/sizes/timestamps).
app.get('/api/projects/:slug/snapshots', requireProjectAccess('viewer'), (req, res) => {
  try {
    res.json(snapAuto.listSnapshots(req.params.slug));
  } catch (err: any) {
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

// Read a project's schedule (viewer+).
app.get('/api/projects/:slug/snapshots/config', requireProjectAccess('viewer'), (req, res) => {
  try {
    res.json(snapAuto.snapshotConfig(req.params.slug));
  } catch (err: any) {
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

// Update a project's schedule (partial merge: enabled / intervalMin / keep).
app.put('/api/projects/:slug/snapshots/config', requireProjectAccess('editor'), (req, res) => {
  try {
    const cfg = snapAuto.setSnapshotConfig(req.params.slug, (req.body as any) || {});
    recordAudit('snapshot-config-change', true, req.ip);
    if (cfg.enabled) snapAuto.scheduleSnapshotSweep();
    res.json(cfg);
  } catch (err: any) {
    recordAudit('snapshot-config-change', false, req.ip);
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

// Capture a stored snapshot now.
app.post('/api/projects/:slug/snapshots', requireProjectAccess('editor'), userWriteLimiter, async (req, res) => {
  try {
    const snapshot = await snapAuto.captureSnapshot(req.params.slug);
    recordAudit('snapshot-save', true, req.ip);
    res.status(201).json({ snapshot });
  } catch (err: any) {
    recordAudit('snapshot-save', false, req.ip);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Download a stored snapshot archive (editor+ — data leaves the server).
app.get('/api/projects/:slug/snapshots/:file', requireProjectAccess('editor'), (req, res) => {
  let stream;
  try {
    stream = snapAuto.downloadSnapshot(req.params.slug, req.params.file);
  } catch (err: any) {
    return res.status(err.statusCode || 400).json({ error: err.message });
  }
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.file}"`);
  stream.on('error', (err: any) => {
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.destroy(err);
  });
  stream.pipe(res);
  recordAudit('snapshot-download', true, req.ip);
});

// Delete a stored snapshot archive.
app.delete('/api/projects/:slug/snapshots/:file', requireProjectAccess('editor'), (req, res) => {
  try {
    snapAuto.deleteSnapshot(req.params.slug, req.params.file);
    recordAudit('snapshot-delete', true, req.ip);
    res.json({ ok: true });
  } catch (err: any) {
    recordAudit('snapshot-delete', false, req.ip);
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

// Restore a stored snapshot as a NEW project (never overwrites an existing one).
app.post('/api/projects/:slug/snapshots/:file/restore', requireProjectAccess('editor'), async (req: any, res) => {
  try {
    const project = await snapAuto.restoreStoredSnapshot(req.params.slug, req.params.file, req.user?.id);
    const userId = req.user?.id;
    if (userId) {
      const meta = loadMeta(project.slug) || { activity: [] };
      meta.ownerId = userId;
      meta.members = [{ userId, role: 'admin', addedAt: new Date().toISOString() }];
      saveMeta(project.slug, meta);
    }
    invalidateStorageCache();
    invalidateProjectsCache();
    recordAudit('snapshot-restore', true, req.ip);
    res.status(201).json({ project });
  } catch (err: any) {
    recordAudit('snapshot-restore', false, req.ip);
    res.status(err.statusCode || 400).json({ error: err.message });
  }
});

// ── Project membership ────────────────────────────────────────

// List members
app.get('/api/projects/:slug/members', requireProjectAccess('viewer'), async (req: any, res) => {
  try {
    const meta = loadMeta(req.params.slug);
    if (!meta) return res.status(404).json({ error: 'Project not found' });
    const members = meta.members || [];
    // Enrich with usernames
    const enriched = members.map((m) => {
      const info = getUserInfo(m.userId);
      return { ...m, username: info?.username || 'unknown', displayName: info?.profile?.displayName, avatarExt: info?.profile?.avatarExt };
    });
    res.json({ members: enriched });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Add member
app.post('/api/projects/:slug/members', (req: any, res) => {
  try {
    const meta = loadMeta(req.params.slug);
    if (!meta) return res.status(404).json({ error: 'Project not found' });

    const { userId, role } = req.body || {};
    if (!userId || !String(userId).trim()) {
      return res.status(400).json({ error: 'userId is required' });
    }
    const memberRole = ['admin', 'editor', 'viewer'].includes(role) ? role : 'viewer';

    // Only project admins and system admins can add members
    const callerId = req.user?.id;
    const callerRole = req.user?.role;
    const isProjectAdmin = meta.ownerId === callerId || meta.members?.some((m) => m.userId === callerId && m.role === 'admin');
    if (callerRole !== 'admin' && !isProjectAdmin) {
      return res.status(403).json({ error: 'Only project or system admins can add members' });
    }

    // Validate user exists
    const targetUser = getUserInfo(userId);
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!meta.members) meta.members = [];
    const existing = meta.members.find((m) => m.userId === userId);
    let action: 'member-added' | 'member-role-changed' = 'member-added';
    if (existing) {
      existing.role = memberRole;
      action = 'member-role-changed';
    } else {
      meta.members.push({ userId, role: memberRole, addedAt: new Date().toISOString() });
    }
    saveMeta(req.params.slug, meta);
    invalidateProjectsCache();
    recordAudit(action, true, req.ip, userId);
    res.json({ member: { userId, role: memberRole } });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Remove member
app.delete('/api/projects/:slug/members/:userId', (req: any, res) => {
  try {
    const meta = loadMeta(req.params.slug);
    if (!meta) return res.status(404).json({ error: 'Project not found' });

    const targetUserId = req.params.userId;
    const callerId = req.user?.id;
    const callerRole = req.user?.role;
    const isProjectAdmin = meta.ownerId === callerId || meta.members?.some((m) => m.userId === callerId && m.role === 'admin');

    // Users can remove themselves; otherwise must be admin
    if (callerId !== targetUserId && callerRole !== 'admin' && !isProjectAdmin) {
      return res.status(403).json({ error: 'Not authorized to remove this member' });
    }

    // Can't remove the owner
    if (targetUserId === meta.ownerId) {
      return res.status(400).json({ error: 'Cannot remove the project owner' });
    }

    if (!meta.members) meta.members = false as any;
    const before = meta.members?.length || 0;
    meta.members = (meta.members || []).filter((m) => m.userId !== targetUserId);
    if (meta.members.length === before) {
      return res.status(404).json({ error: 'Member not found' });
    }
    saveMeta(req.params.slug, meta);
    invalidateProjectsCache();
    recordAudit('member-removed', true, req.ip, targetUserId);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Transfer ownership
app.post('/api/projects/:slug/transfer-owner', (req: any, res) => {
  try {
    const meta = loadMeta(req.params.slug);
    if (!meta) return res.status(404).json({ error: 'Project not found' });

    const { userId } = req.body || {};
    const callerId = req.user?.id;
    if (callerId !== meta.ownerId && req.user?.role !== 'admin') {
      return res.status(403).json({ error: 'Only the owner or a system admin can transfer ownership' });
    }

    const targetUser = getUserInfo(userId);
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Ensure target is a member with admin role
    if (!meta.members) meta.members = [];
    let targetMember = meta.members.find((m) => m.userId === userId);
    if (!targetMember) {
      meta.members.push({ userId, role: 'admin', addedAt: new Date().toISOString() });
    } else {
      targetMember.role = 'admin';
    }

    meta.ownerId = userId;
    saveMeta(req.params.slug, meta);
    invalidateProjectsCache();
    recordAudit('ownership-transferred', true, req.ip, userId);
    res.json({ ok: true, ownerId: userId });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Project presence (who's online)
app.get('/api/projects/:slug/presence', requireProjectAccess('viewer'), (req, res) => {
  const users = getPresence(req.params.slug);
  res.json({ users });
});

// Manually dismiss the crash badge (editor+) — clears meta.crash so the red
// chip/banner goes away without restarting the container.
app.post('/api/projects/:slug/crash-clear', requireProjectAccess('editor'), userWriteLimiter, async (req, res) => {
  try {
    if (!loadMeta(req.params.slug)) {
      return res.status(404).json({ error: 'Project not found' });
    }
    await manualClearCrash(req.params.slug);
    invalidateProjectsCache();
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Start project
app.post('/api/projects/:slug/start', requireProjectAccess('editor'), async (req: any, res) => {
  try {
    const project = await startProject(req.params.slug, req.user?.id);
    res.json({ project });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Stop project
app.post('/api/projects/:slug/stop', requireProjectAccess('editor'), async (req: any, res) => {
  try {
    const project = await stopProject(req.params.slug, req.user?.id);
    res.json({ project });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Remove project — container, meta store AND workspace files from disk.
app.delete('/api/projects/:slug', requireProjectAccess('admin'), rateLimit('strict', RATE_WINDOW, RATE_STRICT_MAX), async (req, res) => {
  try {
    await removeProject(req.params.slug);
    invalidateStorageCache();
    invalidateProjectsCache();
    recordAudit('project-files-deleted', true, req.ip);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ── Notifications / Webhooks (admin) ────────────────────────
// Lifecycle + crash events fire to external URLs. Secrets are masked in
// every response (`hasSecret`); config writes are audited.

app.get('/api/webhooks', requireAdmin, (_req, res) => {
  res.json({ webhooks: listWebhooks().map(toPublic) });
});

app.post('/api/webhooks', requireAdmin, (req: any, res) => {
  try {
    const webhook = createWebhook((req.body as any) || {});
    recordAudit('webhook-config-change', true, req.ip);
    res.status(201).json({ webhook: toPublic(webhook) });
  } catch (err: any) {
    res.status(err.statusCode || err.status || 400).json({ error: err.message });
  }
});

app.put('/api/webhooks/:id', requireAdmin, (req: any, res) => {
  try {
    const webhook = updateWebhook(String(req.params.id), (req.body as any) || {});
    if (!webhook) return res.status(404).json({ error: 'Webhook not found' });
    recordAudit('webhook-config-change', true, req.ip);
    res.json({ webhook: toPublic(webhook) });
  } catch (err: any) {
    res.status(err.statusCode || err.status || 400).json({ error: err.message });
  }
});

app.delete('/api/webhooks/:id', requireAdmin, (req: any, res) => {
  try {
    const ok = deleteWebhook(String(req.params.id));
    if (!ok) return res.status(404).json({ error: 'Webhook not found' });
    recordAudit('webhook-config-change', true, req.ip);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(err.statusCode || err.status || 400).json({ error: err.message });
  }
});

// Manual "Test" — awaited so the admin sees a real success/failure. Accepts a
// saved webhook id OR a raw URL (pre-validate a Slack hook before saving).
app.post('/api/webhooks/test', requireAdmin, rateLimit('strict', RATE_WINDOW, RATE_STRICT_MAX), async (req: any, res) => {
  try {
    const { id, url } = (req.body as any) || {};
    let webhook: { url: string; secret?: string } | null = null;
    if (id) {
      webhook = getWebhook(String(id));
      if (!webhook) return res.status(404).json({ error: 'Webhook not found' });
    } else if (url) {
      webhook = { url: String(url) };
    }
    if (!webhook) return res.status(400).json({ error: 'Provide a webhook id or URL to test' });
    const result = await sendWebhook(webhook, {
      event: 'test',
      at: new Date().toISOString(),
      project: 'Madar — webhook test',
    });
    if (!result.ok) {
      return res.status(result.status || 502).json(result.error ? { ...result, error: result.error } : result);
    }
    recordAudit('webhook-send', true, req.ip);
    res.json(result);
  } catch (err: any) {
    res.status(err.statusCode || err.status || 400).json({ error: err.message });
  }
});

// Open a project in opencode (ensures registration + a session exists) so the
// opencode page's project picker can land the user on the right workspace.
// Require viewer access to the requested slug — a viewer must not be able to
// force-register/seed a project they cannot see. NOTE: requireProjectAccess()
// is param-based (req.params.slug) but this route carries the slug in the
// BODY, so we gate explicitly — the middleware would 400 everyone.
app.post('/api/opencode/open', async (req: any, res) => {
  try {
    const slug = String(req.body?.slug || '');
    if (!slug) return res.status(400).json({ error: 'Project slug required' });
    const { allowed } = checkProjectAccess(req.user.id, req.user.role, slug, 'viewer');
    if (!allowed) return res.status(403).json({ error: 'Access denied to this project' });
    const info = await getProject(slug);
    if (!info) return res.status(404).json({ error: 'Project not found' });
    ensureOpencodeSession(slug);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ── Opencode Studio: subagents / skills / config CRUD + update ──────────

app.get('/api/opencode-studio/agents', (_req, res) => {
  res.json({ agents: studio.listAgents() });
});

app.get('/api/opencode-studio/agents/:name', (req, res) => {
  try {
    res.json(studio.getAgent(String(req.params.name)));
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.post('/api/opencode-studio/agents/:name', (req, res) => {
  try {
    const content = String(req.body?.content ?? '');
    if (!content.trim()) return res.status(400).json({ error: 'Agent content is required' });
    studio.saveAgent(String(req.params.name), content);
    recordAudit('opencode-studio', true);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.delete('/api/opencode-studio/agents/:name', (req, res) => {
  try {
    studio.deleteAgent(String(req.params.name));
    res.json({ ok: true });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.get('/api/opencode-studio/skills', (_req, res) => {
  res.json({ skills: studio.listSkills() });
});

app.get('/api/opencode-studio/skills/:name', (req, res) => {
  try {
    res.json(studio.getSkill(String(req.params.name)));
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.post('/api/opencode-studio/skills/:name', (req, res) => {
  try {
    const content = String(req.body?.content ?? '');
    if (!content.trim()) return res.status(400).json({ error: 'Skill content is required' });
    studio.saveSkill(String(req.params.name), content);
    recordAudit('opencode-studio', true);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.delete('/api/opencode-studio/skills/:name', (req, res) => {
  try {
    studio.deleteSkill(String(req.params.name));
    res.json({ ok: true });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.get('/api/opencode-studio/commands', (_req, res) => {
  res.json({ commands: studio.listCommands() });
});

app.get('/api/opencode-studio/commands/:name', (req, res) => {
  try {
    res.json(studio.getCommand(String(req.params.name)));
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.post('/api/opencode-studio/commands/:name', (req, res) => {
  try {
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    studio.saveCommand(String(req.params.name), content);
    recordAudit('opencode-studio', true);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.delete('/api/opencode-studio/commands/:name', (req, res) => {
  try {
    studio.deleteCommand(String(req.params.name));
    res.json({ ok: true });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.get('/api/opencode-studio/config', (_req, res) => {
  res.json(studio.getConfig());
});

app.put('/api/opencode-studio/config', (req, res) => {
  try {
    res.json(studio.updateConfig(req.body));
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.get('/api/opencode-studio/version', async (_req, res) => {
  try {
    res.json(await studio.getVersionInfo());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/opencode-studio/update', async (_req, res) => {
  try {
    res.json(await studio.runUpdate());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Project container logs
app.get('/api/projects/:slug/logs', requireProjectAccess('viewer'), async (req, res) => {
  try {
    const tail = Number(req.query.tail) || 200;
    const logs = await projectLogs(req.params.slug, tail);
    res.json({ logs });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Upload files into an existing project workspace (files only, no archives)
app.post('/api/projects/:slug/upload', requireProjectAccess('editor'), (req, res) => {
  const slug = String(req.params.slug || '').trim();
  const base = path.resolve(path.join(WORKSPACES_ROOT, slug));
  if (!fs.existsSync(base)) {
    return res.status(404).json({ error: `Project workspace '${slug}' not found` });
  }

  upload.array('files', 50)(req, res, (err: any) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    const files = (req.files || []) as Express.Multer.File[];
    if (files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const saved: { name: string; path: string }[] = [];
    for (const file of files) {
      const rel = normalizeUploadPath((req.body as any)?.paths?.[file.originalname] || file.originalname);
      if (!rel) continue;
      const target = uniqueTargetPath(base, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(file.path, target);
      fs.unlinkSync(file.path);
      saved.push({ name: file.originalname, path: path.relative(base, target).split(path.sep).join('/') });
    }
    res.status(201).json({ ok: true, files: saved });
  });
});

// Edit project metadata (name / description)
app.patch('/api/projects/:slug', requireProjectAccess('editor'), async (req: any, res) => {
  try {
    const project = await getProject(req.params.slug);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const { name, description } = req.body || {};
    const meta = loadMeta(project.slug) || { activity: [] };
    if (typeof name === 'string' && name.trim()) meta.name = name.trim().slice(0, 100);
    if (typeof description === 'string') meta.description = description.trim().slice(0, 2000);
    meta.activity = [
      ...(meta.activity || []),
      { action: 'updated', at: new Date().toISOString(), ...(req.user?.id ? { userId: req.user?.id } : {}) },
    ].slice(-200);
    saveMeta(project.slug, meta);
    res.json({ project: await getProject(project.slug) });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Recreate the container from stored meta (image / ports / env)
app.post('/api/projects/:slug/recreate', requireProjectAccess('editor'), async (req: any, res) => {
  try {
    const project = await getProject(req.params.slug);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const recreated = await recreateProject(project.slug, req.user?.id);
    res.json({ project: recreated });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Set project environment variables (applied on recreate)
app.put('/api/projects/:slug/env', requireProjectAccess('editor'), async (req, res) => {
  try {
    const project = await getProject(req.params.slug);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const rawEnv = (req.body || {}).env || {};
    const clean: Record<string, string> = {};
    if (typeof rawEnv === 'object' && rawEnv !== null) {
      for (const [k, v] of Object.entries(rawEnv)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
        if (typeof v === 'string' && v.length <= 4000) clean[k] = v;
      }
    }
    const meta = loadMeta(project.slug) || { activity: [] };
    meta.env = clean;
    meta.activity = [
      ...(meta.activity || []),
      { action: 'env_updated', at: new Date().toISOString() },
    ].slice(-200);
    saveMeta(project.slug, meta);
    res.json({ env: clean, needsRecreate: project.status === 'running' });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Set project published ports (validated + conflict-checked, applied on recreate)
app.put('/api/projects/:slug/ports', requireProjectAccess('editor'), async (req, res) => {
  try {
    if (!Array.isArray((req.body || {}).ports)) {
      throw new HttpError(400, 'ports must be an array of integers');
    }
    const clean = validatePortSet(req.body.ports, { max: 50 });
    const result = await updateProjectPorts(req.params.slug, clean);
    recordAudit('project-ports', true, req.ip);
    res.json({ ports: result.project.ports, needsRecreate: result.needsRecreate });
  } catch (err: any) {
    recordAudit('project-ports', false, req.ip);
    res.status(err.statusCode || 500).json({ error: err.message, ...(err.taken ? { taken: err.taken } : {}) });
  }
});

// Set project resource limits (CPU / memory — applied on recreate).
// Partial-update contract: only keys present in the body change; `null`
// clears; omitted keys survive untouched.
app.put('/api/projects/:slug/limits', requireProjectAccess('editor'), async (req, res) => {
  try {
    const raw = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const patch: Partial<ProjectLimits> = {};
    if ('cpu' in raw) patch.cpu = raw.cpu;
    if ('memory' in raw) patch.memory = raw.memory;
    const result = await updateProjectLimits(req.params.slug, patch);
    recordAudit('project-limits', true, req.ip);
    res.json({ limits: result.limits, needsRecreate: result.needsRecreate });
  } catch (err: any) {
    recordAudit('project-limits', false, req.ip);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ── Static-site serve (python3 http.server inside the container) ──────
// Persisted per-project toggle (meta.serve); runs `python3 -m http.server
// <port> -d /workspace` so static workspace files are reachable over HTTP.
// Auto re-runs after container start/recreate via ensureServeRunning.

// Read the honest serve state (config + a live probe when running).
app.get('/api/projects/:slug/serve', requireProjectAccess('viewer'), async (req, res) => {
  try {
    res.json({ serve: await serveStatus(req.params.slug) });
  } catch (err: any) {
    res.status(err.statusCode || 404).json({ error: err.message });
  }
});

// Start serving on a given (or defaulted) published port.
app.post('/api/projects/:slug/serve', requireProjectAccess('editor'), userWriteLimiter, async (req: any, res) => {
  try {
    const meta = loadMeta(req.params.slug);
    if (!meta) return res.status(404).json({ error: 'Project not found' });
    const { port } = (req.body as any) || {};
    const cfg = sanitizeServeConfig({ enabled: true, port }, meta.serve, meta.ports || []);
    const serve = await startServeProcess(req.params.slug, cfg.port!, String(cfg.port));
    recordAudit('serve-start', true, req.ip);
    res.json({ serve });
  } catch (err: any) {
    recordAudit('serve-start-failed', false, req.ip);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Stop serving (keeps config for UX memory, enabled=false).
app.post('/api/projects/:slug/serve/stop', requireProjectAccess('editor'), userWriteLimiter, async (req, res) => {
  try {
    const serve = await stopServeProcess(req.params.slug);
    recordAudit('serve-stop', true, req.ip);
    res.json({ serve });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// git clone into the workspace
app.post('/api/projects/:slug/clone', requireProjectAccess('editor'), async (req: any, res) => {
  try {
    const { url } = req.body || {};
    if (!url || !String(url).trim()) {
      return res.status(400).json({ error: 'Git repository URL is required' });
    }
    const result = await cloneIntoWorkspace(req.params.slug, url, req.user?.id);
    res.status(201).json(result);
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Runtime stats (CPU / memory / uptime)
app.get('/api/projects/:slug/stats', requireProjectAccess('viewer'), async (req, res) => {
  try {
    res.json({ stats: await getProjectStats(req.params.slug) });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// HTTP health check for each published port
app.get('/api/projects/:slug/ports/check', requireProjectAccess('viewer'), async (req, res) => {
  try {
    res.json({ checks: await checkProjectPorts(req.params.slug) });
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ── Project workspace files ───────────────────────────────────
app.get('/api/projects/:slug/files', requireProjectAccess('viewer'), (req, res) => {
  try {
    const listing = listWorkspaceFiles(req.params.slug, String(req.query.path || '').trim() || undefined);
    res.json(listing);
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.get('/api/projects/:slug/file', requireProjectAccess('viewer'), (req, res) => {
  try {
    const rel = String(req.query.path || '').trim();
    if (!rel) return res.status(400).json({ error: 'Missing path query' });
    res.json(readWorkspaceFile(req.params.slug, rel));
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Stream a workspace file's raw bytes (images, binaries, downloads).
app.get('/api/projects/:slug/file/raw', requireProjectAccess('viewer'), (req, res) => {
  try {
    const rel = String(req.query.path || '').trim();
    if (!rel) return res.status(400).json({ error: 'Missing path query' });
    const { stream, size, mime } = streamWorkspaceFile(req.params.slug, rel);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', String(size));
    if (req.query.download === '1') {
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(path.basename(rel))}"`);
    }
    stream.on('error', () => res.destroy());
    stream.on('open', () => stream.pipe(res));
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.delete('/api/projects/:slug/file', requireProjectAccess('editor'), (req, res) => {
  try {
    const rel = String(req.query.path || '').trim();
    if (!rel) return res.status(400).json({ error: 'Missing path query' });
    res.json(deleteWorkspacePath(req.params.slug, rel));
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Create or overwrite a text file in the workspace
app.put('/api/projects/:slug/file', requireProjectAccess('editor'), (req, res) => {
  try {
    const rel = String(req.query.path || '').trim();
    if (!rel) return res.status(400).json({ error: 'Missing path query' });
    const content = (req.body || {}).content;
    res.json(writeWorkspaceFile(req.params.slug, rel, typeof content === 'string' ? content : ''));
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// Rename/move a file or directory within the workspace
app.post('/api/projects/:slug/file/rename', requireProjectAccess('editor'), (req, res) => {
  try {
    const from = String((req.body || {}).from || '').trim();
    const to = String((req.body || {}).to || '').trim();
    if (!from || !to) return res.status(400).json({ error: 'from and to are required' });
    res.json(renameWorkspacePath(req.params.slug, from, to));
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ── npm scripts ───────────────────────────────────────────────
app.get('/api/projects/:slug/scripts', requireProjectAccess('viewer'), (req, res) => {
  try {
    const base = path.resolve(WORKSPACES_ROOT, String(req.params.slug || '').trim());
    const pkgPath = path.join(base, 'package.json');
    if (!fs.existsSync(pkgPath)) return res.json({ scripts: {} });
    let pkg: any = {};
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    } catch {
      /* invalid json — treat as no scripts */
    }
    res.json({ scripts: pkg?.scripts || {} });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/projects/:slug/scripts/run', requireProjectAccess('editor'), rateLimit('strict', RATE_WINDOW, RATE_STRICT_MAX), async (req, res) => {
  try {
    const name = String((req.body || {}).script || '').trim();
    if (!/^[A-Za-z0-9:_-]{1,64}$/.test(name)) {
      return res.status(400).json({ error: 'Invalid script name' });
    }
    res.json(await runProjectScript(req.params.slug, name));
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

app.get('/api/projects/:slug/subdir', requireProjectAccess('viewer'), (req, res) => {
  try {
    const info = resolveProjectSubdir(req.params.slug);
    res.json(info);
  } catch (err: any) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

/**
 * Resolve a target path inside the workspace; if a file already exists there,
 * append a numeric suffix before the extension so re-uploads never overwrite.
 */
function uniqueTargetPath(base: string, rel: string): string {
  const target = path.resolve(base, rel);
  if (!target.startsWith(base)) return path.join(base, path.basename(rel));
  if (!fs.existsSync(target)) return target;

  const ext = path.extname(target);
  const stem = path.join(path.dirname(target), path.basename(target, ext));
  for (let i = 1; i < 1000; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

/**
 * Keep upload paths inside the project workspace; strips leading slashes,
 * resolves '..' segments safely, and falls back to the bare filename.
 */
function normalizeUploadPath(raw: string): string | null {
  const value = String(raw ?? '').trim();
  const clean = value.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || clean === '.') return null;
  if (clean.startsWith('..') || clean.includes('/../') || clean.endsWith('/..')) return null;
  return clean.slice(0, 1024);
}

// ── Serve frontend static build if present ───────────────────
const frontendDist = path.join(__dirname, '..', '..', 'frontend', 'dist');
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist, {
    maxAge: '7d',
    immutable: true,
    setHeaders(res, filePath) {
      // index.html must always revalidate — it's the SPA entry point that
      // references hashed Vite assets under /assets/*.
      if (filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }));
  // SPA fallback — catch-all (Express 5 compatible)
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
  console.log(`[Madar] Serving frontend from ${frontendDist}`);
}

// ── Error handler ────────────────────────────────────────────
app.use((err: any, _req: any, res: any, next: any) => {
  if (res.headersSent) return next(err);
  if (err instanceof HttpError) {
    return res.status(err.statusCode).json({ error: err.message });
  }
  // body-parser rejections (malformed JSON / non-object JSON payloads) are
  // client errors — surface them as 400, not 500.
  if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') {
    return res.status(400).json({ error: err.type === 'entity.parse.failed' ? 'Invalid JSON body' : 'Request body too large' });
  }
  // multer rejections (oversized uploads, unexpected fields) are client errors.
  if (typeof err?.code === 'string' && err.code.startsWith('LIMIT_')) {
    return res.status(400).json({ error: 'Upload rejected' });
  }
  console.error('[Madar] Unhandled error:', err?.stack || err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ────────────────────────────────────────────────────
const server = http.createServer(app);
attachWebSockets(server);

server.listen(PORT, HOST, () => {
  console.log(`[Madar] Dashboard on http://${HOST}:${PORT}`);
  console.log(`[Madar] WebSocket hub on ws://${HOST}:${PORT}/ws`);
  console.log(`[Madar] Workspaces root: ${WORKSPACES_ROOT}`);
  console.log(`[Madar] opencode web on port ${OPENCODE_PORT}`);
  console.log(`[Madar] Chat model: ${getChatConfig().model}`);
  console.log(`[Madar] Docker socket: /var/run/docker.sock`);
});

// Automatic orphaned-workspace cleanup (boot + every WSD_JANITOR_INTERVAL_MS).
startJanitor();

// Per-project automated snapshot captures (boot + every WSD_SNAPSHOT_SWEEP_MS).
snapAuto.startSnapshotAutomation();

// Container-crash detection (boot + every WSD_ALERT_SWEEP_MS) — WebSocket-
// independent, so crashes are caught even with zero browsers connected.
startAlertsAutomation();






