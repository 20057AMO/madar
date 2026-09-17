import { useState, useEffect, useRef } from 'preact/hooks';
import { useHashLocation } from 'wouter/use-hash-location';
import {
  BrainCircuit,
  Play,
  Loader2,
  StickyNote,
  LayoutGrid,
  Trash2,
  BookOpen,
  CircleAlert,
  Check,
  Clock,
  Eye,
  Bot,
  Zap,
  Terminal,
} from 'lucide-preact';
import {
  listStudioAgents,
  getStudioAgent,
  delegateStart,
  delegateStatus,
  delegateList,
  delegateGet,
  delegateDelete,
  getProjectNotes,
  saveProjectNotes,
  getProjectCanvas,
  saveProjectCanvas,
  type StudioItem,
  type DelegationEntry,
  type DelegateCapability,
  type NoteKind,
} from '../api';
import { ConfirmModal } from './ConfirmModal';
import { relTime } from '../lib/time';
import {
  buildCanvasFromResult,
  defaultDelegatePrompt,
  delegateAgentCapability,
  resultToNotes,
  DELEGATE_PROMPT_MAX,
  NOTES_MAX_ITEMS,
} from '../lib/delegate-plans';

const POLL_MS = 1500;

function fmtDuration(durationMs?: number): string {
  if (durationMs == null) return '';
  const s = Math.round(durationMs / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function CapBadge({ capability }: { capability: DelegateCapability }) {
  const base = 'display:inline-flex;align-items:center;gap:4px;min-height:24px;font-size:0.72rem;padding:0 8px;border-radius:999px;';
  if (capability === 'readonly') {
    return (
      <span style={`${base}background:rgba(96,165,250,.14);color:#93c5fd`}>
        <Eye width={9} height={9} class="icon" /> read-only
      </span>
    );
  }
  return (
    <span style={`${base}background:rgba(251,191,36,.13);color:#fcd34d`}>
      <Zap width={9} height={9} class="icon" /> writer
    </span>
  );
}

export function AgentRunPanel({ slug, readOnly }: { slug: string; readOnly?: boolean }) {
  const [, setLocation] = useHashLocation();

  const [agents, setAgents] = useState<StudioItem[]>([]);
  const [capabilities, setCapabilities] = useState<Record<string, DelegateCapability>>({});
  const [capLoaded, setCapLoaded] = useState(false);
  const [loading, setLoading] = useState(true);

  const [selected, setSelected] = useState('');
  const [prompt, setPrompt] = useState('');

  const [launchError, setLaunchError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState('');
  const [notice, setNotice] = useState('');

  const [running, setRunning] = useState(false);
  const [tail, setTail] = useState<string[]>([]);
  const [startedAt, setStartedAt] = useState('');

  const [history, setHistory] = useState<DelegationEntry[]>([]);
  const [result, setResult] = useState<DelegationEntry | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');

  const [confirmDelete, setConfirmDelete] = useState<DelegationEntry | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [noteKind, setNoteKind] = useState<NoteKind>('idea');
  const [savingNotes, setSavingNotes] = useState(false);
  const [savingCanvas, setSavingCanvas] = useState(false);

  const pollRef = useRef<number | null>(null);
  const statusRef = useRef<HTMLDivElement | null>(null);
  const resultHeaderRef = useRef<HTMLDivElement | null>(null);
  const runningRef = useRef(false);
  const runningInfoRef = useRef<{ entryId: string; agent: string; startedAt: string } | null>(null);
  const slugRef = useRef(slug);
  slugRef.current = slug;

  const stopPolling = () => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    runningRef.current = false;
    setRunning(false);
  };

  const refreshHistory = async () => {
    try {
      const r = await delegateList(slugRef.current);
      setHistory(r.entries || []);
      setStatusError('');
    } catch (e: any) {
      setStatusError(e.message);
    }
  };

  const finishRun = async (entryId: string) => {
    stopPolling();
    if (!entryId) return;
    try {
      const entry = await delegateGet(slugRef.current, entryId);
      setResult(entry);
      setOpenId(entry.id);
      setAnnouncement(
        entry.status === 'done'
          ? `${entry.agent}: finished`
          : `${entry.agent}: ${entry.status}`,
      );
      requestAnimationFrame(() => resultHeaderRef.current?.focus());
    } catch {
      /* entry may have been pruned by the cap — history refresh below lands it */
    }
    await refreshHistory();
  };

  const pollTick = async () => {
    if (!runningRef.current) {
      stopPolling();
      return;
    }
    try {
      const st = await delegateStatus(slugRef.current);
      if (st.state === 'running') {
        setTail(st.tail || []);
        setStartedAt(st.startedAt);
        return;
      }
      const info = runningInfoRef.current;
      void finishRun(info?.entryId || '');
    } catch (e: any) {
      // 404/403 = project gone or the list/status route stopped answering —
      // stop polling; transient network noise keeps polling.
      if (e.status === 404 || e.status === 403 || e.status === 401) {
        void finishRun(runningInfoRef.current?.entryId || '');
      }
    }
  };

  const startPolling = (entryId?: string, agent?: string, started = new Date().toISOString()) => {
    if (entryId) runningInfoRef.current = { entryId, agent: agent || '', startedAt: started };
    runningRef.current = true;
    setRunning(true);
    setTail([]);
    setAnnouncement('');
    if (pollRef.current !== null) clearInterval(pollRef.current);
    pollRef.current = window.setInterval(pollTick, POLL_MS);
    requestAnimationFrame(() => statusRef.current?.focus());
  };

  // Boot: agents + capabilities + history, and resume a task that is still
  // running server-side (e.g. after a page reload).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // Per-project view state must not leak across projects (result panes are slug-scoped).
    setResult(null);
    setOpenId(null);
    setTail([]);
    setNotice('');
    setLaunchError(null);
    setAnnouncement('');
    setStatusError('');
    runningInfoRef.current = null;
    (async () => {
      try {
        const list = await listStudioAgents();
        if (cancelled) return;
        const items = list.agents || [];
        setAgents(items);
        if (items.length) setSelected((cur) => cur || items[0].name);

        const [caps, hist, st] = await Promise.all([
          Promise.all(
            items.map(async (it): Promise<[string, DelegateCapability]> => {
              try {
                const r = await getStudioAgent(it.name);
                return [it.name, delegateAgentCapability(r.content)];
              } catch {
                return [it.name, 'write']; // safe default — never a false readonly
              }
            }),
          ),
          delegateList(slug).catch(() => ({ entries: [], total: 0 })),
          delegateStatus(slug).catch(() => ({ state: 'idle' as const })),
        ]);
        if (cancelled) return;
        const map: Record<string, DelegateCapability> = {};
        for (const [k, v] of caps) map[k] = v;
        setCapabilities(map);
        setCapLoaded(true);
        setHistory(hist.entries || []);
        if (st.state === 'running') {
          runningInfoRef.current = { entryId: st.entryId, agent: st.agent, startedAt: st.startedAt };
          setTail(st.tail || []);
          setStartedAt(st.startedAt);
          startPolling(undefined, st.agent, st.startedAt);
        }
      } catch (e: any) {
        if (!cancelled) setStatusError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      if (pollRef.current !== null) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      runningRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  // Transient notices auto-dismiss.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  const all = agents;
  const readers = agents.filter((a) => capabilities[a.name] === 'readonly');
  const writers = agents.filter((a) => capabilities[a.name] === 'write');
  const pool = readOnly ? readers : all;

  // Default selection: the first agent in the effective pool once loaded.
  useEffect(() => {
    if (capLoaded && !selected && pool.length) {
      setSelected(pool[0].name);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capLoaded, agents, readOnly]);

  const selectAgent = (name: string) => {
    if (!name) return;
    setSelected(name);
    setPrompt(defaultDelegatePrompt(name)); // each agent ships its own template
  };

  const runAgent = async () => {
    const agent = selected;
    const task = prompt.trim();
    if (!agent || !task || running || task.length > DELEGATE_PROMPT_MAX) return;
    setLaunchError(null);
    try {
      const r = await delegateStart(slug, { agent, prompt: task });
      setResult(null);
      setOpenId(null);
      startPolling(r.id, r.agent, r.createdAt);
      setStartedAt(r.createdAt);
      await refreshHistory();
    } catch (e: any) {
      if (e.code === 'opencode_offline' || e.message === 'opencode_offline') {
        setLaunchError('opencode_offline');
      } else {
        setLaunchError(e.message || 'Failed to start the agent');
      }
    }
  };

  const openEntry = async (entry: DelegationEntry) => {
    setResult(entry);
    setOpenId(entry.id);
    if (entry.status === 'running') {
      try {
        const fresh = await delegateGet(slug, entry.id);
        setResult(fresh);
      } catch {
        /* stale running row — show what history had */
      }
    }
  };

  const doDelete = async () => {
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      await delegateDelete(slug, confirmDelete.id);
      setHistory((h) => h.filter((x) => x.id !== confirmDelete.id));
      if (openId === confirmDelete.id) {
        setResult(null);
        setOpenId(null);
      }
      setConfirmDelete(null);
      setNotice('History entry deleted.');
    } catch (e: any) {
      setStatusError(e.message);
    } finally {
      setDeleting(false);
    }
  };

  // ── Step 6: land a finished result into Notes / Canvas ──
  const saveToNotes = async () => {
    const text = result?.result?.text;
    if (!text || savingNotes || savingCanvas || readOnly) return;
    setSavingNotes(true);
    setStatusError('');
    try {
      const existing = await getProjectNotes(slug);
      const fresh = resultToNotes(text, noteKind);
      const merged = [...fresh, ...(existing.items || [])].slice(0, NOTES_MAX_ITEMS);
      await saveProjectNotes(slug, merged);
      setNotice(`Saved ${fresh.length} note(s) to the project Notes.`);
    } catch (e: any) {
      setStatusError(e.message);
    } finally {
      setSavingNotes(false);
    }
  };

  const aggregateToCanvas = async () => {
    const text = result?.result?.text;
    if (!text || savingNotes || savingCanvas || readOnly) return;
    setSavingCanvas(true);
    setStatusError('');
    try {
      const doc = await getProjectCanvas(slug);
      const built = buildCanvasFromResult(doc, text);
      if (built.added === 0) {
        setNotice('Nothing to aggregate — the result had no parsable items.');
        return;
      }
      await saveProjectCanvas(slug, built.doc);
      setNotice(`Added ${built.added} sticky note(s) to the planning canvas.`);
    } catch (e: any) {
      setStatusError(e.message);
    } finally {
      setSavingCanvas(false);
    }
  };

  const busy = running || savingNotes || savingCanvas;
  const overLimit = prompt.length > DELEGATE_PROMPT_MAX;
  const resultText = result?.result?.text || '';
  const offline = launchError === 'opencode_offline';

  return (
    <div class="notes-panel" style="max-width:720px;margin:0 auto;padding:14px 16px;display:flex;flex-direction:column;gap:12px">
      <div role="status" aria-live="polite" class="sr-only">{announcement}</div>
      <h2 class="panel-title" style="display:flex;align-items:center;gap:6px;margin-bottom:2px">
        <BrainCircuit width={14} height={14} class="icon" /> OpenCode Agents
      </h2>

      {readOnly ? (
        <div class="panel-muted" role="status">
          You have viewer access — you can run <strong>read-only</strong> agents (reviewers and
          auditors) on this project. Editors can additionally run write-capable agents that
          change the workspace, and save results into Notes / Canvas.
        </div>
      ) : (
        <div style="font-size:0.72rem;color:var(--text-3);background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:10px;padding:8px 12px">
          Pick a roster subagent (from Opencode Studio) and give it a task. It works on this
          project's workspace, reading <span class="mono" style="font-size:0.68rem">WSD_PROJECT.md</span> and the planning
          board first. Runs appear in the project activity feed; finished results can be
          saved into Notes or the Canvas.
        </div>
      )}

      {/* ── Agent picker + task editor ── */}
      {loading ? (
        <div
          class="skel-card"
          style="background:rgba(255,255,255,.03);border:1px solid var(--border,#333);border-radius:12px;padding:14px"
          aria-hidden="true"
        >
          <div class="skel-line w40" />
          <div class="skel-line" style="height:76px" />
          <div class="skel-line w60" style="margin-bottom:0" />
        </div>
      ) : pool.length === 0 && capLoaded ? (
        <div class="empty-state" style="text-align:center;padding:24px 0" role="status">
          <div class="big-icon"><BrainCircuit width={26} height={26} class="icon" /></div>
          <p style="color:var(--text-3);font-size:0.78rem;margin:8px 0 0">
            {readOnly
              ? 'There are no read-only agents in the roster for viewer access.'
              : 'No subagents found — open Opencode Studio to create one first.'}
          </p>
        </div>
      ) : (
        <>
          <div style="display:flex;flex-direction:column;gap:8px;background:rgba(255,255,255,.03);border:1px solid var(--border,#333);border-radius:12px;padding:10px">
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <label
                htmlFor="agent-select"
                style="font-size:0.72rem;color:var(--text-3);font-weight:600;text-transform:uppercase;letter-spacing:.04em"
              >
                Agent
              </label>
              <select
                id="agent-select"
                class="modern-input compact"
                style="min-width:200px;flex:1"
                value={selected}
                disabled={running || pool.length === 0}
                onChange={(e: any) => selectAgent(e.target.value)}
              >
                {pool.length > 0 && readers.length > 0 && (
                  <optgroup label="Read-only agents (never edit the workspace)">
                    {readers.map((it) => (
                      <option key={it.name} value={it.name}>
                        {it.name}
                        {it.mode ? ` · ${it.mode}` : ''}
                      </option>
                    ))}
                  </optgroup>
                )}
                {!readOnly && writers.length > 0 && (
                  <optgroup label="Write-capable agents (can edit the workspace)">
                    {writers.map((it) => (
                      <option key={it.name} value={it.name}>
                        {it.name}
                        {it.mode ? ` · ${it.mode}` : ''}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
              {selected && capabilities[selected] && <CapBadge capability={capabilities[selected]} />}
            </div>

            <textarea
              class="modern-input mono"
              style="width:100%;min-height:88px;resize:vertical;font-size:0.78rem;line-height:1.55;box-sizing:border-box"
              aria-label="Agent task"
              aria-invalid={overLimit ? 'true' : undefined}
              aria-describedby="agent-prompt-hint agent-run-shortcut"
              placeholder="Describe the task for this agent — e.g. “Review src/ for XSS-prone patterns”, “Plan the data layer for Y”, “Write tests for Z”…"
              value={prompt}
              disabled={busy}
              onInput={(e: any) => setPrompt(e.target.value)}
              onKeyDown={(e: KeyboardEvent) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') runAgent();
              }}
              spellcheck={false}
            />
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <span
                id="agent-prompt-hint"
                style={`font-size:0.66rem;font-variant-numeric:tabular-nums;${
                  overLimit ? 'color:#fca5a5' : 'color:var(--text-3)'
                }`}
              >
                {prompt.length.toLocaleString()} / {DELEGATE_PROMPT_MAX.toLocaleString()} chars
              </span>
              {overLimit && (
                <span
                  role="alert"
                  style="font-size:0.68rem;color:#fca5a5;font-weight:600"
                >
                  Exceeds the {DELEGATE_PROMPT_MAX.toLocaleString()}-character limit — the agent won't run.
                </span>
              )}
              <span id="agent-run-shortcut" style="font-size:0.66rem;color:var(--text-3)">
                Shortcut: Ctrl+Enter
              </span>
              <span style="flex:1" />
              {selected && (
                <button
                  class="btn-primary sm"
                  onClick={runAgent}
                  disabled={!selected || !prompt.trim() || overLimit || busy}
                  aria-label={running ? 'Agent is running — wait for it to finish' : 'Run the agent on this project'}
                  title="Run (Ctrl+Enter)"
                >
                  {running ? <Loader2 width={13} height={13} class="icon spin" /> : <Play width={13} height={13} class="icon" />}
                  {running ? 'Running…' : 'Run agent'}
                </button>
              )}
              {readOnly && (
                <span style="font-size:0.68rem;color:var(--text-3)">Read-only agents only.</span>
              )}
            </div>
          </div>
        </>
      )}

      {offline && (
        <div class="panel" role="status" style="margin:0;padding:14px;borderInlineStart:3px solid var(--red);background:rgba(248,81,73,0.06)">
          <div style="display:flex;align-items:center;gap:8px;color:var(--text);font-weight:600;font-size:0.8rem">
            <CircleAlert width={15} height={15} class="icon" style="color:var(--red)" />
            <span>opencode isn't reachable in this container</span>
          </div>
          <p class="settings-hint" style="margin:6px 0 0">
            The agent runner needs the opencode web service. Make sure opencode is available
            on the host, then retry — or open the Opencode page to check its status.
          </p>
          <div style="display:flex;gap:8px;margin-top:10px">
            <button class="btn-ghost sm" onClick={() => setLocation('/opencode')}>
              <Terminal width={12} height={12} class="icon" /> Open Opencode
            </button>
            <button class="btn-ghost sm" onClick={() => setLaunchError(null)}>
              <Check width={12} height={12} class="icon" /> Dismiss
            </button>
          </div>
        </div>
      )}

      {!offline && launchError && (
        <div style="font-size:0.74rem;color:#fecaca;background:#7f1d1d;border-radius:8px;padding:7px 10px" role="alert">
          {launchError}
        </div>
      )}
      {statusError && (
        <div style="font-size:0.74rem;color:#fecaca;background:#7f1d1d;border-radius:8px;padding:7px 10px" role="alert">
          {statusError}
        </div>
      )}
      {notice && (
        <div
          style="font-size:0.74rem;color:#bbf7d0;background:#14532d;border-radius:8px;padding:7px 10px"
          role="status"
        >
          <Check width={11} height={11} class="icon" style="vertical-align:-1px" /> {notice}
        </div>
      )}

      {/* ── Live run / result ── */}
      {(running || result) && (
        <div style="display:flex;flex-direction:column;gap:8px;background:rgba(255,255,255,.03);border:1px solid var(--border,#333);border-radius:12px;padding:12px">
          {running && (
            <div
              ref={statusRef}
              tabIndex={-1}
              role="status"
              aria-live="polite"
              style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:0.74rem"
            >
              <Loader2 width={13} height={13} class="icon spin" style="color:#93c5fd" />
              <span style="font-weight:600">{runningInfoRef.current?.agent || selected || 'agent'}</span>
              <span style="color:var(--text-3)">running on this project…</span>
              {startedAt && (
                <span style="display:inline-flex;align-items:center;gap:4px;color:var(--text-3)">
                  <Clock width={11} height={11} class="icon" /> {relTime(startedAt)}
                </span>
              )}
              <span style="flex:1" />
              <span style="font-size:0.64rem;color:var(--text-3)">polls every {POLL_MS / 1000}s</span>
            </div>
          )}
          {tail.length > 0 && (
            <pre
              class="mono"
              tabIndex={0}
              style="margin:0;max-height:240px;overflow:auto;font-size:0.68rem;line-height:1.5;color:#d4d4d8;background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.07);border-radius:8px;padding:8px 10px;white-space:pre-wrap;word-break:break-word"
              aria-label="Agent live output"
            >
              {tail.join('\n')}
            </pre>
          )}
          {!running && result && (
            <div style="display:flex;flex-direction:column;gap:8px">
              <div
                ref={resultHeaderRef}
                tabIndex={-1}
                style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:0.74rem"
              >
                <Bot width={13} height={13} class="icon" style="color:#a78bfa" />
                <span style="font-weight:600">{result.agent}</span>
                {result.capability && <CapBadge capability={result.capability} />}
                <span
                  style={`display:inline-flex;align-items:center;min-height:24px;font-size:0.72rem;padding:0 8px;border-radius:999px;${
                    result.status === 'done'
                      ? 'background:rgba(74,222,128,.13);color:#86efac'
                      : result.status === 'failed'
                        ? 'background:rgba(248,81,73,.14);color:#fca5a5'
                        : 'background:rgba(255,255,255,.08);color:var(--text-2)'
                  }`}
                >
                  {result.status}
                </span>
                {result.durationMs != null && <span style="color:var(--text-3)">{fmtDuration(result.durationMs)}</span>}
                <span style="color:var(--text-3)">{relTime(result.createdAt)}</span>
                {result.actorName && <span style="color:var(--text-3)">by {result.actorName}</span>}
              </div>

              {result.prompt && (
                <div style="font-size:0.68rem;color:var(--text-3);background:rgba(255,255,255,.04);border-radius:6px;padding:5px 9px;white-space:pre-wrap;word-break:break-word;max-height:72px;overflow:auto">
                  {result.prompt}
                </div>
              )}

              {result.error && (
                <div style="font-size:0.72rem;color:#fecaca;background:#7f1d1d;border-radius:8px;padding:7px 10px" role="alert">
                  {result.error}
                </div>
              )}

              {resultText && (
                <pre
                  class="mono"
                  tabIndex={0}
                  style="margin:0;max-height:360px;overflow:auto;font-size:0.72rem;line-height:1.55;color:#e4e4e7;background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.07);border-radius:8px;padding:10px 12px;white-space:pre-wrap;word-break:break-word"
                  aria-label="Agent result"
                >
                  {resultText}
                </pre>
              )}

              {(result.result?.agent || result.result?.model || result.result?.finish || result.result?.cost != null || result.result?.tokens != null) && (
                <div style="display:flex;gap:6px;flex-wrap:wrap;font-size:0.64rem;color:var(--text-3)">
                  {result.result?.agent && <span>{result.result.agent}</span>}
                  {result.result?.model && <span>model: {result.result.model}</span>}
                  {result.result?.finish && <span>finish: {result.result.finish}</span>}
                  {result.result?.cost != null && <span>cost: {result.result.cost}</span>}
                  {result.result?.tokens != null && <span>tokens: {result.result.tokens}</span>}
                </div>
              )}

              {result.result?.files && result.result.files.length > 0 && (
                <div style="font-size:0.68rem;color:#93c5fd;display:flex;flex-direction:column;gap:2px">
                  <span style="color:var(--text-3)">Files touched:</span>
                  {result.result.files.slice(0, 12).map((f) => (
                    <span key={f} style="word-break:break-all">&nbsp;• {f}</span>
                  ))}
                  {result.result.files.length > 12 && <span style="color:var(--text-3)">…+{result.result.files.length - 12} more</span>}
                </div>
              )}

              {!readOnly && result.status === 'done' && resultText && (
                <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;border-top:1px solid rgba(255,255,255,.07);padding-top:8px">
                  <label
                    htmlFor="agent-land-kind"
                    style="font-size:0.68rem;color:var(--text-3);font-weight:600"
                  >
                    Land into project:
                  </label>
                  <select
                    id="agent-land-kind"
                    class="modern-input compact"
                    style="min-width:90px"
                    value={noteKind}
                    disabled={busy}
                    onChange={(e: any) => setNoteKind(e.target.value as NoteKind)}
                  >
                    <option value="idea">Idea</option>
                    <option value="goal">Goal</option>
                  </select>
                  <button class="btn-ghost sm" onClick={saveToNotes} disabled={busy}>
                    {savingNotes ? <Loader2 width={12} height={12} class="icon spin" /> : <StickyNote width={12} height={12} class="icon" />}
                    Save to Notes
                  </button>
                  <button class="btn-ghost sm" onClick={aggregateToCanvas} disabled={busy} title="Add result sections as sticky notes on the planning canvas">
                    {savingCanvas ? <Loader2 width={12} height={12} class="icon spin" /> : <LayoutGrid width={12} height={12} class="icon" />}
                    Aggregate to Canvas
                  </button>
                </div>
              )}
              {readOnly && result.status === 'done' && resultText && (
                <span style="font-size:0.68rem;color:var(--text-3)">Viewers cannot save results into Notes / Canvas.</span>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── History ── */}
      <div style="display:flex;flex-direction:column;gap:8px">
        <h3 style="display:flex;align-items:center;gap:6px;font-size:0.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--text-2);margin:0">
          <BookOpen width={13} height={13} class="icon" /> History
          <span style="color:var(--text-3);font-weight:400;text-transform:none">(last {history.length})</span>
        </h3>
        {loading ? (
          <p style="color:var(--text-3);font-size:0.75rem" role="status">Loading history…</p>
        ) : history.length === 0 ? (
          <div class="empty-state" style="text-align:center;padding:20px 0" role="status">
            <div class="big-icon"><Bot width={24} height={24} class="icon" /></div>
            <p style="color:var(--text-3);font-size:0.75rem;margin:6px 0 0">
              No agent runs yet — launch one above and its history lands here
              (project activity also records each run).
            </p>
          </div>
        ) : (
          <div style="display:flex;flex-direction:column;gap:6px">
            {history.map((h) => (
              <div
                key={h.id}
                style={`display:flex;gap:8px;align-items:flex-start;background:${
                  openId === h.id ? 'rgba(99,102,241,.10)' : 'rgba(255,255,255,.03)'
                };border:1px solid ${openId === h.id ? 'rgba(99,102,241,.4)' : 'var(--border,#333)'};border-radius:10px;padding:8px 10px`}
              >
                <span
                  style={`flex:none;margin-top:3px;width:8px;height:8px;border-radius:50%;${
                    h.status === 'done'
                      ? 'background:#4ade80'
                      : h.status === 'failed'
                        ? 'background:#f87171'
                        : 'background:#fbbf24'
                  }${h.status === 'running' ? ';animation:ws-pulse 1.4s ease-in-out infinite' : ''}`}
                  title={h.status}
                />
                <div style="flex:1;min-width:0">
                  <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:0.74rem">
                    <button
                      class="btn-ghost sm"
                      style="min-height:24px;font-weight:600"
                      onClick={() => openEntry(h)}
                    >
                      {h.agent}
                    </button>
                    {h.capability && <CapBadge capability={h.capability} />}
                    <span style="color:var(--text-3)">{h.status}</span>
                    <span style="flex:1" />
                    <span style="font-size:0.64rem;color:var(--text-3)">{relTime(h.createdAt)}</span>
                    {h.durationMs != null && (
                      <span style="font-size:0.64rem;color:var(--text-3)">{fmtDuration(h.durationMs)}</span>
                    )}
                  </div>
                  <div style="font-size:0.68rem;color:var(--text-3);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
                    {h.prompt || (h.error ? `failed: ${h.error}` : h.result?.text ? h.result.text.slice(0, 120) : '')}
                  </div>
                </div>
                <button
                  class="btn-ghost sm icon-only"
                  title="Delete history entry"
                  aria-label={`Delete run ${h.agent}`}
                  disabled={readOnly}
                  onClick={() => setConfirmDelete(h)}
                  style={
                    readOnly
                      ? 'min-height:24px;min-width:24px;opacity:.4;cursor:not-allowed'
                      : 'min-height:24px;min-width:24px'
                  }
                >
                  <Trash2 width={13} height={13} class="icon" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <ConfirmModal
        open={!!confirmDelete}
        danger
        title={`Delete agent run '${confirmDelete?.agent}'?`}
        message="The history entry is removed from this project. The workspace is not affected."
        confirmLabel="Delete"
        loading={deleting}
        onConfirm={doDelete}
        onCancel={() => setConfirmDelete(null)}
      />
    </div>
  );
}