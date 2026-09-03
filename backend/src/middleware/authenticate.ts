import type { NextFunction, Request, Response } from 'express';
import { expandPermissions, DEFAULT_ROLE_PERMISSIONS, RESIDENT_APP_ROLES, SECURITY_APP_ROLES, STAFF_ROLES, VENDOR_ROLES } from '@colonize/shared';
import { databases } from '../db/manager.js';
import type { TenantDatabase } from '../db/drivers/types.js';
import { permissionCache, societyCache } from '../services/cache.js';
import { verifyAccessToken } from '../services/tokenService.js';
import { ApiError } from '../utils/errors.js';
import type { Document } from '../db/drivers/types.js';
import type { MembershipContext, PrincipalContext, RequestContext, SocietyContext } from './context.js';

/**
 * Authentication + context resolution (§7, §51).
 *
 * Order of operations, and why:
 *  1. verify the JWT signature/expiry            → the token is ours and unexpired
 *  2. load the *user document* from the database → the account still exists and is active
 *  3. load the *society* from the platform DB    → the tenant is active and we know its DB
 *  4. resolve roles → permissions from the tenant DB
 *                                                  → authorisation reflects the current matrix,
 *                                                    not a stale claim baked into the token
 *  5. resolve unit memberships                     → resident-scope queries can be narrowed
 *
 * Nothing in steps 2-5 is read from the request body or query string.
 */

const TOKEN_SOURCES = ['authorization', 'x-access-token'] as const;

function extractToken(req: Request): string | null {
  for (const header of TOKEN_SOURCES) {
    const value = req.headers[header];
    if (typeof value === 'string' && value.trim()) {
      if (value.toLowerCase().startsWith('bearer ')) return value.slice(7).trim();
      if (header === 'x-access-token') return value.trim();
    }
  }
  // Cookie fallback for the web consoles (httpOnly cookie + CSRF header).
  const cookie = (req as Request & { cookies?: Record<string, string> }).cookies?.access_token;
  if (typeof cookie === 'string' && cookie.trim()) return cookie.trim();
  return null;
}

function detectPlatform(req: Request): 'ios' | 'android' | 'web' | 'unknown' {
  const explicit = String(req.headers['x-platform'] ?? '').toLowerCase();
  if (['ios', 'android', 'web'].includes(explicit)) return explicit as 'ios' | 'android' | 'web';
  const ua = String(req.headers['user-agent'] ?? '').toLowerCase();
  if (/android/.test(ua)) return 'android';
  if (/iphone|ipad|ipod|cfnetwork|darwin/.test(ua)) return 'ios';
  if (/mozilla|chrome|safari|edge|firefox/.test(ua)) return 'web';
  return 'unknown';
}

/* ------------------------------ society lookup ----------------------------- */

export interface PlatformSocietyDoc extends Document {
  _id: string;
  name: string;
  slug: string;
  status: string;
  databaseName: string;
  timezone?: string;
  currency?: string;
  logoUrl?: string | null;
  type?: string;
}

export async function loadSocietyById(societyId: string): Promise<PlatformSocietyDoc | null> {
  return societyCache.wrap<PlatformSocietyDoc | null>(`soc:id:${societyId}`, async () => {
    const db = await databases.platform();
    return db.collection<PlatformSocietyDoc>('societies').findById(societyId);
  }, 60_000);
}

export async function loadSocietyBySlug(slug: string): Promise<PlatformSocietyDoc | null> {
  return societyCache.wrap<PlatformSocietyDoc | null>(`soc:slug:${slug}`, async () => {
    const db = await databases.platform();
    return db.collection<PlatformSocietyDoc>('societies').findOne({ slug: slug.toLowerCase() });
  }, 60_000);
}

function toSocietyContext(doc: PlatformSocietyDoc): SocietyContext {
  return {
    id: doc._id,
    slug: doc.slug,
    name: doc.name,
    databaseName: doc.databaseName,
    status: doc.status,
    timezone: doc.timezone ?? 'Asia/Kolkata',
    currency: doc.currency ?? 'INR',
    logoUrl: doc.logoUrl ?? null,
    type: doc.type,
  };
}

/* --------------------------- permission resolution ------------------------- */

interface ResolvedAuth {
  roles: string[];
  permissions: Set<string>;
  membership: MembershipContext;
  enabledModules: Set<string>;
}

