import { useState, useEffect, useRef } from 'preact/hooks';
import {
  Lightbulb,
  Loader2,
  Check,
  X,
  RefreshCw,
  CircleAlert,
  StickyNote,
  PenTool,
} from 'lucide-preact';
import {
  listSuggestions,
  acceptSuggestion,
  dismissSuggestion,
  type Suggestion,
  type SuggestionKind,
  type SuggestionSeverity,
} from '../api';
import { relTime } from '../lib/time';
import { useI18n } from '../i18n';

const KIND_KEYS: Record<SuggestionKind, string> = {
  goal_without_task: 'suggestions.kindGoalWithoutTask',
  untracked_idea: 'suggestions.kindUntrackedIdea',
  stale_bug: 'suggestions.kindStaleBug',
  orphan_card: 'suggestions.kindOrphanCard',
  duplicate_item: 'suggestions.kindDuplicateItem',
  empty_board: 'suggestions.kindEmptyBoard',
};

const SEVERITY_KEYS: Record<SuggestionSeverity, string> = {
  high: 'suggestions.severityHigh',
  med: 'suggestions.severityMed',
  low: 'suggestions.severityLow',
};

const SEVERITY_TONE: Record<SuggestionSeverity, string> = {
  high: 'background:rgba(248,81,73,.14);color:#fca5a5',
  med: 'background:rgba(250,204,21,.14);color:#fde68a',
  low: 'background:rgba(148,163,184,.16);color:#cbd5e1',
};

// `title` is a GENERIC per-kind phrase ("Duplicate item", "Orphan card"), so
// using it as the heading made every card of a kind read identically. The
// concrete subject lives in `payload.text`; fall back to `title` only for
// project-level rows that carry no text (e.g. `empty_board`).
const itemLabel = (s: Suggestion) => (s.payload?.text || '').trim() || s.title;

/** Absolute timestamp behind the relative one (shown sr-only inside `<time>`). */
const absTime = (iso: string) => new Date(iso).toLocaleString();

/**
 * Rule-based planning suggestions. An editor accepts a suggestion (landing it
 * into the project notes or the planning canvas) or dismisses it; a viewer gets
 * the read-only list. Every text field derives from user-authored notes/canvas,
 * so it is rendered as PLAIN TEXT nodes here (never through innerHTML).
 */
