/**
 * embed-core.test.ts
 * Pure unit coverage for the authenticated embedded-surface proxy rules
 * (resolveEmbedRoute / rewriteLocation / prefixIdePath / stripHopByHop /
 * parseCookies / sanitizeSetCookie / cookie attributes). No server, no Docker,
 * no JWT secret - fully offline, mirroring serve-core.test.ts /
 * embedded-status-core.test.ts.
 *
 * These are the rules that decide WHICH upstream a browser request reaches.
 * A mistake here is a security bug, not a cosmetic one: opencode owns the
 * origin root and the IDE lives under /ide, so anything that leaks a
 * non-/ide path to code-server (or vice versa) changes what a request can
 * reach. The Location rules matter for the same reason - an unrewritten
 * absolute Location points the browser straight back at the now-unpublished
 * loopback port.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  EMBED_COOKIE_NAME,
  EMBED_IDE_PREFIX,
  resolveEmbedRoute,
  rewriteLocation,
  prefixIdePath,
  stripHopByHop,
  parseCookies,
  sanitizeSetCookie,
  embedCookieOptions,
  embedCookieClearOptions,
} from '../src/services/embed-core.ts';

describe('resolveEmbedRoute - surface ownership', () => {
  test('opencode owns the origin root', () => {
    assert.deepStrictEqual(resolveEmbedRoute('/'), { surface: 'opencode', upstreamPath: '/' });
    assert.deepStrictEqual(resolveEmbedRoute('/session'), { surface: 'opencode', upstreamPath: '/session' });
  });

  test('the IDE is mounted under /ide with the prefix stripped upstream', () => {
    assert.deepStrictEqual(resolveEmbedRoute('/ide'), { surface: 'ide', upstreamPath: '/' });
    assert.deepStrictEqual(resolveEmbedRoute('/ide/'), { surface: 'ide', upstreamPath: '/' });
    assert.deepStrictEqual(resolveEmbedRoute('/ide/_static/x.js'), {
      surface: 'ide',
      upstreamPath: '/_static/x.js',
    });
  });

  test('the deep-link forms both surfaces use', () => {
    // IDE ?folder= deep link; opencode base64url directory deep link.
    assert.deepStrictEqual(resolveEmbedRoute('/ide/'), { surface: 'ide', upstreamPath: '/' });
    assert.deepStrictEqual(resolveEmbedRoute('/L3dvcmtzcGFjZXMveW91dHViZQ/session'), {
      surface: 'opencode',
      upstreamPath: '/L3dvcmtzcGFjZXMveW91dHViZQ/session',
    });
  });

  test('an /ide-looking path that is NOT the mount point stays with opencode', () => {
    // Guards the naive startsWith('/ide') that would steal /idex from opencode.
    assert.deepStrictEqual(resolveEmbedRoute('/idex'), { surface: 'opencode', upstreamPath: '/idex' });
    assert.deepStrictEqual(resolveEmbedRoute('/ideas'), { surface: 'opencode', upstreamPath: '/ideas' });
  });

  test('non-string / relative junk degrades to the root, never throws', () => {
    assert.deepStrictEqual(resolveEmbedRoute(undefined as any), { surface: 'opencode', upstreamPath: '/' });
    assert.deepStrictEqual(resolveEmbedRoute(''), { surface: 'opencode', upstreamPath: '/' });
    // Not origin-form, so it is normalized to the root rather than trusted.
    assert.deepStrictEqual(resolveEmbedRoute('ide/'), { surface: 'opencode', upstreamPath: '/' });
  });

  test('a traversal attempt cannot escape the IDE prefix', () => {
    // The proxy passes the stripped path to code-server verbatim; the /ide
    // mount must still be the only entry point, so /ide/../x stays an IDE hop.
    assert.deepStrictEqual(resolveEmbedRoute('/ide/../x'), { surface: 'ide', upstreamPath: '/../x' });
  });
});

describe('rewriteLocation - never point back at an internal port', () => {
  test('an absolute loopback Location is made root-relative (opencode)', () => {
    assert.strictEqual(
      rewriteLocation('http://127.0.0.1:4096/session/abc', 'opencode'),
      '/session/abc',
    );
  });

  test('an absolute Location gets the /ide prefix added back', () => {
    assert.strictEqual(rewriteLocation('http://127.0.0.1:8080/?folder=/workspaces', 'ide'), '/ide/?folder=/workspaces');
  });

  test('the internal port cannot survive anywhere in a Location', () => {
    const out = rewriteLocation('https://opencode.internal:4096/a?b=1#c', 'opencode');
    assert.ok(out && !out.includes('4096'), `leaked the upstream port: ${out}`);
    assert.strictEqual(out, '/a?b=1#c');
  });

  test('protocol-relative Location loses its authority', () => {
    assert.strictEqual(rewriteLocation('//127.0.0.1:4096/x', 'opencode'), '/x');
    assert.strictEqual(rewriteLocation('//127.0.0.1:8080/x', 'ide'), '/ide/x');
  });

  test('dot-relative Location passes through untouched (the /ide follow chain)', () => {
    // code-server redirects root -> ./?folder=... ; the browser resolves this
    // against the URL it already has, which carries the /ide prefix.
    assert.strictEqual(rewriteLocation('./?folder=/workspaces', 'ide'), './?folder=/workspaces');
    assert.strictEqual(rewriteLocation('../up', 'ide'), '../up');
  });

  test('root-relative Location is prefixed for the IDE only', () => {
    assert.strictEqual(rewriteLocation('/x', 'ide'), '/ide/x');
    assert.strictEqual(rewriteLocation('/x', 'opencode'), '/x');
  });

  test('unusable / empty Location is dropped (null), never echoed', () => {
    assert.strictEqual(rewriteLocation('', 'opencode'), null);
    assert.strictEqual(rewriteLocation('   ', 'opencode'), null);
    assert.strictEqual(rewriteLocation('http://', 'opencode'), null);
    assert.strictEqual(rewriteLocation('javascript:alert(1)', 'opencode'), null);
    assert.strictEqual(rewriteLocation('not a path', 'opencode'), null);
  });
});

describe('prefixIdePath - idempotent', () => {
  test('adds the prefix once', () => {
    assert.strictEqual(prefixIdePath('/x'), '/ide/x');
    assert.strictEqual(prefixIdePath('/ide/x'), '/ide/x');
    assert.strictEqual(prefixIdePath('/ide'), '/ide');
    assert.strictEqual(prefixIdePath('/ide?x=1'), '/ide?x=1');
    assert.strictEqual(prefixIdePath('/'), '/ide/');
    assert.strictEqual(prefixIdePath(''), '/ide/');
  });

  test('the mount point is a single segment', () => {
    assert.strictEqual(EMBED_IDE_PREFIX, '/ide');
  });
});

describe('stripHopByHop - no smuggling primitives cross the hop', () => {
  test('drops every hop-by-hop header, incl. upgrade/transfer-encoding', () => {
    const out = stripHopByHop({
      connection: 'keep-alive, X-Secret',
      'keep-alive': 'timeout=5',
      'transfer-encoding': 'chunked',
      upgrade: 'websocket',
      te: 'trailers',
      trailer: 'x',
      'proxy-authenticate': 'Basic',
      'proxy-authorization': 'Basic x',
      'proxy-connection': 'keep-alive',
      host: 'proxy:4097',
      cookie: 'a=b',
    });
    for (const key of [
      'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te',
      'trailer', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection',
    ]) {
      assert.ok(!(key in out), `${key} survived the hop`);
    }
    assert.strictEqual(out.host, 'proxy:4097');
    assert.strictEqual(out.cookie, 'a=b');
  });

  test('header matching is case-insensitive and undefined values are dropped', () => {
    const out = stripHopByHop({ Connection: 'close', 'UPGRADE': 'websocket', 'X-A': undefined, 'x-b': '1' });
    assert.deepStrictEqual(out, { 'x-b': '1' });
  });

  test('array values survive (set-cookie must stay a list)', () => {
    const out = stripHopByHop({ 'set-cookie': ['a=1', 'b=2'] });
    assert.deepStrictEqual(out['set-cookie'], ['a=1', 'b=2']);
  });
});

describe('parseCookies - last duplicate wins', () => {
  test('reads the embed cookie out of a normal jar', () => {
    assert.strictEqual(parseCookies('a=1; madar_embed=abc; b=2')[EMBED_COOKIE_NAME], 'abc');
  });

  test('a duplicated name resolves to the LAST value (what the browser sends last)', () => {
    assert.strictEqual(parseCookies(`${EMBED_COOKIE_NAME}=first; ${EMBED_COOKIE_NAME}=second`)[EMBED_COOKIE_NAME], 'second');
  });

  test('quoted values are unwrapped', () => {
    assert.strictEqual(parseCookies(`${EMBED_COOKIE_NAME}="abc"`)[EMBED_COOKIE_NAME], 'abc');
  });

  test('junk / empty headers yield an empty map, never throw', () => {
    assert.deepStrictEqual(parseCookies(undefined), {});
    assert.deepStrictEqual(parseCookies(''), {});
    assert.deepStrictEqual(parseCookies('=; ; a'), {});
  });
});

describe('sanitizeSetCookie - an upstream cannot clobber the credential', () => {
  test('drops any Set-Cookie naming the embed cookie', () => {
    assert.deepStrictEqual(
      sanitizeSetCookie([`${EMBED_COOKIE_NAME}=attacker; Path=/`, 'theme=dark']),
      ['theme=dark'],
    );
  });

  test('the match ignores case and surrounding space', () => {
    assert.deepStrictEqual(sanitizeSetCookie([` MADAR_EMBED =x`]), []);
  });

  test('ordinary upstream cookies pass through', () => {
    assert.deepStrictEqual(sanitizeSetCookie(['a=1', 'b=2']), ['a=1', 'b=2']);
  });

  test('non-array junk is an empty list, never a crash', () => {
    assert.deepStrictEqual(sanitizeSetCookie(undefined), []);
    assert.deepStrictEqual(sanitizeSetCookie('a=1' as any), []);
  });
});

describe('embed cookie attributes', () => {
  test('is HttpOnly + SameSite=Strict + Path=/ so it is host-scoped and CSRF-immune', () => {
    const attrs = embedCookieOptions(3600);
    assert.match(attrs, /HttpOnly/);
    assert.match(attrs, /SameSite=Strict/);
    assert.match(attrs, /Path=\//);
    assert.match(attrs, /Max-Age=3600/);
    assert.ok(!/Secure/i.test(attrs), 'no Secure flag off-TLS or the LAN path would drop the cookie');
  });

  test('a non-positive / junk max-age omits Max-Age (session cookie)', () => {
    assert.ok(!/Max-Age/.test(embedCookieOptions(0)));
    assert.ok(!/Max-Age/.test(embedCookieOptions(Number.NaN)));
  });

  test('the clear form expires the cookie immediately', () => {
    assert.match(embedCookieClearOptions(), /Max-Age=0/);
    assert.match(embedCookieClearOptions(), /HttpOnly/);
    assert.match(embedCookieClearOptions(), /SameSite=Strict/);
  });
});
