export const WORKSPACE_IMAGE_NAME = 'wsd/workspace:latest';
export const WORKSPACE_MARKER_PATH = '/etc/madar/workspace-toolchain.json';
export const WORKSPACE_TOOLCHAIN_SCHEMA = 1;
export const DEFAULT_WORKSPACE_STALE_DAYS = 30;
export const EXPECTED_WORKSPACE_TOOLCHAIN = {
  ubuntuVersionId: '26.04', nodeMajor: 24, nodeChannel: 'lts'
} as const;
export const WORKSPACE_LABELS = {
  schema: 'io.madar.workspace.toolchain.schema',
  image: 'io.madar.workspace.toolchain.image',
  buildId: 'io.madar.workspace.toolchain.build-id',
  builtAt: 'io.madar.workspace.toolchain.built-at',
  marker: 'io.madar.workspace.toolchain.marker',
  markerSchema: 'io.madar.workspace.toolchain.marker-schema',
  ubuntuVersionId: 'io.madar.workspace.toolchain.ubuntu-version-id',
  nodeMajor: 'io.madar.workspace.toolchain.node-major',
  nodeChannel: 'io.madar.workspace.toolchain.node-channel'
} as const;

export type WorkspaceNodeChannel = 'lts' | 'current';
export interface WorkspaceToolchainDeclared { ubuntuVersionId: string; nodeMajor: number; nodeChannel: WorkspaceNodeChannel; }
export interface WorkspaceToolchainActual { ubuntuVersionId: string; ubuntuPrettyName: string; node: string; nodeMajor: number; nodeChannel: WorkspaceNodeChannel; npm: string; dockerCli: boolean; }
export interface WorkspaceToolchainMarker {
  schema: 1; image: string; buildId: string; builtAt: string;
  declared: WorkspaceToolchainDeclared;
  actual: WorkspaceToolchainActual;
  checks: Record<'ubuntu'|'nodeMajor'|'nodeLts'|'npm'|'dockerCliAbsent', 'pass'|'fail'>;
}
export interface WorkspaceImageLabels {
  schema: number | null; image: string | null; buildId: string | null; builtAt: string | null;
  declared: WorkspaceToolchainDeclared | null; markerPath: string | null;
}
export interface DockerDaemonVersion { version: string; apiVersion: string }
export interface WorkspaceImageProjectState { slug: string; containerId: string | null; imageId: string | null; imageCurrent: boolean; running: boolean; }
export type WorkspaceImageSource = 'container-marker' | 'image-label' | 'unavailable';
export type WorkspaceImageDrift = 'ok' | 'declared_actual_mismatch' | 'target_mismatch' | 'unknown';
export interface WorkspaceImageStatus {
  name: string; installed: boolean; imageId: string | null; buildId: string | null; builtAt: string | null;
  stale: boolean; declared: WorkspaceToolchainDeclared | null; actual: WorkspaceToolchainActual | null;
  source: WorkspaceImageSource; drift: WorkspaceImageDrift; reasons: string[];
  daemon: DockerDaemonVersion | null; projects: WorkspaceImageProjectState[]; checkedAt: string;
}
export interface LastWorkspaceRefresh { at: string; ok: boolean; durationMs: number; buildId: string | null; errorCode: string | null; }

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNodeChannel(value: unknown): value is WorkspaceNodeChannel {
  return value === 'lts' || value === 'current';
}

function isIsoDateString(value: unknown): value is string {
  if (!nonEmptyString(value)) return false;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  return Number.isFinite(Date.parse(value));
}

function parseStrictInt(value: unknown): number | null {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^[+-]?\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) ? parsed : null;
}

function labelString(labels: Record<string, unknown>, key: string): string | null {
  const value = labels[key];
  return typeof value === 'string' ? value : null;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (nonEmptyString(value)) return value;
  }
  return null;
}