export function SuggestionsPanel({ slug, canEdit }: { slug: string; canEdit: boolean }) {
  const { t } = useI18n();

  const [items, setItems] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [announcement, setAnnouncement] = useState('');

  const slugRef = useRef(slug);
  slugRef.current = slug;

  const listRef = useRef<HTMLUListElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  // Accept/dismiss removes the card the user was acting on, and with it the
  // focused button → focus silently falls to <body>. Move it one card forward
  // (the removed card's slot), else to the list container, else to the panel
  // heading. `removedIndex` is captured BEFORE the removal (the reload swaps in
  // a whole new list, so the old key is gone by then), and the focus lands on a
  // macrotask AFTER the reload — focusing earlier would target a node the
  // refreshed list then unmounts, dropping focus straight back to <body>.
  // Only when focus really was lost — never stolen from somewhere else.
  const focusAfterRemoval = (removedIndex: number) => {
    window.setTimeout(() => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      const ul = listRef.current;
      const cards = ul ? (Array.from(ul.children) as HTMLElement[]) : [];
      (cards[removedIndex] || ul || headingRef.current)?.focus();
    }, 0);
  };

  // An aria-live region only announces content that CHANGED, so two identical
  // consecutive outcomes set the same string and Preact bails out with zero DOM
  // mutations → nothing is announced. Clear first, then set the text on the next
  // macrotask: two renders, two announcements. setTimeout, not queueMicrotask
  // (Preact batches those into one render) and not rAF (it never fires in a
  // background tab). Same helper as DigestPanel.
  const announceTimerRef = useRef<number | null>(null);
  const announce = (text: string) => {
    if (announceTimerRef.current !== null) window.clearTimeout(announceTimerRef.current);
    setAnnouncement('');
    announceTimerRef.current = window.setTimeout(() => {
      announceTimerRef.current = null;
      setAnnouncement(text);
    }, 60);
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setItems([]);
    setError('');
    setNotice('');
    setAnnouncement('');
    (async () => {
      try {
        const r = await listSuggestions(slug);
        if (!cancelled) setItems(r.items || []);
      } catch (e: any) {
        if (!cancelled) setError(e?.message || t('errors.generic'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      if (announceTimerRef.current !== null) {
        window.clearTimeout(announceTimerRef.current);
        announceTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  // Transient confirmations auto-dismiss.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  // Re-read the list without toggling `loading` (no skeleton flash). Used after
  // an accept/dismiss: landing a card or recording a dismissal can itself change
  // what the rules derive (a freshly landed card is often an orphan), so the
  // honest count comes from the server, not from a local removal alone. A failed
  // refetch keeps the current list — the next mount reconciles.
  const reload = async () => {
    try {
      const r = await listSuggestions(slugRef.current);
      setItems(r.items || []);
    } catch {
      /* keep current list */
    }
  };

  const doRefresh = async () => {
    if (!canEdit || refreshing) return;
    // Focus must survive the busy cycle: `disabled` on a focused control drops
    // focus to <body> in Chromium, so the button stays focusable and uses
    // aria-disabled instead (the guard above is the real gate). Same for the
    // accept/dismiss buttons below.
    setRefreshing(true);
    setError('');
    try {
      // A plain re-fetch: the server recomputes the list on every GET, so this
      // is the whole of "refresh" (there is no refresh endpoint any more).
      const r = await listSuggestions(slugRef.current);
      const next = r.items || [];
      setItems(next);
      setNotice(t('suggestions.refreshed', { n: next.length }));
      announce(t('suggestions.announceRefreshed', { n: next.length }));
    } catch (e: any) {
      setError(e?.message || t('errors.generic'));
    } finally {
      setRefreshing(false);
    }
  };

  const doAccept = async (s: Suggestion) => {
    if (!canEdit || busyKey) return;
    const removedIndex = items.findIndex((x) => x.key === s.key);
    setBusyKey(s.key);
    setError('');
    try {
      const r = await acceptSuggestion(slugRef.current, s.key);
      setItems((list) => list.filter((x) => x.key !== s.key));
      const target =
        r.landed?.target === 'canvas' ? t('suggestions.targetCanvas') : t('suggestions.targetNote');
      setNotice(t('suggestions.landed', { target, title: itemLabel(s) }));
      announce(t('suggestions.announceAccepted', { target, title: itemLabel(s) }));
      await reload();
      focusAfterRemoval(removedIndex);
    } catch (e: any) {
      setError(e?.message || t('errors.generic'));
    } finally {
      setBusyKey(null);
    }
  };

  const doDismiss = async (s: Suggestion) => {
    if (!canEdit || busyKey) return;
    const removedIndex = items.findIndex((x) => x.key === s.key);
    setBusyKey(s.key);
    setError('');
    try {
      await dismissSuggestion(slugRef.current, s.key);
      setItems((list) => list.filter((x) => x.key !== s.key));
      setNotice(t('suggestions.dismissed', { title: itemLabel(s) }));
      announce(t('suggestions.announceDismissed', { title: itemLabel(s) }));
      await reload();
      focusAfterRemoval(removedIndex);
    } catch (e: any) {
      setError(e?.message || t('errors.generic'));
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div style="max-width:720px;margin:0 auto;padding:14px 16px;display:flex;flex-direction:column;gap:12px">
      {/* Accept / dismiss / refresh outcomes are announced here. */}
      <div role="status" aria-live="polite" class="sr-only">
        {announcement}
      </div>

      <div style="display:flex;flex-direction:column;gap:2px">
        <h2
          ref={headingRef}
          tabIndex={-1}
          class="panel-title"
          style="display:flex;align-items:center;gap:6px;margin:0"
        >
          <Lightbulb width={14} height={14} class="icon" /> {t('suggestions.title')}
        </h2>
        <p class="settings-hint" style="margin:0">
          {t('suggestions.description')}
        </p>
      </div>

      {canEdit ? (
        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <span
            style="font-size:0.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--text-2)"
          >
            {t('suggestions.count', { n: items.length })}
          </span>
          <button
            class="btn-ghost sm"
            style="margin-inline-start:auto"
            onClick={doRefresh}
            aria-disabled={refreshing}
          >
            {refreshing ? (
              <Loader2 width={13} height={13} class="icon spin" />
            ) : (
              <RefreshCw width={13} height={13} class="icon" />
            )}
            {refreshing ? t('suggestions.refreshing') : t('suggestions.refresh')}
          </button>
        </div>
      ) : (
        <div class="panel-muted">{t('suggestions.viewerNote')}</div>
      )}

      {error && (
        <div
          style="font-size:0.74rem;color:#fecaca;background:#7f1d1d;border-radius:8px;padding:7px 10px"
          role="alert"
        >
          <CircleAlert width={11} height={11} class="icon" style="vertical-align:-1px" /> {error}
        </div>
      )}
      {/* The visible banners below are deliberately NOT live regions: every
          accept/dismiss/refresh outcome is announced exactly once, through the
          sr-only region at the top of the panel. Errors keep role="alert" —
          they are the one outcome with no sr-only announcement of their own. */}
      {notice && (
        <div
          style="font-size:0.74rem;color:#bbf7d0;background:#14532d;border-radius:8px;padding:7px 10px"
        >
          <Check width={11} height={11} class="icon" style="vertical-align:-1px" /> {notice}
        </div>
      )}

      {/* Status OUTSIDE the aria-hidden skeleton: a screen reader must hear
          that the list is loading. The region stays MOUNTED across states and
          only its text is swapped — a live region inserted already containing
          its text is announced unreliably. */}
      <span class="sr-only" role="status">
        {loading ? t('suggestions.loading') : ''}
      </span>

      {loading ? (
        <>
          <div class="skel-card" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                style="background:rgba(255,255,255,.03);border:1px solid var(--border,#333);border-radius:12px;padding:14px;margin-bottom:10px"
              >
                <div class="skel-line w40" />
                <div class="skel-line w80" style="margin-bottom:0" />
              </div>
            ))}
          </div>
        </>
      ) : items.length === 0 ? (
        <div class="empty-state" style="text-align:center;padding:28px 0">
          <div class="big-icon">
            <Lightbulb width={30} height={30} class="icon" />
          </div>
          <p style="color:var(--text-3);font-size:0.78rem;margin:8px 0 0">{t('suggestions.empty')}</p>
        </div>
      ) : (
        <ul
          ref={listRef}
          role="list"
          tabIndex={-1}
          style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:12px"
        >
          {items.map((s) => (
            <li
              key={s.key}
              tabIndex={-1}
              style="background:rgba(255,255,255,.03);border:1px solid var(--border,#333);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:8px"
            >
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:0.72rem">
                <span
                  style={`display:inline-flex;align-items:center;min-height:24px;font-size:0.72rem;font-weight:600;padding:0 8px;border-radius:999px;${SEVERITY_TONE[s.severity]}`}
                >
                  {t(SEVERITY_KEYS[s.severity])}
                </span>
                <span style="color:var(--text-3)">{t(KIND_KEYS[s.kind])}</span>
                <span style="flex:1" />
                <span style="display:inline-flex;align-items:center;gap:4px;color:var(--text-3)">
                  {s.target === 'canvas' ? (
                    <PenTool width={11} height={11} class="icon" />
                  ) : (
                    <StickyNote width={11} height={11} class="icon" />
                  )}
                  {s.target === 'canvas' ? t('suggestions.targetCanvas') : t('suggestions.targetNote')}
                </span>
                {/* `<time>` maps to a generic role where author-provided names
                    (aria-label/title) are ignored by AT, so the absolute value
                    ships as real sr-only content next to the relative one. */}
                <time datetime={s.createdAt} title={absTime(s.createdAt)} style="color:var(--text-3)">
                  <span aria-hidden="true">{relTime(s.createdAt)}</span>
                  <span class="sr-only">{absTime(s.createdAt)}</span>
                </time>
              </div>

              <p style="margin:0;font-size:0.82rem;font-weight:600;line-height:1.5;color:var(--text-1)">
                {itemLabel(s)}
              </p>
              <p
                style="margin:0;font-size:0.78rem;line-height:1.6;white-space:pre-wrap;word-break:break-word;color:var(--text-2)"
              >
                {s.rationale}
              </p>

              {canEdit && (
                <div style="display:flex;gap:8px;flex-wrap:wrap">
                  <button
                    class="btn-primary sm"
                    onClick={() => doAccept(s)}
                    aria-disabled={!!busyKey}
                    aria-label={t('suggestions.acceptAria', { title: itemLabel(s) })}
                  >
                    {busyKey === s.key ? (
                      <Loader2 width={13} height={13} class="icon spin" />
                    ) : (
                      <Check width={13} height={13} class="icon" />
                    )}
                    {t('suggestions.accept')}
                  </button>
                  <button
                    class="btn-ghost sm"
                    onClick={() => doDismiss(s)}
                    aria-disabled={!!busyKey}
                    aria-label={t('suggestions.dismissAria', { title: itemLabel(s) })}
                  >
                    <X width={13} height={13} class="icon" /> {t('suggestions.dismiss')}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
