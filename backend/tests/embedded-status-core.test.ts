/**
 * embedded-status-core.test.ts
 * Madar — offline unit coverage for the pure embedded-status cache rules
 * (createStatusCache / resolveEmbeddedPort) that back GET /api/ide/status and
 * GET /api/opencode/status. No server, no Docker, no sockets — the clock is
 * injected, so TTL behaviour is asserted without sleeping. Mirrors
 * serve-core.test.ts / project-alerts.test.ts.
 *
 * Contract:
 *  - Concurrent get() calls share ONE in-flight load (singleflight).
 *  - A result is reused for ttlMs, then the next get() probes again.
 *  - ttlMs <= 0 disables caching (every get() probes) but keeps singleflight.
 *  - get({fresh:true}) bypasses the cached snapshot.
 *  - invalidate() during an in-flight load must not let that stale result
 *    repopulate the cache (generation guard).
 *  - A rejected load is never cached; the next get() retries.
 *  - resolveEmbeddedPort degrades junk to the fallback, accepts a valid
 *    stringified port (tolerating surrounding whitespace).
 *  - resolveEmbeddedPublishHost / isLanReachableHost: a MISSING publish host
 *    means loopback (both embedded surfaces are unauthenticated, so the default
 *    must never be 0.0.0.0), and only a non-loopback interface reports LAN
 *    reachability.
 *  - probeEmbeddedPort answers true/false and NEVER throws or rejects — the
 *    one file of this round that talks to a real socket (loopback only).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import net from 'node:net';
import {
  createStatusCache,
  resolveEmbeddedPort,
  resolveEmbeddedPublishHost,
  isLanReachableHost,
  EMBEDDED_STATUS_DEFAULT_TTL_MS,
} from '../src/services/embedded-status-core.ts';
import {
  probeEmbeddedPort,
  EMBEDDED_PROBE_TIMEOUT_MS,
  type EmbeddedProbeConnect,
} from '../src/services/embedded-status-probe.ts';

/** Injectable clock + a load whose resolution the test drives by hand. */
function harness<T>(ttlMs: number, value: T) {
  let clock = 1_000;
  let calls = 0;
  const pending: Array<() => void> = [];
  const cache = createStatusCache<T>({
    ttlMs,
    now: () => clock,
    load: () => {
      calls += 1;
      return new Promise<T>((resolve) => pending.push(() => resolve(value)));
    },
  });
  return {
    cache,
    get calls() {
      return calls;
    },
    advance(ms: number) {
      clock += ms;
    },
    async settle() {
      while (pending.length > 0) pending.shift()!();
      await new Promise((r) => setImmediate(r));
    },
  };
}

describe('createStatusCache — singleflight', () => {
  test('N concurrent get() calls trigger exactly ONE load', async () => {
    const h = harness<string>(1_000, 'v1');
    const all = [h.cache.get(), h.cache.get(), h.cache.get(), h.cache.get(), h.cache.get()];
    assert.strictEqual(h.calls, 1, 'concurrent callers must share the in-flight load');
    await h.settle();
    assert.deepStrictEqual(await Promise.all(all), ['v1', 'v1', 'v1', 'v1', 'v1']);
    assert.strictEqual(h.calls, 1);
  });

  test('a fresh get() is never queued as a parallel probe while one is in flight', async () => {
    const h = harness<number>(1_000, 7);
    const a = h.cache.get();
    const b = h.cache.get({ fresh: true });
    await h.settle();
    assert.deepStrictEqual(await Promise.all([a, b]), [7, 7]);
    assert.strictEqual(h.calls, 1);
  });
});

