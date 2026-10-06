/**
 * chat-sessions.ts
 * Madar — Per-project chat session index.
 * Each session maps to a chat store key (slug, chatId). Persisted as JSON at
 * WSD_DATA_DIR/chats/sessions.json and updated on every appended event.
 * Existing legacy conversations (chats/<slug>/<chatId>/events.jsonl that are not
 * yet in the index) are backfilled on load so old history never disappears.
 */
import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.WSD_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const CHATS_DIR = path.join(DATA_DIR, 'chats');
const INDEX_FILE = path.join(CHATS_DIR, 'sessions.json');

const DEFAULT_SLUG = 'global';

/**
 * Deterministic fallback for an id that sanitizes to nothing (or to a pure dot
 * segment). STABLE by contract: the same input must map to the same key on
 * write and on every later lookup, so the old `chat-${Date.now()}` fallback
 * would orphan rows and could collide with a real session created in the same
 * millisecond. `'..'`/`'.'` used to survive the filters below verbatim, and
 * `path.join(CHATS_DIR, slug, '..')` then named a directory OUTSIDE the
 * session — the rmSync in deleteSession walked up to DATA_DIR itself (see
 * chatDirFor). Mirrors chat-store.sanitizeId.
 */
const FALLBACK_ID = 'chat-unspecified';

export interface ChatSession {
  /** Project slug (or 'global' for general conversations). */
  slug: string;
  chatId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastPreview: string;
}

export interface SessionTouchEvent {
  type: string;
  content: string;
  timestamp: string;
}

let cache: ChatSession[] | null = null;

function sanitizeSlug(slug: string | undefined): string {
  if (!slug) return DEFAULT_SLUG;
  const clean = String(slug).trim().replace(/[^a-z0-9._-]/g, '-').slice(0, 32);
  // The filter DELIBERATELY keeps dots (legacy `my.project` dirs), so '.',
  // '..' and '....' pass through it untouched — map them off before any
  // caller can path.join them with a base.
  if (!clean || /^\.+$/.test(clean)) return DEFAULT_SLUG;
  return clean;
}

function sanitizeChatId(chatId: string): string {
  const clean = String(chatId).replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 64);
  if (!clean || /^\.+$/.test(clean)) return FALLBACK_ID;
  return clean;
}

/**
 * The directory a session's events live in, WITH a structural proof that the
 * joined path really is `CHATS_DIR/<slug>/<chatId>` and nothing else.
 *
 * `path.join` happily consumes `..` segments: `join(CHATS_DIR, 'global', '..')`
 * is CHATS_DIR itself and `join(CHATS_DIR, '..', '..')` is DATA_DIR — the data
 * directory that holds users.json and jwt.secret. The sanitizers above already
 * refuse dot segments, but a containment decision must not rest on a filter
 * this far from the syscall: the RELATIVE path is checked here, exactly two
 * segments, neither a dot segment. Null means "not a session directory" and
 * callers must treat it as 404 without touching the filesystem.
 */
function chatDirFor(slug: string, chatId: string): string | null {
  const dir = path.join(CHATS_DIR, slug, chatId);
  const parts = path.relative(CHATS_DIR, dir).split(path.sep);
  if (parts.length !== 2) return null;
  if (parts.some((p) => !p || p === '.' || p === '..')) return null;
  return dir;
}

function sessionKey(s: ChatSession): string {
  return `${s.slug}/${s.chatId}`;
}

function load(): ChatSession[] {
  if (cache) return cache;
  try {
    if (fs.existsSync(INDEX_FILE)) {
      const raw = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
      cache = Array.isArray(raw) ? (raw as ChatSession[]) : [];
    } else {
      cache = [];
    }
  } catch {
    cache = [];
  }
  backfill();
  return cache;
}

function save(): void {
  fs.mkdirSync(CHATS_DIR, { recursive: true });
  fs.writeFileSync(INDEX_FILE, JSON.stringify(cache ?? [], null, 2), 'utf8');
}

function resetCache(): void {
  cache = null;
}

function humanizeName(chatId: string): string {
  if (/^chat-\d+$/.test(chatId)) return 'New session';
  return chatId;
}

