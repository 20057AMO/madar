/**
 * ws-chat.ts
 * Madar — Chatbot over WebSocket (any configured provider: Ollama,
 * OpenAI-compatible, Anthropic, or Gemini).
 * History is persisted via chat-store under slug = project slug (or 'global').
 * Sessions are indexed via chat-sessions for the sessions rail in the UI.
 * Protocol (client → server, JSON):
 *   { type: "prompt", text, attachments?, project? } → start a streaming reply (one per chat)
 *     attachments: [{ kind: "image"|"text"|"file", name, data?, text?, size? }]
 *     project: "all" | <slug> | omitted → model gets project-aware context injected
 * Protocol (server → client, JSON):
 *   { type: "replay", events: ChatEvent[] } → full history on connect
 *   { type: "started" }
 *   { type: "event", event: ChatEvent }     → live event
 *   { type: "error", message }
 */
import { WebSocket } from 'ws';
import { chatStore, type ChatAttachment, type ChatEvent } from '../services/chat-store';
import { streamChat, type RunControl, type ChatMessage } from '../services/ollama-chat';
import { touchSession } from '../services/chat-sessions';
import { getProjectContext, listProjectsBrief, capText } from '../services/project-context';
import { retrieveProject, formatRetrievedChunks } from '../services/project-index';
import { buildSystemPrompt, getChatConfig } from '../services/chat-config';
import { checkUserWrite } from '../services/user-write-limiter';
import { checkProjectAccess } from '../middleware/auth';
import type { UserRole } from '../services/user-store';

const MAX_PROMPT_CHARS = 20000;
const MAX_HISTORY_TURNS = 20;
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_FILE_CHARS = 100000;
const PROJECT_RE = /^[a-z0-9._-]{1,32}$/i;
const STATIC_CONTEXT_BUDGET = 18000;
const RETRIEVED_CONTEXT_BUDGET = 6000;
const TOTAL_CONTEXT_BUDGET = 24000;
const RETRIEVAL_K = 6;
const active = new Map<string, boolean>();
const controls = new Map<string, RunControl>();
const subscribers = new Map<string, Set<WebSocket>>();

function roomKey(slug: string, chatId: string): string {
  return `${slug}:${chatId}`;
}

function normalizePrompt(raw: any): string | null {
  if (!raw || typeof raw !== 'object' || raw.type !== 'prompt') return null;
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  if (!text) return null;
  if (text.length > MAX_PROMPT_CHARS) return null;
  return text;
}

function normalizeAttachments(raw: any): ChatAttachment[] | null {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return null;
  if (raw.length > MAX_ATTACHMENTS) return null;

  const out: ChatAttachment[] = [];
  let total = 0;
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const kind = item.kind;
    if (kind !== 'image' && kind !== 'text' && kind !== 'file') return null;
    const name = String(item.name ?? 'file').slice(0, 255);
    let data: string | undefined;
    let text: string | undefined;
    let size = Number(item.size) || 0;

    if (kind === 'image') {
      data = String(item.data ?? '');
      if (!data.startsWith('data:image/')) return null;
      size = Math.max(size, Math.round((data.length * 3) / 4));
    } else if (kind === 'text') {
      text = String(item.text ?? '');
      if (text.length > MAX_TEXT_FILE_CHARS) return null;
      size = Buffer.byteLength(text, 'utf8');
    }

    total += size;
    if (total > MAX_ATTACHMENT_BYTES) return null;
    out.push({ kind, name, data, text, size });
  }
  return out;
}

/**
 * Normalize the optional project scope.
 * Returns undefined (no context), 'all', a validated slug, or null (invalid).
 */
function normalizeProject(raw: any): string | null | undefined {
  if (raw == null || raw === '') return undefined;
  if (typeof raw !== 'string') return null;
  const p = raw.trim();
  if (!p) return undefined;
  if (p === 'all') return 'all';
  if (!PROJECT_RE.test(p)) return null;
  return p;
}

