/**
 * secret-box.ts
 * Madar — At-rest encryption for provider API keys (AES-256-GCM).
 *
 * Ciphertext formats (single JSON-safe strings):
 *   v2:<ivB64>:<authTagB64>:<ciphertextB64>:<last4>   (current)
 *   enc1:<ivB64>:<authTagB64>:<ciphertextB64>:<last4>  (legacy, read-only)
 *
 * The trailing <last4> lets the UI keep showing `••••••••1234` without ever
 * decrypting, and keeps masking working even if the key becomes unreadable.
 *
 * Key material:
 *   v2   = a dedicated random 32-byte key in DATA_DIR/enc.key (0600), or the
 *          validated WSD_ENC_KEY override. Never derived from the JWT secret.
 *   enc1 = scrypt(WSD_ENCRYPTION_KEY || resolved JWT secret, crypto.salt, 32)
 *          retained ONLY to decrypt legacy blobs; crypto.salt is never deleted.
 *
 * Old installs stay readable: a legacy blob is decrypted with the old
 * derivation and re-sealed as v2 when its provider document is next rewritten.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { jwtSecretValue } from './jwt-secret';

// Compiled CJS (dist) resolves the package-relative fallback; native TS-ESM
// test runs always set WSD_DATA_DIR explicitly, so cwd fallback is safe.
const here = typeof __dirname !== 'undefined' ? __dirname : '.';
const CURRENT_PREFIX = 'v2';
const LEGACY_PREFIX = 'enc1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const KEY_FILE = 'enc.key';
const SALT_FILE = 'crypto.salt';

interface CachedKey {
  id: string;
  key: Buffer;
}

interface SealedParts {
  iv: Buffer;
  tag: Buffer;
  ct: Buffer;
  last4: string;
}

let keyCache: CachedKey | null = null;
let legacyKeyCache: CachedKey | null = null;

function dataDir(): string {
  return process.env.WSD_DATA_DIR || path.join(here, '..', '..', 'data');
}

function currentKeyId(): string {
  const env = process.env.WSD_ENC_KEY;
  const fingerprint = env === undefined ? '' : crypto.createHash('sha256').update(env).digest('hex');
  return `${dataDir()}\0${fingerprint}`;
}

function validateEnvKey(env: string): void {
  const trimmed = env.trim();
  if (trimmed.length < 16 || trimmed.length > 1024) {
    throw new Error('WSD_ENC_KEY must contain between 16 and 1024 non-blank characters');
  }
}

function parseKeyFile(raw: Buffer): Buffer {
  const text = raw.toString('utf8').trim();
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, 'hex');
  if (raw.length === KEY_BYTES) return raw;
  throw new Error('Provider encryption key file is invalid; refusing to overwrite it');
}

function loadKeyFile(): Buffer {
  const file = path.join(dataDir(), KEY_FILE);
  let raw: Buffer;
  try {
    raw = fs.readFileSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error('Unable to read the provider encryption key file');
    }
    const generated = crypto.randomBytes(KEY_BYTES);
    fs.mkdirSync(dataDir(), { recursive: true });
    try {
      fs.writeFileSync(file, generated.toString('hex'), { mode: 0o600, flag: 'wx' });
    } catch (writeErr) {
      if ((writeErr as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new Error('Unable to create the provider encryption key file');
      }
      raw = fs.readFileSync(file);
      return parseKeyFile(raw);
    }
    try { fs.chmodSync(file, 0o600); } catch { /* Windows / read-only volume */ }
    return generated;
  }
  try { fs.chmodSync(file, 0o600); } catch { /* Windows / read-only volume */ }
  return parseKeyFile(raw);
}

function currentKey(): Buffer {
  const id = currentKeyId();
  if (!keyCache || keyCache.id !== id) {
    const env = process.env.WSD_ENC_KEY;
    let key: Buffer;
    if (env === undefined) {
      key = loadKeyFile();
    } else {
      validateEnvKey(env);
      key = crypto.createHash('sha256').update(env.trim()).digest();
    }
    keyCache = { id, key };
  }
  return keyCache.key;
}

