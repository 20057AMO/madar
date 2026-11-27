#!/usr/bin/env node
// Local pre-commit secret gate. --install is online once; commit scans are offline.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const VERSION = '8.28.0';
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const INSTALL_DIR = path.join(os.homedir(), '.madar', 'secret-gate');
export const CONFIG_NAME = '.gitleaks.toml';
export const SCAN_ARGS = ['protect', '--staged', '--redact', '--no-banner', '--config', CONFIG_NAME];

// Official checksums.txt digests for v8.28.0. Manifest line AND archive must agree.
const PINNED_ARCHIVES = Object.freeze({
  'win32-x64': {
    archive: 'gitleaks_8.28.0_windows_x64.zip',
    sha256: 'da6458e8864af553807de1c46a7a8eac0880bd6b99ba56288e87e86a45af884f',
  },
  'linux-x64': {
    archive: 'gitleaks_8.28.0_linux_x64.tar.gz',
    sha256: 'a65b5253807a68ac0cafa4414031fd740aeb55f54fb7e55f386acb52e6a840eb',
  },
  'linux-arm64': {
    archive: 'gitleaks_8.28.0_linux_arm64.tar.gz',
    sha256: 'eff65261156100e5d94a6b3dec313d532fddfe19ae1590bf7a2b4f2699128356',
  },
  'darwin-x64': {
    archive: 'gitleaks_8.28.0_darwin_x64.tar.gz',
    sha256: 'edf5a507008b0d2ef4959575772772770586409c1f6f74dabf19cbe7ec341ced',
  },
  'darwin-arm64': {
    archive: 'gitleaks_8.28.0_darwin_arm64.tar.gz',
    sha256: 'd942f3ad147250c9edbaab3fed9e482f98d3b59ba10ae97b8d75647e3ade492c',
  },
});

export class GateError extends Error {
  constructor(message) { super(message); this.name = 'GateError'; }
}

function fail(message) { throw new GateError(message); }

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}
function platformPin() {
  const osKey = process.platform === 'win32' ? 'win32'
    : (process.platform === 'linux' || process.platform === 'darwin') ? process.platform : null;
  const arch = process.arch === 'x64' || process.arch === 'arm64' ? process.arch : null;
  if (!osKey || !arch) fail('Unsupported gitleaks platform ' + process.platform + '/' + process.arch);
  const key = osKey + '-' + arch;
  const pin = PINNED_ARCHIVES[key];
  if (!pin) fail('No pinned gitleaks archive for ' + key);
  return { key, pin };
}

