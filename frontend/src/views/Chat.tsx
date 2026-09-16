/**
 * Chat.tsx
 * Madar — Team Chat. A WhatsApp-style workspace messenger:
 * manual team channels, per-project auto "project:<slug>" channels, and
 * direct 1:1 conversations. Text is sent over REST (single authoritative
 * write path); the WebSocket delivers live messages/typing/read/pin/presence.
 */
import { useEffect, useRef, useState, useMemo, useCallback } from 'preact/hooks';
import { Fragment } from 'preact';
import { useHashLocation } from 'wouter/use-hash-location';
import { useAuth } from '../auth';
import {
  MessageCircle,
  Send,
  Search,
  Paperclip,
  X,
  Pin,
  Users as UsersIcon,
  Plus,
  Hash,
  FolderOpen,
  User as UserIcon,
  Loader2,
  Check,
  CheckCheck,
  Mic,
  Settings,
  Pencil,
  Trash2,
  File as FileIcon,
  FileCode2,
  FileText,
  FileArchive,
  FileImage,
  FileAudio,
  FileVideo,
  Menu,
  ChevronLeft,
  ChevronRight,
  ArrowDownToLine,
  Volume2,
  VolumeX,
} from 'lucide-preact';
import {
  listChatChannels,
  createChatChannel,
  openDirectChat,
  deleteChatChannel,
  getChatChannel,
  getChatMessages,
  sendChatMessage,
  pinChatMessage,
  markChatRead,
  uploadChatAttachment,
  chatAttachmentObjectUrl,
  revokeChatAttachmentObjectUrl,
  chatAttachmentText,
  searchChatMessages,
  searchAllChatMessages,
  updateChatChannelSettings,
  editChatMessage,
  deleteChatMessage,
  toggleChatReaction,
  listUsers,
  avatarUrl,
  type ChatChannel,
  type TeamChatMessage,
  type ChatAttachment,
  type GlobalChatSearchResult,
} from '../api';
import { Avatar } from '../components/Avatar';
import { ConfirmModal } from '../components/ConfirmModal';
import { VoiceNotePlayer } from '../components/VoiceNotePlayer';
import { AttachmentLightbox } from '../components/AttachmentLightbox';
import { useTeamChatSocket, type ChatSocketEvent } from '../useTeamChatSocket';
import { renderTeamMarkdown } from '../lib/markdown';
import { attachmentGroup, attachmentIcon, previewability } from '../lib/attachment-types';
import { daySeparatorKey, formatDayLabel, shouldGroup } from '../lib/chat-format';
import { useDocumentVisible } from '../lib/visibility';
import '../tchat.css';

interface ChatPresenceUser {
  id: string;
  username: string;
  role: string;
  displayName?: string;
  avatarExt?: 'png' | 'jpg' | 'webp';
}

interface ComposerState {
  text: string;
  replyTo?: TeamChatMessage;
  attachments: { id: string; name: string; size: number; kind: 'image' | 'file'; url?: string }[];
}

function channelLabel(c: ChatChannel, me: { id: string }): string {
  if (c.kind === 'project') return `# ${c.projectSlug}`;
  if (c.kind === 'channel') return `# ${c.name || 'channel'}`;
  const other = c.members.find((m) => m.userId !== me.id);
  return other ? (other.displayName || other.username) : 'Direct';
}

function channelSub(c: ChatChannel, me: { id: string }): string {
  if (c.kind === 'project') return c.projectSlug || '';
  if (c.kind === 'direct') {
    const others = c.members.filter((m) => m.userId !== me.id);
    return others.map((m) => m.username).join(', ');
  }
  return '';
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const sameDay = new Date(now).toDateString() === d.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function reducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function snippetHtml(text: string, q: string, max = 140): string {
  if (!text) return '<span class="dim">📎 attachment</span>';
  const escaped = escapeHtml(text);
  if (!q) return escaped.length > max ? escaped.slice(0, max) + '…' : escaped;
  const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig');
  const match = re.exec(escaped);
  if (!match) return escaped.length > max ? escaped.slice(0, max) + '…' : escaped;
  const start = Math.max(0, match.index - 40);
  const end = Math.min(escaped.length, match.index + match[0].length + 80);
  let snippet = escaped.slice(start, end);
  if (start > 0) snippet = '…' + snippet;
  if (end < escaped.length) snippet = snippet + '…';
  return snippet.replace(re, '<mark class="tchat-search-hit">$1</mark>');
}

function PinnedMessageHeader({ 
  message, 
  onJump 
}: { 
  message: TeamChatMessage; 
  onJump: () => void 
}) {
  return (
    <div class="tchat-pinned-header" onClick={onJump} role="button" tabIndex={0} onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onJump(); } }}>
      <Pin width={13} height={13} class="icon" />
      <span class="tchat-pinned-author">{message.username}: </span>
      <span class="tchat-pinned-text">
        {(message.text || '').slice(0, 100) || '📎 attachment'}
        {message.text && message.text.length > 100 && '…'}
      </span>
    </div>
  );
}
function AttachImage({ id, alt }: { id: string; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    chatAttachmentObjectUrl(id)
      .then((u) => { if (alive) setUrl(u); })
      .catch(() => {});
    return () => { 
      alive = false; 
      revokeChatAttachmentObjectUrl(id);
    };
  }, [id]);
  if (!url) return <div class="tchat-attachment-img"><span class="dim" style="display:flex;align-items:center;justify-content:center;height:120px;gap:6px"><Loader2 width={14} height={14} class="icon spin" />loading…</span></div>;
  return <img class="tchat-attachment-img" src={url} alt={alt} loading="lazy" />;
}

const FICO_BY_NAME: Record<string, any> = {
  FileCode2, FileText, FileArchive, FileImage, FileAudio, FileVideo, FileIcon,
};

/** Non-image attachment card: group icon + name + size + optional text preview. */
function FileAttachmentCard({ attachment }: { attachment: ChatAttachment }) {
  const group = attachmentGroup(attachment.name, attachment.kind);
  const iconName = attachmentIcon(group);
  const Fico = FICO_BY_NAME[iconName] || FileIcon;
  const pref = previewability(attachment.name, attachment.size);
  const [preview, setPreview] = useState<{ state: '' | 'loading' | 'ready' | 'error'; text: string }>({ state: '', text: '' });

  const togglePreview = () => {
    // Folded back — collapse without re-fetching (the text cache in api.ts
    // would reuse the promise anyway; the module cache never re-downloads).
    if (preview.state === 'ready') {
      setPreview({ state: '', text: '' });
      return;
    }
    if (preview.state === 'loading') return;
    setPreview({ state: 'loading', text: '' });
    chatAttachmentText(attachment.id)
      .then((text) => setPreview({ state: 'ready', text }))
      .catch(() => setPreview({ state: 'error', text: '' }));
  };

  return (
    <div class="tchat-attachment">
      <div class="tchat-attachment-file">
        <Fico width={14} height={14} class={`tchat-fico tchat-fico-${group}`} />
        <span class="tchat-file-name" title={attachment.name}>{attachment.name}</span>
        <span class="dim tchat-file-size">{fmtBytes(attachment.size)}</span>
        {pref === 'ok' ? (
          <button
            class="tchat-preview-btn"
            onClick={togglePreview}
            disabled={preview.state === 'loading'}
            aria-expanded={preview.state === 'ready'}
            aria-controls={`prev-${attachment.id}`}
          >
            Preview
          </button>
        ) : pref === 'too-big' ? (
          <span class="dim tchat-preview-too-big" title="File too large to preview">Too large</span>
        ) : null}
      </div>
      {pref === 'ok' && (
        <div class="tchat-preview-status" role="status" aria-live="polite">
          {preview.state === 'loading' && <>loading…</>}
          {preview.state === 'error' && (
            <button class="tchat-preview-btn" onClick={togglePreview} aria-label="Retry preview">Error · Retry</button>
          )}
        </div>
      )}
      {preview.state === 'ready' && preview.text !== '' && (
        <pre
          id={`prev-${attachment.id}`}
          class="tchat-file-preview"
          tabIndex={0}
          role="region"
          aria-label="File preview"
        >{preview.text}</pre>
      )}
    </div>
  );
}

/** Message attachment block — images grid/single + voice-first file cards. */
function MessageAttachments({ message, onOpenLightbox }: {
  message: TeamChatMessage;
  onOpenLightbox: (images: { id: string; name: string }[], index: number) => void;
}) {
  const atts = message.attachments || [];
  const images = atts.filter((a) => a.kind === 'image');
  const rest = atts.filter((a) => a.kind !== 'image');
  return (
    <>
      {images.length >= 2 && (
        <div class="tchat-attachment-grid">
          {images.map((img, i) => (
            <button
              class="tchat-grid-item"
              key={img.id}
              aria-label={`Open image ${i + 1}: ${img.name}`}
              onClick={() => onOpenLightbox(images, i)}
            >
              <AttachImage id={img.id} alt={img.name} />
            </button>
          ))}
        </div>
      )}
      {images.length === 1 && (
        <div class="tchat-attachment">
          <button class="tchat-img-btn" aria-label={`Open image: ${images[0].name}`} onClick={() => onOpenLightbox(images, 0)}>
            <AttachImage id={images[0].id} alt={images[0].name} />
          </button>
        </div>
      )}
      {rest.map((a) =>
        /\.(webm|ogg|oga|m4a|mp3|wav)$/i.test(a.name || '') ? (
          <div class="tchat-attachment" key={a.id}>
            <VoiceNotePlayer attachmentId={a.id} attachmentName={a.name} />
          </div>
        ) : (
          <FileAttachmentCard key={a.id} attachment={a} />
        )
      )}
    </>
  );
}

function MessageStatus({ status }: { status?: TeamChatMessage['status'] }) {
  if (!status) return null;
  if (status === 'sent') return <Check width={12} height={12} class="tchat-msg-status" role="img" aria-label="Sent" />;
  if (status === 'delivered') return <CheckCheck width={12} height={12} class="tchat-msg-status" role="img" aria-label="Delivered" />;
  if (status === 'read') return <CheckCheck width={12} height={12} class="tchat-msg-status read" role="img" aria-label="Read" />;
  return null;
}

