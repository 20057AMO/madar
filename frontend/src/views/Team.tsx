import { useState, useEffect } from 'preact/hooks';
import { useHashLocation } from 'wouter/use-hash-location';
import {
  Users,
  UserPlus,
  Trash2,
  Loader2,
  AlertTriangle,
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

const ROLE_CONFIG: Record<UserRole, { label: string; color: string; hint: string }> = {
  admin: { label: 'Admin', color: '#f59e0b', hint: 'Full access — users, settings, providers and all projects.' },
  editor: {
    label: 'Editor',
    color: '#3b82f6',
    hint: 'Global editor — writes to every project; cannot manage users, settings, providers, or delete others’ projects.',
  },
  viewer: { label: 'Viewer', color: '#6b7280', hint: 'Read-only on the projects they are added to.' },
};

const ROLE_ORDER: Record<UserRole, number> = { admin: 3, editor: 2, viewer: 1 };

export function Team() {
  const { user: currentUser } = useAuth();
  const isAdmin = currentUser?.role === 'admin';
  const [, setLocation] = useHashLocation();
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

  useEffect(() => {
    loadUsers();
  }, []);

  async function loadUsers() {
    try {
      setLoading(true);
      const data = await getTeamMemberships();
      setUsers(data.users);
    } catch (err: any) {
      setError(err.message || 'Failed to load users');
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
      setError(err.message || 'Failed to create user');
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
      setRoleError(err.message || 'Failed to update role');
    } finally {
      setRoleSaving(false);
    }
  }

  async function handleDelete(userId: string) {
    try {
      setError('');
      await deleteUser(userId);
      setConfirmDelete(null);
      await loadUsers();
    } catch (err: any) {
      setError(err.message || 'Failed to delete user');
    }
  }

  // Role-aware ordering: admins first, then editors, then viewers, joined
  // date as the tiebreaker — a manager scanning the roster sees the hierarchy.
  const sortedUsers = [...users].sort(
    (a, b) =>
      (ROLE_ORDER[b.role] || 0) - (ROLE_ORDER[a.role] || 0) ||
      String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
  );

  if (loading) {
    return (
      <div class="page-container" style={{ display: 'flex', justifyContent: 'center', paddingTop: '4rem' }}>
        <Loader2 class="icon spin" size={32} />
      </div>
    );
  }

  return (
    <div class="page-container" style={{ maxWidth: 800, margin: '0 auto', padding: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Users size={24} />
          <h1 style={{ margin: 0, fontSize: '1.5rem' }}>Team</h1>
          <span style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>{users.length} user(s)</span>
        </div>
        {isAdmin && (
          <button
            class="btn btn-primary"
            onClick={() => setShowAdd(!showAdd)}
            style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}
          >
            <UserPlus size={16} />
            Add User
          </button>
        )}
      </div>

      {error && (
        <div role="alert" style={{
          background: 'rgba(239,68,68,0.1)',
          border: '1px solid rgba(239,68,68,0.3)',
          borderRadius: 8,
          padding: '0.75rem 1rem',
          marginBottom: '1rem',
          color: '#ef4444',
          fontSize: '0.875rem',
        }}>
          {error}
        </div>
      )}

      {showAdd && (
        <div style={{
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: '1.25rem',
          marginBottom: '1rem',
        }}>
          <h3 style={{ margin: '0 0 1rem' }}>Add New User</h3>
          <div style={{ display: 'grid', gap: '0.75rem' }}>
            <input
              type="text"
              placeholder="Username"
              value={newUsername}
              onInput={(e) => setNewUsername((e.target as HTMLInputElement).value)}
              style={{ padding: '0.5rem 0.75rem', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }}
            />
            <input
              type="password"
              placeholder="Password (min 6 characters)"
              value={newPassword}
              onInput={(e) => setNewPassword((e.target as HTMLInputElement).value)}
              style={{ padding: '0.5rem 0.75rem', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--bg)', color: 'var(--text)' }}
            />
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              {(['admin', 'editor', 'viewer'] as UserRole[]).map((r) => {
                const cfg = ROLE_CONFIG[r];
                return (
                  <button
                    key={r}
                    type="button"
                    role="radio"
                    aria-checked={newRole === r}
                    onClick={() => setNewRole(r)}
                    style={{
                      padding: '0.375rem 0.75rem',
                      borderRadius: 6,
                      border: `1px solid ${newRole === r ? cfg.color : 'var(--border)'}`,
                      background: newRole === r ? `${cfg.color}20` : 'transparent',
                      color: newRole === r ? cfg.color : 'var(--text-secondary)',
                      cursor: 'pointer',
                      fontSize: '0.8125rem',
                      fontWeight: newRole === r ? 600 : 400,
                    }}
                  >
                    {cfg.label}
                  </button>
                );
              })}
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{ROLE_CONFIG[newRole].hint}</div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                class="btn btn-primary"
                onClick={handleCreate}
                disabled={creating || !newUsername.trim() || newPassword.trim().length < 6}
              >
                {creating ? <Loader2 class="icon spin" size={14} /> : 'Create'}
              </button>
              <button class="btn" onClick={() => setShowAdd(false)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gap: '0.5rem' }}>
        {sortedUsers.map((u) => {
          const isMe = u.id === currentUser?.id;
          const cfg = ROLE_CONFIG[u.role];
          return (
            <div
              key={u.id}
              className="team-row"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '1rem',
                padding: '0.875rem 1rem',
                background: isMe ? 'rgba(59,130,246,0.06)' : 'var(--surface)',
                border: `1px solid ${isMe ? 'rgba(59,130,246,0.2)' : 'var(--border)'}`,
                borderRadius: 10,
                cursor: 'pointer',
              }}
              onClick={() => setLocation(`/user/${u.id}`)}
              role="button"
              tabIndex={0}
              title={`View ${u.profile?.displayName || u.username}'s profile`}
              onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setLocation(`/user/${u.id}`); } }}
            >
              <Avatar name={u.profile?.displayName || u.username} avatar={avatarUrl(u.id, u.profile?.avatarExt)} size={36} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={{ fontWeight: 600, fontSize: '0.9375rem' }}>{u.profile?.displayName || u.username}</span>
                  {isMe && <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>(you)</span>}
                  <span style={{
                    fontSize: '0.6875rem',
                    padding: '0.125rem 0.375rem',
                    borderRadius: 4,
                    background: `${cfg.color}20`,
                    color: cfg.color,
                    fontWeight: 600,
                  }}>
                    {cfg.label}{u.role === 'editor' ? ' · global' : ''}
                  </span>
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.125rem' }}>
                  {cfg.hint}
                </div>
                <div style={{ fontSize: '0.6875rem', color: 'rgba(255,255,255,0.3)', marginTop: '0.125rem' }}>
                  Joined {new Date(u.createdAt).toLocaleDateString()}
                </div>
                {u.memberships && u.memberships.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem', marginTop: '0.5rem' }}>
                    {u.memberships.map((m) => (
                      <span
                        key={m.slug}
                        title={m.isOwner ? `Owner of ${m.name}` : `${m.role} on ${m.name}`}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '0.25rem',
                          fontSize: '0.6875rem',
                          padding: '0.125rem 0.4375rem',
                          borderRadius: 999,
                          background: 'rgba(59,130,246,0.08)',
                          border: '1px solid rgba(59,130,246,0.18)',
                          color: 'var(--text-secondary)',
                          maxWidth: 220,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {m.isOwner && <span style={{ color: '#f59e0b' }}>★</span>}
                        {m.name}
                        <span style={{
                          fontSize: '0.625rem',
                          padding: '0 0.25rem',
                          borderRadius: 4,
                          background: 'rgba(59,130,246,0.14)',
                          color: '#60a5fa',
                          fontWeight: 600,
                          textTransform: 'capitalize',
                        }}>
                          {m.isOwner ? 'owner' : m.role}
                        </span>
                      </span>
                    ))}
                  </div>
                )}
              </div>
              {isAdmin && !isMe && (
                <div style={{ display: 'flex', gap: '0.375rem', flexShrink: 0 }}>
                  <select
                    value={u.role}
                    onClick={(e: Event) => e.stopPropagation()}
                    onChange={(e) => handleRoleChangeRequested(u.id, (e.target as HTMLSelectElement).value as UserRole)}
                    style={{
                      padding: '0.25rem 0.5rem',
                      borderRadius: 6,
                      border: '1px solid var(--border)',
                      background: 'var(--bg)',
                      color: 'var(--text)',
                      fontSize: '0.8125rem',
                    }}
                  >
                    <option value="admin">Admin</option>
                    <option value="editor">Editor (Global)</option>
                    <option value="viewer">Viewer</option>
                  </select>
                  <button
                    class="btn-icon"
                    onClick={(e: Event) => { e.stopPropagation(); setConfirmDelete(u); }}
                    title="Remove user"
                    aria-label={`Remove user ${u.username}`}
                    style={{ color: '#ef4444' }}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {confirmDelete && (
        <div
          style={{
            position: 'fixed', inset: 0,
            background: 'rgba(0,0,0,0.6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000,
          }}
          onClick={() => setConfirmDelete(null)}
        >
          <div
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              padding: '1.5rem',
              maxWidth: 400,
              width: '90%',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
              <AlertTriangle size={20} color="#ef4444" />
              <h3 style={{ margin: 0 }}>Remove User</h3>
            </div>
            <p style={{ margin: '0 0 1rem', color: 'var(--text-secondary)' }}>
              Are you sure you want to remove <strong>{confirmDelete.username}</strong>?
              They will be logged out immediately.
            </p>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button class="btn" onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button
                class="btn"
                style={{ background: '#ef4444', color: '#fff' }}
                onClick={() => handleDelete(confirmDelete.id)}
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
      <ReAuthModal
        open={pendingRole !== null}
        username={pendingRole ? (pendingRole.user.profile?.displayName || pendingRole.user.username) : currentUser?.username}
        loading={roleSaving}
        error={roleError}
        title={pendingRole ? `Change role of ${pendingRole.user.profile?.displayName || pendingRole.user.username}` : 'Change role'}
        description={
          pendingRole
            ? `Set ${pendingRole.user.profile?.displayName || pendingRole.user.username} as ${ROLE_CONFIG[pendingRole.role].label}? Enter your account password to confirm.`
            : 'Enter your account password to confirm.'
        }
        confirmLabel="Change role"
        onConfirm={handleRoleChangeConfirmed}
        onCancel={() => { setPendingRole(null); setRoleError(null); }}
      />
    </div>
  );
}
