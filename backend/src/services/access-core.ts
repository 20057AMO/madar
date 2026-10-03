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
 * Rules:
 *   - system admins always pass;
 *   - system editors get write-level (editor) access to every project — but not
 *     admin-level powers, which are earned through an explicit owner/admin
 *     member row;
 *   - the project owner is project-admin;
 *   - members need their member role to meet minRole;
 *   - legacy projects with no owner and no members stay open to all
 *     authenticated users at editor level — capped there, so an admin-level
 *     route is never open to a viewer (compat contract).
 *
 * `metaState` distinguishes ABSENT meta from CORRUPT meta. Only ABSENT may
 * enter the legacy open fallback: a corrupt store (unreadable JSON) must
 * never be opened to everyone while the route still resolves the project for
 * writes.
 */
export function decideProjectAccess(
  userId: string,
  userRole: AccessRole,
  meta: AccessSnapshot | null | undefined,
  minRole: AccessRole,
  metaState: 'ok' | 'absent' | 'corrupt' = meta ? 'ok' : 'absent'
): { allowed: boolean; memberRole?: AccessRole } {
  if (userRole === 'admin') return { allowed: true, memberRole: 'admin' };
  if (userRole === 'editor' && minRole !== 'admin') {
    // Global editor: write-level on EVERY project, no membership needed.
    // Admin-level powers are EARNED, not inherited — an explicit project admin
    // (owner row or admin member) manages the team, and only that. Falling
    // through here for minRole 'admin' is what lets a user whose system role is
    // 'editor' still hold project-admin rights they were explicitly given; the
    // short-circuit used to run first and denied them.
    return { allowed: true, memberRole: 'editor' };
  }

  // Legacy projects without membership data: allow all authenticated users at
  // EDITOR level (compat contract) — never at admin level. The cap matters:
  // this fallback answers for EVERY authenticated user, so an admin-level route
  // (add member, manage the team) reached through the same call used to be open
  // to any viewer on a legacy project. Mirrors the system-editor rule above.
  // Corrupt meta is NOT legacy — see metaState contract above.
  if (metaState !== 'corrupt' && (!meta || (!meta.ownerId && (!Array.isArray(meta.members) || meta.members.length === 0)))) {
    return { allowed: minRole !== 'admin', memberRole: 'editor' };
  }

  if (metaState === 'corrupt') return { allowed: false };
  if (!meta) return { allowed: false };

  if (meta.ownerId === userId) return { allowed: true, memberRole: 'admin' };

  const members = Array.isArray(meta.members) ? meta.members : [];
  const member = members.find((m) => m.userId === userId);
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
  const membersArr = Array.isArray(meta?.members) ? meta.members : [];
  const hasMembership = !!meta?.ownerId || membersArr.length > 0;
  if (!hasMembership) return { allowed: userRole === 'admin' };
  return { allowed: decideProjectAccess(userId, userRole, meta, 'admin').allowed };
}
