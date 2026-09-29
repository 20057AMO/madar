/**
 * workspaces-mount-core.test.ts
 * Madar — offline unit coverage for the pure /workspaces bind-source decoder
 * (parseMountinfo / pickMount / decodeBindSource / classifyMountError /
 * resolveHostDir / canaryToken). No server, no Docker, no fs — every input is a
 * string, so the rules are deterministically unit-testable. Mirrors
 * serve-core.test.ts / alerts-core.test.ts / embedded-status-core.test.ts.
 *
 * The property that matters most is the FIRST group: the real, live mountinfo
 * line from a Docker Desktop / Windows install must decode back to the exact
 * host path (a renamed checkout must decode to the renamed path), because that
 * derivation is what replaces the ${PWD}-based env default that silently went
 * stale.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  parseMountinfo,
  pickMount,
  decodeBindSource,
  classifyMountError,
  resolveHostDir,
  mountHint,
  canaryToken,
  mountRefusalCode,
  publicMountInfo,
  unescapeMountinfoField,
  MOUNT_CANARY_FILE,
  MOUNT_VERIFY_CANARY_FILE,
  buildProbeArgv,
  probeVerdictFor,
  probeExitCode,
  confirmProbeVerdict,
  HOST_PATH_REDACTED,
  type MountinfoEntry,
  type WorkspaceMountInfo,
} from '../src/services/workspaces-mount-core.ts';

/**
 * The real live line captured from the running container
 * (`docker exec wsd-pro cat /proc/self/mountinfo`), full super-option set
 * included — a truncated fixture would stop guarding the real decoder.
 */
const LIVE_LINE =
  '898 889 0:71 /Work/madar/workspaces /workspaces rw,noatime - 9p D:\\134 ' +
  'rw,aname=drvfs;path=D:\\;uid=0;gid=0;metadata;symlinkroot=/mnt/host/,cache=0x5,' +
  'access=client,msize=65536,trans=fd,rfd=5,wfd=5';

function entry(partial: Partial<MountinfoEntry>): MountinfoEntry {
  return { root: '/', mountPoint: '/workspaces', fsType: 'overlay', source: 'overlay', superOpts: 'rw', ...partial };
}

describe('parseMountinfo', () => {
  test('the live Docker Desktop line parses into root / mountPoint / fsType / superOpts', () => {
    const [only] = parseMountinfo(LIVE_LINE);
    assert.ok(only, 'the live line must parse');
    assert.strictEqual(only.root, '/Work/madar/workspaces');
    assert.strictEqual(only.mountPoint, '/workspaces');
    assert.strictEqual(only.fsType, '9p');
    assert.strictEqual(
      only.superOpts,
      'rw,aname=drvfs;path=D:\\;uid=0;gid=0;metadata;symlinkroot=/mnt/host/,cache=0x5,' +
        'access=client,msize=65536,trans=fd,rfd=5,wfd=5'
    );
  });

  test('optional (shared/master) fields before the "-" separator are skipped', () => {
    const [only] = parseMountinfo(
      '36 35 98:0 /mnt1 /mnt2 rw,noatime shared:1 master:2 - ext3 /dev/root rw,errors=continue'
    );
    assert.ok(only);
    assert.strictEqual(only.root, '/mnt1');
    assert.strictEqual(only.mountPoint, '/mnt2');
    assert.strictEqual(only.fsType, 'ext3');
    assert.strictEqual(only.superOpts, 'rw,errors=continue');
  });

  test('malformed lines are skipped, not fatal', () => {
    const text = ['', 'garbage', '1 2 3', '36 35 98:0 / / rw -', LIVE_LINE, 'also garbage here now'].join('\n');
    const entries = parseMountinfo(text);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].mountPoint, '/workspaces');
  });

  test('empty input yields no entries', () => {
    assert.deepStrictEqual(parseMountinfo(''), []);
    assert.deepStrictEqual(parseMountinfo(undefined as unknown as string), []);
  });

  test('pickMount matches the mount point EXACTLY (a prefix is not a mount)', () => {
    const entries = parseMountinfo(`${LIVE_LINE}\n42 1 0:5 /a /workspaces/nested rw - tmpfs tmpfs rw`);
    assert.strictEqual(pickMount(entries, '/workspaces')?.root, '/Work/madar/workspaces');
    assert.strictEqual(pickMount(entries, '/workspace'), null);
    assert.strictEqual(pickMount(entries, ''), null);
  });
});

