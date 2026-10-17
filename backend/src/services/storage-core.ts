/**
 * storage-core.ts
 * Madar — Pure, import-free helpers for storage metrics.
 *
 * Mirrors the janitor-core / snapshots-schedule / alerts-core pattern: no
 * dockerode, no local-module imports — just node built-ins, so the offline
 * unit tests can load this file under `node --test` without Docker.
 */
import fs from 'fs';
import path from 'path';

export interface DirSizeResult {
  size: number;
  truncated: boolean;
}

/**
 * Recursively sum the apparent byte size of a directory tree (files + the
 * size of directory entries themselves are excluded — apparent data only,
 * like `du -s --apparent-size`). Symbolic links count their link entry size,
 * never the target's contents. A soft deadline stops the walk early and
 * reports `truncated: true` instead of hanging an endpoint on a huge tree.
 * Unreadable/missing subtrees are skipped silently; a missing root is 0.
 */
export function dirSize(
  dir: string,
  opts?: { budgetMs?: number; now?: () => number }
): DirSizeResult {
  const now = opts?.now || Date.now;
  const budgetMs = opts?.budgetMs ?? 30_000;
  const started = now();
  let size = 0;
  let truncated = false;

  const walk = (p: string): void => {
    if (!truncated && now() - started >= budgetMs) {
      truncated = true;
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(p, ent.name);
      try {
        if (ent.isSymbolicLink()) {
          size += fs.lstatSync(full).size;
        } else if (ent.isDirectory()) {
          walk(full);
        } else if (ent.isFile()) {
          size += fs.statSync(full).size;
        }
      } catch {
        /* unreadable entry — skip, never fail the whole scan */
      }
      if (truncated) return;
    }
  };

  walk(path.resolve(dir));
  return { size, truncated };
}