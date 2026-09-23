/**
 * updates-boot.ts
 * Madar — Boot-time re-application of persisted component updates.
 *
 * A `docker compose build && docker compose up` discards the container's
 * writable layer: an opencode npm install or code-server dpkg upgrade that
 * was persisted as applyState:'ok' BEFORE the rebuild is lost — the freshly
 * built image runs its pinned baseline binaries while the state files still
 * claim the newer version. This service runs at dashboard boot, right AFTER
 * reconcileStaleStates (a plain restart must NOT re-apply — only a new image
 * diverging from the persisted 'ok' state is the trigger), and:
 *
 *  • opencode    — re-installs the persisted version via npm, restarts the
 *    supervisor into it and verifies boot. opencode-ai@<target> is pulled
 *    from npm's OWN registry configuration (the backend's
 *    WSD_UPDATE_NPM_REGISTRY probe is a separate concern) — a version that
 *    exists nowhere fails fast with bootReapply:'failed'.
 *  • code-server — re-installs the persisted version from the local deb cache
 *    when a valid artifact is present (fast, offline — the cache is on the
 *    same wsd-data volume the state files live on), else re-downloads it.
 *    NO rollback: a rebuild is by definition already inside the
 *    binary-swap window the interactive apply would roll back from.
 *
 * Contract:
 *  - upgrade-only: `decideBootReapply` gates every run to a persisted 'ok'
 *    state whose version is STRICTLY newer than the running image;
 *  - never destructive to apply state: a failure records bootReapply:'failed'
 *    (truncated reason in bootReapplyError) and NEVER touches applyState,
 *    currentVersion or targetVersion — the interactive surface stays intact
 *    ('running' is persisted before an install so the UI never flashes a
 *    stale verdict during the ~8s probe/install window);
 *  - never blocks or crashes boot: the whole pass is fire-and-forget, each
 *    component is isolated in its own try/catch, and a failure only appends
 *    to the 0600 update.log.
 */
import { decideBootReapply, parseCliVersion } from './updates-core';
import { probeOpencodeVersion, installOpencodeVersion, SUPPORTED_MAJORS } from './opencode-api';
import * as codeServer from './code-server-update';
import {
  readOpencodeState,
  persistOpencodeState,
  appendLog,
  type OpencodeUpdateState,
} from './component-updates';

const BOOT_REAPPLY_ERROR_CAP = 200;

function truncate(msg: string, max: number): string {
  return msg.length > max ? `${msg.slice(0, max)}…` : msg;
}

let started = false;

/**
 * Kick off the boot-time re-apply pass. Returns immediately; the pass runs in
 * the background so a slow registry/network can never hold up boot. Disable
 * with WSD_UPDATES_BOOT_REAPPLY=0|false. Safe to call multiple times (module
 * single-flight — a second call is a no-op).
 */
export function startBootUpdatesReapply(): void {
  if (started) return;
  started = true;
  const flag = process.env.WSD_UPDATES_BOOT_REAPPLY;
  if (flag === '0' || flag === 'false') {
    appendLog('[boot-reapply] disabled via WSD_UPDATES_BOOT_REAPPLY');
    return;
  }
  void reapplyOpencode();
  void reapplyCodeServer();
}

