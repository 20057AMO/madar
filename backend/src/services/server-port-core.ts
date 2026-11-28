/**
 * server-port-core.ts
 * Madar — pure rules for the dashboard's listening port. Import-free (like
 * serve-core.ts / jwt-secret-core.ts) so node --test can load it offline.
 *
 * `Number(process.env.PORT) || 3000` made an ephemeral port impossible: `0`
 * was silently replaced by 3000, so an isolated test server could never ask
 * the kernel for a free port. The explicit string `'0'` now means "bind an
 * OS-assigned port"; every other non-integer/out-of-range value keeps the
 * honest 3000 fallback instead of throwing at boot.
 */

export const DEFAULT_SERVER_PORT = 3000;

/**
 * Resolve the configured listening port. Blank/missing falls back to 3000;
 * the explicit string `'0'` is the only way to request an ephemeral port.
 * Junk (negative, fractional, hex, exponent, out-of-range, non-string) never
 * throws and never reaches `server.listen()` as an invalid value.
 */
export function resolveServerPort(value: string | undefined): number {
  if (typeof value !== 'string') return DEFAULT_SERVER_PORT;
  const text = value.trim();
  if (!text) return DEFAULT_SERVER_PORT;
  if (text === '0') return 0;
  if (!/^\d+$/.test(text)) return DEFAULT_SERVER_PORT;
  const port = Number(text);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return DEFAULT_SERVER_PORT;
  return port;
}

/** The only shape we need from `server.address()` — kept local to stay import-free. */
export interface BoundServerAddress {
  port: number;
}

/**
 * Derive the port the kernel actually bound. A listening server reports an
 * address object; a Unix socket reports a string, and a closed/broken server
 * reports null. Only a real 1..65535 port may override the configured value,
 * so `PORT=0` can advertise its real port without ever advertising `0`.
 */
export function boundServerPort(
  address: BoundServerAddress | string | null | undefined,
  fallback: number
): number {
  if (!address || typeof address !== 'object') return fallback;
  const { port } = address;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return fallback;
  return port;
}
