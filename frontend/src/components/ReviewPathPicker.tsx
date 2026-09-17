import { useState, useEffect, useRef } from 'preact/hooks';
import { FolderOpen, ChevronRight, ChevronDown, Folder, FileText, Loader2, RotateCcw } from 'lucide-preact';
import { listProjectFiles, type FileEntry } from '../api';

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

/**
 * ReviewPathPicker — a "Browse" workspace file tree beside the Reviews composer
 * path field. Opening the popover lists the workspace root lazily; folders
 * load their children on expand via listProjectFiles(slug, dir). Picking a
 * file only PREFILLS the composer's text field — the backend re-validates the
 * path on submit (normalizeReviewPath), so this never becomes the trust model.
 * Closes on Escape, an outside mousedown (moreOpen pattern) or a file pick.
 */
export function ReviewPathPicker({
  slug,
  onPick,
}: {
  slug: string;
  onPick: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [dirs, setDirs] = useState<Record<string, FileEntry[]>>({});
  const [openDirs, setOpenDirs] = useState<Set<string>>(new Set());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [dirErrors, setDirErrors] = useState<Record<string, string>>({});
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  const close = () => setOpen(false);

  // Outside mousedown + Escape (+ focus the first row whenever the list lands).
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Load the workspace root on first open (fresh per mount — the ReviewsPanel
  // remounts with its tab key, so a reopened panel always sees the live tree).
  useEffect(() => {
    if (!open || entries !== null || loading) return;
    setError('');
    setLoading(true);
    listProjectFiles(slug)
      .then((l) => setEntries(l.entries))
      .catch((err: any) => setError(err.message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Focus the first row once the root listing lands so Enter/Arrows are live.
  useEffect(() => {
    if (!open) return;
    const first = popRef.current?.querySelector<HTMLElement>('button[data-row]');
    first?.focus();
  }, [open, entries]);

  const toggleDir = (dirPath: string) => {
    if (openDirs.has(dirPath)) {
      setOpenDirs((prev) => {
        const next = new Set(prev);
        next.delete(dirPath);
        return next;
      });
      return;
    }
    if (dirs[dirPath] !== undefined) {
      setOpenDirs((prev) => new Set(prev).add(dirPath));
      return;
    }
    setLoadingDirs((prev) => new Set(prev).add(dirPath));
    listProjectFiles(slug, dirPath)
      .then((l) => {
        setDirs((m) => ({ ...m, [dirPath]: l.entries }));
        setOpenDirs((prev) => new Set(prev).add(dirPath));
        setDirErrors((m) => {
          const next = { ...m };
          delete next[dirPath];
          return next;
        });
      })
      .catch((err: any) => setDirErrors((m) => ({ ...m, [dirPath]: err.message })))
      .finally(() =>
        setLoadingDirs((prev) => {
          const next = new Set(prev);
          next.delete(dirPath);
          return next;
        }),
      );
  };

  const retryRoot = () => {
    setError('');
    setLoading(true);
    listProjectFiles(slug)
      .then((l) => setEntries(l.entries))
      .catch((err: any) => setError(err.message))
      .finally(() => setLoading(false));
  };

  const retryDir = (dirPath: string) => {
    setDirErrors((m) => {
      const next = { ...m };
      delete next[dirPath];
      return next;
    });
    setDirs((m) => {
      const next = { ...m };
      delete next[dirPath];
      return next;
    });
    toggleDir(dirPath);
  };

  const pick = (path: string) => {
    close();
    onPick(path);
  };

  // Roving arrow navigation over the rendered rows (buttons carry data-row).
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const rows = Array.from(popRef.current?.querySelectorAll<HTMLElement>('button[data-row]') || []);
      if (rows.length === 0) return;
      const idx = rows.indexOf(document.activeElement as HTMLElement);
      const next = e.key === 'ArrowDown' ? (idx + 1) % rows.length : (idx <= 0 ? rows.length - 1 : idx - 1);
      rows[Math.max(0, next)]?.focus();
      return;
    }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const el = document.activeElement as HTMLElement | null;
      const dir = el?.dataset?.dir;
      if (dir === undefined) return;
      const isOpen = openDirs.has(dir);
      if ((e.key === 'ArrowRight' && !isOpen) || (e.key === 'ArrowLeft' && isOpen)) {
        e.preventDefault();
        toggleDir(dir);
      }
    }
  };

  const rowStyle = (depth: number) =>
    `display:flex;align-items:center;gap:6px;width:100%;min-height:36px;box-sizing:border-box;justify-content:flex-start;text-align:left;padding:6px 8px 6px ${8 + depth * 14}px;border:none;background:transparent;border-radius:6px;font-size:0.74rem;font-weight:500;color:var(--text-2)`;

  const renderRows = (list: FileEntry[], parent: string, depth: number) =>
    list.map((e) => {
      const full = joinPath(parent, e.path);
      if (e.type === 'dir') {
        const isOpen = openDirs.has(full);
        const kids = dirs[full];
        const loadingKids = loadingDirs.has(full);
        const dirErr = dirErrors[full];
        return (
          <li key={full} style="list-style:none">
            <button
              type="button"
              data-row="true"
              data-dir={full}
              class="btn-ghost sm"
              style={rowStyle(depth)}
              aria-expanded={isOpen}
              onClick={() => toggleDir(full)}
            >
              {isOpen ? (
                <ChevronDown width={13} height={13} class="icon" style="flex:none;color:var(--text-3)" />
              ) : (
                <ChevronRight width={13} height={13} class="icon" style="flex:none;color:var(--text-3)" />
              )}
              <Folder width={13} height={13} class="icon" style="flex:none;color:var(--blue)" />
              <span class="mono" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{e.path}</span>
              {loadingKids && <Loader2 width={12} height={12} class="icon spin" style="flex:none;color:var(--text-3)" />}
            </button>
            {isOpen && (
              <ul role="list" style="list-style:none;margin:2px 0;padding:0">
                {loadingKids ? (
                  <li style="display:flex;align-items:center;gap:6px;min-height:28px;padding:4px 8px 4px 22px;font-size:0.7rem;color:var(--text-3)">
                    <Loader2 width={11} height={11} class="icon spin" /> Loading…
                  </li>
                ) : dirErr ? (
                  <li
                    role="alert"
                    style="display:flex;align-items:center;gap:6px;min-height:32px;padding:4px 8px 4px 22px;font-size:0.68rem;color:#fecaca"
                  >
                    <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{dirErr}</span>
                    <button class="btn-ghost sm" onClick={() => retryDir(full)} aria-label={`Retry loading ${full}`}>
                      <RotateCcw width={11} height={11} class="icon" /> Retry
                    </button>
                  </li>
                ) : kids === undefined ? null : kids.length === 0 ? (
                  <li style="padding:4px 8px 6px 22px;font-size:0.68rem;color:var(--text-3)">Empty directory</li>
                ) : (
                  renderRows(kids, full, depth + 1)
                )}
              </ul>
            )}
          </li>
        );
      }
      return (
        <li key={full} style="list-style:none">
          <button
            type="button"
            data-row="true"
            data-file={full}
            class="btn-ghost sm"
            style={rowStyle(depth)}
            onClick={() => pick(full)}
            title={full}
          >
            <FileText width={13} height={13} class="icon" style="flex:none;color:var(--text-3)" />
            <span class="mono" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{e.path}</span>
            <span style="flex:none;font-size:0.62rem;font-weight:700;color:var(--green)">Use</span>
          </button>
        </li>
      );
    });

  return (
    <span ref={wrapRef} style="position:relative;display:inline-flex;flex-shrink:0">
      <button
        type="button"
        class="btn-ghost sm"
        aria-label="Browse workspace files"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls="review-path-picker-list"
        onClick={() => setOpen((o) => !o)}
        title="Browse workspace files"
      >
        <FolderOpen width={13} height={13} class="icon" />
        <span style="font-size:0.75rem">Browse</span>
      </button>

      {open && (
        <div
          id="review-path-picker-list"
          role="listbox"
          aria-label="Browse workspace files"
          ref={popRef}
          onKeyDown={onKeyDown}
          style="position:absolute;top:calc(100% + 6px);right:0;z-index:40;min-width:300px;max-width:min(420px,calc(100vw - 24px));box-sizing:border-box;max-height:min(360px,calc(100vh - 160px));overflow-y:auto;background:var(--panel-2);border:1px solid var(--border-2);border-radius:10px;box-shadow:0 10px 28px rgba(0,0,0,0.4);padding:6px"
        >
          <div style="display:flex;align-items:center;gap:6px;padding:4px 8px 6px">
            <span style="font-size:0.62rem;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;color:var(--text-3)">Workspace</span>
            <span style="flex:1" />
            <span style="font-size:0.62rem;color:var(--text-3)">Escape to close</span>
          </div>

          {loading && entries === null ? (
            <div role="status" style="display:flex;align-items:center;gap:8px;padding:10px 8px;font-size:0.74rem;color:var(--text-2)">
              <Loader2 width={13} height={13} class="icon spin" /> Loading workspace files…
            </div>
          ) : error ? (
            <div role="alert" style="display:flex;align-items:center;gap:8px;padding:8px;font-size:0.72rem;color:#fecaca;background:#7f1d1d;border-radius:8px;margin:2px">
              <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{error}</span>
              <button class="btn-ghost sm" onClick={retryRoot} aria-label="Retry loading workspace files">
                <RotateCcw width={11} height={11} class="icon" /> Retry
              </button>
            </div>
          ) : entries !== null && entries.length === 0 ? (
            <div role="status" style="padding:10px 8px;font-size:0.72rem;color:var(--text-3)">
              No files in the workspace yet — type the path manually.
            </div>
          ) : entries !== null ? (
            <ul role="list" style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column">
              {renderRows(entries, '', 0)}
            </ul>
          ) : null}
        </div>
      )}
    </span>
  );
}