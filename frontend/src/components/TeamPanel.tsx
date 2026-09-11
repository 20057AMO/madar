import { useState, useEffect } from 'preact/hooks';
import { useHashLocation } from 'wouter/use-hash-location';
import { Users, UserPlus, Trash2, Crown } from 'lucide-preact';
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
import type { PresenceUser } from '../usePresence';

interface Props {
  slug: string;
  project: any;
  onlineUsers?: PresenceUser[];
}

const ROLE_HIERARCHY: Record<string, number> = { admin: 3, editor: 2, viewer: 1 };

export function TeamPanel({ slug, project, onlineUsers = [] }: Props) {
  const [, setLocation] = useHashLocation();
  const { user: currentUser } = useAuth();
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [allUsers, setAllUsers] = useState<TeamUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const onlineIds = new Set(onlineUsers.map(u => u.id));

  // The parent polls ownerId on a 5s cycle — keep a local copy so the crown
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
      setError(err.message || 'Failed to load members');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setRemoveTarget(null);
    setTransferTarget(null);
    setTransferError(null);
    loadMembers();
  }, [slug]);

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
      setTransferError(err.message || 'Failed to transfer ownership');
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
        {canManage && nonMembers.length > 0 && (
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
              const isOwner = ownerId === m.userId;
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
                    {isOwner ? (
                      // The owner's role is fixed — the ownership check in
                      // checkProjectAccess outranks any member role, so a
                      // changeable select here would be a lie. Show it as-is.
                      <span class="member-meta" style="textTransform:capitalize" title="The owner always holds admin access">
                        <Crown class="icon icon-sm" style={{ color: '#f59e0b', verticalAlign: '-2px', marginRight: '3px' }} />
                        Owner · Admin
                      </span>
                    ) : canManage ? (
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
                    ) : (
                      <span class="member-meta" style="textTransform:capitalize">{m.role}</span>
                    )}
                    {canManage && !isOwner && (
                      <>
                        <button
                          class="btn-ghost sm"
                          title="Transfer ownership"
                          aria-label={`Transfer ownership to ${m.username}`}
                          onClick={() => { setTransferError(null); setTransferTarget(m); }}
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

      <ReAuthModal
        open={!!transferTarget}
        username={currentUser?.username}
        loading={transferring}
        error={transferError}
        title={`Transfer ownership to ${transferTarget?.username}?`}
        description={`${transferTarget?.username} becomes the new owner with full control. You will become an admin member. Enter your account password to confirm.`}
        confirmLabel="Transfer ownership"
        onConfirm={handleTransfer}
        onCancel={() => { setTransferTarget(null); setTransferError(null); }}
      />
    </div>
  );
}