async function resolveTenantAuth(db: TenantDatabase, societyId: string, userId: string, userRoles: string[]): Promise<ResolvedAuth> {
  return permissionCache.wrap<ResolvedAuth>(`perm:${societyId}:${userId}`, async () => {
    const [roleDocs, unitMembers, residents, staffDocs, guardAssignments, subscription] = await Promise.all([
      db.collection('roles').find({ societyId, role: { $in: userRoles } }),
      db.collection('unit_members').find({ societyId, userId, isActive: true }, { limit: 100 }),
      db.collection('residents').findOne({ societyId, userId }),
      db.collection('staff').find({ societyId, userId }, { limit: 5 }),
      db.collection('guard_assignments').find({ societyId, userId, isActive: true }, { limit: 50 }),
      db.collection('subscriptions').findOne({ societyId }),
    ]);

    const permissions = new Set<string>();
    for (const role of userRoles) {
      // The society's stored matrix wins; the built-in default is the fallback so a
      // partially-provisioned society is still usable.
      const roleDoc = roleDocs.find((r) => r.role === role);
      const grants: string[] = roleDoc?.permissions?.length
        ? roleDoc.permissions
        : (DEFAULT_ROLE_PERMISSIONS[role as keyof typeof DEFAULT_ROLE_PERMISSIONS] ?? []);
      for (const p of expandPermissions(grants)) permissions.add(p);
      for (const p of expandPermissions(roleDoc?.revokedPermissions ?? [])) permissions.delete(p);
    }

    const unitIds = Array.from(new Set(unitMembers.map((m) => String(m.unitId)).filter(Boolean)));
    const primaryMember = unitMembers.find((m) => m.isPrimary) ?? unitMembers[0];
    const staffDoc = staffDocs[0] ?? null;
    const gateIds = Array.from(new Set(guardAssignments.map((g) => String(g.gateId)).filter(Boolean)));

    const familyMember = residents?.kind === 'FAMILY' ? residents : null;
    const familyPermissions = familyMember ? (unitMembers.find((m) => m.residentId === familyMember._id)?.permissions as Record<string, boolean> | undefined) : undefined;

    const membership: MembershipContext = {
      unitIds,
      primaryUnitId: primaryMember?.unitId ? String(primaryMember.unitId) : null,
      residentId: residents?._id ? String(residents._id) : null,
      staffId: staffDoc?._id ? String(staffDoc._id) : null,
      vendorId: staffDoc?.vendorId ? String(staffDoc.vendorId) : null,
      familyMemberId: familyMember?._id ? String(familyMember._id) : null,
      familyPermissions,
      gateIds,
    };

    return {
      roles: userRoles,
      permissions,
      membership,
      enabledModules: new Set<string>(subscription?.modules ?? []),
    };
  }, 30_000);
}

/* -------------------------------- middleware ------------------------------- */

export interface AuthenticateOptions {
  /** Attach context when a token is present but continue unauthenticated when absent. */
  optional?: boolean;
  /** Allow platform-scope tokens (super-admin console). */
  allowPlatform?: boolean;
  /** Allow tenant-scope tokens (society console + mobile apps). */
  allowTenant?: boolean;
  /** Restrict to specific client scopes (resident app vs security app). */
  clientScopes?: Array<'resident' | 'security' | 'staff' | 'vendor' | 'console'>;
}

