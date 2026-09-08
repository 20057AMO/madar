/**
 * ProjectChat.tsx
 * Madar — Project-scoped AI chat panel ("AI Chat" tab in the project page).
 * Talks to the ws-chat backend: streaming replies with project context +
 * BM25 retrieval over the workspace. Sessions persist per project slug.
 */
import { useState, useEffect, useRef } from 'preact/hooks';
import { Paperclip, Languages, Settings, Lock } from 'lucide-preact';
import {
  listChatSessions,
  createChatSession,
  renameChatSession,
  deleteChatSession,
  getChatInfo,
  getChatModels,
  updateChatConfig,
  type ProjectChatSession,
  type ChatConfig,
} from '../api';
import { useChatSocket } from '../useChatSocket';
import { useChatAttachments, formatSize } from '../useChatAttachments';
import { renderMarkdown } from '../lib/markdown';
import { ConfirmModal } from './ConfirmModal';

function relTime(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function ProjectChat({ slug, readOnly = false }: { slug: string; readOnly?: boolean }) {
  const [sessions, setSessions] = useState<ProjectChatSession[]>([]);
  const [activeSession, setActiveSession] = useState<ProjectChatSession | null>(null);
  const [sessionSearch, setSessionSearch] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<ProjectChatSession | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [chatDir, setChatDir] = useState<'ltr' | 'rtl'>('ltr');
  const [configOpen, setConfigOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameName, setRenameName] = useState('');
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (renamingId && renameInputRef.current) renameInputRef.current.focus();
  }, [renamingId]);

  const wsPath = activeSession ? `/ws/chat/${slug}/${activeSession.chatId}` : '';
  const { messages, running, status, error, send, stop, reconnect } = useChatSocket(wsPath, 'prompt');

  const [prompt, setPrompt] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const {
    pending, reading, error: attachError, setError: setAttachError,
    addFiles, removeFile, clear: clearPending, buildAttachments, fileRef,
  } = useChatAttachments();
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    listChatSessions(slug)
      .then(async ({ sessions: list }) => {
        if (cancelled) return;
        let current = list;
        let active = current[0] || null;
        // Read-only viewers never auto-create a session (that's a write op);
        // they just read whatever the editors left behind.
        if (!active && !readOnly) {
          const { session } = await createChatSession(slug);
          if (cancelled) return;
          current = [session];
          active = session;
        }
        setSessions(current);
        setActiveSession(active);
      })
      .catch(() => setLoadError('Failed to load chat sessions'));
    return () => { cancelled = true; };
  }, [slug, readOnly]);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  const handleNewSession = async () => {
    try {
      const { session } = await createChatSession(slug);
      setSessions((cur) => [session, ...cur]);
      setActiveSession(session);
    } catch { /* ignore */ }
  };

  const confirmDeleteSession = async () => {
    if (!confirmDelete) return;
    try {
      await deleteChatSession(slug, confirmDelete.chatId);
      const next = sessions.filter((x) => x.chatId !== confirmDelete.chatId);
      setSessions(next);
      if (activeSession?.chatId === confirmDelete.chatId) {
        if (next.length > 0) setActiveSession(next[0]);
        else handleNewSession();
      }
    } catch { /* ignore */ }
    setConfirmDelete(null);
  };

  const startRename = (s: ProjectChatSession) => {
    setRenamingId(s.chatId);
    setRenameName(s.name);
  };

  const cancelRename = () => {
    setRenamingId(null);
    setRenameName('');
  };

  const submitRename = async (s: ProjectChatSession) => {
    const nn = renameName.trim();
    if (!nn || nn === s.name) { cancelRename(); return; }
    setRenamingId(null);
    setRenameName('');
    try {
      const { session } = await renameChatSession(slug, s.chatId, nn);
      setSessions((cur) => cur.map((x) => (x.chatId === session.chatId ? session : x)));
      if (activeSession?.chatId === session.chatId) setActiveSession(session);
    } catch { /* ignore */ }
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    const text = prompt.trim();
    if ((!text && pending.length === 0) || running || reading || !activeSession) return;
    setSendError(null);
    setAttachError(null);
    const attachments = await buildAttachments();
    if (attachments && send(text, attachments, slug)) {
      setPrompt('');
      clearPending();
      // Refresh the rail so the renamed/touched session bubbles up.
      listChatSessions(slug).then(({ sessions: list }) => setSessions(list)).catch(() => {});
    }
  };

  const filteredSessions = sessionSearch
    ? sessions.filter((s) => s.name.toLowerCase().includes(sessionSearch.toLowerCase()))
    : sessions;

  if (loadError) {
    return <div class="empty-state" style="margin:40px auto"><div class="big">⚠️</div>{loadError}</div>;
  }

  return (
    <div class="project-chat">
      <h2 class="panel-title" style="margin-bottom:10px">AI Chat</h2>
      <div class="agents-sessions-bar scrollbar" role="list">
        <input
          class="session-search-input"
          type="text"
          placeholder="Search…"
          aria-label="Search sessions"
          value={sessionSearch}
          onInput={(e: any) => setSessionSearch(e.target.value)}
        />
        {filteredSessions.map((s) => {
          const isActive = s.chatId === activeSession?.chatId;
          return (
            <div class={`session-chip ${isActive ? 'active' : ''}`} key={s.chatId} role="listitem" aria-current={isActive ? 'true' : undefined}>
              {renamingId === s.chatId ? (
                <div class="session-chip-rename">
                  <input
                    class="modern-input compact"
                    ref={renameInputRef}
                    aria-label="Session name"
                    value={renameName}
                    onInput={(e: any) => setRenameName(e.target.value)}
                    onKeyDown={(e: any) => {
                      if (e.key === 'Enter') submitRename(s);
                      else if (e.key === 'Escape') cancelRename();
                    }}
                  />
                </div>
              ) : (
                <button class="session-chip-main" type="button" onClick={() => setActiveSession(s)}
                  onDblClick={() => startRename(s)} title={s.lastPreview}>
                  <span class="session-chip-name">{s.name}</span>
                  {s.messageCount > 1 && (
                    <span class="session-chip-summary">{s.messageCount} messages</span>
                  )}
                  <span class="session-chip-meta">{relTime(s.updatedAt)} · {s.messageCount}</span>
                </button>
              )}
              <span class="session-chip-actions">
                {!readOnly && (
                  <>
                    <button class="session-chip-act" type="button" title="Rename" aria-label="Rename session" aria-pressed={renamingId === s.chatId} onClick={() => startRename(s)}>✎</button>
                    <button class="session-chip-act" type="button" title="Delete" aria-label="Delete session" onClick={() => setConfirmDelete(s)}>×</button>
                  </>
                )}
              </span>
            </div>
          );
        })}
        {sessionSearch && filteredSessions.length === 0 && (
          <span class="session-no-results" role="status">No results</span>
        )}
        {!readOnly && <button class="session-new-btn" type="button" onClick={handleNewSession}>+ New</button>}
      </div>

      <div class="chat-panel" style="flex:1;display:flex;flex-direction:column;min-height:0">
        <div class="chat-head">
          <span class="chat-head-name">{activeSession?.name || 'Chat'}</span>
          <span class="chat-head-badge">{slug}</span>
          <span class="chat-head-tools">
            {!readOnly && (
              <button class="dir-toggle-btn" type="button" onClick={() => setConfigOpen(true)} title="Chat settings (model, provider, system prompt)" aria-label="Chat settings">
                <Settings width={13} height={13} class="icon" />
              </button>
            )}
            {readOnly && (
              <span class="cn-ro-chip" title="Your role can only read this chat" role="status">
                <Lock width={11} height={11} /> Read-only
              </span>
            )}
            <button class="dir-toggle-btn" type="button" onClick={() => setChatDir((d) => d === 'ltr' ? 'rtl' : 'ltr')} title="Toggle text direction">
              <Languages width={13} height={13} class="icon" />
              {chatDir === 'ltr' ? 'عربي' : 'English'}
            </button>
            <span class="chat-head-status">
              <span role="status">
                {status === 'connected' ? 'connected' : status === 'connecting' ? 'connecting…' : status === 'disconnected' ? 'offline' : 'error'}
                {running && ' · typing…'}
              </span>
              {(status === 'disconnected' || status === 'error') && (
                <button class="term-reconnect-btn" type="button" onClick={reconnect} title="Reconnect" aria-label="Reconnect">↻</button>
              )}
            </span>
          </span>
        </div>
        <div class="chat-body scrollbar" ref={bodyRef} role="log" aria-live="polite" aria-relevant="additions" aria-atomic="false" style="flex:1;height:auto;min-height:0">
          {messages.length === 0 && (
            <div class="chat-msg system" dir={chatDir}>
              Ask anything about this project — the model sees the project structure and can search its files. Images and text files can be attached for extra context.
            </div>
          )}
          {messages.map((m, i) =>
            m.role === 'user' ? (
              <div class="chat-msg user" dir={chatDir} key={i}>
                <span>You</span>
                {m.attachments && m.attachments.length > 0 && (
                  <div class="chat-attachments">
                    {m.attachments.map((a, j) =>
                      a.kind === 'image' && a.data ? (
                        <img class="chat-img" src={a.data} alt={a.name} key={j} />
                      ) : (
                        <span class="chat-file-chip" key={j}><Paperclip width={11} height={11} class="icon" /> {a.name}</span>
                      )
                    )}
                  </div>
                )}
                <div class="chat-msg-text">{m.text}</div>
              </div>
            ) : m.role === 'error' ? (
              <div class="chat-msg system err" dir={chatDir} key={i}>{m.text}</div>
            ) : (
              <div class="chat-msg agent" dir={chatDir} key={i}>
                <span class="agent-badge">🤖 Assistant</span>
                <div class="agent-stream md" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }} />
              </div>
            )
          )}
          {error && !running && <div class="chat-msg system err" dir={chatDir}>{error}</div>}
          {attachError && <div class="chat-msg system err" dir={chatDir}>{attachError}</div>}
          {sendError && <div class="chat-msg system err" dir={chatDir}>{sendError}</div>}
        </div>

        {pending.length > 0 && !readOnly && (
          <div class="chat-pending">
            {pending.map((p) => (
              <span class="chat-attach-chip" key={p.id}>
                {p.type.startsWith('image/') && p.data ? (
                  <img class="chat-attach-thumb" src={p.data} alt="" />
                ) : (
                  <span class="chat-attach-icon"><Paperclip width={13} height={13} class="icon" /></span>
                )}
                <span class="chat-attach-name">{p.name}</span>
                <span class="chat-attach-size">{formatSize(p.size)}</span>
                <button class="chat-attach-x" type="button" onClick={() => removeFile(p.id)} aria-label="Remove attachment">×</button>
              </span>
            ))}
          </div>
        )}

        {readOnly ? (
          <div class="chat-input-row ro" role="status">
            <span class="dim">Viewer — read-only. Ask an editor to start a conversation.</span>
          </div>
        ) : (
          <form class="chat-input-row" onSubmit={submit}>
          <button class="btn-ghost chat-attach-btn" type="button" title="Attach files" aria-label="Attach files"
            onClick={() => fileRef.current?.click()} disabled={running || reading}><Paperclip width={14} height={14} class="icon" /></button>
          <input ref={fileRef} type="file" multiple style="display:none"
            onChange={(e: any) => { addFiles(e.target.files); e.target.value = ''; }} />
          <textarea
            class="modern-input agent-prompt-input" dir={chatDir} rows={1}
            placeholder="Ask about this project…"
            aria-label="Ask about this project"
            value={prompt}
            onInput={(e: any) => {
              setPrompt(e.target.value);
              const el = e.target as HTMLTextAreaElement;
              el.style.height = 'auto';
              el.style.height = Math.min(el.scrollHeight, 120) + 'px';
            }}
            onKeyDown={(e: KeyboardEvent) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(e); }
            }}
            disabled={running}
          />
          {running && <button class="btn-danger sm" type="button" onClick={stop}>Stop</button>}
          <button class="btn-primary" type="submit"
            disabled={running || reading || (!prompt.trim() && pending.length === 0)}>
            {reading ? '…' : 'Send'}
          </button>
          </form>
        )}
      </div>

      {configOpen && (
        <ChatConfigModal onClose={() => setConfigOpen(false)} />
      )}

      {confirmDelete && (
        <ConfirmModal
          open
          title="Delete Session"
          message={`Delete session '${confirmDelete.name}'? This cannot be undone.`}
          confirmLabel="Delete"
          danger
          onConfirm={confirmDeleteSession}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}

/** Global chat config editor (provider/model/language/temperature/system prompt). */
function ChatConfigModal({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<ChatConfig | null>(null);
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [language, setLanguage] = useState<'auto' | 'ar' | 'en'>('auto');
  const [temperature, setTemperature] = useState(0.4);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const providerRef = useRef<HTMLSelectElement | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getChatInfo()
      .then((cfg) => {
        setInfo(cfg);
        setProvider(cfg.provider);
        setModel(cfg.model);
        setModels(cfg.models || []);
        setLanguage(cfg.language);
        setTemperature(cfg.temperature);
        setSystemPrompt(cfg.systemPrompt);
      })
      .catch(() => setSaveMsg('Failed to load chat configuration'));
  }, []);

  useEffect(() => {
    providerRef.current?.focus();
  }, []);

  // Tab trap + Escape close.
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    const focusables = () =>
      overlayRef.current && overlayRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const nodes = focusables();
      if (!nodes || nodes.length === 0) return;
      const list = Array.from(nodes);
      const firstEl = list[0];
      const lastEl = list[list.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      trigger?.focus();
    };
  }, []);

  const handleProviderChange = (p: string) => {
    setProvider(p);
    setModels([]);
    setModel('');
    getChatModels(p)
      .then(({ models: list }) => {
        setModels(list);
        if (list.length > 0) setModel(list.includes(model) ? model : list[0]);
      })
      .catch(() => setSaveMsg(`Could not load models for ${p}`));
  };

  const save = async (e: Event) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      await updateChatConfig({ provider, model, language, temperature, systemPrompt });
      setSaveMsg('Saved.');
      setTimeout(onClose, 700);
    } catch (err: any) {
      setSaveMsg(err.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div class="confirm-overlay" ref={overlayRef} onClick={(e) => { if (e.target === (e.currentTarget as HTMLElement)) onClose(); }}>
      <form class="presets-modal chat-config-modal" role="dialog" aria-modal="true" aria-labelledby="chat-config-title" onSubmit={save}>
        <div class="confirm-title" id="chat-config-title">Chat Settings</div>
        <div class="confirm-message">Global defaults for AI chat replies.</div>

        <div class="chat-settings-row">
          <label class="chat-settings-label">
            <span>Provider</span>
            <select ref={providerRef} class="modern-input chat-sel" value={provider} onChange={(e: any) => handleProviderChange(e.target.value)}>
              {(info?.providers || []).filter((p) => p.enabled).map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
          <label class="chat-settings-label">
            <span>Model</span>
            <select class="modern-input chat-sel" value={model} onChange={(e: any) => setModel(e.target.value)}>
              {!model && <option value="">—</option>}
              {models.map((m) => (<option key={m} value={m}>{m}</option>))}
            </select>
          </label>
        </div>

        <div class="chat-settings-row">
          <label class="chat-settings-label">
            <span>Reply language</span>
            <select class="modern-input chat-sel" value={language} onChange={(e: any) => setLanguage(e.target.value)}>
              <option value="auto">Auto</option>
              <option value="ar">Arabic</option>
              <option value="en">English</option>
            </select>
          </label>
          <label class="chat-settings-label">
            <span>Temperature ({temperature})</span>
            <input type="range" min={0} max={1.5} step={0.1} value={temperature}
              onInput={(e: any) => setTemperature(Number(e.target.value))} style="width:140px" />
          </label>
        </div>

        <label class="field-label" for="chat-system-prompt">System prompt</label>
        <textarea
          id="chat-system-prompt"
          class="modern-input chat-sysprompt" rows={6}
          value={systemPrompt}
          onInput={(e: any) => setSystemPrompt(e.target.value)}
        />

        {saveMsg && (
          <div class={saveMsg === 'Saved.' ? 'chat-save-msg' : 'login-error'} role={saveMsg === 'Saved.' ? 'status' : 'alert'} style="margin-top: 8px">
            {saveMsg}
          </div>
        )}

        <div class="confirm-actions" style="margin-top:12px">
          <button class="btn-ghost sm" type="button" onClick={onClose}>Cancel</button>
          <button class="btn-primary sm" type="submit" disabled={saving || !provider || !model}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}
