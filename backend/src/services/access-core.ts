/**
 * access-core.ts
 * Madar — Pure project-access decision logic, shared by the REST middleware
 * (requireProjectAccess) and the WebSocket routes (ws-server gate).
 *
 * Pure module: no imports. The caller supplies the project's membership
 * snapshot (ownerId + members) so this stays trivially testable offline.
 */

export type AccessRole = 'admin' | 'editor' | 'viewer';

export interface AccessMember {
  userId: string;
  role: AccessRole;
}

export interface AccessSnapshot {
  ownerId?: string;
  members?: AccessMember[];
}

const ROLE_LEVEL: Record<AccessRole, number> = { admin: 3, editor: 2, viewer: 1 };

/**
 * Decide whether `userId` with system role `userRole` reaches a project whose
 * membership snapshot is `meta`, when `minRole` is required.
 *
 * Rules (mirrors the historical middleware behavior exactly):
 *   - system admins always pass;
 *   - system editors get write-level (editor) access to every project;
 *   - the project owner is project-admin;
 *   - members need their member role to meet minRole;
 *   - legacy projects with no owner and no members stay open to all
 *     authenticated users at editor level (compat contract).
 */
export function decideProjectAccess(
  userId: string,
  userRole: AccessRole,
  meta: AccessSnapshot | null | undefined,
  minRole: AccessRole
): { allowed: boolean; memberRole?: AccessRole } {
  if (userRole === 'admin') return { allowed: true, memberRole: 'admin' };
  if (userRole === 'editor') {
    return { allowed: minRole !== 'admin', memberRole: 'editor' };
  }

  // Legacy projects without membership data: allow all authenticated users.
  if (!meta || (!meta.ownerId && (!meta.members || meta.members.length === 0))) {
    return { allowed: true, memberRole: 'editor' };
  }

  if (meta.ownerId === userId) return { allowed: true, memberRole: 'admin' };

  const member = (meta.members || []).find((m) => m.userId === userId);
  if (!member) return { allowed: false };

  const hasLevel = ROLE_LEVEL[member.role] || 0;
  const needLevel = ROLE_LEVEL[minRole] || 0;
  return { allowed: hasLevel >= needLevel, memberRole: member.role };
}

/**
 * Stricter decision for the control-mode terminal (a HOST shell inside the
 * backend container, with docker CLI + socket access).
 *
 * The legacy open-projects bypass above must NOT apply here: an anonymous
 * legacy project would otherwise hand every viewer a host shell. Rule:
 * real system admin, or project owner/admin-member on a project that has
 * membership data.
 */
export function decideControlAccess(
  userId: string,
  userRole: AccessRole,
  meta: AccessSnapshot | null | undefined
): { allowed: boolean } {
  const hasMembership = !!meta?.ownerId || (meta?.members?.length ?? 0) > 0;
  if (!hasMembership) return { allowed: userRole === 'admin' };
  return { allowed: decideProjectAccess(userId, userRole, meta, 'admin').allowed };
}
