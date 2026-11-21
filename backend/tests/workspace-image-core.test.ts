import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  WORKSPACE_IMAGE_NAME,
  WORKSPACE_MARKER_PATH,
  DEFAULT_WORKSPACE_STALE_DAYS,
  EXPECTED_WORKSPACE_TOOLCHAIN,
  WORKSPACE_LABELS,
  parseWorkspaceMarker,
  parseWorkspaceImageLabels,
  safeDockerDaemonVersion,
  isWorkspaceImageStale,
  compareWorkspaceToolchain,
  deriveWorkspaceImageStatus,
  buildWorkspaceRefreshArgv,
  sanitizeWorkspaceErrorLabel,
  type WorkspaceToolchainMarker,
  type WorkspaceToolchainDeclared,
  type WorkspaceToolchainActual,
  type WorkspaceImageLabels,
} from '../src/services/workspace-image-core.ts';

const BUILT_AT = '2026-11-01T00:00:00.000Z';
const DAY_MS = 86400000;

function validMarkerObject(): WorkspaceToolchainMarker {
  return {
    schema: 1,
    image: WORKSPACE_IMAGE_NAME,
    buildId: 'build-abc123',
    builtAt: BUILT_AT,
    declared: { ubuntuVersionId: '26.04', nodeMajor: 24, nodeChannel: 'lts' },
    actual: {
      ubuntuVersionId: '26.04',
      ubuntuPrettyName: 'Ubuntu 26.04 LTS',
      node: 'v24.9.0',
      nodeMajor: 24,
      nodeChannel: 'lts',
      npm: '11.2.0',
      dockerCli: false,
    },
    checks: { ubuntu: 'pass', nodeMajor: 'pass', nodeLts: 'pass', npm: 'pass', dockerCliAbsent: 'pass' },
  };
}

function mutatedMarker(mutator: (obj: Record<string, unknown>) => void): string {
  const obj = JSON.parse(JSON.stringify(validMarkerObject())) as Record<string, unknown>;
  mutator(obj);
  return JSON.stringify(obj);
}

function validLabelsObject(): Record<string, string> {
  return {
    [WORKSPACE_LABELS.schema]: '1',
    [WORKSPACE_LABELS.image]: WORKSPACE_IMAGE_NAME,
    [WORKSPACE_LABELS.buildId]: 'build-abc123',
    [WORKSPACE_LABELS.builtAt]: BUILT_AT,
    [WORKSPACE_LABELS.marker]: WORKSPACE_MARKER_PATH,
    [WORKSPACE_LABELS.ubuntuVersionId]: '26.04',
    [WORKSPACE_LABELS.nodeMajor]: '24',
    [WORKSPACE_LABELS.nodeChannel]: 'lts',
  };
}

function validDeclared(): WorkspaceToolchainDeclared {
  return { ubuntuVersionId: '26.04', nodeMajor: 24, nodeChannel: 'lts' };
}

function validActual(overrides: Partial<WorkspaceToolchainActual> = {}): WorkspaceToolchainActual {
  return {
    ubuntuVersionId: '26.04',
    ubuntuPrettyName: 'Ubuntu 26.04 LTS',
    node: 'v24.9.0',
    nodeMajor: 24,
    nodeChannel: 'lts',
    npm: '11.2.0',
    dockerCli: false,
    ...overrides,
  };
}