/** Register every events.jsonl on disk that is not yet in the index. */
function backfill(): void {
  if (!cache) return;
  const known = new Set(cache.map(sessionKey));
  let changed = false;
  try {
    const slugs = fs.readdirSync(CHATS_DIR, { withFileTypes: true });
    for (const s of slugs) {
      if (!s.isDirectory()) continue;
      const slug = sanitizeSlug(s.name);
      const slugDir = path.join(CHATS_DIR, s.name);
      const ids = fs.readdirSync(slugDir, { withFileTypes: true });
      for (const id of ids) {
        if (!id.isDirectory()) continue;
        const chatId = sanitizeChatId(id.name);
        const key = `${slug}/${chatId}`;
        if (known.has(key)) continue;
        const f = path.join(slugDir, id.name, 'events.jsonl');
        if (!fs.existsSync(f)) continue;
        const lines = fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim());
        let firstTs = '';
        let lastTs = '';
        let lastPreview = '';
        let count = 0;
        for (const line of lines) {
          try {
            const ev = JSON.parse(line);
            if (typeof ev.timestamp === 'string') {
              if (!firstTs) firstTs = ev.timestamp;
              lastTs = ev.timestamp;
            }
            if (ev.type === 'user_message' || ev.type === 'agent_done') {
              count += 1;
              if (typeof ev.content === 'string') lastPreview = ev.content.replace(/\s+/g, ' ').slice(0, 120);
            }
          } catch {
            /* skip malformed */
          }
        }
        cache.push({
          slug,
          chatId,
          name: humanizeName(chatId),
          createdAt: firstTs || lastTs || new Date().toISOString(),
          updatedAt: lastTs || firstTs || new Date().toISOString(),
          messageCount: count,
          lastPreview: lastPreview || `Conversation (${lines.length} events)`,
        });
        changed = true;
      }
    }
  } catch {
    /* dir missing — nothing to backfill */
  }
  if (changed) save();
}

/** Update a session after an event was appended (creates the session if needed). */
export function touchSession(slug: string | undefined, chatId: string, ev: SessionTouchEvent): ChatSession {
  const s = sanitizeSlug(slug);
  const c = sanitizeChatId(chatId);
  const list = load();
  let entry = list.find((x) => x.slug === s && x.chatId === c);
  if (!entry) {
    entry = {
      slug: s,
      chatId: c,
      name: humanizeName(c),
      createdAt: ev.timestamp || new Date().toISOString(),
      updatedAt: ev.timestamp || new Date().toISOString(),
      messageCount: 0,
      lastPreview: '',
    };
    list.push(entry);
  }
  entry.updatedAt = ev.timestamp || new Date().toISOString();
  if (ev.type === 'user_message' || ev.type === 'agent_done') {
    entry.messageCount += 1;
    if (ev.content) entry.lastPreview = ev.content.replace(/\s+/g, ' ').slice(0, 120);
  }
  save();
  return entry;
}

/** List sessions for a scope (project slug or 'global'), newest first. */
export function listSessions(project?: string): ChatSession[] {
  const s = sanitizeSlug(project);
  return load()
    .filter((x) => x.slug === s)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
}

/** Create a new session in a scope. */
export function createSession(opts: { project?: string; name?: string }): ChatSession {
  const s = sanitizeSlug(opts.project);
  const chatId = `chat-${Date.now()}`;
  const now = new Date().toISOString();
  const entry: ChatSession = {
    slug: s,
    chatId,
    name: opts.name ? String(opts.name).trim().slice(0, 80) : 'New session',
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    lastPreview: '',
  };
  load().push(entry);
  save();
  return entry;
}

/** Rename a session. Returns the updated session or null when missing. */
export function renameSession(project: string | undefined, chatId: string, name: string): ChatSession | null {
  const s = sanitizeSlug(project);
  const c = sanitizeChatId(chatId);
  const list = load();
  const entry = list.find((x) => x.slug === s && x.chatId === c);
  if (!entry) return null;
  entry.name = name.trim().slice(0, 80) || entry.name;
  save();
  return entry;
}

/** Delete a session and its persisted events. Returns false when missing. */
export function deleteSession(project: string | undefined, chatId: string): boolean {
  const s = sanitizeSlug(project);
  const c = sanitizeChatId(chatId);
  const list = load();
  const idx = list.findIndex((x) => x.slug === s && x.chatId === c);
  if (idx === -1) return false;
  // The containment proof runs BEFORE anything is removed. A crafted
  // `DELETE /api/chat/sessions/..?project=global` used to reach this rmSync
  // with `path.join(CHATS_DIR, 'global', '..')` = CHATS_DIR (every
  // conversation on the server) and, with both segments '..', DATA_DIR itself.
  // An unshaped answer is "no such session": the row is left alone and the
  // filesystem is never touched.
  const dir = chatDirFor(s, c);
  if (!dir) return false;
  list.splice(idx, 1);
  save();
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

/** Reset the in-memory cache (used by tests). */
export function resetSessionsCache(): void {
  resetCache();
}
