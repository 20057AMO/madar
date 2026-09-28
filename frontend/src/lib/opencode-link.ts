/**
 * opencode-link.ts
 * Pure URL builder for the embedded opencode web client.
 *
 * Verified against the live container (opencode web 1.18.32). The client splits
 * the path and resolves the first segment through its own base64url decoder, so
 * `/<base64url(directory)>/session` scopes the whole client to that directory and
 * opens a fresh session there (the client then redirects itself to
 * `/new-session?draftId=…`, which is the intended landing state — the redirect
 * is NOT a fallback to home: every API call still carries the directory, while
 * the bare root issues an unscoped global session list). The encoding mirrors
 * the client's own encoder: btoa over the UTF-8 bytes with '+'→'-', '/'→'_' and
 * '=' stripped.
 *
 * Directory-scoped links are the only supported form: the backend deliberately
 * keeps the created session id server-side, so there is no id to resume with.
 */

export interface OpencodeUrlParts {
  proto: string;
  host: string;
  port: number;
  directory?: string | null;
}

export function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export function buildOpencodeUrl(parts: OpencodeUrlParts): string {
  const { proto, host, port, directory } = parts;
  const base = `${proto}://${host}:${port}`;
  if (!directory) return base;
  return `${base}/${base64UrlEncode(directory)}/session`;
}
