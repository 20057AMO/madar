/**
 * embedded-status-probe.ts
 * Madar — the wired sibling of the pure embedded-status-core.ts: one shared
 * liveness probe for the embedded services (code-server + opencode web) that
 * run as separate processes inside the main container.
 *
 * Plain TCP connect on purpose (same argument as the IDE probe): we only need
 * to know that something is LISTENING, never what it answers, so an HTTP
 * round-trip would pay for status line + headers + a body we throw away.
 * Measured inside the container: TCP connect p50 1ms / max 5ms versus a full
 * `GET /` on the same port p50 63ms / max 97ms — and on a cold opencode the
 * HTTP path was observed up to 1.85s, which an HTTP-shaped timeout would
 * misread as "offline".
 *
 * `EMBEDDED_PROBE_TIMEOUT_MS` is the ceiling for a socket whose handshake never
 * completes (a black-holed/filtered port): 3s is ~1.6x the worst observed cold
 * start (1.85s) yet still bounded, and a dead service fails fast anyway
 * (ECONNREFUSED on loopback returns immediately), so the large ceiling costs
 * nothing in the common "stopped" case. NOTE: a peer that ACCEPTS the
 * connection but never sends a byte is `true` the moment the handshake lands —
 * this is a listening-socket probe, not an HTTP round-trip.
 */
import net from 'net';

export const EMBEDDED_PROBE_TIMEOUT_MS = 3_000;

/** The slice of net.Socket the probe actually drives (structurally satisfied by it). */
export interface EmbeddedProbeSocket {
  setTimeout(ms: number, cb: () => void): unknown;
  once(event: 'connect' | 'error', cb: () => void): unknown;
  destroy(): unknown;
}

/** Injectable connector — the seam the offline tests use to reach the timeout. */
export type EmbeddedProbeConnect = (opts: { host: string; port: number }) => EmbeddedProbeSocket;

const connectLoopback: EmbeddedProbeConnect = (opts) => net.connect(opts);

/**
 * True when something accepts a TCP connection on 127.0.0.1:<port>.
 * Never throws and never rejects: an out-of-range port makes net.connect throw
 * ERR_SOCKET_BAD_PORT *synchronously*, which would otherwise reject here and
 * surface as an unhandled rejection in any caller that does not await.
 */
export function probeEmbeddedPort(
  port: number,
  timeoutMs: number = EMBEDDED_PROBE_TIMEOUT_MS,
  connect: EmbeddedProbeConnect = connectLoopback
): Promise<boolean> {
  return new Promise((resolve) => {
    let sock: EmbeddedProbeSocket;
    try {
      sock = connect({ host: '127.0.0.1', port });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}
