import { useState, useEffect, useRef, useMemo } from 'preact/hooks';
import { Paperclip, Wrench, FileOutput, Bot, Languages } from 'lucide-preact';
import { useHashLocation } from 'wouter/use-hash-location';
import {
  listAgents,
  listAgentSessions,
  createAgentSession,
  deleteAgentSession,
  renameAgentSession,
  createAgent,
  updateAgent,
  listProjects,
  getChatContext,
  getChatInfo,
  getChatModels,
  type AgentDef,
  type AgentSession,
  type Project,
  type ChatConfig,
} from '../api';
import { useChatSocket } from '../useChatSocket';
import { useChatAttachments, formatSize } from '../useChatAttachments';
import { renderMarkdown } from '../lib/markdown';
import { AgentSettingsModal } from '../components/AgentSettingsModal';
import { ConfirmModal } from '../components/ConfirmModal';

const AGENT_PRESETS = [
  { name: 'Coder', icon: '⚡', desc: 'Write and build code', prompt: 'You are an expert developer. Follow this workflow: 1) Read context and existing patterns, 2) Plan approach briefly, 3) Implement clean minimal code, 4) Verify with build/typecheck, 5) Summarize changes. Standards: error handling on every async call, proper TypeScript types, sanitize input, no unrelated refactors. After coding, always run the appropriate build command to verify.', tools: true },
  { name: 'Planner', icon: '📐', desc: 'Plan architecture & tasks', prompt: 'You are a senior software architect. Follow this workflow: 1) Understand requirements and constraints, 2) Analyze current architecture, 3) Propose decisions with rationale, 4) Break into ordered phases with concrete tasks, 5) Identify risks and mitigations. Output format: Architecture Decision, Tech Stack, Implementation Plan (phased tasks), Risks. Do NOT write code — describe what should be built and how.', tools: false },
  { name: 'Code Reviewer', icon: '🔍', desc: 'Review code quality', prompt: 'You are a senior code reviewer. Follow this workflow: 1) Understand context, 2) Scan systematically (correctness, security, performance, conventions, error handling, edge cases), 3) Classify each finding by severity, 4) Provide concrete fixes with file:line references. Output format: [Severity] file:line — Issue → Impact → Fix. Prioritize: Critical > High > Medium > Low. Be constructive, explain WHY.', tools: false },
  { name: 'Debugger', icon: '🐛', desc: 'Find and fix bugs', prompt: 'You are a debugging specialist. Follow this workflow: 1) Understand reproduction steps and expected vs actual behavior, 2) Trace the execution path through error messages, stack traces, and logs, 3) Identify root cause (not just symptoms), 4) Provide targeted fix, 5) Verify with build/test, 6) Check for similar issues elsewhere. Output: Root Cause → Fix → Verification → Prevention.', tools: true },
  { name: 'DevOps', icon: '🐳', desc: 'Docker, CI/CD, infra', prompt: 'You are a senior DevOps engineer. Follow this workflow: 1) Assess current infrastructure (Dockerfiles, compose, CI configs), 2) Diagnose issues (build failures, runtime errors, security misconfigs), 3) Implement fixes, 4) Verify with docker compose build + health check. Expertise: multi-stage Docker builds, layer optimization, CI/CD pipelines, networking, monitoring, secrets management. Never hardcode secrets. Always use health checks.', tools: true },
  { name: 'UX/UI Designer', icon: '🎨', desc: 'Design interfaces & experiences', prompt: 'You are a senior UX/UI designer. Follow this workflow: 1) Audit current UI code (CSS, components, layouts), 2) Analyze against: usability, WCAG 2.1 AA accessibility, responsive design, consistency, visual hierarchy, 3) Classify issues by severity, 4) Implement concrete CSS/component fixes. Checklist: color contrast ≥4.5:1, focus indicators, touch targets ≥44px, loading/empty/error states, RTL support, dark mode, no layout shifts.', tools: true },
  { name: 'Security', icon: '🛡️', desc: 'Code security & vulnerabilities', prompt: 'You are a security engineer. Follow this workflow: 1) Scope the audit (auth, API, file ops, crypto, input handling, network), 2) Scan against OWASP checklist, 3) Classify by severity with exact file:line, 4) Implement fixes. Checklist: auth (JWT, bcrypt, brute-force), authorization (IDOR, privilege escalation), input validation (injection, XSS, path traversal), secrets (no hardcoded keys), SSRF, file uploads, crypto (AES-256-GCM), dependencies (CVEs), error handling (no stack trace leaks). Output: [Severity] file:line — Vulnerability → Impact → Fix.', tools: true },
  { name: 'Chat', icon: '💬', desc: 'General conversation', prompt: 'You are a helpful, friendly assistant. Answer questions, discuss ideas, help with planning, and have natural conversations. Be concise and clear. Use markdown when helpful. If the user needs code changes, suggest the Coder agent. If they need a review, suggest the Reviewer agent.', tools: false },
];

