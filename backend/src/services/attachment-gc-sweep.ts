/**
 * attachment-gc-sweep.ts
 * Periodic sweep that removes orphaned attachment uploads — files saved to
 * data/chat-team/uploads/ that no message references and that are older than
 * 1 hour. Runs on a timer like the workspace-janitor / alert-sweep pattern.
 */
import path from 'path';
import { pruneUnreferenced } from './attachment-gc';

const DATA_DIR = process.env.WSD_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const CHAT_DIR = path.join(DATA_DIR, 'chat-team');
const MESSAGES_DIR = path.join(CHAT_DIR, 'messages');
const UPLOADS_DIR = path.join(CHAT_DIR, 'uploads');

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
const MIN_INTERVAL_MS = 10_000;
const MAX_AGE_MS = 60 * 60 * 1000;

let running = false;

export function startAttachmentGcSweep(): void {
  const interval = Math.max(
    MIN_INTERVAL_MS,
    parseInt(process.env.WSD_ATTACHMENT_GC_MS || '', 10) || DEFAULT_INTERVAL_MS,
  );

  function sweep() {
    if (running) return;
    running = true;
    try {
      const pruned = pruneUnreferenced(MESSAGES_DIR, UPLOADS_DIR, MAX_AGE_MS);
      if (pruned > 0) console.log(`[Madar] attachment-gc: pruned ${pruned} orphaned upload(s)`);
    } catch (err) {
      console.warn('[Madar] attachment-gc sweep error:', err);
    } finally {
      running = false;
    }
  }

  sweep();
  setInterval(sweep, interval);
}
