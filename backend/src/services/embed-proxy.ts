/**
 * embed-proxy.ts
 * Madar — authenticated reverse proxy in front of the two embedded developer
 * surfaces (code-server on 8080, opencode web on 4096).
 *
 * ── The problem this exists to solve ──────────────────────────────────────
 * Both upstreams are UNAUTHENTICATED code-execution surfaces (`code-server
 * --auth none`, `opencode web` with no password) running as ROOT in a container
 * that holds /var/run/docker.sock. They are now bound to 127.0.0.1 inside the
 * app container, so no container on ANY docker network can reach them: a
 * project container can no longer open a session and prompt opencode to mount
 * the host filesystem. The published ports 8100/4096 are gone, so there is no
 * unauthenticated route left at all.
 *
 * This listener is that route. It is the same Node process and the same auth
 * model as the dashboard: a Madar session is required, editor+ (the surfaces
 * execute code in the app container, so a viewer must never reach them), and
 * the credential is a purpose-scoped HttpOnly cookie the browser cannot read.
 *
 * ── Two path shapes, one origin ───────────────────────────────────────────
 * opencode's shell hardcodes absolute asset paths, so it owns the origin root;
 * code-server emits relative ones and lives under /ide. See embed-core.ts.
 *
 * No dependency is added: HTTP is proxied with node:http and websockets are
 * spliced at the TCP layer after the upgrade, so no frame is ever parsed here.
 */
import http from 'http';
import net from 'net';
import type { Duplex } from 'stream';

import {
  EMBED_COOKIE_NAME,
  parseCookies,
  resolveEmbedRoute,
  rewriteLocation,
  sanitizeSetCookie,
  stripHopByHop,
  type EmbedSurface,
} from './embed-core';
import { verifyEmbedToken, type EmbedIdentity } from './user-store';
import { resolveEmbeddedPort } from './embedded-status-core';

/** code-server's own bind inside the app container (loopback, never published). */
const IDE_UPSTREAM_PORT = resolveEmbeddedPort(process.env.WSD_IDE_INTERNAL_PORT, 8080);
/** opencode's own bind inside the app container (loopback, never published). */
const OPENCODE_UPSTREAM_PORT = resolveEmbeddedPort(process.env.WSD_OPENCODE_PORT, 4096);

/**
 * Host port the proxy itself listens on. This — not the upstream port — is what
 * the browser is told to use, and the only embedded port still published.
 */
export const EMBED_PROXY_PORT = resolveEmbeddedPort(process.env.WSD_EMBED_PROXY_PORT, 4097);

/**
 * Ceiling on the websocket UPGRADE handshake, armed on the upstream request so
 * an upstream that accepts the TCP connection and then stalls cannot hold the
 * browser's socket (and this one) open forever. Overridable so the handshake
 * guard is testable in milliseconds instead of 15s, and clamped so it can never
 * be configured away into a half-open hang.
 */