/** Query text used for retrieval: the message + any inlined text attachments. */
function buildRetrievalQuery(text: string, attachments: ChatAttachment[]): string {
  const parts: string[] = [text];
  for (const a of attachments) {
    if (a.kind === 'text' && a.text) parts.push(a.name, a.text);
  }
  return parts.join('\n').slice(0, 4000);
}

/** Model-facing text for the current turn: prompt + inlined text files + binary markers. */
function buildUserContent(text: string, attachments: ChatAttachment[]): string {
  const parts: string[] = [text];
  for (const a of attachments) {
    if (a.kind === 'text' && a.text != null) {
      parts.push(`[attached file: ${a.name}]\n${a.text}`);
    } else if (a.kind === 'file') {
      parts.push(`[attached file: ${a.name} (${a.size} bytes) — binary, cannot read content]`);
    }
  }
  return parts.join('\n\n');
}

/** Reconstruct a model message from a persisted event (keeps image context). */
function eventToMessage(ev: ChatEvent): ChatMessage | null {
  if (ev.type === 'user_message') {
    const images = (ev.attachments || [])
      .filter((a) => a.kind === 'image' && a.data)
      .map((a) => a.data!);
    return {
      role: 'user',
      content: ev.content,
      ...(images.length > 0 ? { images } : {}),
    };
  }
  if (ev.type === 'agent_done') {
    return { role: 'assistant', content: ev.content };
  }
  return null;
}

/** Recent history (user + assistant) to give the model context, newest last. */
function buildHistory(slug: string, chatId: string): ChatMessage[] {
  const events = chatStore.readEvents(slug, chatId);
  const turns: ChatMessage[] = [];
  for (const ev of events) {
    const msg = eventToMessage(ev);
    if (msg) turns.push(msg);
  }
  return turns.slice(-MAX_HISTORY_TURNS * 2);
}

