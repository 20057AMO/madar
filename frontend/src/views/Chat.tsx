/**
 * Chat.tsx
 * Madar — Team Chat. A WhatsApp-style workspace messenger:
 * manual team channels, per-project auto "project:<slug>" channels, and
 * direct 1:1 conversations. Text is sent over REST (single authoritative
 * write path); the WebSocket delivers live messages/typing/read/pin/presence.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
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
} from 'lucide-preact';
import {
  listChatChannels,
  createChatChannel,
  openDirectChat,
  deleteChatChannel,
  getChatChannel,
  sendChatMessage,
  pinChatMessage,
  markChatRead,
  uploadChatAttachment,
  chatAttachmentObjectUrl,
  searchChatMessages,
  listUsers,
  avatarUrl,
  type ChatChannel,
  type TeamChatMessage,
} from '../api';
import { Avatar } from '../components/Avatar';
import { ConfirmModal } from '../components/ConfirmModal';
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

/** Async authed attachment image — resolves to a blob URL before rendering. */
function AttachImage({ id, alt }: { id: string; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    chatAttachmentObjectUrl(id)
      .then((u) => { if (alive) setUrl(u); })
      .catch(() => {});
    return () => { alive = false; };
  }, [id]);
  if (!url) return <div class="tchat-attachment-img"><span class="dim" style="display:flex;align-items:center;justify-content:center;height:120px;gap:6px"><Loader2 width={14} height={14} class="icon spin" />loading…</span></div>;
  return <img class="tchat-attachment-img" src={url} alt={alt} loading="lazy" />;
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
        lastSeen.current.set(ev.channelId, ev.messages?.[ev.messages.length - 1]?.id || '');
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
          const next = [...prev, ev.message].slice(-500);
          lastSeen.current.set(cid, ev.message.id);
          return next;
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
    sock.subscribe(activeId);
    const known = channelsRef.current.find((c) => c.id === activeId);
    setActive(known || null);
    setTyping([]);
    setViewerOnly(false);
    setSearchResults(null);
    setSearchQ('');
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
    // Refresh unread badges from the authoritative REST list.
    void listChatChannels()
      .then(({ channels: chans }) => setChannels(chans))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, activeId]);

  // scroll to bottom on message growth
  useEffect(() => {
    const el = listRef.current;
    if (!el || skipScroll.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, activeId]);

  // clear typing indicators after a pause
  useEffect(() => {
    if (!typing.length) return;
    const t = setTimeout(() => setTyping([]), 4500);
    return () => clearTimeout(t);
  }, [typing]);

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
      const next = [...composer.attachments];
      for (const f of fileList) {
        const { attachment } = await uploadChatAttachment(activeId, f);
        next.push({
          id: attachment.id,
          name: attachment.name,
          size: attachment.size,
          kind: attachment.kind,
        });
      }
      setComposer((c) => ({ ...c, attachments: next }));
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
      setChannels((prev) => prev.filter((c) => c.id !== deleteTarget.id));
      if (activeId === deleteTarget.id) {
        const rest = channels.filter((c) => c.id !== deleteTarget.id);
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

  const canDelete = (c: ChatChannel) =>
    c.kind === 'channel' && (user?.role === 'admin' || (user?.role === 'editor' && c.createdBy === user.id));

  const pinned = messages.filter((m) => m.pinned);

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
            return (
              <div
                key={c.id}
                class={`tchat-channel-row${isActive ? ' active' : ''}${c.unread ? ' unread' : ''}`}
                onClick={() => setActiveId(c.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActiveId(c.id); } }}
              >
                <span class="tchat-channel-icon">
                  {c.kind === 'project' ? <FolderOpen width={15} height={15} /> : c.kind === 'direct' ? <UserIcon width={15} height={15} /> : <Hash width={15} height={15} />}
                </span>
                <span class="tchat-channel-meta">
                  <span class="tchat-channel-name">{channelLabel(c, { id: meId })}</span>
                  <span class="tchat-channel-sub">
                    {c.kind === 'direct' ? (onlineNow ? `${onlineNow} online` : channelSub(c, { id: meId })) : channelSub(c, { id: meId })}
                  </span>
                </span>
                <span class="tchat-channel-side">
                  {c.lastMessageAt && <span class="tchat-channel-time">{fmtTime(c.lastMessageAt)}</span>}
                  {c.unread ? <span class="tchat-unread-badge">{c.unread > 99 ? '99+' : c.unread}</span> : null}
                  {canDelete(c) && (
                    <button
                      class="tchat-delete-btn"
                      title="Delete channel"
                      aria-label="Delete channel"
                      onClick={(e: Event) => { e.stopPropagation(); setDeleteTarget(c); }}
                    >
                      <X width={12} height={12} />
                    </button>
                  )}
                </span>
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
                <button class="btn btn-sm" onClick={() => { if (searchQ.trim()) setSearchQ(''); setSearchResults(null); }} title="Search">
                  <Search width={14} height={14} /> Search
                </button>
              </div>
            </div>

            {/* pinned banner */}
            {pinned.length > 0 && (
              <div class="tchat-pinned-banner">
                <Pin width={13} height={13} class="icon" />
                {pinned.length === 1
                  ? <>Pinned: <em>{pinned[0].text.slice(0, 120) || '📎 attachment'}</em></>
                  : <>{pinned.length} pinned messages</>}
              </div>
            )}

            {/* search box */}
            {searchResults !== null && (
              <div class="tchat-searchbox">
                <input
                  class="input"
                  placeholder="Search this channel…"
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

            <div class="tchat-messages" ref={listRef}>
              {messages.map((m) => {
                const mine = m.userId === meId;
                const reply = m.replyTo ? messages.find((x) => x.id === m.replyTo) : undefined;
                const author = active?.members.find((mem) => mem.userId === m.userId);
                return (
                  <div key={m.id} class={`tchat-msg${mine ? ' mine' : ''}`}>
                    {!mine && (
                      <button
                        class="tchat-presence-avatar"
                        style="align-self:flex-start;margin-top:2px"
                        aria-label={`View ${author?.displayName || m.username}'s profile`}
                        onClick={() => setLocation(`/user/${m.userId}`)}
                      >
                        <Avatar
                          name={author?.displayName || m.username}
                          avatar={avatarUrl(m.userId, author?.avatarExt)}
                          size={28}
                          title={author?.displayName || m.username}
                        />
                      </button>
                    )}
                    <div class="tchat-msg-body">
                      {/* reply context */}
                      {reply && (
                        <div class="tchat-msg-reply">
                          <span class="tchat-msg-reply-from">{reply.username}</span>
                          {reply.text.slice(0, 80) || '📎 attachment'}
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
                        <div class="tchat-attachment" key={a.id}>
                          {a.kind === 'image' ? (
                            <AttachImage id={a.id} alt={a.name} />
                          ) : (
                            <span class="tchat-attachment-file">📎 {a.name} ({fmtBytes(a.size)})</span>
                          )}
                        </div>
                      ))}
                    </div>
                    <div class="tchat-msg-side">
                      {m.pinned && <Pin width={12} height={12} class="icon" style="color:var(--accent)" />}
                      {userCanWrite() && (
                        <button
                          class="tchat-msg-action"
                          title={m.pinned ? 'Unpin' : 'Pin'}
                          aria-label={m.pinned ? 'Unpin message' : 'Pin message'}
                          onClick={() => void togglePin(m)}
                        >
                          <Pin width={12} height={12} />
                        </button>
                      )}
                      {userCanWrite() && (
                        <button
                          class="tchat-msg-action"
                          title="Reply"
                          aria-label="Reply to message"
                          onClick={() => setComposer((c) => ({ ...c, replyTo: m }))}
                        >
                          <MessageCircle width={12} height={12} />
                        </button>
                      )}
                    </div>
                    <div class="tchat-msg-time" title={new Date(m.createdAt).toLocaleString()}>
                      {fmtTime(m.createdAt)}
                    </div>
                  </div>
                );
              })}
              {!messages.length && (
                <div class="tchat-empty-msg">No messages yet. Say hello 👋</div>
              )}
            </div>

            {/* typing row */}
            {typing.length > 0 && (
              <div class="tchat-typing">
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
                    Replying to {composer.replyTo.username}: {composer.replyTo.text.slice(0, 60) || '📎'}
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
                  <textarea
                    class="tchat-textarea"
                    placeholder="Type a message…"
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
                    accept="image/*,.png,.jpg,.jpeg,.webp,.gif"
                    onChange={(e: Event) => {
                      const el = e.target as HTMLInputElement;
                      if (el.files) void onPickAttachments(el.files);
                      el.value = '';
                    }}
                  />
                  <button class="btn btn-icon" title="Attach file" aria-label="Attach file" onClick={() => fileInput.current?.click()}>
                    <Paperclip width={16} height={16} />
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
        <div class="modal-overlay" onMouseDown={(e: any) => { if (e.target === e.currentTarget) setCreateOpen(false); }}>
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
                autoFocus
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
        <div class="modal-overlay" onMouseDown={(e: any) => { if (e.target === e.currentTarget) setDirectOpen(false); }}>
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
                    onClick={() => void startDirect(u.id)}
                    onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter') void startDirect(u.id); }}
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