describe('parseWorkspaceMarker — valid + strict schema', () => {
  test('a well-formed marker round-trips every field', () => {
    const parsed = parseWorkspaceMarker(JSON.stringify(validMarkerObject()));
    assert.deepStrictEqual(parsed, validMarkerObject());
  });

  test('returned object and nested objects are fresh, not the parsed alias', () => {
    const raw = JSON.stringify(validMarkerObject());
    const source = JSON.parse(raw) as Record<string, unknown>;
    const parsed = parseWorkspaceMarker(raw);
    assert.ok(parsed);
    assert.notStrictEqual(parsed, source);
    assert.notStrictEqual(parsed.declared, source.declared);
    assert.notStrictEqual(parsed.actual, source.actual);
    assert.notStrictEqual(parsed.checks, source.checks);
  });

  test('published constants carry the pinned values', () => {
    assert.strictEqual(WORKSPACE_IMAGE_NAME, 'wsd/workspace:latest');
    assert.strictEqual(WORKSPACE_MARKER_PATH, '/etc/madar/workspace-toolchain.json');
    assert.strictEqual(DEFAULT_WORKSPACE_STALE_DAYS, 30);
    assert.deepStrictEqual(EXPECTED_WORKSPACE_TOOLCHAIN, { ubuntuVersionId: '26.04', nodeMajor: 24, nodeChannel: 'lts' });
    assert.strictEqual(WORKSPACE_LABELS.buildId, 'io.madar.workspace.toolchain.build-id');
  });
});

describe('parseWorkspaceMarker — malformed input returns null', () => {
  test('wrong schema (2) is refused', () => {
    assert.strictEqual(parseWorkspaceMarker(mutatedMarker(o => { o.schema = 2; })), null);
  });

  test('string schema "1" is refused (strict schema === 1)', () => {
    assert.strictEqual(parseWorkspaceMarker(mutatedMarker(o => { o.schema = '1'; })), null);
  });

  test('non-object JSON roots are refused', () => {
    assert.strictEqual(parseWorkspaceMarker('[]'), null);
    assert.strictEqual(parseWorkspaceMarker('null'), null);
    assert.strictEqual(parseWorkspaceMarker('"hello"'), null);
    assert.strictEqual(parseWorkspaceMarker('42'), null);
  });

  test('invalid JSON and non-string input are refused without throwing', () => {
    assert.strictEqual(parseWorkspaceMarker('{not json'), null);
    assert.strictEqual(parseWorkspaceMarker(''), null);
    assert.strictEqual(parseWorkspaceMarker(undefined as unknown as string), null);
  });

  test('missing or blank image / buildId is refused', () => {
    assert.strictEqual(parseWorkspaceMarker(mutatedMarker(o => { delete o.image; })), null);
    assert.strictEqual(parseWorkspaceMarker(mutatedMarker(o => { o.image = '   '; })), null);
    assert.strictEqual(parseWorkspaceMarker(mutatedMarker(o => { delete o.buildId; })), null);
  });

  test('bad ISO builtAt is refused', () => {
    assert.strictEqual(parseWorkspaceMarker(mutatedMarker(o => { o.builtAt = 'not-a-date'; })), null);
    assert.strictEqual(parseWorkspaceMarker(mutatedMarker(o => { o.builtAt = '2026-13-99T00:00:00Z'; })), null);
    assert.strictEqual(parseWorkspaceMarker(mutatedMarker(o => { delete o.builtAt; })), null);
  });

  test('declared field violations are refused', () => {
    assert.strictEqual(parseWorkspaceMarker(mutatedMarker(o => { (o.declared as Record<string, unknown>).nodeMajor = 24.5; })), null);
    assert.strictEqual(parseWorkspaceMarker(mutatedMarker(o => { (o.declared as Record<string, unknown>).nodeChannel = 'beta'; })), null);
    assert.strictEqual(parseWorkspaceMarker(mutatedMarker(o => { delete o.declared; })), null);
  });

  test('non-boolean dockerCli and missing actual fields are refused', () => {
    assert.strictEqual(parseWorkspaceMarker(mutatedMarker(o => { (o.actual as Record<string, unknown>).dockerCli = 'false'; })), null);
    assert.strictEqual(parseWorkspaceMarker(mutatedMarker(o => { (o.actual as Record<string, unknown>).nodeMajor = '24'; })), null);
    assert.strictEqual(parseWorkspaceMarker(mutatedMarker(o => { delete (o.actual as Record<string, unknown>).npm; })), null);
  });

  test('checks with a bad value or a missing key are refused', () => {
    assert.strictEqual(parseWorkspaceMarker(mutatedMarker(o => { (o.checks as Record<string, unknown>).ubuntu = 'warn'; })), null);
    assert.strictEqual(parseWorkspaceMarker(mutatedMarker(o => { delete (o.checks as Record<string, unknown>).dockerCliAbsent; })), null);
    assert.strictEqual(parseWorkspaceMarker(mutatedMarker(o => { o.checks = 'all-pass'; })), null);
  });
});

