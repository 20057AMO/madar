export interface UserPermissions {
  projectWrite: boolean;
  projectTeam: boolean;
}

export function sanitizeUserPermissions(value: unknown): UserPermissions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { projectWrite: false, projectTeam: false };
  }
  const permissions = value as Record<string, unknown>;
  return {
    projectWrite: permissions.projectWrite === true,
    projectTeam: permissions.projectTeam === true,
  };
}

export function isUserPermissions(value: unknown): value is UserPermissions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const permissions = value as Record<string, unknown>;
  return Object.keys(permissions).length === 2 &&
    Object.hasOwn(permissions, 'projectWrite') &&
    Object.hasOwn(permissions, 'projectTeam') &&
    typeof permissions.projectWrite === 'boolean' &&
    typeof permissions.projectTeam === 'boolean';
}
