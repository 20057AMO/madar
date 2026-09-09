/**
 * avatar-store.ts
 * Madar — User avatar images on disk (data/avatars/<userId>.<ext>).
 *
 * MIME is validated by MAGIC BYTES, never by the upload name: only PNG/JPEG
 * (and WebP) pass; SVG and every other type are rejected outright. Avatar
 * bytes never touch users.json — only the extension is recorded there by
 * `setUserAvatarExt`, so the auth store stays lean and the serve route can
 * set the right Content-Type.
 */
import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.WSD_DATA_DIR || '/app/data';
const AVATARS_DIR = path.join(DATA_DIR, 'avatars');
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

export type AvatarExt = 'png' | 'jpg' | 'webp';

const MIME_BY_MAGIC: Array<{ ext: AvatarExt; mime: string; check: (b: Buffer) => boolean }> = [
  { ext: 'png', mime: 'image/png', check: (b) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a },
  { ext: 'jpg', mime: 'image/jpeg', check: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'webp', mime: 'image/webp', check: (b) => b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' },
];

export function detectImageExt(buffer: Buffer): AvatarExt | null {
  if (!Buffer.isBuffer(buffer) || buffer.length < 3) return null;
  for (const t of MIME_BY_MAGIC) {
    if (t.check(buffer)) return t.ext;
  }
  return null;
}

/** Strict userId format — never do path math with anything else. */
export function validAvatarUserId(userId: string): boolean {
  return /^user-[A-Za-z0-9-]+$/.test(String(userId || ''));
}

/** Every stored file for a user (its own extension + any stale sibling). */
function avatarFilesFor(userId: string): string[] {
  if (!validAvatarUserId(userId)) return [];
  try {
    if (!fs.existsSync(AVATARS_DIR)) return [];
    return fs.readdirSync(AVATARS_DIR).filter((f) => f.startsWith(userId + '.'));
  } catch {
    return [];
  }
}

export function getAvatarPath(userId: string): string | null {
  for (const f of avatarFilesFor(userId)) {
    return path.join(AVATARS_DIR, f);
  }
  return null;
}

/** Write a validated avatar, removing any previous file of another type. */
export function saveAvatar(userId: string, buffer: Buffer): AvatarExt {
  if (!validAvatarUserId(userId)) throw new Error('Invalid user id.');
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('No image data provided.');
  if (buffer.length > AVATAR_MAX_BYTES) throw new Error(`Avatar must be at most ${Math.floor(AVATAR_MAX_BYTES / 1024 / 1024)} MB.`);
  const ext = detectImageExt(buffer);
  if (!ext) throw new Error('Unsupported image. Only PNG, JPEG and WebP are allowed.');
  for (const f of avatarFilesFor(userId)) {
    fs.rmSync(path.join(AVATARS_DIR, f), { force: true });
  }
  fs.mkdirSync(AVATARS_DIR, { recursive: true });
  fs.writeFileSync(path.join(AVATARS_DIR, `${userId}.${ext}`), buffer, { mode: 0o600 });
  return ext;
}

export function deleteAvatar(userId: string): boolean {
  let found = false;
  for (const f of avatarFilesFor(userId)) {
    fs.rmSync(path.join(AVATARS_DIR, f), { force: true });
    found = true;
  }
  return found;
}