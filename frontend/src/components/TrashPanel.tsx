import { useState, useEffect, useCallback } from 'preact/hooks';
import { Trash2, RotateCcw, Loader2 } from 'lucide-preact';
import { useHashLocation } from 'wouter/use-hash-location';
import { ConfirmModal } from './ConfirmModal';
import {
  listArchive,
  restoreArchive,
  deleteArchive,
  emptyTrash,
  type ArchivedProject,
} from '../api';
import { fmtBytes } from '../lib/size';
import { useAuth } from '../auth';

interface TrashPanelProps {
  onRestored?: (slug: string) => void;
  onTrashCountChange?: (count: number) => void;
}

export function TrashPanel({ onRestored, onTrashCountChange }: TrashPanelProps) {
  const [, setLocation] = useHashLocation();
  const { user } = useAuth();
  const readOnly = user?.role === 'viewer';

  const [archives, setArchives] = useState<ArchivedProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Empty-trash confirmation
  const [emptyOpen, setEmptyOpen] = useState(false);
  const [emptyBusy, setEmptyBusy] = useState(false);

  // Per-row restore modal
  const [restoreTarget, setRestoreTarget] = useState<ArchivedProject | null>(null);
  const [restoreName, setRestoreName] = useState('');
  const [restorePorts, setRestorePorts] = useState('');
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  // Per-row delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<ArchivedProject | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await listArchive();
      setArchives(res.archives);
      setError(null);
      onTrashCountChange?.(res.archives.length);
    } catch (err: any) {
      setError(err.message || 'Failed to load trash');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // ── Empty trash ───────────────────────────────────────────
  const handleEmpty = async () => {
    if (emptyBusy) return;
    setEmptyBusy(true);
    try {
      await emptyTrash();
      setEmptyOpen(false);
      await load();
    } catch (err: any) {
      setError(err.message || 'Failed to empty trash');
    } finally {
      setEmptyBusy(false);
    }
  };

  // ── Restore ──────────────────────────────────────────────
  const openRestore = (a: ArchivedProject) => {
    setRestoreTarget(a);
    setRestoreName(a.name);
    setRestorePorts('');
    setRestoreError(null);
  };

  const handleRestore = async (e: Event) => {
    e.preventDefault();
    if (!restoreTarget || restoreBusy) return;
    setRestoreBusy(true);
    setRestoreError(null);
    try {
      const parsedPorts = restorePorts
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n > 0 && n <= 65535);
      const body: { name?: string; description?: string; ports?: number[] } = {};
      if (restoreName.trim()) body.name = restoreName.trim();
      if (parsedPorts.length > 0) body.ports = parsedPorts;
      const { project } = await restoreArchive(restoreTarget.entry, body);
      setRestoreTarget(null);
      await load();
      onRestored?.(project.slug);
      setLocation(`/project/${project.slug}`);
    } catch (err: any) {
      setRestoreError(err.message || 'Restore failed');
    } finally {
      setRestoreBusy(false);
    }
  };

  // ── Delete permanently ───────────────────────────────────
  const handleDelete = async () => {
    if (!deleteTarget || deleteBusy) return;
    setDeleteBusy(true);
    try {
      await deleteArchive(deleteTarget.entry);
      setDeleteTarget(null);
      await load();
    } catch (err: any) {
      setError(err.message || 'Failed to delete');
    } finally {
      setDeleteBusy(false);
    }
  };

  // ── Derived ──────────────────────────────────────────────
  const totalBytes = archives.reduce((sum, a) => sum + (a.sizeBytes || 0), 0);

  if (loading) {
    return (
      <div class="dash-loading" role="status">
        <Loader2 width={24} height={24} class="icon spin" /> Loading trash…
      </div>
    );
  }

  return (
    <div>
      {error && <div class="login-error" style="margin-bottom:12px" role="alert">{error}</div>}

      {/* Stats + empty action */}
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px">
        <span class="hero-sub" style="margin:0">
          {archives.length} archived · {fmtBytes(totalBytes)}
        </span>
        {!readOnly && archives.length > 0 && (
          <button class="btn-danger sm" onClick={() => setEmptyOpen(true)}>
            <Trash2 width={13} height={13} class="icon" /> Empty trash
          </button>
        )}
      </div>

      {archives.length === 0 ? (
        <div class="empty-state">
          <div class="big-icon"><Trash2 width={30} height={30} class="icon" /></div>
          Trash is empty — no archived projects.
        </div>
      ) : (
        <div class="proj-table-wrap">
          <table class="proj-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Archived</th>
                <th>Size</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {archives.map((a) => (
                <tr key={a.entry}>
                  <td class="proj-td-name">{a.name}</td>
                  <td>{a.date ? new Date(a.date).toLocaleString() : '—'}</td>
                  <td>
                    {fmtBytes(a.sizeBytes)}
                    {a.truncated && <span class="dim" style="margin-left:4px;font-size:0.7rem">(partial)</span>}
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {!readOnly && (
                      <>
                        <button
                          class="btn-ghost sm"
                          title="Restore this project"
                          onClick={() => openRestore(a)}
                        >
                          <RotateCcw width={12} height={12} class="icon" /> Restore
                        </button>
                        <button
                          class="btn-ghost sm"
                          title="Delete permanently"
                          aria-label={`Delete ${a.name} permanently`}
                          onClick={() => setDeleteTarget(a)}
                        >
                          <Trash2 width={12} height={12} class="icon" />
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Empty-trash confirmation ───────────────────────── */}
      <ConfirmModal
        open={emptyOpen}
        danger
        loading={emptyBusy}
        title="Empty the trash?"
        message={`Permanently delete all ${archives.length} archived project workspace${archives.length !== 1 ? 's' : ''}. This cannot be undone.`}
        confirmLabel="Empty trash"
        onConfirm={handleEmpty}
        onCancel={() => { if (!emptyBusy) setEmptyOpen(false); }}
      />

      {/* ── Restore modal ──────────────────────────────────── */}
      {restoreTarget && (
        <div class="modal-overlay" onMouseDown={(e: any) => { if (e.target === e.currentTarget && !restoreBusy) setRestoreTarget(null); }}>
          <form
            class="create-card modal-dialog"
            style="max-width:440px;width:100%"
            onSubmit={handleRestore}
          >
            <div class="create-title">Restore "{restoreTarget.name}"</div>
            <input
              class="modern-input"
              placeholder="Project name"
              value={restoreName}
              onInput={(e: any) => setRestoreName(e.target.value)}
              autoFocus
            />
            <input
              class="modern-input"
              style="margin-top:10px"
              placeholder="Ports (optional, e.g. 8000,3000)"
              value={restorePorts}
              onInput={(e: any) => setRestorePorts(e.target.value)}
            />
            {restoreError && <div class="login-error" style="margin-top:10px">{restoreError}</div>}
            <div style="display:flex;gap:10px;margin-top:14px;justify-content:flex-end">
              <button type="button" class="btn-ghost sm" onClick={() => setRestoreTarget(null)} disabled={restoreBusy}>Cancel</button>
              <button type="submit" class="btn-primary" disabled={restoreBusy || !restoreName.trim()}>
                {restoreBusy ? (
                  <span style="display:inline-flex;align-items:center;gap:6px;">
                    <Loader2 width={14} height={14} class="icon spin" /> Restoring…
                  </span>
                ) : (
                  <><RotateCcw width={13} height={13} class="icon" /> Restore</>
                )}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ── Delete-permanently confirmation ────────────────── */}
      <ConfirmModal
        open={!!deleteTarget}
        danger
        loading={deleteBusy}
        title={`Delete '${deleteTarget?.name ?? ''}' permanently?`}
        message="The archived workspace and all its files will be removed forever. This cannot be undone."
        confirmLabel="Delete permanently"
        onConfirm={handleDelete}
        onCancel={() => { if (!deleteBusy) setDeleteTarget(null); }}
      />
    </div>
  );
}
