/**
 * embed-core.ts
 * Madar — PURE, import-free rules behind the authenticated embedded-surface
 * reverse proxy (`embed-proxy.ts`), the same split the repo already uses for
 * serve-core / alerts-core / snapshots-schedule / janitor-core: no net/http/user
 * imports, so `node --test` loads it offline and drives the exact helpers the
 * server uses.
 *
 * ── Why a proxy at all ────────────────────────────────────────────────────
 * code-server (`--auth none`) and opencode web (no password) are arbitrary
 * code execution surfaces running as ROOT in a container that holds
 * /var/run/docker.sock. They are bound to 127.0.0.1 inside the app container so
 * NO container on ANY docker network can reach them; the browser reaches them
 * only through this proxy, which demands a Madar session first.
 *
 * ── Why the two surfaces get different path shapes ────────────────────────
 * opencode's shell hardcodes ABSOLUTE asset paths (`/assets/index-*.js`,
 * `/favicon-*.svg`) and its router/API calls absolute paths too, and its
 * directory routes are base64url of `/workspaces/<slug>` — always beginning
 * `L3dv`. It therefore cannot live under a path prefix and cannot share a
 * prefix with the IDE: opencode owns the ORIGIN ROOT and the IDE takes `/ide`
 * (a segment opencode's own routes can never produce, so the split is
 * unambiguous). code-server on the other hand emits relative asset URLs
 * (`./_static/...`, `serverBasePath: "."`) and so works fine under `/ide`.
 */

export const EMBED_COOKIE_NAME = 'madar_embed';

/** Path prefix the IDE lives under on the proxy origin. */
export const EMBED_IDE_PREFIX = '/ide';

export type EmbedSurface = 'ide' | 'opencode';

export interface EmbedRoute {
  surface: EmbedSurface;
  /** Path to request on the upstream, prefix already removed for the IDE. */
  upstreamPath: string;
}

/**
 * Map a proxy-origin request path onto a surface + upstream path.
 *
 * `/ide`, `/ide/`, `/ide/<rest>` → the IDE with `/ide` stripped (code-server
 * resolves its own relative assets against the document URL, so it must SEE
 * the stripped path while the browser keeps the prefix).
 *
 * Everything else → opencode, verbatim, at the origin root.
 */
export function resolveEmbedRoute(pathname: string): EmbedRoute {
  const raw = typeof pathname === 'string' && pathname.startsWith('/') ? pathname : '/';
  if (raw === EMBED_IDE_PREFIX) {
    return { surface: 'ide', upstreamPath: '/' };
  }
  if (raw.startsWith(`${EMBED_IDE_PREFIX}/`)) {
    const rest = raw.slice(EMBED_IDE_PREFIX.length);
    return { surface: 'ide', upstreamPath: rest.startsWith('/') ? rest : `/${rest}` };
  }
  return { surface: 'opencode', upstreamPath: raw };
}

/**
 * Headers that must never cross a proxy hop in either direction (RFC 9110
 * §7.6.1 + RFC 9110 §7.6.2). Forwarding `connection`/`transfer-encoding` from a
 * re-framed body is how request-smuggling desyncs start, so they are dropped
 * rather than trusted; `upgrade` is handled separately by the websocket leg.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export function stripHopByHop(headers: Record<string, string | string[] | undefined>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Re-point an upstream `Location` at the proxy origin the browser is actually
 * talking to.
 *
 * The IDE gets its `/ide` prefix added back (code-server may redirect to a
 * root-relative path). opencode gets ABSOLUTE loopback locations rewritten to
 * root-relative ones — otherwise the browser would follow a `Location:
 * http://127.0.0.1:4096/...` straight back to the now-unpublished internal
 * port, which is exactly the route this change removes. Returns null when the
 * header is unusable and should be dropped instead.
 */
export function rewriteLocation(location: string, surface: EmbedSurface): string | null {
  const value = String(location || '').trim();
  if (!value) return null;

  if (/^https?:\/\//i.test(value)) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return null;
    }
    // Same scheme-less relative form: strip scheme+authority, keep path/query.
    const rel = `${parsed.pathname || '/'}${parsed.search || ''}${parsed.hash || ''}`;
    return surface === 'ide' ? prefixIdePath(rel) : rel;
  }

  // Protocol-relative: same treatment, authority always dropped. The authority
  // starts at index 2, so the path slash must be searched FROM there — a plain
  // indexOf('/') finds the leading slash at 0 and would slice the authority
  // back on, leaking the internal port to the browser verbatim.
  if (value.startsWith('//')) {
    const slash = value.indexOf('/', 2);
    if (slash < 0) return surface === 'ide' ? `${EMBED_IDE_PREFIX}/` : '/';
    const rest = value.slice(slash);
    return surface === 'ide' ? prefixIdePath(rest) : rest;
  }

  // Dot-relative (`./…`, `../…`): the browser resolves these against the URL
  // it already has — which carries the /ide prefix for the IDE — so they must
  // pass through UNTOUCHED. code-server redirects root to `./?folder=…` and a
  // rewritten-or-dropped header breaks the whole follow chain. Anything else
  // that is not absolute, protocol-relative or dot-relative is unusable.
  if (value.startsWith('./') || value.startsWith('../')) return value;

  if (!value.startsWith('/')) return null;
  return surface === 'ide' ? prefixIdePath(value) : value;
}

