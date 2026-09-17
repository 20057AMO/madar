/**
 * gemini-chat.ts
 * Madar — Streaming chat against the native Gemini API
 * (Google AI Studio keys: old AIza… and new AQ… format).
 * Uses /models/{model}:streamGenerateContent?alt=sse.
 * NOTE: new "AQ." keys do NOT work on the OpenAI-compatible endpoint yet
 * (Google returns "Multiple authentication credentials received"), so the
 * native path is used instead. Images are sent as inlineData parts.
 */

import { consumeLines } from './stream-lines';
import type { ProviderEndpoint } from './chat-config';
import type { ChatMessage, StreamHandlers, RunControl } from './chat-types';

function splitDataUrl(dataUrl: string): { mimeType: string; data: string } {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (m) return { mimeType: m[1], data: m[2] };
  return { mimeType: 'image/png', data: dataUrl };
}

function toParts(msg: ChatMessage): { text?: string; inlineData?: { mimeType: string; data: string } }[] {
  const parts: { text?: string; inlineData?: { mimeType: string; data: string } }[] = [];
  if (msg.content) parts.push({ text: msg.content });
  if (msg.images) {
    for (const img of msg.images) {
      const { mimeType, data } = splitDataUrl(img);
      parts.push({ inlineData: { mimeType, data } });
    }
  }
  return parts;
}

export async function streamChatGemini(
  ep: ProviderEndpoint,
  model: string,
  temperature: number,
  system: string,
  messages: ChatMessage[],
  handlers: StreamHandlers,
  control: RunControl
): Promise<string> {
  const modelName = String(model).replace(/^models\//, '');
  const body = JSON.stringify({
    contents: messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: toParts(m),
    })),
    systemInstruction: system ? { parts: [{ text: system }] } : undefined,
    generationConfig: { temperature },
  });

  const controller = new AbortController();
  control.abort = () => controller.abort();

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ep.apiKey) headers['x-goog-api-key'] = ep.apiKey;

  let full = '';
  try {
    const res = await fetch(
      `${ep.baseUrl}/models/${modelName}:streamGenerateContent?alt=sse`,
      {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      }
    );

    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `${ep.baseUrl} request failed (HTTP ${res.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`
      );
    }

    await consumeLines(res.body, (line) => {
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload) return;
      try {
        const parsed = JSON.parse(payload);
        const candidates = parsed?.candidates as { content?: { parts?: { text?: string }[] } }[] | undefined;
        const text = (candidates?.[0]?.content?.parts || [])
          .map((p) => p.text || '')
          .join('');
        if (text) {
          full += text;
          handlers.onDelta(text);
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
