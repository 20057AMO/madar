import { useState, useEffect } from 'preact/hooks';
import { useHashLocation } from 'wouter/use-hash-location';
import { Users, UserPlus, Trash2, Crown } from 'lucide-preact';
import { ROLE_ORDER, membershipRoleMeta } from '../lib/role-meta';
import { useAuth } from '../auth';
import {
  listProjectMembers,
  addProjectMember,
  removeProjectMember,
  transferOwner,
  listUsers,
  avatarUrl,
  type ProjectMember,
  type TeamUser,
  type UserRole,
} from '../api';
import { ConfirmModal } from './ConfirmModal';
import { ReAuthModal } from './ReAuthModal';
import { Avatar } from './Avatar';
import { useI18n } from '../i18n';
import type { PresenceUser } from '../usePresence';

interface Props {
  slug: string;
  project: any;
  onlineUsers?: PresenceUser[];
}

/**
 * Icon + tinted pill for a role — the same visual language as the /team page.
 * Module-level (not declared inside TeamPanel) so Preact never remounts it on
 * an unrelated parent re-render.
 */
function RoleBadge({ role, title, ar }: { role: string; title?: string; ar: boolean }) {
  const meta = membershipRoleMeta(role);
  const Ico = meta.Icon;
  return (
    <span
      class="team-role-badge"
      style={{ '--rc': meta.color } as any}
      title={title ?? (ar ? meta.hintAr : meta.hintEn)}
    >
      <Ico size={11} aria-hidden="true" />
      {ar ? meta.labelAr : meta.labelEn}
    </span>
  );
}