const ALL_REACTIONS = ['👍','❤️','😂','🎉','👀','✅','🔥','🙏','👎','😮','💯','🚀'];

function EmojiPicker({ onSelect, onClose }: { onSelect: (emoji: string) => void; onClose: () => void }) {
  const ref = useEmojiPickerRef(onClose);
  return (
    <div class="tchat-emoji-picker" ref={ref} role="group" aria-label="Pick a reaction">
      {ALL_REACTIONS.map((e) => (
        <button
          key={e}
          class="tchat-emoji-option"
          aria-label={e}
          onClick={() => onSelect(e)}
        >
          {e}
        </button>
      ))}
    </div>
  );
}

function useEmojiPickerRef(onClose: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onDown = (e: MouseEvent) => {
      if (!el.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);
  return ref;
}

function MessageReactions({
  reactions,
  meId,
  onToggle,
  onPicker,
}: {
  reactions?: Record<string, string[]>;
  meId: string;
  onToggle: (emoji: string) => void;
  onPicker: () => void;
}) {
  const entries = reactions
    ? Object.entries(reactions).filter(([, ids]) => ids.length > 0).sort((a, b) => b[1].length - a[1].length)
    : [];
  return (
    <div class="tchat-reactions">
      {entries.map(([emoji, ids]) => {
        const mine = ids.includes(meId);
        const count = ids.length;
        return (
          <button
            key={emoji}
            class={`tchat-reaction-chip${mine ? ' mine' : ''}`}
            aria-pressed={mine}
            aria-label={`${emoji} ${count}${mine ? ', you reacted' : ''}`}
            onClick={() => onToggle(emoji)}
          >
            <span class="tchat-reaction-emoji">{emoji}</span>
            <span class="tchat-reaction-count">{count}</span>
          </button>
        );
      })}
      <button class="tchat-reaction-add" aria-label="Add reaction" onClick={onPicker} title="Add reaction">
        <Plus width={12} height={12} />
      </button>
    </div>
  );
}

/** Local matchMedia hook — re-renders on breakpoint changes. */
function useMediaQuery(query: string, initial = false): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : initial
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    setMatches(mq.matches);
    mq.addEventListener?.('change', onChange);
    if (!mq.addEventListener) mq.addListener?.(onChange);
    return () => {
      mq.removeEventListener?.('change', onChange);
      if (!mq.removeEventListener) mq.removeListener?.(onChange);
    };
  }, [query]);
  return matches;
}

// ── Notification sound (short oscillator blip). Lazily created so the
// AudioContext costs nothing until the first message, and the context is
// unlocked by the first pointer/key interaction (browser autoplay policy).
let chatAudioCtx: AudioContext | null = null;
let lastSoundPlayedAt = 0;
const SOUND_MIN_GAP_MS = 500;
function getChatAudioCtx(): AudioContext | null {
  if (!chatAudioCtx) {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    chatAudioCtx = new AC();
  }
  if (chatAudioCtx.state === 'suspended') void chatAudioCtx.resume();
  return chatAudioCtx;
}
function playChatSound(): void {
  try {
    // Throttle: never fire two notification blips within 500ms — a burst of
    // messages (or a cross-channel chat_bump storm) must not machine-gun.
    const now = Date.now();
    if (now - lastSoundPlayedAt < SOUND_MIN_GAP_MS) return;
    lastSoundPlayedAt = now;
    const ctx = getChatAudioCtx();
    if (!ctx) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.setValueAtTime(660, t + 0.09);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.12, t + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.26);
  } catch {
    /* sound is best-effort — never break chat over a blocked AudioContext */
  }
}