describe('decodeBindSource — the live Windows/9p case (rule 1, VERIFIED on hardware)', () => {
  test('decodes the real captured line to the exact stale-env host path', () => {
    const decoded = decodeBindSource(parseMountinfo(LIVE_LINE)[0]);
    assert.strictEqual(decoded.ok, true);
    assert.strictEqual(decoded.ok && decoded.hostPath, 'D:\\Work\\madar\\workspaces');
    assert.strictEqual(decoded.ok && decoded.kind, 'windows-9p');
  });

  test('a renamed checkout decodes to the RENAMED path (never a stale one)', () => {
    const renamed = LIVE_LINE.replace('/Work/madar/workspaces', '/Work/WSD-Pro/workspaces');
    const decoded = decodeBindSource(parseMountinfo(renamed)[0]);
    assert.strictEqual(decoded.ok && decoded.hostPath, 'D:\\Work\\WSD-Pro\\workspaces');
  });

  test('a lowercase drive letter is normalized to upper case', () => {
    const line = LIVE_LINE.replace('path=D:\\', 'path=d:\\');
    const decoded = decodeBindSource(parseMountinfo(line)[0]);
    assert.strictEqual(decoded.ok && decoded.hostPath, 'D:\\Work\\madar\\workspaces');
  });

  test('a forward-slash drvfs path and a drive-root bind (root === "/") both resolve', () => {
    const fwd = LIVE_LINE.replace('path=D:\\', 'path=D:/');
    assert.strictEqual(
      decodeBindSource(parseMountinfo(fwd)[0]).ok && parseMountinfo(fwd)[0] && (decodeBindSource(parseMountinfo(fwd)[0]) as any).hostPath,
      'D:\\Work\\madar\\workspaces'
    );
    const driveRoot = LIVE_LINE.replace('/Work/madar/workspaces /workspaces', '/ /workspaces');
    const decoded = decodeBindSource(parseMountinfo(driveRoot)[0]);
    assert.strictEqual(decoded.ok && decoded.hostPath, 'D:\\');
  });
});

describe('decodeBindSource — virtiofs / gRPC-FUSE (rule 2, unit-covered only)', () => {
  test('a leading /d segment is promoted to D:/', () => {
    const decoded = decodeBindSource(
      entry({ root: '/d/Work/WSD-Pro/workspaces', fsType: 'virtiofs', superOpts: 'rw' })
    );
    assert.strictEqual(decoded.ok && decoded.hostPath, 'D:/Work/WSD-Pro/workspaces');
    assert.strictEqual(decoded.ok && decoded.kind, 'posix');
  });

  test('symlinkroot=/host_mnt alone also unlocks the promotion', () => {
    const decoded = decodeBindSource(
      entry({ root: '/c/Users/me/madar/workspaces', fsType: 'fuse.darwinfs', superOpts: 'rw,symlinkroot=/host_mnt' })
    );
    assert.strictEqual(decoded.ok && decoded.hostPath, 'C:/Users/me/madar/workspaces');
  });

  test('a drive-only root promotes to C:/ (no trailing slash guessing)', () => {
    const decoded = decodeBindSource(entry({ root: '/e', fsType: 'virtiofs', superOpts: 'rw' }));
    assert.strictEqual(decoded.ok && decoded.hostPath, 'E:/');
  });

  test('virtiofs WITHOUT a drive segment never guesses a posix root: it is unresolved', () => {
    // The /c-style promotion is an unverified shape. Falling through to rule 3
    // would read the same root as a plain Linux bind, i.e. guess.
    const virtiofs = decodeBindSource(entry({ root: '/home/me/madar/workspaces', fsType: 'virtiofs', superOpts: 'rw' }));
    assert.deepStrictEqual(virtiofs, { ok: false, reason: 'unresolved_source' });
    const symlinkroot = decodeBindSource(
      entry({ root: '/home/me/madar/workspaces', fsType: 'fuse.virtiofs', superOpts: 'rw,symlinkroot=/host_mnt' })
    );
    assert.deepStrictEqual(symlinkroot, { ok: false, reason: 'unresolved_source' });
    const unresolved = decodeBindSource(entry({ root: '/srv/shares/team', fsType: 'tmpfs', superOpts: 'rw' }));
    assert.deepStrictEqual(unresolved, { ok: false, reason: 'unresolved_source' });
  });
});

