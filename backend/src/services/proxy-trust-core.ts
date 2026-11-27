import { isIP } from 'node:net';
import { resolveEmbeddedPublishHost } from './embedded-status-core';

const PROXY_ALIASES = new Set(['loopback', 'linklocal', 'uniquelocal']);

export type TrustedProxyEnv = Record<string, unknown>;

export interface TrustedProxyApp {
  set(setting: string, value: unknown): unknown;
}

interface Cidr {
  address: string;
  prefix: number;
  version: 4 | 6;
}

function ipVersion(value: string): 4 | 6 | null {
  const version = isIP(value);
  return version === 4 || version === 6 ? version : null;
}

function ipv6Groups(value: string): number[] | null {
  if (ipVersion(value) !== 6) return null;
  let normalized = value.toLowerCase();
  const embedded = normalized.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (embedded) {
    const octets = embedded[1].split('.').map(Number);
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    normalized = `${normalized.slice(0, -embedded[1].length)}${hi}:${lo}`;
  }
  const halves = normalized.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':').filter(Boolean) : [];
  const right = halves[1] ? halves[1].split(':').filter(Boolean) : [];
  if (halves.length === 1 && left.length !== 8) return null;
  if (halves.length === 2 && left.length + right.length >= 8) return null;
  const groups = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  if (groups.length !== 8) return null;
  const values = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  return values.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? values : null;
}

function ipv4BigInt(value: string): bigint | null {
  if (ipVersion(value) !== 4) return null;
  const octets = value.split('.').map(Number);
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return octets.reduce((acc, n) => (acc << 8n) | BigInt(n), 0n);
}

function ipBigInt(value: string): bigint | null {
  const version = ipVersion(value);
  if (version === 4) return ipv4BigInt(value);
  const groups = ipv6Groups(value);
  if (!groups) return null;
  return groups.reduce((acc, n) => (acc << 16n) | BigInt(n), 0n);
}

function ipv4MappedAddress(value: string): string | null {
  const groups = ipv6Groups(value);
  if (!groups || groups.slice(0, 5).some((n) => n !== 0) || groups[5] !== 0xffff) return null;
  return [
    groups[6] >> 8,
    groups[6] & 0xff,
    groups[7] >> 8,
    groups[7] & 0xff,
  ].join('.');
}

function parseCidr(value: string): Cidr | null {
  const parts = value.split('/');
  if (parts.length !== 2) return null;
  const version = ipVersion(parts[0]);
  if (!version) return null;
  const max = version === 4 ? 32 : 128;
  const prefix = Number(parts[1]);
  if (!/^\d+$/.test(parts[1]) || !Number.isInteger(prefix) || prefix < 1 || prefix > max) return null;
  return { address: parts[0], prefix, version };
}

function sameIp(left: string, right: string): boolean {
  const lv = ipVersion(left);
  const rv = ipVersion(right);
  if (!lv || !rv) return false;
  if (lv === rv) return ipBigInt(left) === ipBigInt(right);
  if (lv === 6 && rv === 4) {
    const mapped = ipv4MappedAddress(left);
    return mapped !== null && ipv4BigInt(mapped) === ipv4BigInt(right);
  }
  const mapped = ipv4MappedAddress(right);
  return mapped !== null && ipv4BigInt(mapped) === ipv4BigInt(left);
}

function cidrMatches(peer: string, cidr: Cidr): boolean {
  const version = ipVersion(peer);
  if (!version) return false;
  let candidate = peer;
  let candidateVersion = version;
  if (version === 6 && cidr.version === 4) {
    const mapped = ipv4MappedAddress(peer);
    if (!mapped) return false;
    candidate = mapped;
    candidateVersion = 4;
  } else if (version === 4 && cidr.version === 6) {
    candidate = `::ffff:${peer}`;
    candidateVersion = 6;
  }
  if (candidateVersion !== cidr.version) return false;
  const value = ipBigInt(candidate);
  const network = ipBigInt(cidr.address);
  if (value === null || network === null) return false;
  const totalBits = cidr.version === 4 ? 32 : 128;
  const shift = BigInt(totalBits - cidr.prefix);
  return (value >> shift) === (network >> shift);
}

