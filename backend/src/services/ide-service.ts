/**
 * ide-service.ts
 * Madar — Unified VS Code service (single code-server in the main container,
 * rooted at /workspaces, so it sees every project).
 * The dashboard only needs to know whether it is up and on which port to point
 * the iframe at. code-server runs with `--auth none`, so there is NO IDE
 * password: nothing to mint, persist or echo.
 *
 * `running` answers "can the browser load the IDE right now", which is the
 * conjunction of two facts: code-server answers on its internal port AND the
 * authenticated proxy in front of it is listening. A proxy that failed to bind
 * makes a perfectly healthy code-server unreachable from anywhere, so it must
 * not read as `running:true` with a `port` nothing serves. The payload then
 * also carries the workspaces mount verdict (`workspace`) and whether the
 * authenticated proxy is published off-host (`lanReachable`): an IDE that is
 * running and serving an empty directory is NOT healthy, and a published IDE is
 * only as safe as the proxy in front of it.
 */
import {
  createStatusCache,
  isLanReachableHost,
  resolveEmbeddedPort,
  resolveEmbeddedPublishHost,
  EMBEDDED_STATUS_DEFAULT_TTL_MS,
} from './embedded-status-core';
import { probeEmbeddedPort } from './embedded-status-probe';
import { embedProxyListening } from './embed-proxy';
import { getWorkspaceMount, type WorkspaceMountInfo } from './workspaces-mount';

/** code-server's own bind inside the main container (the entrypoint's arg). */
const IDE_INTERNAL_PORT = resolveEmbeddedPort(process.env.WSD_IDE_INTERNAL_PORT, 8080);
/**
 * Interface the AUTHENTICATED proxy is published on. The raw code-server port
 * is no longer published at all — the upstreams are loopback-bound and only
 * this proxy reaches them — so this knob now describes a session-checked
 * route, not an open one.
 */
const IDE_PUBLISH_HOST = resolveEmbeddedPublishHost(process.env.WSD_EMBEDDED_PUBLISH_HOST);
/** The only port the browser may use: the Madar embedded-surface proxy. */
const EMBED_PORT = resolveEmbeddedPort(process.env.WSD_EMBED_PROXY_PORT, 4097);

export interface IdeStatus {
  /** code-server is up AND the authenticated proxy in front of it is listening. */
  running: boolean;
  /** Proxy port the iframe must point at (the IDE is NOT published directly). */
  port: number;
  /**
   * The workspaces bind mount — reported separately from `running` because a
   * broken mount left code-server serving an empty Explorer, which this payload
   * used to call "healthy".
   */
  workspace: WorkspaceMountInfo;
  /** True when the authenticated proxy is published beyond loopback. */
  lanReachable: boolean;
}

/**
 * Check whether the IDE is USABLE: code-server is up on the internal port
 * (ide-service.ts) AND the authenticated proxy in front of it is actually
 * listening (embed-proxy). Both are required, because the proxy is the only
 * route the browser has — a running code-server behind a proxy that failed to
 * bind is reachable from nowhere, so reporting it as running is what used to
 * send the page to a dead port. Shared plain-TCP probe: auth/healthz behavior
 * never matters.
 */
async function isIdeRunning(): Promise<boolean> {
  if (!embedProxyListening()) return false;
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
    return {
      running,
      port: EMBED_PORT,
      workspace: getWorkspaceMount(),
      lanReachable: isLanReachableHost(IDE_PUBLISH_HOST),
    };
  },
});

/** Drop the cached probe — call after restarting/updating code-server. */
export function invalidateIdeStatusCache(): void {
  ideStatusCache.invalidate();
}

export function getIdeStatus(opts?: { fresh?: boolean }): Promise<IdeStatus> {
  return ideStatusCache.get(opts);
}