describe('decodeBindSource — posix binds, volumes, root fs (rules 3-6)', () => {
  test('a plain Linux bind (ext4, non-root root, no master) resolves to the root path', () => {
    const decoded = decodeBindSource(
      entry({ root: '/home/me/madar/workspaces', mountPoint: '/workspaces', fsType: 'ext4', source: '/dev/sda1', superOpts: 'rw' })
    );
    assert.strictEqual(decoded.ok && decoded.hostPath, '/home/me/madar/workspaces');
    assert.strictEqual(decoded.ok && decoded.kind, 'posix');
  });

  test('a shared master: mount is a named_volume, never claimed as a host path', () => {
    const decoded = decodeBindSource(
      entry({ root: '/data/projects/team', fsType: 'ext4', superOpts: 'rw,master:12' })
    );
    assert.deepStrictEqual(decoded, { ok: false, reason: 'named_volume' });
  });

  test('a docker volume root is a named_volume even with NO master: option', () => {
    const decoded = decodeBindSource(
      entry({ root: '/var/lib/docker/volumes/wsd-data/_data', fsType: 'ext4', superOpts: 'rw' })
    );
    assert.deepStrictEqual(decoded, { ok: false, reason: 'named_volume' });
    const alt = decodeBindSource(
      entry({ root: '/data/docker/volumes/wsd-workspaces/_data', fsType: 'xfs', superOpts: 'rw' })
    );
    assert.deepStrictEqual(alt, { ok: false, reason: 'named_volume' });
  });

  test('the container\'s own root fs (root === "/") is refused, not guessed', () => {
    const decoded = decodeBindSource(entry({ root: '/', fsType: 'overlay', superOpts: 'rw,lowerdir=/a' }));
    assert.deepStrictEqual(decoded, { ok: false, reason: 'root_fs' });
  });

  test('a bind of a whole drive on 9p still resolves (rule 1 outranks rule 5)', () => {
    const line = LIVE_LINE.replace('/Work/madar/workspaces /workspaces', '/ /workspaces');
    assert.strictEqual(decodeBindSource(parseMountinfo(line)[0]).ok, true);
  });

  test('an unknown filesystem with an odd root is unresolved, not guessed', () => {
    const decoded = decodeBindSource(entry({ root: '/weird/place', fsType: 'fuse.sshfs', superOpts: 'rw' }));
    // fuse.* is a real-fs shape: the root IS the host path it was mounted from.
    assert.strictEqual(decoded.ok && decoded.hostPath, '/weird/place');
    const junk = decodeBindSource(entry({ root: 'relative/path', fsType: 'tmpfs', superOpts: 'rw' }));
    assert.deepStrictEqual(junk, { ok: false, reason: 'unresolved_source' });
  });
});

