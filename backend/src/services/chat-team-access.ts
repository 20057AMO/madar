/**
 * chat-team-access.ts
 * Access decisions for team chat — shared by the REST routes and the WebSocket
 * handler so both surfaces enforce exactly the same matrix:
 *   'channel'  → every authenticated user reads; editors+ write (team-wide room),
 *                creation/deletion additionally gated by the editor level.
 *   'direct'   → participants only (both may read and write by joining).
 *   'project'  → mirrors project access via checkProjectAccess: read = viewer+,
 *                write = editor+ (global editors pass on every project).
 * System admins always pass.
 */
import { checkProjectAccess } from '../middleware/auth';
import type { UserRole } from '../services/user-store';
import type { TeamChannel } from '../services/chat-team-core';

export type AccessLevel = 'none' | 'read' | 'write';

export interface ChatUser {
  id: string;
  username: string;
  role: UserRole;
}

export function canAccessChannel(user: ChatUser, channel: TeamChannel): AccessLevel {
  if (!user || !channel) return 'none';
  if (user.role === 'admin') return 'write';

  if (channel.kind === 'project' && channel.projectSlug) {
    const read = checkProjectAccess(user.id, user.role, channel.projectSlug, 'viewer').allowed;
    if (!read) return 'none';
    const write = checkProjectAccess(user.id, user.role, channel.projectSlug, 'editor').allowed;
    return write ? 'write' : 'read';
  }

  if (channel.kind === 'direct') {
    return channel.members.some((m) => m.userId === user.id) ? 'write' : 'none';
  }

  // Manual team-wide channel: every authenticated user reads; editors+ write.
  // Viewers are READ-ONLY here (matches the documented access contract) —
  // only admins/editors may create or delete, checked at the routes.
  return user.role === 'viewer' ? 'read' : 'write';
}