/**
 * ollama-chat.ts
 * Madar — Chat dispatcher. Resolves the configured provider and routes to the
 * matching engine:
 *   - type 'ollama'    → /api/chat (NDJSON)  — implemented below
 *   - type 'openai'    → OpenAI-compatible   — openai-chat.ts
 *   - type 'anthropic' → Anthropic Messages  — anthropic-chat.ts
 *   - type 'gemini'    → native Gemini API   — gemini-chat.ts
 */

import {
  getChatConfig,
  resolveProvider,
  buildSystemPrompt,
  type ProviderEndpoint,
} from './chat-config';
import { consumeLines } from './stream-lines';
import { streamChatOpenAI } from './openai-chat';
import { streamChatAnthropic } from './anthropic-chat';
import { streamChatGemini } from './gemini-chat';

export type { ChatMessage, StreamHandlers, RunControl } from './chat-types';
import type { ChatMessage, StreamHandlers, RunControl } from './chat-types';

export interface StreamOptions {
  provider: string;
  model: string;
  temperature: number;
  /** System prompt override (e.g. with project context injected). */
  system?: string;
}

/** Strip the data-URI prefix (Ollama expects raw base64). */
function stripDataUrl(dataUrl: string): string {
  const idx = dataUrl.indexOf(',');
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
}

export async function streamChat(
  messages: ChatMessage[],
  handlers: StreamHandlers,
  control: RunControl,
  opts: Partial<StreamOptions> = {}
): Promise<string> {
  const cfg = getChatConfig();
  const provider = opts.provider || cfg.provider;
  const model = opts.model || cfg.model;
  const temperature = opts.temperature ?? cfg.temperature;
  const ep = resolveProvider(provider);
  const system = opts.system ?? buildSystemPrompt(cfg);

  if (ep.type === 'openai' || ep.type === 'azure') {
    return streamChatOpenAI(ep, model, temperature, system, messages, handlers, control);
  }
  if (ep.type === 'anthropic') {
    return streamChatAnthropic(ep, model, temperature, system, messages, handlers, control);
  }
  if (ep.type === 'gemini') {
    return streamChatGemini(ep, model, temperature, system, messages, handlers, control);
  }
  return streamChatOllama(ep, model, temperature, system, messages, handlers, control);
}

async function streamChatOllama(
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
      ...messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.images && m.images.length > 0 ? { images: m.images.map(stripDataUrl) } : {}),
      })),
    ],
    stream: true,
    options: { temperature },
  });

  const controller = new AbortController();
  control.abort = () => controller.abort();

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ep.apiKey) headers['Authorization'] = `Bearer ${ep.apiKey}`;

  let full = '';
  try {
    const res = await fetch(`${ep.baseUrl}/api/chat`, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `${ep.baseUrl} request failed (HTTP ${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`
      );
    }

    await consumeLines(res.body, (line) => {
      try {
        const parsed = JSON.parse(line);
        const delta: string = parsed?.message?.content || '';
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