describe('kernel octal escapes in mountinfo (a path with a space is NOT a broken decoder)', () => {
  test('exactly the four kernel escapes are decoded, and nothing else', () => {
    assert.strictEqual(unescapeMountinfoField('/Users/First\\040Last'), '/Users/First Last');
    assert.strictEqual(unescapeMountinfoField('/a\\011b'), '/a\tb');
    assert.strictEqual(unescapeMountinfoField('/a\\012b'), '/a\nb');
    assert.strictEqual(unescapeMountinfoField('/a\\134b'), '/a\\b');
    // Only those four codes exist; any other \NNN is literal text and must stay.
    assert.strictEqual(unescapeMountinfoField('/a\\123b\\04c'), '/a\\123b\\04c');
    assert.strictEqual(unescapeMountinfoField('/plain/path'), '/plain/path');
    assert.strictEqual(unescapeMountinfoField(undefined as unknown as string), '');
  });

  test('the escaping is a single left-to-right pass (an escaped backslash cannot re-open one)', () => {
    // A directory literally named "\040" is reported as \134040; decoding twice
    // would turn it into a space, i.e. into a path that does not exist.
    assert.strictEqual(unescapeMountinfoField('/a\\134040b'), '/a\\040b');
  });

  test('a live-shaped drvfs line with an escaped space decodes to the REAL host path', () => {
    const spaced = LIVE_LINE.replace('/Work/madar/workspaces', '/Users/First\\040Last/madar/workspaces');
    const [parsed] = parseMountinfo(spaced);
    assert.ok(parsed, 'the escaped line must still parse as ONE record');
    assert.strictEqual(parsed.root, '/Users/First\\040Last/madar/workspaces');
    const decoded = decodeBindSource(parsed);
    assert.strictEqual(decoded.ok && decoded.hostPath, 'D:\\Users\\First Last\\madar\\workspaces');
    // Round trip through the top-level decision, which is what createProject uses.
    assert.strictEqual(
      resolveHostDir({ envValue: '', mountinfoText: spaced }).hostPath,
      'D:\\Users\\First Last\\madar\\workspaces',
    );
  });

  test('escapes survive every rule: virtiofs drive promotion and the posix bind', () => {
    const virtiofs = decodeBindSource(
      entry({ root: '/c/Users/First\\040Last/workspaces', fsType: 'virtiofs', superOpts: 'rw' })
    );
    assert.strictEqual(virtiofs.ok && virtiofs.hostPath, 'C:/Users/First Last/workspaces');
    const posix = decodeBindSource(
      entry({ root: '/srv/team\\040space/workspaces', fsType: 'ext4', source: '/dev/sda1', superOpts: 'rw' })
    );
    assert.strictEqual(posix.ok && posix.hostPath, '/srv/team space/workspaces');
  });

  test('an escaped backslash in a directory name is preserved as a backslash', () => {
    const decoded = decodeBindSource(
      entry({ root: '/srv/odd\\134name/workspaces', fsType: 'ext4', source: '/dev/sda1', superOpts: 'rw' })
    );
    assert.strictEqual(decoded.ok && decoded.hostPath, '/srv/odd\\name/workspaces');
  });

  test('a mount point with an escaped space is still matched EXACTLY', () => {
    const line = '42 41 0:33 /host/team\\040space /workspaces\\040old rw,noatime - 9p D:\\134 rw,aname=drvfs;path=D:\\;symlinkroot=/mnt/host/';
    const entries = parseMountinfo(line);
    assert.strictEqual(pickMount(entries, '/workspaces old')?.root, '/host/team\\040space');
    assert.strictEqual(pickMount(entries, '/workspaces'), null);
  });

  test('unescaping never turns a volume root or the root fs into a host path', () => {
    const volume = decodeBindSource(
      entry({ root: '/var/lib/docker/volumes/wsd\\040data/_data', fsType: 'ext4', superOpts: 'rw' })
    );
    assert.deepStrictEqual(volume, { ok: false, reason: 'named_volume' });
    assert.deepStrictEqual(
      decodeBindSource(entry({ root: '/', fsType: 'overlay', superOpts: 'rw' })),
      { ok: false, reason: 'root_fs' },
    );
  });
});

