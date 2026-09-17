/**
 * openai-chat.ts
 * Madar — Streaming chat against any OpenAI-compatible endpoint
 * (OpenAI, OpenRouter, Groq, DeepSeek, Mistral, Together, xAI, HuggingFace,
 * Fireworks, Google AI Studio via its official OpenAI-compatible API, …).
 * Streams POST {baseUrl}/chat/completions (SSE). No SDK required.
 */

import { consumeLines } from './stream-lines';
import { AZURE_API_VERSION } from './provider-store';
import type { ProviderEndpoint } from './chat-config';
import type { ChatMessage, StreamHandlers, RunControl } from './chat-types';

function toOpenAIContent(msg: ChatMessage): string | unknown[] {
  if (!msg.images || msg.images.length === 0) return msg.content;
  const parts: unknown[] = [{ type: 'text', text: msg.content }];
  for (const img of msg.images) {
    parts.push({ type: 'image_url', image_url: { url: img } });
  }
  return parts;
}

export async function streamChatOpenAI(
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
    messages: [
      { role: 'system', content: system },
      ...messages.map((m) => ({ role: m.role, content: toOpenAIContent(m) })),
    ],
    stream: true,
    temperature,
  });

  const controller = new AbortController();
  control.abort = () => controller.abort();

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ep.apiKey) {
    if (ep.type === 'azure' || ep.auth === 'api-key') {
      headers['api-key'] = ep.apiKey;
    } else {
      headers['Authorization'] = `Bearer ${ep.apiKey}`;
    }
  }

  // Azure routes by deployment name in the URL path (the body `model` is ignored).
  const url =
    ep.type === 'azure'
      ? `${ep.baseUrl}/openai/deployments/${encodeURIComponent(model)}/chat/completions?api-version=${AZURE_API_VERSION}`
      : `${ep.baseUrl}/chat/completions`;

  let full = '';
  try {
    const res = await fetch(url, {
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
        const delta: string = parsed?.choices?.[0]?.delta?.content || '';
        if (delta) {
          full += delta;
          handlers.onDelta(delta);
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
