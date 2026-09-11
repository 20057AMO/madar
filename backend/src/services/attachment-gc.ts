/**
 * attachment-gc.ts
 * Pure filesystem logic for orphaned-attachment garbage collection — NO service
 * imports so it can be unit-tested directly under node --test (same pattern as
 * janitor-core/alerts-core/snapshots-schedule).
 */
import fs from 'fs';
import path from 'path';

/**
 * Collect every attachment id referenced by any message in the messages dir.
 * Corrupt / missing files are silently skipped.
 */
export function collectReferencedIds(messagesDir: string): Set<string> {
  const ids = new Set<string>();
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(messagesDir);
  } catch { return ids; }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(messagesDir, entry), 'utf8'));
      if (!Array.isArray(raw)) continue;
      for (const msg of raw) {
        if (Array.isArray(msg.attachments)) {
          for (const a of msg.attachments) {
            if (a && typeof a.id === 'string') ids.add(a.id);
          }
        }
      }
    } catch { /* corrupt file — skip */ }
  }
  return ids;
}

/**
 * Return upload filenames that are NOT in `referencedIds` and whose mtime is
 * older than `maxAgeMs` relative to now.
 */
export function findUnreferencedUploads(
  uploadsDir: string,
  referencedIds: Set<string>,
  maxAgeMs: number,
): string[] {
  const stale: string[] = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(uploadsDir);
  } catch { return stale; }
  const cutoff = Date.now() - maxAgeMs;
  for (const entry of entries) {
    if (!/^att-[a-z0-9-]+$/.test(entry)) continue;
    if (referencedIds.has(entry)) continue;
    try {
      const st = fs.statSync(path.join(uploadsDir, entry));
      if (st.isFile() && st.mtimeMs < cutoff) stale.push(entry);
    } catch { /* unreadable — skip */ }
  }
  return stale;
}

/**
 * Delete unreferenced uploads older than `maxAgeMs`. Returns the number of
 * files removed.
 */
export function pruneUnreferenced(
  messagesDir: string,
  uploadsDir: string,
  maxAgeMs: number,
): number {
  const referenced = collectReferencedIds(messagesDir);
  const targets = findUnreferencedUploads(uploadsDir, referenced, maxAgeMs);
  let pruned = 0;
  for (const name of targets) {
    try {
      fs.rmSync(path.join(uploadsDir, name));
      pruned++;
    } catch { /* busy/permission — skip */ }
    try {
      fs.rmSync(path.join(uploadsDir, `${name}.meta.json`));
    } catch { /* best-effort */ }
  }
  return pruned;
}