describe('mountRefusalCode — what may a project container bind to?', () => {
  const ok = { hostPath: 'D:\\Work\\WSD-Pro\\workspaces', state: 'ok' } as const;

  test('a proved mount on a healthy state is the only shape that creates', () => {
    assert.strictEqual(mountRefusalCode({ ...ok, verification: 'proved' }), null);
  });

  test('an UNKNOWN verdict is permissive (an absent probe is not proof of breakage)', () => {
    assert.strictEqual(mountRefusalCode({ ...ok, verification: 'unknown' }), null);
  });

  test('a REFUTED proof refuses — the probe saw a different directory than we write', () => {
    assert.strictEqual(mountRefusalCode({ ...ok, verification: 'refuted' }), 'refuted');
  });

  test('no host path refuses as unresolvable, whatever the verdict says', () => {
    assert.strictEqual(
      mountRefusalCode({ hostPath: null, state: 'unresolved', verification: 'unknown' }),
      'unresolvable',
    );
    // 'broken' outranks 'refuted': the mount we audit is already unusable, which
    // is the more actionable refusal to report.
    assert.strictEqual(
      mountRefusalCode({ ...ok, state: 'missing', verification: 'refuted' }),
      'broken',
    );
  });

  test('every non-ok state refuses as broken', () => {
    for (const state of ['missing', 'not_a_directory', 'unreadable', 'unresolved'] as const) {
      assert.strictEqual(mountRefusalCode({ ...ok, state, verification: 'proved' }), 'broken', state);
    }
  });
});

describe('publicMountInfo — the host path is operator information', () => {
  const info: WorkspaceMountInfo = {
    state: 'ok',
    hostPath: 'D:\\Users\\First Last\\WSD-Pro\\workspaces',
    source: 'mountinfo',
    reason: null,
    hint: mountHint('ok', null, 'D:\\Users\\First Last\\WSD-Pro\\workspaces', '/workspaces'),
    checkedAt: '2026-09-29T10:00:00.000Z',
    verification: 'proved',
  };

  test('an admin keeps the whole verdict verbatim', () => {
    assert.strictEqual(publicMountInfo(info, true), info);
  });

  test('a non-admin keeps state / reason / source / verification but never the path', () => {
    const view = publicMountInfo(info, false);
    assert.strictEqual(view.state, 'ok');
    assert.strictEqual(view.verification, 'proved');
    assert.strictEqual(view.source, 'mountinfo');
    assert.strictEqual(view.hint.length > 10, true);
    assert.strictEqual(view.hostPath, HOST_PATH_REDACTED);
    assert.ok(!view.hint.includes('D:\\Users'), 'the ok hint embeds the path — it must be scrubbed too');
    assert.ok(!JSON.stringify(view).includes('D:\\'), 'no host path may survive anywhere in the payload');
  });

  test('the cached object is never mutated (the same snapshot serves every caller)', () => {
    publicMountInfo(info, false);
    assert.strictEqual(info.hostPath, 'D:\\Users\\First Last\\WSD-Pro\\workspaces');
    assert.ok(info.hint.includes('D:\\Users\\First Last'));
  });

  test('an unresolved path stays null (honest, not redacted), for admins and viewers alike', () => {
    const unresolved: WorkspaceMountInfo = {
      ...info,
      state: 'unresolved',
      hostPath: null,
      reason: 'named_volume',
      verification: 'unknown',
      hint: mountHint('unresolved', 'named_volume', null, '/workspaces'),
    };
    assert.strictEqual(publicMountInfo(unresolved, false).hostPath, null);
    assert.strictEqual(publicMountInfo(unresolved, false).hint, unresolved.hint);
  });
});

