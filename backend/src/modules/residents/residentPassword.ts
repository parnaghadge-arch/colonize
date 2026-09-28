/**
 * Every resident account starts with this password. It is not a lasting secret:
 * sign-in with it sets `mustChangePassword`, and the resident app will not open
 * anything else until they choose their own.
 */
export const RESIDENT_INITIAL_PASSWORD = 'Resident@123';

const RESIDENT_ROLES = new Set(['OWNER', 'TENANT', 'FAMILY_MEMBER', 'RESIDENT']);

export function isResidentRole(roles: unknown): boolean {
  return Array.isArray(roles) && roles.some((role) => RESIDENT_ROLES.has(String(role)));
}