describe('parseWorkspaceImageLabels — strict parsing', () => {
  test('null / undefined / junk never throw and yield the all-null shape', () => {
    const empty: WorkspaceImageLabels = {
      schema: null, image: null, buildId: null, builtAt: null, declared: null, markerPath: null,
    };
    assert.deepStrictEqual(parseWorkspaceImageLabels(null), empty);
    assert.deepStrictEqual(parseWorkspaceImageLabels(undefined), empty);
    assert.deepStrictEqual(parseWorkspaceImageLabels('junk' as unknown as Record<string, string>), empty);
    assert.deepStrictEqual(parseWorkspaceImageLabels([] as unknown as Record<string, string>), empty);
  });

  test('valid labels parse strict ints and a complete declared object', () => {
    const parsed = parseWorkspaceImageLabels(validLabelsObject());
    assert.strictEqual(parsed.schema, 1);
    assert.strictEqual(parsed.image, WORKSPACE_IMAGE_NAME);
    assert.strictEqual(parsed.buildId, 'build-abc123');
    assert.strictEqual(parsed.builtAt, BUILT_AT);
    assert.strictEqual(parsed.markerPath, WORKSPACE_MARKER_PATH);
    assert.deepStrictEqual(parsed.declared, validDeclared());
  });

  test('schema and nodeMajor junk fall back to null; numeric strings parse', () => {
    const labels = validLabelsObject();
    labels[WORKSPACE_LABELS.schema] = 'one';
    labels[WORKSPACE_LABELS.nodeMajor] = '24.5';
    let parsed = parseWorkspaceImageLabels(labels);
    assert.strictEqual(parsed.schema, null);
    assert.strictEqual(parsed.declared, null);

    labels[WORKSPACE_LABELS.schema] = '1';
    labels[WORKSPACE_LABELS.nodeMajor] = '24';
    parsed = parseWorkspaceImageLabels(labels);
    assert.strictEqual(parsed.schema, 1);
    assert.deepStrictEqual(parsed.declared, validDeclared());
  });

  test('declared is non-null only when all three parts are valid', () => {
    const missingChannel = validLabelsObject();
    delete missingChannel[WORKSPACE_LABELS.nodeChannel];
    assert.strictEqual(parseWorkspaceImageLabels(missingChannel).declared, null);

    const badChannel = validLabelsObject();
    badChannel[WORKSPACE_LABELS.nodeChannel] = 'nightly';
    assert.strictEqual(parseWorkspaceImageLabels(badChannel).declared, null);

    const badUbuntu = validLabelsObject();
    badUbuntu[WORKSPACE_LABELS.ubuntuVersionId] = '   ';
    assert.strictEqual(parseWorkspaceImageLabels(badUbuntu).declared, null);
  });

  test('builtAt is echoed raw even when invalid (stale rule owns validity)', () => {
    const labels = validLabelsObject();
    labels[WORKSPACE_LABELS.builtAt] = 'garbage-date';
    assert.strictEqual(parseWorkspaceImageLabels(labels).builtAt, 'garbage-date');
  });
});

