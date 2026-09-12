/**
 * Chat.tsx
 * Madar — Team Chat. A WhatsApp-style workspace messenger:
 * manual team channels, per-project auto "project:<slug>" channels, and
 * direct 1:1 conversations. Text is sent over REST (single authoritative
 * write path); the WebSocket delivers live messages/typing/read/pin/presence.
 */
import { useEffect, useRef, useState, useMemo } from 'preact/hooks';
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
  searchChatMessages,
  listUsers,
  avatarUrl,
  type ChatChannel,
  type TeamChatMessage,
} from '../api';
import { Avatar } from '../components/Avatar';
import { ConfirmModal } from '../components/ConfirmModal';
import { VoiceNotePlayer } from '../components/VoiceNotePlayer';
import { useTeamChatSocket, type ChatSocketEvent } from '../useTeamChatSocket';
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

function MessageStatus({ status }: { status?: TeamChatMessage['status'] }) {
  if (!status) return null;
  if (status === 'sent') return <Check width={12} height={12} class="tchat-msg-status" />;
  if (status === 'delivered') return <CheckCheck width={12} height={12} class="tchat-msg-status" />;
  if (status === 'read') return <CheckCheck width={12} height={12} class="tchat-msg-status read" />;
  return null;
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
  const skipScroll = useRef(false);
  const activeIdRef = useRef<string | null>(null);
  const channelsRef = useRef<ChatChannel[]>([]);
  channelsRef.current = channels;
  activeIdRef.current = activeId;
  const lastSeen = useRef<Map<string, string>>(new Map());


  // ── socket — one connection per session
  const onEvent = (ev: ChatSocketEvent) => {
    if (ev.type === 'subscribed') {
      if (ev.channelId === activeIdRef.current) {
        skipScroll.current = true;
        setMessages(ev.messages || []);
        setViewerOnly(ev.level === 'read');
        requestAnimationFrame(() => requestAnimationFrame(() => { skipScroll.current = false; }));
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
          return [...prev, ev.message].slice(-500);
        });
      }
      setChannels((prev) =>
        prev.map((c) => (c.id === cid ? { ...c, lastMessageAt: ev.message.createdAt } : c))
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
  };
  const sock = useTeamChatSocket(onEvent);

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
    setSearchResults(null);
    setSearchQ('');
    setMessages([]);
    setComposer({ text: '', attachments: [] });
    let cancelled = false;
    void getChatChannel(activeId)
      .then((res) => {
        if (cancelled) return;
        const ch = res.channel;
        setActive(ch);
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

  // clear typing indicators after a pause
  useEffect(() => {
    if (!typing.length) return;
    const t = setTimeout(() => setTyping([]), 4500);
    return () => clearTimeout(t);
  }, [typing]);

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

  const userCanWrite = () => !viewerOnly;

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
      setActiveId(channel.id);
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
      setActiveId(channel.id);
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
      let rest: ChatChannel[] = [];
      setChannels((prev) => {
        rest = prev.filter((c) => c.id !== deleteTarget.id);
        return rest;
      });
      if (activeId === deleteTarget.id) {
        setActiveId(rest[0]?.id || null);
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
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.setAttribute('tabindex', '-1');
      el.focus({ preventScroll: true });
      el.classList.add('tchat-msg-highlight');
      setTimeout(() => {
        el.classList.remove('tchat-msg-highlight');
        skipScroll.current = false;
      }, 1000);
    }
  };
  
  const canDelete = (c: ChatChannel) => {
    if (c.kind !== 'channel') return false;
    return user?.role === 'admin' || c.createdBy === meId;
  };

  const renderedMessages = useMemo(() => {
    return messages.map((m, i) => {
      const isMine = m.userId === meId;
      const prev = messages[i - 1];
      const isGrouped = prev && prev.userId === m.userId;
      const reply = m.replyTo ? messages.find((x) => x.id === m.replyTo) : undefined;
      const author = active?.members.find((x) => x.userId === m.userId);

      return (
        <div key={m.id} id={`msg-${m.id}`} class={`tchat-msg ${isMine ? 'mine' : ''}`}>
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
            {reply && (
              <div class="tchat-msg-reply">
                <span class="tchat-msg-reply-from">{reply.username}</span> {(reply.text || '').slice(0, 60) || '📎'}
              </div>
            )}
            {m.text && (
              <div
                class="tchat-msg-text"
                dangerouslySetInnerHTML={{
                  __html: m.text
                    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                    .replace(/(^|\s)@([\p{L}\p{N}][\p{L}\p{N}._-]{1,49})/gu, '$1<span class="tchat-mention">@$2</span>')
                    .replace(/\n/g, '<br />'),
                }}
              />
            )}
            {m.attachments?.map((a) => (
              <div key={a.id} class="tchat-attachment">
                {a.kind === 'image' ? (
                  <AttachImage id={a.id} alt={a.name} />
                ) : /\.(webm|ogg|oga|m4a|mp3|wav)$/i.test(a.name || '') ? (
                  <VoiceNotePlayer attachmentId={a.id} attachmentName={a.name} />
                ) : (
                  <div class="tchat-attachment-file">
                    <Paperclip width={12} height={12} style="margin-right:6px" />
                    {a.name} <span class="dim" style="margin-left:6px">{fmtBytes(a.size)}</span>
                  </div>
                )}
              </div>
            ))}
            <div class="tchat-msg-time">
              {fmtTime(m.createdAt)}
              {isMine && <MessageStatus status={m.status} />}
            </div>
          </div>
          {userCanWrite() && (
            <div class="tchat-msg-side">
              <button class="tchat-msg-action" onClick={() => {
                setComposer((c) => ({ ...c, replyTo: m }));
              }} title="Reply">
                <div style="display:flex;align-items:center;gap:4px;font-size:0.65rem"><Send width={10} height={10} /> Reply</div>
              </button>
              <button class="tchat-msg-action" onClick={() => void togglePin(m)} aria-pressed={!!m.pinned} aria-label={m.pinned ? 'Unpin message' : 'Pin message'} title={m.pinned ? 'Unpin' : 'Pin'}>
                <Pin width={10} height={10} style={m.pinned ? 'color:var(--accent)' : ''} />
              </button>
            </div>
          )}
        </div>
      );
    });
  }, [messages, meId, active, viewerOnly]);

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
      <div class="tchat-rail">
        <div class="tchat-rail-head">
          <span class="tchat-rail-title">
            <MessageCircle width={16} height={16} class="icon" />
            Team Chat
          </span>
          <div style="display:flex;align-items:center;gap:8px">
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
                {presence.size > 5 && <span class="tchat-members-all" title={`${presence.size} members online`}>+{presence.size - 5}</span>}
              </span>
            )}
          </div>
        </div>
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
        <div class="tchat-channel-list">
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
                  onClick={() => setActiveId(c.id)}
                  role="button"
                  tabIndex={0}
                  aria-label={c.unread ? `${label}, ${c.unread} unread messages` : label}
                  onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActiveId(c.id); } }}
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
      </div>

      <div class="tchat-main">
        {active ? (
          <>
            <div class="tchat-head">
              <div style="display:flex;align-items:center;gap:10px;min-width:0">
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
                    <span class="tchat-members-all" title="All members">
                      <UsersIcon width={14} height={14} />
                    </span>
                  )}
                </div>
                <button class="btn btn-sm" onClick={() => setSearchResults((prev) => (prev === null ? [] : null))} aria-pressed={searchResults !== null} title="Search">
                  <Search width={14} height={14} /> Search
                </button>
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
                  onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter') void doSearch(); }}
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

             <div class="tchat-messages" ref={listRef} role="log" aria-live="polite" aria-label="Messages">
               {renderedMessages}
               {!messages.length && (

                <div class="tchat-empty-msg">No messages yet. Say hello 👋</div>
              )}
            </div>

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
                        <div class="tchat-recording-indicator" role="status">
                          <span class="tchat-recording-pulse"></span>
                          <span>{Math.floor(recordTime / 60)}:{ (recordTime % 60).toString().padStart(2, '0') }</span>
                        </div>
                      )}
                      <textarea
                        class="tchat-textarea"
                        placeholder={isRecording ? "Recording..." : "Type a message…"}
                        aria-label="Type a message"
                        rows={2}
                        value={composer.text}
                        onInput={(e: Event) => {
                          const v = (e.target as HTMLTextAreaElement).value;
                          setComposer((c) => ({ ...c, text: v }));
                          if (v.trim()) sock.sendTyping(active.id);
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

              </div>
            ) : (
              <div class="tchat-readonly" role="status">Viewer — you can read this channel but not reply.</div>
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
    </div>
  );
}