import { useState, useEffect, useMemo } from 'preact/hooks';
import { Plus, Trash2, Check, RotateCcw, StickyNote, Lightbulb, Bug, Target } from 'lucide-preact';
import { getProjectNotes, saveProjectNotes, type NoteItem, type NoteKind } from '../api';

const KIND_META: Record<NoteKind, { label: string; icon: typeof Lightbulb; color: string }> = {
  idea: { label: 'Idea', icon: Lightbulb, color: '#fbbf24' },
  bug: { label: 'Bug', icon: Bug, color: '#f87171' },
  goal: { label: 'Goal', icon: Target, color: '#4ade80' },
};

type Filter = NoteKind | 'all';

export function NotesPanel({ slug, readOnly }: { slug: string; readOnly?: boolean }) {
  const [items, setItems] = useState<NoteItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState('');
  const [kind, setKind] = useState<NoteKind>('idea');
  const [filter, setFilter] = useState<Filter>('all');
  const [showDone, setShowDone] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setLoading(true);
    getProjectNotes(slug)
      .then((r) => setItems(r.items || []))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [slug]);

  const persist = async (next: NoteItem[]) => {
    setSaving(true);
    try {
      const r = await saveProjectNotes(slug, next);
      setItems(r.items || next);
      setError('');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const add = () => {
    const text = draft.trim();
    if (!text || text.length > 2000) return;
    const item: NoteItem = {
      id: `n-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text,
      kind,
      done: false,
      createdAt: new Date().toISOString(),
    };
    setDraft('');
    persist([item, ...items]);
  };

  const toggle = (id: string) =>
    persist(items.map((n) => (n.id === id ? { ...n, done: !n.done } : n)));

  const remove = (id: string) => persist(items.filter((n) => n.id !== id));

  const visible = useMemo(
    () =>
      items.filter(
        (n) => (filter === 'all' || n.kind === filter) && (showDone || !n.done),
      ),
    [items, filter, showDone],
  );

  const openCount = items.filter((n) => !n.done).length;
  const countFor = (k: NoteKind) => items.filter((n) => n.kind === k && !n.done).length;

  return (
    <div class="notes-panel" style="max-width:720px;margin:0 auto;padding:14px 16px;display:flex;flex-direction:column;gap:12px">
      <h2 class="panel-title" style="margin-bottom:2px">Notes</h2>
      {readOnly ? (
        <div class="panel-muted" role="status">
          You have viewer access — notes are read-only. Owners and editors can add, mark and delete notes.
        </div>
      ) : (
      /* Composer */
      <div style="display:flex;flex-direction:column;gap:8px;background:rgba(255,255,255,.03);border:1px solid var(--border,#333);border-radius:12px;padding:10px">
        <textarea
          class="modern-input"
          style="width:100%;min-height:56px;resize:vertical;font-size:0.82rem;line-height:1.5;box-sizing:border-box"
          id="notes-composer"
          aria-label="New note"
          placeholder={
            kind === 'bug'
              ? 'Describe the bug — error message, where it happens…'
              : kind === 'goal'
                ? 'What should be true when this goal is reached?'
                : 'Capture the idea before it escapes…'
          }
          value={draft}
          onInput={(e: any) => setDraft(e.target.value)}
          onKeyDown={(e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') add();
          }}
        />
        <div class="notes-track" style="display:flex;align-items:center;gap:6px">
          {(Object.keys(KIND_META) as NoteKind[]).map((k) => {
            const meta = KIND_META[k];
            const active = kind === k;
            return (
              <button
                key={k}
                class={`btn-ghost sm${active ? ' active' : ''}`}
                style={active ? `border-color:${meta.color};color:${meta.color}` : ''}
                aria-pressed={active}
                onClick={() => setKind(k)}
              >
                <meta.icon width={13} height={13} class="icon" /> {meta.label}
              </button>
            );
          })}
          <span style="flex:1" />
          <button
            class="btn-primary sm"
            onClick={add}
            disabled={!draft.trim() || saving}
            title="Add note (Ctrl+Enter)"
            aria-label="Add note"
          >
            <Plus width={13} height={13} class="icon" /> Add
          </button>
        </div>
        {error && (
          <div style="font-size:0.72rem;color:#fecaca;background:#7f1d1d;border-radius:8px;padding:6px 10px" role="alert">
            {error}
          </div>
        )}
      </div>
      )}

      {/* Filters */}
      <div class="notes-filterbar" style="display:flex;align-items:center;gap:6px;font-size:0.75rem;color:var(--text-3)">
        {(['all', 'bug', 'goal', 'idea'] as Filter[]).map((f) => (
          <button
            key={f}
            class={`btn-ghost sm${filter === f ? ' active' : ''}`}
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
          >
            {f === 'all' ? `All (${openCount})` : `${KIND_META[f].label} (${countFor(f)})`}
          </button>
        ))}
        <span style="flex:1" />
        <button class={`btn-ghost sm${showDone ? ' active' : ''}`} aria-pressed={showDone} onClick={() => setShowDone(!showDone)}>
          {showDone ? 'Hiding nothing' : 'Completed hidden'}
        </button>
      </div>

      {/* List */}
      {loading ? (
        <p style="color:var(--text-3);font-size:0.78rem" role="status">Loading notes…</p>
      ) : visible.length === 0 ? (
        <div class="empty-state" style="text-align:center;padding:28px 0" role="status">
          <div class="big-icon"><StickyNote width={30} height={30} class="icon" /></div>
          <p style="color:var(--text-3);font-size:0.78rem;margin:8px 0 0">
            No notes here yet — capture ideas, bugs and goals above.
            They are fed to the AI automatically in project chat.
          </p>
        </div>
      ) : (
        visible.map((n) => {
          const meta = KIND_META[n.kind];
          return (
            <div
              key={n.id}
              style={`display:flex;gap:10px;align-items:flex-start;background:rgba(255,255,255,.03);border:1px solid var(--border,#333);border-radius:12px;padding:10px 12px;opacity:${n.done ? 0.55 : 1}`}
            >
              <button
                title={n.done ? 'Mark as open' : 'Mark as done'}
                aria-label={n.done ? 'Mark as open' : 'Mark as done'}
                aria-pressed={n.done}
                disabled={readOnly}
                onClick={() => toggle(n.id)}
                style={`flex:none;margin-top:2px;width:18px;height:18px;border-radius:6px;border:1.5px solid ${n.done ? meta.color : 'var(--border,#555)'};background:${n.done ? meta.color : 'transparent'};cursor:pointer;display:inline-flex;align-items:center;justify-content:center${readOnly ? ';opacity:.5' : ''}`}
              >
                {n.done && <Check width={13} height={13} style="color:#121318" />}
              </button>
              <div style="flex:1;min-width:0">
                <div
                  style={`font-size:0.8rem;line-height:1.55;white-space:pre-wrap;word-break:break-word;text-decoration:${n.done ? 'line-through' : 'none'}`}
                >
                  {n.text}
                </div>
                <div style="display:flex;align-items:center;gap:8px;margin-top:4px">
                  <span style={`display:inline-flex;align-items:center;gap:4px;font-size:0.64rem;color:${meta.color}`}>
                    <meta.icon width={11} height={11} /> {meta.label}
                  </span>
                  <span style="font-size:0.62rem;color:var(--text-3)">
                    {new Date(n.createdAt).toLocaleString()}
                  </span>
                </div>
              </div>
              <button
                title="Delete note"
                aria-label="Delete note"
                disabled={readOnly}
                onClick={() => remove(n.id)}
                style="flex:none;border:0;background:none;padding:6px;cursor:pointer;opacity:.5;border-radius:6px"
              >
                <Trash2 width={14} height={14} class="icon" />
              </button>
            </div>
          );
        })
      )}

      {items.length > 0 && !showDone && items.some((n) => n.done) && (
        <button class="btn-ghost sm" style="align-self:center" onClick={() => setShowDone(true)}>
          <RotateCcw width={12} height={12} class="icon" /> Show completed
        </button>
      )}
    </div>
  );
}