describe('safeDockerDaemonVersion — allowlist of two fields', () => {
  test('accepts dockerode-style Version/ApiVersion and leaks nothing else', () => {
    const info = { Version: '27.1.1', ApiVersion: '1.46', Name: 'docker-host', ID: 'ABC', KernelVersion: '6.1', secret: 'nope' };
    assert.deepStrictEqual(safeDockerDaemonVersion(info), { version: '27.1.1', apiVersion: '1.46' });
  });

  test('accepts lowercase version shape', () => {
    assert.deepStrictEqual(safeDockerDaemonVersion({ version: '24.0.7', apiVersion: '1.43' }), { version: '24.0.7', apiVersion: '1.43' });
  });

  test('junk / missing fields return null', () => {
    assert.strictEqual(safeDockerDaemonVersion(null), null);
    assert.strictEqual(safeDockerDaemonVersion('docker'), null);
    assert.strictEqual(safeDockerDaemonVersion({ Version: '27.1.1' }), null);
    assert.strictEqual(safeDockerDaemonVersion({ Version: '  ', ApiVersion: '1.46' }), null);
    assert.strictEqual(safeDockerDaemonVersion([]), null);
  });
});

describe('isWorkspaceImageStale — boundary + fallback', () => {
  test('missing / blank / unparseable builtAt is stale', () => {
    assert.strictEqual(isWorkspaceImageStale(null), true);
    assert.strictEqual(isWorkspaceImageStale(undefined), true);
    assert.strictEqual(isWorkspaceImageStale(''), true);
    assert.strictEqual(isWorkspaceImageStale('   '), true);
    assert.strictEqual(isWorkspaceImageStale('not-a-date'), true);
  });

  test('exactly at the boundary is stale, one millisecond inside is not', () => {
    const built = Date.parse(BUILT_AT);
    assert.strictEqual(isWorkspaceImageStale(BUILT_AT, built + 30 * DAY_MS, 30), true);
    assert.strictEqual(isWorkspaceImageStale(BUILT_AT, built + 30 * DAY_MS - 1, 30), false);
  });

  test('custom maxAgeDays is honored', () => {
    const built = Date.parse(BUILT_AT);
    assert.strictEqual(isWorkspaceImageStale(BUILT_AT, built + 10 * DAY_MS, 7), true);
    assert.strictEqual(isWorkspaceImageStale(BUILT_AT, built + 10 * DAY_MS, 30), false);
  });

  test('junk / <=0 maxAgeDays falls back to the default of 30', () => {
    const built = Date.parse(BUILT_AT);
    assert.strictEqual(isWorkspaceImageStale(BUILT_AT, built + 10 * DAY_MS, 0), false);
    assert.strictEqual(isWorkspaceImageStale(BUILT_AT, built + 10 * DAY_MS, -5), false);
    assert.strictEqual(isWorkspaceImageStale(BUILT_AT, built + 10 * DAY_MS, Number.NaN), false);
    assert.strictEqual(isWorkspaceImageStale(BUILT_AT, built + 10 * DAY_MS, 'x' as unknown as number), false);
  });

  test('a future build date is not stale', () => {
    const built = Date.parse(BUILT_AT);
    assert.strictEqual(isWorkspaceImageStale(BUILT_AT, built - 1000, 30), false);
  });
});