export function TeamPanel({ slug, project, onlineUsers = [] }: Props) {
  const [, setLocation] = useHashLocation();
  const { user: currentUser } = useAuth();
  const { t2, lang } = useI18n();
  const ar = lang === 'ar';
  const roleLabel = (role: string) => {
    const meta = membershipRoleMeta(role);
    return ar ? meta.labelAr : meta.labelEn;
  };
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [allUsers, setAllUsers] = useState<TeamUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const onlineIds = new Set(onlineUsers.map(u => u.id));

  // The parent polls ownerId on a 5s cycle — keep a local copy so the role
  // badge + manage gates update the instant a transfer completes, without
  // waiting for the next poll racing the backend write.
  const [ownerId, setOwnerId] = useState<string | undefined>(project?.ownerId);
  useEffect(() => { setOwnerId(project?.ownerId); }, [project?.ownerId]);

  // Add form
  const [showAdd, setShowAdd] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [selectedRole, setSelectedRole] = useState<UserRole>('viewer');
  const [adding, setAdding] = useState(false);

  // Remove confirmation
  const [removeTarget, setRemoveTarget] = useState<ProjectMember | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  // Transfer ownership (sudo — account password required)
  const [transferTarget, setTransferTarget] = useState<ProjectMember | null>(null);
  const [transferring, setTransferring] = useState(false);
  const [transferError, setTransferError] = useState<string | null>(null);

  const myMemberRole = members.find((m) => m.userId === currentUser?.id)?.role;
  // Who may manage members: system admins, the (local) owner, and admin
  // members. A plain caller — even a project viewer/editor — sees the roster
  // read-only instead of buttons that would always 403.
  const canManage = currentUser?.role === 'admin' || ownerId === currentUser?.id || myMemberRole === 'admin';

  const loadMembers = async () => {
    try {
      setLoading(true);
      const [memberRes, usersRes] = await Promise.all([
        listProjectMembers(slug),
        listUsers(),
      ]);
      setMembers(memberRes.members || []);
      setAllUsers(usersRes || []);
      setError(null);
    } catch (err: any) {
      setError(err.message || t2('فشل تحميل الأعضاء', 'Failed to load members'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setRemoveTarget(null);
    setRemoveError(null);
    setTransferTarget(null);
    setTransferError(null);
    loadMembers();
  }, [slug]);

  const isMember = (userId: string) => members.some((m) => m.userId === userId);
  const nonMembers = allUsers.filter((u) => !isMember(u.id));

  // Role-aware ordering: admins first, then editors, then viewers.
  const sortedMembers = [...members].sort(
    (a, b) => (ROLE_ORDER[b.role as UserRole] || 0) - (ROLE_ORDER[a.role as UserRole] || 0)
  );

  const handleAdd = async () => {
    if (!selectedUserId) return;
    try {
      setAdding(true);
      await addProjectMember(slug, selectedUserId, selectedRole);
      setSelectedUserId('');
      setSelectedRole('viewer');
      setShowAdd(false);
      await loadMembers();
    } catch (err: any) {
      setError(err.message || t2('فشل إضافة العضو', 'Failed to add member'));
    } finally {
      setAdding(false);
    }
  };

  const handleRemove = async () => {
    if (!removeTarget) return;
    try {
      setRemoving(true);
      await removeProjectMember(slug, removeTarget.userId);
      setRemoveTarget(null);
      setRemoveError(null);
      await loadMembers();
    } catch (err: any) {
      setRemoveError(err.message || t2('فشل إزالة العضو', 'Failed to remove member'));
    } finally {
      setRemoving(false);
    }
  };

  const handleTransfer = async (accountPassword?: string) => {
    if (!transferTarget) return;
    try {
      setTransferring(true);
      setTransferError(null);
      const data = await transferOwner(slug, transferTarget.userId, accountPassword);
      setTransferTarget(null);
      setOwnerId(data.ownerId);
      await loadMembers();
    } catch (err: any) {
      setTransferError(err.message || t2('فشل نقل الملكية', 'Failed to transfer ownership'));
    } finally {
      setTransferring(false);
    }
  };

  const handleRoleChange = async (member: ProjectMember, newRole: UserRole) => {
    try {
      await addProjectMember(slug, member.userId, newRole);
      await loadMembers();
    } catch (err: any) {
      setError(err.message || t2('فشل تغيير الدور', 'Failed to change role'));
    }
  };

  if (loading) {
    return <div class="panel-muted" role="status">{t2('جارٍ تحميل الفريق…', 'Loading team...')}</div>;
  }

  return (
    <div class="team-panel">
      {error && <div class="notice error" role="alert">{error}</div>}

      <div class="team-header">
        <h2 class="team-title">
          <Users class="icon" />
          <span>{t2('فريق المشروع', 'Project Team')}</span>
          <span class="badge">{members.length}</span>
        </h2>
        {canManage && nonMembers.length > 0 && (
          <button class="btn-primary sm" aria-expanded={showAdd} onClick={() => { if (showAdd) setError(null); setShowAdd(!showAdd); }}>
            <UserPlus class="icon" />
            {showAdd ? t2('إلغاء', 'Cancel') : t2('إضافة عضو', 'Add Member')}
          </button>
        )}
      </div>

      {showAdd && (
        <div class="add-member-form">
          <select
            class="select-dark"
            aria-label={t2('مستخدم للإضافة', 'User to add')}
            value={selectedUserId}
            onChange={(e) => setSelectedUserId((e.target as HTMLSelectElement).value)}
          >
            <option value="">{t2('اختر مستخدماً…', 'Select user...')}</option>
            {nonMembers.map((u) => (
              <option key={u.id} value={u.id}>{u.username} ({roleLabel(u.role)})</option>
            ))}
          </select>
          <select
            class="select-dark"
            aria-label={t2('دور العضو الجديد', 'Role for the new member')}
            value={selectedRole}
            onChange={(e) => setSelectedRole((e.target as HTMLSelectElement).value as UserRole)}
          >
            <option value="viewer">{t2('عارض', 'Viewer')}</option>
            <option value="editor">{t2('محرر', 'Editor')}</option>
            <option value="admin">{t2('مدير', 'Admin')}</option>
          </select>
          <button
            class="btn-primary sm"
            disabled={!selectedUserId || adding}
            onClick={handleAdd}
          >
            {adding ? t2('جارٍ الإضافة…', 'Adding...') : t2('إضافة', 'Add')}
          </button>
        </div>
      )}

      <div class="member-list">
        {members.length === 0 ? (
          <div class="panel-muted" role="status">{t2('لا يوجد أعضاء بعد.', 'No team members yet.')}</div>
        ) : (
          sortedMembers.map((m) => {
              const isOwner = ownerId === m.userId;
              return (
                <div class="member-row" key={m.userId}>
                  <div
                    class="member-info"
                    role="button"
                    tabIndex={0}
                    title={t2(`عرض ملف ${m.displayName || m.username}`, `View ${m.displayName || m.username}'s profile`)}
                    onClick={() => setLocation(`/user/${m.userId}`)}
                    onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setLocation(`/user/${m.userId}`); } }}
                  >
                    <div class="member-avatar" style="position:relative">
                      <Avatar name={m.displayName || m.username} avatar={avatarUrl(m.userId, m.avatarExt)} size={34} decorative />
                      {onlineIds.has(m.userId) && <span class="presence-online-dot" />}
                    </div>
                    <div class="member-details">
                      <span class="member-name">
                        {m.displayName || m.username}
                        <RoleBadge
                          role={m.role}
                          ar={ar}
                          title={isOwner
                            ? t2('المالك — يحمل دائماً صلاحية مدير', 'Owner — always holds admin access')
                            : undefined}
                        />
                      </span>
                      <span class="member-meta">
                        {t2('أُضيف في', 'Added')} {new Date(m.addedAt).toLocaleDateString()}
                        {isOwner && (
                          <>
                            {' '}<span aria-hidden="true">·</span> {t2('مالك المشروع', 'Project owner')}
                          </>
                        )}
                      </span>
                    </div>
                  </div>
                  <div class="member-actions">
                    {isOwner ? (
                      // The owner's role is fixed — the ownership check in
                      // checkProjectAccess outranks any member role, so a
                      // changeable select here would be a lie. The role badge
                      // next to the name already says "admin"; nothing more to
                      // render (the crown badge was retired).
                      null
                    ) : canManage ? (
                      <select
                        class="select-dark select-sm"
                        aria-label={t2(`دور ${m.username}`, `Role for ${m.username}`)}
                        value={m.role}
                        onChange={(e) => handleRoleChange(m, (e.target as HTMLSelectElement).value as UserRole)}
                      >
                        <option value="viewer">{t2('عارض', 'Viewer')}</option>
                        <option value="editor">{t2('محرر', 'Editor')}</option>
                        <option value="admin">{t2('مدير', 'Admin')}</option>
                      </select>
                    ) : (
                      <span class="member-meta"><RoleBadge role={m.role} ar={ar} /></span>
                    )}
                    {canManage && !isOwner && (
                      <>
                        <button
                          class="btn-ghost sm"
                          title={t2('نقل الملكية', 'Transfer ownership')}
                          aria-label={t2(`نقل الملكية إلى ${m.username}`, `Transfer ownership to ${m.username}`)}
                          onClick={() => { setTransferError(null); setTransferTarget(m); }}
                        >
                          <Crown class="icon icon-sm" />
                        </button>
                        <button
                          class="btn-danger sm"
                          title={t2('إزالة العضو', 'Remove member')}
                          aria-label={t2(`إزالة ${m.username}`, `Remove ${m.username}`)}
                          onClick={() => { setRemoveError(null); setRemoveTarget(m); }}
                        >
                          <Trash2 class="icon icon-sm" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })
        )}
      </div>

      <ConfirmModal
        open={!!removeTarget}
        danger={true}
        title={removeTarget ? t2(`إزالة ${removeTarget.username}؟`, `Remove ${removeTarget.username}?`) : ''}
        message={t2('سيفقد الوصول إلى هذا المشروع.', 'They will lose access to this project.')}
        confirmLabel={t2('إزالة', 'Remove')}
        onConfirm={handleRemove}
        onCancel={() => { setRemoveTarget(null); setRemoveError(null); }}
        loading={removing}
        error={removeError}
      />

      <ReAuthModal
        open={!!transferTarget}
        username={currentUser?.username}
        loading={transferring}
        error={transferError}
        title={t2(`نقل الملكية إلى ${transferTarget?.username}؟`, `Transfer ownership to ${transferTarget?.username}?`)}
        description={t2(`سيصبح ${transferTarget?.username} المالك الجديد بصلاحية كاملة. ستصبح أنت عضواً مديراً. أدخل كلمة مرور حسابك للتأكيد.`, `${transferTarget?.username} becomes the new owner with full control. You will become an admin member. Enter your account password to confirm.`)}
        confirmLabel={t2('نقل الملكية', 'Transfer ownership')}
        onConfirm={handleTransfer}
        onCancel={() => { setTransferTarget(null); setTransferError(null); }}
      />
    </div>
  );
}
