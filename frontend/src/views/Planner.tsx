import { useEffect, useMemo, useState } from 'preact/hooks';
import { useHashLocation } from 'wouter/use-hash-location';
import { ArrowUpRight, LayoutGrid } from 'lucide-preact';
import { listProjects } from '../api';
import type { Project } from '../api';
import { CrashBadge } from '../components/CrashBadge';
import { fmtCpu, fmtMem } from '../lib/limits';
import { relTime } from '../lib/time';

/**
 * Planner — a visual overview of every project and its planning canvas.
 * Each card links straight into that project's Canvas tab; cards carry a
 * live status dot and the last canvas edit time so the freshest boards float
 * to the top.
 */

export function Planner() {
  const [, setLocation] = useHashLocation();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'recent' | 'alpha'>('recent');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listProjects()
      .then(({ projects: list }) => {
        if (!cancelled) setProjects(list);
      })
      .catch((err: any) => {
        if (!cancelled) setError(err.message || 'Failed to load projects');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const visible = useMemo(() => {
    let list = projects || [];
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.slug.toLowerCase().includes(q) ||
          (p.description || '').toLowerCase().includes(q)
      );
    }
    const sorted = [...list];
    if (sort === 'recent') {
      sorted.sort((a, b) => {
        const at = new Date(a.canvasEditedAt || a.createdAt || 0).getTime();
        const bt = new Date(b.canvasEditedAt || b.createdAt || 0).getTime();
        return bt - at;
      });
    } else {
      sorted.sort((a, b) => a.name.localeCompare(b.name));
    }
    return sorted;
  }, [projects, query, sort]);

  return (
    <div class="view">
      <div class="proj-header">
        <div>
          <h1 class="hero-title" style="font-size:1.5rem">Planner</h1>
          <p class="hero-sub" style="margin:0">Visual planning for every project — open a board and arrange sticky notes, tasks and arrows.</p>
        </div>
      </div>

      <div class="proj-toolbar planner-tools">
        <div class="proj-search-row">
          <input
            class="modern-input proj-search"
            placeholder="Filter projects by name, slug or description…"
            value={query}
            onInput={(e: any) => setQuery(e.currentTarget.value)}
          />
          <select class="modern-input chat-sel" value={sort} onChange={(e: any) => setSort(e.currentTarget.value as 'recent' | 'alpha')}>
            <option value="recent">Recently edited</option>
            <option value="alpha">Name (A–Z)</option>
          </select>
        </div>
      </div>

      {error ? (
        <div class="panel" style="margin-top: 16px">
          <div class="empty-state">
            <div style="color: var(--danger); margin-bottom: 8px" role="alert">Could not load projects</div>
            <div class="dim">{error}</div>
          </div>
        </div>
      ) : projects === null ? (
        <div class="panel" style="margin-top: 16px">
          <div class="empty-state">
            <div class="big">…</div>
            <div class="dim" role="status">Loading projects…</div>
          </div>
        </div>
      ) : visible.length === 0 ? (
        <div class="panel" style="margin-top: 16px">
          <div class="empty-state">
            <div class="big">
              <LayoutGrid width={28} height={28} style="margin: 0 auto" />
            </div>
            <div class="dim">{query ? 'No projects match that search.' : 'No projects yet — create one and its planning canvas will appear here.'}</div>
            {!query && (
              <button class="btn-ghost sm" style="margin-top: 12px" onClick={() => setLocation('/projects')}>
                Go to Projects
              </button>
            )}
          </div>
        </div>
      ) : (
        <div class="projects-grid planner-grid">
          {visible.map((p) => {
            const edited = relTime(p.canvasEditedAt);
const handleCardKeyDown = (path: string) => (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setLocation(path); }
  };

  return (
              <div
                class="project-card planner-card"
                key={p.slug}
                role="button"
                tabIndex={0}
                onClick={() => setLocation(`/project/${p.slug}?tab=canvas`)}
                onKeyDown={handleCardKeyDown(`/project/${p.slug}?tab=canvas`)}
              >
                <div class="project-card-header">
                  <h3>{p.name}</h3>
                  <span class={`status-badge ${p.status}`}>{p.status}</span>
                  {p.crash && <CrashBadge crash={p.crash} />}
                </div>
                <div class="project-desc">{p.description || `Workspace ${p.slug}`}</div>
                <div class="project-meta">
                  {p.hostPorts && Object.keys(p.hostPorts).length > 0
                    ? Object.entries(p.hostPorts).map(([priv, pub]) => (
                      <span class="meta-chip port" key={priv}>:{pub}</span>
                    ))
                    : p.ports && p.ports.length > 0
                      ? p.ports.map(port => (
                        <span class="meta-chip port" key={String(port)}>:{port}</span>
                      ))
                      : <span class="meta-chip">{p.slug}</span>
                  }
                  {p.limits?.cpu && <span class="meta-chip" title="CPU limit">{fmtCpu(p.limits.cpu)}</span>}
                  {p.limits?.memory && <span class="meta-chip" title="Memory limit">RAM {fmtMem(p.limits.memory)}</span>}
                </div>
                <div class="card-footer planner-footer">
                  <span class={`plan-edit ${edited ? '' : 'plan-new'}`}>
                    {edited ? `Canvas edited ${edited} ago` : 'Canvas not started'}
                  </span>
                  <button class="btn-ghost sm" onClick={(e) => { e.stopPropagation(); setLocation(`/project/${p.slug}?tab=canvas`); }}>
                    Open board <ArrowUpRight width={13} height={13} class="icon" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}