/**
 * role-meta.ts
 * Madar — the single source of truth for how a system role is PRESENTED:
 * bilingual label, brand colour, permission hint and the expressive icon that
 * carries the role at a glance (admin = shield, editor = pen, viewer = eye).
 *
 * Both roster surfaces render from here — the admin Team page (/team) and the
 * project's Team tab (TeamPanel) — so a role can never be styled one way in
 * one place and another way in the other.
 */
import { ShieldCheck, PenLine, Eye } from 'lucide-preact';
import type { UserRole } from '../api';

export interface RoleMeta {
  labelAr: string;
  labelEn: string;
  /** Brand colour used for the tinted badge/tile (already contrast-checked on --panel). */
  color: string;
  hintAr: string;
  hintEn: string;
  /** lucide icon component — render with size 9–17px. */
  Icon: any;
}

export const ROLE_CONFIG: Record<UserRole, RoleMeta> = {
  admin: {
    labelAr: 'مدير',
    labelEn: 'Admin',
    color: '#f59e0b',
    hintAr: 'وصول كامل — المستخدمون والإعدادات والمزوّدون وكل المشاريع.',
    hintEn: 'Full access — users, settings, providers and all projects.',
    Icon: ShieldCheck,
  },
  editor: {
    labelAr: 'محرر',
    labelEn: 'Editor',
    color: '#58a6ff',
    hintAr: 'محرر عام — يكتب في كل مشروع؛ لا يدير المستخدمين أو الإعدادات أو المزوّدون أو يحذف مشاريع الآخرين.',
    hintEn: 'Global editor — writes to every project; cannot manage users, settings, providers, or delete others’ projects.',
    Icon: PenLine,
  },
  viewer: {
    labelAr: 'عارض',
    labelEn: 'Viewer',
    color: '#9ca3af',
    hintAr: 'قراءة فقط على المشاريع المُضاف إليها.',
    hintEn: 'Read-only on the projects they are added to.',
    Icon: Eye,
  },
};

/** Descending privilege — the roster sorts with this, higher first. */
export const ROLE_ORDER: Record<UserRole, number> = { admin: 3, editor: 2, viewer: 1 };

/** Presentation order used by the pickers (admin → editor → viewer). */
export const NEW_ROLE_ORDER: UserRole[] = ['admin', 'editor', 'viewer'];

/**
 * Membership roles are plain strings on the wire (a project member row, a
 * roster affiliation) — unknown values degrade to a neutral viewer-style meta
 * instead of throwing or rendering blank.
 */
export function membershipRoleMeta(role: string): RoleMeta {
  return (
    ROLE_CONFIG[role as UserRole] || {
      labelAr: role,
      labelEn: role,
      color: '#9ca3af',
      hintAr: '',
      hintEn: '',
      Icon: Eye,
    }
  );
}
