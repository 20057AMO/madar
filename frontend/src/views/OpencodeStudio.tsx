import { useState, useEffect, useRef } from 'preact/hooks';
import { ArrowLeft, Bot, Sparkles, SlidersHorizontal, RefreshCw, CheckCircle2, ArrowUpCircle, Lock, Trash2, Plus, Save, Terminal, BookOpen, Search, Copy, Check, AlertTriangle } from 'lucide-preact';
import { useHashLocation } from 'wouter/use-hash-location';
import { ConfirmModal } from '../components/ConfirmModal';
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
  runStudioUpdate,
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

  const update = async () => {
    setUpdating(true);
    try {
      const r = await runStudioUpdate();
      if (r.ok) flash('ok', `Updated to ${r.updatedTo}`);
      else flash('err', r.error || 'Update failed');
    } catch (err: any) {
      flash('err', err.message);
    } finally {
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
            {updating || ver.updateRunning ? (
              <RefreshCw width={12} height={12} class="icon spin" />
            ) : ver.upToDate === true ? (
              <CheckCircle2 width={12} height={12} style="color:var(--ok,#4ade80)" />
            ) : ver.upToDate === false && ver.channelUnlocked ? (
              <button class="btn-primary sm" onClick={update} disabled={updating}>
                <ArrowUpCircle width={12} height={12} class="icon" /> Update to {ver.latest}
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
          style={
            notice.kind === 'err'
              ? 'background:#7f1d1d;color:#fecaca;margin:10px 16px;padding:8px 12px;border-radius:8px;font-size:0.75rem'
              : 'margin:10px 16px;padding:8px 12px;border-radius:8px;font-size:0.75rem'
          }
        >
          {notice.text}
        </div>
      )}

      <div id={`studio-pane-${tab}`} role="tabpanel" aria-labelledby={`ptab-${tab}`} tabIndex={0}>
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
          <textarea
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
              <input
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
                  style={`padding:8px 10px;border-radius:8px;cursor:pointer;margin-bottom:6px;background:${
                    selected === it.name ? 'var(--accent-bg,rgba(99,102,241,.15))' : 'transparent'
                  }`}
                  onClick={() => openItem(it.name)}
                >
                  <div style="display:flex;justify-content:space-between;align-items:center;gap:6px">
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
                    <span style="display:inline-flex;align-items:center;gap:4px;margin-inline-start:auto">
                      {it.description && (
                        copied === it.name ? (
                          <Check width={13} height={13} class="icon" style="opacity:.8;color:var(--ok,#4ade80)" />
                        ) : (
                          <Copy
                            width={13}
                            height={13}
                            class="icon"
                            title="Copy description — paste into chat to summon this specialist by name"
                            style="opacity:.5;cursor:pointer"
                            onClick={(e: Event) => {
                              e.stopPropagation();
                              navigator.clipboard.writeText(it.description).then(() => {
                                setCopied(it.name);
                                setTimeout(() => setCopied((c) => (c === it.name ? null : c)), 1500);
                              });
                            }}
                          />
                        )
                      )}
                      <Trash2
                        width={13}
                        height={13}
                        class="icon"
                        style="opacity:.5;cursor:pointer"
                        onClick={(e: Event) => {
                          e.stopPropagation();
                          setConfirmDelete(it.name);
                        }}
                      />
                    </span>
                  </div>
                  {it.description && (
                    <div style="font-size:0.68rem;color:var(--text-3);margin-top:2px">
                      {it.description.slice(0, 90)}
                      {it.description.length > 90 ? '…' : ''}
                    </div>
                  )}
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
                  <input
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
                  <div style="display:flex;gap:6px;align-items:center;font-size:0.7rem;color:#fbbf24;background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.25);padding:6px 10px;border-radius:8px">
                    <AlertTriangle width={13} height={13} class="icon" />
                    Description lacks a trigger phrase ("Use when…") — opencode may never select this item automatically.
                  </div>
                )}
                <textarea
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
    </div>
  );
}