describe('compareWorkspaceToolchain — all four drift values', () => {
  test('unavailable source is unknown', () => {
    assert.strictEqual(compareWorkspaceToolchain({ declared: validDeclared(), actual: validActual(), source: 'unavailable' }), 'unknown');
  });

  test('missing declared or actual is unknown', () => {
    assert.strictEqual(compareWorkspaceToolchain({ declared: null, actual: validActual(), source: 'container-marker' }), 'unknown');
    assert.strictEqual(compareWorkspaceToolchain({ declared: validDeclared(), actual: null, source: 'image-label' }), 'unknown');
  });

  test('declared differing from the expected target is target_mismatch', () => {
    assert.strictEqual(compareWorkspaceToolchain({ declared: { ...validDeclared(), ubuntuVersionId: '24.04' }, actual: validActual(), source: 'container-marker' }), 'target_mismatch');
    assert.strictEqual(compareWorkspaceToolchain({ declared: { ...validDeclared(), nodeMajor: 22 }, actual: validActual(), source: 'container-marker' }), 'target_mismatch');
    assert.strictEqual(compareWorkspaceToolchain({ declared: { ...validDeclared(), nodeChannel: 'current' }, actual: validActual(), source: 'container-marker' }), 'target_mismatch');
  });

  test('actual contradicting the declared metadata is declared_actual_mismatch', () => {
    assert.strictEqual(compareWorkspaceToolchain({ declared: validDeclared(), actual: validActual({ ubuntuVersionId: '22.04' }), source: 'container-marker' }), 'declared_actual_mismatch');
    assert.strictEqual(compareWorkspaceToolchain({ declared: validDeclared(), actual: validActual({ nodeMajor: 22 }), source: 'container-marker' }), 'declared_actual_mismatch');
    assert.strictEqual(compareWorkspaceToolchain({ declared: validDeclared(), actual: validActual({ nodeChannel: 'current' }), source: 'container-marker' }), 'declared_actual_mismatch');
  });

  test('node PATCH differences within the same major are ok', () => {
    const a = compareWorkspaceToolchain({ declared: validDeclared(), actual: validActual({ node: 'v24.1.0', npm: '11.0.0' }), source: 'container-marker' });
    const b = compareWorkspaceToolchain({ declared: validDeclared(), actual: validActual({ node: 'v24.9.0', npm: '11.9.9' }), source: 'container-marker' });
    assert.strictEqual(a, 'ok');
    assert.strictEqual(b, 'ok');
  });

  test('fully consistent metadata is ok', () => {
    assert.strictEqual(compareWorkspaceToolchain({ declared: validDeclared(), actual: validActual(), source: 'container-marker' }), 'ok');
  });
});

describe('buildWorkspaceRefreshArgv — exact argv + guards', () => {
  test('argv is exact and ordered with the default image', () => {
    const argv = buildWorkspaceRefreshArgv({
      dockerfile: 'backend/docker/Dockerfile.workspace',
      context: 'backend/docker',
      buildId: 'b-123',
      builtAt: BUILT_AT,
    });
    assert.deepStrictEqual(argv, [
      'build', '--pull', '--no-cache', '--file', 'backend/docker/Dockerfile.workspace', '--tag', 'wsd/workspace:latest',
      '--build-arg', 'UBUNTU_VERSION=26.04',
      '--build-arg', 'NODE_MAJOR=24',
      '--build-arg', 'NODE_CHANNEL=lts',
      '--build-arg', 'MADAR_BUILD_ID=b-123',
      '--build-arg', `MADAR_BUILD_AT=${BUILT_AT}`,
      'backend/docker',
    ]);
  });

  test('an explicit image overrides the default', () => {
    const argv = buildWorkspaceRefreshArgv({ dockerfile: 'D', context: 'C', image: 'custom/workspace:v2', buildId: 'b', builtAt: 't' });
    assert.strictEqual(argv[argv.indexOf('--tag') + 1], 'custom/workspace:v2');
  });

  test('special characters stay inside one argv element (no shell)', () => {
    const argv = buildWorkspaceRefreshArgv({ dockerfile: 'D', context: 'C', buildId: 'a b; rm -rf /', builtAt: 't' });
    assert.ok(argv.includes('MADAR_BUILD_ID=a b; rm -rf /'));
    assert.strictEqual(argv.length, 18);
  });

  test('empty dockerfile / context / buildId / builtAt throw a plain Error', () => {
    const base = { dockerfile: 'D', context: 'C', buildId: 'b', builtAt: 't' };
    assert.throws(() => buildWorkspaceRefreshArgv({ ...base, dockerfile: '' }), (e: unknown) => e instanceof Error && /dockerfile is required/.test((e as Error).message));
    assert.throws(() => buildWorkspaceRefreshArgv({ ...base, context: '  ' }), (e: unknown) => e instanceof Error && /context is required/.test((e as Error).message));
    assert.throws(() => buildWorkspaceRefreshArgv({ ...base, buildId: '' }), (e: unknown) => e instanceof Error && /buildId is required/.test((e as Error).message));
    assert.throws(() => buildWorkspaceRefreshArgv({ ...base, builtAt: '' }), (e: unknown) => e instanceof Error && /builtAt is required/.test((e as Error).message));
  });
});

