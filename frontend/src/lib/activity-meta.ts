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
  BrainCircuit,
} from 'lucide-preact';
import type { ActivityDetails } from '../api';

export interface ActivityMeta {
  Icon: any;
  /** i18n key under `activity.*` (e.g. `activity.member_added`), or null for the humanize fallback. */
  labelKey: string | null;
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

/** All 33 server actions. Labels resolve through i18n keys under `activity.*`. */
const META: Record<string, ActivityMeta> = {
  // ── Lifecycle ──
  created: { Icon: FolderPlus, labelKey: 'activity.created', dotClass: 'created', fmtDetail: fmtGeneric },
  recreated: { Icon: RefreshCw, labelKey: 'activity.recreated', dotClass: 'recreated', fmtDetail: fmtGeneric },
  duplicated: { Icon: Copy, labelKey: 'activity.duplicated', dotClass: 'duplicated', fmtDetail: fmtGeneric },
  imported: { Icon: Upload, labelKey: 'activity.imported', dotClass: 'imported', fmtDetail: fmtGeneric },
  restored: { Icon: History, labelKey: 'activity.restored', dotClass: 'restored', fmtDetail: fmtGeneric },
  deleted: { Icon: Trash2, labelKey: 'activity.deleted', dotClass: 'deleted', fmtDetail: fmtGeneric },
  started: { Icon: Play, labelKey: 'activity.started', dotClass: 'started', fmtDetail: fmtGeneric },
  stopped: { Icon: Square, labelKey: 'activity.stopped', dotClass: 'stopped', fmtDetail: fmtGeneric },
  cloned: { Icon: GitBranch, labelKey: 'activity.cloned', dotClass: 'cloned', fmtDetail: fmtGeneric },
  // ── Setup ──
  updated: { Icon: Settings, labelKey: 'activity.updated', dotClass: 'updated', fmtDetail: fmtGeneric },
  env_updated: { Icon: Variable, labelKey: 'activity.env_updated', dotClass: 'env_updated', fmtDetail: fmtGeneric },
  tags_updated: { Icon: Tags, labelKey: 'activity.tags_updated', dotClass: 'tags_updated', fmtDetail: fmtGeneric },
  ports_updated: { Icon: Network, labelKey: 'activity.ports_updated', dotClass: 'ports_updated', fmtDetail: fmtGeneric },
  limits_updated: { Icon: Gauge, labelKey: 'activity.limits_updated', dotClass: 'limits_updated', fmtDetail: fmtGeneric },
  // ── Content ──
  notes_saved: { Icon: Save, labelKey: 'activity.notes_saved', dotClass: 'notes_saved', fmtDetail: fmtGeneric },
  canvas_saved: { Icon: PenTool, labelKey: 'activity.canvas_saved', dotClass: 'canvas_saved', fmtDetail: fmtGeneric },
  // ── Team ──
  member_added: { Icon: UserPlus, labelKey: 'activity.member_added', dotClass: 'member_added', fmtDetail: fmtGeneric },
  member_removed: { Icon: UserMinus, labelKey: 'activity.member_removed', dotClass: 'member_removed', fmtDetail: fmtGeneric },
  member_role_changed: {
    Icon: UserCog,
    labelKey: 'activity.member_role_changed',
    dotClass: 'member_role_changed',
    fmtDetail: fmtGeneric,
  },
  ownership_transferred: {
    Icon: Crown,
    labelKey: 'activity.ownership_transferred',
    dotClass: 'ownership_transferred',
    fmtDetail: fmtGeneric,
  },
  // ── Snapshots ──
  snapshot_captured: {
    Icon: Camera,
    labelKey: 'activity.snapshot_captured',
    dotClass: 'snapshot_captured',
    fmtDetail: fmtGeneric,
  },
  snapshot_deleted: {
    Icon: Trash2,
    labelKey: 'activity.snapshot_deleted',
    dotClass: 'snapshot_deleted',
    fmtDetail: fmtGeneric,
  },
  snapshot_config: {
    Icon: CalendarClock,
    labelKey: 'activity.snapshot_config',
    dotClass: 'snapshot_config',
    fmtDetail: fmtGeneric,
  },
  exported: { Icon: Download, labelKey: 'activity.exported', dotClass: 'exported', fmtDetail: fmtGeneric },
  // ── Serve ──
  serve_started: { Icon: Globe, labelKey: 'activity.serve_started', dotClass: 'serve_started', fmtDetail: fmtGeneric },
  serve_stopped: { Icon: Globe, labelKey: 'activity.serve_stopped', dotClass: 'serve_stopped', fmtDetail: fmtGeneric },
  // ── Crash ──
  crashed: { Icon: TriangleAlert, labelKey: 'activity.crashed', dotClass: 'crashed', fmtDetail: fmtGeneric },
  crash_cleared: {
    Icon: Check,
    labelKey: 'activity.crash_cleared',
    dotClass: 'crash_cleared',
    fmtDetail: fmtGeneric,
  },
  // ── File reviews ──
  review_opened: {
    Icon: MessageSquare,
    labelKey: 'activity.review_opened',
    dotClass: 'review_opened',
    fmtDetail: fmtGeneric,
  },
  review_commented: {
    Icon: MessageCircle,
    labelKey: 'activity.review_commented',
    dotClass: 'review_commented',
    fmtDetail: fmtGeneric,
  },
  review_resolved: {
    Icon: CircleCheck,
    labelKey: 'activity.review_resolved',
    dotClass: 'review_resolved',
    fmtDetail: fmtGeneric,
  },
  review_reopened: {
    Icon: RotateCcw,
    labelKey: 'activity.review_reopened',
    dotClass: 'review_reopened',
    fmtDetail: fmtGeneric,
  },
  review_deleted: {
    Icon: Trash2,
    labelKey: 'activity.review_deleted',
    dotClass: 'review_deleted',
    fmtDetail: fmtGeneric,
  },
  // ── Agents ──
  agent_run: { Icon: BrainCircuit, labelKey: 'activity.agent_run', dotClass: 'agent_run', fmtDetail: fmtGeneric },
};

/** Presentation metadata for an action (unknown actions get a neutral fallback). */
export function activityMeta(action: string): ActivityMeta {
  return META[action] || {
    Icon: Activity,
    labelKey: null,
    dotClass: 'unknown',
    fmtDetail: fmtGeneric,
  };
}

/** Localized human label for an action — shared with the Overview quick list. */
export function fmtAction(action: string): string {
  const meta = META[action];
  if (meta && meta.labelKey) return tFn(meta.labelKey);
  return humanize(action);
}

/**
 * Late-bound translator — the i18n module can't be imported at the top of this
 * file (it's a .tsx component module; this is a plain lib module), so consumers
 * (ActivityPanel / Project) inject it once via `setActivityTranslator`.
 */
let tFn = (key: string): string => humanize(key.split('.').pop() || key);
export function setActivityTranslator(t: (key: string) => string): void {
  tFn = t;
}