export function authenticate(options: AuthenticateOptions = {}) {
  const { optional = false, allowPlatform = true, allowTenant = true, clientScopes } = options;

  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const requestId = String(req.headers['x-request-id'] ?? (req as Request & { id?: string }).id ?? crypto.randomUUID());
      const startedAt = Date.now();
      const ip = (req.ip ?? req.socket?.remoteAddress ?? '').toString();
      const userAgent = String(req.headers['user-agent'] ?? '');
      const platform = detectPlatform(req);
      const appVersion = String(req.headers['x-app-version'] ?? '') || undefined;

      const token = extractToken(req);
      if (!token) {
        if (optional) return next();
        throw ApiError.unauthenticated('Authentication required. Please sign in.');
      }

      const claims = verifyAccessToken(token);
      const platformDatabase = await databases.platform();

      /* ------------------------------- platform ------------------------------- */
      if (claims.scope === 'platform') {
        if (!allowPlatform) throw ApiError.forbidden('Platform tokens are not accepted here');
        const userDoc = await platformDatabase.collection('platform_users').findById(claims.sub);
        if (!userDoc) throw ApiError.unauthenticated('Account no longer exists', 'TOKEN_INVALID');
        if (userDoc.status !== 'ACTIVE') {
          throw new ApiError('This account is not active. Contact your platform administrator.', 'ACCOUNT_INACTIVE');
        }

        const roles: string[] = Array.isArray(userDoc.roles) ? userDoc.roles : [];
        const permissions = new Set<string>();
        for (const role of roles) {
          for (const p of expandPermissions(DEFAULT_ROLE_PERMISSIONS[role as keyof typeof DEFAULT_ROLE_PERMISSIONS] ?? [])) {
            permissions.add(p);
          }
        }
        // The super admin can always reach every platform capability.
        if (roles.includes('SUPER_ADMIN')) permissions.add('*');

        const principal: PrincipalContext = {
          userId: String(userDoc._id),
          fullName: String(userDoc.fullName ?? ''),
          email: userDoc.email ? String(userDoc.email) : null,
          phone: userDoc.phone ? String(userDoc.phone) : null,
          avatarUrl: userDoc.avatarUrl ? String(userDoc.avatarUrl) : null,
          roles,
          permissions,
          scope: 'platform',
          sessionId: claims.sid ?? null,
          deviceId: String(req.headers['x-device-id'] ?? '') || null,
          isPlatformUser: true,
          isResidentScope: false,
          isSecurityScope: false,
          isVendorScope: false,
          isStaffScope: false,
          userDoc,
        };

        // Platform users may act *into* a society when the request says which one
        // (`x-society-id`). This is how super admin manages a tenant without impersonation.
        let societyCtx: SocietyContext | null = null;
        let tenantDb = null;
        let membership: MembershipContext = emptyMembership();
        let enabledModules = new Set<string>();

        const targetSocietyId = String(req.headers['x-society-id'] ?? req.query.societyId ?? '');
        if (targetSocietyId) {
          const societyDoc = await loadSocietyById(targetSocietyId);
          if (!societyDoc) throw ApiError.notFound('Society');
          societyCtx = toSocietyContext(societyDoc);
          const handle = await databases.forSociety({
            id: societyDoc._id,
            slug: societyDoc.slug,
            databaseName: societyDoc.databaseName,
          });
          tenantDb = handle.db;
          const subscription = await handle.db.collection('subscriptions').findOne({ societyId: societyDoc._id });
          enabledModules = new Set<string>(subscription?.modules ?? []);
        }

        assertClientScope(clientScopes, principal, 'console');

        req.ctx = {
          requestId,
          ip,
          userAgent,
          platform,
          appVersion,
          principal,
          society: societyCtx,
          membership,
          db: tenantDb,
          platformDatabase,
          enabledModules,
          startedAt,
        };
        return next();
      }

      /* -------------------------------- tenant -------------------------------- */
      if (!allowTenant) throw ApiError.forbidden('Society tokens are not accepted here');
      if (!claims.soc) throw ApiError.unauthenticated('Token is missing its society context', 'TOKEN_INVALID');

      const societyDoc = await loadSocietyById(claims.soc);
      if (!societyDoc) throw ApiError.unauthenticated('Society no longer exists', 'TOKEN_INVALID');
      if (societyDoc.status !== 'ACTIVE' && societyDoc.status !== 'ONBOARDING') {
        throw new ApiError(
          `This society is ${societyDoc.status.toLowerCase()}. Please contact support.`,
          'SUBSCRIPTION_INACTIVE',
        );
      }

      const handle = await databases.forSociety({
        id: societyDoc._id,
        slug: societyDoc.slug,
        databaseName: societyDoc.databaseName,
      });
      const db = handle.db;

      const userDoc = await db.collection('users').findById(claims.sub);
      if (!userDoc) throw ApiError.unauthenticated('Account no longer exists', 'TOKEN_INVALID');
      if (userDoc.status !== 'ACTIVE') {
        throw new ApiError(
          userDoc.status === 'LOCKED'
            ? 'This account is temporarily locked. Try again later.'
            : 'This account is not active. Contact your society administrator.',
          userDoc.status === 'LOCKED' ? 'ACCOUNT_LOCKED' : 'ACCOUNT_INACTIVE',
        );
      }
      if (userDoc.lockedUntil && new Date(userDoc.lockedUntil).getTime() > Date.now()) {
        throw new ApiError('This account is temporarily locked due to repeated failed sign-ins.', 'ACCOUNT_LOCKED');
      }

      const roles: string[] = Array.isArray(userDoc.roles) ? userDoc.roles : [];
      if (roles.length === 0) throw ApiError.forbidden('This account has no role assigned in this society');

      const resolved = await resolveTenantAuth(db, societyDoc._id, String(userDoc._id), roles);
      const principal: PrincipalContext = {
        userId: String(userDoc._id),
        fullName: String(userDoc.fullName ?? ''),
        email: userDoc.email ? String(userDoc.email) : null,
        phone: userDoc.phone ? String(userDoc.phone) : null,
        avatarUrl: userDoc.avatarUrl ? String(userDoc.avatarUrl) : null,
        roles,
        permissions: resolved.permissions,
        scope: 'tenant',
        sessionId: claims.sid ?? null,
        deviceId: String(req.headers['x-device-id'] ?? '') || null,
        isPlatformUser: false,
        isResidentScope: roles.some((r) => (RESIDENT_APP_ROLES as readonly string[]).includes(r)),
        isSecurityScope: roles.some((r) => (SECURITY_APP_ROLES as readonly string[]).includes(r)),
        isVendorScope: roles.some((r) => (Object.values(VENDOR_ROLES) as string[]).includes(r)),
        isStaffScope: roles.some((r) => (Object.values(STAFF_ROLES) as string[]).includes(r)),
        userDoc,
      };

      assertClientScope(clientScopes, principal, platform);

      const subscription = await db.collection('subscriptions').findOne({ societyId: societyDoc._id });
      const enabledModules = new Set<string>(subscription?.modules ?? resolved.enabledModules);

      req.ctx = {
        requestId,
        ip,
        userAgent,
        platform,
        appVersion,
        principal,
        society: toSocietyContext(societyDoc),
        membership: resolved.membership,
        db,
        platformDatabase,
        enabledModules,
        startedAt,
      };
      return next();
    } catch (err) {
      next(err);
    }
  };
}