function relTime(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function Agents() {
  const [, setLocation] = useHashLocation();
  const [agents, setAgents] = useState<AgentDef[]>([]);
  const [activeAgentId, setActiveAgentId] = useState('');
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [activeSession, setActiveSession] = useState<AgentSession | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [contextScope, setContextScope] = useState('');
  const [ctxOpen, setCtxOpen] = useState(false);
  const [ctxPreview, setCtxPreview] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState<AgentDef | null>(null);

  const [chatInfo, setChatInfo] = useState<ChatConfig | null>(null);
  const [sessionSearch, setSessionSearch] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<AgentSession | null>(null);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [chatDir, setChatDir] = useState<'ltr' | 'rtl'>('ltr');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creatingPreset, setCreatingPreset] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  const [agentModels, setAgentModels] = useState<string[]>([]);
  const activeAgent = agents.find((a) => a.id === activeAgentId);
  const wsPath = activeAgent && activeSession
    ? `/ws/agent/${activeAgent.id}/${activeSession.chatId}`
    : '';
  const { messages, running, status, error, sessionName, send, stop, reconnect } = useChatSocket(wsPath, 'prompt');

  const [prompt, setPrompt] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const {
    pending, reading, error: attachError, setError: setAttachError,
    addFiles, removeFile, clear: clearPending, buildAttachments, fileRef,
  } = useChatAttachments();
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    Promise.all([listAgents(), listProjects(), getChatInfo()])
      .then(([agentsRes, projectsRes, infoRes]) => {
        setAgents(agentsRes.agents);
        if (agentsRes.agents.length > 0 && !activeAgentId) {
          setActiveAgentId(agentsRes.agents[0].id);
        }
        setProjects(projectsRes.projects.filter((p) => p.status === 'running' || p.status === 'created'));
        setChatInfo(infoRes);
      })
      .catch(() => setLoadError('Failed to load agents'))
      .finally(() => setLoading(false));
  }, []);

  // Model list follows the ACTIVE agent's provider — Global falls back to
  // the chat-config provider's models; anything else fetches its own list.
  useEffect(() => {
    const prov = activeAgent?.provider || '';
    if (!prov) {
      setAgentModels(chatInfo?.models || []);
      return;
    }
    let cancelled = false;
    getChatModels(prov)
      .then(({ models }) => { if (!cancelled) setAgentModels(models); })
      .catch(() => { if (!cancelled) setAgentModels([]); });
    return () => { cancelled = true; };
  }, [activeAgent?.provider, chatInfo]);

  useEffect(() => {
    if (!activeAgentId) return;
    let cancelled = false;
    listAgentSessions(activeAgentId)
      .then(async ({ sessions: list }) => {
        if (cancelled) return;
        let current = list;
        let active = current[0] || null;
        if (!active) {
          const { session } = await createAgentSession(activeAgentId);
          if (cancelled) return;
          current = [session];
          active = session;
        }
        setSessions(current);
        setActiveSession(active);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [activeAgentId]);

  useEffect(() => {
    if (sessionName && activeSession) {
      setSessions((cur) => cur.map((s) => (s.chatId === activeSession.chatId ? { ...s, name: sessionName } : s)));
      setActiveSession((cur) => (cur && cur.chatId === activeSession.chatId ? { ...cur, name: sessionName } : cur));
    }
  }, [sessionName, activeSession]);

  useEffect(() => {
    if (!contextScope || !activeSession) {
      setCtxPreview('');
      setCtxOpen(false);
      return;
    }
    let cancelled = false;
    getChatContext(contextScope)
      .then((ctx) => {
        if (!cancelled) {
          setCtxPreview(ctx.text);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setCtxPreview('');
        }
      });
    return () => { cancelled = true; };
  }, [contextScope, activeSession]);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pending]);

  const handleNewSession = async () => {
    if (!activeAgentId) return;
    try {
      const { session } = await createAgentSession(activeAgentId);
      setSessions((cur) => [session, ...cur]);
      setActiveSession(session);
    } catch (err: any) {
      setApiError(err?.message || 'Failed to create session');
    }
  };

  const handleDeleteSession = async (s: AgentSession) => {
    if (!activeAgentId) return;
    setConfirmDelete(s);
  };

  const confirmDeleteSession = async () => {
    if (!activeAgentId || !confirmDelete) return;
    try {
      await deleteAgentSession(activeAgentId, confirmDelete.chatId);
      const next = sessions.filter((x) => x.chatId !== confirmDelete.chatId);
      setSessions(next);
      if (activeSession?.chatId === confirmDelete.chatId) {
        if (next.length > 0) setActiveSession(next[0]);
        else handleNewSession();
      }
    } catch (err: any) {
      setApiError(err?.message || 'Failed to delete session');
    }
    setConfirmDelete(null);
  };

  const handleRenameSession = (s: AgentSession) => {
    setRenamingSessionId(s.chatId);
    setRenameValue(s.name);
  };

  const confirmRenameSession = async () => {
    if (!activeAgentId || !renamingSessionId) return;
    const name = renameValue.trim();
    if (!name) { setRenamingSessionId(null); return; }
    try {
      const { session } = await renameAgentSession(activeAgentId, renamingSessionId, name);
      setSessions((cur) => cur.map((x) => (x.chatId === session.chatId ? session : x)));
      if (activeSession?.chatId === session.chatId) setActiveSession(session);
    } catch (err: any) {
      setApiError(err?.message || 'Failed to rename session');
    }
    setRenamingSessionId(null);
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    const text = prompt.trim();
    if ((!text && pending.length === 0) || running || reading || !activeSession) return;
    setSendError(null);
    setAttachError(null);
    const attachments = await buildAttachments();
    if (attachments && send(text, attachments, contextScope || undefined)) {
      setPrompt('');
      clearPending();
      // Reset textarea height after send
      if (promptRef.current) promptRef.current.style.height = 'auto';
    }
  };

  const handleSelectAgent = (id: string) => {
    setActiveAgentId(id);
    setActiveSession(null);
    setSessionSearch('');
  };

  const handleAgentSaved = (agent: AgentDef) => {
    setAgents((cur) => {
      const idx = cur.findIndex((a) => a.id === agent.id);
      if (idx >= 0) {
        const next = [...cur];
        next[idx] = agent;
        return next;
      }
      return [...cur, agent];
    });
    setSettingsOpen(false);
    setEditingAgent(null);
  };

  const handleAgentDeleted = (agentId: string) => {
    setSettingsOpen(false);
    setEditingAgent(null);
    setAgents((cur) => {
      const next = cur.filter((a) => a.id !== agentId);
      return next;
    });
    if (activeAgentId === agentId) {
      setActiveAgentId((curActive) => {
        if (curActive !== agentId) return curActive;
        // Use functional updater to read latest agents
        const remaining = agents.filter((a) => a.id !== agentId);
        return remaining.length > 0 ? remaining[0].id : '';
      });
      setActiveSession(null);
    }
  };

  const handleNewAgent = () => {
    setPresetsOpen(true);
  };

  const handleCreateFromPreset = async (preset: typeof AGENT_PRESETS[0]) => {
    if (creatingPreset) return;
    setCreatingPreset(true);
    try {
      const { agent } = await createAgent({
        name: preset.name,
        icon: preset.icon,
        description: preset.desc,
        systemPrompt: preset.prompt,
        toolsEnabled: preset.tools,
      });
      setAgents((cur) => [...cur, agent]);
      setActiveAgentId(agent.id);
      setEditingAgent(agent);
      setSettingsOpen(true);
      setPresetsOpen(false);
    } catch { /* ignore */ }
    setCreatingPreset(false);
  };

  const handleProviderChange = async (provider: string) => {
    if (!activeAgent) return;
    try {
      const { agent } = await updateAgent(activeAgent.id, { provider });
      setAgents((cur) => cur.map((a) => (a.id === agent.id ? agent : a)));
    } catch (err: any) {
      setApiError(err?.message || 'Failed to update provider');
    }
  };

  const handleModelChange = async (model: string) => {
    if (!activeAgent) return;
    try {
      const { agent } = await updateAgent(activeAgent.id, { model });
      setAgents((cur) => cur.map((a) => (a.id === agent.id ? agent : a)));
    } catch (err: any) {
      setApiError(err?.message || 'Failed to update model');
    }
  };

  const handleContextChange = async (val: string) => {
    setContextScope(val);
  };

  const filteredSessions = useMemo(() => {
    if (!sessionSearch) return sessions;
    const q = sessionSearch.toLowerCase();
    return sessions.filter((s) => s.name.toLowerCase().includes(q));
  }, [sessions, sessionSearch]);

  const quickProviders = chatInfo?.providers || [];
  const activeProviderModels = agentModels;

  return (
    <div class="agents-page">
      {loading && (
        <div class="empty-state" style="margin:60px auto" role="status">
          <div class="big">⏳</div>
          Loading…
        </div>
      )}
      {loadError && !loading && (
        <div class="empty-state" style="margin:60px auto" role="alert">
          <div class="big">⚠️</div>
          {loadError}
        </div>
      )}
      {!loading && !loadError && (
      <>
      <div class="agents-toolbar">
        <button class="btn-ghost sm" onClick={() => setLocation('/')}>← Dashboard</button>
        <h1 class="agents-toolbar-title">Agents</h1>
      </div>

      <div class="agents-body">
        <div class="agents-sidebar scrollbar">
          {agents.map((a) => (
            <button
              key={a.id}
              class={`agent-nav-btn ${a.id === activeAgentId ? 'active' : ''}`}
              onClick={() => handleSelectAgent(a.id)}
              title={a.description}
            >
              <span class="agent-nav-icon">{a.icon}</span>
              <span class="agent-nav-name">{a.name}</span>
            </button>
          ))}
          <button class="agent-nav-btn new-agent-btn" onClick={handleNewAgent} title="Create new agent">
            <span class="agent-nav-icon">+</span>
            <span class="agent-nav-name">New Agent</span>
          </button>
        </div>

        <div class="agents-main">
          {activeAgent ? (
            <>
              <div class="agents-topbar">
                <span class="agents-agent-label">{activeAgent.icon} {activeAgent.name}</span>
                <span class="agents-agent-desc">{activeAgent.description}</span>
                <div class="agents-topbar-right">
                  <label class="chat-settings-label quick-select" style="margin:0">
                    <span>Provider</span>
                    <select
                      class="modern-input chat-sel"
                      value={activeAgent.provider || ''}
                      onChange={(e: any) => handleProviderChange(e.target.value)}
                    >
                      <option value="">Global</option>
                      {quickProviders.filter((p) => p.enabled).map((p) => (
                        <option key={p.id} value={p.id}>{p.name}</option>
                      ))}
                    </select>
                  </label>
                  <label class="chat-settings-label quick-select" style="margin:0">
                    <span>Model</span>
                    <select
                      class="modern-input chat-sel"
                      value={activeAgent.model || ''}
                      onChange={(e: any) => handleModelChange(e.target.value)}
                    >
                      <option value="">Global</option>
                      {activeProviderModels.map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  </label>
                  <label class="chat-settings-label" style="margin:0">
                    <span>Project</span>
                    <select
                      class="modern-input chat-sel"
                      value={contextScope}
                      onChange={(e: any) => handleContextChange(e.target.value)}
                    >
                      <option value="">None</option>
                      <option value="all">All projects</option>
                      {projects.map((p) => (
                        <option key={p.slug} value={p.slug}>{p.name}</option>
                      ))}
                    </select>
                  </label>
                  <button class="btn-ghost sm" onClick={() => { setEditingAgent(activeAgent); setSettingsOpen(true); }} aria-label={`Settings for ${activeAgent.name}`} title="Agent settings">⚙</button>
                </div>
              </div>

              <div class="agents-sessions-bar scrollbar">
                <input
                  class="session-search-input"
                  type="text"
                  placeholder="Search…"
                  value={sessionSearch}
                  onInput={(e: any) => setSessionSearch(e.target.value)}
                />
                {filteredSessions.map((s) => (
                  <div class={`session-chip ${s.chatId === activeSession?.chatId ? 'active' : ''}`} key={s.chatId}>
                    {renamingSessionId === s.chatId ? (
                      <div class="session-rename-row">
                        <input
                          class="modern-input session-rename-input"
                          type="text"
                          value={renameValue}
                          onInput={(e: any) => setRenameValue(e.target.value)}
                          onKeyDown={(e: KeyboardEvent) => {
                            if (e.key === 'Enter') confirmRenameSession();
                            if (e.key === 'Escape') setRenamingSessionId(null);
                          }}
                          onBlur={confirmRenameSession}
                          autoFocus
                        />
                      </div>
                    ) : (
                      <button class="session-chip-main" type="button" onClick={() => setActiveSession(s)}
                        onDblClick={() => handleRenameSession(s)}>
                        <span class="session-chip-name">{s.name}</span>
                        {s.messageCount > 1 && (
                          <span class="session-chip-summary">{s.messageCount} messages</span>
                        )}
                        <span class="session-chip-meta">{relTime(s.updatedAt)} · {s.messageCount}</span>
                      </button>
                    )}
                    <span class="session-chip-actions">
                      <button class="session-chip-act" type="button" title="Rename" aria-label="Rename session" onClick={() => handleRenameSession(s)}>✎</button>
                      <button class="session-chip-act" type="button" title="Delete" aria-label="Delete session" onClick={() => handleDeleteSession(s)}>×</button>
                    </span>
                  </div>
                ))}
                {sessionSearch && filteredSessions.length === 0 && (
                  <span class="session-no-results">No results</span>
                )}
                <button class="session-new-btn" type="button" onClick={handleNewSession}>+ New</button>
              </div>

              {ctxOpen && ctxPreview && (
                <div class="ctx-preview mono scrollbar">{ctxPreview}</div>
              )}

              <div class="chat-panel" style="flex:1;display:flex;flex-direction:column;min-height:0">
                <div class="chat-head">
                  <span class="chat-head-name">{activeSession?.name || activeAgent.name}</span>
                  <span class="chat-head-info">
                    {activeAgent.provider && <span class="chat-head-badge">{activeAgent.provider}</span>}
                    {activeAgent.model && <span class="chat-head-badge">{activeAgent.model}</span>}
                    {contextScope && <span class="chat-head-badge">{contextScope === 'all' ? 'All projects' : contextScope}</span>}
                  </span>
                  <span class="chat-head-tools">
                    <button class="dir-toggle-btn" type="button" onClick={() => setChatDir((d) => d === 'ltr' ? 'rtl' : 'ltr')} title="Toggle text direction">
                      <Languages width={13} height={13} class="icon" />
                      {chatDir === 'ltr' ? 'عربي' : 'English'}
                    </button>
                    <span class="chat-head-status">
                      {status === 'connected' ? 'connected' : status === 'connecting' ? 'connecting…' : status === 'disconnected' ? 'offline' : 'error'}
                      {running && ' · typing…'}
                      {(status === 'disconnected' || status === 'error') && (
                        <button class="term-reconnect-btn" type="button" onClick={reconnect} title="Reconnect" aria-label="Reconnect">↻</button>
                      )}
                    </span>
                  </span>
                </div>
                <div class="chat-body scrollbar" ref={bodyRef} style="flex:1;height:auto;min-height:0">
                  {messages.length === 0 && (
                    <div class="chat-msg system" dir={chatDir}>
                      {activeAgent.description}. You can attach images or files for context.
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
                    ) : m.role === 'tool_call' ? (
                      <div class="tool-step tool-call" key={i}>
                        <span class="tool-step-icon"><Wrench width={12} height={12} class="icon" /></span>
                        <span class="tool-step-label">Using {m.toolName || 'tool'}</span>
                        <span class="tool-step-args">{m.toolArgs ? Object.entries(m.toolArgs).map(([k, v]) => `${k}=${v}`).join(' ') : ''}</span>
                      </div>
                    ) : m.role === 'tool_result' ? (
                      <div class="tool-step tool-result" key={i}>
                        <span class="tool-step-icon"><FileOutput width={12} height={12} class="icon" /></span>
                        <span class="tool-step-label">Result</span>
                        <pre class="tool-step-output">{m.text.slice(0, 500)}{m.text.length > 500 ? '\n…(truncated)' : ''}</pre>
                      </div>
                    ) : (
                      <div class="chat-msg agent" dir={chatDir} key={i}>
                        <span class="agent-badge">{activeAgent.icon} {activeAgent.name}</span>
                        <div class="agent-stream md" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }} />
                      </div>
                    )
                  )}
                  {error && !running && <div class="chat-msg system err" dir={chatDir} role="alert">{error}</div>}
                  {attachError && <div class="chat-msg system err" dir={chatDir} role="alert">{attachError}</div>}
                  {sendError && <div class="chat-msg system err" dir={chatDir} role="alert">{sendError}</div>}
                  {apiError && (
                    <div class="chat-msg system err" dir={chatDir} role="alert">
                      {apiError}
                      <button class="btn-ghost sm" style="margin-left:8px" onClick={() => setApiError(null)} aria-label="Dismiss">×</button>
                    </div>
                  )}
                </div>

                {pending.length > 0 && (
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

                <form class="chat-input-row" onSubmit={submit}>
                  <button class="btn-ghost chat-attach-btn" type="button" title="Attach files" aria-label="Attach files"
                    onClick={() => fileRef.current?.click()} disabled={running || reading}><Paperclip width={14} height={14} class="icon" /></button>
                  <input ref={fileRef} type="file" multiple style="display:none"
                    onChange={(e: any) => { addFiles(e.target.files); e.target.value = ''; }} />
                  <textarea
                    ref={promptRef}
                    class="modern-input agent-prompt-input" dir={chatDir} rows={1}
                    placeholder={`Ask ${activeAgent.name}...`}
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
              </div>
            </>
          ) : (
            <div class="empty-state" style="margin:60px auto;max-width:480px">
              <div class="big-icon"><Bot width={30} height={30} class="icon" /></div>
              Select an agent to get started.
            </div>
          )}
        </div>
      </div>

      {settingsOpen && editingAgent && (
        <AgentSettingsModal
          agent={editingAgent}
          onSave={handleAgentSaved}
          onDelete={handleAgentDeleted}
          onClose={() => { setSettingsOpen(false); setEditingAgent(null); }}
        />
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

      {presetsOpen && (
        <div class="confirm-overlay" onClick={(e) => { if (e.target === (e.currentTarget as HTMLElement)) setPresetsOpen(false); }}>
          <div class="presets-modal">
            <div class="confirm-title">New Agent</div>
            <div class="confirm-message">Choose a template or create custom</div>
            <div class="presets-grid">
              {AGENT_PRESETS.map((p) => (
                <button class="preset-card" type="button" key={p.name} onClick={() => handleCreateFromPreset(p)}>
                  <span class="preset-icon">{p.icon}</span>
                  <span class="preset-name">{p.name}</span>
                  <span class="preset-desc">{p.desc}</span>
                </button>
              ))}
            </div>
            <div class="confirm-actions" style="margin-top:12px">
              <button class="btn-ghost sm" type="button" onClick={() => setPresetsOpen(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </>
    )}
    </div>
  );
}