describe('classifyMountError', () => {
  test('ENOENT / ENOTDIR map to distinct states', () => {
    assert.strictEqual(classifyMountError({ code: 'ENOENT' }), 'no_such_directory');
    assert.strictEqual(classifyMountError({ code: 'ENOTDIR' }), 'not_a_directory');
  });

  test('EACCES / ESTALE / ENODEV / EPERM are all "unreadable"', () => {
    for (const code of ['EACCES', 'ESTALE', 'ENODEV', 'EPERM']) {
      assert.strictEqual(classifyMountError({ code }), 'unreadable', code);
    }
  });

  test('junk, a plain Error and null degrade to unreadable instead of throwing', () => {
    assert.strictEqual(classifyMountError(new Error('boom')), 'unreadable');
    assert.strictEqual(classifyMountError(null), 'unreadable');
    assert.strictEqual(classifyMountError({ code: 'ELOOP' }), 'unreadable');
  });
});

describe('resolveHostDir', () => {
  test('an explicit non-empty env value WINS over derivation (back-compat)', () => {
    const r = resolveHostDir({ envValue: 'Z:/custom/workspaces', mountinfoText: LIVE_LINE });
    assert.deepStrictEqual(r, { hostPath: 'Z:/custom/workspaces', source: 'env', reason: null });
  });

  test('an UNSET env value derives from mountinfo instead of degrading to "/workspaces"', () => {
    for (const envValue of [undefined, null, '', '   ']) {
      const r = resolveHostDir({ envValue, mountinfoText: LIVE_LINE });
      assert.strictEqual(r.hostPath, 'D:\\Work\\madar\\workspaces', String(envValue));
      assert.strictEqual(r.source, 'mountinfo');
      assert.strictEqual(r.reason, null);
    }
  });

  test('trailing separators are trimmed, but a bare drive root survives', () => {
    assert.strictEqual(resolveHostDir({ envValue: '  D:\\Work\\madar\\workspaces\\  ' }).hostPath, 'D:\\Work\\madar\\workspaces');
    assert.strictEqual(resolveHostDir({ envValue: '/home/me/madar/workspaces/' }).hostPath, '/home/me/madar/workspaces');
    assert.strictEqual(resolveHostDir({ envValue: 'D:\\' }).hostPath, 'D:\\');
  });

  test('no mount entry for the mount point → hostPath null with an honest reason', () => {
    const r = resolveHostDir({ envValue: '', mountinfoText: LIVE_LINE, mountPoint: '/somewhere-else' });
    assert.deepStrictEqual(r, { hostPath: null, source: null, reason: 'no_mount_entry' });
  });

  test('no mountinfo at all (non-Linux) → hostPath null, never a fabricated path', () => {
    const r = resolveHostDir({ envValue: '', mountinfoText: '' });
    assert.strictEqual(r.hostPath, null);
    assert.strictEqual(r.source, null);
    assert.strictEqual(r.reason, 'no_mount_entry');
  });

  test('a named volume at the mount point reports named_volume (an operator must set the env)', () => {
    const line = '99 20 0:55 /var/lib/docker/volumes/wsd-workspaces/_data /workspaces rw - ext4 /dev/sdb rw';
    const r = resolveHostDir({ envValue: '', mountinfoText: line });
    assert.deepStrictEqual(r, { hostPath: null, source: null, reason: 'named_volume' });
  });

  test('the default mount point is /workspaces', () => {
    assert.strictEqual(resolveHostDir({ mountinfoText: LIVE_LINE }).hostPath, 'D:\\Work\\madar\\workspaces');
  });
});

