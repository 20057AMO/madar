/**
 * embed-proxy.test.ts — the authenticated embedded-surface proxy, offline.
 *
 * The proxy is the ONLY route to code-server and opencode, and both execute code
 * as root beside the docker socket, so its credential boundary is the security
 * boundary of the whole RCE fix. The live suite (tests/embedded-access.test.ts)
 * can only prove a few 401/403/200 rows against the running container; everything
 * that must be provable WITHOUT Docker lives here:
 *
 *   - a missing / junk / viewer / demoted / revoked / dashboard-session cookie
 *     never reaches an upstream, and the upstream is never even contacted;
 *   - a live editor+ cookie does reach it, with the Cookie and Authorization
 *     headers stripped and the path mapped per surface;
 *   - the cookie cannot be used as a dashboard session (verifyToken refuses a
 *     scope:'embed' token) — and a dashboard token is not a proxy credential;
 *   - the websocket upgrade obeys the same gate, relays bytes, tears down on
 *     half-close, never injects an HTTP response into a spliced frame stream,
 *     and is bounded when the upstream stalls mid-handshake;
 *   - a failed bind is reported as not-listening (the honest-status contract).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { register } from 'node:module';
import { EMBED_COOKIE_NAME, resolveEmbedRoute } from '../src/services/embed-core.ts';

// The wiring modules under test import each other extensionless, which node's ESM
// loader cannot resolve — see tests/ts-ext-resolve.mjs for why, and for what the
// hook does and does not rewrite.
const HOOK_URL = new URL('./ts-ext-resolve.mjs', import.meta.url).href;
register(HOOK_URL);

// Must clear the resolver's own bar (>= 32 chars, not a known-weak literal) or
// user-store would refuse it and sign with a generated secret instead.
const JWT = 'embed-proxy-suite-secret-0123456789abcdef';
const PASSWORD = 'embed-proxy-pass';

const ADMIN = { id: 'u-admin', username: 'owner', role: 'admin' as const };
const EDITOR = { id: 'u-editor', username: 'builder', role: 'editor' as const };
const VIEWER = { id: 'u-viewer', username: 'watcher', role: 'viewer' as const };
const EDITOR_2 = { id: 'u-editor2', username: 'builder2', role: 'editor' as const };

// ── fake upstreams ─────────────────────────────────────────────

interface Seen {
  surface: string;
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
}

type WsBehavior = 'relay' | 'stall' | 'die-after-handshake' | 'forbidden';

let seen: Seen[] = [];
let upgrades: Seen[] = [];
let wsBehavior: WsBehavior = 'relay';
/** Sockets the fake upstream handed out, so close-propagation can be observed. */
let upstreamSockets: net.Socket[] = [];
/** Every connection the fakes accepted (plain HTTP keep-alive AND upgrades). */
const inboundSockets = new Set<net.Socket>();
/** Reply the next HTTP request to the fake opencode with (302 → absolute Location). */
let ideReply: () => { status: number; headers: Record<string, string>; body: string } = () => ({
  status: 200,
  headers: {},
  body: 'ide-upstream',
});
/** Kill the next request at the socket level (an upstream dying mid-request). */
let killNextOpencode = false;

function makeUpstream(surface: string, reply: () => { status: number; headers: Record<string, string>; body: string }) {
  const server = http.createServer((req, res) => {
    if (surface === 'opencode' && killNextOpencode) {
      killNextOpencode = false;
      req.socket.destroy();
      return;
    }
    seen.push({ surface, method: req.method || 'GET', url: req.url || '/', headers: req.headers });
    const r = reply();
    res.writeHead(r.status, r.headers);
    res.end(r.body);
  });
  server.on('upgrade', (req, socket, head) => {
    upgrades.push({ surface, method: req.method || 'GET', url: req.url || '/', headers: req.headers });
    upstreamSockets.push(socket);
    socket.on('error', () => { /* the proxy tears these down on purpose */ });
    if (wsBehavior === 'forbidden') {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if (wsBehavior === 'stall') return; // accepts the TCP connection, never handshakes
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    if (head?.length) socket.write(head);
    if (wsBehavior === 'die-after-handshake') {
      socket.destroy();
      return;
    }
    // relay mode: echo every byte, so the byte-level relay is observable, and
    // complete the close like a real server does on a peer FIN (code-server and
    // opencode both end their side — an upgraded socket never closes by itself).
    socket.on('data', (b) => socket.write(Buffer.concat([Buffer.from('echo:'), b])));
    socket.on('end', () => socket.end());
  });
  server.on('connection', (socket) => {
    inboundSockets.add(socket);
    socket.on('close', () => inboundSockets.delete(socket));
  });
  return server;
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve(addr.port);
    });
  });
}