describe('createStatusCache — TTL', () => {
  test('result is reused inside the window and re-probed after expiry', async () => {
    const h = harness<string>(4_000, 'v1');
    const first = h.cache.get();
    await h.settle();
    assert.strictEqual(await first, 'v1');
    assert.strictEqual(h.calls, 1);

    const warm = [h.cache.get(), h.cache.get()];
    await h.settle();
    await Promise.all(warm);
    assert.strictEqual(h.calls, 1, 'inside the TTL the probe is not repeated');

    h.advance(3_999);
    const almost = h.cache.get();
    await h.settle();
    await almost;
    assert.strictEqual(h.calls, 1, 'still inside the window');

    h.advance(2);
    const expired = h.cache.get();
    await h.settle();
    assert.strictEqual(await expired, 'v1');
    assert.strictEqual(h.calls, 2, 'past the TTL the next get() probes again');
  });

  test('get({fresh:true}) bypasses a warm cache', async () => {
    const h = harness<string>(10_000, 'v1');
    const first = h.cache.get();
    await h.settle();
    await first;
    assert.strictEqual(h.cache.debug().cacheAt, 1_000);

    const fresh = h.cache.get({ fresh: true });
    await h.settle();
    assert.strictEqual(await fresh, 'v1');
    assert.strictEqual(h.calls, 2);
  });

  test('ttlMs <= 0 means no caching — every get() probes', async () => {
    const h = harness<string>(0, 'v1');
    for (let i = 1; i <= 3; i++) {
      const p = h.cache.get();
      await h.settle();
      assert.strictEqual(await p, 'v1');
      assert.strictEqual(h.calls, i, 'no-cache mode must probe every time');
    }
    assert.strictEqual(h.cache.debug().cacheAt, null, 'nothing is ever cached');
  });

  test('default TTL is a short, restart-aware window', () => {
    assert.ok(
      EMBEDDED_STATUS_DEFAULT_TTL_MS > 0 && EMBEDDED_STATUS_DEFAULT_TTL_MS <= 10_000,
      'the probe cache must stay short enough to notice a process restart'
    );
  });
});

describe('createStatusCache — invalidate', () => {
  test('invalidate() drops the warm snapshot', async () => {
    const h = harness<string>(10_000, 'v1');
    const first = h.cache.get();
    await h.settle();
    await first;
    assert.strictEqual(h.calls, 1);

    h.cache.invalidate();
    assert.strictEqual(h.cache.debug().cacheAt, null);

    const second = h.cache.get();
    await h.settle();
    assert.strictEqual(await second, 'v1');
    assert.strictEqual(h.calls, 2, 'the next get() re-probes after invalidate');
  });

  test('invalidate() mid-flight does not let the stale result repopulate', async () => {
    const h = harness<string>(10_000, 'stale');
    const inflight = h.cache.get();
    h.cache.invalidate();
    await h.settle();
    assert.strictEqual(await inflight, 'stale', 'the in-flight caller still gets its value');
    assert.strictEqual(h.cache.debug().cacheAt, null, 'a stale in-flight result must not refill the cache');

    const next = h.cache.get();
    await h.settle();
    assert.strictEqual(await next, 'stale');
    assert.strictEqual(h.calls, 2, 'the following get() probes again instead of trusting the stale fill');
  });
});

describe('createStatusCache — failures', () => {
  test('a rejected load is never cached; the next get() retries', async () => {
    let calls = 0;
    const cache = createStatusCache<boolean>({
      ttlMs: 10_000,
      load: async () => {
        calls += 1;
        if (calls === 1) throw new Error('probe exploded');
        return true;
      },
    });

    await assert.rejects(() => cache.get(), /probe exploded/);
    assert.strictEqual(calls, 1);
    assert.strictEqual(cache.debug().cacheAt, null, 'a failed probe must not be cached');
    assert.strictEqual(await cache.get(), true);
    assert.strictEqual(calls, 2);
  });
});