function emptyMembership(): MembershipContext {
  return {
    unitIds: [],
    primaryUnitId: null,
    residentId: null,
    staffId: null,
    vendorId: null,
    familyMemberId: null,
    gateIds: [],
  };
}

/**
 * Enforce that a token is being used by the right *client*.
 * A resident must not be able to drive the security app with a resident token, and vice versa.
 */
function assertClientScope(
  clientScopes: AuthenticateOptions['clientScopes'],
  principal: PrincipalContext,
  platform: string,
): void {
  if (!clientScopes || clientScopes.length === 0) return;
  const matched = clientScopes.some((scope) => {
    switch (scope) {
      case 'console':
        return !principal.isResidentScope && !principal.isSecurityScope;
      case 'resident':
        return principal.isResidentScope;
      case 'security':
        return principal.isSecurityScope;
      case 'staff':
        return principal.isStaffScope;
      case 'vendor':
        return principal.isVendorScope;
      default:
        return false;
    }
  });
  if (!matched) {
    throw ApiError.forbidden(
      `This account cannot use the ${clientScopes.join('/')} client${platform === 'web' ? ' from the web' : ''}.`,
    );
  }
}

/** Fail if `authenticate` was not run (or was optional and no token was supplied). */
export function requireContext(req: Request): RequestContext {
  if (!req.ctx) throw ApiError.unauthenticated('Authentication required');
  return req.ctx;
}

/** Require a resolved society + tenant database (blocks platform-only tokens). */
export function requireTenantContext(req: Request): RequestContext & { society: SocietyContext; db: TenantDatabase } {
  const ctx = requireContext(req);
  if (!ctx.society || !ctx.db) {
    throw ApiError.forbidden('A society context is required for this operation', 'TENANT_MISMATCH');
  }
  return ctx as RequestContext & { society: SocietyContext; db: import('../db/drivers/types.js').TenantDatabase };
}

/**
 * Platform-console guard.
 *
 * Rejects society tokens outright: a resident, guard or society administrator can never reach
 * /api/platform/* even with a valid, unexpired token.
 */
export function authenticatePlatform(options: Omit<AuthenticateOptions, 'allowPlatform' | 'allowTenant'> = {}) {
  return authenticate({ ...options, allowPlatform: true, allowTenant: false, clientScopes: ['console'] });
}

/** Require a platform principal (super-admin / support / finance console). */
export function requirePlatformContext(req: Request): RequestContext & { platformDatabase: TenantDatabase } {
  const ctx = requireContext(req);
  if (!ctx.principal.isPlatformUser) {
    throw ApiError.forbidden('This endpoint is restricted to platform administrators');
  }
  return ctx as RequestContext & { platformDatabase: TenantDatabase };
}