async function waitFor(fn: () => boolean | Promise<boolean>, ms: number, label: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out after ${ms}ms waiting for: ${label}`);
}

// ── environment before the env-reading modules load ────────────

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsd-embed-proxy-'));
const passwordHash = bcrypt.hashSync(PASSWORD, 10);
fs.writeFileSync(
  path.join(dataDir, 'users.json'),
  JSON.stringify({
    users: [ADMIN, EDITOR, VIEWER, EDITOR_2].map((u) => ({
      ...u,
      passwordHash,
      createdAt: '2026-01-01T00:00:00.000Z',
      tokenVersion: 0,
    })),
  }, null, 2),
);

const ideUpstream = makeUpstream('ide', () => ideReply());
const opencodeUpstream = makeUpstream('opencode', () => ({ status: 200, headers: {}, body: 'opencode-upstream' }));
const idePort = await listen(ideUpstream);
const opencodePort = await listen(opencodeUpstream);

process.env.WSD_DATA_DIR = dataDir;
process.env.JWT_SECRET = JWT;
process.env.WSD_IDE_INTERNAL_PORT = String(idePort);
process.env.WSD_OPENCODE_PORT = String(opencodePort);
process.env.WSD_EMBED_UPGRADE_TIMEOUT_MS = '400';

const store = await import('../src/services/user-store.ts');
const { startEmbedProxy, embedProxyListening, embedProxyListenError } = await import('../src/services/embed-proxy.ts');

const proxy = startEmbedProxy(0);
await new Promise<void>((resolve, reject) => {
  proxy.once('listening', () => resolve());
  proxy.once('error', reject);
});
const PROXY_PORT = (proxy.address() as net.AddressInfo).port;

function cookieFor(userId: string): string {
  const token = store.signEmbedToken(userId);
  assert.ok(token, `no embed token minted for ${userId}`);
  return `${EMBED_COOKIE_NAME}=${token}`;
}

function get(pathname: string, cookie?: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PROXY_PORT,
        path: pathname,
        method: 'GET',
        // No keep-alive: a pooled socket would keep the proxy server (and the
        // two fakes) from ever closing, and the suite would hang in teardown.
        agent: false,
        headers: cookie ? { Cookie: cookie } : {},
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** A raw upgrade handshake, so the 401/101 bytes and the relay are both observable. */
let clientSockets: net.Socket[] = [];

function upgrade(pathname: string, cookie?: string): Promise<{ status: number; raw: string; socket: net.Socket; text: () => string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(PROXY_PORT, '127.0.0.1');
    clientSockets.push(socket);
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end === -1) return;
      socket.removeListener('data', onData);
      const head = buf.subarray(0, end + 4).toString('utf8');
      const status = Number(head.split(' ')[1] || 0);
      const rest = buf.subarray(end + 4);
      let text = rest.toString('utf8');
      socket.on('data', (c) => { text += c.toString('utf8'); });
      resolve({ status, raw: head + text, socket, text: () => text });
    };
    socket.on('data', onData);
    socket.on('error', reject);
    socket.on('connect', () => {
      const lines = [
        `GET ${pathname} HTTP/1.1`,
        `Host: 127.0.0.1:${PROXY_PORT}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      ];
      if (cookie) lines.push(`Cookie: ${cookie}`);
      socket.write(lines.join('\r\n') + '\r\n\r\n');
    });
  });
}

before(() => {
  seen = [];
  upgrades = [];
  upstreamSockets = [];
});

