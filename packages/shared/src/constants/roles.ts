/**
 * Role catalogue for the Colonize platform.
 *
 * Roles are grouped by *scope*. A scope determines where a role can be granted and which
 * part of the product it unlocks (platform console, society console, resident app,
 * security app, staff app, vendor portal).
 *
 * Roles are data, not code paths: the permission matrix below only defines sensible
 * defaults. A society can override any role's permissions at runtime (see the `roles`
 * collection in each society database + `rbac` module), which satisfies the requirement
 * that "permissions must be configurable".
 */

export const ROLE_SCOPES = [
  'platform',
  'society',
  'resident',
  'security',
  'staff',
  'vendor',
] as const;
export type RoleScope = (typeof ROLE_SCOPES)[number];

/** Platform (SaaS operator) roles. */
export const PLATFORM_ROLES = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  PLATFORM_ADMIN: 'PLATFORM_ADMIN',
  SUPPORT_ADMIN: 'SUPPORT_ADMIN',
  FINANCE_ADMIN: 'FINANCE_ADMIN',
} as const;

/** Society (tenant) management roles. */
export const SOCIETY_ROLES = {
  SOCIETY_ADMIN: 'SOCIETY_ADMIN',
  CHAIRMAN: 'CHAIRMAN',
  SECRETARY: 'SECRETARY',
  TREASURER: 'TREASURER',
  COMMITTEE_MEMBER: 'COMMITTEE_MEMBER',
  FACILITY_MANAGER: 'FACILITY_MANAGER',
  ACCOUNTANT: 'ACCOUNTANT',
  RECEPTIONIST: 'RECEPTIONIST',
} as const;

/** Resident-side roles (owners, tenants and their households). */
export const RESIDENT_ROLES = {
  OWNER: 'OWNER',
  TENANT: 'TENANT',
  FAMILY_MEMBER: 'FAMILY_MEMBER',
} as const;

/** Gate / security roles. */
export const SECURITY_ROLES = {
  SECURITY_GUARD: 'SECURITY_GUARD',
  SECURITY_SUPERVISOR: 'SECURITY_SUPERVISOR',
} as const;

/** Society-employed / contracted staff roles. */
export const STAFF_ROLES = {
  DOMESTIC_STAFF: 'DOMESTIC_STAFF',
  MAINTENANCE_STAFF: 'MAINTENANCE_STAFF',
  ELECTRICIAN: 'ELECTRICIAN',
  PLUMBER: 'PLUMBER',
  HOUSEKEEPING: 'HOUSEKEEPING',
  GARDENER: 'GARDENER',
  DRIVER: 'DRIVER',
} as const;

/** Vendor / service-provider roles. */
export const VENDOR_ROLES = {
  VENDOR: 'VENDOR',
  SERVICE_PROVIDER: 'SERVICE_PROVIDER',
} as const;

export const ROLES = {
  ...PLATFORM_ROLES,
  ...SOCIETY_ROLES,
  ...RESIDENT_ROLES,
  ...SECURITY_ROLES,
  ...STAFF_ROLES,
  ...VENDOR_ROLES,
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

export const ALL_ROLES = Object.values(ROLES) as Role[];

export const ROLE_SCOPE: Record<Role, RoleScope> = {
  ...Object.fromEntries(Object.values(PLATFORM_ROLES).map((r) => [r, 'platform'])) as Record<
    (typeof PLATFORM_ROLES)[keyof typeof PLATFORM_ROLES],
    'platform'
  >,
  ...Object.fromEntries(Object.values(SOCIETY_ROLES).map((r) => [r, 'society'])) as Record<
    (typeof SOCIETY_ROLES)[keyof typeof SOCIETY_ROLES],
    'society'
  >,
  ...Object.fromEntries(Object.values(RESIDENT_ROLES).map((r) => [r, 'resident'])) as Record<
    (typeof RESIDENT_ROLES)[keyof typeof RESIDENT_ROLES],
    'resident'
  >,
  ...Object.fromEntries(Object.values(SECURITY_ROLES).map((r) => [r, 'security'])) as Record<
    (typeof SECURITY_ROLES)[keyof typeof SECURITY_ROLES],
    'security'
  >,
  ...Object.fromEntries(Object.values(STAFF_ROLES).map((r) => [r, 'staff'])) as Record<
    (typeof STAFF_ROLES)[keyof typeof STAFF_ROLES],
    'staff'
  >,
  ...Object.fromEntries(Object.values(VENDOR_ROLES).map((r) => [r, 'vendor'])) as Record<
    (typeof VENDOR_ROLES)[keyof typeof VENDOR_ROLES],
    'vendor'
  >,
} as Record<Role, RoleScope>;

/** Roles that authenticate against the platform (super-admin) console. */
export const PLATFORM_ROLE_LIST = Object.values(PLATFORM_ROLES) as Role[];
/** Roles that authenticate against the society management console. */
export const SOCIETY_ROLE_LIST = Object.values(SOCIETY_ROLES) as Role[];
/** Roles allowed into the resident mobile app. */
export const RESIDENT_APP_ROLES = Object.values(RESIDENT_ROLES) as Role[];
/** Roles allowed into the security/gatekeeper mobile app. */
export const SECURITY_APP_ROLES = Object.values(SECURITY_ROLES) as Role[];

export const ROLE_LABELS: Record<Role, string> = {
  SUPER_ADMIN: 'Super Admin',
  PLATFORM_ADMIN: 'Platform Admin',
  SUPPORT_ADMIN: 'Support Admin',
  FINANCE_ADMIN: 'Finance Admin',
  SOCIETY_ADMIN: 'Society Admin',
  CHAIRMAN: 'Chairman',
  SECRETARY: 'Secretary',
  TREASURER: 'Treasurer',
  COMMITTEE_MEMBER: 'Committee Member',
  FACILITY_MANAGER: 'Facility Manager',
  ACCOUNTANT: 'Accountant',
  RECEPTIONIST: 'Receptionist',
  OWNER: 'Owner',
  TENANT: 'Tenant',
  FAMILY_MEMBER: 'Family Member',
  SECURITY_GUARD: 'Security Guard',
  SECURITY_SUPERVISOR: 'Security Supervisor',
  DOMESTIC_STAFF: 'Domestic Staff',
  MAINTENANCE_STAFF: 'Maintenance Staff',
  ELECTRICIAN: 'Electrician',
  PLUMBER: 'Plumber',
  HOUSEKEEPING: 'Housekeeping',
  GARDENER: 'Gardener',
  DRIVER: 'Driver',
  VENDOR: 'Vendor',
  SERVICE_PROVIDER: 'Service Provider',
};

/** Resident relationship kinds inside a unit (drives `unit_members.kind`). */
export const MEMBER_KINDS = ['OWNER', 'TENANT', 'FAMILY', 'COMPANY_GUEST'] as const;
export type MemberKind = (typeof MEMBER_KINDS)[number];

export const FAMILY_RELATIONSHIPS = [
  'SPOUSE',
  'CHILD',
  'PARENT',
  'SIBLING',
  'GRANDPARENT',
  'IN_LAW',
  'OTHER',
] as const;
export type FamilyRelationship = (typeof FAMILY_RELATIONSHIPS)[number];
