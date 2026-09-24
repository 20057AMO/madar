/**
 * webhooks-store.ts
 * Madar — Durable webhook configuration (data/webhooks.json).
 * Webhooks fire lifecycle + crash events to external URLs (Slack/Discord/
 * Telegram/status pages). URLs are validated with the same SSRF guard used
 * for provider hosts; each webhook may carry an optional HMAC signing secret.
 *
 * NOTE (secret handling): the optional signing secret is stored in plaintext
 * next to the URL under data/ with mode 0600, like users.json. It is masked
 * in every API response (`hasSecret`) and stripped from settings backups —
 * it never leaves the server in the clear.
 */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { assertFetchableHost } from './providers-detect';

const DATA_DIR = process.env.WSD_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const WEBHOOKS_FILE = path.join(DATA_DIR, 'webhooks.json');
const MAX_WEBHOOKS = 50;
const MAX_SECRET_LEN = 256;

export const WEBHOOK_EVENTS = [
  'crash',
  'created',
  'started',
  'stopped',
  'recreated',
  'deleted',
  'snapshot-saved',
  'update-started',
  'update-ok',
  'update-failed',
  'update-rolled-back',
  'update-rollback-failed',
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export interface Webhook {
  id: string;
  name: string;
  url: string;
  events: WebhookEvent[];
  enabled: boolean;
  secret?: string;
  createdAt: string;
  updatedAt: string;
}

/** API-facing shape — the signing secret is never echoed. */
export type WebhookPublic = Omit<Webhook, 'secret'> & { hasSecret: boolean };

export interface WebhookInput {
  name?: string;
  url?: string;
  events?: string[];
  enabled?: boolean;
  /** '' clears the secret; a value sets it; undefined/omitted = unchanged. */
  secret?: string;
}

function err400(message: string): Error & { statusCode: number; status: number } {
  return Object.assign(new Error(message), { statusCode: 400, status: 400 });
}

function loadWebhooks(): Webhook[] {
  try {
    if (!fs.existsSync(WEBHOOKS_FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(WEBHOOKS_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveWebhooks(webhooks: Webhook[]): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(WEBHOOKS_FILE, JSON.stringify(webhooks, null, 2), { encoding: 'utf8', mode: 0o600 });
}

/** Whitelist events; junk entries are dropped, a fully-junk set falls back to ['crash']. */
function sanitizeEvents(raw: string[] | undefined): WebhookEvent[] {
  const events = (Array.isArray(raw) ? raw : [])
    .map((e) => String(e))
    .filter((e): e is WebhookEvent => (WEBHOOK_EVENTS as readonly string[]).includes(e));
  return events.length > 0 ? [...new Set(events)] : ['crash'];
}

function assertWebhookUrl(url: string): void {
  try {
    assertFetchableHost(url);
  } catch {
    throw err400('Webhook URL must use http(s) and must not point at cloud-metadata endpoints');
  }
}

function validateSecret(secret: string | undefined): string | undefined {
  if (secret === undefined || secret === null) return undefined;
  const s = String(secret).trim();
  if (s === '') return undefined;
  if (s.length > MAX_SECRET_LEN) throw err400('Webhook signing secret is too long (max 256 chars)');
  return s;
}

export function toPublic(w: Webhook): WebhookPublic {
  const { secret, ...rest } = w;
  return { ...rest, hasSecret: !!secret };
}

export function listWebhooks(): Webhook[] {
  return loadWebhooks();
}

export function getWebhook(id: string): Webhook | null {
  return loadWebhooks().find((w) => w.id === id) || null;
}

/** Enabled webhooks subscribed to an event — used by the background sender. */
export function webhooksForEvent(event: WebhookEvent): Webhook[] {
  return loadWebhooks().filter((w) => w.enabled && w.events.includes(event));
}

export function createWebhook(input: WebhookInput): Webhook {
  const name = String(input.name ?? '').trim();
  if (!name) throw err400('Webhook name is required');
  const url = String(input.url ?? '').trim();
  if (!url) throw err400('Webhook URL is required');
  assertWebhookUrl(url);
  const all = loadWebhooks();
  if (all.length >= MAX_WEBHOOKS) throw err400(`Too many webhooks (max ${MAX_WEBHOOKS})`);
  const secret = validateSecret(input.secret);
  const now = new Date().toISOString();
  const webhook: Webhook = {
    id: randomUUID(),
    name,
    url,
    events: sanitizeEvents(input.events),
    enabled: input.enabled !== false,
    createdAt: now,
    updatedAt: now,
  };
  if (secret) webhook.secret = secret;
  all.push(webhook);
  saveWebhooks(all);
  return webhook;
}

/** Partial update: only explicitly-provided fields change; omitted survive. */
export function updateWebhook(id: string, input: WebhookInput): Webhook | null {
  const all = loadWebhooks();
  const idx = all.findIndex((w) => w.id === id);
  if (idx < 0) return null;
  const w = all[idx];
  if (input.name !== undefined) {
    const name = String(input.name).trim();
    if (!name) throw err400('Webhook name is required');
    w.name = name;
  }
  if (input.url !== undefined) {
    const url = String(input.url).trim();
    if (!url) throw err400('Webhook URL is required');
    assertWebhookUrl(url);
    w.url = url;
  }
  if (input.events !== undefined) w.events = sanitizeEvents(input.events);
  if (input.enabled !== undefined) w.enabled = !!input.enabled;
  if (input.secret !== undefined) {
    const s = validateSecret(input.secret);
    if (s) w.secret = s;
    else delete w.secret;
  }
  w.updatedAt = new Date().toISOString();
  saveWebhooks(all);
  return w;
}

export function deleteWebhook(id: string): boolean {
  const all = loadWebhooks();
  const next = all.filter((w) => w.id !== id);
  if (next.length === all.length) return false;
  saveWebhooks(next);
  return true;
}