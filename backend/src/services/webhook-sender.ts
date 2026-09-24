/**
 * webhook-sender.ts
 * Madar — Outbound webhook delivery (fire-and-forget for background events,
 * awaited for the manual "Test" endpoint so admins see a real result).
 *
 * Each POST carries the event payload as flat JSON. When the webhook has a
 * signing secret, an HMAC-SHA256 signature is added over the raw body:
 *   X-Madar-Signature: sha256=<hex>
 *   X-Madar-Timestamp: <unix>
 * so receivers can verify authenticity/integrity without TLS trust alone.
 *
 * Delivery is bounded (5s AbortSignal timeout), never retried, and never
 * allowed to block the crash detector or lifecycle paths. Webhook URLs are
 * guarded by the same SSRF check as provider hosts.
 */
import { createHmac } from 'crypto';
import { recordAudit } from './audit-store';
import { assertFetchableHost } from './providers-detect';
import { webhooksForEvent, type Webhook, type WebhookEvent } from './webhooks-store';

/** The update-event subset of the webhook whitelist (store owns the full list). */
export type UpdateWebhookEvent = Extract<WebhookEvent, `update-${string}`>;

const TIMEOUT_MS = 5000;

export interface WebhookPayload {
  event: string;
  at: string;
  [k: string]: unknown;
}

export interface WebhookSendResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/** Send one webhook POST. `audit: false` silences audit (test-probe reuse). */
export async function sendWebhook(
  w: Pick<Webhook, 'url' | 'secret'>,
  payload: WebhookPayload,
  opts?: { audit?: boolean }
): Promise<WebhookSendResult> {
  const doAudit = opts?.audit ?? true;
  try {
    assertFetchableHost(w.url);
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'Madar/BETA',
    };
    if (w.secret) {
      headers['X-Madar-Timestamp'] = String(Math.floor(Date.now() / 1000));
      headers['X-Madar-Signature'] = `sha256=${createHmac('sha256', w.secret).update(body).digest('hex')}`;
    }
    const res = await fetch(w.url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (doAudit) recordAudit(res.ok ? 'webhook-send' : 'webhook-send-failed', res.ok);
    return res.ok
      ? { ok: true, status: res.status }
      : { ok: false, status: res.status, error: `HTTP ${res.status}` };
  } catch (err: any) {
    if (doAudit) recordAudit('webhook-send-failed', false);
    return { ok: false, error: err?.message || 'Webhook delivery failed' };
  }
}

/**
 * Fire an event to every enabled webhook subscribed to it. Non-blocking:
 * each send runs in its own detached promise with its own error swallow, so
 * a dead endpoint can never stall a sweep or a lifecycle write.
 */
export function dispatchWebhook(event: WebhookEvent, payload: WebhookPayload): void {
  for (const w of webhooksForEvent(event)) {
    void sendWebhook(w, payload).catch(() => {
      /* sendWebhook never throws — defensive only */
    });
  }
}

/** Flat payload shape for component-update events (see dispatchUpdateEvent). */
export interface UpdateEventInfo {
  component: 'opencode' | 'code-server';
  phase: 'start' | 'ok' | 'failed' | 'rolled-back' | 'rollback-failed';
  /** Running (start) or baseline (terminal) version, null when unknown. */
  from?: string | null;
  /** Target version on start, installed version on success; absent on failures. */
  to?: string;
  /** Persisted error string for failed phases. */
  error?: string;
}

/**
 * Fire a component-update event (update-started/update-ok/update-failed/
 * update-rolled-back/update-rollback-failed) with the flat payload Madar
 * webhooks use everywhere (`event` + `at` + one field per fact, no nesting).
 * Same fire-and-forget semantics as dispatchWebhook — only webhooks with the
 * event ticked receive it, so a Slack/Discord receiver subscribed to just
 * `update-failed` never sees the routine started/ok traffic.
 */
export function dispatchUpdateEvent(event: UpdateWebhookEvent, info: UpdateEventInfo): void {
  dispatchWebhook(event, {
    event,
    component: info.component,
    phase: info.phase,
    at: new Date().toISOString(),
    ...(info.from !== undefined ? { from: info.from } : {}),
    ...(info.to !== undefined ? { to: info.to } : {}),
    ...(info.error !== undefined ? { error: info.error } : {}),
  });
}