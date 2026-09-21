/**
 * updates-core.test.ts
 * Pure unit coverage for the component-update pure rules (parseCliVersion,
 * semverCompare, parseCodeServerRelease, assetDebName, checksumMatches,
 * compatGate, freeSpaceGate, assertSafeDebName, applyStateMachine).
 * No server, no Docker — fully offline, mirroring serve-core.test.ts /
 * project-alerts.test.ts.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  parseSemver,
  parseCliVersion,
  semverCompare,
  parseCodeServerRelease,
  assetDebName,
  checksumMatches,
  compatGate,
  freeSpaceGate,
  assertSafeDebName,
  assertAllowedUpdateBase,
  isSupportedArch,
  isStrictPublisherVersion,
  applyStateMachine,
  type ApplyState,
  type ApplyEvent,
} from '../src/services/updates-core.ts';

/* ── isStrictPublisherVersion (npm latest guard) ──────────────────────── */

describe('isStrictPublisherVersion', () => {
  test('exact published semver passes', () => {
    assert.strictEqual(isStrictPublisherVersion('1.18.22'), true);
    assert.strictEqual(isStrictPublisherVersion('1.2.3'), true);
    assert.strictEqual(isStrictPublisherVersion('0.0.1'), true);
  });

  test('prerelease suffix passes (npm pins these too)', () => {
    assert.strictEqual(isStrictPublisherVersion('1.2.3-beta.1'), true);
    assert.strictEqual(isStrictPublisherVersion('1.2.3-rc.2'), true);
  });

  test('surrounding whitespace is tolerated (trimmed before test)', () => {
    assert.strictEqual(isStrictPublisherVersion('  1.18.22  '), true);
  });

  test('semver RANGES are rejected (would pass a loose /(\\d+)\\./ probe)', () => {
    assert.strictEqual(isStrictPublisherVersion('1.99.0 || 2.0.0'), false);
    assert.strictEqual(isStrictPublisherVersion('>=1.0.0'), false);
    assert.strictEqual(isStrictPublisherVersion('~1.2.3'), false);
    assert.strictEqual(isStrictPublisherVersion('^1.2.3'), false);
    assert.strictEqual(isStrictPublisherVersion('1.x'), false);
  });

  test('dist-tags and junk are rejected', () => {
    assert.strictEqual(isStrictPublisherVersion('latest'), false);
    assert.strictEqual(isStrictPublisherVersion('next'), false);
    assert.strictEqual(isStrictPublisherVersion(''), false);
    assert.strictEqual(isStrictPublisherVersion('   '), false);
    assert.strictEqual(isStrictPublisherVersion('not-a-version'), false);
  });

  test('v-prefix is rejected (npm latest never ships one)', () => {
    assert.strictEqual(isStrictPublisherVersion('v1.18.22'), false);
  });

  test('partial versions are rejected', () => {
    assert.strictEqual(isStrictPublisherVersion('1.2'), false);
    assert.strictEqual(isStrictPublisherVersion('1'), false);
    assert.strictEqual(isStrictPublisherVersion('1.2.3.4'), false);
  });

  test('injection / path / flag shapes are rejected', () => {
    assert.strictEqual(isStrictPublisherVersion('../evil'), false);
    assert.strictEqual(isStrictPublisherVersion('/tmp/pwn'), false);
    assert.strictEqual(isStrictPublisherVersion('1.2.3@latest'), false);
    assert.strictEqual(isStrictPublisherVersion('1.2.3 && rm -rf /'), false);
    assert.strictEqual(isStrictPublisherVersion('1.2.3\nlatest'), false);
  });

  test('non-strings are rejected', () => {
    assert.strictEqual(isStrictPublisherVersion(undefined), false);
    assert.strictEqual(isStrictPublisherVersion(null), false);
    assert.strictEqual(isStrictPublisherVersion(12345), false);
    assert.strictEqual(isStrictPublisherVersion({}), false);
  });
});

