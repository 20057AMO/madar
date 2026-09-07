import { useState, useEffect, useMemo } from 'preact/hooks';
import { ArrowLeft, Search } from 'lucide-preact';
import { useHashLocation } from 'wouter/use-hash-location';
import { listProjects, type Project } from '../api';
import { ProjectTerminal } from '../components/ProjectTerminal';

const LS_LAST = 'wsd.terminals.lastProject';

export function Terminals({ params }: { params: { slug?: string } }) {
  const slug = params?.slug;
  const [, setLocation] = useHashLocation();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(slug || localStorage.getItem(LS_LAST) || null);

  useEffect(() => {
    const load = () =>
      listProjects()
        .then((r) => setProjects(r.projects || []))
        .catch(() => {})
        .finally(() => setLoading(false));
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (selected) localStorage.setItem(LS_LAST, selected);
  }, [selected]);

  // If the requested slug from the route doesn't exist (deleted project), clear.
  useEffect(() => {
    if (!loading && slug && !projects.some((p) => p.slug === slug)) {
      setLocation('/terminals');
    }
  }, [loading, slug, projects]);

  // A deep-link like /terminals/<slug> must select that project even when
  // this component stays mounted (e.g. navigating from /terminals to
  // /terminals/<slug> — useState(slug) only reads the initial value).
  useEffect(() => {
    if (slug) setSelected(slug);
  }, [slug]);

  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      q
        ? projects.filter(
            (p) => p.name.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q),
          )
        : projects,
    [projects, q],
  );

  const statusColor = (s: string) =>
    s === 'running' ? 'var(--ok,#4ade80)' : s === 'exited' || s === 'stopped' ? '#f87171' : '#d29922';

  return (
    <div class="app-view terminals-page" style="display:flex;flex-direction:column">
      <div class="opencode-toolbar">
        <button class="btn-ghost sm" onClick={() => setLocation('/')}>
          <ArrowLeft width={13} height={13} class="icon" /> Dashboard
        </button>
        <h1 style="font-weight:600;font-size:0.9rem;margin:0;margin-left:8px">Terminals</h1>
        <span style="flex:1" />
      </div>

      <div class="terms-split" style="flex:1;display:flex;gap:14px;padding:14px 16px;overflow:hidden;min-height:0">
        {/* Project picker */}
        <div
          class="terms-picker"
          style="width:270px;overflow:auto;border-right:1px solid var(--border,#333);padding-right:10px;display:flex;flex-direction:column;gap:6px"
        >
          <div style="position:relative">
            <Search width={12} height={12} class="icon" style="position:absolute;top:7px;left:8px;opacity:.45" />
            <input
              class="modern-input"
              style="width:100%;font-size:0.72rem;padding:5px 8px 5px 24px;box-sizing:border-box"
              placeholder="Filter projects…"
              value={query}
              onInput={(e: any) => setQuery(e.target.value)}
            />
          </div>
          {loading ? (
            <p style="color:var(--text-3);font-size:0.75rem" role="status">Loading…</p>
          ) : visible.length === 0 ? (
            <p style="color:var(--text-3);font-size:0.75rem" role="status">No projects match.</p>
          ) : (
            visible.map((p) => {
              const active = selected === p.slug;
              return (
                <button
                  type="button"
                  key={p.slug}
                  onClick={() => setSelected(p.slug)}
                  aria-pressed={active}
                  style={`text-align:inherit;width:100%;color:inherit;font:inherit;padding:8px 10px;border-radius:8px;cursor:pointer;border:1px solid ${active ? 'var(--accent,#818cf8)' : 'var(--border,#333)'};background:${active ? 'var(--accent-bg,rgba(99,102,241,.15))' : 'transparent'}`}
                >
                  <div style="display:flex;align-items:center;gap:7px">
                    <span
                      style={`width:8px;height:8px;border-radius:999px;background:${statusColor(p.status)};flex:none`}
                      title={p.status}
                      aria-hidden="true"
                    />
                    <strong style="font-size:0.78rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                      {p.name}
                    </strong>
                  </div>
                  <div class="mono" style="font-size:0.66rem;color:var(--text-3);margin-top:2px">
                    {p.slug} · {p.status}
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* Terminal area */}
        <div style="flex:1;min-width:0;display:flex;flex-direction:column">
          {selected && projects.some((p) => p.slug === selected) ? (
            <ProjectTerminal key={selected} slug={selected} />
          ) : (
            <div class="empty-state" style="margin:auto;text-align:center">
              <p style="color:var(--text-3);font-size:0.82rem">
                Select a project to open its terminal — project and control shells,
                tabs, command history and quick commands all work here for every project.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
