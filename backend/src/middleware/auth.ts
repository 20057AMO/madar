import { verifyToken, type UserRole } from '../services/user-store';
import { loadMeta, type ProjectMember } from '../services/projects-meta';

export interface AuthRequest extends Express.Request {
  user?: { id: string; username: string; role: UserRole; jti?: string };
}

export function authMiddleware(req: any, res: any, next: any): void {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  const user = verifyToken(token);
  if (!user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  req.user = user;
  next();
}

/** Middleware: require admin role. */
export function requireAdmin(req: any, res: any, next: any): void {
  if (!req.user || req.user.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}

/** Middleware: require minimum role (admin > editor > viewer). */
export function requireRole(minRole: UserRole) {
  const hierarchy: Record<UserRole, number> = { admin: 3, editor: 2, viewer: 1 };
  return (req: any, res: any, next: any) => {
    const userRole: UserRole | undefined = req.user?.role;
    if (!userRole || (hierarchy[userRole] || 0) < hierarchy[minRole]) {
      res.status(403).json({ error: `${minRole} access required` });
      return;
    }
    next();
  };
}

/**
 * Check if a user has access to a project.
 * System admins always have access. System editors are global editors: they have
 * write access to every project (level 'editor'), without needing membership.
 * Any other user must be a member. If the project has no membership data (legacy),
 * all authenticated users are allowed.
 * minRole: 'viewer' (default read) | 'editor' (write) | 'admin' (manage members).
 */
export function checkProjectAccess(
  userId: string,
  userRole: UserRole,
  slug: string,
  minRole: 'admin' | 'editor' | 'viewer' = 'viewer'
): { allowed: boolean; memberRole?: string } {
  if (userRole === 'admin') return { allowed: true, memberRole: 'admin' };
  // Global editor: write-level access to every project without membership.
  if (userRole === 'editor') {
    return { allowed: minRole !== 'admin', memberRole: 'editor' };
  }

  const meta = loadMeta(slug);
  // Legacy projects without membership data: allow all authenticated users
  if (!meta || (!meta.ownerId && (!meta.members || meta.members.length === 0))) {
    return { allowed: true, memberRole: 'editor' };
  }

  // Owner always has admin
  if (meta.ownerId === userId) return { allowed: true, memberRole: 'admin' };

  const member = (meta.members || []).find((m) => m.userId === userId);
  if (!member) return { allowed: false };

  const hierarchy: Record<string, number> = { admin: 3, editor: 2, viewer: 1 };
  const hasLevel = hierarchy[member.role] || 0;
  const needLevel = hierarchy[minRole] || 0;
  return { allowed: hasLevel >= needLevel, memberRole: member.role };
}

/**
 * Middleware factory: require project access with a minimum role.
 * Reads :slug from params, checks against authenticated user.
 */
export function requireProjectAccess(minRole: 'admin' | 'editor' | 'viewer' = 'viewer') {
  return (req: any, res: any, next: any) => {
    if (!req.user) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const slug = req.params.slug;
    if (!slug) {
      res.status(400).json({ error: 'Project slug required' });
      return;
    }
    const { allowed } = checkProjectAccess(req.user.id, req.user.role, slug, minRole);
    if (!allowed) {
      res.status(403).json({ error: 'Access denied to this project' });
      return;
    }
    next();
  };
}
