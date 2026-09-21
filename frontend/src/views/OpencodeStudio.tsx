import { useState, useEffect, useRef } from 'preact/hooks';
import { ArrowLeft, Bot, Sparkles, SlidersHorizontal, RefreshCw, CheckCircle2, ArrowUpCircle, Lock, Trash2, Plus, Save, Terminal, BookOpen, Search, Copy, Check, AlertTriangle } from 'lucide-preact';
import { useHashLocation } from 'wouter/use-hash-location';
import { ConfirmModal } from '../components/ConfirmModal';
import { ReAuthModal } from '../components/ReAuthModal';
import { useAuth } from '../auth';
import { StudioGuide } from './studio-guide';
import {
  listStudioAgents,
  getStudioAgent,
  saveStudioAgent,
  deleteStudioAgent,
  listStudioSkills,
  getStudioSkill,
  saveStudioSkill,
  deleteStudioSkill,
  listStudioCommands,
  getStudioCommand,
  saveStudioCommand,
  deleteStudioCommand,
  getStudioConfig,
  updateStudioConfig,
  getStudioVersion,
  applyUpdates,
  type StudioItem,
  type StudioVersionInfo,
} from '../api';

type Tab = 'agents' | 'skills' | 'commands' | 'config' | 'guide';

const TRIGGER_RE = /(Use when|Use PROACTIVELY when|Use ONLY when)/i;

function descriptionMissingTrigger(content: string): boolean {
  const m = content.match(/^description:\s*(.+)$/m);
  return !!m && !TRIGGER_RE.test(m[1]);
}

const AGENT_TEMPLATE = `---
description: What this subagent does (shown to the model for selection)
mode: subagent
permission:
  edit: deny
---

You are a focused specialist.

1. ...
2. ...

Rules:
- ...
`;

const SKILL_TEMPLATE = `---
name: my-skill
description: One clear sentence — the model loads the skill when this matches the task
---

# My Skill

Use when ...

## Steps
1. ...
2. ...
`;

const COMMAND_TEMPLATE = `---
description: What this slash command does (shown in the command menu)
agent: code-reviewer
---

Run the task described by the user:

$ARGUMENTS

State the expected output format and any constraints here.
`;

const TAB_ORDER: readonly Tab[] = ['agents', 'skills', 'commands', 'config', 'guide'];