/** Prefix a root-relative path with the IDE mount point (idempotent). */
export function prefixIdePath(pathAndQuery: string): string {
  const value = String(pathAndQuery || '');
  if (value === EMBED_IDE_PREFIX || value.startsWith(`${EMBED_IDE_PREFIX}/`) || value.startsWith(`${EMBED_IDE_PREFIX}?`)) {
    return value;
  }
  return `${EMBED_IDE_PREFIX}${value.startsWith('/') ? '' : '/'}${value}`;
}

/**
 * Parse a `Cookie` header into a name→value map. The embed cookie is the ONLY
 * credential the proxy accepts, and a duplicated name must never win by being
 * parsed first — the LAST occurrence is what a browser sends last, so resolve
 * in order and let the final one stand (mirrors the proxy's own header
 * handling rather than trusting an attacker-chosen early duplicate).
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof header !== 'string' || !header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length > 1) value = value.slice(1, -1);
    out[name] = value;
  }
  return out;
}

/**
 * Drop any upstream `Set-Cookie` that would clobber the embed credential —
 * an upstream that could name `madar_embed` must not be able to overwrite the
 * session gate (nor inherit a laxer attribute set than HttpOnly/SameSite).
 *
 * This is the RESPONSE direction only: everything else passes through, because
 * the surfaces own their own session cookies. The REQUEST direction is the
 * opposite rule — `buildUpstreamHeaders` drops the whole `Cookie` header rather
 * than filtering it, since the embed credential rides in it and the upstreams
 * run `--auth none` (they have no use for any cookie). Do not "fix" that by
 * forwarding a filtered Cookie header: that is exactly how madar_embed would
 * reach a root code-execution surface.
 */
export function sanitizeSetCookie(values: string[] | undefined, embedCookieName = EMBED_COOKIE_NAME): string[] {
  if (!Array.isArray(values)) return [];
  return values.filter((raw) => {
    const name = String(raw || '').split('=', 1)[0]?.trim().toLowerCase();
    return name !== embedCookieName.toLowerCase();
  });
}

/**
 * Should the embed cookie carry `Secure`?
 *
 * True only when the request that minted it arrived over TLS, which costs
 * nothing on an HTTPS install and cuts the LAN-sniffing window there. It is
 * deliberately NOT unconditional: the documented deployment is a plain-HTTP LAN
 * (the dashboard is published on :3000 with no TLS terminator), and a browser
 * silently DROPS a `Secure` cookie received over http:// — the IDE would then
 * fail to load with no error anywhere. `forwardedProto` is honoured only when
 * the operator opted into trusting one proxy hop (WSD_TRUST_PROXY), because
 * that header is attacker-controlled otherwise.
 */
export function embedCookieSecure(req: {
  encrypted?: boolean;
  forwardedProto?: string;
  trustProxy?: boolean;
}): boolean {
  if (req.encrypted === true) return true;
  if (req.trustProxy !== true) return false;
  const first = String(req.forwardedProto || '').split(',')[0]?.trim().toLowerCase();
  return first === 'https';
}

/**
 * Attributes for the embed cookie: HttpOnly, SameSite=Strict, host-scoped.
 * `Secure` is conditional (see embedCookieSecure) and the clearing form must
 * carry the same decision, so a TLS install expires the cookie it minted.
 */
export function embedCookieOptions(maxAgeSeconds: number, secure = false): string {
  const attrs = ['HttpOnly', 'SameSite=Strict', 'Path=/'];
  if (Number.isFinite(maxAgeSeconds) && maxAgeSeconds > 0) {
    attrs.push(`Max-Age=${Math.floor(maxAgeSeconds)}`);
  }
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

/** Clear the embed cookie (logout, or a role that no longer qualifies). */
export function embedCookieClearOptions(secure = false): string {
  const attrs = ['HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=0'];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}