/* ── parseSemver ─────────────────────────────────────────────────────── */

describe('parseSemver', () => {
  test('clean semver', () => {
    assert.deepStrictEqual(parseSemver('1.2.3'), { major: 1, minor: 2, patch: 3 });
  });

  test('v-prefix stripped', () => {
    assert.deepStrictEqual(parseSemver('v4.96.4'), { major: 4, minor: 96, patch: 4 });
  });

  test('prerelease suffix ignored', () => {
    assert.deepStrictEqual(parseSemver('1.0.0-beta.1'), { major: 1, minor: 0, patch: 0 });
  });

  test('two components → null', () => {
    assert.strictEqual(parseSemver('4.96'), null);
  });

  test('single component → null', () => {
    assert.strictEqual(parseSemver('4'), null);
  });

  test('junk → null', () => {
    assert.strictEqual(parseSemver('not-a-version'), null);
    assert.strictEqual(parseSemver(''), null);
    assert.strictEqual(parseSemver('   '), null);
  });

  test('non-string → null', () => {
    assert.strictEqual(parseSemver(undefined as unknown as string), null);
    assert.strictEqual(parseSemver(42 as unknown as string), null);
  });
});

/* ── parseCliVersion ─────────────────────────────────────────────────── */

describe('parseCliVersion', () => {
  test('real code-server output', () => {
    assert.strictEqual(parseCliVersion('4.96.4 b7ef8f9d6fa50c64c5c15e65765c4f173c1e8e78 with Code 1.96.4'), '4.96.4');
  });

  test('bare semver', () => {
    assert.strictEqual(parseCliVersion('4.137.0'), '4.137.0');
  });

  test('v-prefixed', () => {
    assert.strictEqual(parseCliVersion('v4.137.0'), '4.137.0');
  });

  test('multi-line — takes first valid token', () => {
    const input = 'some noise\n4.96.4 extra stuff';
    assert.strictEqual(parseCliVersion(input), '4.96.4');
  });

  test('version with prerelease suffix', () => {
    assert.strictEqual(parseCliVersion('4.96.4-beta.1 extra'), '4.96.4');
  });

  test('two-component version is skipped, third component on same line wins', () => {
    assert.strictEqual(parseCliVersion('4.96 4.97.1'), '4.97.1');
  });

  test('no valid semver → null', () => {
    assert.strictEqual(parseCliVersion('junk'), null);
    assert.strictEqual(parseCliVersion(''), null);
    assert.strictEqual(parseCliVersion('code-server 2024'), null);
  });

  test('non-string → null', () => {
    assert.strictEqual(parseCliVersion(undefined as unknown as string), null);
    assert.strictEqual(parseCliVersion(123 as unknown as string), null);
  });
});

/* ── semverCompare ───────────────────────────────────────────────────── */

describe('semverCompare', () => {
  test('a < b → negative', () => {
    assert.ok(semverCompare('1.0.0', '2.0.0') < 0);
    assert.ok(semverCompare('1.0.0', '1.1.0') < 0);
    assert.ok(semverCompare('1.0.0', '1.0.1') < 0);
  });

  test('a > b → positive', () => {
    assert.ok(semverCompare('2.0.0', '1.0.0') > 0);
    assert.ok(semverCompare('1.1.0', '1.0.0') > 0);
    assert.ok(semverCompare('1.0.1', '1.0.0') > 0);
  });

  test('equal → 0', () => {
    assert.strictEqual(semverCompare('1.0.0', '1.0.0'), 0);
    assert.strictEqual(semverCompare('4.96.4', '4.96.4'), 0);
  });

  test('v-prefix is transparent', () => {
    assert.strictEqual(semverCompare('v1.0.0', '1.0.0'), 0);
    assert.ok(semverCompare('v2.0.0', '1.0.0') > 0);
  });

  test('prerelease suffix is ignored', () => {
    assert.strictEqual(semverCompare('1.0.0-beta.1', '1.0.0'), 0);
    assert.strictEqual(semverCompare('1.0.0', '1.0.0-alpha'), 0);
  });

  test('non-semver → NaN', () => {
    assert.ok(Number.isNaN(semverCompare('junk', '1.0.0')));
    assert.ok(Number.isNaN(semverCompare('1.0.0', 'junk')));
    assert.ok(Number.isNaN(semverCompare('junk', 'junk')));
  });
});

