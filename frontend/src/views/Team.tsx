import { useState, useEffect } from 'preact/hooks';
import {
  Users,
  UserPlus,
  Trash2,
  ShieldCheck,
  Shield,
  Eye,
  Loader2,
  AlertTriangle,
} from 'lucide-preact';
import { useAuth } from '../auth';
import {
  listUsers,
  createUser,
  updateUserRole,
  deleteUser,
  type TeamUser,
  type UserRole,
} from '../api';

const ROLE_CONFIG: Record<UserRole, { label: string; color: string; icon: typeof ShieldCheck }> = {
  admin: { label: 'Admin', color: '#f59e0b', icon: ShieldCheck },
  editor: { label: 'Editor', color: '#3b82f6', icon: Shield },
  viewer: { label: 'Viewer', color: '#6b7280', icon: Eye },
};

export function Team() {
  const { user: currentUser } = useAuth();
  const isAdmin = currentUser?.role === 'admin';
  const [users, setUsers] = useState<TeamUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState<UserRole>('editor');
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<TeamUser | null>(null);

  useEffect(() => {
    loadUsers();
  }, []);

  async function loadUsers() {
    try {
      setLoading(true);
      const data = await listUsers();
      setUsers(data);
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

  async function handleRoleChange(userId: string, role: UserRole) {
    try {
      setError('');
      await updateUserRole(userId, role);
      await loadUsers();
    } catch (err: any) {
      setError(err.message || 'Failed to update role');
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
        {users.map((u) => {
          const isMe = u.id === currentUser?.id;
          const cfg = ROLE_CONFIG[u.role];
          const RoleIcon = cfg.icon;
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
              }}
            >
              <div style={{
                width: 36, height: 36, borderRadius: '50%',
                background: `${cfg.color}20`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
              }}>
                <RoleIcon size={18} color={cfg.color} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={{ fontWeight: 600, fontSize: '0.9375rem' }}>{u.username}</span>
                  {isMe && <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>(you)</span>}
                  <span style={{
                    fontSize: '0.6875rem',
                    padding: '0.125rem 0.375rem',
                    borderRadius: 4,
                    background: `${cfg.color}20`,
                    color: cfg.color,
                    fontWeight: 600,
                  }}>
                    {cfg.label}
                  </span>
                </div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.125rem' }}>
                  Joined {new Date(u.createdAt).toLocaleDateString()}
                </div>
              </div>
              {isAdmin && !isMe && (
                <div style={{ display: 'flex', gap: '0.375rem', flexShrink: 0 }}>
                  <select
                    value={u.role}
                    onChange={(e) => handleRoleChange(u.id, (e.target as HTMLSelectElement).value as UserRole)}
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
                    <option value="editor">Editor</option>
                    <option value="viewer">Viewer</option>
                  </select>
                  <button
                    class="btn-icon"
                    onClick={() => setConfirmDelete(u)}
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
    </div>
  );
}