export function handleChatSocket(
  ws: WebSocket,
  slug: string,
  chatId: string,
  authUser: { id: string; username: string; role: UserRole; jti?: string } | null,
  onRelease: () => void
): void {
  // Project-level authorization matches the REST surface: 'global' is not a
  // project (stays open to every authenticated user); any other slug requires
  // membership to READ the room and editor-level access to WRITE it. System
  // admins always pass; legacy projects without membership data stay open.
  const notGlobal = slug !== 'global';
  const ctx = notGlobal
    ? { read: checkProjectAccess(authUser?.id ?? '', authUser?.role ?? 'viewer', slug, 'viewer').allowed,
        write: checkProjectAccess(authUser?.id ?? '', authUser?.role ?? 'viewer', slug, 'editor').allowed }
    : { read: true, write: true };
  if (!ctx.read) {
    onRelease();
    ws.close(1008, 'access denied');
    return;
  }

  const room = roomKey(slug, chatId);
  const events = chatStore.readEvents(slug, chatId);
  sendJson(ws, { type: 'replay', events });

  if (!subscribers.has(room)) subscribers.set(room, new Set());
  subscribers.get(room)!.add(ws);

  const release = () => {
    const set = subscribers.get(room);
    if (set) {
      set.delete(ws);
      if (set.size === 0) subscribers.delete(room);
    }
    onRelease();
  };

  ws.on('message', (data) => {
    void handleMessage(data);
  });

  async function handleMessage(data: any): Promise<void> {
    let msg: any;
    try {
      msg = JSON.parse(data.toString('utf8'));
    } catch {
      sendJson(ws, { type: 'error', message: 'Invalid JSON payload' });
      return;
    }

    if (msg.type === 'stop') {
      if (!ctx.write) {
        sendJson(ws, { type: 'error', message: 'Read-only: only editors can control this chat.' });
        return;
      }
      const ctrl = controls.get(room);
      if (ctrl) {
        ctrl.cancelled = true;
        if (ctrl.abort) ctrl.abort();
      }
      active.delete(room);
      controls.delete(room);
      return;
    }

    if (!ctx.write) {
      sendJson(ws, { type: 'error', message: 'Read-only: only editors can send messages to this project chat.' });
      return;
    }

    const text = normalizePrompt(msg);
    if (!text) {
      sendJson(ws, { type: 'error', message: 'Invalid prompt payload' });
      return;
    }

    const attachments = normalizeAttachments(msg.attachments);
    if (attachments === null) {
      sendJson(ws, { type: 'error', message: 'Invalid attachments (too many or too large)' });
      return;
    }

    const project = normalizeProject(msg.project);
    if (project === null) {
      sendJson(ws, { type: 'error', message: 'Invalid project scope' });
      return;
    }

    // Per-user write budget (NAT-shared safe). Reject the message, but keep the
    // socket open so the client can back off and retry — never drop the WS.
    const retryAfter = checkUserWrite(authUser?.id, undefined);
    if (retryAfter > 0) {
      sendJson(ws, { type: 'error', message: 'Rate limited. Slow down your messages and try again shortly.' });
      return;
    }

    if (active.get(room)) {
      sendJson(ws, { type: 'error', message: 'A reply is already running. Wait for it to finish.' });
      return;
    }
    active.set(room, true);

    const userContent = buildUserContent(text, attachments);
    const userEvent = chatStore.append(slug, chatId, 'user_message', userContent, attachments);
    touchSession(slug, chatId, userEvent);
    broadcast(room, { type: 'event', event: userEvent });

    const control: RunControl = { cancelled: false, abort: null };
    controls.set(room, control);

    const images = attachments
      .filter((a) => a.kind === 'image' && a.data)
      .map((a) => a.data!);
    const userMessage: ChatMessage = {
      role: 'user',
      content: userContent,
      ...(images.length > 0 ? { images } : {}),
    };

    let systemText = buildSystemPrompt(getChatConfig());
    if (project) {
      try {
        let ctxText: string;
        if (project === 'all') {
          ctxText = (await listProjectsBrief()).text;
        } else {
          ctxText = (await getProjectContext(project, STATIC_CONTEXT_BUDGET)).text;
          const query = buildRetrievalQuery(text, attachments);
          try {
            const ret = await retrieveProject(project, query, RETRIEVAL_K);
            const block = formatRetrievedChunks(ret);
            if (block) ctxText += `\n\n${capText(block, RETRIEVED_CONTEXT_BUDGET).text}`;
          } catch {
            // Retrieval is best-effort; never fail the reply because of it.
          }
        }
        const total = capText(ctxText, TOTAL_CONTEXT_BUDGET);
        systemText += `\n\n${total.text}`;
      } catch {
        // Project context is best-effort; never fail the reply because of it.
      }
    }

    streamChat(
      [...buildHistory(slug, chatId), userMessage],
      {
        onDelta: (delta) => {
          const ev = chatStore.append(slug, chatId, 'agent_chunk', delta);
          touchSession(slug, chatId, ev);
          broadcast(room, { type: 'event', event: ev });
        },
        onDone: (final) => {
          const ev = chatStore.append(slug, chatId, 'agent_done', final);
          touchSession(slug, chatId, ev);
          broadcast(room, { type: 'event', event: ev });
          active.delete(room);
          controls.delete(room);
        },
        onError: (error) => {
          const ev = chatStore.append(slug, chatId, 'agent_error', error);
          touchSession(slug, chatId, ev);
          broadcast(room, { type: 'event', event: ev });
          active.delete(room);
          controls.delete(room);
        },
      },
      control,
      { system: systemText }
    ).catch((err: any) => {
      active.delete(room);
      controls.delete(room);
      sendJson(ws, { type: 'error', message: err?.message || String(err) });
    });

    broadcast(room, { type: 'started' });
  }

  ws.on('close', release);
  ws.on('error', release);
}

function broadcast(room: string, payload: unknown): void {
  const set = subscribers.get(room);
  if (!set) return;
  const text = JSON.stringify(payload);
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) ws.send(text);
  }
}

function sendJson(ws: WebSocket, obj: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}