/* ── parseCodeServerRelease ──────────────────────────────────────────── */

describe('parseCodeServerRelease', () => {
  const VALID_RELEASE = {
    tag_name: 'v4.137.0',
    assets: [
      { name: 'code-server_4.137.0_amd64.deb', browser_download_url: 'https://example.com/amd64.deb', digest: 'sha256:abcdef1234567890', size: 50_000_000 },
      { name: 'code-server_4.137.0_arm64.deb', browser_download_url: 'https://example.com/arm64.deb', digest: 'sha256:deadbeef12345678', size: 48_000_000 },
      { name: 'other.tar.gz', browser_download_url: 'https://example.com/other.tar.gz' },
    ],
  };

  test('parses valid amd64 release', () => {
    const r = parseCodeServerRelease(VALID_RELEASE, 'x64');
    assert.ok(r);
    assert.strictEqual(r!.version, '4.137.0');
    assert.strictEqual(r!.debUrl, 'https://example.com/amd64.deb');
    assert.strictEqual(r!.digest, 'sha256:abcdef1234567890');
  });

  test('parses valid arm64 release', () => {
    const r = parseCodeServerRelease(VALID_RELEASE, 'arm64');
    assert.ok(r);
    assert.strictEqual(r!.version, '4.137.0');
    assert.strictEqual(r!.debUrl, 'https://example.com/arm64.deb');
    assert.strictEqual(r!.digest, 'sha256:deadbeef12345678');
  });

  test('asset without digest → null digest', () => {
    const release = {
      tag_name: 'v1.0.0',
      assets: [{ name: 'code-server_1.0.0_amd64.deb', browser_download_url: 'https://example.com/d.deb' }],
    };
    const r = parseCodeServerRelease(release, 'x64');
    assert.ok(r);
    assert.strictEqual(r!.digest, null);
  });

  test('digest without sha256: prefix → null', () => {
    const release = {
      tag_name: 'v1.0.0',
      assets: [{ name: 'code-server_1.0.0_amd64.deb', browser_download_url: 'https://example.com/d.deb', digest: 'md5:abc' }],
    };
    const r = parseCodeServerRelease(release, 'x64');
    assert.ok(r);
    assert.strictEqual(r!.digest, null);
  });

  test('no matching asset → null', () => {
    const release = {
      tag_name: 'v1.0.0',
      assets: [{ name: 'code-server_1.0.0_arm64.deb', browser_download_url: 'https://example.com/arm.deb' }],
    };
    assert.strictEqual(parseCodeServerRelease(release, 'x64'), null);
  });

  test('missing tag_name → null', () => {
    assert.strictEqual(parseCodeServerRelease({ assets: [] }, 'x64'), null);
  });

  test('no assets array → null', () => {
    assert.strictEqual(parseCodeServerRelease({ tag_name: 'v1.0.0' }, 'x64'), null);
  });

  test('null / non-object → null', () => {
    assert.strictEqual(parseCodeServerRelease(null, 'x64'), null);
    assert.strictEqual(parseCodeServerRelease('string', 'x64'), null);
    assert.strictEqual(parseCodeServerRelease(undefined, 'x64'), null);
  });

  test('asset missing download_url → skipped (null)', () => {
    const release = {
      tag_name: 'v1.0.0',
      assets: [{ name: 'code-server_1.0.0_amd64.deb' }],
    };
    assert.strictEqual(parseCodeServerRelease(release, 'x64'), null);
  });
});