export function Chat() {
  const { user } = useAuth();
  const meId = user?.id || '';
  const [, setLocation] = useHashLocation();
  const [channels, setChannels] = useState<ChatChannel[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [active, setActive] = useState<ChatChannel | null>(null);
  const [messages, setMessages] = useState<TeamChatMessage[]>([]);
  const [typing, setTyping] = useState<{ id: string; username: string }[]>([]);
  const [presence, setPresence] = useState<Map<string, ChatPresenceUser>>(new Map());
  const [composer, setComposer] = useState<ComposerState>({ text: '', attachments: [] });
  const [viewerOnly, setViewerOnly] = useState(false);
  const [activeCanSend, setActiveCanSend] = useState<'everyone' | 'admins'>('everyone');
  const [canWrite, setCanWrite] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchQ, setSearchQ] = useState('');
  const [searchResults, setSearchResults] = useState<TeamChatMessage[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [newChannelName, setNewChannelName] = useState('');
  const [directOpen, setDirectOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ChatChannel | null>(null);
  const [allUsers, setAllUsers] = useState<Awaited<ReturnType<typeof listUsers>>>([]);
  const [editingMsgId, setEditingMsgId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [deleteMsgTarget, setDeleteMsgTarget] = useState<TeamChatMessage | null>(null);
  const [deletedNotice, setDeletedNotice] = useState('');
  const [lightbox, setLightbox] = useState<{ images: { id: string; name: string }[]; index: number } | null>(null);
  const [emojiPickerFor, setEmojiPickerFor] = useState<string | null>(null);

  // ── Responsive layout: drawer rail on phones, collapsible rail on tablets
  const isTablet = useMediaQuery('(max-width: 1023px)');
  const isPhone = useMediaQuery('(max-width: 639px)');
  const [railOpen, setRailOpen] = useState(false);
  const [railCollapsed, setRailCollapsed] = useState(() => localStorage.getItem('wsd.chat.railCollapsed') === '1');

  // ── Load-earlier paging + jump-to-bottom FAB
  const [noMore, setNoMore] = useState(false);
  const [loadingEarly, setLoadingEarly] = useState(false);
  const [showJump, setShowJump] = useState(false);

  // ── Notifications: local unread tally (non-active channels), title + sound
  const docVisible = useDocumentVisible();
  const [soundOn, setSoundOn] = useState(() => localStorage.getItem('wsd.chat.sound') !== 'off');

  const railRef = useRef<HTMLDivElement | null>(null);
  const railRestoreRef = useRef<HTMLElement | null>(null);
  const burgerRef = useRef<HTMLButtonElement | null>(null);
  const modalsOpenRef = useRef(false);
  modalsOpenRef.current = createOpen || directOpen;
  const messagesRef = useRef<TeamChatMessage[]>([]);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const unreadLocal = useRef<Map<string, Set<string>>>(new Map());
  const origTitleRef = useRef('');
  const docVisibleRef = useRef(true);
  const soundOnRef = useRef(true);
  const loadingEarlierRef = useRef(false);
  const noMoreRef = useRef(false);
  docVisibleRef.current = docVisible;
  soundOnRef.current = soundOn;
  messagesRef.current = messages;

  // ── Global search (across all channels)
  const [globalOpen, setGlobalOpen] = useState(false);
  const [globalQ, setGlobalQ] = useState('');
  const [globalResults, setGlobalResults] = useState<GlobalChatSearchResult[] | null>(null);
  const [globalLoading, setGlobalLoading] = useState(false);
  const globalReq = useRef(0);
  const globalDebounceRef = useRef<number | null>(null);
  const [pendingJump, setPendingJump] = useState<{ channelId: string; msgId: string } | null>(null);
  const searchBoxRef = useRef<HTMLInputElement | null>(null);

  // Channel switches close any open lightbox SYNCHRONOUSLY — a delayed effect
  // would retire the image URL after the messages already unmounted, leaving
  // the overlay on a revoked/blobless broken frame.
  const switchChannel = (id: string | null) => {
    setActiveId(id);
    setLightbox(null);
    setEmojiPickerFor(null);
    if (isPhone) setRailOpen(false);
    // Kill any ghost unread tally synchronously — the message is now on
    // screen, so the count must not linger until the next poll reconciles.
    if (id) {
      unreadLocal.current.delete(id);
      if (unreadTotal() === 0) document.title = origTitleRef.current || document.title;
    }
  };

  const openRail = () => {
    if (isPhone) setRailOpen(true);
    else {
      setRailCollapsed(false);
      localStorage.setItem('wsd.chat.railCollapsed', '0');
    }
  };

  const closeRail = () => setRailOpen(false);

  const toggleRailCollapsed = () => {
    setRailCollapsed((c) => {
      const next = !c;
      localStorage.setItem('wsd.chat.railCollapsed', next ? '1' : '0');
      return next;
    });
  };

  const toggleSound = () => {
    setSoundOn((s) => {
      const next = !s;
      localStorage.setItem('wsd.chat.sound', next ? 'on' : 'off');
      return next;
    });
  };

  // Drawer focus management (ConfirmModal pattern): save the opening trigger,
  // move focus into the channel list, close on Escape, restore focus on close.
  useEffect(() => {
    if (!railOpen) return;
    railRestoreRef.current = document.activeElement as HTMLElement | null;
    requestAnimationFrame(() => {
      const first = railRef.current?.querySelector<HTMLElement>('.tchat-channel-row');
      (first || railRef.current)?.focus();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || modalsOpenRef.current) return;
      e.preventDefault();
      setRailOpen(false);
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      // rAF: the rail may be mid-close — focus once the DOM has settled.
      requestAnimationFrame(() => {
        const target = burgerRef.current
          || (railRestoreRef.current?.isConnected ? railRestoreRef.current : null);
        target?.focus();
      });
      railRestoreRef.current = null;
    };
  }, [railOpen]);
  
  // ── Voice Recording state
  const [isRecording, setIsRecording] = useState(false);
  const [recordTime, setRecordTime] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const discardRecordingRef = useRef(false);
  const micDownAt = useRef(0);

  // ── New-channel / direct-message dialog focus management
  const createDialogRef = useRef<HTMLDivElement | null>(null);
  const directDialogRef = useRef<HTMLDivElement | null>(null);
  const dialogRestoreRef = useRef<HTMLElement | null>(null);

  const fileInput = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const settingsWrapRef = useRef<HTMLDivElement | null>(null);
  const settingsBtnRef = useRef<HTMLButtonElement | null>(null);
  const globalSearchBtnRef = useRef<HTMLButtonElement | null>(null);
  const channelSearchBtnRef = useRef<HTMLButtonElement | null>(null);
  const fabWasVisibleRef = useRef(false);
  const firstOptionRef = useRef<HTMLButtonElement | null>(null);
  const settingsOpenByKeyRef = useRef(false);
  const skipScroll = useRef(false);
  const activeIdRef = useRef<string | null>(null);
  const channelsRef = useRef<ChatChannel[]>([]);
  channelsRef.current = channels;
  activeIdRef.current = activeId;
  const lastSeen = useRef<Map<string, string>>(new Map());
  // Per-message markdown cache: key = id + text + editedAt, cleared per channel,
  // so flips of local state (sending, editing) never re-parse 500 messages.
  const mdCache = useRef(new Map<string, string>());

  const unreadTotal = () => {
    let n = 0;
    for (const s of unreadLocal.current.values()) n += s.size;
    return n;
  };

  // Notification bump for a message landing in a NON-active channel: tally it
  // locally (deduped by message id), update the tab title when hidden, and
  // ping the sound toggle. The 30s channel-list poll reconciles authoritative
  // server unread counts.
  const bumpUnread = (channelId: string, msg: { id: string }) => {
    if (channelId === activeIdRef.current) return;
    let set = unreadLocal.current.get(channelId);
    if (!set) {
      set = new Set();
      unreadLocal.current.set(channelId, set);
    }
    if (set.has(msg.id)) return;
    set.add(msg.id);
    if (!docVisibleRef.current && unreadTotal() > 0) {
      document.title = `(${unreadTotal()}) Madar — Team Chat`;
    }
    if (soundOnRef.current) playChatSound();
  };

  // ── socket — one connection per session
  const onEvent = (ev: ChatSocketEvent) => {
    if (ev.type === 'subscribed') {
      if (ev.channelId === activeIdRef.current) {
        skipScroll.current = true;
        setMessages(ev.messages || []);
        setViewerOnly(ev.level === 'read');
        setActiveCanSend(ev.canSend === 'admins' ? 'admins' : 'everyone');
        setCanWrite(ev.level === 'write');
        requestAnimationFrame(() => requestAnimationFrame(() => { skipScroll.current = false; }));
      }
      return;
    }
    if (ev.type === 'channel_update') {
      if (ev.channel.id === activeIdRef.current) {
        setActiveCanSend(ev.channel.canSend);
        setCanWrite(!viewerOnly && (ev.channel.canSend !== 'admins' || canManageChannel()));
        setChannels((prev) =>
          prev.map((c) => (c.id === ev.channel.id ? { ...c, canSend: ev.channel.canSend } : c))
        );
        setSettingsOpen(false);
      }
      return;
    }
    if (ev.type === 'message') {
      // Drop own message dupes (broadcast echo of the REST write).
      const cid = ev.channel.id;
      const list = cid === activeIdRef.current;
      if (list) {
        setMessages((prev) => {
          if (prev.some((m) => m.id === ev.message.id)) return prev;
          // Dynamic ceiling: live appends must never truncate history that
          // loadEarlier paged in (up to 2000). Cap at max(500, current size)
          // so prepended history survives incremental live messages.
          const max = Math.max(500, prev.length);
          return [...prev, ev.message].slice(-max);
        });
      } else {
        bumpUnread(cid, ev.message);
      }
      setChannels((prev) =>
        prev.map((c) => (c.id === cid ? { ...c, lastMessageAt: ev.message.createdAt } : c))
      );
      return;
    }
    if (ev.type === 'chat_bump') {
      // Lightweight cross-channel notification frame (no full message body):
      // bump the local unread tally + title/sound; the channel list refresh
      // (poll + subscriptions) reconciles the authoritative server unread.
      bumpUnread(ev.channelId, ev.message);
      setChannels((prev) =>
        prev.map((c) => (c.id === ev.channelId ? { ...c, lastMessageAt: ev.message.createdAt } : c))
      );
      return;
    }
    if (ev.type === 'typing' && ev.channelId === activeIdRef.current) {
      if (ev.user.username === user?.username) return;
      setTyping((prev) => {
        if (prev.some((t) => t.id === ev.user.id)) return prev;
        return [...prev, ev.user].slice(0, 3);
      });
      return;
    }
    if (ev.type === 'typing_stop' && ev.channelId === activeIdRef.current) {
      setTyping((prev) => prev.filter((t) => t.id !== ev.user.id));
      return;
    }
    if (ev.type === 'pin') {
      if (ev.channelId !== activeIdRef.current) return;
      setMessages((prev) =>
        prev.map((m) => (m.id === ev.msgId ? { ...m, pinned: ev.pinned } : m))
      );
      return;
    }
    if (ev.type === 'presence') {
      setPresence(new Map(ev.users.map((u) => [u.id, u])));
      return;
    }
    if (ev.type === 'read') {
      if (ev.channelId !== activeIdRef.current) return;
      // Nothing to render per-reader marks in V1 — the unread badge comes
      // from the REST list refresh. Keep the handler for future read-receipts.
      return;
    }
    if (ev.type === 'status_update') {
      if (ev.messageId) {
        setMessages((prev) =>
          prev.map((m) => (m.id === ev.messageId ? { ...m, status: ev.newStatus } : m))
        );
      }
      return;
    }
    if (ev.type === 'message_updated') {
      if (ev.channelId === activeIdRef.current) {
        setMessages((prev) => prev.map((m) => (m.id === ev.message.id ? ev.message : m)));
      }
      return;
    }
    if (ev.type === 'message_deleted') {
      if (ev.channelId === activeIdRef.current) {
        setMessages((prev) => prev.filter((m) => m.id !== ev.msgId));
        if (editingMsgId === ev.msgId) {
          setEditingMsgId(null);
          setEditText('');
        }
        setDeletedNotice('Message deleted');
        setTimeout(() => setDeletedNotice(''), 3000);
        requestAnimationFrame(() => {
          document.querySelector<HTMLTextAreaElement>('.tchat-textarea')?.focus();
        });
      }
      return;
    }
  };
  const sock = useTeamChatSocket(onEvent);
  const connTitle = sock.status === 'open' ? 'Connected' : sock.status === 'reconnecting' ? 'Reconnecting…' : 'Offline';

  // ── initial load
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [{ channels: chans }, users] = await Promise.all([listChatChannels(), listUsers()]);
        if (cancelled) return;
        setChannels(chans);
        setAllUsers(users);
        const preferred = localStorage.getItem('wsd.chat.active') || (chans[0]?.id ?? null);
        if (preferred && chans.some((c) => c.id === preferred)) setActiveId(preferred);
        else if (chans[0]) setActiveId(chans[0].id);
      } catch (err) {
        if (!cancelled) setError('Failed to load channels');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, []);

  // Switching channels (above, in the rail/handlers) closes the lightbox —
  // synchronously, inside switchChannel, not via a delayed effect.

  // ── activate channel: subscribe + REST detail + history
  useEffect(() => {
    if (!activeId) return;
    localStorage.setItem('wsd.chat.active', activeId);
    // Switching channels abandons any in-flight recording and clears the
    // previous channel's messages immediately (no flicker of old content).
    cancelRecording();
    skipScroll.current = true;
    sock.subscribe(activeId);
    const known = channelsRef.current.find((c) => c.id === activeId);
    setActive(known || null);
    setTyping([]);
    setViewerOnly(false);
    setActiveCanSend(known?.canSend === 'admins' ? 'admins' : 'everyone');
    setCanWrite(true);
    setSettingsOpen(false);
    setSearchResults(null);
    setSearchQ('');
    setMessages([]);
    mdCache.current.clear();
    setComposer({ text: '', attachments: [] });
    setEditingMsgId(null);
    setEditText('');
    setDeleteMsgTarget(null);
    setNoMore(false);
    setLoadingEarly(false);
    setShowJump(false);
    noMoreRef.current = false;
    loadingEarlierRef.current = false;
    let cancelled = false;
    void getChatChannel(activeId)
      .then((res) => {
        if (cancelled) return;
        const ch = res.channel;
        setActive(ch);
        setActiveCanSend(ch.canSend === 'admins' ? 'admins' : 'everyone');
        setCanWrite(ch.maySend ?? localCanWrite());
        setChannels((prev) =>
          prev.map((c) => (c.id === ch.id ? { ...(ch as ChatChannel), unread: c.unread } : c))
        );
      })
      .catch(() => {});
    // REST fallback seed: fills history even when the socket replay is slow
    // (or the socket is reconnecting). Guarded so it never clobbers the
    // authoritative `subscribed` replay once that lands.
    void getChatMessages(activeId, { limit: 100 })
      .then((res) => {
        if (cancelled) return;
        setMessages((prev) => (prev.length ? prev : res.messages || []));
        skipScroll.current = false;
      })
      .catch(() => {});
    return () => { cancelled = true; sock.unsubscribe(activeId); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // Subscribe ONLY to the active channel (handled in the activate effect
  // above). The server skips the sender on `chat_bump`, so a message I send
  // never loops back as a full `message` frame → no self sound / self unread.
  // Cross-channel notifications ride on `chat_bump` (arrives for every
  // authorized client) + the 30s list poll reconciles authoritative counts.

  // Keep the channel list fresh (unread counts, lastMessageAt recency).
  useEffect(() => {
    let alive = true;
    const poll = () => {
      void listChatChannels().then(({ channels: chans }) => {
        if (!alive) return;
        setChannels(chans);
        chans.forEach((c) => { if ((c.unread || 0) === 0) unreadLocal.current.delete(c.id); });
      }).catch(() => {});
    };
    const t = setInterval(poll, 30000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  // ── Tab title: keep the app's own title around, show a live unread count
  // while this tab is hidden, and restore the original on visibility, when
  // the count hits zero, or on unmount.
  useEffect(() => {
    if (!origTitleRef.current) origTitleRef.current = document.title;
    return () => { document.title = origTitleRef.current; };
  }, []);

  useEffect(() => {
    if (docVisible || unreadTotal() === 0) {
      document.title = origTitleRef.current || document.title;
    } else {
      document.title = `(${unreadTotal()}) Madar — Team Chat`;
    }
  }, [docVisible, channels]);

  // Mark read whenever the active channel list changes (new messages).
  useEffect(() => {
    if (!activeId || !messages.length) return;
    const anchor = messages[messages.length - 1].id;
    if (lastSeen.current.get(activeId) === anchor) return;
    lastSeen.current.set(activeId, anchor);
    sock.sendRead(activeId, anchor);
    void markChatRead(activeId, anchor).catch(() => {});
    
    // Update unread count for active channel locally instead of full list refresh
    setChannels((prev) => 
      prev.map(c => c.id === activeId ? { ...c, unread: 0 } : c)
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, activeId]);

  // Explicit "scroll to bottom" read receipt check
  useEffect(() => {
    const handleScroll = () => {
      const el = listRef.current;
      if (!el || !activeId || !messages.length) return;
      
      // Trigger when user is within 50px of the bottom
      if (el.scrollHeight - el.scrollTop <= el.clientHeight + 50) {
        const anchor = messages[messages.length - 1].id;
        if (lastSeen.current.get(activeId) === anchor) return;
        
        lastSeen.current.set(activeId, anchor);
        sock.sendRead(activeId, anchor);
        void markChatRead(activeId, anchor).catch(() => {});
      }
    };

    const el = listRef.current;
    el?.addEventListener('scroll', handleScroll);
    return () => el?.removeEventListener('scroll', handleScroll);
  }, [messages, activeId]);


  // scroll to bottom on message growth (only when the reader is near the bottom)
  useEffect(() => {
    const el = listRef.current;
    if (!el || skipScroll.current) return;
    if (el.scrollHeight - el.scrollTop > el.clientHeight + 50) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, activeId]);

  // ── Load-earlier paging: prepend older history, preserving the reader's
  // distance from the bottom so the view doesn't jump when messages land.
  const loadEarlier = useCallback(() => {
    const cid = activeIdRef.current;
    if (!cid || loadingEarlierRef.current || noMoreRef.current) return;
    const anchorId = messagesRef.current[0]?.id;
    if (!anchorId) return;
    const el = listRef.current;
    const prevHeight = el ? el.scrollHeight : 0;
    const prevTop = el ? el.scrollTop : 0;
    loadingEarlierRef.current = true;
    setLoadingEarly(true);
    getChatMessages(cid, { limit: 200, before: anchorId })
      .then((res) => {
        const older = res.messages || [];
        if (!older.length) {
          noMoreRef.current = true;
          setNoMore(true);
          return;
        }
        setMessages((prevList) => {
          const have = new Set(prevList.map((m) => m.id));
          const fresh = older.filter((m) => !have.has(m.id));
          if (!fresh.length) return prevList;
          const merged = [...fresh, ...prevList];
          return merged.length > 2000 ? merged.slice(0, 2000) : merged;
        });
      })
      .catch(() => { /* transient — retry on the next scroll-up */ })
      .finally(() => {
        loadingEarlierRef.current = false;
        setLoadingEarly(false);
        // Double rAF (same style as the `subscribed` reset): the first frame
        // lets Preact commit the prepended DOM, the second restores the exact
        // distance from the bottom so the view never jumps.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            const el2 = listRef.current;
            if (el2) el2.scrollTop = prevTop + (el2.scrollHeight - prevHeight);
          });
        });
      });
  }, []);

  const jumpToBottom = useCallback((instant = false) => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: reducedMotion() || instant ? 'auto' : 'smooth',
    });
  }, []);

  // Scroll listener: drives the jump-to-bottom FAB and load-earlier paging.
  // Deps include `active`, not just activeId: on initial load the messages
  // list only renders after `setActive` (activate effect), so without `active`
  // here the listener would attach to a null listRef on first load and never
  // re-run — leaving the FAB dead for the auto-selected channel until a switch.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const onScroll = () => {
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      setShowJump(dist > 120);
      if (el.scrollTop < 80) void loadEarlier();
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [loadEarlier, loading, activeId, active]);

  // The FAB stays mounted (visibility:hidden) so it never leaves the DOM —
  // but if it disappears WHILE focused, redirect focus into the message list
  // instead of dropping it to <body> (a hidden+disabled button can't hold it).
  useEffect(() => {
    if (showJump) {
      fabWasVisibleRef.current = true;
      return;
    }
    const wasVisible = fabWasVisibleRef.current;
    fabWasVisibleRef.current = false;
    if (wasVisible && document.activeElement?.classList.contains('tchat-jump-bottom')) {
      listRef.current?.focus();
    }
  }, [showJump]);

  // clear typing indicators after a pause
  useEffect(() => {
    if (!typing.length) return;
    const t = setTimeout(() => setTyping([]), 4500);
    return () => clearTimeout(t);
  }, [typing]);

  // Composer auto-grow: fit the textarea to its content (cap at 150px), and
  // reset it whenever the draft is cleared or the channel switches.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    if (composer.text) el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
  }, [composer.text, activeId]);

  // ── pendingJump: scroll to a message after switching to its channel
  useEffect(() => {
    if (!pendingJump) return;
    if (pendingJump.channelId !== activeId) return;
    const el = document.getElementById(`msg-${pendingJump.msgId}`);
    if (el) {
      jumpToMessage(pendingJump.msgId);
      setPendingJump(null);
    }
    // else: wait — messages may still be loading via WS replay or REST seed
  }, [messages, pendingJump, activeId]);

  // ── Global search: debounced handler
  const doGlobalSearch = (q: string) => {
    if (globalDebounceRef.current) clearTimeout(globalDebounceRef.current);
    if (!q.trim()) {
      setGlobalResults(null);
      setGlobalLoading(false);
      return;
    }
    setGlobalLoading(true);
    globalDebounceRef.current = window.setTimeout(() => {
      const reqId = ++globalReq.current;
      void searchAllChatMessages(q.trim())
        .then((res) => {
          if (reqId !== globalReq.current) return;
          setGlobalResults(res.results || []);
        })
        .catch(() => {
          if (reqId !== globalReq.current) return;
          setGlobalResults([]);
        })
        .finally(() => {
          if (reqId === globalReq.current) setGlobalLoading(false);
        });
    }, 250);
  };

  const toggleGlobalSearch = () => {
    if (globalOpen) {
      setGlobalOpen(false);
      setGlobalQ('');
      setGlobalResults(null);
    } else {
      setGlobalOpen(true);
      requestAnimationFrame(() => searchBoxRef.current?.focus());
    }
  };

  // Clean up any in-flight voice recording on unmount.
  useEffect(() => {
    return () => {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      const rec = mediaRecorderRef.current;
      discardRecordingRef.current = true;
      if (rec && rec.state !== 'inactive') {
        try { rec.stop(); } catch { /* ignore */ }
      }
      mediaRecorderRef.current = null;
      setIsRecording(false);
    };
  }, []);

  // Dialog focus management: move focus in on open, Escape closes, trap Tab,
  // restore focus to the opener when closed.
  const trapTab = (e: KeyboardEvent, container: HTMLElement | null) => {
    if (e.key !== 'Tab' || !container) return;
    const focusables = Array.from(
      container.querySelectorAll<HTMLElement>('button, input, select, textarea, [href], [tabindex]:not([tabindex="-1"])')
    ).filter((el) => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true');
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  // Escape cancels edit mode
  useEffect(() => {
    if (!editingMsgId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelEdit();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [editingMsgId]);

  useEffect(() => {
    if (!createOpen) return;
    dialogRestoreRef.current = document.activeElement as HTMLElement | null;
    const el = createDialogRef.current?.querySelector<HTMLElement>('input, button, [tabindex]:not([tabindex="-1"])');
    el?.focus();
  }, [createOpen]);

  useEffect(() => {
    if (!directOpen) return;
    dialogRestoreRef.current = document.activeElement as HTMLElement | null;
    const el = directDialogRef.current?.querySelector<HTMLElement>('.tchat-user-row') ||
      directDialogRef.current?.querySelector<HTMLElement>('button, [tabindex]:not([tabindex="-1"])');
    el?.focus();
  }, [directOpen]);

  useEffect(() => {
    if (createOpen || directOpen) return;
    dialogRestoreRef.current?.focus?.();
    dialogRestoreRef.current = null;
  }, [createOpen, directOpen]);

  // Channel-settings popover: close on outside click, or Escape while the
  // focus is inside the wrap (A1/A5: restore focus to the trigger button).
  useEffect(() => {
    if (!settingsOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!settingsWrapRef.current?.contains(e.target as Node)) setSettingsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && settingsWrapRef.current?.contains(document.activeElement)) {
        setSettingsOpen(false);
        settingsBtnRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [settingsOpen]);

  // Focus the first menu option when the popover was opened via the keyboard
  // (APG Menu Button pattern — A2). Mouse-opened popovers keep focus on the
  // trigger button.
  useEffect(() => {
    if (!settingsOpen || !settingsOpenByKeyRef.current) return;
    settingsOpenByKeyRef.current = false;
    firstOptionRef.current?.focus();
  }, [settingsOpen]);

  const doSend = async () => {
    if (!activeId || sending) return;
    const text = composer.text.trim();
    if (!text && !composer.attachments.length) return;
    setSending(true);
    setError('');
    try {
      const atts = composer.attachments.length
        ? composer.attachments.map((a) => ({ id: a.id, name: a.name }))
        : undefined;
      await sendChatMessage(activeId, {
        text,
        replyTo: composer.replyTo?.id,
        attachments: atts,
      });
      setComposer({ text: '', attachments: [] });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message');
    } finally {
      setSending(false);
    }
  };

  const onPickAttachments = async (files: FileList | File[]) => {
    if (!activeId) return;
    const fileList = Array.from(files).slice(0, 5 - composer.attachments.length);
    if (!fileList.length) return;
    try {
      const uploadPromises = fileList.map(async (f) => {
        const { attachment } = await uploadChatAttachment(activeId, f);
        return {
          id: attachment.id,
          name: attachment.name,
          size: attachment.size,
          kind: attachment.kind,
        };
      });
      
      const results = await Promise.all(uploadPromises);
      setComposer((c) => ({ ...c, attachments: [...c.attachments, ...results] }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    }
  };

  const createChannel = async () => {
    const name = newChannelName.trim();
    if (!name) return;
    setError('');
    try {
      const { channel } = await createChatChannel(name);
      setChannels((prev) => [...prev, channel as unknown as ChatChannel]);
      switchChannel(channel.id);
      setCreateOpen(false);
      setNewChannelName('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create channel');
    }
  };

  const startDirect = async (withId: string) => {
    setError('');
    try {
      const { channel } = await openDirectChat(withId);
      setChannels((prev) => {
        if (prev.some((c) => c.id === channel.id)) return prev;
        return [...prev, channel as unknown as ChatChannel];
      });
      switchChannel(channel.id);
      setDirectOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open conversation');
    }
  };

  const runDelete = async () => {
    if (!deleteTarget) return;
    setError('');
    try {
      await deleteChatChannel(deleteTarget.id);
      unreadLocal.current.delete(deleteTarget.id);
      if (unreadTotal() === 0) document.title = origTitleRef.current || document.title;
      let rest: ChatChannel[] = [];
      setChannels((prev) => {
        rest = prev.filter((c) => c.id !== deleteTarget.id);
        return rest;
      });
      if (activeId === deleteTarget.id) {
        switchChannel(rest[0]?.id || null);
      }
      setDeleteTarget(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete channel');
    }
  };

  const togglePin = async (m: TeamChatMessage) => {
    if (!activeId) return;
    setError('');
    try {
      await pinChatMessage(activeId, m.id, !m.pinned);
      // optimistic — the ws pin frame also reconciles
      setMessages((prev) => prev.map((x) => (x.id === m.id ? { ...x, pinned: !m.pinned } : x)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to toggle pin');
    }
  };

  const startEdit = (m: TeamChatMessage) => {
    setEditingMsgId(m.id);
    setEditText(m.text);
    requestAnimationFrame(() => {
      const ta = document.querySelector<HTMLTextAreaElement>('.tchat-edit-textarea');
      if (ta) { ta.focus(); ta.select(); }
    });
  };

  const cancelEdit = () => {
    setEditingMsgId(null);
    setEditText('');
  };

  const doEdit = async () => {
    if (!activeId || !editingMsgId) return;
    const trimmed = editText.trim();
    if (!trimmed) return;
    const orig = messages.find((m) => m.id === editingMsgId);
    if (orig && trimmed === orig.text) { cancelEdit(); return; }
    setError('');
    try {
      await editChatMessage(activeId, editingMsgId, trimmed);
      setEditingMsgId(null);
      setEditText('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to edit message');
    }
  };

  const doDeleteMessage = async () => {
    if (!activeId || !deleteMsgTarget) return;
    setError('');
    try {
      await deleteChatMessage(activeId, deleteMsgTarget.id);
      setDeleteMsgTarget(null);
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.tchat-textarea')?.focus());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete message');
    }
  };

  const doToggleReaction = async (msgId: string, emoji: string) => {
    if (!activeId) return;
    // optimistic: toggle locally
    setMessages((prev) => prev.map((m) => {
      if (m.id !== msgId) return m;
      const reactions = { ...(m.reactions || {}) };
      const ids = reactions[emoji] ? [...reactions[emoji]] : [];
      const idx = ids.indexOf(meId);
      if (idx >= 0) ids.splice(idx, 1); else ids.push(meId);
      if (ids.length) reactions[emoji] = ids; else delete reactions[emoji];
      return { ...m, reactions };
    }));
    try {
      await toggleChatReaction(activeId, msgId, emoji);
      // WS message_updated will deliver the authoritative version.
    } catch (err) {
      // On failure the WS broadcast of the authoritative state will reconcile.
      setError(err instanceof Error ? err.message : 'Failed to react');
    }
  };

  const doSearch = async () => {
    if (!activeId || !searchQ.trim()) return;
    setError('');
    try {
      const { messages: found } = await searchChatMessages(activeId, searchQ.trim());
      setSearchResults(found);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
    }
  };

  const startRecording = async () => {
    if (!activeId || sending) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];
      discardRecordingRef.current = false;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        stream.getTracks().forEach(t => t.stop());
        if (discardRecordingRef.current) return;
        await sendVoiceNote(blob);
      };

      recorder.start();
      setIsRecording(true);
      setRecordTime(0);
      timerRef.current = window.setInterval(() => setRecordTime(t => t + 1), 1000);
    } catch (err) {
      setError('Microphone access denied');
    }
  };

  const stopRecording = () => {
    if (!isRecording || !mediaRecorderRef.current) return;
    mediaRecorderRef.current.stop();
    setIsRecording(false);
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  // Abandon an in-flight recording without sending it (unmount / channel switch).
  const cancelRecording = () => {
    discardRecordingRef.current = true;
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    const rec = mediaRecorderRef.current;
    if (rec && rec.state !== 'inactive') {
      try { rec.stop(); } catch { /* ignore */ }
    }
    mediaRecorderRef.current = null;
    setIsRecording(false);
    setRecordTime(0);
  };

  const sendVoiceNote = async (blob: Blob) => {
    if (!activeId) return;
    setSending(true);
    setError('');
    try {
      const file = new File([blob], `voice-${Date.now()}.webm`, { type: 'audio/webm' });
      const { attachment } = await uploadChatAttachment(activeId, file);
      await sendChatMessage(activeId, {
        text: '',
        attachments: [{ id: attachment.id, name: attachment.name }],
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send voice note');
    } finally {
      setSending(false);
    }
  };

  const jumpToMessage = (id: string) => {
    const el = document.getElementById(`msg-${id}`);
    if (el) {
      skipScroll.current = true;
      el.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
      el.setAttribute('tabindex', '-1');
      el.focus({ preventScroll: true });
      el.classList.add('tchat-msg-highlight');
      setTimeout(() => {
        el.classList.remove('tchat-msg-highlight');
        skipScroll.current = false;
      }, 1000);
    }
  };
  
  const otherDirectName = (c: ChatChannel): string => {
    const other = c.members.find((m) => m.userId !== meId);
    return other ? (other.displayName || other.username) : 'them';
  };

  const canDelete = (c: ChatChannel) => {
    if (c.kind !== 'channel') return false;
    return user?.role === 'admin' || c.createdBy === meId;
  };

  const canManageChannel = () => {
    if (!active || active.kind !== 'channel') return false;
    return user?.role === 'admin' || active.createdBy === meId || active.members?.some((m) => m.userId === meId && m.role === 'admin');
  };

  // Server-resolved write permission (`maySend`) is authoritative once the
  // channel detail/subscribe lands; `localCanWrite` is only a fallback and
  // for instant re-derivation on `channel_update`.
  const localCanWrite = () => !viewerOnly && (activeCanSend !== 'admins' || canManageChannel());
  const userCanWrite = () => canWrite;

  // Roving-tabindex keyboard navigation for the send-permissions menu (A2).
  const handleSettingsMenuKeyDown = (e: KeyboardEvent) => {
    const opts = Array.from(
      (e.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')
    );
    if (!opts.length) return;
    const idx = opts.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      opts[idx === -1 ? 0 : (idx + 1) % opts.length].focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      opts[idx === -1 ? opts.length - 1 : (idx - 1 + opts.length) % opts.length].focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      opts[0].focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      opts[opts.length - 1].focus();
    } else if (e.key === 'Tab') {
      // Close the menu and let the browser continue moving focus naturally (A4).
      setSettingsOpen(false);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setSettingsOpen(false);
      settingsBtnRef.current?.focus();
    }
  };

  const toggleCanSend = async (target?: 'everyone' | 'admins') => {
    if (!activeId || !active) return;
    const newMode = target ?? (activeCanSend === 'admins' ? 'everyone' : 'admins');
    // Picking the already-active option is a no-op: close and return focus.
    if (newMode === activeCanSend) {
      setSettingsOpen(false);
      settingsBtnRef.current?.focus();
      return;
    }
    setError('');
    try {
      await updateChatChannelSettings(activeId, newMode);
      setActiveCanSend(newMode);
      setCanWrite(!viewerOnly && (newMode !== 'admins' || canManageChannel()));
      setChannels((prev) =>
        prev.map((c) => (c.id === activeId ? { ...c, canSend: newMode } : c))
      );
      setSettingsOpen(false);
      settingsBtnRef.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update channel settings');
    }
  };

  const renderMsgHtml = (m: TeamChatMessage): string => {
    const key = `${m.id}:${m.text}:${m.editedAt ?? ''}`;
    const cached = mdCache.current.get(key);
    if (cached !== undefined) return cached;
    const html = renderTeamMarkdown(m.text);
    mdCache.current.set(key, html);
    return html;
  };

  const renderedMessages = useMemo(() => {
    return messages.map((m, i) => {
      const isMine = m.userId === meId;
      const prev = messages[i - 1];
      const isGrouped = prev ? shouldGroup(prev.createdAt, m.createdAt, 600_000, prev.userId === m.userId) : false;
      const dayKey = daySeparatorKey(m.createdAt);
      const prevDayKey = prev ? daySeparatorKey(prev.createdAt) : undefined;
      const showDaySep = !prev || dayKey !== prevDayKey;
      const reply = m.replyTo ? messages.find((x) => x.id === m.replyTo) : undefined;
      const author = active?.members.find((x) => x.userId === m.userId);
      const canDeleteMsg = isMine || user?.role === 'admin' || canManageChannel();
      const isEditing = editingMsgId === m.id;
      const bodyHtml = m.text ? renderMsgHtml(m) : '';

      return (
        <Fragment key={m.id}>
          {showDaySep && (
            <div class="tchat-day-sep">
              <span>{formatDayLabel(dayKey)}</span>
            </div>
          )}
          <div id={`msg-${m.id}`} class={`tchat-msg ${isMine ? 'mine' : ''}${isGrouped ? ' grouped' : ''}`}>
          {!isGrouped && (
            <div class="tchat-msg-avatar">
              <Avatar name={m.username} avatar={avatarUrl(m.userId, author?.avatarExt)} size={32} />
            </div>
          )}
          <div class="tchat-msg-bubble">
            {!isGrouped && (
              <div class="tchat-msg-author" style="font-weight:600;font-size:0.75rem;margin-bottom:4px">
                {m.username}
              </div>
            )}
            {reply ? (
              <div class="tchat-msg-reply">
                <span class="tchat-msg-reply-from">{reply.username}</span> {(reply.text || '').slice(0, 60) || '📎'}
              </div>
            ) : m.replyTo ? (
              <div class="tchat-msg-reply tchat-msg-reply-deleted">
                <span class="tchat-msg-reply-from">Reply</span> Original message deleted
              </div>
            ) : null}
            {isEditing ? (
              <div class="tchat-edit-box">
                <textarea
                  class="tchat-edit-textarea"
                  aria-label="Edit message"
                  value={editText}
                  onInput={(e: Event) => setEditText((e.target as HTMLTextAreaElement).value)}
                  onKeyDown={(e: KeyboardEvent) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void doEdit();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      cancelEdit();
                    }
                  }}
                />
                <div class="tchat-edit-actions">
                  <button class="btn-ghost sm" onClick={cancelEdit}>Cancel</button>
                  <button class="btn-primary sm" onClick={() => void doEdit()} disabled={!editText.trim() || editText.trim() === m.text}>Save</button>
                </div>
              </div>
            ) : (
              m.text && (
                <div
                  class="tchat-msg-text md"
                  dangerouslySetInnerHTML={{ __html: bodyHtml }}
                />
              )
            )}
            {m.attachments && m.attachments.length > 0 && (
              <MessageAttachments message={m} onOpenLightbox={(imgs, i) => setLightbox({ images: imgs, index: i })} />
            )}
            <MessageReactions
              reactions={m.reactions}
              meId={meId}
              onToggle={(emoji) => void doToggleReaction(m.id, emoji)}
              onPicker={() => setEmojiPickerFor((cur) => (cur === m.id ? null : m.id))}
            />
            {emojiPickerFor === m.id && (
              <EmojiPicker
                onSelect={(emoji) => {
                  setEmojiPickerFor(null);
                  void doToggleReaction(m.id, emoji);
                }}
                onClose={() => setEmojiPickerFor(null)}
              />
            )}
            <div class="tchat-msg-time">
              {fmtTime(m.createdAt)}
              {m.editedAt && <span class="tchat-msg-edited" title={`Edited ${new Date(m.editedAt).toLocaleString()}`}>edited</span>}
              {isMine && <MessageStatus status={m.status} />}
            </div>
          </div>
          <div class="tchat-msg-side">
            {(isMine || canDeleteMsg) && (
              <>
                {isMine && (
                  <button
                    class="tchat-msg-action"
                    onClick={() => startEdit(m)}
                    title="Edit message"
                    aria-label="Edit message"
                    disabled={isEditing}
                  >
                    <Pencil width={12} height={12} />
                  </button>
                )}
                {canDeleteMsg && (
                  <button
                    class="tchat-msg-action tchat-msg-action-danger"
                    onClick={() => setDeleteMsgTarget(m)}
                    title="Delete message"
                    aria-label="Delete message"
                  >
                    <Trash2 width={12} height={12} />
                  </button>
                )}
              </>
            )}
            {userCanWrite() && (
              <>
                <button class="tchat-msg-action" onClick={() => {
                  setComposer((c) => ({ ...c, replyTo: m }));
                }} title="Reply">
                  <div style="display:flex;align-items:center;gap:4px;font-size:0.65rem"><Send width={10} height={10} /> Reply</div>
                </button>
                <button class="tchat-msg-action" onClick={() => void togglePin(m)} aria-pressed={!!m.pinned} aria-label={m.pinned ? 'Unpin message' : 'Pin message'} title={m.pinned ? 'Unpin' : 'Pin'}>
                  <Pin width={10} height={10} style={m.pinned ? 'color:var(--accent)' : ''} />
                </button>
              </>
            )}
          </div>
        </div>
        </Fragment>
      );
    });
  }, [messages, meId, active, viewerOnly, activeCanSend, canWrite, editingMsgId, editText, emojiPickerFor]);

  const pinned = useMemo(() => messages.filter((m) => m.pinned), [messages]);

  // ── render
  if (loading) {
    return (
      <div class="view">
        <div style="display:flex;align-items:center;justify-content:center;height:60vh;gap:8px">
          <Loader2 width={20} height={20} class="icon spin" />
          <span class="dim">Loading channels…</span>
        </div>
      </div>
    );
  }

  return (
    <div class="view chat-view">
      <div class={`tchat-backdrop${railOpen ? ' open' : ''}`} onClick={closeRail} />
      <div
        id="tchat-rail"
        ref={railRef}
        class={`tchat-rail${railOpen ? ' open' : ''}${railCollapsed ? ' collapsed' : ''}`}
      >
        <nav class="tchat-rail-nav" aria-label="Channels">
        <div class="tchat-rail-head">
          <span class="tchat-rail-title">
            <MessageCircle width={16} height={16} class="icon" />
            Team Chat
          </span>
          <div style="display:flex;align-items:center;gap:8px">
            <span
              class={`tchat-conn-dot tchat-conn-${sock.status}`}
              role="status"
              aria-label={connTitle}
              title={connTitle}
            />
            <button
              class="btn btn-icon btn-sm"
              onClick={toggleSound}
              aria-pressed={soundOn}
              title={soundOn ? 'Disable notification sound' : 'Enable notification sound'}
              aria-label={soundOn ? 'Disable notification sound' : 'Enable notification sound'}
            >
              {soundOn ? <Volume2 width={14} height={14} /> : <VolumeX width={14} height={14} />}
            </button>
            <button
              class="btn btn-icon btn-sm tchat-collapse-btn"
              onClick={toggleRailCollapsed}
              aria-expanded={!railCollapsed}
              title={railCollapsed ? 'Expand channel list' : 'Collapse channel list'}
              aria-label={railCollapsed ? 'Expand channel list' : 'Collapse channel list'}
            >
              {railCollapsed ? <ChevronRight width={14} height={14} /> : <ChevronLeft width={14} height={14} />}
            </button>
            <button
              class="btn btn-icon btn-sm"
              ref={globalSearchBtnRef}
              onClick={toggleGlobalSearch}
              aria-pressed={globalOpen}
              title="Search all channels"
              aria-label="Search all channels"
            >
              <Search width={14} height={14} />
            </button>
            <span class="tchat-online">{presence.size} online</span>
            {presence.size > 0 && (
              <span class="tchat-presence-avatars">
                {Array.from(presence.values()).slice(0, 5).map((p) => (
                  <button
                    key={p.id}
                    class="tchat-presence-avatar"
                    aria-label={`View ${p.displayName || p.username}'s profile`}
                    onClick={() => setLocation(`/user/${p.id}`)}
                  >
                    <Avatar name={p.displayName || p.username} avatar={avatarUrl(p.id, p.avatarExt)} size={22} title={p.displayName || p.username} />
                  </button>
                ))}
                {presence.size > 5 && <span class="tchat-members-all" title={`${presence.size} members online`} aria-label={`${presence.size} members online`}>+{presence.size - 5}</span>}
              </span>
            )}
          </div>
        </div>
        {globalOpen && (
          <div class="tchat-global-search">
            <input
              ref={searchBoxRef}
              class="input"
              placeholder="Search all channels…"
              aria-label="Search all channels"
              value={globalQ}
              onInput={(e: Event) => {
                const v = (e.target as HTMLInputElement).value;
                setGlobalQ(v);
                doGlobalSearch(v);
              }}
              onKeyDown={(e: KeyboardEvent) => {
                if (e.key === 'Escape') {
                  setGlobalOpen(false);
                  setGlobalQ('');
                  setGlobalResults(null);
                  globalSearchBtnRef.current?.focus();
                }
              }}
            />
            {globalLoading && <div class="tchat-global-status"><Loader2 width={12} height={12} class="icon spin" /> Searching…</div>}
            {globalResults !== null && !globalLoading && (
              <div class="tchat-global-results">
                {globalResults.length === 0 && <div class="tchat-global-empty">No matches.</div>}
                {globalResults.map((gr) => {
                  const kindIcon = gr.channelKind === 'project' ? <FolderOpen width={13} height={13} /> :
                    gr.channelKind === 'direct' ? <UserIcon width={13} height={13} /> :
                    <Hash width={13} height={13} />;
                  return (
                    <div key={gr.channelId} class="tchat-global-channel">
                      <div class="tchat-global-channel-header">
                        <span class="tchat-global-channel-icon">{kindIcon}</span>
                        <span class="tchat-global-channel-name">{gr.channelName}</span>
                        <span class="tchat-global-channel-count">{gr.messages.length}</span>
                      </div>
                      {gr.messages.map((m) => (
                        <div
                          key={m.id}
                          class="tchat-global-hit"
                          role="button"
                          tabIndex={0}
                          onClick={() => {
                            setPendingJump({ channelId: gr.channelId, msgId: m.id });
                            setGlobalOpen(false);
                            setGlobalQ('');
                            setGlobalResults(null);
                            switchChannel(gr.channelId);
                          }}
                          onKeyDown={(e: KeyboardEvent) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              setPendingJump({ channelId: gr.channelId, msgId: m.id });
                              setGlobalOpen(false);
                              setGlobalQ('');
                              setGlobalResults(null);
                              switchChannel(gr.channelId);
                            }
                          }}
                        >
                          <span class="tchat-global-hit-author">{m.username}</span>
                          <span
                            class="tchat-global-hit-text"
                            dangerouslySetInnerHTML={{ __html: snippetHtml(m.text, globalQ) }}
                          />
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {user?.role !== 'viewer' && (
          <div class="tchat-rail-actions">
            <button class="btn btn-sm" onClick={() => setCreateOpen(true)} title="New channel">
              <Plus width={14} height={14} /> Channel
            </button>
            <button class="btn btn-sm" onClick={() => setDirectOpen(true)} title="New direct message">
              <UserIcon width={14} height={14} /> Direct
            </button>
          </div>
        )}
        <div class="tchat-channel-list" aria-label="Channel list">
          {channels.map((c) => {
            const isActive = c.id === activeId;
            const onlineNow = c.members.filter((m) => presence.has(m.userId) && m.userId !== meId).length;
            const label = channelLabel(c, { id: meId });
            return (
              <div
                key={c.id}
                class={`tchat-channel-item${isActive ? ' active' : ''}${c.unread ? ' unread' : ''}`}
              >
                <div
                  class={`tchat-channel-row${isActive ? ' active' : ''}${c.unread ? ' unread' : ''}`}
                  onClick={() => switchChannel(c.id)}
                  role="button"
                  tabIndex={0}
                  aria-label={c.unread ? `${label}, ${c.unread} unread messages` : label}
                  onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switchChannel(c.id); } }}
                >
                  <span class="tchat-channel-icon">
                    {c.kind === 'project' ? <FolderOpen width={15} height={15} /> : c.kind === 'direct' ? <UserIcon width={15} height={15} /> : <Hash width={15} height={15} />}
                  </span>
                  <span class="tchat-channel-meta">
                    <div class="tchat-channel-name-row" style="display:flex;justify-content:space-between;align-items:center;gap:8px">
                      <span class="tchat-channel-name">{label}</span>
                    </div>
                    <span class="tchat-channel-sub">
                      {c.kind === 'direct' ? (onlineNow ? `${onlineNow} online` : channelSub(c, { id: meId })) : channelSub(c, { id: meId })}
                    </span>
                  </span>
                  <span class="tchat-channel-side">
                    {c.lastMessageAt && <span class="tchat-channel-time">{fmtTime(c.lastMessageAt)}</span>}
                    {c.unread ? <span class="tchat-unread-badge">{c.unread > 99 ? '99+' : c.unread}</span> : null}
                  </span>
                </div>
                {canDelete(c) && (
                  <button
                    class="tchat-delete-btn"
                    title={`Delete channel ${label}`}
                    aria-label={`Delete channel ${label}`}
                    onClick={(e: Event) => { e.stopPropagation(); setDeleteTarget(c); }}
                  >
                    <X width={12} height={12} />
                  </button>
                )}
              </div>
            );
          })}
          {!channels.length && (
            <div class="tchat-empty-rail">No conversations yet. Create a channel to get started.</div>
          )}
        </div>
        </nav>
      </div>

      <div class="tchat-main" inert={railOpen && isPhone}>
        {active ? (
          <>
            <div class="tchat-head">
              <div style="display:flex;align-items:center;gap:10px;min-width:0">
                {(isTablet || railCollapsed) && (
                  <button
                    ref={burgerRef}
                    class="tchat-burger"
                    onClick={openRail}
                    aria-expanded={isPhone ? railOpen : !railCollapsed}
                    aria-controls="tchat-rail"
                    title="Toggle channel list"
                    aria-label="Toggle channel list"
                  >
                    <Menu width={16} height={16} />
                  </button>
                )}
                <span class="tchat-channel-icon">{active.kind === 'project' ? <FolderOpen width={15} height={15} /> : active.kind === 'direct' ? <UserIcon width={15} height={15} /> : <Hash width={15} height={15} />}</span>
                <div style="min-width:0">
                  <div class="tchat-head-title">{channelLabel(active, { id: meId })}</div>
                  <div class="tchat-head-sub">
                    {active.kind === 'project' ? 'Project channel' : active.kind === 'direct' ? 'Direct message' : 'Team channel'}
                    {viewerOnly ? ' · read-only' : ''}
                  </div>
                </div>
              </div>
              <div style="display:flex;align-items:center;gap:8px">
                <div class="tchat-member-avatars">
                  {active.members.slice(0, 4).map((m) => (
                    <button
                      key={m.userId}
                      class="tchat-presence-avatar"
                      aria-label={`View ${m.displayName || m.username}'s profile`}
                      onClick={() => setLocation(`/user/${m.userId}`)}
                    >
                      <Avatar name={m.displayName || m.username} avatar={avatarUrl(m.userId, m.avatarExt)} size={22} title={m.displayName || m.username} />
                    </button>
                  ))}
                  {(!active.members.length || active.kind === 'channel') && (
                    <span class="tchat-members-all" title="All members" aria-label="All channel members">
                      <UsersIcon width={14} height={14} />
                    </span>
                  )}
                </div>
                <button class="btn btn-sm" ref={channelSearchBtnRef} onClick={() => setSearchResults((prev) => (prev === null ? [] : null))} aria-pressed={searchResults !== null} title="Search" aria-label="Search messages in this channel">
                  <Search width={14} height={14} /> Search
                </button>
                {active.kind === 'channel' && canManageChannel() && (
                  <div class="tchat-settings-wrap" ref={settingsWrapRef}>
                    <button
                      ref={settingsBtnRef}
                      class="btn btn-icon tchat-settings-btn"
                      onClick={() => setSettingsOpen((o) => !o)}
                      onKeyDown={(e: KeyboardEvent) => {
                        if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
                          e.preventDefault();
                          if (!settingsOpen) {
                            settingsOpenByKeyRef.current = true;
                            setSettingsOpen(true);
                          }
                        }
                      }}
                      aria-haspopup="menu"
                      aria-expanded={settingsOpen}
                      aria-controls="tchat-settings-menu"
                      title="Channel settings"
                      aria-label="Channel settings"
                    >
                      <Settings width={14} height={14} />
                    </button>
                    {settingsOpen && (
                      <div
                        id="tchat-settings-menu"
                        class="tchat-settings-popover"
                        role="menu"
                        aria-label="Channel send permissions"
                        onKeyDown={handleSettingsMenuKeyDown}
                      >
                        <div class="tchat-settings-title">Who can send</div>
                        <button
                          ref={firstOptionRef}
                          class={`tchat-settings-option${activeCanSend === 'everyone' ? ' active' : ''}`}
                          role="menuitemradio"
                          aria-checked={activeCanSend === 'everyone'}
                          onClick={() => void toggleCanSend('everyone')}
                        >
                          <Check width={13} height={13} style={activeCanSend === 'everyone' ? '' : 'visibility:hidden'} />
                          <span>
                            <span class="tchat-settings-option-name">Everyone can send</span>
                            <span class="tchat-settings-option-sub">All channel members may post</span>
                          </span>
                        </button>
                        <button
                          class={`tchat-settings-option${activeCanSend === 'admins' ? ' active' : ''}`}
                          role="menuitemradio"
                          aria-checked={activeCanSend === 'admins'}
                          onClick={() => void toggleCanSend('admins')}
                        >
                          <Check width={13} height={13} style={activeCanSend === 'admins' ? '' : 'visibility:hidden'} />
                          <span>
                            <span class="tchat-settings-option-name">Only admins can send</span>
                            <span class="tchat-settings-option-sub">Editors and viewers read only</span>
                          </span>
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

             {/* pinned banner */}
             {pinned.length > 0 && (
               <PinnedMessageHeader 
                 message={pinned[0]} 
                 onJump={() => jumpToMessage(pinned[0].id)} 
               />
             )}


            {/* search box */}
            {searchResults !== null && (
              <div class="tchat-searchbox">
                <input
                  class="input"
                  placeholder="Search this channel…"
                  aria-label="Search messages"
                  value={searchQ}
                  onInput={(e: Event) => setSearchQ((e.target as HTMLInputElement).value)}
                  onKeyDown={(e: KeyboardEvent) => {
                  if (e.key === 'Enter') void doSearch();
                  else if (e.key === 'Escape') {
                    setSearchResults(null);
                    setSearchQ('');
                    channelSearchBtnRef.current?.focus();
                  }
                }}
                />
                {searchResults.length > 0 && (
                  <div class="tchat-search-results">
                    {searchResults.map((m) => (
                      <div class="tchat-search-result" key={m.id}>
                        <span class="dim">{m.username}</span> {m.text.slice(0, 100) || '📎 attachment'}
                      </div>
                    ))}
                  </div>
                )}
                {searchResults.length === 0 && <div class="dim" style="padding:6px 10px">No matches.</div>}
              </div>
            )}

             <div class="tchat-messages" ref={listRef} role="log" aria-live="polite" aria-relevant="additions" aria-busy={loadingEarly} aria-label="Messages" tabIndex={-1}>
               {noMore && messages.length > 0 && (
                 <div class="tchat-history-start">Beginning of conversation</div>
               )}
               {!noMore && messages.length > 0 && (
                 <button
                   class="tchat-load-earlier"
                   onClick={() => void loadEarlier()}
                   disabled={loadingEarly}
                   aria-label="Load earlier messages"
                 >
                   {loadingEarly ? (
                     <><Loader2 width={12} height={12} class="icon spin" /> Loading earlier…</>
                   ) : (
                     'Load earlier'
                   )}
                 </button>
               )}
               {renderedMessages}
               {!messages.length && (
                 <div class="tchat-empty-msg">
                   {active?.kind === 'direct' ? (
                     <>
                       You and {otherDirectName(active)} — say hello
                       {userCanWrite() && (
                         <button class="tchat-empty-btn" onClick={() => taRef.current?.focus()}>
                           Write first message
                         </button>
                       )}
                     </>
                   ) : active?.kind === 'project' ? (
                     'Workspace channel'
                   ) : active ? (
                     `# ${active.name} — Start the conversation`
                   ) : (
                     'No messages yet.'
                   )}
                 </div>
               )}
            </div>
            {/* Stay mounted: unmounting mid-focus drops focus to <body>. visibility
              removes it from the tab order + a11y tree, disabled blocks clicks. */}
            <button
              class="tchat-jump-bottom"
              onClick={(e: MouseEvent) => {
                // e.detail === 0 means a keyboard activation (Enter/Space).
                // Instant jump for keyboard: a focused container + smooth scroll
                // conflict in Chromium (focus trims the animation), so keyboard
                // users get an instant jump and then focus moves to the list.
                const fromKeyboard = e.detail === 0;
                jumpToBottom(fromKeyboard);
                if (fromKeyboard) {
                  requestAnimationFrame(() => listRef.current?.focus());
                }
              }}
              aria-label="Jump to latest"
              title="Jump to latest"
              disabled={!showJump}
              aria-hidden={!showJump}
              tabIndex={showJump ? 0 : -1}
              style={showJump ? undefined : 'visibility:hidden'}
            >
              <ArrowDownToLine width={16} height={16} />
            </button>
            {deletedNotice && <div role="status" aria-live="polite" class="sr-only">{deletedNotice}</div>}

            {/* typing row */}
            {typing.length > 0 && (
              <div class="tchat-typing" role="status">
                <Loader2 width={12} height={12} class="icon spin" />
                {typing.map((t) => t.username).join(', ')} {typing.length > 1 ? 'are' : 'is'} typing…
              </div>
            )}

            {error && <div class="form-error" role="alert">{error}</div>}

            {/* composer */}
            {userCanWrite() ? (
              <div class="tchat-composer">
                {composer.replyTo && (
                  <div class="tchat-composer-reply">
                    Replying to {composer.replyTo.username}: {(composer.replyTo.text || '').slice(0, 60) || '📎'}
                    <button class="tchat-x" onClick={() => setComposer((c) => ({ ...c, replyTo: undefined }))} aria-label="Cancel reply">
                      <X width={12} height={12} />
                    </button>
                  </div>
                )}
                {composer.attachments.map((a) => (
                  <div class="tchat-composer-att" key={a.id}>
                    {a.kind === 'image' && <AttachImage id={a.id} alt={a.name} />}
                    <span class="dim">{a.name}</span>
                    <button class="tchat-x" onClick={() => setComposer((c) => ({ ...c, attachments: c.attachments.filter((x) => x.id !== a.id) }))} aria-label="Remove attachment">
                      <X width={12} height={12} />
                    </button>
                  </div>
                ))}
                    <div style="display:flex;gap:8px;align-items:flex-end">
                      {isRecording && (
                        <div class="tchat-recording-indicator">
                          <span class="tchat-recording-pulse" aria-hidden="true"></span>
                          <span role="status">Recording…</span>
                          <span aria-hidden="true">{Math.floor(recordTime / 60)}:{ (recordTime % 60).toString().padStart(2, '0') }</span>
                        </div>
                      )}
                      <textarea
                        ref={taRef}
                        class="tchat-textarea"
                        placeholder={isRecording ? "Recording..." : "Type a message…"}
                        aria-label="Type a message"
                        rows={2}
                        maxLength={5000}
                        value={composer.text}
                        onInput={(e: Event) => {
                          const el = e.target as HTMLTextAreaElement;
                          const v = el.value;
                          setComposer((c) => ({ ...c, text: v }));
                          if (v.trim()) sock.sendTyping(active.id);
                          el.style.height = 'auto';
                          el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
                        }}
                        onKeyDown={(e: KeyboardEvent) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            void doSend();
                          }
                        }}
                      />
                      <input
                        ref={fileInput}
                        type="file"
                        multiple
                        hidden
                        aria-label="Attach files"
                        onChange={(e: Event) => {
                          const el = e.target as HTMLInputElement;
                          if (el.files) void onPickAttachments(el.files);
                          el.value = '';
                        }}
                      />
                      <button class="btn btn-icon" title="Attach file" aria-label="Attach file" onClick={() => fileInput.current?.click()}>
                        <Paperclip width={16} height={16} />
                      </button>
                      <button
                        class={`btn btn-icon ${isRecording ? 'btn-recording' : ''}`}
                        title={isRecording ? 'Stop voice note' : 'Record a voice note'}
                        aria-label="Voice note"
                        aria-pressed={isRecording}
                        onMouseDown={() => { micDownAt.current = Date.now(); void startRecording(); }}
                        onMouseUp={() => { stopRecording(); }}
                        onMouseLeave={() => { if (micDownAt.current !== 0) { micDownAt.current = 0; stopRecording(); } }}
                        onTouchStart={(e) => { e.preventDefault(); micDownAt.current = Date.now(); void startRecording(); }}
                        onTouchEnd={(e) => { e.preventDefault(); stopRecording(); }}
                        onClick={() => {
                          // A mouse/touch click already ran start+stop via the
                          // down/up handlers; only a keyboard-activated click
                          // (no preceding pointerdown) reaches the toggle.
                          if (micDownAt.current !== 0) { micDownAt.current = 0; return; }
                          if (isRecording) stopRecording(); else void startRecording();
                        }}
                      >
                        <Mic width={16} height={16} />
                      </button>
                      <button class="btn btn-primary" onClick={() => void doSend()} disabled={sending} aria-label="Send">
                        {sending ? <Loader2 width={16} height={16} class="icon spin" /> : <Send width={16} height={16} />}
                      </button>
                    </div>
                    {composer.text.length > 4800 && (
                      <span class="tchat-char-counter" aria-live="off">{composer.text.length}/5000</span>
                    )}

              </div>
            ) : viewerOnly ? (
              <div class="tchat-readonly" role="status">Viewer — you can read this channel but not reply.</div>
            ) : (
              <div class="tchat-readonly" role="status">Only admins can send in this channel.</div>
            )}
          </>
        ) : (
          <div class="tchat-main-empty">
            <MessageCircle width={32} height={32} class="icon" />
            <p>Select a conversation to start chatting.</p>
          </div>
        )}
      </div>

      {/* create channel modal */}
      {createOpen && (
        <div
          class="modal-overlay"
          ref={createDialogRef}
          onMouseDown={(e: any) => { if (e.target === e.currentTarget) setCreateOpen(false); }}
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key === 'Escape') { e.stopPropagation(); setCreateOpen(false); }
            trapTab(e, createDialogRef.current);
          }}
        >
          <form
            class="modal-card reauth-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="chat-create-title"
            onSubmit={(e: Event) => { e.preventDefault(); void createChannel(); }}
          >
            <div class="reauth-avatar" aria-hidden="true"><Plus width={24} height={24} /></div>
            <div class="reauth-title" id="chat-create-title" style="text-align:center">New channel</div>
            <p class="settings-hint" style="text-align:center">Team-wide channel — every member can read and post.</p>
            <div style="display:flex;flex-direction:column;gap:10px;margin-top:12px">
              <input
                class="input"
                placeholder="Channel name"
                aria-label="Channel name"
                value={newChannelName}
                onInput={(e: Event) => setNewChannelName((e.target as HTMLInputElement).value)}
              />
            </div>
            <div style="display:flex;gap:8px;margin-top:14px;justify-content:center">
              <button class="btn-ghost sm" type="button" onClick={() => setCreateOpen(false)}>Cancel</button>
              <button class="btn-primary sm" type="submit">Create</button>
            </div>
          </form>
        </div>
      )}

      {/* direct modal */}
      {directOpen && (
        <div
          class="modal-overlay"
          ref={directDialogRef}
          onMouseDown={(e: any) => { if (e.target === e.currentTarget) setDirectOpen(false); }}
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key === 'Escape') { e.stopPropagation(); setDirectOpen(false); }
            trapTab(e, directDialogRef.current);
          }}
        >
          <div class="modal-card reauth-card" role="dialog" aria-modal="true" aria-labelledby="chat-direct-title">
            <div class="reauth-avatar" aria-hidden="true"><UserIcon width={24} height={24} /></div>
            <div class="reauth-title" id="chat-direct-title" style="text-align:center">New direct message</div>
            <div class="tchat-user-picker">
              {allUsers
                .filter((u) => u.id !== meId)
                .map((u) => (
                  <div
                    class="tchat-user-row"
                    key={u.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`Start a direct message with ${u.profile?.displayName || u.username}`}
                    onClick={() => void startDirect(u.id)}
                    onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void startDirect(u.id); } }}
                  >
                    <Avatar name={u.profile?.displayName || u.username} avatar={avatarUrl(u.id, u.profile?.avatarExt)} size={26} />
                    <span>{u.profile?.displayName || u.username}</span>
                    <span class="dim" style="margin-left:auto">{u.role}</span>
                  </div>
                ))}
              {!allUsers.filter((u) => u.id !== meId).length && <div class="dim">No other members yet.</div>}
            </div>
            <div style="display:flex;gap:8px;margin-top:14px;justify-content:center">
              <button class="btn-ghost sm" onClick={() => setDirectOpen(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* delete confirm */}
      <ConfirmModal
        open={!!deleteTarget}
        danger
        title={`Delete #${deleteTarget?.name || ''}?`}
        confirmLabel="Delete"
        onConfirm={() => void runDelete()}
        onCancel={() => setDeleteTarget(null)}
        message="This deletes the channel and all its messages. This cannot be undone."
      />

      {/* message delete confirm */}
      <ConfirmModal
        open={!!deleteMsgTarget}
        danger
        title="Delete message?"
        confirmLabel="Delete"
        onConfirm={() => void doDeleteMessage()}
        onCancel={() => setDeleteMsgTarget(null)}
        message="This message will be permanently deleted. This cannot be undone."
      />

      {/* attachment lightbox */}
      {lightbox && (
        <AttachmentLightbox
          images={lightbox.images}
          index={lightbox.index}
          onClose={() => setLightbox(null)}
          onIndexChange={(i) => setLightbox((lb) => (lb ? { ...lb, index: i } : lb))}
        />
      )}
    </div>
  );
}