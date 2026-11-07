/**
 * chat-attachment-kind.ts
 * Madar — pure, import-free classification + naming for team-chat uploads.
 * No imports at all (node globals only) so `node --test` loads it offline,
 * same convention as chat-team-core / serve-core / janitor-core.
 *
 * This module is the SINGLE source of truth for what the server calls an
 * image, and it is deliberately narrower than "what a MIME database says":
 * only formats a browser paints as RASTER pixels count (PNG, JPEG, WebP, GIF,
 * BMP, AVIF). SVG and HTML are markup, so serving either as `image/*` with an
 * inline disposition would turn an upload endpoint into stored XSS on our own
 * origin — they stay `application/octet-stream` + `attachment`. HEIC/HEIF and
 * TIFF are excluded because browsers do not render them from an <img> (a
 * "kind: image" the UI cannot display is a lie, and a broken preview reads as
 * a server bug).
 *
 * Bytes are the ONLY input: a client-supplied name, extension or `kind` is
 * never trusted, and the same classifier runs on upload and on message send.
 */

/** Structural twin of ChatAttachment['kind'] (kept local to stay import-free). */
export type ChatAttachmentKind = 'image' | 'file';

export interface AttachmentFacts {
  kind: ChatAttachmentKind;
  /** Real MIME for a renderable raster; octet-stream for everything else. */
  mime: string;
  /** Canonical extension without the dot — '' when not an image. */
  ext: string;
}

const FILE_FACTS: AttachmentFacts = Object.freeze({
  kind: 'file' as const,
  mime: 'application/octet-stream',
  ext: '',
});

const PNG: AttachmentFacts = Object.freeze({ kind: 'image' as const, mime: 'image/png', ext: 'png' });
const JPEG: AttachmentFacts = Object.freeze({ kind: 'image' as const, mime: 'image/jpeg', ext: 'jpg' });
const WEBP: AttachmentFacts = Object.freeze({ kind: 'image' as const, mime: 'image/webp', ext: 'webp' });
const GIF: AttachmentFacts = Object.freeze({ kind: 'image' as const, mime: 'image/gif', ext: 'gif' });
const BMP: AttachmentFacts = Object.freeze({ kind: 'image' as const, mime: 'image/bmp', ext: 'bmp' });
const AVIF: AttachmentFacts = Object.freeze({ kind: 'image' as const, mime: 'image/avif', ext: 'avif' });

/** Signatures need nothing past the ISO-BMFF major brand (offset 8..11). */
export const ATTACHMENT_HEAD_BYTES = 64;

/** Attachment display names are capped at the same 255 as the upload route. */
export const MAX_ATTACHMENT_NAME = 255;

function asciiAt(buf: Buffer, offset: number, text: string): boolean {
  if (buf.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (buf[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function bytesAt(buf: Buffer, offset: number, bytes: readonly number[]): boolean {
  if (buf.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) {
    if (buf[offset + i] !== bytes[i]) return false;
  }
  return true;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** ISO-BMFF brands a browser paints. HEIC/HEIF brands are NOT here on purpose. */
const AVIF_BRANDS = ['avif', 'avis'] as const;

/**
 * Classify an uploaded byte string. Never throws and never trusts anything but
 * the leading bytes: a missing/short/junk buffer is a plain file.
 */
export function detectAttachmentFacts(bytes: unknown): AttachmentFacts {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return FILE_FACTS;
  const buf = bytes;

  if (bytesAt(buf, 0, PNG_MAGIC)) return PNG;

  // JPEG: SOI + first marker. `FF D8 FF` is what every encoder emits.
  if (bytesAt(buf, 0, [0xff, 0xd8, 0xff])) return JPEG;

  if (asciiAt(buf, 0, 'GIF87a') || asciiAt(buf, 0, 'GIF89a')) return GIF;

  // RIFF container — only the WEBP form is a browser image (WAV/AVI are not).
  if (asciiAt(buf, 0, 'RIFF') && asciiAt(buf, 8, 'WEBP')) return WEBP;

  // BMP: "BM" is only two bytes, so require the BITMAPFILEHEADER reserved
  // words to be zero as well (14-byte header) — a text file that merely starts
  // with "BM" must not be served as image/bmp.
  if (
    buf.length >= 14 &&
    buf[0] === 0x42 &&
    buf[1] === 0x4d &&
    buf.readUInt16LE(6) === 0 &&
    buf.readUInt16LE(8) === 0
  ) {
    return BMP;
  }

  // AVIF: ISO-BMFF `ftyp` box whose MAJOR brand is avif/avis. Major-brand-only
  // (never the compatible-brand list) is what keeps HEIC/HEIF — whose major
  // brands are heic/heix/hevc/mif1 — classified as plain files.
  if (asciiAt(buf, 4, 'ftyp')) {
    for (const brand of AVIF_BRANDS) {
      if (asciiAt(buf, 8, brand)) return AVIF;
    }
  }

  return FILE_FACTS;
}

/** Convenience wrapper — the classification alone. */
export function detectAttachmentKind(bytes: unknown): ChatAttachmentKind {
  return detectAttachmentFacts(bytes).kind;
}

/** Content-Type to serve this byte string with (never image/svg+xml, never text/html). */
export function attachmentMimeType(bytes: unknown): string {
  return detectAttachmentFacts(bytes).mime;
}

/**
 * Strip anything that could break a header or smuggle a path out of a
 * download name: control chars (incl. CR/LF — header injection), quotes and
 * path separators. Whitespace collapses; the result is capped at 255 chars and
 * falls back when nothing printable survives.
 */
export function sanitizeAttachmentName(raw: unknown, fallback = 'file'): string {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/["\\/]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ATTACHMENT_NAME);
  return cleaned || fallback;
}

/**
 * Display name for a stored attachment: the meta record's name when it has
 * one, otherwise a generated `attachment.<ext>` / `attachment.bin`. Legacy
 * uploads (saved before names were persisted) therefore still download with a
 * truthful filename instead of a bare id.
 */
export function attachmentFileName(stored: unknown, facts: AttachmentFacts): string {
  const explicit = typeof stored === 'string' ? stored.trim() : '';
  if (explicit) return sanitizeAttachmentName(explicit);
  return facts.ext ? `attachment.${facts.ext}` : 'attachment.bin';
}

/** RFC 5987 attr-char is narrower than encodeURIComponent()'s unreserved set. */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function asciiFilename(value: string): string {
  const out = value.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_').trim();
  return out || 'file';
}

/**
 * `Content-Disposition` for an attachment. Images render inline (the chat UI
 * previews them from this URL); everything else is a download. The name is
 * re-sanitized here so no caller can inject a header value, and both the
 * ASCII `filename` and the RFC 5987 `filename*` form are emitted for
 * non-ASCII (Arabic) filenames.
 */
export function contentDispositionHeader(name: unknown, kind: ChatAttachmentKind): string {
  const safe = sanitizeAttachmentName(name);
  const disposition = kind === 'image' ? 'inline' : 'attachment';
  return `${disposition}; filename="${asciiFilename(safe)}"; filename*=UTF-8''${encodeRfc5987(safe)}`;
}
