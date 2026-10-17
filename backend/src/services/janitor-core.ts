/**
 * janitor-core.ts
 * Pure filesystem logic for the workspace janitor — NO service imports so it
 * can be unit-tested directly under node --test (ESM type-stripping requires
 * explicit relative extensions, which production CJS forbids).
 *
 * A "orphan" is a directory under `root` whose name is not in `live` slugs.
 * Orphans are MOVED into `<root>/.archive/<ts>-<slug>/` (same filesystem ⇒
 * instant rename; dot-dir ⇒ invisible to code-server/opencode loops), and
 * archive entries older than `archiveDays` are purged.
 */
import fs from 'fs';
import path from 'path';

/** Directory names we are ever willing to touch — no traversal, no dot-dirs. */
export function safeName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.startsWith('.');
}

export function sweepWorkspaces(
  root: string,
  live: Iterable<string>,
  archiveDays: number,
): { archived: string[]; purged: string[] } {
  const archived: string[] = [];
  const purged: string[] = [];
  const archiveDir = path.join(root, '.archive');
  const liveSet = new Set(live);

  // ── Purge expired archive entries ────────────────────────────
  try {
    const cutoff = Date.now() - Math.max(0, archiveDays) * 24 * 60 * 60 * 1000;
    for (const entry of fs.readdirSync(archiveDir)) {
      if (!safeName(entry)) continue;
      const full = path.join(archiveDir, entry);
      let old = true;
      try {
        old = fs.statSync(full).mtimeMs < cutoff;
      } catch {
        continue; // vanished mid-sweep
      }
      if (!old) continue;
      fs.rmSync(full, { recursive: true, force: true });
      purged.push(entry);
    }
  } catch {
    /* archive dir missing — nothing to purge */
  }

  // ── Archive orphaned workspace dirs ──────────────────────────
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return { archived, purged };
  }
  for (const name of entries) {
    if (!safeName(name) || name === '.archive') continue;
    if (liveSet.has(name)) continue;
    const src = path.join(root, name);
    let isDir = false;
    try {
      isDir = fs.statSync(src).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const dest = path.join(archiveDir, `${Date.now().toString(36)}-${name}`);
    try {
      fs.mkdirSync(archiveDir, { recursive: true });
      try {
        fs.renameSync(src, dest);
      } catch {
        // Cross-device fallback (should not happen — same bind): copy+remove.
        fs.cpSync(src, dest, { recursive: true });
        fs.rmSync(src, { recursive: true, force: true });
      }
      archived.push(name);
    } catch {
      /* leave it; next sweep retries */
    }
  }
  return { archived, purged };
}
