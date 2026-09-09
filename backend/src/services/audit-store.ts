/**
 * audit-store.ts
 * Append-only security activity log (data/audit.json).
 * Records auth-sensitive events so the owner can review recent account
 * activity from Settings. Capped at the most recent 100 entries.
 */
import fs from 'fs';
import path from 'path';

import { withFileLock } from './write-queue';

const DATA_DIR = process.env.WSD_DATA_DIR || '/app/data';
const AUDIT_FILE = path.join(DATA_DIR, 'audit.json');
const MAX_ENTRIES = 100;

export type AuditEvent =
  | 'setup'
  | 'login'
  | 'login-failed'
  | 'logout-all'
  | 'logout-all-failed'
  | 'password-change'
  | 'password-change-failed'
  | 'providers-lock-change'
  | 'providers-lock-change-failed'
  | 'providers-unlock'
  | 'providers-unlock-failed'
  | 'providers-unlock-cooldown'
  | 'providers-relock'
  | '2fa-enabled'
  | '2fa-enabled-failed'
  | '2fa-disabled'
  | '2fa-disabled-failed'
  | 'login-2fa-failed'
  | 'backup-export'
  | 'backup-import'
  | 'snapshot-export'
  | 'snapshot-import'
  | 'project-zip'
  | 'snapshot-save'
  | 'snapshot-download'
  | 'snapshot-delete'
  | 'snapshot-restore'
  | 'snapshot-config-change'
  | 'project-tags'
  | 'canvas-save'
  | 'project-ports'
  | 'project-limits'
  | 'serve-start'
  | 'serve-start-failed'
  | 'serve-stop'
  | 'workspace-janitor'
  | 'storage-cleanup'
  | 'archive-delete'
  | 'archive-empty'
  | 'archive-restore'
  | 'project-files-deleted'
  | 'opencode-studio'
  | 'opencode-update'
  | 'opencode-update-failed'
  | 'user-created'
  | 'user-role-changed'
  | 'user-deleted'
  | 'profile-update'
  | 'avatar-upload'
  | 'avatar-remove'
  | 'container-crash'
  | 'webhook-send'
  | 'webhook-send-failed'
  | 'webhook-config-change';

export interface AuditEntry {
  ts: string;
  event: AuditEvent;
  ok: boolean;
  ip?: string;
}

function loadEntries(): AuditEntry[] {
  try {
    if (!fs.existsSync(AUDIT_FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Record an event; failures to persist are non-fatal by design. */
export function recordAudit(event: AuditEvent, ok: boolean, ip?: string): void {
  withFileLock('audit', () => {
    try {
      const entries = loadEntries();
      entries.push({ ts: new Date().toISOString(), event, ok, ...(ip ? { ip } : {}) });
      const trimmed = entries.slice(-MAX_ENTRIES);
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(AUDIT_FILE, JSON.stringify(trimmed, null, 2), { encoding: 'utf8', mode: 0o600 });
    } catch {
      /* auditing must never break the request flow */
    }
  });
}

/** Most recent entries first. */
export function listAudit(limit = 50, offset = 0): { entries: AuditEntry[]; total: number } {
  const all = loadEntries().reverse();
  const total = all.length;
  return { entries: all.slice(offset, offset + Math.min(Math.max(limit, 1), MAX_ENTRIES)), total };
}