/* ── assetDebName ────────────────────────────────────────────────────── */

describe('assetDebName', () => {
  test('x64 → amd64', () => {
    assert.strictEqual(assetDebName('4.137.0', 'x64'), 'code-server_4.137.0_amd64.deb');
  });

  test('arm64 → arm64', () => {
    assert.strictEqual(assetDebName('1.0.0', 'arm64'), 'code-server_1.0.0_arm64.deb');
  });

  test('unknown arch → throws', () => {
    assert.throws(
      () => assetDebName('1.0.0', 'mips'),
      (e: any) => e instanceof Error && /Unsupported architecture/i.test(e.message)
    );
  });
});

/* ── checksumMatches ─────────────────────────────────────────────────── */

describe('checksumMatches', () => {
  test('exact match', () => {
    assert.strictEqual(checksumMatches('abc123', 'abc123'), true);
  });

  test('case-insensitive', () => {
    assert.strictEqual(checksumMatches('ABC123', 'abc123'), true);
    assert.strictEqual(checksumMatches('abc123', 'ABC123'), true);
  });

  test('different values → false', () => {
    assert.strictEqual(checksumMatches('abc123', 'abc124'), false);
  });

  test('different lengths → false', () => {
    assert.strictEqual(checksumMatches('abc', 'abcd'), false);
  });

  test('null expected → false', () => {
    assert.strictEqual(checksumMatches('abc', null), false);
  });

  test('empty strings → true (both empty = equal)', () => {
    assert.strictEqual(checksumMatches('', ''), true);
  });
});

/* ── compatGate ──────────────────────────────────────────────────────── */

describe('compatGate', () => {
  test('valid upgrade → ok', () => {
    const r = compatGate({ current: '4.96.4', target: '4.137.0', arch: 'x64', maxBytes: 100_000_000 });
    assert.deepStrictEqual(r, { ok: true });
  });

  test('arm64 arch → ok', () => {
    const r = compatGate({ current: '4.96.4', target: '4.137.0', arch: 'arm64', maxBytes: 100_000_000 });
    assert.deepStrictEqual(r, { ok: true });
  });

  test('unsupported arch → rejected', () => {
    const r = compatGate({ current: '4.96.4', target: '4.137.0', arch: 'mips', maxBytes: 100_000_000 });
    assert.deepStrictEqual(r, { ok: false, reason: 'unsupported-arch' });
  });

  test('same version → not-newer', () => {
    const r = compatGate({ current: '4.137.0', target: '4.137.0', arch: 'x64', maxBytes: 100_000_000 });
    assert.deepStrictEqual(r, { ok: false, reason: 'not-newer' });
  });

  test('downgrade → not-newer', () => {
    const r = compatGate({ current: '4.137.0', target: '4.96.4', arch: 'x64', maxBytes: 100_000_000 });
    assert.deepStrictEqual(r, { ok: false, reason: 'not-newer' });
  });

  test('non-semver current → not-newer (NaN comparison)', () => {
    const r = compatGate({ current: 'junk', target: '4.137.0', arch: 'x64', maxBytes: 100_000_000 });
    assert.deepStrictEqual(r, { ok: false, reason: 'not-newer' });
  });

  test('deb too large → rejected', () => {
    const r = compatGate({ current: '4.96.4', target: '4.137.0', arch: 'x64', maxBytes: 10_000_000, debSizeBytes: 50_000_000 });
    assert.deepStrictEqual(r, { ok: false, reason: 'too-large' });
  });

  test('deb at exact max → ok (not strictly greater)', () => {
    const r = compatGate({ current: '4.96.4', target: '4.137.0', arch: 'x64', maxBytes: 50_000_000, debSizeBytes: 50_000_000 });
    assert.deepStrictEqual(r, { ok: true });
  });

  test('no debSizeBytes → size check skipped', () => {
    const r = compatGate({ current: '4.96.4', target: '4.137.0', arch: 'x64', maxBytes: 1 });
    assert.deepStrictEqual(r, { ok: true });
  });
});