describe('sanitizeWorkspaceErrorLabel — leakage resistance', () => {
  test('URL / key / proxy fragments collapse to workspace_build_failed', () => {
    assert.strictEqual(sanitizeWorkspaceErrorLabel('fetch failed: https://registry.example.com/v2/?token=sk-live-SECRET'), 'workspace_build_failed');
    assert.strictEqual(sanitizeWorkspaceErrorLabel('proxy api_key=abcd blocked'), 'workspace_build_failed');
    assert.strictEqual(sanitizeWorkspaceErrorLabel('unix:///var/run/docker.sock failed'), 'workspace_build_failed');
  });

  test('raw secret material is never echoed', () => {
    const out = sanitizeWorkspaceErrorLabel(new Error('build failed with sk-live-SECRET123 at https://evil.example/x'));
    assert.ok(!out.includes('SECRET123'));
    assert.ok(!out.includes('https://'));
    assert.strictEqual(out, 'workspace_build_failed');
  });

  test('recognised cases map to fixed non-sensitive labels', () => {
    assert.strictEqual(sanitizeWorkspaceErrorLabel('Docker daemon unavailable'), 'docker_unavailable');
    assert.strictEqual(sanitizeWorkspaceErrorLabel('ETIMEDOUT after waiting'), 'timeout');
    assert.strictEqual(sanitizeWorkspaceErrorLabel('workspace build unavailable - missing tool'), 'workspace_build_unavailable');
    assert.strictEqual(sanitizeWorkspaceErrorLabel('build step exited 1'), 'build_failed');
  });

  test('junk / null / undefined yield a non-empty generic label', () => {
    for (const junk of [null, undefined, 42, {}, '', '   ']) {
      const out = sanitizeWorkspaceErrorLabel(junk);
      assert.ok(out.length > 0);
      assert.strictEqual(out, 'workspace_image_error');
    }
  });
});

