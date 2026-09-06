import { useState, useEffect } from 'preact/hooks';
import { Camera, Download, History, Trash2, Archive } from 'lucide-preact';
import { useHashLocation } from 'wouter/use-hash-location';
import {
  getProjectSnapshots,
  getSnapshotSchedule,
  setSnapshotSchedule,
  captureSnapshotNow,
  deleteStoredSnapshot,
  restoreStoredSnapshot,
  downloadStoredSnapshot,
  type SnapshotEntry,
  type SnapshotSchedule,
} from '../api';
import { ConfirmModal } from './ConfirmModal';

const INTERVAL_OPTIONS = [
  { value: 60, label: 'Every hour' },
  { value: 180, label: 'Every 3 hours' },
  { value: 360, label: 'Every 6 hours' },
  { value: 720, label: 'Every 12 hours' },
  { value: 1440, label: 'Every day' },
  { value: 10080, label: 'Every week' },
];
const KEEP_OPTIONS = [1, 2, 3, 5, 10, 20];

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function SnapshotsPanel({ slug }: { slug: string }) {
  const [, setLocation] = useHashLocation();
  const [snapshots, setSnapshots] = useState<SnapshotEntry[]>([]);
  const [schedule, setSchedule] = useState<SnapshotSchedule | null>(null);
  const [loading, setLoading] = useState(true);
  const [capturing, setCapturing] = useState(false);
  const [savingCfg, setSavingCfg] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<SnapshotEntry | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<SnapshotEntry | null>(null);
  const [working, setWorking] = useState(false);

  const refresh = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [list, cfg] = await Promise.all([
        getProjectSnapshots(slug),
        getSnapshotSchedule(slug),
      ]);
      setSnapshots(list.snapshots || []);
      setSchedule(cfg);
      setError('');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  const toggleEnabled = async (enabled: boolean) => {
    setSavingCfg(true);
    try {
      const cfg = await setSnapshotSchedule(slug, { enabled });
      setSchedule(cfg);
      setError('');
      if (enabled) {
        setNotice('Snapshot automation enabled — the first copy is being captured…');
        setTimeout(() => refresh(true), 5000);
      } else {
        setNotice('Snapshot automation paused.');
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSavingCfg(false);
    }
  };

  const saveConfig = async () => {
    if (!schedule) return;
    setSavingCfg(true);
    try {
      const cfg = await setSnapshotSchedule(slug, {
        intervalMin: schedule.intervalMin,
        keep: schedule.keep,
      });
      setSchedule(cfg);
      setNotice('Schedule saved.');
      setError('');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSavingCfg(false);
    }
  };

  const captureNow = async () => {
    setCapturing(true);
    try {
      await captureSnapshotNow(slug);
      setNotice('Snapshot captured.');
      setError('');
      await refresh(true);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setCapturing(false);
    }
  };

  const download = async (s: SnapshotEntry) => {
    try {
      const { blob, filename } = await downloadStoredSnapshot(slug, s.file);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const doDelete = async () => {
    if (!confirmDelete) return;
    setWorking(true);
    try {
      await deleteStoredSnapshot(slug, confirmDelete.file);
      setConfirmDelete(null);
      setError('');
      setNotice('Snapshot deleted.');
      await refresh(true);
    } catch (e: any) {
      setError(e.message);
      setConfirmDelete(null);
    } finally {
      setWorking(false);
    }
  };

  const doRestore = async () => {
    if (!confirmRestore) return;
    setWorking(true);
    try {
      const { project } = await restoreStoredSnapshot(slug, confirmRestore.file);
      setConfirmRestore(null);
      setNotice(`Restored as '${project.slug}' — opening it…`);
      setTimeout(() => setLocation(`/project/${project.slug}`), 1200);
    } catch (e: any) {
      setError(e.message);
      setConfirmRestore(null);
      setWorking(false);
    }
  };

  return (
    <div style="max-width:720px;margin:0 auto;padding:14px 16px;display:flex;flex-direction:column;gap:12px">
      {/* Schedule card */}
      <div style="background:rgba(255,255,255,.03);border:1px solid var(--border,#333);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:10px">
        <label class="agent-settings-toggle" style="cursor:pointer">
          <input
            type="checkbox"
            checked={!!schedule?.enabled}
            disabled={savingCfg}
            onChange={(e: any) => toggleEnabled(e.target.checked)}
          />
          <span class="agent-settings-toggle-text">
            <span class="agent-settings-toggle-label">Automatic snapshots</span>
            <span class="agent-settings-toggle-desc">
              Copy the workspace + notes + config to the server on a schedule
            </span>
          </span>
        </label>

        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
          <label style="display:flex;flex-direction:column;gap:4px;font-size:0.7rem;color:var(--text-3)">
            Frequency
            <select
              class="modern-input"
              style="min-width:140px"
              value={schedule?.intervalMin ?? 1440}
              disabled={!schedule?.enabled}
              onChange={(e: any) =>
                setSchedule((s) => (s ? { ...s, intervalMin: Number(e.target.value) } : s))
              }
            >
              {INTERVAL_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <label style="display:flex;flex-direction:column;gap:4px;font-size:0.7rem;color:var(--text-3)">
            Keep
            <select
              class="modern-input"
              style="min-width:80px"
              value={schedule?.keep ?? 5}
              disabled={!schedule?.enabled}
              onChange={(e: any) =>
                setSchedule((s) => (s ? { ...s, keep: Number(e.target.value) } : s))
              }
            >
              {KEEP_OPTIONS.map((k) => (
                <option key={k} value={k}>{k} {k === 1 ? 'copy' : 'copies'}</option>
              ))}
            </select>
          </label>
          {schedule?.enabled && (
            <span style="flex:1;min-width:120px;font-size:0.7rem;color:var(--text-3);padding-bottom:4px">
              Last snapshot: {schedule.lastSnapshotAt ? new Date(schedule.lastSnapshotAt).toLocaleString() : 'none yet'}
            </span>
          )}
          <button
            class="btn-ghost sm"
            style="margin-left:auto"
            onClick={saveConfig}
            disabled={!schedule?.enabled || savingCfg}
          >
            {savingCfg ? 'Saving…' : 'Save'}
          </button>
        </div>

        <button class="btn-primary sm" onClick={captureNow} disabled={capturing}>
          <Camera width={13} height={13} class="icon" /> {capturing ? 'Capturing…' : 'Capture now'}
        </button>

        {error && (
          <div style="font-size:0.72rem;color:#fecaca;background:#7f1d1d;border-radius:8px;padding:6px 10px" role="alert">
            {error}
          </div>
        )}
        {notice && (
          <div style="font-size:0.72rem;color:#d1fae5;background:#064e3b;border-radius:8px;padding:6px 10px" role="status">
            {notice}
          </div>
        )}
      </div>

      {/* Stored versions */}
      <h2 class="panel-title" style="display:flex;align-items:center;gap:6px;margin:0">
        <Archive width={13} height={13} class="icon" /> Stored versions
        <span style="flex:1" />
        {snapshots.length > 0 && (
          <span style="font-size:0.68rem;color:var(--text-3)">{snapshots.length} stored</span>
        )}
      </h2>

      {loading ? (
        <p style="color:var(--text-3);font-size:0.78rem" role="status">Loading snapshots…</p>
      ) : snapshots.length === 0 ? (
        <div class="empty-state" style="text-align:center;padding:28px 0" role="status">
          <div class="big-icon"><Archive width={30} height={30} class="icon" /></div>
          <p style="color:var(--text-3);font-size:0.78rem;margin:8px 0 0">
            No snapshots stored yet — capture one with the button above, or enable
            automatic snapshots and Madar will keep copies here for you.
          </p>
        </div>
      ) : (
        snapshots.map((s) => (
          <div
            key={s.file}
            class="snapshot-row"
            style="display:flex;gap:10px;align-items:center;background:rgba(255,255,255,.03);border:1px solid var(--border,#333);border-radius:12px;padding:10px 12px"
          >
            <History width={15} height={15} class="icon" style="flex:none;opacity:.6" />
            <div style="flex:1;min-width:0">
              <div style="font-size:0.78rem;word-break:break-all">{s.file}</div>
              <div style="display:flex;gap:8px;margin-top:2px">
                <span style="font-size:0.64rem;color:var(--text-3)">{new Date(s.at).toLocaleString()}</span>
                <span style="font-size:0.64rem;color:var(--text-3)">{fmtSize(s.size)}</span>
              </div>
            </div>
            <button class="btn-ghost sm" title="Download" aria-label={`Download ${s.file} (${fmtSize(s.size)})`} onClick={() => download(s)}>
              <Download width={13} height={13} class="icon" />
            </button>
            <button class="btn-ghost sm" title="Restore as a new project" aria-label={`Restore ${s.file} as a new project`} onClick={() => setConfirmRestore(s)}>
              <History width={13} height={13} class="icon" /> Restore
            </button>
            <button class="btn-ghost sm danger-icon" title="Delete snapshot" aria-label={`Delete snapshot ${s.file}`} onClick={() => setConfirmDelete(s)}>
              <Trash2 width={13} height={13} class="icon" />
            </button>
          </div>
        ))
      )}

      <ConfirmModal
        open={!!confirmDelete}
        danger
        title={`Delete snapshot '${confirmDelete?.file ?? ''}'?`}
        message="The stored archive is removed from the server. This cannot be undone."
        confirmLabel="Delete"
        loading={working}
        onConfirm={doDelete}
        onCancel={() => setConfirmDelete(null)}
      />
      <ConfirmModal
        open={!!confirmRestore}
        danger={false}
        title={`Restore '${confirmRestore?.file ?? ''}'?`}
        message="A brand-new project is created from this snapshot. Existing projects are never overwritten."
        confirmLabel="Restore as new project"
        loading={working}
        onConfirm={doRestore}
        onCancel={() => setConfirmRestore(null)}
      />
    </div>
  );
}