describe('resolveEmbeddedPort', () => {
  test('junk degrades to the fallback instead of poisoning the probe', () => {
    assert.strictEqual(resolveEmbeddedPort(undefined, 8100), 8100);
    assert.strictEqual(resolveEmbeddedPort('', 8100), 8100);
    assert.strictEqual(resolveEmbeddedPort('   ', 8100), 8100);
    assert.strictEqual(resolveEmbeddedPort('abc', 8100), 8100);
    assert.strictEqual(resolveEmbeddedPort('0', 8100), 8100, '0 is never a real port');
    assert.strictEqual(resolveEmbeddedPort('-1', 8100), 8100);
    assert.strictEqual(resolveEmbeddedPort('99999', 8100), 8100, 'above the TCP range');
    assert.strictEqual(resolveEmbeddedPort('80.5', 8100), 8100, 'fractional');
    assert.strictEqual(resolveEmbeddedPort('1e3', 8100), 8100, 'scientific notation is not a literal port');
  });

  test('a valid stringified port is honored, whitespace tolerated', () => {
    assert.strictEqual(resolveEmbeddedPort('8100', 8080), 8100);
    assert.strictEqual(resolveEmbeddedPort(' 8100 ', 8080), 8100);
    assert.strictEqual(resolveEmbeddedPort('8080', 8100), 8080);
    assert.strictEqual(resolveEmbeddedPort('1', 8100), 1);
    assert.strictEqual(resolveEmbeddedPort('65535', 8100), 65535);
  });
});

describe('resolveEmbeddedPublishHost / isLanReachableHost', () => {
  test('an unset publish host degrades to LOOPBACK, never 0.0.0.0', () => {
    // Both embedded surfaces run unauthenticated, so the safe default must be
    // the one a missing value produces.
    assert.strictEqual(resolveEmbeddedPublishHost(undefined), '127.0.0.1');
    assert.strictEqual(resolveEmbeddedPublishHost(''), '127.0.0.1');
    assert.strictEqual(resolveEmbeddedPublishHost('   '), '127.0.0.1');
  });

  test('a real interface passes through, whitespace trimmed', () => {
    assert.strictEqual(resolveEmbeddedPublishHost('0.0.0.0'), '0.0.0.0');
    assert.strictEqual(resolveEmbeddedPublishHost(' 192.168.1.10 '), '192.168.1.10');
  });

  test('lanReachable is false for every loopback spelling and true for the rest', () => {
    assert.strictEqual(isLanReachableHost(undefined), false);
    assert.strictEqual(isLanReachableHost('127.0.0.1'), false);
    assert.strictEqual(isLanReachableHost('127.0.0.1 '), false);
    assert.strictEqual(isLanReachableHost('LOCALHOST'), false);
    assert.strictEqual(isLanReachableHost('::1'), false);
    assert.strictEqual(isLanReachableHost('0.0.0.0'), true);
    assert.strictEqual(isLanReachableHost('192.168.1.10'), true);
  });
});

// ── The wired sibling: the plain-TCP probe (loopback only, no Docker) ─────────

/** Bind a throwaway listener on 127.0.0.1:0 and hand back its (now dead) port. */
async function listen(): Promise<{ port: number; close: () => Promise<void> }> {
  const accepted: net.Socket[] = [];
  const server = net.createServer((s) => accepted.push(s));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as net.AddressInfo;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of accepted) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/** Run `fn` while watching for unhandled rejections (they surface a turn later). */
async function withRejectionWatch<T>(fn: () => Promise<T>): Promise<{ value: T; rejections: unknown[] }> {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    const value = await fn();
    await new Promise((r) => setImmediate(r));
    return { value, rejections };
  } finally {
    process.off('unhandledRejection', onRejection);
  }
}

describe('probeEmbeddedPort — an open listener', () => {
  test('resolves true well inside the timeout', async () => {
    const srv = await listen();
    try {
      const started = Date.now();
      const { value, rejections } = await withRejectionWatch(() => probeEmbeddedPort(srv.port, 1_000));
      assert.strictEqual(value, true, 'a listening loopback port must read as up');
      assert.ok(Date.now() - started < 500, 'a loopback connect must not wait for the ceiling');
      assert.deepStrictEqual(rejections, []);
    } finally {
      await srv.close();
    }
  });

  test('a listener that accepts but never sends a byte is still true (a connect-probe, not an HTTP GET)', async () => {
    // Honest deviation from the brief for this row: the handshake completes the
    // moment the peer accepts, so 'accepted but silent' is UP. The timeout
    // branch is unreachable on loopback and is covered with the injected
    // connector below. Pinned here so nobody 'fixes' this into a GET /.
    const srv = await listen();
    try {
      assert.strictEqual(await probeEmbeddedPort(srv.port, 200), true);
    } finally {
      await srv.close();
    }
  });
});

