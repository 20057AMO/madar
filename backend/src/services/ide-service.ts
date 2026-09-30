/**
 * ide-service.ts
 * Madar — Unified VS Code service (single code-server in the main container,
 * rooted at /workspaces, so it sees every project).
 * The dashboard only needs to know whether it is up and on which port to point
 * the iframe at. code-server runs with `--auth none`, so there is NO IDE
 * password: nothing to mint, persist or echo.
 *
 * `running` describes the PROCESS and nothing else — which is exactly why the
 * payload also carries the workspaces mount verdict (`workspace`) and whether
 * the authenticated proxy is published off-host (`lanReachable`). An IDE that
 * is running and serving an empty directory is NOT healthy, and a published
 * IDE is only as safe as the proxy in front of it.
 */
import {
  createStatusCache,
  isLanReachableHost,
  resolveEmbeddedPort,
  resolveEmbeddedPublishHost,
  EMBEDDED_STATUS_DEFAULT_TTL_MS,
} from './embedded-status-core';
import { probeEmbeddedPort } from './embedded-status-probe';
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
  running: boolean;
  /** Proxy port the iframe must point at (the IDE is NOT published directly). */
  port: number;
  /**
   * The workspaces bind mount — reported here because `running:true` only
   * describes the PROCESS: a broken mount left code-server serving an empty
   * Explorer, which this payload used to call "healthy".
   */
  workspace: WorkspaceMountInfo;
  /** True when the authenticated proxy is published beyond loopback. */
  lanReachable: boolean;
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