describe('hints + canary', () => {
  test('every state yields a non-empty sentence that never names a credential', () => {
    const states = ['ok', 'missing', 'not_a_directory', 'unreadable', 'unresolved'] as const;
    for (const state of states) {
      const hint = mountHint(state, 'unresolved_source', null, '/workspaces');
      assert.ok(hint.length > 10, state);
      assert.ok(hint.trim().endsWith('.'), `${state} hint must be a sentence`);
      assert.ok(!hint.toLowerCase().includes('password'), `${state} hint leaked a secret-bearing word`);
    }
  });

  test('a read-only bind is named as such, not as a read failure', () => {
    assert.ok(/read-only/.test(mountHint('unreadable', 'not_writable', null, '/workspaces')));
    assert.ok(!/read-only/.test(mountHint('unreadable', 'unreadable', null, '/workspaces')));
  });

  test('the ok hint names the recovered path', () => {
    assert.ok(mountHint('ok', null, 'D:\\Work\\madar\\workspaces', '/workspaces').includes('D:\\Work\\madar\\workspaces'));
  });

  test('canaryToken is deterministic, seed-sensitive and clearly named', () => {
    assert.strictEqual(canaryToken('a'), canaryToken('a'));
    assert.notStrictEqual(canaryToken('a'), canaryToken('b'));
    assert.match(canaryToken('a'), /^madar-mount-canary-[0-9a-f]{8}$/);
    assert.strictEqual(MOUNT_CANARY_FILE, '.madar-mount-canary');
  });
});

describe('probe canary separation', () => {
  // REGRESSION GUARD. physicalCheck() is synchronous and unlinks its canary in a
  // `finally`, so it can run during a verification's await (an MOUNT_AUDIT_MS
  // cache expiry or the sweep tick) — while the probe container is booting. On
  // one shared canary name that audit deleted the file the probe still had to
  // see: `test -f` exited 1, the verdict was persisted as 'refuted', and
  // mountRefusalCode() then refused EVERY project create with a 500 against a
  // mount that was never broken. Two names make the interleaving impossible.
  test('the probe canary is a DIFFERENT file from the physical check canary', () => {
    assert.notStrictEqual(MOUNT_VERIFY_CANARY_FILE, MOUNT_CANARY_FILE);
    assert.strictEqual(MOUNT_VERIFY_CANARY_FILE, '.madar-mount-verify-canary');
  });

  test('both canaries stay dotfiles at the root, and neither can name the other', () => {
    for (const name of [MOUNT_CANARY_FILE, MOUNT_VERIFY_CANARY_FILE]) {
      assert.ok(name.startsWith('.'), `${name} must be a dotfile (the janitor and the file UI skip those)`);
      assert.ok(!name.includes('/') && !name.includes('\\'), `${name} must be a bare file name`);
      assert.ok(!name.includes('..'), `${name} must not traverse`);
    }
    assert.ok(!MOUNT_VERIFY_CANARY_FILE.includes(MOUNT_CANARY_FILE.slice(1)));
    assert.ok(!MOUNT_CANARY_FILE.includes(MOUNT_VERIFY_CANARY_FILE.slice(1)));
  });

  test('the probe argv defaults to the PROBE canary, never the audit canary', () => {
    const argv = buildProbeArgv('D:\\Work\\madar\\workspaces', 'wsd/workspace:latest');
    assert.deepStrictEqual(argv, [
      'run',
      '--rm',
      '-v',
      'D:\\Work\\madar\\workspaces:/probe',
      'wsd/workspace:latest',
      'test',
      '-f',
      `/probe/${MOUNT_VERIFY_CANARY_FILE}`,
    ]);
    assert.ok(argv[7].endsWith(MOUNT_VERIFY_CANARY_FILE));
    assert.ok(!argv[7].endsWith(MOUNT_CANARY_FILE));
  });

  test('a passed canary name is the one the probe looks for (one source of truth)', () => {
    assert.deepStrictEqual(
      buildProbeArgv('/host/ws', 'img', MOUNT_VERIFY_CANARY_FILE),
      buildProbeArgv('/host/ws', 'img'),
    );
    const override = buildProbeArgv('/host/ws', 'img', MOUNT_CANARY_FILE);
    assert.strictEqual(override[7], `/probe/${MOUNT_CANARY_FILE}`);
    assert.notStrictEqual(override[7], buildProbeArgv('/host/ws', 'img')[7]);
  });

  test('the argv is an argv, never a shell string (no quoting to get wrong)', () => {
    const argv = buildProbeArgv('D:\\My Projects\\ws; rm -rf /', 'img');
    assert.ok(Array.isArray(argv));
    assert.strictEqual(argv[3], 'D:\\My Projects\\ws; rm -rf /:/probe');
    assert.ok(!argv.some((a) => typeof a !== 'string' || a.includes("'")));
  });
});