async function reapplyOpencode(): Promise<void> {
  try {
    const prev = readOpencodeState();
    const probe = await probeOpencodeVersion(true);
    const running = probe.version === 'unknown' ? null : probe.version;
    const decision = decideBootReapply({
      applyState: prev.applyState,
      persisted: prev.currentVersion ?? prev.targetVersion ?? null,
      running,
      supportedMajors: SUPPORTED_MAJORS,
    });

    // Every verdict re-reads the CURRENT state right before persisting: the
    // install primitive below clears updateInFlight before it resolves, so a
    // user apply can legitimately land in that window — writing a stale
    // snapshot would resurrect old versions/applyState over the fresh write.
    if (decision.action === 'skip') {
      const cur = readOpencodeState();
      await persistOpencodeState({ ...cur, bootReapply: 'skipped', bootReapplyError: undefined });
      appendLog(`[boot-reapply] opencode: skip (${decision.reason})`);
      return;
    }
    if (decision.action === 'adopt-image') {
      // Normalize the raw CLI probe before persisting — a `v`-prefixed output
      // would fail the strict publisher gate on a later rebuild.
      const adopted = parseCliVersion(decision.runningVersion) ?? decision.runningVersion;
      const cur = readOpencodeState();
      const next: OpencodeUpdateState = {
        ...cur,
        currentVersion: adopted,
        targetVersion: adopted,
        bootReapply: 'skipped',
        bootReapplyError: undefined,
      };
      await persistOpencodeState(next);
      appendLog(`[boot-reapply] opencode: adopting image version ${adopted} (persisted ${cur.currentVersion ?? 'unknown'})`);
      return;
    }

    const cur = readOpencodeState();
    await persistOpencodeState({ ...cur, bootReapply: 'running', bootReapplyError: undefined });
    appendLog(`[boot-reapply] opencode: re-installing persisted ${decision.targetVersion} over image ${running}`);
    const result = await installOpencodeVersion(decision.targetVersion);
    if (result.ok) {
      const done = readOpencodeState();
      await persistOpencodeState({ ...done, bootReapply: 'ok', bootReapplyError: undefined });
      appendLog(`[boot-reapply] opencode: ${decision.targetVersion} re-applied and booted`);
    } else {
      // bootFailed:true is still a plain failure here — no rollback is correct
      // for the boot reapply path (a rebuild is already inside the binary-swap
      // window the interactive rollback would roll back from).
      const err = truncate(result.error ?? 'reapply failed', BOOT_REAPPLY_ERROR_CAP);
      const done = readOpencodeState();
      await persistOpencodeState({ ...done, bootReapply: 'failed', bootReapplyError: err });
      appendLog(`[boot-reapply] opencode: failed to re-apply ${decision.targetVersion} — ${err}`);
    }
  } catch (err: any) {
    appendLog(`[boot-reapply] opencode: reapply pass crashed: ${truncate(err?.message ?? 'unknown error', BOOT_REAPPLY_ERROR_CAP)}`);
  }
}

async function reapplyCodeServer(): Promise<void> {
  try {
    const prev = codeServer.getCodeServerUpdateState();
    const running = await codeServer.probeCurrentVersion(true);
    const decision = decideBootReapply({
      applyState: prev.applyState,
      persisted: prev.currentVersion ?? prev.targetVersion ?? null,
      running,
    });

    if (decision.action === 'skip') {
      const cur = codeServer.getCodeServerUpdateState();
      await codeServer.persistCodeServerState({ ...cur, bootReapply: 'skipped', bootReapplyError: undefined });
      appendLog(`[boot-reapply] code-server: skip (${decision.reason})`);
      return;
    }
    if (decision.action === 'adopt-image') {
      const adopted = parseCliVersion(decision.runningVersion) ?? decision.runningVersion;
      const cur = codeServer.getCodeServerUpdateState();
      const next: codeServer.CodeServerUpdateState = {
        ...cur,
        currentVersion: adopted,
        targetVersion: adopted,
        bootReapply: 'skipped',
        bootReapplyError: undefined,
      };
      await codeServer.persistCodeServerState(next);
      appendLog(`[boot-reapply] code-server: adopting image version ${adopted} (persisted ${cur.currentVersion ?? 'unknown'})`);
      return;
    }

    const cur = codeServer.getCodeServerUpdateState();
    await codeServer.persistCodeServerState({ ...cur, bootReapply: 'running', bootReapplyError: undefined });
    appendLog(`[boot-reapply] code-server: re-installing persisted ${decision.targetVersion} over image ${running}`);
    const result = await codeServer.installCodeServerVersion(decision.targetVersion, { fromCache: true });
    if (result.ok) {
      const done = codeServer.getCodeServerUpdateState();
      await codeServer.persistCodeServerState({ ...done, bootReapply: 'ok', bootReapplyError: undefined });
      appendLog(`[boot-reapply] code-server: ${decision.targetVersion} re-applied and booted`);
    } else {
      const err = truncate(result.error ?? 'reapply failed', BOOT_REAPPLY_ERROR_CAP);
      const done = codeServer.getCodeServerUpdateState();
      await codeServer.persistCodeServerState({ ...done, bootReapply: 'failed', bootReapplyError: err });
      appendLog(`[boot-reapply] code-server: failed to re-apply ${decision.targetVersion} — ${err}`);
    }
  } catch (err: any) {
    appendLog(`[boot-reapply] code-server: reapply pass crashed: ${truncate(err?.message ?? 'unknown error', BOOT_REAPPLY_ERROR_CAP)}`);
  }
}