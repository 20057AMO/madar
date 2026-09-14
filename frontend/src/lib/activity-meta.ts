/**
 * activity-meta.ts
 * Madar — Presentation metadata for the project activity feed.
 * Maps every server action to an icon, a human label, a dot/icon color
 * class and a `fmtDetail` that renders the action payload as secondary text.
 */
import {
  FolderPlus,
  RefreshCw,
  Copy,
  Upload,
  History,
  Trash2,
  Play,
  Square,
  GitBranch,
  Settings,
  Variable,
  Tags,
  Network,
  Gauge,
  Save,
  PenTool,
  UserPlus,
  UserMinus,
  UserCog,
  Crown,
  Camera,
  CalendarClock,
  Download,
  Globe,
  TriangleAlert,
  Check,
  Activity,
  MessageSquare,
  MessageCircle,
  CircleCheck,
  RotateCcw,
} from 'lucide-preact';
import type { ActivityDetails } from '../api';

export interface ActivityMeta {
  Icon: any;
  /** Human label, e.g. "Member added". */
  label: string;
  /** CSS class suffix used by `.activity-dot.<dotClass>` / `.activity-ico.<dotClass>`. */
  dotClass: string;
  /** Formats the action payload (`details`) as a secondary mono line. */
  fmtDetail: (details: ActivityDetails) => string;
}

/** Humanize a raw/snake_case action into a readable title (fallback). */
function humanize(action: string): string {
  return action.charAt(0).toUpperCase() + action.slice(1).replace(/_+/g, ' ');
}

/** Generic details formatter: skips id-style noise keys and empty values. */
function fmtPairs(details: ActivityDetails): string[] {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(details || {})) {
    if (v === undefined || v === null || v === '') continue;
    if (k === 'id' || /Id$/.test(k)) continue; // targetUserId etc → noise
    parts.push(Array.isArray(v) ? `${k}: ${v.join(', ')}` : `${k}: ${String(v)}`);
  }
  return parts;
}

const fmtGeneric = (details: ActivityDetails): string => fmtPairs(details).join(' · ');

/** All 33 server actions. */
const META: Record<string, ActivityMeta> = {
  // ── Lifecycle ──
  created: { Icon: FolderPlus, label: 'Created', dotClass: 'created', fmtDetail: fmtGeneric },
  recreated: { Icon: RefreshCw, label: 'Recreated', dotClass: 'recreated', fmtDetail: fmtGeneric },
  duplicated: { Icon: Copy, label: 'Duplicated', dotClass: 'duplicated', fmtDetail: fmtGeneric },
  imported: { Icon: Upload, label: 'Imported', dotClass: 'imported', fmtDetail: fmtGeneric },
  restored: { Icon: History, label: 'Restored', dotClass: 'restored', fmtDetail: fmtGeneric },
  deleted: { Icon: Trash2, label: 'Deleted', dotClass: 'deleted', fmtDetail: fmtGeneric },
  started: { Icon: Play, label: 'Started', dotClass: 'started', fmtDetail: fmtGeneric },
  stopped: { Icon: Square, label: 'Stopped', dotClass: 'stopped', fmtDetail: fmtGeneric },
  cloned: { Icon: GitBranch, label: 'Git cloned', dotClass: 'cloned', fmtDetail: fmtGeneric },
  // ── Setup ──
  updated: { Icon: Settings, label: 'Updated', dotClass: 'updated', fmtDetail: fmtGeneric },
  env_updated: { Icon: Variable, label: 'Env updated', dotClass: 'env_updated', fmtDetail: fmtGeneric },
  tags_updated: { Icon: Tags, label: 'Tags updated', dotClass: 'tags_updated', fmtDetail: fmtGeneric },
  ports_updated: { Icon: Network, label: 'Ports updated', dotClass: 'ports_updated', fmtDetail: fmtGeneric },
  limits_updated: { Icon: Gauge, label: 'Limits updated', dotClass: 'limits_updated', fmtDetail: fmtGeneric },
  // ── Content ──
  notes_saved: { Icon: Save, label: 'Notes saved', dotClass: 'notes_saved', fmtDetail: fmtGeneric },
  canvas_saved: { Icon: PenTool, label: 'Canvas saved', dotClass: 'canvas_saved', fmtDetail: fmtGeneric },
  // ── Team ──
  member_added: { Icon: UserPlus, label: 'Member added', dotClass: 'member_added', fmtDetail: fmtGeneric },
  member_removed: { Icon: UserMinus, label: 'Member removed', dotClass: 'member_removed', fmtDetail: fmtGeneric },
  member_role_changed: {
    Icon: UserCog,
    label: 'Role changed',
    dotClass: 'member_role_changed',
    fmtDetail: fmtGeneric,
  },
  ownership_transferred: {
    Icon: Crown,
    label: 'Ownership transferred',
    dotClass: 'ownership_transferred',
    fmtDetail: fmtGeneric,
  },
  // ── Snapshots ──
  snapshot_captured: {
    Icon: Camera,
    label: 'Snapshot captured',
    dotClass: 'snapshot_captured',
    fmtDetail: fmtGeneric,
  },
  snapshot_deleted: {
    Icon: Trash2,
    label: 'Snapshot deleted',
    dotClass: 'snapshot_deleted',
    fmtDetail: fmtGeneric,
  },
  snapshot_config: {
    Icon: CalendarClock,
    label: 'Snapshot schedule changed',
    dotClass: 'snapshot_config',
    fmtDetail: fmtGeneric,
  },
  exported: { Icon: Download, label: 'Exported', dotClass: 'exported', fmtDetail: fmtGeneric },
  // ── Serve ──
  serve_started: { Icon: Globe, label: 'Serve started', dotClass: 'serve_started', fmtDetail: fmtGeneric },
  serve_stopped: { Icon: Globe, label: 'Serve stopped', dotClass: 'serve_stopped', fmtDetail: fmtGeneric },
  // ── Crash ──
  crashed: { Icon: TriangleAlert, label: 'Crashed', dotClass: 'crashed', fmtDetail: fmtGeneric },
  crash_cleared: {
    Icon: Check,
    label: 'Crash cleared',
    dotClass: 'crash_cleared',
    fmtDetail: fmtGeneric,
  },
  // ── File reviews ──
  review_opened: {
    Icon: MessageSquare,
    label: 'Review opened',
    dotClass: 'review_opened',
    fmtDetail: fmtGeneric,
  },
  review_commented: {
    Icon: MessageCircle,
    label: 'Review commented',
    dotClass: 'review_commented',
    fmtDetail: fmtGeneric,
  },
  review_resolved: {
    Icon: CircleCheck,
    label: 'Review resolved',
    dotClass: 'review_resolved',
    fmtDetail: fmtGeneric,
  },
  review_reopened: {
    Icon: RotateCcw,
    label: 'Review reopened',
    dotClass: 'review_reopened',
    fmtDetail: fmtGeneric,
  },
  review_deleted: {
    Icon: Trash2,
    label: 'Review deleted',
    dotClass: 'review_deleted',
    fmtDetail: fmtGeneric,
  },
};

/** Presentation metadata for an action (unknown actions get a neutral fallback). */
export function activityMeta(action: string): ActivityMeta {
  return META[action] || {
    Icon: Activity,
    label: humanize(action),
    dotClass: 'unknown',
    fmtDetail: fmtGeneric,
  };
}

/** Human label for an action — shared with the Overview quick list. */
export function fmtAction(action: string): string {
  return META[action] ? META[action].label : humanize(action);
}