describe('probeEmbeddedPort — a closed port', () => {
  test('resolves false fast, with no rejected promise left behind', async () => {
    const srv = await listen();
    const deadPort = srv.port;
    await srv.close();

    const started = Date.now();
    const { value, rejections } = await withRejectionWatch(() => probeEmbeddedPort(deadPort, 2_000));
    const elapsed = Date.now() - started;
    assert.strictEqual(value, false, 'a port with no listener must read as down');
    assert.ok(elapsed < 1_000, `ECONNREFUSED must fail fast, took ${elapsed}ms`);
    assert.deepStrictEqual(rejections, [], 'a refused probe must not leak a rejection');
  });
});

describe('probeEmbeddedPort — the timeout branch', () => {
  test('a handshake that never completes resolves false AT the ceiling, socket destroyed once', async () => {
    // The branch a real socket cannot reach from loopback (ECONNREFUSED and a
    // completed handshake are both instant) — a SYN that is swallowed. Injected
    // connector, 200ms ceiling, so this asserts the cleanup without a 3s sleep.
    const ceiling = 200;
    let armedMs = -1;
    let destroys = 0;
    let timer: NodeJS.Timeout | null = null;
    // A real socket arms an idle timer; a fake that only records the value would
    // never fire and the probe would hang instead of resolving. destroy() clears
    // it, so a leaked timer keeps the runner's event loop alive.
    const stalled: EmbeddedProbeConnect = () => ({
      setTimeout(ms: number, cb: () => void) {
        armedMs = ms;
        timer = setTimeout(cb, ms);
      },
      once() { return undefined; },
      destroy() {
        destroys += 1;
        if (timer) { clearTimeout(timer); timer = null; }
      },
    });

    const started = Date.now();
    const { value, rejections } = await withRejectionWatch(() => probeEmbeddedPort(4096, ceiling, stalled));
    const elapsed = Date.now() - started;

    assert.strictEqual(value, false, 'a stalled handshake must read as down');
    assert.strictEqual(armedMs, ceiling, 'the ceiling must be armed on the socket');
    assert.ok(elapsed >= ceiling, `resolved before the ceiling (${elapsed}ms)`);
    assert.ok(elapsed < ceiling * 10, `the ceiling did not bound the wait (${elapsed}ms)`);
    assert.strictEqual(destroys, 1, 'the stalled socket must be destroyed exactly once');
    assert.deepStrictEqual(rejections, []);
  });

  test('the production ceiling stays above the 1.85s cold answer and bounded', () => {
    assert.ok(EMBEDDED_PROBE_TIMEOUT_MS >= 1_850);
    assert.ok(EMBEDDED_PROBE_TIMEOUT_MS <= 10_000);
  });
});

describe('probeEmbeddedPort — a port net.connect rejects outright', () => {
  test('never throws synchronously and never rejects, for any out-of-range port', async () => {
    // The exact shape Task 2 removes from the opencode path: net.connect THROWS
    // ERR_SOCKET_BAD_PORT synchronously for these, which the Promise executor
    // would turn into a rejection — an unhandled one in any non-awaiting caller.
    for (const port of [-1, 65_536, 99_999, 1.5, 0]) {
      let returned: Promise<boolean> | null = null;
      let syncThrow: unknown = null;
      try {
        returned = probeEmbeddedPort(port, 200);
      } catch (err) {
        syncThrow = err;
      }
      assert.strictEqual(syncThrow, null, `probeEmbeddedPort(${port}) threw synchronously`);
      assert.ok(returned instanceof Promise, `probeEmbeddedPort(${port}) returned no promise`);

      const { value, rejections } = await withRejectionWatch(() => returned as Promise<boolean>);
      assert.strictEqual(value, false, `port ${port} must resolve false`);
      assert.deepStrictEqual(rejections, [], `port ${port} leaked an unhandled rejection`);
    }
  });
});
