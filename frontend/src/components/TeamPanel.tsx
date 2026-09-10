import { useState, useEffect } from 'preact/hooks';
import { useHashLocation } from 'wouter/use-hash-location';
import { Users, UserPlus, Trash2, Crown } from 'lucide-preact';
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
import { Avatar } from './Avatar';
import type { PresenceUser } from '../usePresence';

interface Props {
  slug: string;
  project: any;
  onlineUsers?: PresenceUser[];
}

const ROLE_HIERARCHY: Record<string, number> = { admin: 3, editor: 2, viewer: 1 };

export function TeamPanel({ slug, project, onlineUsers = [] }: Props) {
  const [, setLocation] = useHashLocation();
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [allUsers, setAllUsers] = useState<TeamUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const onlineIds = new Set(onlineUsers.map(u => u.id));

  // Add form
  const [showAdd, setShowAdd] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [selectedRole, setSelectedRole] = useState<UserRole>('viewer');
  const [adding, setAdding] = useState(false);

  // Remove confirmation
  const [removeTarget, setRemoveTarget] = useState<ProjectMember | null>(null);
  const [removing, setRemoving] = useState(false);

  // Transfer ownership
  const [transferTarget, setTransferTarget] = useState<ProjectMember | null>(null);
  const [transferring, setTransferring] = useState(false);

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
      setError(err.message || 'Failed to load members');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadMembers(); }, [slug]);

  const isMember = (userId: string) => members.some((m) => m.userId === userId);
  const nonMembers = allUsers.filter((u) => !isMember(u.id));

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
      setError(err.message || 'Failed to add member');
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
      await loadMembers();
    } catch (err: any) {
      setError(err.message || 'Failed to remove member');
    } finally {
      setRemoving(false);
    }
  };

  const handleTransfer = async () => {
    if (!transferTarget) return;
    try {
      setTransferring(true);
      await transferOwner(slug, transferTarget.userId);
      setTransferTarget(null);
      await loadMembers();
    } catch (err: any) {
      setError(err.message || 'Failed to transfer ownership');
    } finally {
      setTransferring(false);
    }
  };

  const handleRoleChange = async (member: ProjectMember, newRole: UserRole) => {
    try {
      await addProjectMember(slug, member.userId, newRole);
      await loadMembers();
    } catch (err: any) {
      setError(err.message || 'Failed to change role');
    }
  };

  if (loading) {
    return <div class="panel-muted" role="status">Loading team...</div>;
  }

  return (
    <div class="team-panel">
      {error && <div class="notice error" role="alert">{error}</div>}

      <div class="team-header">
        <h2 class="team-title">
          <Users class="icon" />
          <span>Project Team</span>
          <span class="badge">{members.length}</span>
        </h2>
        {nonMembers.length > 0 && (
          <button class="btn-primary sm" aria-expanded={showAdd} onClick={() => setShowAdd(!showAdd)}>
            <UserPlus class="icon" />
            {showAdd ? 'Cancel' : 'Add Member'}
          </button>
        )}
      </div>

      {showAdd && (
        <div class="add-member-form">
          <select
            class="select-dark"
            aria-label="User to add"
            value={selectedUserId}
            onChange={(e) => setSelectedUserId((e.target as HTMLSelectElement).value)}
          >
            <option value="">Select user...</option>
            {nonMembers.map((u) => (
              <option key={u.id} value={u.id}>{u.username} ({u.role})</option>
            ))}
          </select>
          <select
            class="select-dark"
            aria-label="Role for the new member"
            value={selectedRole}
            onChange={(e) => setSelectedRole((e.target as HTMLSelectElement).value as UserRole)}
          >
            <option value="viewer">Viewer</option>
            <option value="editor">Editor</option>
            <option value="admin">Admin</option>
          </select>
          <button
            class="btn-primary sm"
            disabled={!selectedUserId || adding}
            onClick={handleAdd}
          >
            {adding ? 'Adding...' : 'Add'}
          </button>
        </div>
      )}

      <div class="member-list">
        {members.length === 0 ? (
          <div class="panel-muted" role="status">No team members yet.</div>
        ) : (
          members
            .sort((a, b) => (ROLE_HIERARCHY[b.role] || 0) - (ROLE_HIERARCHY[a.role] || 0))
            .map((m) => {
              const isOwner = project?.ownerId === m.userId;
              return (
                <div class="member-row" key={m.userId}>
                  <div
                    class="member-info"
                    role="button"
                    tabIndex={0}
                    title={`View ${m.displayName || m.username}'s profile`}
                    onClick={() => setLocation(`/user/${m.userId}`)}
                    onKeyDown={(e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setLocation(`/user/${m.userId}`); } }}
                  >
                    <div class="member-avatar" style="position:relative">
                      <Avatar name={m.displayName || m.username} avatar={avatarUrl(m.userId, m.avatarExt)} size={34} />
                      {onlineIds.has(m.userId) && <span class="presence-online-dot" />}
                    </div>
                    <div class="member-details">
                      <span class="member-name">
                        {m.displayName || m.username}
                        {isOwner && <Crown class="icon icon-sm" style={{ color: '#f59e0b', marginLeft: '4px' }} />}
                      </span>
                      <span class="member-meta">Added {new Date(m.addedAt).toLocaleDateString()}</span>
                    </div>
                  </div>
                  <div class="member-actions">
                    <select
                      class="select-dark select-sm"
                      aria-label={`Role for ${m.username}`}
                      value={m.role}
                      onChange={(e) => handleRoleChange(m, (e.target as HTMLSelectElement).value as UserRole)}
                    >
                      <option value="viewer">Viewer</option>
                      <option value="editor">Editor</option>
                      <option value="admin">Admin</option>
                    </select>
                    {!isOwner && (
                      <>
                        <button
                          class="btn-ghost sm"
                          title="Transfer ownership"
                          aria-label={`Transfer ownership to ${m.username}`}
                          onClick={() => setTransferTarget(m)}
                        >
                          <Crown class="icon icon-sm" />
                        </button>
                        <button
                          class="btn-danger sm"
                          title="Remove member"
                          aria-label={`Remove ${m.username}`}
                          onClick={() => setRemoveTarget(m)}
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
        title={`Remove ${removeTarget?.username}?`}
        message="They will lose access to this project."
        confirmLabel="Remove"
        onConfirm={handleRemove}
        onCancel={() => setRemoveTarget(null)}
        loading={removing}
      />

      <ConfirmModal
        open={!!transferTarget}
        danger={false}
        title={`Transfer ownership to ${transferTarget?.username}?`}
        message="You will become an admin member. The new owner gets full control."
        confirmLabel="Transfer"
        onConfirm={handleTransfer}
        onCancel={() => setTransferTarget(null)}
        loading={transferring}
      />
    </div>
  );
}
