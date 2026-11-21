export type TerminalMode = 'project' | 'control';

interface TerminalUser {
  id: string;
  role: 'admin' | 'editor' | 'viewer';
  permissions?: { projectWrite?: boolean; projectTeam?: boolean };
}

interface TerminalProject {
  ownerId?: string;
  members?: { userId: string; role: 'admin' | 'editor' | 'viewer' }[];
}

export function canUseTerminalMode(
  user: TerminalUser | null | undefined,
  project: TerminalProject | null | undefined,
  mode: TerminalMode,
): boolean {
  if (!user || !project) return false;
  if (user.role === 'admin') return true;
  const member = (project.members || []).find((entry) => entry.userId === user.id);
  if (mode === 'control') {
    if (project.ownerId === user.id) return true;
    return member?.role === 'admin';
  }
  if (user.role === 'editor') return true;
  if (!project.ownerId && !(project.members && project.members.length > 0)) return true;
  if (project.ownerId === user.id) return true;
  if (!member) return false;
  return member.role === 'admin' || member.role === 'editor' || user.permissions?.projectWrite === true;
}
