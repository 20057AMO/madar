import { useState, useEffect, useRef } from 'preact/hooks';
import {
  Users,
  UserPlus,
  Trash2,
  Loader2,
  Search,
  X,
  CalendarDays,
  FolderKanban,
} from 'lucide-preact';
import { useAuth } from '../auth';
import {
  getTeamMemberships,
  createUser,
  updateUserRole,
  deleteUser,
  avatarUrl,
  type TeamUserWithMemberships,
  type UserRole,
} from '../api';
import { Avatar } from '../components/Avatar';
import { ReAuthModal } from '../components/ReAuthModal';
import { ConfirmModal } from '../components/ConfirmModal';
import { useI18n } from '../i18n';
import { ROLE_CONFIG, ROLE_ORDER, NEW_ROLE_ORDER, membershipRoleMeta } from '../lib/role-meta';

export function Team() {
  const { user: currentUser } = useAuth();
  const { t2, lang } = useI18n();
  const ar = lang === 'ar';
  const isAdmin = currentUser?.role === 'admin';
  const [users, setUsers] = useState<TeamUserWithMemberships[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<UserRole>('editor');
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<TeamUserWithMemberships | null>(null);
  const [pendingRole, setPendingRole] = useState<{ user: TeamUserWithMemberships; role: UserRole } | null>(null);
  const [roleSaving, setRoleSaving] = useState(false);
  const [roleError, setRoleError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [roleFilter, setRoleFilter] = useState<UserRole | null>(null);
  const roleRefs = useRef<Record<UserRole, HTMLButtonElement | null>>({ admin: null, editor: null, viewer: null });

  useEffect(() => {
    loadUsers();
  }, []);

  async function loadUsers() {
    try {
      setLoading(true);
      const data = await getTeamMemberships();
      setUsers(data.users);
    } catch (err: any) {
      setError(err.message || t2('فشل تحميل المستخدمين', 'Failed to load users'));
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate() {
    if (!newUsername.trim() || !newPassword.trim()) return;
    try {
      setCreating(true);
      setError('');
      await createUser(newUsername.trim(), newPassword.trim(), newRole);
      setNewUsername('');
      setNewPassword('');
      setNewRole('editor');
      setShowAdd(false);
      await loadUsers();
    } catch (err: any) {
      setError(err.message || t2('فشل إنشاء المستخدم', 'Failed to create user'));
    } finally {
      setCreating(false);
    }
  }

  async function handleRoleChangeRequested(userId: string, role: UserRole) {
    if (roleError) setRoleError(null);
    const target = users.find((u) => u.id === userId);
    if (!target || role === target.role) return;
    // Role changes are sudo ops — surface the identity confirmation modal
    // instead of changing the role with a single click.
    setPendingRole({ user: target, role });
  }

  async function handleRoleChangeConfirmed(accountPassword: string) {
    if (!pendingRole) return;
    try {
      setRoleSaving(true);
      setRoleError(null);
      await updateUserRole(pendingRole.user.id, pendingRole.role, accountPassword);
      setPendingRole(null);
      setError('');
      await loadUsers();
    } catch (err: any) {
      setRoleError(err.message || t2('فشل تحديث الدور', 'Failed to update role'));
    } finally {
      setRoleSaving(false);
    }
  }

  function handleRoleKeyDown(e: KeyboardEvent, r: UserRole) {
    const handled = ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Home', 'End'];
    if (!handled.includes(e.key)) return;
    e.preventDefault();
    let next: UserRole;
    if (e.key === 'Home') {
      next = NEW_ROLE_ORDER[0];
    } else if (e.key === 'End') {
      next = NEW_ROLE_ORDER[NEW_ROLE_ORDER.length - 1];
    } else {
      const i = NEW_ROLE_ORDER.indexOf(r);
      const step = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
      const delta = ar ? -step : step;
      next = NEW_ROLE_ORDER[(i + delta + NEW_ROLE_ORDER.length) % NEW_ROLE_ORDER.length];
    }
    setNewRole(next);
    roleRefs.current[next]?.focus();
  }

  async function handleDelete(userId: string) {
    try {
      setDeleting(true);
      setDeleteError(null);
      await deleteUser(userId);
      setConfirmDelete(null);
      setDeleteError(null);
      await loadUsers();
    } catch (err: any) {
      setDeleteError(err.message || t2('فشل حذف المستخدم', 'Failed to delete user'));
    } finally {
      setDeleting(false);
    }
  }

  // Role-aware ordering: admins first, then editors, then viewers, joined
  // date as the tiebreaker — a manager scanning the roster sees the hierarchy.
  const sortedUsers = [...users].sort(
    (a, b) =>
      (ROLE_ORDER[b.role] || 0) - (ROLE_ORDER[a.role] || 0) ||
      String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
  );

  const roleCounts: Record<UserRole, number> = { admin: 0, editor: 0, viewer: 0 };
  for (const u of users) roleCounts[u.role] += 1;

  // Roster search: display name, username, role label and project names.
  const needle = query.trim().toLowerCase();
  const visible = sortedUsers.filter((u) => {
    if (roleFilter && u.role !== roleFilter) return false;
    if (!needle) return true;
    const cfg = ROLE_CONFIG[u.role];
    const hay = [
      u.username,
      u.profile?.displayName || '',
      ar ? cfg.labelAr : cfg.labelEn,
      ...(u.memberships || []).map((m) => m.name),
    ]
      .join(' ')
      .toLowerCase();
    return hay.includes(needle);
  });

  const filtersActive = !!needle || !!roleFilter;

  if (loading) {
    return (
      <div class="team-page" role="status" aria-label={t2('جارٍ تحميل الفريق', 'Loading team')}>
        <div class="team-skel" style={{ marginBottom: 18, padding: '16px 18px' }}>
          <div class="team-skel-av" style={{ width: 46, height: 46, borderRadius: 13 }} />
          <div style={{ flex: 1 }}>
            <div class="skel-line w40" style={{ marginBottom: 8 }} />
            <div class="skel-line w60" style={{ marginBottom: 0, height: 10 }} />
          </div>
        </div>
        {[0, 1, 2].map((i) => (
          <div class="team-skel" key={i} style={{ marginBottom: 8 }}>
            <div class="team-skel-av" />
            <div style={{ flex: 1 }}>
              <div class="skel-line w40" style={{ marginBottom: 8 }} />
              <div class="skel-line w60" style={{ marginBottom: 0, height: 10 }} />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div class="team-page">
      <div class="team-hero">
        <div class="team-hero-l">
          <span class="team-hero-ico" aria-hidden="true">
            <Users size={22} />
          </span>
          <div style={{ minWidth: 0 }}>
            <h1>{t2('الفريق', 'Team')}</h1>
            <div class="team-hero-sub">
              <span>{t2('الأعضاء والصلاحيات عبر المنصة', 'Members and roles across the workspace')}</span>
              <span class="sep" aria-hidden="true">·</span>
              <span>{t2(`${users.length} عضو`, `${users.length} member(s)`)}</span>
            </div>
          </div>
        </div>
        {isAdmin && (
          <button
            class="btn-primary"
            onClick={() => setShowAdd(!showAdd)}
            aria-expanded={showAdd}
          >
            <UserPlus size={16} />
            {showAdd ? t2('إغلاق', 'Close') : t2('إضافة مستخدم', 'Add User')}
          </button>
        )}
      </div>

      {error && (
        <div class="notice error" role="alert" style={{ marginBottom: '1rem', textAlign: 'start' }}>
          {error}
        </div>
      )}

      {isAdmin && users.length > 0 && (
        <div class="team-roles">
          {NEW_ROLE_ORDER.map((r) => {
            const cfg = ROLE_CONFIG[r];
            const Ico = cfg.Icon;
            const active = roleFilter === r;
            return (
              <button
                key={r}
                type="button"
                class="team-role-tile"
                aria-pressed={active}
                style={{ '--rc': cfg.color } as any}
                onClick={() => setRoleFilter(active ? null : r)}
                title={ar ? cfg.hintAr : cfg.hintEn}
              >
                <span class="ico" aria-hidden="true">
                  <Ico size={17} />
                </span>
                <span style={{ minWidth: 0 }}>
                  <span class="num">{roleCounts[r]}</span>
                  <span class="lbl">{ar ? cfg.labelAr : cfg.labelEn}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}

      <div class="team-toolbar">
        <div class="team-search">
          <Search class="icon" size={15} aria-hidden="true" />
          <input
            type="search"
            class="modern-input"
            aria-label={t2('بحث في الفريق', 'Search the team')}
            placeholder={t2('ابحث بالاسم أو المشروع…', 'Search by name or project…')}
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          />
          {query && (
            <button
              type="button"
              class="team-search-clear"
              onClick={() => setQuery('')}
              aria-label={t2('مسح البحث', 'Clear search')}
            >
              <X size={14} />
            </button>
          )}
        </div>
        {filtersActive && (
          <button
            type="button"
            class="btn-ghost"
            onClick={() => { setQuery(''); setRoleFilter(null); }}
          >
            <X size={14} />
            {t2('إلغاء التصفية', 'Clear filters')}
          </button>
        )}
      </div>

      {showAdd && isAdmin && (
        <div class="team-add">
          <h2>{t2('إضافة مستخدم جديد', 'Add New User')}</h2>
          <div class="team-fields">
            <label style={{ display: 'block' }}>
              <span class="field-label" style={{ display: 'block', marginTop: 0 }}>
                {t2('اسم المستخدم', 'Username')}
              </span>
              <input
                type="text"
                class="modern-input"
                autocomplete="username"
                placeholder={t2('اسم المستخدم', 'Username')}
                value={newUsername}
                onInput={(e) => setNewUsername((e.target as HTMLInputElement).value)}
                style={{ marginTop: 6 }}
              />
            </label>
            <label style={{ display: 'block' }}>
              <span class="field-label" style={{ display: 'block', marginTop: 0 }}>
                {t2('كلمة المرور', 'Password')}
              </span>
              <input
                type="password"
                class="modern-input"
                autocomplete="new-password"
                placeholder={t2('6 أحرف على الأقل', 'Min 6 characters')}
                value={newPassword}
                onInput={(e) => setNewPassword((e.target as HTMLInputElement).value)}
                style={{ marginTop: 6 }}
              />
            </label>
          </div>

          <div class="field-label" style={{ display: 'block', marginTop: 14 }}>
            {t2('دور المستخدم', 'User role')}
          </div>
          <div role="radiogroup" aria-label={t2('دور المستخدم الجديد', 'New user role')} class="team-role-opts" style={{ marginTop: 6 }}>
            {NEW_ROLE_ORDER.map((r) => {
              const cfg = ROLE_CONFIG[r];
              const Ico = cfg.Icon;
              return (
                <button
                  key={r}
                  ref={(el) => { roleRefs.current[r] = el; }}
                  type="button"
                  role="radio"
                  aria-checked={newRole === r}
                  tabIndex={newRole === r ? 0 : -1}
                  onKeyDown={(e: KeyboardEvent) => handleRoleKeyDown(e, r)}
                  onClick={() => setNewRole(r)}
                  class="team-role-opt"
                  style={{ '--rc': cfg.color } as any}
                >
                  <span class="ico" aria-hidden="true"><Ico size={16} /></span>
                  <span style={{ minWidth: 0 }}>
                    <span class="tt">{ar ? cfg.labelAr : cfg.labelEn}</span>
                    <span class="hh">{ar ? cfg.hintAr : cfg.hintEn}</span>
                  </span>
                </button>
              );
            })}
          </div>

          <div class="team-add-actions">
            <button
              class="btn-primary"
              onClick={handleCreate}
              disabled={creating || !newUsername.trim() || newPassword.trim().length < 6}
            >
              {creating ? <Loader2 class="icon spin" size={14} /> : <UserPlus size={15} />}
              {t2('إنشاء', 'Create')}
            </button>
            <button class="btn-ghost" onClick={() => setShowAdd(false)}>{t2('إلغاء', 'Cancel')}</button>
          </div>
        </div>
      )}

      {users.length === 0 ? (
        <div class="empty-state">
          <div class="big"><Users size={30} aria-hidden="true" /></div>
          <div>{t2('لا يوجد أعضاء بعد.', 'No members yet.')}</div>
          {isAdmin && (
            <button class="btn-primary" style={{ marginTop: 14 }} onClick={() => setShowAdd(true)}>
              <UserPlus size={15} />
              {t2('إضافة أول مستخدم', 'Add the first user')}
            </button>
          )}
        </div>
      ) : visible.length === 0 ? (
        <div class="empty-state">
          <div class="big"><Search size={28} aria-hidden="true" /></div>
          <div>{t2('لا نتائج مطابقة.', 'No matching members.')}</div>
          <button
            class="btn-ghost"
            style={{ marginTop: 14 }}
            onClick={() => { setQuery(''); setRoleFilter(null); }}
          >
            <X size={14} />
            {t2('إلغاء التصفية', 'Clear filters')}
          </button>
        </div>
      ) : (
        <div class="team-list">
          {visible.map((u) => {
            const isMe = u.id === currentUser?.id;
            const cfg = ROLE_CONFIG[u.role] || ROLE_CONFIG.viewer;
            const RoleIco = cfg.Icon;
            const name = u.profile?.displayName || u.username;
            const joined = (() => {
              const d = new Date(u.createdAt);
              return isNaN(d.getTime()) ? '' : d.toLocaleDateString(ar ? 'ar' : undefined);
            })();
            return (
              <div
                key={u.id}
                className={`team-row${isMe ? ' is-me' : ''}`}
              >
                <a
                  href={`#/user/${u.id}`}
                  onClick={(e) => e.stopPropagation()}
                  class="team-row-link"
                  title={t2(`عرض ملف ${name}`, `View ${name}'s profile`)}
                >
                  <Avatar name={name} avatar={avatarUrl(u.id, u.profile?.avatarExt)} size={40} decorative />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div class="team-row-name">
                      <span class="nm">{name}</span>
                      {isMe && <span class="team-me-pill">{t2('أنت', 'you')}</span>}
                      <span
                        class="team-role-badge"
                        style={{ '--rc': cfg.color } as any}
                        title={ar ? cfg.hintAr : cfg.hintEn}
                      >
                        <RoleIco size={11} aria-hidden="true" />
                        {ar ? cfg.labelAr : cfg.labelEn}
                        {u.role === 'editor' ? (ar ? ' · عام' : ' · global') : ''}
                      </span>
                    </div>
                    <div class="team-row-sub">
                      <span class="mono">@{u.username}</span>
                      {joined && (
                        <>
                          <span aria-hidden="true">·</span>
                          <CalendarDays class="icon" size={12} aria-hidden="true" />
                          <span>{t2('انضم في', 'Joined')} {joined}</span>
                        </>
                      )}
                    </div>
                    {u.memberships && u.memberships.length > 0 && (
                      <div class="team-chips">
                        {u.memberships.map((m) => {
                          const mrc = membershipRoleMeta(m.role);
                          const MrcIco = mrc.Icon;
                          return (
                            <span
                              key={m.slug}
                              class="team-chip"
                              title={t2(`${ar ? mrc.labelAr : mrc.labelEn} على ${m.name}`, `${mrc.labelEn} on ${m.name}`)}
                            >
                              <FolderKanban class="icon" size={11} aria-hidden="true" />
                              <span class="nm">{m.name}</span>
                              <span class="rl" style={{ '--rc': mrc.color } as any}>
                                <MrcIco size={9} aria-hidden="true" />
                                {ar ? mrc.labelAr : mrc.labelEn}
                              </span>
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </a>
                {isAdmin && !isMe && (
                  <div class="team-actions">
                    <select
                      class="select-dark select-sm"
                      aria-label={t2(`تغيير دور ${name}`, `Change role for ${name}`)}
                      value={u.role}
                      onClick={(e: Event) => e.stopPropagation()}
                      onChange={(e) => handleRoleChangeRequested(u.id, (e.target as HTMLSelectElement).value as UserRole)}
                    >
                      <option value="admin">{t2('مدير', 'Admin')}</option>
                      <option value="editor">{t2('محرر (عام)', 'Editor (Global)')}</option>
                      <option value="viewer">{t2('عارض', 'Viewer')}</option>
                    </select>
                    <button
                      class="btn-ghost sm icon-only danger-icon"
                      onClick={(e: Event) => { e.stopPropagation(); setDeleteError(null); setConfirmDelete(u); }}
                      title={t2('إزالة المستخدم', 'Remove user')}
                      aria-label={t2(`إزالة المستخدم ${u.username}`, `Remove user ${u.username}`)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <ConfirmModal
        open={!!confirmDelete}
        danger
        title={confirmDelete ? t2(`إزالة ${confirmDelete.username}؟`, `Remove ${confirmDelete.username}?`) : ''}
        message={confirmDelete ? t2(`هل تريد إزالة ${confirmDelete.username}؟ سيُسجَّل خروجه فوراً.`, `Are you sure you want to remove ${confirmDelete.username}? They will be logged out immediately.`) : undefined}
        confirmLabel={t2('إزالة', 'Remove')}
        loading={deleting}
        error={deleteError}
        onConfirm={() => { if (confirmDelete) handleDelete(confirmDelete.id); }}
        onCancel={() => { setConfirmDelete(null); setDeleteError(null); }}
      />
      <ReAuthModal
        open={pendingRole !== null}
        username={pendingRole ? (pendingRole.user.profile?.displayName || pendingRole.user.username) : currentUser?.username}
        loading={roleSaving}
        error={roleError}
        title={pendingRole ? t2(`تغيير دور ${pendingRole.user.profile?.displayName || pendingRole.user.username}`, `Change role of ${pendingRole.user.profile?.displayName || pendingRole.user.username}`) : t2('تغيير الدور', 'Change role')}
        description={
          pendingRole
            ? t2(`تعيين ${pendingRole.user.profile?.displayName || pendingRole.user.username} كـ${ar ? ROLE_CONFIG[pendingRole.role].labelAr : ROLE_CONFIG[pendingRole.role].labelEn}؟ أدخل كلمة مرور حسابك للتأكيد.`, `Set ${pendingRole.user.profile?.displayName || pendingRole.user.username} as ${ROLE_CONFIG[pendingRole.role].labelEn}? Enter your account password to confirm.`)
            : t2('أدخل كلمة مرور حسابك للتأكيد.', 'Enter your account password to confirm.')
        }
        confirmLabel={t2('تغيير الدور', 'Change role')}
        onConfirm={handleRoleChangeConfirmed}
        onCancel={() => { setPendingRole(null); setRoleError(null); }}
      />
    </div>
  );
}