const UPGRADE_TIMEOUT_MS = (() => {
  const raw = Number(process.env.WSD_EMBED_UPGRADE_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return 15_000;
  return Math.min(Math.max(Math.floor(raw), 100), 60_000);
})();

const UPSTREAM_HOST = '127.0.0.1';

/** editor+ is the floor: both surfaces run code as root beside the docker socket. */
function roleAllows(identity: EmbedIdentity | null): boolean {
  if (!identity) return false;
  return identity.role === 'admin' || identity.role === 'editor';
}

/**
 * Listen state of the proxy, derived from the live server rather than tracked
 * by hand: the browser is pointed at the PROXY port, so a proxy that never
 * bound made every embedded `running:true` a lie — the page rendered a frame src
 * on a port nothing answers, with no error anywhere. `server.listening` is
 * false before the bind lands, after it is closed, and when it failed, which is
 * exactly the set of answers the status contract must not paper over.
 */
let proxyServer: http.Server | null = null;
let listenError = '';

/** True only while the proxy is actually accepting connections. */
export function embedProxyListening(): boolean {
  return proxyServer?.listening === true;
}

/** Why the bind failed (empty when the proxy is healthy or merely unstarted). */
export function embedProxyListenError(): string {
  return listenError;
}

function upstreamPortFor(surface: EmbedSurface): number {
  return surface === 'ide' ? IDE_UPSTREAM_PORT : OPENCODE_UPSTREAM_PORT;
}

/** The raw `?…` tail of a request URL, or '' when there is none. */
function searchOf(url: string | undefined): string {
  const value = url || '';
  const idx = value.indexOf('?');
  return idx >= 0 ? value.slice(idx) : '';
}

/** Minimal, non-revealing failure. Never echoes an upstream error string. */
function refuse(res: http.ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify({ error: message });
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/**
 * Headers forwarded upstream.
 *
 * The ENTIRE `Cookie` header is dropped, not filtered: the embed credential
 * rides in it, the dashboard session token rides in `Authorization`, and both
 * upstreams run `--auth none` so neither has any use for a cookie at all. That
 * is the REQUEST direction of the same rule `sanitizeSetCookie` implements for
 * the response direction (there, the surfaces' own cookies pass and only
 * `madar_embed` is dropped). Never re-add a filtered `Cookie` header here —
 * that is precisely how the credential guarding two root code-execution
 * surfaces would leak downstream.
 */
function buildUpstreamHeaders(
  req: http.IncomingMessage,
  surface: EmbedSurface,
  isUpgrade: boolean,
): Record<string, string | string[]> {
  const headers = stripHopByHop(req.headers as Record<string, string | string[] | undefined>);
  delete headers.cookie;
  delete (headers as Record<string, unknown>).authorization;
  const port = upstreamPortFor(surface);
  headers.host = `${UPSTREAM_HOST}:${port}`;
  headers['x-forwarded-host'] = String(req.headers.host || '');
  headers['x-forwarded-proto'] = String(
    (req.socket as net.Socket & { encrypted?: boolean }).encrypted ? 'https' : 'http',
  );
  headers['x-forwarded-for'] = String(req.socket.remoteAddress || '');
  if (isUpgrade) {
    // The upgrade leg must keep the handshake headers the hop removed.
    headers.connection = 'Upgrade';
    headers.upgrade = String(req.headers.upgrade || 'websocket');
  }
  return headers;
}

function proxyHttp(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): void {
  const route = resolveEmbedRoute(pathname);
  const identity = verifyEmbedToken(parseCookies(req.headers.cookie)[EMBED_COOKIE_NAME]);
  if (!identity) {
    refuse(res, 401, 'Madar session required');
    return;
  }
  if (!roleAllows(identity)) {
    refuse(res, 403, 'Editor access required');
    return;
  }

  const upstream = http.request(
    {
      host: UPSTREAM_HOST,
      port: upstreamPortFor(route.surface),
      method: req.method,
      path: route.upstreamPath + searchOf(req.url),
      headers: buildUpstreamHeaders(req, route.surface, false),
    },
    (up) => {
      const headers = stripHopByHop(up.headers as Record<string, string | string[] | undefined>);
      const location = headers.location;
      if (location !== undefined) {
        const rewritten = rewriteLocation(String(location), route.surface);
        if (rewritten) headers.location = rewritten;
        else delete headers.location;
      }
      const setCookie = sanitizeSetCookie(headers['set-cookie'] as string[] | undefined);
      if (setCookie.length) headers['set-cookie'] = setCookie;
      else delete headers['set-cookie'];
      res.writeHead(up.statusCode || 502, headers);
      up.pipe(res);
    },
  );

  upstream.setTimeout(120_000, () => upstream.destroy(new Error('upstream timeout')));
  upstream.on('error', () => {
    if (!res.headersSent) refuse(res, 502, 'The embedded surface is not responding');
    else res.destroy();
  });
  // A client that walks away must not leave the upstream writing into a void.
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
}

function proxyUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, pathname: string): void {
  const route = resolveEmbedRoute(pathname);
  const identity = verifyEmbedToken(parseCookies(req.headers.cookie)[EMBED_COOKIE_NAME]);
  if (!identity || !roleAllows(identity)) {
    // end() (not destroy()) so the 401 is actually flushed before the close:
    // an immediate destroy() discards the buffered response and the client
    // only ever sees ECONNRESET.
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }

  const upstreamReq = http.request({
    host: UPSTREAM_HOST,
    port: upstreamPortFor(route.surface),
    method: req.method,
    path: route.upstreamPath + searchOf(req.url),
    headers: buildUpstreamHeaders(req, route.surface, true),
  });

  // The upgrade leg is bounded too: the socket timeout has to be armed on the
  // REQUEST, not only after `upgrade` fires, or an upstream that accepts the TCP
  // connection and never completes the handshake holds the client's socket (and
  // this one) open forever. Cleared again once the relay starts — a long-lived
  // websocket legitimately goes idle.
  const upgradeDeadline = setTimeout(() => upstreamReq.destroy(new Error('upstream upgrade timeout')), UPGRADE_TIMEOUT_MS);
  upgradeDeadline.unref?.();
  let spliced = false;

  // Authenticated already — the upgrade is now a blind byte relay, which is why
  // no frame is ever parsed here and why a websocket needs no separate gate.
  upstreamReq.on('upgrade', (upRes, upSocket, upHead) => {
    // The handshake is over: the guard has done its job and must be cleared or
    // it would fire mid-session and destroy a perfectly healthy relay.
    clearTimeout(upgradeDeadline);
    if (!upSocket) {
      socket.destroy();
      return;
    }
    spliced = true;
    upSocket.setTimeout(0);
    const lines = [`HTTP/1.1 ${upRes.statusCode || 101} ${upRes.statusMessage || 'Switching Protocols'}`];
    for (const [key, value] of Object.entries(upRes.headers)) {
      if (key.toLowerCase() === 'location') continue;
      if (Array.isArray(value)) for (const v of value) lines.push(`${key}: ${v}`);
      else if (value !== undefined) lines.push(`${key}: ${value}`);
    }
    lines.push('', '');
    socket.write(lines.join('\r\n'));
    if (upHead && upHead.length) socket.write(upHead);
    if (head && head.length) upSocket.write(head);
    socket.pipe(upSocket).pipe(socket);
    // A blind byte relay cannot speak the WebSocket close handshake, and BOTH
    // sides of an upgraded socket are half-open by construction: pipe() forwards
    // a FIN upstream, but nothing ever closed the pair. So a browser tab that
    // navigated away (or a reload) left code-server / opencode holding the
    // session — and its memory — open until the process itself gave up. Verified
    // live: with only 'close'/'error' listeners a client FIN left the upstream
    // socket readable-ended and open indefinitely.
    //
    // Completing the close on the first FIN is the fix: graceful end() first so
    // bytes already in flight are flushed (destroy() alone drops them), then a
    // guaranteed destroy so the pair can never linger. Idempotent, because
    // 'end', 'close' and 'error' can all fire for one teardown.
    let torn = false;
    const teardown = () => {
      if (torn) return;
      torn = true;
      socket.end();
      upSocket.end();
      const kill = setTimeout(() => {
        socket.destroy();
        upSocket.destroy();
      }, 250);
      kill.unref?.();
    };
    socket.on('end', teardown);
    upSocket.on('end', teardown);
    socket.on('error', teardown);
    upSocket.on('error', teardown);
    socket.on('close', teardown);
    upSocket.on('close', teardown);
  });

  // An upstream that answers a normal (non-101) response to an upgrade request
  // (a restart mid-handshake, an auth redirect) still has to reach the browser
  // as a real HTTP response instead of an abrupt reset.
  upstreamReq.on('response', (upRes) => {
    clearTimeout(upgradeDeadline);
    if (upRes.statusCode === 101) return;
    const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage || ''}`];
    const headers = stripHopByHop(upRes.headers as Record<string, string | string[] | undefined>);
    const location = headers.location;
    if (location !== undefined) {
      const rewritten = rewriteLocation(String(location), route.surface);
      if (rewritten) headers.location = rewritten;
      else delete headers.location;
    }
    for (const [key, value] of Object.entries(headers)) {
      if (Array.isArray(value)) for (const v of value) lines.push(`${key}: ${v}`);
      else if (value !== undefined) lines.push(`${key}: ${value}`);
    }
    lines.push('', '');
    socket.write(lines.join('\r\n'));
    upRes.pipe(socket);
    socket.on('error', () => upRes.destroy());
    socket.on('close', () => upRes.destroy());
  });

  upstreamReq.on('error', () => {
    clearTimeout(upgradeDeadline);
    // Once the relay is spliced these two sockets ARE one WebSocket byte
    // stream: writing an HTTP response into it would inject a response body
    // into a frame stream the browser is already parsing. Tear the pair down.
    if (spliced) {
      socket.destroy();
      return;
    }
    if (!socket.destroyed && !socket.writableEnded) {
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    }
  });
  socket.on('error', () => upstreamReq.destroy());
  socket.on('close', () => upstreamReq.destroy());
  upstreamReq.end();
}

/**
 * Start the embedded-surface proxy. Returns the listening server (for tests and
 * for a graceful shutdown).
 */
export function startEmbedProxy(port: number = EMBED_PROXY_PORT): http.Server {
  const server = http.createServer();

  server.on('request', (req, res) => {
    const pathname = (req.url || '/').split('?')[0];
    if (pathname === '/favicon.ico') {
      // Never let the proxy's own origin 404 into opencode's asset space.
      refuse(res, 404, 'Not found');
      return;
    }
    try {
      proxyHttp(req, res, pathname);
    } catch {
      refuse(res, 502, 'The embedded surface is not responding');
    }
  });

  server.on('upgrade', (req, socket, head) => {
    const pathname = (req.url || '/').split('?')[0];
    try {
      proxyUpgrade(req, socket, head, pathname);
    } catch {
      socket.destroy();
    }
  });

  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(
      `[Madar] Embedded-surface proxy on 0.0.0.0:${port} (authenticated: editor+ session cookie) ` +
        `→ code-server 127.0.0.1:${IDE_UPSTREAM_PORT} at /ide, opencode 127.0.0.1:${OPENCODE_UPSTREAM_PORT} at /`,
    );
  });
  server.on('error', (err) => {
    // A failed bind (EADDRINUSE, EACCES) used to be logged and then ignored, so
    // both status routes kept reporting the surfaces as running while every
    // frame pointed at a port nothing answers. It is fail-CLOSED — the only
    // route to the upstreams is simply gone, which is the safe direction — so
    // the process stays up (the dashboard is still useful) and the honest
    // `running:false` comes from embedProxyListening() above.
    listenError = err.message;
    console.error(
      `[Madar] Embedded-surface proxy failed to start on :${port}: ${err.message} — ` +
        `the IDE and opencode will report as NOT running until this is fixed (docker compose logs app).`,
    );
  });
  proxyServer = server;
  return server;
}
