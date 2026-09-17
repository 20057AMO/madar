/**
 * chat-types.ts
 * Madar — Shared chat types used by every chat engine.
 * Images are base64 data URLs (data:image/...;base64,...) so the mime type is preserved.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** Base64 data URLs for vision-capable models. */
  images?: string[];
}

export interface StreamHandlers {
  onDelta: (text: string) => void;
  /** May return a promise (agent tool loops await it); engines MUST await it. */
  onDone: (full: string) => void | Promise<void>;
  onError: (error: string) => void;
}

export interface RunControl {
  cancelled: boolean;
  abort: (() => void) | null;
}
