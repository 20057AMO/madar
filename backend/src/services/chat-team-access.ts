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
import { isChannelAdmin, type CanSendMode, type TeamChannel } from '../services/chat-team-core';

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

/**
 * Channel-level SEND gate — a second, orthogonal layer under the regular
 * access level. canAccessChannel stays the single read/visibility authority;
 * this only narrows WHO may write when the channel is locked down:
 *   - not write-level (viewer / no access)                → never may send
 *   - canSend 'everyone' (or absent on legacy channels)   → write-level passes
 *   - canSend 'admins'                                    → system admins +
 *     the channel creator / explicit admin members only
 * 'project'/'direct' channels never carry canSend, so they are unaffected.
 */
export function canSendInChannel(
  user: { id: string; role: string },
  channel: {
    createdBy?: string;
    members?: { userId: string; role: string }[];
    canSend?: CanSendMode;
  },
  level: 'read' | 'write'
): boolean {
  if (level !== 'write') return false;
  if (channel.canSend !== 'admins') return true;
  return user.role === 'admin' || isChannelAdmin(channel, user.id);
}