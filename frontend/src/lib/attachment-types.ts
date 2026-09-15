/**
 * attachment-types.ts
 * Madar — pure (import-free) classification of team-chat attachments:
 * which group an attachment belongs to, which icon to show, and whether its
 * raw text may be previewed in a <pre>. Kept free of React/lucide imports so
 * it stays trivially unit-testable and reusable.
 */

export type AttachmentGroup =
  | 'image'
  | 'audio'
  | 'video'
  | 'code'
  | 'pdf'
  | 'archive'
  | 'text'
  | 'file';

/** Files larger than this never offer a text preview. */
export const PREVIEW_MAX_BYTES = 100 * 1024;

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);
// Only formats VoiceNotePlayer can actually play — anything else classifies
// as a generic file instead of showing an audio icon with no way to play it.
const AUDIO_EXTS = new Set(['m4a', 'ogg', 'oga', 'mp3', 'wav']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'mkv']);
const CODE_EXTS = new Set([
  'js', 'ts', 'tsx', 'jsx', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'cs', 'rb',
  'php', 'sh', 'zsh', 'bash', 'sql', 'html', 'css', 'json', 'yaml', 'yml', 'xml',
  'toml', 'ini', 'dockerfile',
]);
const PDF_EXTS = new Set(['pdf']);
const ARCHIVE_EXTS = new Set(['zip', 'tar', 'gz', 'tgz', '7z', 'rar']);
const TEXT_EXTS = new Set(['txt', 'md', 'log', 'csv', 'conf', 'env']);

function extOf(name: string): string {
  const idx = name.lastIndexOf('.');
  if (idx < 0) return name.toLowerCase();
  // Dotfile like `.env` — the extension is everything after the leading dot.
  if (idx === 0) return name.slice(1).toLowerCase();
  return name.slice(idx + 1).toLowerCase();
}

export function attachmentGroup(name: string, kind: string): AttachmentGroup {
  if (kind === 'image') return 'image';
  const ext = extOf(name);
  if (CODE_EXTS.has(ext)) return 'code';
  if (PDF_EXTS.has(ext)) return 'pdf';
  if (ARCHIVE_EXTS.has(ext)) return 'archive';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (TEXT_EXTS.has(ext)) return 'text';
  if (IMAGE_EXTS.has(ext)) return 'image';
  return 'file';
}

/** lucide-preact icon name for an attachment group. */
export function attachmentIcon(group: AttachmentGroup): string {
  switch (group) {
    case 'code': return 'FileCode2';
    case 'text':
    case 'pdf': return 'FileText';
    case 'archive': return 'FileArchive';
    case 'image': return 'FileImage';
    case 'audio': return 'FileAudio';
    case 'video': return 'FileVideo';
    default: return 'File';
  }
}

export type Previewability = 'ok' | 'too-big' | 'unsupported';

/**
 * 'ok' only for code/text files at or under PREVIEW_MAX_BYTES; larger code/text
 * is 'too-big' (shown dimmed, no button); everything else is 'unsupported'.
 */
export function previewability(name: string, size: number): Previewability {
  const group = attachmentGroup(name, 'file');
  if (group !== 'code' && group !== 'text') return 'unsupported';
  return size <= PREVIEW_MAX_BYTES ? 'ok' : 'too-big';
}