describe('probeVerdictFor', () => {
  test('only the probe exit code 1 refutes the path', () => {
    assert.strictEqual(probeVerdictFor(null, true), 'proved', 'a clean run proves the path');
    assert.strictEqual(probeVerdictFor(1, false), 'refuted', 'test(1) = the canary was not visible');
  });

  test('docker 125+, a killed probe and a missing binary are all absent answers', () => {
    for (const status of [125, 126, 127, 2, 143, null, undefined]) {
      assert.strictEqual(probeVerdictFor(status, false), 'unknown', `status ${status} must stay permissive`);
    }
  });

  // REGRESSION GUARD: Node's execFile error carries the exit code on `code` and
  // has NO `status` key, so a mapping reading `err.status === 1` is dead code —
  // every refutation degraded to 'unknown' and the strongest creation-gate signal
  // never fired (measured live: an absent canary produced code:1, status:null).
  test('probeExitCode reads Node\'s `code`, with `status` only as a fallback', () => {
    assert.strictEqual(probeExitCode({ code: 1, killed: false, signal: null, cmd: 'docker run …' }), 1);
    assert.strictEqual(probeExitCode({ code: 125 }), 125);
    assert.strictEqual(probeExitCode({ status: 1 }), 1, 'a spawn-style error object still works');
    for (const err of [null, undefined, {}, { code: null }, { code: 'ENOENT' }, { killed: true }]) {
      assert.strictEqual(probeExitCode(err as any), null, `${JSON.stringify(err)} must read as "no answer"`);
    }
  });

  test('an absent canary refutes through the real mapping (the dead-branch proof)', () => {
    const execError = { code: 1, killed: false, signal: null, cmd: 'docker run …' };
    assert.strictEqual(probeVerdictFor(probeExitCode(execError), false), 'refuted');
  });

  test('an unavailable probe stays permissive in the creation gate', () => {
    assert.strictEqual(
      mountRefusalCode({ hostPath: 'D:\\Work\\madar\\workspaces', state: 'ok', verification: 'unknown' }),
      null,
    );
    assert.strictEqual(
      mountRefusalCode({ hostPath: 'D:\\Work\\madar\\workspaces', state: 'ok', verification: 'refuted' }),
      'refuted',
    );
    assert.strictEqual(
      mountRefusalCode({ hostPath: 'D:\\Work\\madar\\workspaces', state: 'ok', verification: 'proved' }),
      null,
    );
  });
});

describe('confirmProbeVerdict', () => {
  // A refuted verdict is PERSISTED and refuses project creation, so it may never
  // rest on one observation: a bind mount can hide a just-written file for a
  // moment, and a single miss must not take project creation down.
  test('two consecutive refutations are the only path to a blocking verdict', () => {
    assert.strictEqual(confirmProbeVerdict('refuted', 'refuted'), 'refuted');
  });

  test('a lone refutation degrades to the permissive answer', () => {
    assert.strictEqual(confirmProbeVerdict('refuted', 'unknown'), 'unknown');
    assert.strictEqual(confirmProbeVerdict('refuted', 'proved'), 'proved');
  });

  test('a second look that proves the path always wins', () => {
    assert.strictEqual(confirmProbeVerdict('unknown', 'proved'), 'proved');
    assert.strictEqual(confirmProbeVerdict('proved', 'unknown'), 'unknown');
    assert.strictEqual(confirmProbeVerdict('unknown', 'unknown'), 'unknown');
  });
});
