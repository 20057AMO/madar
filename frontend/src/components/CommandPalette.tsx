import type { JSX } from 'preact';
import { useState, useEffect, useRef, useMemo } from 'preact/hooks';
import {
  LayoutDashboard,
  FolderOpen,
  MessageCircle,
  PencilRuler,
  Bot,
  Settings as SettingsIcon,
  KeyRound,
  Users,
  UserRound,
  Search,
  Plus,
  TerminalSquare,
  Languages,
  CornerDownLeft,
} from 'lucide-preact';
import { useHashLocation } from 'wouter/use-hash-location';
import { useI18n } from '../i18n';
import { useAuth } from '../auth';
import { listProjects, type Project } from '../api';
import { VSCodeIcon, OpencodeIcon } from './brand-icons';

interface Cmd {
  id: string;
  label: string;
  section: 'pages' | 'actions' | 'projects';
  icon: any;
  run: () => void;
  /** The route this command lands on, used to mark the current page. */
  path?: string;
  /** Lower runs earlier within its section. */
  order?: number;
}

const LIST_ID = 'palette-listbox';

function subsequenceMatch(haystack: string, needle: string): boolean {
  let i = 0;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  for (const ch of n) {
    i = h.indexOf(ch, i);
    if (i === -1) return false;
    i++;
  }
  return true;
}

function routePath(loc: string | null): string {
  return (loc || '').split('?')[0].split('#')[0].replace(/\/+$/, '') || '/';
}

/**
 * Whether an element is a real, on-screen target for restored focus. A
 * connected node is not enough: below 860px the sidebar is only translated
 * off-canvas (never unmounted), so its "Command palette" trigger stays in the
 * DOM while invisible and must not receive focus on close. `#main` is the
 * fallback whenever this returns false.
 */