/* ── freeSpaceGate ───────────────────────────────────────────────────── */

describe('freeSpaceGate', () => {
  test('enough space → true', () => {
    assert.strictEqual(freeSpaceGate(200, 100), true);
  });

  test('exactly 10% margin → true', () => {
    assert.strictEqual(freeSpaceGate(100 * 1.1, 100), true);
  });

  test('just under margin → false', () => {
    assert.strictEqual(freeSpaceGate(109, 100), false);
  });

  test('way more space → true', () => {
    assert.strictEqual(freeSpaceGate(1_000_000, 100), true);
  });

  test('zero free → false', () => {
    assert.strictEqual(freeSpaceGate(0, 100), false);
  });

  test('zero needed → true (0 >= 0)', () => {
    assert.strictEqual(freeSpaceGate(0, 0), true);
  });
});

/* ── assertSafeDebName ───────────────────────────────────────────────── */

describe('assertSafeDebName', () => {
  test('valid amd64 name', () => {
    assert.strictEqual(assertSafeDebName('code-server_4.137.0_amd64.deb'), true);
  });

  test('valid arm64 name', () => {
    assert.strictEqual(assertSafeDebName('code-server_1.0.0_arm64.deb'), true);
  });

  test('path traversal rejected', () => {
    assert.strictEqual(assertSafeDebName('../etc/passwd.deb'), false);
    assert.strictEqual(assertSafeDebName('code-server_1.0.0_amd64.deb/../../etc/passwd'), false);
  });

  test('wrong extension rejected', () => {
    assert.strictEqual(assertSafeDebName('code-server_1.0.0_amd64.rpm'), false);
  });

  test('missing version rejected', () => {
    assert.strictEqual(assertSafeDebName('code-server__amd64.deb'), false);
  });

  test('wrong arch rejected', () => {
    assert.strictEqual(assertSafeDebName('code-server_1.0.0_i386.deb'), false);
  });

  test('extra dots in version rejected', () => {
    assert.strictEqual(assertSafeDebName('code-server_1.0.0.1_amd64.deb'), false);
  });

  test('injection attempt rejected', () => {
    assert.strictEqual(assertSafeDebName('code-server_$(rm -rf /)_amd64.deb'), false);
    assert.strictEqual(assertSafeDebName('code-server_1.0.0_amd64.deb; rm -rf /'), false);
  });

  test('empty string → false', () => {
    assert.strictEqual(assertSafeDebName(''), false);
  });
});

/* ── applyStateMachine ───────────────────────────────────────────────── */

