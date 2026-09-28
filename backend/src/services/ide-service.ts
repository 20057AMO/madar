/**
 * ide-service.ts
 * Madar — Unified VS Code service (single code-server in the main container,
 * rooted at /workspaces, so it sees every project).
 * The dashboard only needs to know whether it is up and on which host port.
 * code-server runs with `--auth none`, so there is NO IDE password: nothing to
 * mint, persist or echo.
 */
import {
  createStatusCache,
  resolveEmbeddedPort,
  EMBEDDED_STATUS_DEFAULT_TTL_MS,
} from './embedded-status-core';
import { probeEmbeddedPort } from './embedded-status-probe';

/** Host-facing port (compose maps WSD_IDE_PORT -> the internal bind below). */
const IDE_HOST_PORT = resolveEmbeddedPort(process.env.WSD_IDE_PORT, 8100);
/** code-server's own bind inside the main container (the entrypoint's arg). */
const IDE_INTERNAL_PORT = resolveEmbeddedPort(process.env.WSD_IDE_INTERNAL_PORT, 8080);

export interface IdeStatus {
  running: boolean;
  port: number;
}

/**
 * Check whether code-server is up (it runs inside the same main container on
 * the internal port — the dashboard host port is WSD_IDE_PORT).
 * Shared plain-TCP probe: auth/healthz behavior never matters.
 */
function isIdeRunning(): Promise<boolean> {
  return probeEmbeddedPort(IDE_INTERNAL_PORT);
}

const ideStatusCache = createStatusCache<IdeStatus>({
  ttlMs: EMBEDDED_STATUS_DEFAULT_TTL_MS,
  load: async () => {
    // A probe failure is not an error state: `running:false` is the honest
    // answer, and the status endpoint must never 500 because of it.
    let running = false;
    try {
      running = await isIdeRunning();
    } catch {
      running = false;
    }
    return { running, port: IDE_HOST_PORT };
  },
});

/** Drop the cached probe — call after restarting/updating code-server. */
export function invalidateIdeStatusCache(): void {
  ideStatusCache.invalidate();
}

export function getIdeStatus(opts?: { fresh?: boolean }): Promise<IdeStatus> {
  return ideStatusCache.get(opts);
}