function visibleFocusTarget(el: HTMLElement | null): el is HTMLElement {
  if (!el || !el.isConnected || !el.offsetParent) return false;
  const sidebar = el.closest('.sidebar');
  // Below 860px the sidebar is only translated off-canvas (never unmounted),
  // and `.open` is the authoritative signal there. `.open` is never added at
  // desktop widths, where the sidebar is always visible, so the class is only
  // consulted inside the mobile breakpoint.
  if (
    sidebar &&
    !sidebar.classList.contains('open') &&
    window.matchMedia('(max-width: 860px)').matches
  ) {
    return false;
  }
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.right > 0 && r.left < window.innerWidth;
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, setLang, lang } = useI18n();
  const { user } = useAuth();
  const [location, setLocation] = useHashLocation();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  // Guard against a slow response from a previous open landing after a reopen.
  const reqRef = useRef(0);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const close = () => onCloseRef.current();

  // Save the opener and fetch projects on open; restore focus on close.
  useEffect(() => {
    if (!open) return;
    const req = ++reqRef.current;
    const active = document.activeElement;
    openerRef.current =
      active instanceof HTMLElement && active !== document.body && visibleFocusTarget(active) ? active : null;
    setQuery('');
    setCursor(0);
    setProjects([]);
    setLoadState('loading');
    listProjects()
      .then((p) => { if (req === reqRef.current) { setProjects(p.projects); setLoadState('ready'); } })
      .catch(() => { if (req === reqRef.current) { setProjects([]); setLoadState('error'); } });
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      cancelAnimationFrame(raf);
      // Invalidate any in-flight fetch from this open.
      reqRef.current++;
      // `#main` exists on every route (Shell, plus the /agents and
      // /opencode-studio early-return branches). An opener that has gone
      // off-canvas (a mobile sidebar drawer that just closed) is skipped too.
      const opener = openerRef.current;
      const target = visibleFocusTarget(opener) ? opener : document.getElementById('main');
      target?.focus?.();
    };
  }, [open]);

  const go = (path: string) => {
    setLocation(path);
    close();
  };

  const isAdmin = user?.role === 'admin';
  const canWrite = !!user && user.role !== 'viewer';

  const commands = useMemo<Cmd[]>(() => {
    const cmds: Cmd[] = [
      { id: 'page:/', path: '/', label: t('nav.dashboard'), section: 'pages', icon: LayoutDashboard, run: () => go('/'), order: 10 },
      { id: 'page:/projects', path: '/projects', label: t('nav.projects'), section: 'pages', icon: FolderOpen, run: () => go('/projects'), order: 20 },
      { id: 'page:/chat', path: '/chat', label: t('nav.teamChat'), section: 'pages', icon: MessageCircle, run: () => go('/chat'), order: 30 },
      { id: 'page:/planner', path: '/planner', label: t('nav.planner'), section: 'pages', icon: PencilRuler, run: () => go('/planner'), order: 40 },
      { id: 'page:/agents', path: '/agents', label: t('nav.agents'), section: 'pages', icon: Bot, run: () => go('/agents'), order: 50 },
      { id: 'page:/profile', path: '/profile', label: t('common.profile'), section: 'pages', icon: UserRound, run: () => go('/profile'), order: 60 },
    ];
    if (isAdmin) {
      cmds.push(
        { id: 'page:/providers', path: '/providers', label: t('nav.providers'), section: 'pages', icon: KeyRound, run: () => go('/providers'), order: 70 },
        { id: 'page:/team', path: '/team', label: t('nav.team'), section: 'pages', icon: Users, run: () => go('/team'), order: 75 },
        { id: 'page:/opencode-studio', path: '/opencode-studio', label: t('nav.ocStudio'), section: 'pages', icon: OpencodeIcon, run: () => go('/opencode-studio'), order: 80 },
      );
    }
    cmds.push(
      { id: 'page:/settings', path: '/settings', label: t('nav.settings'), section: 'pages', icon: SettingsIcon, run: () => go('/settings'), order: 90 },
    );
    if (canWrite) {
      cmds.push({
        id: 'action:new-project',
        label: t('palette.newProject'),
        section: 'actions',
        icon: Plus,
        run: () => {
          try { sessionStorage.setItem('wsd.openCreate', '1'); } catch { /* ignore */ }
          window.dispatchEvent(new CustomEvent('wsd:openCreate'));
          go('/projects');
        },
        order: 10,
      });
      cmds.push({
        id: 'action:vscode',
        path: '/ide',
        label: t('palette.openVSCode'),
        section: 'actions',
        icon: VSCodeIcon,
        run: () => go('/ide'),
        order: 20,
      });
    }
    cmds.push({
      id: 'action:terminals',
      path: '/terminals',
      label: t('palette.openTerminals'),
      section: 'actions',
      icon: TerminalSquare,
      run: () => go('/terminals'),
      order: 30,
    });
    cmds.push({
      id: 'action:lang',
      label: t('palette.toggleLang'),
      section: 'actions',
      icon: Languages,
      run: () => { setLang(lang === 'ar' ? 'en' : 'ar'); close(); },
      order: 40,
    });
    return cmds;
    // `go()`/`close()` read stable refs + setLocation; `path` (the current-route
    // marker) derives from `location` at render time, so the memo is rebuilt
    // only when the copy, language or role actually change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, lang, setLang, isAdmin, canWrite]);

  const filtered = useMemo(() => {
    const q = query.trim();
    const matchCmds = (list: Cmd[]) =>
      q ? list.filter((c) => subsequenceMatch(c.label, q)) : list;

    const pages = matchCmds(commands.filter((c) => c.section === 'pages')).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const actions = matchCmds(commands.filter((c) => c.section === 'actions')).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    const projCmds: Cmd[] = q
      ? projects
          .filter((p) => subsequenceMatch(`${p.name} ${p.slug}`, q))
          .slice(0, 6)
          .map((p) => ({
            id: `project:${p.slug}`,
            label: p.name,
            section: 'projects' as const,
            icon: FolderOpen,
            path: `/project/${p.slug}`,
            run: () => go(`/project/${p.slug}`),
          }))
      : [];
    return [...pages, ...actions, ...projCmds];
  }, [query, commands, projects]);

  const activeIdx = Math.max(0, Math.min(cursor, filtered.length - 1));
  const hasQuery = query.trim().length > 0;
  const path = routePath(location);

  // Keep the listener mounted once per open; live values ride in refs.
  const filteredRef = useRef(filtered);
  filteredRef.current = filtered;
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  useEffect(() => {
    setCursor(0);
  }, [query]);

  useEffect(() => {
    setCursor((c) => (c > filtered.length - 1 ? Math.max(0, filtered.length - 1) : c));
  }, [filtered.length]);

  // Keep the highlighted row visible while arrowing through a long list.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const row = list.querySelector<HTMLElement>(`[data-idx="${activeIdx}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const consume = () => {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
      };
      if (e.key === 'Escape') {
        consume();
        close();
      } else if (e.key === 'ArrowDown') {
        consume();
        setCursor((c) => Math.min(c + 1, Math.max(0, filteredRef.current.length - 1)));
      } else if (e.key === 'ArrowUp') {
        consume();
        setCursor((c) => Math.max(c - 1, 0));
      } else if (e.key === 'Tab') {
        consume();
        inputRef.current?.focus();
      } else if (e.key === 'Enter') {
        consume();
        const list = filteredRef.current;
        const idx = Math.min(cursorRef.current, list.length - 1);
        const cmd = idx >= 0 ? list[idx] : undefined;
        if (cmd) cmd.run();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open]);

  if (!open) return null;

  const sections: Array<{ key: 'pages' | 'actions' | 'projects'; label: string }> = [
    { key: 'pages', label: t('palette.pages') },
    { key: 'actions', label: t('palette.actions') },
    { key: 'projects', label: t('palette.projects') },
  ];

  let flatIdx = -1;

  return (
    <div class="palette-overlay" onClick={close}>
      <div
        class="palette"
        role="dialog"
        aria-modal="true"
        aria-label={t('palette.title')}
        onClick={(e: Event) => e.stopPropagation()}
      >
        <div class="palette-input-row">
          <Search width={15} height={15} class="icon palette-search-icon" aria-hidden="true" />
          <input
            ref={inputRef}
            class="palette-input"
            type="text"
            value={query}
            placeholder={t('palette.placeholder')}
            role="combobox"
            aria-expanded={filtered.length > 0 ? 'true' : 'false'}
            aria-haspopup="listbox"
            aria-controls={LIST_ID}
            aria-autocomplete="list"
            aria-activedescendant={filtered.length > 0 ? `palette-opt-${activeIdx}` : undefined}
            aria-label={t('palette.searchLabel')}
            autoComplete="off"
            spellcheck={false}
            onInput={(e: JSX.TargetedEvent<HTMLInputElement>) => setQuery(e.currentTarget.value)}
          />
          <kbd class="palette-kbd">esc</kbd>
        </div>
        <div class="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {filtered.length === 0
            ? t('palette.noResults')
            : filtered.length === 1
              ? t('palette.resultsOne')
              : t('palette.results', { n: filtered.length })}
        </div>
        <div class="palette-list" ref={listRef}>
          <div class="palette-options" role="listbox" id={LIST_ID}>
            {sections.map((s) => {
              const rows = filtered.filter((c) => c.section === s.key);
              if (rows.length === 0) return null;
              return (
                <div class="palette-section" key={s.key} role="group" aria-labelledby={`palette-sec-${s.key}`}>
                  <div class="palette-section-title" id={`palette-sec-${s.key}`}>{s.label}</div>
                  {rows.map((c) => {
                    flatIdx++;
                    const idx = flatIdx;
                    const active = idx === activeIdx;
                    const current = !!c.path && c.path === path;
                    return (
                      <button
                        key={c.id}
                        type="button"
                        role="option"
                        id={`palette-opt-${idx}`}
                        aria-selected={active ? 'true' : 'false'}
                        class={`palette-row${active ? ' active' : ''}`}
                        data-idx={idx}
                        tabIndex={-1}
                        title={c.label}
                        onMouseMove={() => { if (cursor !== idx) setCursor(idx); }}
                        onClick={() => c.run()}
                      >
                        <c.icon width={14} height={14} class="icon" aria-hidden="true" />
                        <span class="palette-row-label">{c.label}</span>
                        {current && <span class="palette-row-current">{t('palette.current')}</span>}
                        {active && <CornerDownLeft width={12} height={12} class="palette-enter" aria-hidden="true" />}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
          {filtered.length === 0 && hasQuery && <div class="palette-empty">{t('palette.noResults')}</div>}
          {hasQuery && loadState === 'loading' && <div class="palette-note">{t('common.loading')}</div>}
          {hasQuery && loadState === 'error' && <div class="palette-note error">{t('palette.projectsError')}</div>}
        </div>
        <div class="palette-footer">
          <span class="palette-hint">{t('palette.hint')}</span>
        </div>
      </div>
    </div>
  );
}