describe('applyStateMachine', () => {
  // Happy path: full successful update
  test('happy path: idle → downloading → verifying → installing → restarting → verifying-boot → ok', () => {
    let s: ApplyState = 'idle';
    s = applyStateMachine(s, 'start');       assert.strictEqual(s, 'downloading');
    s = applyStateMachine(s, 'downloaded');  assert.strictEqual(s, 'verifying');
    s = applyStateMachine(s, 'verified');    assert.strictEqual(s, 'installing');
    s = applyStateMachine(s, 'installed');   assert.strictEqual(s, 'restarting');
    s = applyStateMachine(s, 'restarted');   assert.strictEqual(s, 'verifying-boot');
    s = applyStateMachine(s, 'boot-ok');     assert.strictEqual(s, 'ok');
  });

  // Happy path with rollback
  test('happy path: idle → ... → verifying-boot → rollback → rollback-ok → failed', () => {
    let s: ApplyState = 'idle';
    s = applyStateMachine(s, 'start');
    s = applyStateMachine(s, 'downloaded');
    s = applyStateMachine(s, 'verified');
    s = applyStateMachine(s, 'installed');
    s = applyStateMachine(s, 'restarted');
    s = applyStateMachine(s, 'boot-fail');   assert.strictEqual(s, 'rollback');
    s = applyStateMachine(s, 'rollback-ok'); assert.strictEqual(s, 'failed');
  });

  // Error from each execution state → failed
  const execStates: ApplyState[] = [
    'downloading', 'verifying', 'installing', 'restarting', 'verifying-boot', 'rollback',
  ];
  for (const state of execStates) {
    test(`error from '${state}' → failed`, () => {
      assert.strictEqual(applyStateMachine(state, 'error'), 'failed');
    });
  }

  // Error from non-execution states throws
  test('error from idle → throws', () => {
    assert.throws(() => applyStateMachine('idle', 'error'));
  });
  test('error from ok → throws', () => {
    assert.throws(() => applyStateMachine('ok', 'error'));
  });
  test('error from failed → throws', () => {
    assert.throws(() => applyStateMachine('failed', 'error'));
  });

  // reset from any state → idle
  const allStates: ApplyState[] = [
    'idle', 'downloading', 'verifying', 'installing', 'restarting',
    'verifying-boot', 'ok', 'failed', 'rollback',
  ];
  for (const state of allStates) {
    test(`reset from '${state}' → idle`, () => {
      assert.strictEqual(applyStateMachine(state, 'reset'), 'idle');
    });
  }

  // Invalid transitions throw
  test('start from downloading → throws', () => {
    assert.throws(() => applyStateMachine('downloading', 'start'));
  });
  test('downloaded from idle → throws', () => {
    assert.throws(() => applyStateMachine('idle', 'downloaded'));
  });
  test('boot-ok from idle → throws', () => {
    assert.throws(() => applyStateMachine('idle', 'boot-ok'));
  });
  test('boot-fail from idle → throws', () => {
    assert.throws(() => applyStateMachine('idle', 'boot-fail'));
  });
  test('start from failed → throws', () => {
    assert.throws(() => applyStateMachine('failed', 'start'));
  });
  test('start from ok → throws', () => {
    assert.throws(() => applyStateMachine('ok', 'start'));
  });
  test('boot-fail from downloading → throws (must reach verifying-boot first)', () => {
    assert.throws(() => applyStateMachine('downloading', 'boot-fail'));
  });
  test('rollback-ok from idle → throws', () => {
    assert.throws(() => applyStateMachine('idle', 'rollback-ok'));
  });
  test('rollback-fail from idle → throws', () => {
    assert.throws(() => applyStateMachine('idle', 'rollback-fail'));
  });
  test('rollback-fail from rollback → failed', () => {
    assert.strictEqual(applyStateMachine('rollback', 'rollback-fail'), 'failed');
  });
  test('downloaded from installing → throws', () => {
    assert.throws(() => applyStateMachine('installing', 'downloaded'));
  });
  test('installed from downloading → throws', () => {
    assert.throws(() => applyStateMachine('downloading', 'installed'));
  });

  // Boot-ok only valid from verifying-boot
  test('boot-ok from idle → throws', () => {
    assert.throws(() => applyStateMachine('idle', 'boot-ok'));
  });
  test('boot-ok from downloading → throws', () => {
    assert.throws(() => applyStateMachine('downloading', 'boot-ok'));
  });

  // Transition error message contains both states
  test('error message includes both states', () => {
    try {
      applyStateMachine('idle', 'downloaded');
      assert.fail('should have thrown');
    } catch (e: any) {
      assert.ok(e.message.includes('idle'), 'mentions current state');
      assert.ok(e.message.includes('downloaded'), 'mentions event');
    }
  });
});

/* ── assertAllowedUpdateBase (transport + host guard) ────────────────── */