export function binPaths(installDir = INSTALL_DIR) {
  return {
    binary: path.join(installDir, process.platform === 'win32' ? 'gitleaks.exe' : 'gitleaks'),
    state: path.join(installDir, 'gitleaks.sha256'),
  };
}
function assertGitleaksVersion(binary) {
  const probe = spawnSync(binary, ['version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (probe.error || probe.status !== 0 || !String(probe.stdout || '').includes(VERSION)) {
    fail('gitleaks version check failed; expected ' + VERSION);
  }
}

async function download(url) {
  let response;
  try {
    response = await fetch(url, { redirect: 'follow' });
  } catch (error) {
    fail('download failed for ' + new URL(url).pathname + ': ' + error.message);
  }
  if (!response.ok) fail('download failed for ' + new URL(url).pathname + ' (HTTP ' + response.status + ')');
  return Buffer.from(await response.arrayBuffer());
}

function psQuote(value) {
  return "'" + value.replace(/'/g, "''") + "'";
}

function extractArchive(archivePath, destination, isZip) {
  fs.mkdirSync(destination, { recursive: true });
  if (isZip) {
    const command = 'Expand-Archive -LiteralPath ' + psQuote(archivePath) + ' -DestinationPath ' + psQuote(destination) + ' -Force';
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { stdio: 'pipe' });
  } else {
    execFileSync('tar', ['-xzf', archivePath, '-C', destination, 'gitleaks'], { stdio: 'pipe' });
  }
}

const RELEASE_BASE = 'https://github.com/gitleaks/gitleaks/releases/download/v' + VERSION;
const CHECKSUMS_NAME = 'gitleaks_' + VERSION + '_checksums.txt';
const HEX64 = /^[0-9a-f]{64}$/i;

export async function install({ installDir = INSTALL_DIR, repoRoot = REPO_ROOT, setHook = true } = {}) {
  const { pin } = platformPin();
  const manifest = (await download(RELEASE_BASE + '/' + CHECKSUMS_NAME)).toString('utf8');
  const line = manifest.split(/\r?\n/).map(function (row) { return row.trim(); })
    .find(function (row) { return row.endsWith(' ' + pin.archive) || row.endsWith('\t' + pin.archive) || row.endsWith('*' + pin.archive); });
  if (!line) fail('checksums.txt has no entry for ' + pin.archive);
  const manifestDigest = line.split(/\s+/)[0];
  if (!HEX64.test(manifestDigest)) fail('checksums.txt digest is malformed for ' + pin.archive);
  if (manifestDigest.toLowerCase() !== pin.sha256) fail('pinned digest disagrees with official checksums.txt for ' + pin.archive);

  const archive = await download(RELEASE_BASE + '/' + pin.archive);
  const archiveDigest = sha256(archive);
  if (archiveDigest !== manifestDigest.toLowerCase() || archiveDigest !== pin.sha256) {
    fail('archive SHA-256 mismatch for ' + pin.archive);
  }

  fs.mkdirSync(installDir, { recursive: true });
  const staging = fs.mkdtempSync(path.join(installDir, '.install-'));
  try {
    const archivePath = path.join(staging, pin.archive);
    fs.writeFileSync(archivePath, archive);
    extractArchive(archivePath, path.join(staging, 'unpacked'), process.platform === 'win32');

    const name = process.platform === 'win32' ? 'gitleaks.exe' : 'gitleaks';
    const extracted = path.join(staging, 'unpacked', name);
    if (!fs.existsSync(extracted)) fail('archive did not contain ' + name);
    const binaryDigest = sha256(fs.readFileSync(extracted));
    assertGitleaksVersion(extracted);


    const paths = binPaths(installDir);
    fs.copyFileSync(extracted, paths.binary);
    if (process.platform !== 'win32') fs.chmodSync(paths.binary, 0o755);
    const record = JSON.stringify({
      version: VERSION,
      archive: pin.archive,
      archiveSha256: archiveDigest,
      binarySha256: binaryDigest,
      installedAt: new Date().toISOString(),
    }, null, 2) + '\n';
    fs.writeFileSync(paths.state, record, { mode: 0o600 });

    if (setHook) {
      execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: repoRoot, stdio: 'pipe' });
    }
    console.log('Secret gate installed: ' + paths.binary + ' (gitleaks ' + VERSION + ', SHA-256 verified)');
    if (setHook) console.log('Git hooks path set to .githooks in ' + repoRoot);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
export function verifyInstalled(installDir = INSTALL_DIR) {
  const paths = binPaths(installDir);
  if (!fs.existsSync(paths.binary)) {
    fail('gitleaks binary is missing at ' + paths.binary + '. Run: node scripts/check-secrets.mjs --install (once, online).');
  }
  if (!fs.existsSync(paths.state)) {
    fail('gitleaks integrity record is missing at ' + paths.state + '. Re-run: node scripts/check-secrets.mjs --install');
  }
  let record;
  try {
    record = JSON.parse(fs.readFileSync(paths.state, 'utf8'));
  } catch {
    fail('gitleaks integrity record is corrupt at ' + paths.state + '. Re-run: node scripts/check-secrets.mjs --install');
  }
  if (!record || record.version !== VERSION || !HEX64.test(String(record.binarySha256 || ''))) {
    fail('gitleaks integrity record is invalid. Re-run: node scripts/check-secrets.mjs --install');
  }
  const actual = sha256(fs.readFileSync(paths.binary));
  if (actual !== String(record.binarySha256).toLowerCase()) {
    fail('gitleaks binary failed its integrity check (tampered or wrong version). Re-run: node scripts/check-secrets.mjs --install');
  }
  assertGitleaksVersion(paths.binary);
  return paths.binary;
}

export function runScan({ installDir = INSTALL_DIR, repoRoot = REPO_ROOT } = {}) {
  const binary = verifyInstalled(installDir);
  const config = path.join(repoRoot, CONFIG_NAME);
  if (!fs.existsSync(config)) fail('missing ' + CONFIG_NAME + ' in ' + repoRoot);
  // No network, no history scan: the staged diff is the only input.
  const result = spawnSync(binary, SCAN_ARGS, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) fail('could not start gitleaks: ' + result.error.message);
  if (result.status !== 0) {
    console.error('Secret gate blocked the commit (gitleaks exit ' + result.status + '). Review the staged changes.');
    return result.status || 1;
  }
  console.log('Secret gate passed (staged diff only).');
  return 0;
}

function printHelp() {
  console.log('Usage: node scripts/check-secrets.mjs [--install|--scan]');
  console.log('  --install  one-time online download + SHA-256 verification, then sets core.hooksPath');
  console.log('  --scan     offline staged-diff scan (used by the pre-commit hook)');
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
  } else if (args[0] === '--install' && args.length === 1) {
    install().catch(function (error) {
      console.error('Secret gate install failed: ' + (error && error.message ? error.message : String(error)));
      process.exitCode = 1;
    });
  } else if ((args.length === 0 || (args[0] === '--scan' && args.length === 1))) {
    try {
      process.exitCode = runScan();
    } catch (error) {
      console.error('Secret gate failed closed: ' + (error && error.message ? error.message : String(error)));
      process.exitCode = 1;
    }
  } else {
    console.error('Unknown arguments. Run with --help.');
    process.exitCode = 1;
  }
}
