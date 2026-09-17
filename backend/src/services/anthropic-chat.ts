/**
 * anthropic-chat.ts
 * Madar — Streaming chat against the Anthropic Messages API
 * (POST {baseUrl}/v1/messages, SSE with content_block_delta events).
 * Auth uses x-api-key + anthropic-version headers.
 */

import { consumeLines } from './stream-lines';
import type { ProviderEndpoint } from './chat-config';
import type { ChatMessage, StreamHandlers, RunControl } from './chat-types';

const ANTHROPIC_VERSION = '2023-06-01';
const MAX_TOKENS = 8192;

function parseImage(dataUrl: string): { media_type: string; data: string } {
  const comma = dataUrl.indexOf(',');
  const header = comma >= 0 ? dataUrl.slice(0, comma) : '';
  const raw = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const mime = /data:([^;]+)/.exec(header)?.[1] || 'image/png';
  return { media_type: mime, data: raw };
}

function toAnthropicContent(msg: ChatMessage): string | unknown[] {
  if (!msg.images || msg.images.length === 0) return msg.content;
  const parts: unknown[] = [{ type: 'text', text: msg.content }];
  for (const img of msg.images) {
    parts.push({ type: 'image', source: { type: 'base64', ...parseImage(img) } });
  }
  return parts;
}

export async function streamChatAnthropic(
  ep: ProviderEndpoint,
  model: string,
  temperature: number,
  system: string,
  messages: ChatMessage[],
  handlers: StreamHandlers,
  control: RunControl
): Promise<string> {
  const body = JSON.stringify({
    model,
    max_tokens: MAX_TOKENS,
    temperature,
    system,
    messages: messages.map((m) => ({ role: m.role, content: toAnthropicContent(m) })),
    stream: true,
  });

  const controller = new AbortController();
  control.abort = () => controller.abort();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': ep.apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
  };

  let full = '';
  try {
    const res = await fetch(`${ep.baseUrl}/v1/messages`, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `${ep.baseUrl} request failed (HTTP ${res.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`
      );
    }

    await consumeLines(res.body, (line) => {
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      try {
        const parsed = JSON.parse(payload);
        if (parsed?.type === 'content_block_delta' && parsed?.delta?.type === 'text_delta') {
          const delta: string = parsed.delta.text || '';
          if (delta) {
            full += delta;
            handlers.onDelta(delta);
          }
        }
      } catch {
        // skip malformed line
      }
    });

    if (control.cancelled) throw new Error('Chat stopped');
    await handlers.onDone(full);
    return full;
  } catch (err: any) {
    if (control.cancelled) throw new Error('Chat stopped');
    if (err?.name === 'AbortError') throw new Error('Chat stopped');
    handlers.onError(err?.message || String(err));
    throw err;
  } finally {
    control.abort = null;
  }
}