function matchesAlias(alias: string, peer: string): boolean {
  const mapped = ipv4MappedAddress(peer);
  const v4 = ipVersion(peer) === 4 ? peer : mapped;
  if (alias === 'loopback') {
    if (v4 && /^127\./.test(v4)) return true;
    return sameIp(peer, '::1');
  }
  if (alias === 'linklocal') {
    if (v4 && /^169\.254\./.test(v4)) return true;
    const groups = ipv6Groups(peer);
    return !!groups && (groups[0] & 0xffc0) === 0xfe80;
  }
  if (alias === 'uniquelocal') {
    if (v4) {
      const [a, b] = v4.split('.').map(Number);
      if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return true;
    }
    const groups = ipv6Groups(peer);
    return !!groups && (groups[0] & 0xfe00) === 0xfc00;
  }
  return false;
}

function tokenize(value: unknown): string[] {
  return String(value ?? '')
    .toLowerCase()
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function parseTrustedProxies(env: TrustedProxyEnv = process.env): string[] | undefined {
  const explicit = env.WSD_TRUSTED_PROXIES !== undefined && env.WSD_TRUSTED_PROXIES !== null;
  const raw = explicit ? env.WSD_TRUSTED_PROXIES : env.WSD_TRUST_PROXY;
  if (raw === undefined || raw === null) return undefined;
  if (!explicit) {
    const legacy = String(raw).trim().toLowerCase();
    return legacy === '1' || legacy === 'true' ? ['loopback', 'uniquelocal'] : undefined;
  }

  const accepted: string[] = [];
  for (const entry of tokenize(raw)) {
    // A wildcard CIDR would make every client a trusted proxy, so X-Forwarded-For
    // could rewrite the IP used by every rate limiter and the unlock cooldown.
    if (entry.endsWith('/0')) continue;
    if (PROXY_ALIASES.has(entry) || ipVersion(entry) || parseCidr(entry)) {
      if (!accepted.includes(entry)) accepted.push(entry);
    }
  }
  return accepted.length > 0 ? accepted : undefined;
}

export function trustedProxyWarning(env: TrustedProxyEnv = process.env): string | null {
  if (env.WSD_TRUSTED_PROXIES === undefined || env.WSD_TRUSTED_PROXIES === null) return null;
  const wildcard = tokenize(env.WSD_TRUSTED_PROXIES).find((entry) => entry.endsWith('/0'));
  return wildcard
    ? `Ignoring trusted proxy entry ${wildcard}: a wildcard would let any client spoof X-Forwarded-For.`
    : null;
}

export function trustedProxyExposureWarning(env: TrustedProxyEnv = process.env): string | null {
  if (!parseTrustedProxies(env)?.length) return null;
  if (resolveEmbeddedPublishHost(env.WSD_EMBEDDED_PUBLISH_HOST as string | undefined) !== '0.0.0.0') return null;
  return 'Trusted proxies are enabled while WSD_EMBEDDED_PUBLISH_HOST resolves to 0.0.0.0; the authenticated IDE/proxy surface is published on all interfaces. Terminate TLS and restrict access at the reverse proxy.';
}

export function configureTrustedProxy(app: TrustedProxyApp, env: TrustedProxyEnv = process.env): string[] | undefined {
  const proxies = parseTrustedProxies(env);
  if (proxies) app.set('trust proxy', proxies);
  return proxies;
}

export function isTrustedProxyPeer(peer: unknown, proxies: readonly string[] | undefined): boolean {
  if (!proxies || proxies.length === 0 || typeof peer !== 'string') return false;
  const address = peer.trim();
  for (const entry of proxies) {
    if (PROXY_ALIASES.has(entry)) {
      if (matchesAlias(entry, address)) return true;
      continue;
    }
    const cidr = parseCidr(entry);
    if (cidr ? cidrMatches(address, cidr) : sameIp(entry, address)) return true;
  }
  return false;
}