export function parseWorkspaceMarker(raw: string): WorkspaceToolchainMarker | null {
  if (typeof raw !== 'string') return null;
  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch {
    return null;
  }
  const obj = asRecord(root);
  if (!obj || obj.schema !== WORKSPACE_TOOLCHAIN_SCHEMA) return null;
  if (!nonEmptyString(obj.image) || !nonEmptyString(obj.buildId)) return null;
  if (!isIsoDateString(obj.builtAt)) return null;

  const declaredRaw = asRecord(obj.declared);
  if (!declaredRaw) return null;
  const declUbuntu = declaredRaw.ubuntuVersionId;
  const declMajor = declaredRaw.nodeMajor;
  const declChannel = declaredRaw.nodeChannel;
  if (!nonEmptyString(declUbuntu) || !Number.isInteger(declMajor) || !isNodeChannel(declChannel)) return null;

  const actualRaw = asRecord(obj.actual);
  if (!actualRaw) return null;
  const actUbuntu = actualRaw.ubuntuVersionId;
  const actPretty = actualRaw.ubuntuPrettyName;
  const actNode = actualRaw.node;
  const actMajor = actualRaw.nodeMajor;
  const actChannel = actualRaw.nodeChannel;
  const actNpm = actualRaw.npm;
  const actDockerCli = actualRaw.dockerCli;
  if (!nonEmptyString(actUbuntu) || !nonEmptyString(actPretty) || !nonEmptyString(actNode) ||
      !Number.isInteger(actMajor) || !isNodeChannel(actChannel) || !nonEmptyString(actNpm) ||
      typeof actDockerCli !== 'boolean') return null;

  const checksRaw = asRecord(obj.checks);
  if (!checksRaw) return null;
  const checkKeys = ['ubuntu', 'nodeMajor', 'nodeLts', 'npm', 'dockerCliAbsent'] as const;
  const checks = {} as WorkspaceToolchainMarker['checks'];
  for (const key of checkKeys) {
    const value = checksRaw[key];
    if (value !== 'pass' && value !== 'fail') return null;
    checks[key] = value;
  }

  return {
    schema: WORKSPACE_TOOLCHAIN_SCHEMA,
    image: obj.image,
    buildId: obj.buildId,
    builtAt: obj.builtAt,
    declared: {
      ubuntuVersionId: declUbuntu,
      nodeMajor: declMajor as number,
      nodeChannel: declChannel,
    },
    actual: {
      ubuntuVersionId: actUbuntu,
      ubuntuPrettyName: actPretty,
      node: actNode,
      nodeMajor: actMajor as number,
      nodeChannel: actChannel,
      npm: actNpm,
      dockerCli: actDockerCli,
    },
    checks: { ...checks },
  };
}

export function parseWorkspaceImageLabels(labels: Record<string, string> | null | undefined): WorkspaceImageLabels {
  const src = asRecord(labels) ?? {};
  const schema = parseStrictInt(src[WORKSPACE_LABELS.schema]);
  const nodeMajor = parseStrictInt(src[WORKSPACE_LABELS.nodeMajor]);
  const ubuntuVersionId = src[WORKSPACE_LABELS.ubuntuVersionId];
  const nodeChannel = src[WORKSPACE_LABELS.nodeChannel];
  const declared: WorkspaceToolchainDeclared | null =
    nonEmptyString(ubuntuVersionId) && nodeMajor !== null && isNodeChannel(nodeChannel)
      ? { ubuntuVersionId, nodeMajor, nodeChannel }
      : null;
  return {
    schema,
    image: labelString(src, WORKSPACE_LABELS.image),
    buildId: labelString(src, WORKSPACE_LABELS.buildId),
    builtAt: labelString(src, WORKSPACE_LABELS.builtAt),
    declared,
    markerPath: labelString(src, WORKSPACE_LABELS.marker),
  };
}

export function safeDockerDaemonVersion(info: unknown): DockerDaemonVersion | null {
  const obj = asRecord(info);
  if (!obj) return null;
  const version = firstNonEmptyString(obj.Version, obj.version);
  const apiVersion = firstNonEmptyString(obj.ApiVersion, obj.apiVersion);
  if (version === null || apiVersion === null) return null;
  return { version, apiVersion };
}

export function isWorkspaceImageStale(builtAt: string | null | undefined, nowMs?: number, maxAgeDays?: number): boolean {
  if (!nonEmptyString(builtAt)) return true;
  const builtMs = Date.parse(builtAt);
  if (!Number.isFinite(builtMs)) return true;
  const days = typeof maxAgeDays === 'number' && Number.isFinite(maxAgeDays) && maxAgeDays > 0
    ? maxAgeDays
    : DEFAULT_WORKSPACE_STALE_DAYS;
  const now = typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : Date.now();
  return now - builtMs >= days * 86400000;
}

export function compareWorkspaceToolchain(input: {
  declared: WorkspaceToolchainDeclared | null;
  actual: WorkspaceToolchainActual | null;
  source: WorkspaceImageSource;
}): WorkspaceImageDrift {
  if (input.source === 'unavailable' || input.declared === null || input.actual === null) return 'unknown';
  const declared = input.declared;
  if (declared.ubuntuVersionId !== EXPECTED_WORKSPACE_TOOLCHAIN.ubuntuVersionId ||
      declared.nodeMajor !== EXPECTED_WORKSPACE_TOOLCHAIN.nodeMajor ||
      declared.nodeChannel !== EXPECTED_WORKSPACE_TOOLCHAIN.nodeChannel) {
    return 'target_mismatch';
  }
  const actual = input.actual;
  if (actual.ubuntuVersionId !== declared.ubuntuVersionId ||
      actual.nodeMajor !== declared.nodeMajor ||
      actual.nodeChannel !== declared.nodeChannel) {
    return 'declared_actual_mismatch';
  }
  return 'ok';
}

