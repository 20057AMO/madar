import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { register } from 'node:module';

register(new URL('./ts-ext-resolve.mjs', import.meta.url).href);

const {
  parseTrustedProxies,
  trustedProxyExposureWarning,
  trustedProxyWarning,
  configureTrustedProxy,
  isTrustedProxyPeer,
} = await import('../src/services/proxy-trust-core.ts');
const { embedCookieSecure } = await import('../src/services/embed-core.ts');

function fakeApp(): { app: { set(key: string, value: unknown): unknown }; calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = [];
  const app = {
    set(key: string, value: unknown) {
      calls.push([key, value]);
      return app;
    },
  };
  return { app, calls };
}

function listen(app: ReturnType<typeof express>): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function getJson(port: number, url: string, headers: Record<string, string> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('trusted proxy configuration parsing', () => {
  test('unset, empty, zero and false env values keep Express at its safe default', () => {
    assert.strictEqual(parseTrustedProxies({}), undefined);
    assert.strictEqual(parseTrustedProxies({ WSD_TRUST_PROXY: '0' }), undefined);
    assert.strictEqual(parseTrustedProxies({ WSD_TRUST_PROXY: 'false' }), undefined);
    assert.strictEqual(parseTrustedProxies({ WSD_TRUSTED_PROXIES: '' }), undefined);
    assert.strictEqual(parseTrustedProxies({ WSD_TRUSTED_PROXIES: '0' }), undefined);
    assert.strictEqual(parseTrustedProxies({ WSD_TRUSTED_PROXIES: 'false' }), undefined);
  });

  test('legacy WSD_TRUST_PROXY=1 or true keeps the old one-hop allowlist', () => {
    assert.deepStrictEqual(parseTrustedProxies({ WSD_TRUST_PROXY: '1' }), ['loopback', 'uniquelocal']);
    assert.deepStrictEqual(parseTrustedProxies({ WSD_TRUST_PROXY: ' TRUE ' }), ['loopback', 'uniquelocal']);
  });

  test('an explicit WSD_TRUSTED_PROXIES list overrides legacy and accepts aliases, IPs and CIDRs', () => {
    const parsed = parseTrustedProxies({
      WSD_TRUST_PROXY: '1',
      WSD_TRUSTED_PROXIES: 'loopback, 203.0.113.10 10.0.0.0/8,2001:db8::/32, loopback',
    });
    assert.deepStrictEqual(parsed, ['loopback', '203.0.113.10', '10.0.0.0/8', '2001:db8::/32']);
  });

  test('junk, wildcard CIDRs and invalid prefixes are refused; wildcard is warned about', () => {
    const env = {
      WSD_TRUSTED_PROXIES: 'junk.example 0.0.0.0/0 ::/0 10.0.0.0/33 203.0.113.11/30 loopback',
    };
    assert.deepStrictEqual(parseTrustedProxies(env), ['203.0.113.11/30', 'loopback']);
    assert.strictEqual(
      trustedProxyWarning(env),
      'Ignoring trusted proxy entry 0.0.0.0/0: a wildcard would let any client spoof X-Forwarded-For.'
    );
    assert.strictEqual(trustedProxyWarning({ WSD_TRUSTED_PROXIES: 'loopback' }), null);
    assert.strictEqual(trustedProxyWarning({ WSD_TRUST_PROXY: '1' }), null);
  });

  test('configureTrustedProxy sets Express trust only for a non-empty parsed list', () => {
    const empty = fakeApp();
    assert.strictEqual(configureTrustedProxy(empty.app, { WSD_TRUSTED_PROXIES: '' }), undefined);
    assert.deepStrictEqual(empty.calls, []);

    const configured = fakeApp();
    assert.deepStrictEqual(configureTrustedProxy(configured.app, { WSD_TRUST_PROXY: '1' }), ['loopback', 'uniquelocal']);
    assert.deepStrictEqual(configured.calls, [['trust proxy', ['loopback', 'uniquelocal']]]);
  });
});

describe('trusted proxy peer matching', () => {
  test('aliases cover IPv4, IPv6 and IPv4-mapped peers only inside their ranges', () => {
    assert.strictEqual(isTrustedProxyPeer('127.0.0.1', ['loopback']), true);
    assert.strictEqual(isTrustedProxyPeer('::1', ['loopback']), true);
    assert.strictEqual(isTrustedProxyPeer('::ffff:127.0.0.1', ['loopback']), true);
    assert.strictEqual(isTrustedProxyPeer('169.254.1.1', ['linklocal']), true);
    assert.strictEqual(isTrustedProxyPeer('fe80::1', ['linklocal']), true);
    assert.strictEqual(isTrustedProxyPeer('192.168.1.10', ['uniquelocal']), true);
    assert.strictEqual(isTrustedProxyPeer('172.16.0.1', ['uniquelocal']), true);
    assert.strictEqual(isTrustedProxyPeer('172.15.0.1', ['uniquelocal']), false);
    assert.strictEqual(isTrustedProxyPeer('fc00::1', ['uniquelocal']), true);
    assert.strictEqual(isTrustedProxyPeer('8.8.8.8', ['loopback', 'linklocal', 'uniquelocal']), false);
  });

  test('exact IPs and IPv4/IPv6 CIDRs match by network, including IPv4-mapped peers', () => {
    assert.strictEqual(isTrustedProxyPeer('203.0.113.10', ['203.0.113.10']), true);
    assert.strictEqual(isTrustedProxyPeer('::ffff:203.0.113.10', ['203.0.113.10']), true);
    assert.strictEqual(isTrustedProxyPeer('203.0.113.11', ['203.0.113.10']), false);
    assert.strictEqual(isTrustedProxyPeer('10.1.2.3', ['10.0.0.0/8']), true);
    assert.strictEqual(isTrustedProxyPeer('10.1.2.3', ['10.2.0.0/16']), false);
    assert.strictEqual(isTrustedProxyPeer('2001:db8::5', ['2001:db8::/32']), true);
    assert.strictEqual(isTrustedProxyPeer('2001:db9::5', ['2001:db8::/32']), false);
  });

  test('invalid peers and empty trust lists never trust a forwarded header', () => {
    assert.strictEqual(isTrustedProxyPeer('not-an-ip', ['loopback']), false);
    assert.strictEqual(isTrustedProxyPeer(undefined, ['loopback']), false);
    assert.strictEqual(isTrustedProxyPeer('127.0.0.1', undefined), false);
    assert.strictEqual(isTrustedProxyPeer('127.0.0.1', []), false);
  });

  test('embedCookieSecure honors X-Forwarded-Proto only from a trusted peer', () => {
    assert.strictEqual(
      embedCookieSecure({
        forwardedProto: 'https',
        trustProxy: isTrustedProxyPeer('127.0.0.1', ['loopback']),
      }),
      true
    );
    assert.strictEqual(
      embedCookieSecure({
        forwardedProto: 'https',
        trustProxy: isTrustedProxyPeer('127.0.0.1', ['203.0.113.10']),
      }),
      false
    );
    assert.strictEqual(
      embedCookieSecure({ encrypted: true, trustProxy: false }),
      true
    );
  });
});

describe('Express X-Forwarded-For behavior', () => {
  test('a loopback proxy is trusted and its forwarded ip becomes req.ip', async () => {
    const app = express();
    configureTrustedProxy(app, { WSD_TRUSTED_PROXIES: 'loopback' });
    app.get('/ip', (req: any, res: any) => res.json({ ip: req.ip, ips: req.ips }));
    const server = await listen(app);
    try {
      const port = (server.address() as { port: number }).port;
      const body = await getJson(port, '/ip', { 'x-forwarded-for': '203.0.113.10' });
      assert.strictEqual(body.ip, '203.0.113.10');
      assert.deepStrictEqual(body.ips, ['203.0.113.10']);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('a non-allowlisted peer is untrusted and cannot rewrite req.ip', async () => {
    const app = express();
    configureTrustedProxy(app, { WSD_TRUSTED_PROXIES: '203.0.113.10' });
    app.get('/ip', (req: any, res: any) => res.json({ ip: req.ip, ips: req.ips }));
    const server = await listen(app);
    try {
      const port = (server.address() as { port: number }).port;
      const body = await getJson(port, '/ip', { 'x-forwarded-for': '203.0.113.10' });
      assert.strictEqual(body.ip, '127.0.0.1');
      assert.deepStrictEqual(body.ips, []);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('wildcard publish exposure warning', () => {
  test('warns only when trusted proxies are configured and publish host is 0.0.0.0', () => {
    const expected =
      'Trusted proxies are enabled while WSD_EMBEDDED_PUBLISH_HOST resolves to 0.0.0.0; ' +
      'the authenticated IDE/proxy surface is published on all interfaces. ' +
      'Terminate TLS and restrict access at the reverse proxy.';
    assert.strictEqual(
      trustedProxyExposureWarning({ WSD_EMBEDDED_PUBLISH_HOST: '0.0.0.0', WSD_TRUSTED_PROXIES: 'loopback' }),
      expected
    );
    assert.strictEqual(
      trustedProxyExposureWarning({ WSD_EMBEDDED_PUBLISH_HOST: '0.0.0.0', WSD_TRUST_PROXY: '1' }),
      expected
    );
    assert.strictEqual(
      trustedProxyExposureWarning({ WSD_EMBEDDED_PUBLISH_HOST: '0.0.0.0', WSD_TRUSTED_PROXIES: '0.0.0.0/0' }),
      null
    );
    assert.strictEqual(trustedProxyExposureWarning({ WSD_TRUSTED_PROXIES: 'loopback' }), null);
    assert.strictEqual(
      trustedProxyExposureWarning({ WSD_EMBEDDED_PUBLISH_HOST: '127.0.0.1', WSD_TRUSTED_PROXIES: 'loopback' }),
      null
    );
    assert.strictEqual(
      trustedProxyExposureWarning({ WSD_EMBEDDED_PUBLISH_HOST: ' 0.0.0.0 ', WSD_TRUST_PROXY: 'true' }),
      expected
    );
  });
});

describe('trusted proxy wiring', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'index.ts'), 'utf8');

  test('index.ts configures the explicit allowlist and gates forwarded-proto on the peer', () => {
    assert.match(source, /configureTrustedProxy\(app, process\.env\)/);
    assert.match(source, /isTrustedProxyPeer\(req\?\.socket\?\.remoteAddress, trustedProxies\)/);
    assert.doesNotMatch(source, /app\.set\('trust proxy', 1\)/);
    assert.doesNotMatch(source, /WSD_TRUST_PROXY === '1'/);
  });

  test('limiter keys are req.ip only, never a socket address or raw forwarded header', () => {
    const limiterIps = source.match(/const ip = [^\n]+/g) || [];
    assert.ok(limiterIps.length >= 4, 'expected all limiter IP declarations');
    for (const declaration of limiterIps) {
      assert.match(declaration, /String\(req\.ip \?\? 'unknown'\)/);
      assert.doesNotMatch(declaration, /socket/i);
    }
    assert.match(source, /checkUserWrite\(req\?\.user\?\.id\s*,\s*req\?\.ip\b/);
    assert.match(source, /x-forwarded-proto/, 'expected forwarded-proto gating on trusted peer');
    assert.doesNotMatch(source, /x-forwarded-for/i, 'raw forwarded headers must never feed a limiter key');
  });

  test('startup logs both trust warnings through the existing [madar] path without failing boot', () => {
    assert.match(source, /trustedProxyExposureWarning\(process\.env\)/);
    assert.match(source, /\[madar\] \$\{warning\}/);
    assert.match(source, /console\.warn/);
    assert.doesNotMatch(source, /throw new Error\(warning\)/);
  });
});
