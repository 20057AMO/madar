import { useState, useEffect, useRef, useMemo } from 'preact/hooks';
import {
  LayoutDashboard,
  FolderOpen,
  MessageCircle,
  PencilRuler,
  Bot,
  Settings as SettingsIcon,
  Search,
  Plus,
  TerminalSquare,
  Languages,
  CornerDownLeft,
} from 'lucide-preact';
import { useHashLocation } from 'wouter/use-hash-location';
import { useI18n } from '../i18n';
import { listProjects, type Project } from '../api';
import { VSCodeIcon } from './brand-icons';

interface Cmd {
  id: string;
  label: string;
  section: 'pages' | 'actions' | 'projects';
  icon: any;
  run: () => void;
  /** Lower runs earlier within its section. */
  order?: number;
}

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

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, setLang, lang } = useI18n();
  const [, setLocation] = useHashLocation();
  const [projects, setProjects] = useState<Project[]>([]);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setCursor(0);
    listProjects()
      .then((p) => setProjects(p.projects))
      .catch(() => {});
    const id = window.setTimeout(() => inputRef.current?.focus(), 20);
    return () => clearTimeout(id);
  }, [open]);

  const close = () => onClose();

  const go = (path: string) => {
    setLocation(path);
    close();
  };

  const commands = useMemo<Cmd[]>(() => {
    const cmds: Cmd[] = [
      { id: 'page:/', label: t('nav.dashboard'), section: 'pages', icon: LayoutDashboard, run: () => go('/'), order: 10 },
      { id: 'page:/projects', label: t('nav.projects'), section: 'pages', icon: FolderOpen, run: () => go('/projects'), order: 20 },
      { id: 'page:/chat', label: t('nav.teamChat'), section: 'pages', icon: MessageCircle, run: () => go('/chat'), order: 30 },
      { id: 'page:/planner', label: t('nav.planner'), section: 'pages', icon: PencilRuler, run: () => go('/planner'), order: 40 },
      { id: 'page:/agents', label: t('nav.agents'), section: 'pages', icon: Bot, run: () => go('/agents'), order: 50 },
      { id: 'page:/settings', label: t('nav.settings'), section: 'pages', icon: SettingsIcon, run: () => go('/settings'), order: 60 },
      {
        id: 'action:new-project',
        label: t('dashboard.newProject'),
        section: 'actions',
        icon: Plus,
        run: () => {
          try { sessionStorage.setItem('wsd.openCreate', '1'); } catch { /* ignore */ }
          go('/projects');
        },
        order: 10,
      },
      {
        id: 'action:vscode',
        label: t('nav.vscode'),
        section: 'actions',
        icon: VSCodeIcon,
        run: () => go('/ide'),
        order: 20,
      },
      {
        id: 'action:terminals',
        label: t('dashboard.terminals'),
        section: 'actions',
        icon: TerminalSquare,
        run: () => go('/terminals'),
        order: 30,
      },
      {
        id: 'action:lang',
        label: t('lang.switch'),
        section: 'actions',
        icon: Languages,
        run: () => { setLang(lang === 'ar' ? 'en' : 'ar'); close(); },
        order: 40,
      },
    ];
    return cmds;
    // go() closes over setLocation/onClose which are stable per render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, lang, setLang, location]);

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
            run: () => go(`/project/${p.slug}`),
          }))
      : [];
    return [...pages, ...actions, ...projCmds];
  }, [query, commands, projects]);

  useEffect(() => {
    setCursor(0);
  }, [query]);

  // Keep the highlighted row visible while arrowing through a long list.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const row = list.querySelector<HTMLElement>(`[data-idx="${cursor}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCursor((c) => Math.min(c + 1, Math.max(0, filtered.length - 1)));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCursor((c) => Math.max(c - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const cmd = filtered[cursor];
        if (cmd) cmd.run();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, filtered, cursor]);

  if (!open) return null;

  const sections: Array<{ key: 'pages' | 'actions' | 'projects'; label: string }> = [
    { key: 'pages', label: t('palette.pages') },
    { key: 'actions', label: t('palette.actions') },
    { key: 'projects', label: t('palette.projects') },
  ];

  let flatIdx = -1;

  return (
    <div class="palette-overlay" onClick={close} role="presentation">
      <div
        class="palette"
        role="dialog"
        aria-modal="true"
        aria-label={t('palette.title')}
        onClick={(e: Event) => e.stopPropagation()}
      >
        <div class="palette-input-row">
          <Search width={15} height={15} class="icon palette-search-icon" />
          <input
            ref={inputRef}
            class="palette-input"
            type="text"
            value={query}
            placeholder={t('palette.placeholder')}
            aria-label={t('palette.title')}
            autoComplete="off"
            spellcheck={false}
            onInput={(e: any) => setQuery(e.target.value)}
          />
          <kbd class="palette-kbd">esc</kbd>
        </div>
        <div class="palette-list" ref={listRef}>
          {filtered.length === 0 && <div class="palette-empty">{t('palette.noResults')}</div>}
          {sections.map((s) => {
            const rows = filtered.filter((c) => c.section === s.key);
            if (rows.length === 0) return null;
            return (
              <div class="palette-section" key={s.key}>
                <div class="palette-section-title">{s.label}</div>
                {rows.map((c) => {
                  flatIdx++;
                  const idx = flatIdx;
                  const active = idx === cursor;
                  return (
                    <button
                      key={c.id}
                      class={`palette-row${active ? ' active' : ''}`}
                      data-idx={idx}
                      onMouseEnter={() => setCursor(idx)}
                      onClick={() => c.run()}
                    >
                      <c.icon width={14} height={14} class="icon" />
                      <span class="palette-row-label">{c.label}</span>
                      {active && <CornerDownLeft width={12} height={12} class="palette-enter" />}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
        <div class="palette-footer">
          <span class="palette-hint">{t('palette.hint')}</span>
        </div>
      </div>
    </div>
  );
}