export function deriveWorkspaceImageStatus(input: {
  labels: WorkspaceImageLabels;
  marker: WorkspaceToolchainMarker | null;
  daemon: DockerDaemonVersion | null;
  projects: WorkspaceImageProjectState[];
  nowMs?: number;
  maxAgeDays?: number;
}): WorkspaceImageStatus {
  const now = typeof input.nowMs === 'number' && Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  const marker = input.marker;
  const labels = input.labels;
  const buildId = marker?.buildId ?? labels.buildId ?? null;
  const builtAt = marker?.builtAt ?? labels.builtAt ?? null;
  const declared = labels.declared ?? marker?.declared ?? null;
  const actual = marker?.actual ?? null;
  const source: WorkspaceImageSource = marker ? 'container-marker' : labels.declared ? 'image-label' : 'unavailable';
  const imageId: string | null = null;
  const installed = imageId !== null;
  const stale = isWorkspaceImageStale(builtAt, now, input.maxAgeDays);
  const drift = compareWorkspaceToolchain({
    declared: labels.declared,
    actual: marker?.actual ?? null,
    source,
  });

  const reasons: string[] = [];
  if (stale) reasons.push('The workspace image build date is missing, invalid, or older than the allowed age.');
  if (drift === 'unknown') reasons.push('Workspace toolchain metadata is unavailable.');
  else if (drift === 'target_mismatch') reasons.push('The workspace image was built for a toolchain target that differs from the expected target.');
  else if (drift === 'declared_actual_mismatch') reasons.push('The workspace image declared metadata contradicts the toolchain detected inside the image.');

  return {
    name: WORKSPACE_IMAGE_NAME,
    installed,
    imageId,
    buildId,
    builtAt,
    stale,
    declared,
    actual,
    source,
    drift,
    reasons,
    daemon: input.daemon,
    projects: input.projects,
    checkedAt: new Date(now).toISOString(),
  };
}

export function buildWorkspaceRefreshArgv(input: {
  dockerfile: string;
  context: string;
  image?: string;
  buildId: string;
  builtAt: string;
}): string[] {
  if (!nonEmptyString(input.dockerfile)) throw new Error('dockerfile is required');
  if (!nonEmptyString(input.context)) throw new Error('context is required');
  if (!nonEmptyString(input.buildId)) throw new Error('buildId is required');
  if (!nonEmptyString(input.builtAt)) throw new Error('builtAt is required');
  const image = nonEmptyString(input.image) ? input.image : WORKSPACE_IMAGE_NAME;
  return [
    'build', '--pull', '--no-cache', '--file', input.dockerfile, '--tag', image,
    '--build-arg', `UBUNTU_VERSION=${EXPECTED_WORKSPACE_TOOLCHAIN.ubuntuVersionId}`,
    '--build-arg', `NODE_MAJOR=${EXPECTED_WORKSPACE_TOOLCHAIN.nodeMajor}`,
    '--build-arg', `NODE_CHANNEL=${EXPECTED_WORKSPACE_TOOLCHAIN.nodeChannel}`,
    '--build-arg', `MADAR_BUILD_ID=${input.buildId}`,
    '--build-arg', `MADAR_BUILD_AT=${input.builtAt}`,
    input.context,
  ];
}

export function sanitizeWorkspaceErrorLabel(raw: unknown): string {
  let msg = '';
  if (typeof raw === 'string') {
    msg = raw;
  } else if (raw instanceof Error) {
    msg = raw.message;
  } else {
    const obj = asRecord(raw);
    if (obj && typeof obj.message === 'string') msg = obj.message;
  }
  const text = msg.toLowerCase();
  if (!text.trim()) return 'workspace_image_error';
  if (/https?:\/\/|:\/\/|api[_-]?key|apikey|\bsecret\b|\bpassword\b|\btoken\b|bearer|proxy|\bkey\b|=/.test(text)) {
    return 'workspace_build_failed';
  }
  if (/(docker|daemon|socket|econnrefused|no such (file|container))/.test(text)) return 'docker_unavailable';
  if (/(timed?[ -]?out|etimedout)/.test(text)) return 'timeout';
  if (/workspace/.test(text) && /unavailable|not available|missing/.test(text)) return 'workspace_build_unavailable';
  if (/build/.test(text)) return 'build_failed';
  return 'workspace_image_error';
}
