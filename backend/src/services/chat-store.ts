/**
 * chat-store.ts
 * Madar — Persistent chat history (JSONL, one file per conversation).
 * Every event: { seq, type, content, timestamp }
 * Types: user_message | agent_chunk | agent_done | agent_error
 */
import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.WSD_DATA_DIR || path.join(__dirname, '..', '..', 'data');

export type ChatEventType = 'user_message' | 'agent_chunk' | 'agent_done' | 'agent_error' | 'tool_call' | 'tool_result';

export interface ChatAttachment {
  kind: 'image' | 'text' | 'file';
  name: string;
  /** Base64 data URL (data:image/...) — present for image attachments. */
  data?: string;
  /** Inlined text content — present for text-file attachments. */
  text?: string;
  size: number;
}

export interface ChatEvent {
  seq: number;
  type: ChatEventType;
  content: string;
  timestamp: string;
  attachments?: ChatAttachment[];
}

export class ChatStore {
  private dir: string;
  private seqCache = new Map<string, number>();
  private eventsCache = new Map<string, ChatEvent[]>();

  constructor() {
    this.dir = path.join(DATA_DIR, 'chats');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /**
   * Sanitize one path segment of a conversation key. The output can only be
   * `[a-zA-Z0-9._-]{1,64}` with no dot-only value, so the `path.join` in
   * `file()` is structurally two segments below `chats/` — '..' as a slug or
   * chatId used to survive the character filter verbatim and made
   * `join(chats, '..', '..')` name a directory OUTSIDE the data dir, where
   * mkdir+append happily wrote. The empty-input fallback is STABLE (the same
   * input must resolve to the same file on write and on read; the old
   * `chat-${Date.now()}` generated a different key per call). Mirrors
   * chat-sessions.sanitizeChatId.
   */
  private sanitizeId(id: string): string {
    const clean = id.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 64);
    if (!clean || /^\.+$/.test(clean)) return 'chat-unspecified';
    return clean;
  }

  private file(slug: string, chatId: string): string {
    const dir = path.join(this.dir, this.sanitizeId(slug), this.sanitizeId(chatId));
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'events.jsonl');
  }

  private nextSeq(slug: string, chatId: string): number {
    const key = `${slug}/${chatId}`;
    const cached = this.seqCache.get(key);
    if (cached !== undefined) return cached + 1;
    const events = this.readEvents(slug, chatId);
    const seq = (events[events.length - 1]?.seq ?? 0) + 1;
    this.seqCache.set(key, seq);
    return seq;
  }

  /** Append an event and persist it (sync append is fine for local JSONL). */
  append(
    slug: string,
    chatId: string,
    type: ChatEventType,
    content: string,
    attachments?: ChatAttachment[]
  ): ChatEvent {
    const event: ChatEvent = {
      seq: this.nextSeq(slug, chatId),
      type,
      content,
      timestamp: new Date().toISOString(),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    };
    fs.appendFileSync(this.file(slug, chatId), JSON.stringify(event) + '\n', 'utf8');
    const key = `${this.sanitizeId(slug)}/${this.sanitizeId(chatId)}`;
    this.eventsCache.delete(key);
    return event;
  }

  /** Full event list for a conversation, in sequence (replay). */
  readEvents(slug: string, chatId: string): ChatEvent[] {
    const key = `${this.sanitizeId(slug)}/${this.sanitizeId(chatId)}`;
    const cached = this.eventsCache.get(key);
    if (cached) return cached;
    const f = this.file(slug, chatId);
    if (!fs.existsSync(f)) return [];
    const events = fs
      .readFileSync(f, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as ChatEvent;
        } catch {
          return null;
        }
      })
      .filter((e): e is ChatEvent => e !== null);
    if (this.eventsCache.size > 50) {
      const oldest = this.eventsCache.keys().next().value;
      if (oldest !== undefined) this.eventsCache.delete(oldest);
    }
    this.eventsCache.set(key, events);
    return events;
  }
}

export const chatStore = new ChatStore();