export function OpencodeStudio() {
  const [, setLocation] = useHashLocation();
  const [tab, setTab] = useState<Tab>('agents');

  const tabsRef = useRef<HTMLSpanElement | null>(null);
  const pendingTabFocus = useRef<Tab | null>(null);
  useEffect(() => {
    if (pendingTabFocus.current === tab) {
      pendingTabFocus.current = null;
      tabsRef.current?.querySelector<HTMLElement>(`[data-tab="${tab}"]`)?.focus();
    }
  }, [tab]);

  const onTabsKeyDown = (e: any) => {
    const idx = TAB_ORDER.indexOf(tab);
    if (idx < 0) return;
    let next: number | null = null;
    if (e.key === 'ArrowRight') next = (idx + 1) % TAB_ORDER.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + TAB_ORDER.length) % TAB_ORDER.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TAB_ORDER.length - 1;
    if (next === null) return;
    e.preventDefault();
    const t = TAB_ORDER[next];
    pendingTabFocus.current = t;
    setTab(t);
  };

  // Shared editor state (agents & skills)
  const [items, setItems] = useState<StudioItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState<string | null>(null);

  // Config tab
  const [configText, setConfigText] = useState('');

  // Version / update
  const [ver, setVer] = useState<StudioVersionInfo | null>(null);
  const [updating, setUpdating] = useState(false);
  const { user } = useAuth();
  const [pendingUpdate, setPendingUpdate] = useState(false);
  const [reauthLoading, setReauthLoading] = useState(false);
  const [reauthError, setReauthError] = useState<string | null>(null);

  // Focus-return contract for the ReAuthModal update flow: the Update button is
  // disabled (disabled buttons blur in Chrome) the moment the dialog opens, so
  // ReAuthModal's own trigger-restore can capture BODY. Re-focus the button
  // (or the active tab) explicitly once the dialog closes again.
  const updateBtnRef = useRef<HTMLButtonElement | null>(null);
  const prevPendingUpdate = useRef(false);
  useEffect(() => {
    if (prevPendingUpdate.current && !pendingUpdate) {
      const t = window.setTimeout(() => {
        if (updateBtnRef.current) updateBtnRef.current.focus();
        else tabsRef.current?.querySelector<HTMLElement>(`[data-tab="${tab}"]`)?.focus();
      }, 0);
      return () => window.clearTimeout(t);
    }
    prevPendingUpdate.current = pendingUpdate;
  }, [pendingUpdate, tab]);

  useEffect(() => {
    getStudioVersion()
      .then(setVer)
      .catch(() => {});
  }, []);

  const loadList = (which: Tab) => {
    setLoading(true);
    const p =
      which === 'skills'
        ? listStudioSkills().then((r) => r.skills || [])
        : which === 'commands'
          ? listStudioCommands().then((r) => r.commands || [])
          : listStudioAgents().then((r) => r.agents || []);
    p.then((list) => {
      setItems(list);
      setLoading(false);
    }).catch(() => setLoading(false));
  };

  useEffect(() => {
    setSelected(null);
    setNotice(null);
    setQuery('');
    if (tab === 'config') {
      getStudioConfig()
        .then((c) => setConfigText(JSON.stringify(c, null, 2)))
        .catch(() => {});
      return;
    }
    loadList(tab);
  }, [tab]);

  const flash = (kind: 'ok' | 'err', text: string) => {
    setNotice({ kind, text });
    setTimeout(() => setNotice(null), 4000);
  };

  const openItem = async (name: string) => {
    try {
      const getter =
        tab === 'skills' ? getStudioSkill : tab === 'commands' ? getStudioCommand : getStudioAgent;
      const r = await getter(name);
      setSelected(name);
      setDraftName(name);
      setContent(r.content);
      setDirty(false);
    } catch (err: any) {
      flash('err', err.message);
    }
  };

  const newItem = () => {
    setSelected('__new__');
    setDraftName('');
    setContent(
      tab === 'skills' ? SKILL_TEMPLATE : tab === 'commands' ? COMMAND_TEMPLATE : AGENT_TEMPLATE,
    );
    setDirty(true);
  };

  const save = async () => {
    const name = draftName.trim();
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) {
      flash('err', 'Name must be kebab-case: lowercase letters, digits, dashes');
      return;
    }
    setBusy(true);
    try {
      if (tab === 'skills') await saveStudioSkill(name, content);
      else if (tab === 'commands') await saveStudioCommand(name, content);
      else await saveStudioAgent(name, content);
      flash('ok', `Saved '${name}' — new opencode sessions pick it up immediately`);
      setSelected(name);
      setDirty(false);
      loadList(tab);
    } catch (err: any) {
      flash('err', err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string) => {
    setBusy(true);
    try {
      if (tab === 'skills') await deleteStudioSkill(name);
      else if (tab === 'commands') await deleteStudioCommand(name);
      else await deleteStudioAgent(name);
      flash('ok', `Deleted '${name}'`);
      if (selected === name) {
        setSelected(null);
        setContent('');
      }
      loadList(tab);
    } catch (err: any) {
      flash('err', err.message);
    } finally {
      setBusy(false);
      setConfirmDelete(null);
    }
  };

  const saveConfig = async () => {
    let patch: Record<string, unknown>;
    try {
      patch = JSON.parse(configText);
    } catch (err: any) {
      flash('err', `Invalid JSON: ${err.message}`);
      return;
    }
    setBusy(true);
    try {
      const merged = await updateStudioConfig(patch);
      setConfigText(JSON.stringify(merged, null, 2));
      flash('ok', 'Configuration saved');
    } catch (err: any) {
      flash('err', err.message);
    } finally {
      setBusy(false);
    }
  };

  const update = () => {
    setNotice(null);
    setReauthError(null);
    setUpdating(true);
    setPendingUpdate(true);
  };

  const executeUpdate = async (accountPassword: string) => {
    setReauthLoading(true);
    setReauthError(null);
    try {
      await applyUpdates(accountPassword, 'opencode');
      setPendingUpdate(false);
      flash('ok', 'opencode update started — progress is tracked in Settings → Updates.');
    } catch (err: any) {
      const msg = err.message || 'Update failed.';
      // Wrong sudo password / rate limit → keep the dialog open for retry;
      // anything else is terminal — close it and surface the error inline.
      const retryable = err.status === 401 || err.status === 429 || (err.status === 400 && /password/i.test(msg));
      if (retryable) {
        setReauthError(msg);
        return;
      }
      setPendingUpdate(false);
      flash('err', msg);
    } finally {
      setReauthLoading(false);
      setUpdating(false);
      getStudioVersion().then(setVer).catch(() => {});
    }
  };

  const q = query.trim().toLowerCase();
  const filtered = q
    ? items.filter(
        (it) =>
          it.name.toLowerCase().includes(q) || (it.description || '').toLowerCase().includes(q),
      )
    : items;

  return (
    <div class="opencode-page">
      <h1 class="sr-only">Opencode Studio</h1>
      <div class="opencode-toolbar">
        <button class="btn-ghost sm" onClick={() => setLocation('/')}><ArrowLeft width={13} height={13} class="icon" /> Dashboard</button>
        <span style="display:inline-flex;align-items:center;gap:4px;margin-left:8px" ref={tabsRef} role="tablist" aria-label="Studio sections" onKeyDown={onTabsKeyDown}>
          <button type="button" role="tab" id="ptab-agents" aria-selected={tab === 'agents'} tabIndex={tab === 'agents' ? 0 : -1} aria-controls="studio-pane-agents" data-tab="agents" class={`btn-ghost sm${tab === 'agents' ? ' active' : ''}`} onClick={() => setTab('agents')}><Bot width={13} height={13} class="icon" /> Subagents</button>
          <button type="button" role="tab" id="ptab-skills" aria-selected={tab === 'skills'} tabIndex={tab === 'skills' ? 0 : -1} aria-controls="studio-pane-skills" data-tab="skills" class={`btn-ghost sm${tab === 'skills' ? ' active' : ''}`} onClick={() => setTab('skills')}><Sparkles width={13} height={13} class="icon" /> Skills</button>
          <button type="button" role="tab" id="ptab-commands" aria-selected={tab === 'commands'} tabIndex={tab === 'commands' ? 0 : -1} aria-controls="studio-pane-commands" data-tab="commands" class={`btn-ghost sm${tab === 'commands' ? ' active' : ''}`} onClick={() => setTab('commands')}><Terminal width={13} height={13} class="icon" /> Commands</button>
          <button type="button" role="tab" id="ptab-config" aria-selected={tab === 'config'} tabIndex={tab === 'config' ? 0 : -1} aria-controls="studio-pane-config" data-tab="config" class={`btn-ghost sm${tab === 'config' ? ' active' : ''}`} onClick={() => setTab('config')}><SlidersHorizontal width={13} height={13} class="icon" /> Config</button>
          <button type="button" role="tab" id="ptab-guide" aria-selected={tab === 'guide'} tabIndex={tab === 'guide' ? 0 : -1} aria-controls="studio-pane-guide" data-tab="guide" class={`btn-ghost sm${tab === 'guide' ? ' active' : ''}`} onClick={() => setTab('guide')}><BookOpen width={13} height={13} class="icon" /> Guide</button>
        </span>
        <span style="flex:1" />
        {tab !== 'config' && tab !== 'guide' && (
          <button class="btn-primary sm" onClick={newItem}><Plus width={13} height={13} class="icon" /> New</button>
        )}
        {ver && (
          <span class="mono" style="font-size:0.68rem;color:var(--text-3);margin-left:12px;display:inline-flex;align-items:center;gap:6px">
            opencode v{ver.current}
            {ver.updateRunning ? (
              <RefreshCw width={12} height={12} class="icon spin" />
            ) : ver.upToDate === true ? (
              <CheckCircle2 width={12} height={12} style="color:var(--ok,#4ade80)" />
            ) : ver.upToDate === false && ver.channelUnlocked ? (
              <button ref={updateBtnRef} class="btn-primary sm" onClick={update} disabled={updating}>
                {updating ? (
                  <RefreshCw width={12} height={12} class="icon spin" />
                ) : (
                  <ArrowUpCircle width={12} height={12} class="icon" />
                )}
                {updating ? ' Authorizing…' : ` Update to ${ver.latest}`}
              </button>
            ) : ver.upToDate === false ? (
              <span title={`v${ver.latest} is a newer major than this Madar build supports (${ver.supportedMajors.join(', ')}). Update Madar first.`}>
                <Lock width={12} height={12} /> {ver.latest} needs a Madar update
              </span>
            ) : null}
          </span>
        )}
      </div>

      {notice && (
        <div
          class="chat-save-msg"
          role={notice.kind === 'err' ? 'alert' : 'status'}
          style={
            notice.kind === 'err'
              ? 'background:#7f1d1d;color:#fecaca;margin:10px 16px;padding:8px 12px;border-radius:8px;font-size:0.75rem'
              : 'margin:10px 16px;padding:8px 12px;border-radius:8px;font-size:0.75rem'
          }
        >
          {notice.text}
        </div>
      )}

      <div id={`studio-pane-${tab}`} role="tabpanel" aria-labelledby={`ptab-${tab}`} tabIndex={0} style="flex:1;display:flex;flex-direction:column;min-height:0">
      {tab === 'guide' ? (
        <div style="flex:1;overflow:hidden">
          <StudioGuide />
        </div>
      ) : tab === 'config' ? (
        <div class="studio-editor" style="padding:16px;display:flex;flex-direction:column;gap:10px;overflow:auto">
          <p style="font-size:0.75rem;color:var(--text-3);margin:0">
            Global opencode.json — applies to every project and interface.
            The $schema key is managed by Madar.
          </p>
          <label class="sr-only" htmlFor="studio-config">Global opencode.json — applies to every project</label>
          <textarea
            id="studio-config"
            class="modern-input mono"
            style="flex:1;min-height:320px;resize:vertical;font-size:0.78rem;line-height:1.5;white-space:pre"
            value={configText}
            onInput={(e: any) => setConfigText(e.target.value)}
            spellcheck={false}
          />
          <div>
            <button class="btn-primary sm" onClick={saveConfig} disabled={busy}>
              <Save width={13} height={13} class="icon" /> Save config
            </button>
          </div>
        </div>
      ) : (
        <div class="studio-body" style="display:flex;gap:14px;padding:14px 16px;overflow:hidden;flex:1">
          {/* List column */}
          <div class="studio-list" style="width:260px;overflow:auto;border-right:1px solid var(--border,#333);padding-right:10px">
            <div style="position:relative;margin-bottom:8px">
              <Search width={12} height={12} class="icon" style="position:absolute;top:7px;inset-inline-start:8px;opacity:.45" />
              <label class="sr-only" htmlFor="studio-filter">Filter items</label>
              <input
                id="studio-filter"
                class="modern-input"
                style="width:100%;font-size:0.72rem;padding:5px 8px 5px 24px;box-sizing:border-box"
                placeholder="Filter…"
                value={query}
                onInput={(e: any) => setQuery(e.target.value)}
              />
            </div>
            {loading ? (
              <p style="color:var(--text-3);font-size:0.75rem">Loading…</p>
            ) : filtered.length === 0 ? (
              <p style="color:var(--text-3);font-size:0.75rem">
                {items.length === 0 ? 'Nothing yet — create one with New.' : 'No matches.'}
              </p>
            ) : (
              filtered.map((it) => (
                <div
                  key={it.name}
                  class="studio-item"
                  style={`display:flex;align-items:center;gap:2px;padding:0 6px 0 10px;border-radius:8px;margin-bottom:6px;background:${
                    selected === it.name ? 'var(--accent-bg,rgba(99,102,241,.15))' : 'transparent'
                  }`}
                >
                  <button
                    type="button"
                    class="studio-item-open"
                    aria-current={selected === it.name ? 'true' : undefined}
                    aria-expanded={selected === it.name ? 'true' : undefined}
                    onClick={() => openItem(it.name)}
                    style="flex:1;min-width:0;text-align:left;background:transparent;border:0;padding:8px 0;cursor:pointer;color:inherit;font:inherit"
                  >
                    <span style="display:flex;justify-content:space-between;align-items:center;gap:6px">
                      <strong style="font-size:0.78rem">{it.name}</strong>
                      {tab === 'agents' && it.mode && (
                        <span style="font-size:0.62rem;padding:1px 6px;border-radius:999px;background:rgba(255,255,255,.08)">
                          {it.mode}
                        </span>
                      )}
                      {tab === 'commands' && it.agent && (
                        <span title="Bound agent" style="font-size:0.62rem;padding:1px 6px;border-radius:999px;background:rgba(255,255,255,.08)">
                          @{it.agent}
                        </span>
                      )}
                    </span>
                    {it.description && (
                      <span style="display:block;font-size:0.68rem;color:var(--text-3);margin-top:2px">
                        {it.description.slice(0, 90)}
                        {it.description.length > 90 ? '…' : ''}
                      </span>
                    )}
                  </button>
                  <span style="display:inline-flex;align-items:center;gap:2px;flex-shrink:0">
                    {it.description && (
                      copied === it.name ? (
                        <span style="display:inline-flex;align-items:center;padding:4px;opacity:.8;color:var(--ok,#4ade80)" role="status">
                          <Check width={13} height={13} class="icon" aria-hidden="true" />
                          <span class="sr-only">Copied</span>
                        </span>
                      ) : (
                        <button
                          type="button"
                          class="studio-action"
                          aria-label={`Copy description of ${it.name}`}
                          title="Copy description — paste into chat to summon this specialist by name"
                          onClick={(e: Event) => {
                            e.stopPropagation();
                            navigator.clipboard.writeText(it.description).then(() => {
                              setCopied(it.name);
                              setTimeout(() => setCopied((c) => (c === it.name ? null : c)), 1500);
                            });
                          }}
                          style="background:transparent;border:0;padding:4px;cursor:pointer;opacity:.5;display:inline-flex;align-items:center;color:inherit"
                        >
                          <Copy width={13} height={13} class="icon" aria-hidden="true" />
                        </button>
                      )
                    )}
                    <button
                      type="button"
                      class="studio-action"
                      aria-label={`Delete ${it.name}`}
                      title="Delete"
                      onClick={(e: Event) => {
                        e.stopPropagation();
                        setConfirmDelete(it.name);
                      }}
                      style="background:transparent;border:0;padding:4px;cursor:pointer;opacity:.5;display:inline-flex;align-items:center;color:inherit"
                    >
                      <Trash2 width={13} height={13} class="icon" aria-hidden="true" />
                    </button>
                  </span>
                </div>
              ))
            )}
          </div>

          {/* Editor column */}
          <div style="flex:1;display:flex;flex-direction:column;gap:8px;min-width:0">
            {selected == null ? (
                <div class="empty-state" style="margin:auto;text-align:center">
                  <div class="big-icon">
                    {tab === 'skills' ? (
                      <Sparkles width={30} height={30} class="icon" />
                    ) : tab === 'commands' ? (
                      <Terminal width={30} height={30} class="icon" />
                    ) : (
                      <Bot width={30} height={30} class="icon" />
                    )}
                  </div>
                Select an item or press New to create one.
                </div>
            ) : (
              <>
                <div style="display:flex;gap:8px;align-items:center">
                  <label class="sr-only" htmlFor="studio-item-name">Item name (kebab-case)</label>
                  <input
                    id="studio-item-name"
                    class="modern-input mono"
                    style="width:240px;font-size:0.78rem;padding:6px 10px"
                    placeholder={tab === 'skills' ? 'skill-name' : tab === 'commands' ? 'command-name' : 'agent-name'}
                    value={selected === '__new__' ? draftName : selected!}
                    readOnly={selected !== '__new__'}
                    onInput={(e: any) => setDraftName(e.target.value)}
                    spellcheck={false}
                  />
                  <span style="flex:1" />
                  <button class="btn-primary sm" onClick={save} disabled={busy || !dirty && selected !== '__new__'}>
                    <Save width={13} height={13} class="icon" /> Save
                  </button>
                </div>
                {descriptionMissingTrigger(content) && (
                  <div role="status" style="display:flex;gap:6px;align-items:center;font-size:0.7rem;color:#fbbf24;background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.25);padding:6px 10px;border-radius:8px">
                    <AlertTriangle width={13} height={13} class="icon" />
                    Description lacks a trigger phrase ("Use when…") — opencode may never select this item automatically.
                  </div>
                )}
                <label class="sr-only" htmlFor="agent-content">Agent content (frontmatter + body)</label>
                <textarea
                  id="agent-content"
                  class="modern-input mono"
                  style="flex:1;resize:none;font-size:0.78rem;line-height:1.55;white-space:pre;min-height:300px"
                  value={content}
                  onInput={(e: any) => {
                    setContent(e.target.value);
                    setDirty(true);
                  }}
                  spellcheck={false}
                />
              </>
            )}
          </div>
        </div>
      )}
      </div>

      <ConfirmModal
        open={confirmDelete != null}
        danger
        loading={busy}
        title={
          tab === 'skills'
            ? `Delete skill '${confirmDelete}'?`
            : tab === 'commands'
              ? `Delete command '/${confirmDelete}'?`
              : `Delete subagent '${confirmDelete}'?`
        }
        message="Removed from the global opencode config. Existing sessions keep working; new ones will not see it."
        confirmLabel="Delete"
        onConfirm={() => remove(confirmDelete!)}
        onCancel={() => setConfirmDelete(null)}
      />

      {/* Component updates now flow through the unified /api/updates route
          (admin-only on the backend) — sudo-style identity confirmation. */}
      <ReAuthModal
        open={pendingUpdate}
        username={user?.username}
        loading={reauthLoading}
        error={reauthError}
        title="Authorize opencode update"
        description="Updating opencode in place. Enter your account password to authorize."
        confirmLabel="Update"
        onConfirm={executeUpdate}
        onCancel={() => { setPendingUpdate(false); setReauthError(null); setUpdating(false); }}
      />
    </div>
  );
}
