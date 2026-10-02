import { verifyToken, type UserRole } from '../services/user-store';
import { readMeta } from '../services/projects-meta';
import { decideProjectAccess } from '../services/access-core';
import { canonicalProjectSlug } from '../services/project-slug-core';

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
 *
 * CONTRACT: the slug must ALREADY be canonical — the caller's value is the value
 * that gates AND the value that acts (one canonicalization, before the gate).
 * This function deliberately does NOT fold: folding here used to make the gate
 * decide about a DIFFERENT project than the caller acted on (`secret.plan`
 * decided as `secret-plan`), and the fold's miss landed on the legacy
 * "no membership ⇒ allow all" fallback. An unfolded value is refused instead.
 */
export function checkProjectAccess(
  userId: string,
  userRole: UserRole,
  slug: string,
  minRole: 'admin' | 'editor' | 'viewer' = 'viewer'
): { allowed: boolean; memberRole?: string } {
  const canonical = canonicalProjectSlug(slug);
  // Fails closed on junk, on an empty fold, and on ANY non-canonical spelling.
  if (!canonical || canonical !== slug) return { allowed: false };
  const read = readMeta(canonical);
  // Pass the read STATE, not just the doc: a CORRUPT meta store must never hit
  // the legacy "no membership data ⇒ open to all" fallback (see access-core).
  return decideProjectAccess(userId, userRole, read.meta, minRole, read.state);
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
    const raw = String(req.params.slug ?? '');
    if (!raw) {
      res.status(400).json({ error: 'Project slug required' });
      return;
    }
    // Canonicalize ONCE, before the gate, and reuse that single value for the
    // access check AND everything downstream (mirrors the documented rule on
    // POST /api/opencode/open). Evaluating the gate on a raw, unfolded value
    // lets near-misses ("my-project!") miss the meta store, trip the legacy
    // no-membership fallback, and still resolve to the real project later.
    const canonical = canonicalProjectSlug(raw);
    // Refuse outright — rather than folding — anything that can never be a
    // real slug: an empty fold (junk / whitespace / `.` / `..`, including the
    // URL-decoded %2E%2E form) or a raw path separator (`a/b` would fold to the
    // safe single segment `a-b`, but only the caller could tell it apart from
    // a genuine `a-b`; refusing is the honest answer for a value the route
    // cannot legally carry). The access check below is then never reached with
    // an unfolded value.
    if (!canonical || raw.includes('/') || raw.includes('\\') || raw.split(/[\\/]+/).includes('..')) {
      res.status(400).json({ error: 'Project slug is invalid' });
      return;
    }
    req.params.slug = canonical;
    const { allowed } = checkProjectAccess(req.user.id, req.user.role, canonical, minRole);
    if (!allowed) {
      res.status(403).json({ error: 'Access denied to this project' });
      return;
    }
    next();
  };
}
