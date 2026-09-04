import type { Document } from '../db/drivers/types.js';
import type { TenantDatabase } from '../db/drivers/types.js';
import { ApiError } from '../utils/errors.js';

/**
 * Request context types (§5, §51).
 *
 * The golden rule enforced here: **societyId, unitId and roles are never taken from the
 * client.** They are resolved from the verified JWT plus a database lookup, and then used to
 * scope every single query the request performs.
 */

export interface SocietyContext {
  id: string;
  slug: string;
  name: string;
  databaseName: string;
  status: string;
  timezone: string;
  currency: string;
  logoUrl?: string | null;
  type?: string;
}

export interface MembershipContext {
  /** Units this user is linked to (residents: their flats; staff: units they may visit). */
  unitIds: string[];
  primaryUnitId: string | null;
  residentId: string | null;
  staffId: string | null;
  vendorId: string | null;
  familyMemberId: string | null;
  /** Per-family-member permissions (only set for FAMILY_MEMBER role). */
  familyPermissions?: Record<string, boolean>;
  /** Gates a guard is assigned to (empty = all gates). */
  gateIds: string[];
}

export interface PrincipalContext {
  userId: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  avatarUrl: string | null;
  roles: string[];
  permissions: Set<string>;
  scope: 'platform' | 'tenant';
  sessionId: string | null;
  deviceId: string | null;
  isPlatformUser: boolean;
  /** True for OWNER/TENANT/FAMILY_MEMBER — used to narrow data to the caller's own unit. */
  isResidentScope: boolean;
  /** True for SECURITY_GUARD/SECURITY_SUPERVISOR. */
  isSecurityScope: boolean;
  isVendorScope: boolean;
  isStaffScope: boolean;
  /** Raw user document (tenant `users` or platform `platform_users`). */
  userDoc: Document;
}

export interface RequestContext {
  requestId: string;
  ip: string;
  userAgent: string;
  platform: 'ios' | 'android' | 'web' | 'unknown';
  appVersion?: string;
  principal: PrincipalContext;
  society: SocietyContext | null;
  membership: MembershipContext;
  /** The tenant database this request may use. Null for platform-only requests. */
  db: TenantDatabase | null;
  platformDatabase: TenantDatabase;
  /** Enabled modules for this society's subscription (module gating, §42). */
  enabledModules: Set<string>;
  startedAt: number;
}

/**
 * Base filter that MUST be spread into every tenant query.
 * Adds the society boundary even though each society already has its own database — the
 * second line of defence that makes cross-tenant leakage structurally impossible.
 */
export function tenantFilter(ctx: RequestContext): Document {
  if (!ctx.society) throw ApiError.forbidden('No society context is available for this request', 'TENANT_MISMATCH');
  return { societyId: ctx.society.id };
}

/**
 * Unit-level scoping for resident-scope callers.
 * Society staff/admin get no restriction; residents are limited to their own units.
 */
export function unitScopeFilter(ctx: RequestContext, field = 'unitId'): Document {
  if (!ctx.principal.isResidentScope) return {};
  const unitIds = ctx.membership.unitIds;
  if (unitIds.length === 0) {
    // A resident with no linked unit sees nothing — fail closed.
    return { [field]: '__no_access__' };
  }
  return { [field]: { $in: unitIds } };
}

/** Combined filter: tenant boundary + (optional) resident unit boundary. */
export function scopedFilter(
  ctx: RequestContext,
  extra: Document = {},
  opts: { unitScoped?: boolean; unitScopeField?: string } = {},
): Document {
  const base: Document = { ...tenantFilter(ctx) };
  if (opts.unitScoped !== false && ctx.principal.isResidentScope) {
    Object.assign(base, unitScopeFilter(ctx, opts.unitScopeField ?? 'unitId'));
  }
  return { ...base, ...extra };
}

/**
 * Assert a loaded document belongs to the caller's society.
 * Called after every direct `findById` so a guessed id from another tenant cannot be read.
 */
export function assertSameSociety<T extends Document>(doc: T | null, ctx: RequestContext, label = 'Record'): T {
  if (!doc) throw ApiError.notFound(label);
  if (!ctx.society) throw ApiError.forbidden('No society context', 'TENANT_MISMATCH');
  if (doc.societyId && doc.societyId !== ctx.society.id) {
    // Logged as a security event: someone tried to reach across the tenant boundary.
    throw ApiError.forbidden(`${label} belongs to another society`, 'TENANT_MISMATCH');
  }
  return doc;
}

/** Assert the caller may act on a specific unit. */
export function assertUnitAccess(ctx: RequestContext, unitId: string | null | undefined, label = 'Unit'): void {
  if (!unitId) return;
  if (!ctx.principal.isResidentScope) return;
  if (!ctx.membership.unitIds.includes(unitId)) {
    throw ApiError.forbidden(`You do not have access to this ${label.toLowerCase()}`, 'FORBIDDEN');
  }
}

/** True when the caller holds any of the given roles. */
export function hasAnyRole(ctx: RequestContext, roles: readonly string[]): boolean {
  return roles.some((r) => ctx.principal.roles.includes(r));
}

/** True when the caller holds a specific permission (supports `module:*`). */
export function hasPermission(ctx: RequestContext, permission: string): boolean {
  if (ctx.principal.permissions.has('*')) return true;
  if (ctx.principal.permissions.has(permission)) return true;
  const [mod] = permission.split(':');
  return ctx.principal.permissions.has(`${mod}:*`);
}
