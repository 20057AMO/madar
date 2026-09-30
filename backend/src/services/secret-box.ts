/**
 * secret-box.ts
 * Madar — At-rest encryption for provider API keys (AES-256-GCM).
 *
 * Ciphertext format (single JSON-safe string):
 *   enc1:<ivB64>:<authTagB64>:<ciphertextB64>:<last4>
 *
 * The trailing <last4> lets the UI keep showing `••••••••1234` without ever
 * decrypting, and keeps masking working even if the master key becomes
 * unreadable (rotated env var, lost salt file).
 *
 * Key material:
 *   master = WSD_ENCRYPTION_KEY  → falls back to the resolved JWT signing
 *           secret (env, else the generated secret in DATA_DIR/jwt.secret)
 *   key    = scrypt(master, salt, 32)
 *   salt   = random 32 bytes persisted once in DATA_DIR/crypto.salt (0600)
 *
 * Rotating the master secret makes previously sealed values undecryptable —
 * they open to '' and upstream calls fail with auth errors instead of leaking.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { jwtSecretValue } from './jwt-secret';

// Compiled CJS (dist) resolves the package-relative fallback; native TS-ESM
// test runs always set WSD_DATA_DIR explicitly, so cwd fallback is safe.
const here = typeof __dirname !== 'undefined' ? __dirname : '.';
const DATA_DIR = process.env.WSD_DATA_DIR || path.join(here, '..', '..', 'data');
const SALT_FILE = path.join(DATA_DIR, 'crypto.salt');
const PREFIX = 'enc1';

let keyCache: Buffer | null = null;

function masterSecret(): string {
  return process.env.WSD_ENCRYPTION_KEY || jwtSecretValue();
}

function loadSalt(): Buffer {
  try {
    const hex = fs.readFileSync(SALT_FILE, 'utf8').trim();
    const buf = Buffer.from(hex, 'hex');
    if (buf.length === 32) return buf;
  } catch { /* first run */ }
  const salt = crypto.randomBytes(32);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SALT_FILE, salt.toString('hex'), { mode: 0o600 });
  return salt;
}

function deriveKey(): Buffer {
  if (!keyCache) keyCache = crypto.scryptSync(masterSecret(), loadSalt(), 32);
  return keyCache;
}

/** True when the value carries our sealed prefix. */
export function isSealed(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX + ':');
}

/**
 * Seal a plaintext secret. Empty strings and already-sealed values pass
 * through untouched. Plaintext is never returned by this function.
 */
export function sealSecret(plain: unknown): string {
  const value = String(plain ?? '');
  if (!value || isSealed(value)) return value;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(), iv);
  const ct = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString('base64'), tag.toString('base64'), ct.toString('base64'), value.slice(-4)].join(':');
}

/**
 * Open a sealed secret. Plain values pass through (legacy rows migrate on
 * save); unreadable ciphertext yields '' so callers fail upstream with an
 * auth error instead of transmitting corrupted key material.
 */
export function openSecret(stored: unknown): string {
  const value = String(stored ?? '');
  if (!value) return '';
  if (!isSealed(value)) return value;
  try {
    const [, ivB64, tagB64, ctB64] = value.split(':');
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

/** Mask for display — never decrypts; mirrors maskKey()'s output shape. */
export function maskStored(stored: unknown): string {
  const value = String(stored ?? '');
  if (!value) return '';
  if (isSealed(value)) {
    const last4 = String(value.split(':')[4] ?? '');
    return last4 ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' + last4 : '\u2022\u2022\u2022\u2022';
  }
  return value.length <= 4
    ? '\u2022\u2022\u2022\u2022'
    : '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' + value.slice(-4);
}