describe('deriveWorkspaceImageStatus — assembly, source + reasons', () => {
  test('marker source: healthy status uses marker data and passes daemon/projects verbatim', () => {
    const marker = validMarkerObject();
    const daemon = { version: '27.1.1', apiVersion: '1.46' };
    const projects = [{ slug: 'app', containerId: 'cid', imageId: 'iid', imageCurrent: true, running: true }];
    const nowMs = Date.parse(BUILT_AT) + DAY_MS;
    const status = deriveWorkspaceImageStatus({
      labels: parseWorkspaceImageLabels(validLabelsObject()),
      marker,
      daemon,
      projects,
      nowMs,
    });
    assert.strictEqual(status.name, WORKSPACE_IMAGE_NAME);
    assert.strictEqual(status.installed, false);
    assert.strictEqual(status.imageId, null);
    assert.strictEqual(status.buildId, 'build-abc123');
    assert.strictEqual(status.builtAt, BUILT_AT);
    assert.deepStrictEqual(status.declared, validDeclared());
    assert.deepStrictEqual(status.actual, validActual());
    assert.strictEqual(status.source, 'container-marker');
    assert.strictEqual(status.drift, 'ok');
    assert.strictEqual(status.stale, false);
    assert.deepStrictEqual(status.reasons, []);
    assert.strictEqual(status.daemon, daemon);
    assert.strictEqual(status.projects, projects);
    assert.strictEqual(status.checkedAt, new Date(nowMs).toISOString());
  });

  test('image-label source: no marker → source image-label, drift unknown, reason present', () => {
    const nowMs = Date.parse(BUILT_AT) + DAY_MS;
    const status = deriveWorkspaceImageStatus({
      labels: parseWorkspaceImageLabels(validLabelsObject()),
      marker: null,
      daemon: null,
      projects: [],
      nowMs,
    });
    assert.strictEqual(status.source, 'image-label');
    assert.strictEqual(status.drift, 'unknown');
    assert.strictEqual(status.stale, false);
    assert.deepStrictEqual(status.declared, validDeclared());
    assert.strictEqual(status.actual, null);
    assert.strictEqual(status.reasons.length, 1);
    assert.match(status.reasons[0], /metadata is unavailable/i);
  });

  test('unavailable source: no labels and no marker → stale + unknown reasons, declared null', () => {
    const status = deriveWorkspaceImageStatus({
      labels: parseWorkspaceImageLabels(null),
      marker: null,
      daemon: null,
      projects: [],
      nowMs: Date.parse(BUILT_AT),
    });
    assert.strictEqual(status.source, 'unavailable');
    assert.strictEqual(status.drift, 'unknown');
    assert.strictEqual(status.stale, true);
    assert.strictEqual(status.declared, null);
    assert.strictEqual(status.actual, null);
    assert.strictEqual(status.reasons.length, 2);
  });

  test('stale + target mismatch reasons are human-readable and contain no host paths', () => {
    const oldBuiltAt = '2026-01-01T00:00:00.000Z';
    const labels = validLabelsObject();
    labels[WORKSPACE_LABELS.builtAt] = oldBuiltAt;
    labels[WORKSPACE_LABELS.nodeMajor] = '22';
    const marker = validMarkerObject();
    marker.builtAt = oldBuiltAt;
    marker.declared.nodeMajor = 22;
    marker.actual.nodeMajor = 22;
    const status = deriveWorkspaceImageStatus({
      labels: parseWorkspaceImageLabels(labels),
      marker,
      daemon: null,
      projects: [],
      nowMs: Date.parse('2026-06-01T00:00:00.000Z'),
    });
    assert.strictEqual(status.stale, true);
    assert.strictEqual(status.drift, 'target_mismatch');
    assert.strictEqual(status.reasons.length, 2);
    for (const reason of status.reasons) {
      assert.ok(!reason.includes('/etc/'));
      assert.ok(!reason.includes('sk-live-'));
      assert.ok(reason.length > 0);
    }
  });

  test('declared_actual_mismatch propagates with its reason', () => {
    const marker = validMarkerObject();
    marker.actual.nodeMajor = 22;
    const status = deriveWorkspaceImageStatus({
      labels: parseWorkspaceImageLabels(validLabelsObject()),
      marker,
      daemon: null,
      projects: [],
      nowMs: Date.parse(BUILT_AT) + DAY_MS,
    });
    assert.strictEqual(status.drift, 'declared_actual_mismatch');
    assert.strictEqual(status.reasons.length, 1);
    assert.match(status.reasons[0], /contradicts/i);
  });

  test('marker buildId / builtAt take precedence over label values', () => {
    const labels = validLabelsObject();
    labels[WORKSPACE_LABELS.buildId] = 'label-build';
    labels[WORKSPACE_LABELS.builtAt] = '2020-01-01T00:00:00.000Z';
    const marker = validMarkerObject();
    marker.buildId = 'marker-build';
    marker.builtAt = BUILT_AT;
    const status = deriveWorkspaceImageStatus({
      labels: parseWorkspaceImageLabels(labels),
      marker,
      daemon: null,
      projects: [],
      nowMs: Date.parse(BUILT_AT) + DAY_MS,
    });
    assert.strictEqual(status.buildId, 'marker-build');
    assert.strictEqual(status.builtAt, BUILT_AT);
    assert.strictEqual(status.stale, false);
  });
});