describe('assertAllowedUpdateBase', () => {
  const ENV = 'WSD_UPDATE_GITHUB_BASE';

  test('official https base passes, trailing slash trimmed', () => {
    assert.equal(
      assertAllowedUpdateBase('https://api.github.com/', ENV, false),
      'https://api.github.com',
    );
  });

  test('bare host gets an https scheme', () => {
    assert.equal(assertAllowedUpdateBase('api.github.com', ENV, false), 'https://api.github.com');
  });

  test('plain http refs under WSD_TESTING=1 (local mock)', () => {
    assert.equal(
      assertAllowedUpdateBase('http://host.docker.internal:8987', ENV, true),
      'http://host.docker.internal:8987',
    );
  });

  test('plain http is refused outside testing (no silent downgrade)', () => {
    assert.throws(() => assertAllowedUpdateBase('http://registry.npmjs.org/foo', ENV, false), /https/i);
  });

  test('cloud-metadata hosts are always refused', () => {
    for (const bad of ['http://169.254.169.254', 'http://metadata.google.internal', 'https://metadata.goog/thing', 'http://100.100.100.200']) {
      assert.throws(() => assertAllowedUpdateBase(bad, ENV, true), /cannot point at this host/i, bad);
    }
  });

  test('link-local fe80 refused', () => {
    assert.throws(() => assertAllowedUpdateBase('http://[fe80::1]:8080', ENV, true), /cannot point at this host/i);
  });

  test('wildcard-DNS suffixes are refused even when they embed benign-looking labels', () => {
    // nip.io/sslip.io/xip.io resolve the IP in their subdomain, so the
    // literal host checks above would see a harmless suffix while the fetch
    // lands on cloud-metadata or loopback — the suffix itself must block.
    const badHosts = [
      'http://169.254.169.254.nip.io',
      'https://10.0.0.1.sslip.io',
      'http://192.168.1.1.xip.io',
      'http://metadata.google.internal.nip.io',
      'http://nip.io',
      'https://sslip.io',
      'http://xip.io:8080',
    ];
    for (const bad of badHosts) {
      assert.throws(() => assertAllowedUpdateBase(bad, ENV, true), /cannot point at this host/i, bad);
    }
  });

  test('legit hosts merely CONTAINING a suffix pass (substring is not a block)', () => {
    assert.equal(
      assertAllowedUpdateBase('https://cdn.nipio.example.com', ENV, true),
      'https://cdn.nipio.example.com',
    );
    assert.equal(
      assertAllowedUpdateBase('https://notxip.io.example.com', ENV, true),
      'https://notxip.io.example.com',
    );
  });

  test('empty and junk values throw', () => {
    assert.throws(() => assertAllowedUpdateBase('', ENV, true), /must not be empty/i);
    assert.throws(() => assertAllowedUpdateBase('   ', ENV, true), /must not be empty/i);
    assert.throws(() => assertAllowedUpdateBase('not a url!!', ENV, true), /valid URL/i);
  });

  test('legit signed asset URL passes (query params do not bypass the guard)', () => {
    // GitHub's browser_download_url may carry short-lived signature params —
    // they must not affect the scheme+host verdict, and the full signed URL
    // survives intact because downloadDeb needs it (the token itself is also
    // never persisted: urlForLog keeps host+path only).
    assert.equal(
      assertAllowedUpdateBase(
        'https://github.com/coder/code-server/releases/download/v4.96.4/code-server_4.96.4_amd64.deb?token=abc123',
        ENV,
        false,
      ),
      'https://github.com/coder/code-server/releases/download/v4.96.4/code-server_4.96.4_amd64.deb?token=abc123',
    );
  });
});

/* ── isSupportedArch ─────────────────────────────────────────────────── */

describe('isSupportedArch', () => {
  test('x64 and arm64 have deb assets', () => {
    assert.equal(isSupportedArch('x64'), true);
    assert.equal(isSupportedArch('arm64'), true);
  });

  test('everything else is locked out of the update channel', () => {
    for (const bad of ['ia32', 'ppc64', 's390x', 'riscv64', '']) {
      assert.equal(isSupportedArch(bad), false, bad);
    }
  });
});