function loadSalt(): Buffer {
  const file = path.join(dataDir(), SALT_FILE);
  try {
    const hex = fs.readFileSync(file, 'utf8').trim();
    const buf = Buffer.from(hex, 'hex');
    if (buf.length === KEY_BYTES) return buf;
  } catch { /* first run */ }
  const salt = crypto.randomBytes(KEY_BYTES);
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(file, salt.toString('hex'), { mode: 0o600 });
  return salt;
}

function legacyMasterSecret(): string {
  return process.env.WSD_ENCRYPTION_KEY || jwtSecretValue();
}

function legacyKey(): Buffer {
  const id = `${dataDir()}\0${process.env.WSD_ENCRYPTION_KEY ?? ''}`;
  if (!legacyKeyCache || legacyKeyCache.id !== id) {
    legacyKeyCache = { id, key: crypto.scryptSync(legacyMasterSecret(), loadSalt(), KEY_BYTES) };
  }
  return legacyKeyCache.key;
}

function parseSealed(value: string): SealedParts {
  const parts = value.split(':');
  if (parts.length !== 5 || (parts[0] !== CURRENT_PREFIX && parts[0] !== LEGACY_PREFIX)) {
    throw new Error('Invalid sealed secret');
  }
  const iv = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');
  const ct = Buffer.from(parts[3], 'base64');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES || ct.length === 0) {
    throw new Error('Invalid sealed secret');
  }
  return { iv, tag, ct, last4: parts[4] };
}

function decryptParts(parts: SealedParts, key: Buffer): string {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, parts.iv);
  decipher.setAuthTag(parts.tag);
  return Buffer.concat([decipher.update(parts.ct), decipher.final()]).toString('utf8');
}

function sealNew(value: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', currentKey(), iv);
  const ct = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [
    CURRENT_PREFIX,
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    ct.toString('base64'),
    value.slice(-4),
  ].join(':');
}

/**
 * True only for ciphertext sealed with the CURRENT format. Legacy enc1 blobs
 * answer false deliberately: provider-store's existing `!isSealed(apiKey)`
 * load loop then re-seals them, which is the lazy v2 migration on next save.
 */
export function isSealed(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(CURRENT_PREFIX + ':');
}

/** True for a legacy blob that is still readable with the old derivation. */
export function isLegacySealed(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(LEGACY_PREFIX + ':');
}

/**
 * Seal a plaintext secret. Empty strings and current sealed values pass
 * through untouched; a legacy blob is decrypted with the OLD derivation and
 * re-sealed with the dedicated key. An unreadable legacy blob is preserved
 * byte-for-byte instead of being overwritten with an empty secret.
 */
export function sealSecret(plain: unknown): string {
  const value = String(plain ?? '');
  if (!value || isSealed(value)) return value;
  if (isLegacySealed(value)) {
    try {
      return sealNew(decryptParts(parseSealed(value), legacyKey()));
    } catch {
      return value;
    }
  }
  return sealNew(value);
}

/**
 * Open a sealed secret, throwing on malformed ciphertext, a wrong key or a
 * failed GCM tag check. Plain values pass through (legacy rows migrate on save).
 */
export function openSecretStrict(stored: unknown): string {
  const value = String(stored ?? '');
  if (!value) return '';
  if (!isSealed(value) && !isLegacySealed(value)) return value;
  const parts = parseSealed(value);
  return decryptParts(parts, isSealed(value) ? currentKey() : legacyKey());
}

/**
 * Lenient form used by callers that must fail upstream with an auth error
 * rather than a 500 when a stored blob is corrupt. Strict verification still
 * happens inside; only the error is converted to ''.
 */
export function openSecret(stored: unknown): string {
  try {
    return openSecretStrict(stored);
  } catch {
    return '';
  }
}

/** Mask for display — never decrypts; mirrors maskKey()'s output shape. */
export function maskStored(stored: unknown): string {
  const value = String(stored ?? '');
  if (!value) return '';
  if (isSealed(value) || isLegacySealed(value)) {
    const last4 = String(value.split(':')[4] ?? '');
    return last4 ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' + last4 : '\u2022\u2022\u2022\u2022';
  }
  return value.length <= 4
    ? '\u2022\u2022\u2022\u2022'
    : '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' + value.slice(-4);
}