after(async () => {
  // Client sockets FIRST, and unconditionally: a failed row that skipped its own
  // cleanup would otherwise leave a spliced relay pair alive (an upgraded socket
  // is detached from server connection tracking, so neither close() nor
  // closeAllConnections() reaches it) and hang the whole suite instead of
  // reporting the failure.
  for (const socket of clientSockets) socket.destroy();
  // The proxy's own OUTBOUND sockets are pooled by the global agent (keep-alive
  // is on by default since Node 19), so they are only reachable through it.
  http.globalAgent.destroy();
  await new Promise((r) => setTimeout(r, 100));
  for (const socket of upstreamSockets) socket.destroy();
  for (const socket of inboundSockets) socket.destroy();
  for (const server of [proxy, ideUpstream, opencodeUpstream]) {
    try {
      server.closeAllConnections();
      await Promise.race([
        new Promise<void>((r) => server.close(() => r())),
        new Promise<void>((r) => setTimeout(r, 2000)),
      ]);
    } catch (err) {
      console.error('teardown:', (err as Error).message);
    }
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ── HTTP boundary ──────────────────────────────────────────────

describe('embedded proxy — HTTP credential boundary', () => {
  test('the credential is a scope-limited token a dashboard session can never be', () => {
    const embedToken = store.signEmbedToken(ADMIN.id);
    assert.ok(embedToken);
    const decoded = jwt.decode(embedToken) as { scope?: string; id?: string };
    assert.strictEqual(decoded.scope, 'embed');
    assert.strictEqual(decoded.id, ADMIN.id);
    // The one-way door: an embed token is NOT a dashboard session.
    assert.strictEqual(store.verifyToken(embedToken), null, 'verifyToken accepted a scope:embed token');
    // …and a dashboard session is not a proxy credential.
    const sessionToken = jwt.sign({ id: ADMIN.id, username: ADMIN.username, role: 'admin' }, JWT, { expiresIn: '1h' });
    assert.ok(store.verifyToken(sessionToken), 'the forged dashboard session should be a valid session');
    assert.strictEqual(store.verifyEmbedToken(sessionToken), null, 'verifyEmbedToken accepted a dashboard session');
  });

  test('a missing cookie is refused and the upstream is never contacted', async () => {
    seen = [];
    const res = await get('/ide/');
    assert.strictEqual(res.status, 401);
    assert.match(res.body, /session/i);
    assert.deepStrictEqual(seen, [], 'the IDE upstream answered a request with no cookie');
  });

  test('a junk / empty / foreign-name cookie is refused', async () => {
    seen = [];
    for (const cookie of ['', `${EMBED_COOKIE_NAME}=`, `${EMBED_COOKIE_NAME}=not-a-jwt`, 'session=abc', `${EMBED_COOKIE_NAME}=a.b.c`]) {
      const res = await get('/ide/', cookie);
      assert.strictEqual(res.status, 401, `cookie ${JSON.stringify(cookie)} was not refused`);
    }
    assert.deepStrictEqual(seen, []);
  });

  test('a viewer cookie is refused and never reaches an upstream', async () => {
    seen = [];
    const res = await get('/ide/', cookieFor(VIEWER.id));
    assert.strictEqual(res.status, 403);
    assert.match(res.body, /editor/i);
    assert.deepStrictEqual(seen, [], 'a viewer credential reached an upstream');
  });

  test('a demoted editor loses access on the very next request (role read live)', async () => {
    seen = [];
    const cookie = cookieFor(EDITOR_2.id);
    assert.strictEqual((await get('/ide/', cookie)).status, 200);
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(store.updateUserRole(EDITOR_2.id, 'viewer'), true);
    const after = await get('/ide/', cookie);
    assert.strictEqual(after.status, 403, 'a demoted user kept proxy access');
    assert.strictEqual(seen.length, 1, 'the demoted request still reached the upstream');
    store.updateUserRole(EDITOR_2.id, 'editor');
    assert.strictEqual((await get('/ide/', cookie)).status, 200, 're-promotion did not restore access');
  });

  test('a revoked (logout-everywhere) cookie dies with the session version', async () => {
    const cookie = cookieFor(EDITOR.id);
    assert.strictEqual((await get('/ide/', cookie)).status, 200);
    await store.revokeAllSessions(); // bumps tokenVersion for every user
    const after = await get('/ide/', cookie);
    assert.strictEqual(after.status, 401, 'a revoked embed cookie was still honoured');
    // A freshly minted one is fine: revocation is not a ban.
    assert.strictEqual((await get('/ide/', cookieFor(EDITOR.id))).status, 200);
  });

  test('a deleted user loses access even though the cookie is still unexpired', async () => {
    seen = [];
    // A throwaway account, so deleting it cannot break the rows that follow.
    const ghost = await store.createUser('ghostdel', PASSWORD, 'editor', ADMIN.id);
    const cookie = cookieFor(ghost.id);
    assert.strictEqual((await get('/ide/', cookie)).status, 200);
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(store.deleteUser(ghost.id), true);
    const after = await get('/ide/', cookie);
    assert.strictEqual(after.status, 401, 'a deleted user kept proxy access until the cookie expired');
    assert.strictEqual(seen.length, 1, 'the deleted user still reached an upstream');
  });

  test('editor+ reaches the IDE upstream with the cookie and Authorization stripped', async () => {
    seen = [];
    const res = await get('/ide/?folder=/workspaces/demo', cookieFor(EDITOR.id));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body, 'ide-upstream');
    assert.strictEqual(seen.length, 1);
    const hit = seen[0];
    assert.strictEqual(hit.surface, 'ide');
    assert.strictEqual(hit.url, '/?folder=/workspaces/demo', 'the /ide prefix must be stripped for code-server');
    assert.strictEqual(hit.headers.cookie, undefined, 'the proxy cookie leaked downstream');
    assert.strictEqual(hit.headers.authorization, undefined, 'a dashboard Authorization header leaked downstream');
    assert.strictEqual(hit.headers['x-forwarded-host'], `127.0.0.1:${PROXY_PORT}`);
    assert.ok(hit.headers['x-forwarded-proto'], 'X-Forwarded-Proto missing');
  });

  test('the origin root is opencode, and an upstream cannot clobber the embed cookie', async () => {
    seen = [];
    ideReply = () => ({
      status: 200,
      headers: { 'Set-Cookie': `${EMBED_COOKIE_NAME}=pwned; Path=/; HttpOnly` },
      body: 'ide-upstream',
    });
    try {
      const res = await get('/ide/', cookieFor(EDITOR.id));
      const cookies = res.headers['set-cookie'] as unknown as string[] | undefined;
      assert.ok(!cookies || !cookies.some((c) => c.startsWith(EMBED_COOKIE_NAME)), 'the upstream clobbered the embed cookie');
    } finally {
      ideReply = () => ({ status: 200, headers: {}, body: 'ide-upstream' });
    }
    const oc = await get('/', cookieFor(EDITOR.id));
    assert.strictEqual(oc.status, 200);
    assert.strictEqual(oc.body, 'opencode-upstream');
    assert.strictEqual(seen[seen.length - 1].surface, 'opencode');
    assert.strictEqual(seen[seen.length - 1].url, '/');
    // /idex and /ideas stay opencode's own routes (the regression that splits the
    // two surfaces must never widen into the IDE prefix).
    assert.strictEqual(resolveEmbedRoute('/idex').surface, 'opencode');
    assert.strictEqual(resolveEmbedRoute('/ideas').surface, 'opencode');
    assert.strictEqual(resolveEmbedRoute('/ide').surface, 'ide');
  });

  test('a Location from an upstream is re-pointed at the proxy origin, never the internal port', async () => {
    ideReply = () => ({
      status: 302,
      headers: { Location: `http://127.0.0.1:${idePort}/?folder=/x` },
      body: '',
    });
    try {
      const res = await get('/ide/', cookieFor(EDITOR.id));
      assert.strictEqual(res.status, 302);
      const location = String(res.headers.location);
      assert.ok(location.startsWith('/ide'), `Location not root-relative at the proxy: ${location}`);
      assert.ok(!location.includes(String(idePort)), `Location still points at the internal port: ${location}`);
    } finally {
      ideReply = () => ({ status: 200, headers: {}, body: 'ide-upstream' });
    }
  });

  test('a dead upstream is a 502 on the proxy origin, not a crash', async () => {
    killNextOpencode = true;
    const res = await get('/', cookieFor(EDITOR.id));
    assert.strictEqual(res.status, 502);
    assert.match(res.body, /not responding/i);
    // and the next request works again — a transient upstream death is not a
    // sticky failure state
    assert.strictEqual((await get('/', cookieFor(EDITOR.id))).status, 200);
  });
});

// ── websocket boundary ─────────────────────────────────────────

describe('embedded proxy — websocket upgrade boundary', () => {
  test('a missing cookie never reaches the upstream upgrade handler', async () => {
    upgrades = [];
    wsBehavior = 'relay';
    const res = await upgrade('/ide/', undefined);
    assert.strictEqual(res.status, 401);
    assert.match(res.raw, /401/);
    res.socket.destroy();
    await new Promise((r) => setTimeout(r, 50));
    assert.deepStrictEqual(upgrades, [], 'an unauthenticated upgrade reached the upstream');
  });

  test('a viewer upgrade is refused with 401 and no upstream handshake', async () => {
    upgrades = [];
    const res = await upgrade('/ide/', cookieFor(VIEWER.id));
    assert.strictEqual(res.status, 401);
    res.socket.destroy();
    await new Promise((r) => setTimeout(r, 50));
    assert.deepStrictEqual(upgrades, []);
  });

  test('editor+ is relayed byte-for-byte, and the cookie never crosses the wire', async () => {
    upgrades = [];
    wsBehavior = 'relay';
    const res = await upgrade('/ide/', cookieFor(EDITOR.id));
    assert.strictEqual(res.status, 101);
    assert.strictEqual(upgrades.length, 1);
    assert.strictEqual(upgrades[0].url, '/', 'the /ide prefix must be stripped before the upgrade too');
    assert.strictEqual(upgrades[0].headers.cookie, undefined, 'the embed cookie was forwarded upstream');
    res.socket.write('ping');
    await waitFor(() => res.text().includes('echo:ping'), 2000, 'the relayed echo');
    res.socket.destroy();
  });

  test('a client FIN completes the close in BOTH directions — no half-open relay', async () => {
    upgrades = [];
    upstreamSockets = [];
    wsBehavior = 'relay';
    const res = await upgrade('/ide/', cookieFor(EDITOR.id));
    assert.strictEqual(res.status, 101);
    const up = upstreamSockets[upstreamSockets.length - 1];
    let upEnd = false;
    let upClosed = false;
    let clientEnd = false;
    up.on('end', () => { upEnd = true; });
    up.on('close', () => { upClosed = true; });
    res.socket.on('end', () => { clientEnd = true; });

    res.socket.end(); // a browser tab closing / navigating away
    // 1. the FIN travels upstream (pipe does this on its own)…
    await waitFor(() => upEnd, 2000, 'the client FIN to reach the upstream socket');
    // 2. …and comes BACK. This is the regression: an upgraded socket is
    //    half-open by construction, so a relay that only listens for 'close'
    //    never completes the handshake and the pair sits open forever, holding
    //    the code-server / opencode session.
    await waitFor(() => clientEnd, 2000, 'the close to be completed back to the browser');
    // 3. and the whole pair is released
    await waitFor(() => upClosed, 2000, 'the upstream socket to be released');
    await waitFor(() => res.socket.destroyed, 2000, 'the browser socket to be released');
  });

  test('an abrupt browser disconnect (RST) releases the upstream too', async () => {
    upgrades = [];
    upstreamSockets = [];
    wsBehavior = 'relay';
    const res = await upgrade('/ide/', cookieFor(EDITOR.id));
    assert.strictEqual(res.status, 101);
    const up = upstreamSockets[upstreamSockets.length - 1];
    let upClosed = false;
    up.on('close', () => { upClosed = true; });
    res.socket.destroy(); // no FIN, no close frame — a crashed tab / killed network
    await waitFor(() => upClosed, 2000, 'the upstream socket to be destroyed after the client vanished');
  });

  test('an upstream error AFTER the splice tears down instead of injecting a 502 into the frame stream', async () => {
    upgrades = [];
    wsBehavior = 'die-after-handshake';
    const res = await upgrade('/ide/', cookieFor(EDITOR.id));
    assert.strictEqual(res.status, 101);
    await waitFor(() => res.socket.destroyed, 2000, 'the spliced socket to be torn down');
    // A 502 written into a spliced stream would corrupt the client's frame
    // parsing; the injected response is the whole regression.
    assert.ok(!res.text().includes('502'), `an HTTP response was injected into the websocket stream: ${JSON.stringify(res.raw)}`);
  });

  test('an upstream that stalls mid-handshake is bounded (no half-open hold)', async () => {
    upgrades = [];
    wsBehavior = 'stall';
    const started = Date.now();
    const res = await upgrade('/ide/', cookieFor(EDITOR.id));
    // The honest answer to a stalled handshake is a real 502 (the relay never
    // started, so there is no frame stream to corrupt) — NOT an open socket the
    // browser waits on until it gives up.
    assert.strictEqual(res.status, 502, `a stalled handshake answered ${res.status}`);
    assert.match(res.raw, /502/);
    await waitFor(() => res.socket.destroyed || res.socket.readableEnded, 3000, 'the upgrade socket to be closed');
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 3000, `the upgrade timeout did not bound the stall (${elapsed}ms)`);
    res.socket.destroy();
  });

  test('an upstream answering a non-101 to the upgrade is forwarded as a real response', async () => {
    upgrades = [];
    wsBehavior = 'forbidden';
    const res = await upgrade('/ide/', cookieFor(EDITOR.id));
    assert.strictEqual(res.status, 403);
    assert.match(res.raw, /Forbidden/);
    res.socket.destroy();
    wsBehavior = 'relay';
  });
});

// ── honest listen state ────────────────────────────────────────

describe('embedded proxy — listen state honesty', () => {
  test('a healthy proxy reports listening with no error', () => {
    assert.strictEqual(embedProxyListening(), true);
    assert.strictEqual(embedProxyListenError(), '');
  });

  test('a proxy that cannot bind reports NOT running (child process, occupied port)', async () => {
    // The blocker takes the SAME address the proxy binds (0.0.0.0), not just
    // loopback: Windows lets a 0.0.0.0 bind succeed alongside an existing
    // 127.0.0.1 bind on the same port, so a loopback-only blocker would make
    // this row pass vacuously — the "failed" proxy would really be listening.
    const blocker = http.createServer();
    await new Promise<void>((r) => blocker.listen(0, '0.0.0.0', () => r()));
    const taken = (blocker.address() as net.AddressInfo).port;
    // A separate process: the bind failure is a one-shot, and an occupied port in
    // THIS process would leave the suite's own proxy broken for the rows above.
    // The child binds an already-taken port and reports what the status contract
    // would then serve — the honest `running:false` the finding asked for.
    const script = `
      import { register } from 'node:module';
      register(${JSON.stringify(HOOK_URL)});
      const { startEmbedProxy, embedProxyListening, embedProxyListenError } =
        await import(${JSON.stringify(new URL('../src/services/embed-proxy.ts', import.meta.url).href)});
      startEmbedProxy(${taken});
      await new Promise((r) => setTimeout(r, 500));
      process.stdout.write(JSON.stringify({ listening: embedProxyListening(), error: embedProxyListenError() }));
      // A server object that failed to bind can still hold the loop open, and
      // this child has nothing left to do once the verdict is printed.
      process.exit(0);
    `;
    const { execFile } = await import('node:child_process');
    const out = await new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        ['--no-warnings', '--input-type=module', '-e', script],
        {
          timeout: 30_000,
          env: {
            ...process.env,
            WSD_IDE_INTERNAL_PORT: String(idePort),
            WSD_OPENCODE_PORT: String(opencodePort),
          },
        },
        (err, stdout) => (err ? reject(new Error(`${err.message}\n${stdout}`)) : resolve(stdout)),
      );
    });
    await new Promise<void>((r) => blocker.close(() => r()));
    // The child also prints the proxy's own startup banner on stdout, so take the
    // JSON line rather than the whole stream.
    const jsonLine = out.trim().split(/\r?\n/).filter((l) => l.trim().startsWith('{')).pop();
    assert.ok(jsonLine, `the child printed no verdict: ${JSON.stringify(out)}`);
    const parsed = JSON.parse(jsonLine) as { listening: boolean; error: string };
    assert.strictEqual(parsed.listening, false, 'a failed bind reported itself as running');
    assert.match(parsed.error, /EADDRINUSE|address already in use/i, `no honest bind error: ${JSON.stringify(parsed.error)}`);
  });
});
