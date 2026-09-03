import type { Request } from 'express';
import { formatPersonName, normalisePhone, type AuthenticatedUser, type DeviceInfo, type LoginResult, type Role, type SocietyMembership } from '@colonize/shared';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { databases } from '../../db/manager.js';
import { newId, secureToken } from '../../db/ids.js';
import { ApiError } from '../../utils/errors.js';
import { hashPassword, hashSecret, verifyPassword } from '../../services/crypto.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  newTokenFamily,
  signAccessToken,
  signOneTimeToken,
  signRefreshToken,
  verifyOneTimeToken,
  verifyRefreshToken,
} from '../../services/tokenService.js';
import { AuditService, logSystemAudit } from '../../services/audit.js';
import { invalidateSociety, permissionCache } from '../../services/cache.js';
import { findByIdentifier, upsertMembership, type DirectoryMembership } from '../../services/identityDirectory.js';
import { NotificationService } from '../../services/notifications/index.js';
import type { Document, TenantDatabase } from '../../db/drivers/types.js';
import type { RequestContext } from '../../middleware/context.js';
import { verifyOtp, maskMobile } from './otpService.js';

/**
 * Authentication service (§7).
 *
 * Multi-society aware: one phone number can be an owner in society A and a committee member
 * in society B. Login therefore resolves *memberships* first, and only then issues tokens
 * scoped to exactly one society. A token can never span two tenants.
 */

export interface LoginDeviceInfo extends DeviceInfo {
  ip?: string;
  userAgent?: string;
}

interface ResolvedMembership extends DirectoryMembership {
  databaseName: string;
}

/* ------------------------------ membership lookup -------------------------- */

async function resolveMemberships(identifier: string): Promise<ResolvedMembership[]> {
  const entry = await findByIdentifier(identifier);
  if (!entry) return [];
  if (entry.isBlocked) {
    throw new ApiError('This account has been blocked. Please contact support.', 'ACCOUNT_LOCKED');
  }

  const platform = await databases.platform();
  const societyIds = Array.from(new Set((entry.memberships ?? []).map((m) => m.societyId)));
  if (societyIds.length === 0) return [];

  const societies = await platform.collection('societies').find({ _id: { $in: societyIds } }, { limit: societyIds.length });
  const byId = new Map(societies.map((s) => [String(s._id), s]));

  return (entry.memberships ?? [])
    .map((m) => {
      const society = byId.get(m.societyId);
      if (!society) return null;
      if (society.status !== 'ACTIVE' && society.status !== 'ONBOARDING') return null;
      return {
        ...m,
        societyName: String(society.name),
        societySlug: String(society.slug),
        databaseName: String(society.databaseName),
      } as ResolvedMembership;
    })
    .filter((m): m is ResolvedMembership => Boolean(m) && m!.isActive);
}

async function tenantFor(membership: ResolvedMembership): Promise<TenantDatabase> {
  const handle = await databases.forSociety({
    id: membership.societyId,
    slug: membership.societySlug,
    databaseName: membership.databaseName,
  });
  return handle.db;
}

/* --------------------------------- sessions -------------------------------- */

export interface IssueSessionInput {
  db: TenantDatabase;
  societyId: string;
  user: Document;
  device: LoginDeviceInfo;
  platform?: 'ios' | 'android' | 'web' | 'unknown';
  loginMethod: 'OTP' | 'PASSWORD' | 'REFRESH' | 'PLATFORM';
  isPlatformUser?: boolean;
}

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  sessionId: string;
}

export async function issueSession(input: IssueSessionInput): Promise<IssuedSession> {
  const { db, societyId, user, device } = input;
  const userId = String(user._id);
  const roles: string[] = Array.isArray(user.roles) ? (user.roles as string[]) : [];

  const collectionName = input.isPlatformUser ? 'platform_sessions' : 'sessions';
  const sessions = db.collection(collectionName);

  /* ---- enforce a bound on concurrent devices (§7 device management) ---- */
  const active = await sessions.countDocuments(
    input.isPlatformUser ? { userId, isActive: true } : { societyId, userId, isActive: true },
  );
  if (active >= env.SESSION_MAX_ACTIVE_DEVICES) {
    // Retire the least recently used session rather than locking the user out.
    const oldest = await sessions.find(
      input.isPlatformUser ? { userId, isActive: true } : { societyId, userId, isActive: true },
      { sort: { lastUsedAt: 1 }, limit: active - env.SESSION_MAX_ACTIVE_DEVICES + 1 },
    );
    if (oldest.length > 0) {
      await sessions.updateMany(
        { _id: { $in: oldest.map((o) => String(o._id)) } },
        { $set: { isActive: false, revokedAt: new Date(), revokeReason: 'DEVICE_LIMIT_REACHED' } },
      );
    }
  }

  /* ---- reuse the session for this device when one exists ---- */
  const deviceId = device.deviceId ?? device.ip ?? 'unknown';
  const existing = await sessions.findOne(
    input.isPlatformUser
      ? { userId, deviceId, isActive: true }
      : { societyId, userId, deviceId, isActive: true },
    { sort: { lastUsedAt: -1 }, limit: 1 },
  );

  const sessionId = existing ? String(existing._id) : newId(collectionName);
  const family = existing?.tokenFamily ? String(existing.tokenFamily) : newTokenFamily();
  const refreshToken = signRefreshToken({
    sub: userId,
    scope: input.isPlatformUser ? 'platform' : 'tenant',
    ...(input.isPlatformUser ? {} : { soc: societyId }),
    sid: sessionId,
    fam: family,
    jti: secureToken(12),
  });

  const sessionDoc: Document = {
    refreshTokenHash: hashSecret(refreshToken),
    tokenFamily: family,
    deviceId,
    deviceName: device.model ?? device.platform ?? 'Unknown device',
    platform: device.platform ?? 'unknown',
    appVersion: device.appVersion ?? null,
    osVersion: device.osVersion ?? null,
    model: device.model ?? null,
    pushToken: device.pushToken ?? null,
    userAgent: device.userAgent ?? null,
    ip: device.ip ?? null,
    lastUsedAt: new Date(),
    lastUsedIp: device.ip ?? null,
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000),
    isActive: true,
  };

  if (existing) {
    await sessions.updateOne({ _id: sessionId }, { $set: sessionDoc });
  } else {
    await sessions.create({
      _id: sessionId,
      ...(input.isPlatformUser ? {} : { societyId }),
      userId,
      ...sessionDoc,
    });
  }

  /* ---- keep push tokens registered for delivery ---- */
  if (device.pushToken && !input.isPlatformUser) {
    await db.collection('push_tokens').updateOne(
      { societyId, token: device.pushToken },
      {
        $set: {
          societyId,
          userId,
          sessionId,
          provider: env.PUSH_PROVIDER === 'expo' ? 'EXPO' : 'FCM',
          platform: device.platform ?? 'android',
          deviceId,
          appVersion: device.appVersion ?? null,
          isActive: true,
          lastUsedAt: new Date(),
          failureCount: 0,
        },
        $setOnInsert: { _id: newId('push_tokens') },
      },
      { upsert: true },
    );
  }

  const accessToken = signAccessToken({
    sub: userId,
    scope: input.isPlatformUser ? 'platform' : 'tenant',
    ...(input.isPlatformUser ? {} : { soc: societyId }),
    sid: sessionId,
    rol: roles,
  });

  return {
    accessToken,
    refreshToken,
    tokenType: 'Bearer',
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    sessionId,
  };
}

/* ------------------------------ profile mapping ---------------------------- */

export async function buildAuthenticatedUser(
  db: TenantDatabase,
  societyId: string,
  user: Document,
  memberships: ResolvedMembership[],
  isPlatformUser = false,
): Promise<AuthenticatedUser> {
  const roles: string[] = Array.isArray(user.roles) ? (user.roles as string[]) : [];
  const permissions = await permissionsFor(db, societyId, roles, isPlatformUser);

  const societyMemberships: SocietyMembership[] = memberships.map((m) => ({
    societyId: m.societyId,
    societyName: m.societyName,
    societySlug: m.societySlug,
    roles: (m.roles ?? []) as Role[],
    unitIds: m.unitIds ?? [],
    primaryUnitId: (m.unitIds ?? [])[0] ?? null,
    isActive: m.isActive,
  }));

  return {
    id: String(user._id),
    email: user.email ? String(user.email) : null,
    phone: user.phone ? String(user.phone) : null,
    fullName: String(user.fullName ?? ''),
    roles: roles as Role[],
    permissions: Array.from(permissions),
    memberships: societyMemberships,
    isPlatformUser,
    avatarUrl: user.avatarUrl ? String(user.avatarUrl) : null,
    status: String(user.status ?? 'ACTIVE'),
    preferredSocietyId: societyId,
  };
}

export async function permissionsFor(
  db: TenantDatabase,
  societyId: string,
  roles: string[],
  isPlatformUser: boolean,
): Promise<Set<string>> {
  if (isPlatformUser) {
    const { expandPermissions, DEFAULT_ROLE_PERMISSIONS } = await import('@colonize/shared');
    const out = new Set<string>();
    for (const role of roles) {
      for (const p of expandPermissions(DEFAULT_ROLE_PERMISSIONS[role as keyof typeof DEFAULT_ROLE_PERMISSIONS] ?? [])) out.add(p);
    }
    if (roles.includes('SUPER_ADMIN')) out.add('*');
    return out;
  }
  return permissionCache.wrap<Set<string>>(`perm-set:${societyId}:${roles.sort().join(',')}`, async () => {
    const { expandPermissions, DEFAULT_ROLE_PERMISSIONS } = await import('@colonize/shared');
    const roleDocs = await db.collection('roles').find({ societyId, role: { $in: roles } });
    const out = new Set<string>();
    for (const role of roles) {
      const doc = roleDocs.find((r) => r.role === role);
      const grants: string[] = doc?.permissions?.length
        ? (doc.permissions as string[])
        : (DEFAULT_ROLE_PERMISSIONS[role as keyof typeof DEFAULT_ROLE_PERMISSIONS] ?? []);
      for (const p of expandPermissions(grants)) out.add(p);
      for (const p of expandPermissions((doc?.revokedPermissions as string[]) ?? [])) out.delete(p);
    }
    return out;
  }, 30_000);
}

/* ---------------------------------- logins --------------------------------- */

export interface OtpLoginInput {
  phone: string;
  otp: string;
  purpose: 'LOGIN' | 'PASSWORD_RESET' | 'PHONE_VERIFY' | 'STEP_UP';
  device: LoginDeviceInfo;
}

export type LoginOutcome =
  | { kind: 'success'; result: LoginResult }
  | { kind: 'selection'; selectionToken: string; memberships: Array<{ societyId: string; societyName: string; societySlug: string; roles: string[] }> };

export async function loginWithOtp(input: OtpLoginInput): Promise<LoginOutcome> {
  const phone = normalisePhone(input.phone);
  await verifyOtp({ phone, otp: input.otp, purpose: input.purpose });

  const memberships = await resolveMemberships(phone);
  if (memberships.length === 0) {
    // Deliberately does not reveal whether the number exists in any society.
    throw new ApiError(
      'No society account is linked to this mobile number. Please contact your society administrator.',
      'NOT_FOUND',
    );
  }
  if (memberships.length > 1) return selectionOutcome(phone, memberships, input.device);

  return successOutcome(memberships[0] as ResolvedMembership, input.device, 'OTP');
}

export async function loginWithPassword(
  identifier: string,
  password: string,
  device: LoginDeviceInfo,
): Promise<LoginOutcome> {
  const memberships = await resolveMemberships(identifier);
  if (memberships.length === 0) {
    throw ApiError.unauthenticated('Invalid credentials');
  }

  const verified: ResolvedMembership[] = [];
  for (const membership of memberships) {
    try {
      const db = await tenantFor(membership);
      const user = await db.collection('users').findById(membership.userId);
      if (!user || user.status !== 'ACTIVE') continue;
      if (!user.passwordHash) continue;
      const okPassword = await verifyPassword(password, String(user.passwordHash));
      if (okPassword) verified.push(membership);
    } catch (err) {
      logger.warn({ err: (err as Error).message, societyId: membership.societyId }, 'auth: membership check failed');
    }
  }

  if (verified.length === 0) {
    // Record the failure against the first membership's society for auditing.
    await recordFailedLogin(memberships[0] as ResolvedMembership, identifier);
    throw ApiError.unauthenticated('Invalid credentials');
  }
  if (verified.length > 1) return selectionOutcome(identifier, verified, device);
  return successOutcome(verified[0] as ResolvedMembership, device, 'PASSWORD');
}

/** Platform console login (super admin) — password only, no society selection. */
export async function loginPlatformUser(
  identifier: string,
  password: string,
  device: LoginDeviceInfo,
): Promise<LoginResult> {
  const platform = await databases.platform();
  const users = platform.collection('platform_users');
  const isEmail = identifier.includes('@');
  const user = await users.findOne(isEmail ? { email: identifier.toLowerCase() } : { phone: identifier });

  if (!user || !user.passwordHash) throw ApiError.unauthenticated('Invalid credentials');
  if (user.status !== 'ACTIVE') {
    throw new ApiError('This platform account is not active', 'ACCOUNT_INACTIVE');
  }
  const valid = await verifyPassword(password, String(user.passwordHash));
  if (!valid) {
    await logSystemAudit(platform, {
      societyId: '',
      collection: 'platform_audit_logs',
      action: 'LOGIN_FAILED',
      module: 'auth',
      recordId: String(user._id),
      status: 'FAILURE',
      severity: 'WARNING',
      errorMessage: 'Invalid password',
      actor: { id: String(user._id), name: String(user.fullName), type: 'PLATFORM' },
    });
    throw ApiError.unauthenticated('Invalid credentials');
  }

  const session = await issueSession({
    db: platform,
    societyId: '',
    user,
    device,
    loginMethod: 'PLATFORM',
    isPlatformUser: true,
  });

  await users.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
  await logSystemAudit(platform, {
    societyId: '',
    collection: 'platform_audit_logs',
    action: 'LOGIN',
    module: 'auth',
    recordId: String(user._id),
    actor: { id: String(user._id), name: String(user.fullName), type: 'PLATFORM', roles: user.roles as string[] },
  });

  const authedUser = await buildAuthenticatedUser(platform, '', user, [], true);
  return { ...session, user: authedUser };
}

async function recordFailedLogin(membership: ResolvedMembership, identifier: string): Promise<void> {
  try {
    const db = await tenantFor(membership);
    const user = await db.collection('users').findById(membership.userId);
    if (user) {
      const attempts = Number(user.failedLoginAttempts ?? 0) + 1;
      const lock = attempts >= 5;
      await db.collection('users').updateOne(
        { _id: user._id },
        {
          $set: {
            failedLoginAttempts: attempts,
            ...(lock ? { lockedUntil: new Date(Date.now() + 15 * 60_000), status: 'LOCKED' } : {}),
          },
        },
      );
      if (lock) logger.warn({ userId: String(user._id), identifier: maskMobile(identifier) }, 'auth: account locked after repeated failures');
    }
    await logSystemAudit(db, {
      societyId: membership.societyId,
      action: 'LOGIN_FAILED',
      module: 'auth',
      recordId: membership.userId,
      status: 'FAILURE',
      severity: 'WARNING',
      errorMessage: 'Invalid credentials',
      actor: { id: membership.userId, name: String(user?.fullName ?? ''), type: 'USER', roles: membership.roles },
    });
  } catch (err) {
    logger.debug({ err: (err as Error).message }, 'auth: could not record failed login');
  }
}

function selectionOutcome(identifier: string, memberships: ResolvedMembership[], device: LoginDeviceInfo): LoginOutcome {
  const selectionToken = signOneTimeToken(
    { identifier, device, membershipIds: memberships.map((m) => m.societyId) },
    300,
  );
  return {
    kind: 'selection',
    selectionToken,
    memberships: memberships.map((m) => ({
      societyId: m.societyId,
      societyName: m.societyName,
      societySlug: m.societySlug,
      roles: m.roles,
    })),
  };
}

async function successOutcome(
  membership: ResolvedMembership,
  device: LoginDeviceInfo,
  method: 'OTP' | 'PASSWORD',
): Promise<LoginOutcome> {
  const db = await tenantFor(membership);
  const user = await db.collection('users').findById(membership.userId);
  if (!user) throw ApiError.unauthenticated('Account no longer exists', 'TOKEN_INVALID');
  if (user.status === 'LOCKED' && user.lockedUntil && new Date(user.lockedUntil as string | Date).getTime() > Date.now()) {
    throw new ApiError('This account is temporarily locked. Try again in a few minutes.', 'ACCOUNT_LOCKED');
  }
  if (user.status !== 'ACTIVE') {
    throw new ApiError('This account is not active. Contact your society administrator.', 'ACCOUNT_INACTIVE');
  }

  const session = await issueSession({ db, societyId: membership.societyId, user, device, loginMethod: method });

  await db.collection('users').updateOne(
    { _id: user._id },
    { $set: { lastLoginAt: new Date(), lastLoginIp: device.ip ?? null, failedLoginAttempts: 0, ...(user.status === 'LOCKED' ? { status: 'ACTIVE', lockedUntil: null } : {}) } },
  );

  await logSystemAudit(db, {
    societyId: membership.societyId,
    action: method === 'OTP' ? 'OTP_VERIFIED' : 'LOGIN',
    module: 'auth',
    recordId: String(user._id),
    actor: { id: String(user._id), name: String(user.fullName), type: 'USER', roles: membership.roles },
  });

  // Rebuild the directory entry so role/unit changes elsewhere are reflected at next login.
  await upsertMembership({
    societyId: membership.societyId,
    societyName: membership.societyName,
    societySlug: membership.societySlug,
    userId: String(user._id),
    phone: user.phone ? String(user.phone) : null,
    email: user.email ? String(user.email) : null,
    roles: Array.isArray(user.roles) ? (user.roles as string[]) : [],
    unitIds: Array.isArray(user.unitIds) ? (user.unitIds as string[]) : membership.unitIds,
    status: String(user.status),
    isActive: true,
  });

  const allMemberships = await resolveMemberships(String(user.phone ?? membership.societyId));
  const authedUser = await buildAuthenticatedUser(db, membership.societyId, user, allMemberships);

  // Non-blocking welcome-back notification for a new device.
  void NotificationService.send({
    db,
    societyId: membership.societyId,
    type: 'DEVICE_LOGIN',
    userIds: [String(user._id)],
    data: { platform: device.platform ?? 'unknown', time: new Date().toISOString() },
    transient: true,
  }).catch(() => undefined);

  return {
    kind: 'success',
    result: {
      ...session,
      user: authedUser,
      requiresSocietySelection: false,
    },
  };
}

/** Step 2 of a multi-society login. */
export async function completeSocietySelection(
  selectionToken: string,
  societyId: string,
  device: LoginDeviceInfo,
): Promise<LoginResult> {
  const payload = verifyOneTimeToken<{ identifier: string; device: LoginDeviceInfo; membershipIds: string[] }>(selectionToken);
  if (!payload.membershipIds?.includes(societyId)) {
    throw ApiError.forbidden('That society is not linked to this sign-in');
  }
  const memberships = await resolveMemberships(payload.identifier);
  const chosen = memberships.find((m) => m.societyId === societyId);
  if (!chosen) throw ApiError.notFound('Society membership');

  const outcome = await successOutcome(chosen, { ...device, ...(payload.device ?? {}) }, 'OTP');
  if (outcome.kind !== 'success') throw ApiError.badRequest('Please complete sign-in again');
  return outcome.result;
}

/* --------------------------------- refresh --------------------------------- */

export async function refreshTokens(
  refreshToken: string,
  device: LoginDeviceInfo,
): Promise<{ tokens: LoginResult; rotatedRefreshToken: string }> {
  const claims = verifyRefreshToken(refreshToken);
  const incomingHash = hashSecret(refreshToken);

  if (claims.scope === 'platform') {
    const platform = await databases.platform();
    const sessions = platform.collection('platform_sessions');
    const stored = await sessions.findOne({ refreshTokenHash: incomingHash });
    if (!stored) {
      // A hash we have never issued, or one already rotated away → treat as theft and kill
      // the whole family so the attacker's token stops working too.
      const family = claims.fam;
      if (family) {
        await sessions.updateMany(
          { tokenFamily: family, isActive: true },
          { $set: { isActive: false, revokedAt: new Date(), revokeReason: 'TOKEN_REUSE_DETECTED' } },
        );
      }
      throw ApiError.unauthenticated('Session is no longer valid. Please sign in again.', 'TOKEN_REUSED');
    }
    if (!stored.isActive || new Date(stored.expiresAt as string | Date).getTime() < Date.now()) {
      throw ApiError.unauthenticated('Session expired. Please sign in again.', 'TOKEN_EXPIRED');
    }
    const user = await platform.collection('platform_users').findById(claims.sub);
    if (!user || user.status !== 'ACTIVE') throw ApiError.unauthenticated('Account is not active', 'ACCOUNT_INACTIVE');

    const session = await issueSession({ db: platform, societyId: '', user, device, loginMethod: 'PLATFORM', isPlatformUser: true });
    await sessions.updateOne({ _id: stored._id }, { $set: { isActive: false, revokedAt: new Date(), revokeReason: 'ROTATED' } });
    const authedUser = await buildAuthenticatedUser(platform, '', user, [], true);
    return { tokens: { ...session, user: authedUser }, rotatedRefreshToken: session.refreshToken };
  }

  if (!claims.soc) throw ApiError.unauthenticated('Token is missing its society context', 'TOKEN_INVALID');

  const platform = await databases.platform();
  const society = await platform.collection('societies').findById(claims.soc);
  if (!society) throw ApiError.unauthenticated('Society no longer exists', 'TOKEN_INVALID');
  if (society.status !== 'ACTIVE' && society.status !== 'ONBOARDING') {
    throw new ApiError('This society is not active', 'SUBSCRIPTION_INACTIVE');
  }

  const handle = await databases.forSociety({
    id: String(society._id),
    slug: String(society.slug),
    databaseName: String(society.databaseName),
  });
  const db = handle.db;
  const sessions = db.collection('sessions');
  const stored = await sessions.findOne({ societyId: String(society._id), refreshTokenHash: incomingHash });

  if (!stored) {
    // Refresh-token reuse detection: revoke every session in the family.
    if (claims.fam) {
      await sessions.updateMany(
        { societyId: String(society._id), tokenFamily: claims.fam, isActive: true },
        { $set: { isActive: false, revokedAt: new Date(), revokeReason: 'TOKEN_REUSE_DETECTED' } },
      );
    }
    await logSystemAudit(db, {
      societyId: String(society._id),
      action: 'TOKEN_REVOKED',
      module: 'auth',
      recordId: claims.sid,
      status: 'FAILURE',
      severity: 'CRITICAL',
      errorMessage: 'Refresh token reuse detected — session family revoked',
      actor: { id: claims.sub, type: 'USER' },
    });
    throw ApiError.unauthenticated('This session was reused and has been signed out everywhere. Please sign in again.', 'TOKEN_REUSED');
  }

  if (!stored.isActive) throw ApiError.unauthenticated('This session has been signed out', 'TOKEN_INVALID');
  if (new Date(stored.expiresAt as string | Date).getTime() < Date.now()) {
    throw ApiError.unauthenticated('Session expired. Please sign in again.', 'TOKEN_EXPIRED');
  }

  const user = await db.collection('users').findById(claims.sub);
  if (!user || user.status !== 'ACTIVE') throw ApiError.unauthenticated('Account is not active', 'ACCOUNT_INACTIVE');

  const session = await issueSession({
    db,
    societyId: String(society._id),
    user,
    device,
    loginMethod: 'REFRESH',
  });
  await sessions.updateOne(
    { _id: stored._id },
    { $set: { isActive: false, revokedAt: new Date(), revokeReason: 'ROTATED' } },
  );
  await logSystemAudit(db, {
    societyId: String(society._id),
    action: 'TOKEN_REFRESHED',
    module: 'auth',
    recordId: String(user._id),
    actor: { id: String(user._id), name: String(user.fullName), type: 'USER', roles: user.roles as string[] },
  });

  const memberships = user.phone ? await resolveMemberships(String(user.phone)) : [];
  const authedUser = await buildAuthenticatedUser(db, String(society._id), user, memberships);
  return { tokens: { ...session, user: authedUser }, rotatedRefreshToken: session.refreshToken };
}

/* --------------------------------- logout ---------------------------------- */

export async function logout(ctx: RequestContext, opts: { allDevices: boolean; refreshToken?: string }): Promise<{ revoked: number }> {
  const { db, society, principal } = ctx;
  if (!db) return { revoked: 0 };
  const collectionName = principal.isPlatformUser ? 'platform_sessions' : 'sessions';
  const sessions = db.collection(collectionName);

  const filter: Document = principal.isPlatformUser
    ? { userId: principal.userId, isActive: true }
    : { societyId: society?.id, userId: principal.userId, isActive: true };

  let revoked = 0;
  if (opts.allDevices) {
    const res = await sessions.updateMany(filter, {
      $set: { isActive: false, revokedAt: new Date(), revokeReason: 'USER_LOGOUT_ALL' },
    });
    revoked = res.modified;
  } else if (principal.sessionId) {
    const res = await sessions.updateOne(
      { ...filter, _id: principal.sessionId },
      { $set: { isActive: false, revokedAt: new Date(), revokeReason: 'USER_LOGOUT' } },
    );
    revoked = res.modified;
  } else if (opts.refreshToken) {
    const res = await sessions.updateOne(
      { ...filter, refreshTokenHash: hashSecret(opts.refreshToken) },
      { $set: { isActive: false, revokedAt: new Date(), revokeReason: 'USER_LOGOUT' } },
    );
    revoked = res.modified;
  }

  await new AuditService(ctx).log({ action: 'LOGOUT', module: 'auth', recordId: principal.userId });
  permissionCache.invalidatePrefix(`perm:${society?.id ?? ''}:${principal.userId}`);
  return { revoked };
}

/* ------------------------------ session listing ---------------------------- */

export async function listSessions(ctx: RequestContext): Promise<Document[]> {
  const { db, society, principal } = ctx;
  if (!db) return [];
  const collectionName = principal.isPlatformUser ? 'platform_sessions' : 'sessions';
  const filter: Document = principal.isPlatformUser
    ? { userId: principal.userId }
    : { societyId: society?.id, userId: principal.userId };
  const sessions = await db.collection(collectionName).find(filter, { sort: { lastUsedAt: -1 }, limit: 50 });
  return sessions.map((s) => ({
    id: String(s._id),
    deviceId: s.deviceId,
    deviceName: s.deviceName,
    platform: s.platform,
    appVersion: s.appVersion,
    osVersion: s.osVersion,
    model: s.model,
    ip: s.ip,
    lastUsedAt: s.lastUsedAt,
    lastUsedIp: s.lastUsedIp,
    expiresAt: s.expiresAt,
    isActive: s.isActive,
    revokedReason: s.revokeReason,
    isCurrent: String(s._id) === principal.sessionId,
  }));
}

export async function revokeSession(ctx: RequestContext, sessionId: string): Promise<void> {
  const { db, society, principal } = ctx;
  if (!db) throw ApiError.forbidden('No society context');
  const collectionName = principal.isPlatformUser ? 'platform_sessions' : 'sessions';
  const filter: Document = principal.isPlatformUser
    ? { _id: sessionId, userId: principal.userId }
    : { societyId: society?.id, _id: sessionId, userId: principal.userId };
  const res = await db.collection(collectionName).updateOne(filter, {
    $set: { isActive: false, revokedAt: new Date(), revokeReason: 'REVOKED_BY_USER' },
  });
  if (res.matched === 0) throw ApiError.notFound('Session');
  await new AuditService(ctx).log({ action: 'TOKEN_REVOKED', module: 'auth', recordId: sessionId, severity: 'NOTICE' });
}

/* ------------------------------- passwords --------------------------------- */

export async function changePassword(ctx: RequestContext, currentPassword: string, newPassword: string, device: LoginDeviceInfo): Promise<void> {
  const { db, society, principal } = ctx;
  if (!db) throw ApiError.forbidden('No society context');
  const collectionName = principal.isPlatformUser ? 'platform_users' : 'users';
  const users = db.collection(collectionName);
  const user = await users.findById(principal.userId);
  if (!user) throw ApiError.notFound('Account');

  if (user.passwordHash) {
    const valid = await verifyPassword(currentPassword, String(user.passwordHash));
    if (!valid) {
      await new AuditService(ctx).security('PASSWORD_CHANGE_FAILED', 'auth', { reason: 'current password mismatch' });
      throw ApiError.badRequest('Your current password is incorrect');
    }
  } else if (currentPassword) {
    throw ApiError.badRequest('This account signs in with an OTP. Set a password from the profile screen.');
  }

  const passwordHash = await hashPassword(newPassword);
  await users.updateOne({ _id: user._id }, { $set: { passwordHash, mustChangePassword: false } });

  // Every other session is signed out — a password change is a security boundary.
  const sessions = db.collection(principal.isPlatformUser ? 'platform_sessions' : 'sessions');
  const sessionFilter: Document = principal.isPlatformUser
    ? { userId: principal.userId, isActive: true }
    : { societyId: society?.id, userId: principal.userId, isActive: true };
  await sessions.updateMany(
    { ...sessionFilter, _id: { $ne: principal.sessionId } },
    { $set: { isActive: false, revokedAt: new Date(), revokeReason: 'PASSWORD_CHANGED' } },
  );

  await new AuditService(ctx).log({ action: 'PASSWORD_CHANGED', module: 'auth', recordId: principal.userId, severity: 'NOTICE' });

  if (society) {
    void NotificationService.send({
      db,
      societyId: society.id,
      type: 'PASSWORD_CHANGED',
      userIds: [principal.userId],
      data: { device: device.model ?? device.platform ?? 'your device' },
    }).catch(() => undefined);
  }
}

export async function setPassword(ctx: RequestContext, newPassword: string): Promise<void> {
  const { db, principal } = ctx;
  if (!db) throw ApiError.forbidden('No society context');
  const collectionName = principal.isPlatformUser ? 'platform_users' : 'users';
  await db.collection(collectionName).updateOne(
    { _id: principal.userId },
    { $set: { passwordHash: await hashPassword(newPassword), mustChangePassword: false } },
  );
  await new AuditService(ctx).log({ action: 'PASSWORD_CHANGED', module: 'auth', recordId: principal.userId, severity: 'NOTICE' });
}

export interface ResetFlowResult {
  selectionToken?: string;
  memberships?: Array<{ societyId: string; societyName: string }>;
  resetToken?: string;
  expiresInSeconds: number;
}

/**
 * Forgot-password step 1: verify the person exists and issue a short-lived reset token.
 * The response is deliberately identical whether or not the identifier exists, so the
 * endpoint cannot be used to enumerate residents.
 */
export async function requestPasswordReset(identifier: string): Promise<ResetFlowResult> {
  const memberships = await resolveMemberships(identifier);
  if (memberships.length === 0) return { expiresInSeconds: 900 };

  if (memberships.length > 1) {
    return {
      expiresInSeconds: 900,
      selectionToken: signOneTimeToken({ identifier, purpose: 'PASSWORD_RESET', membershipIds: memberships.map((m) => m.societyId) }, 900),
      memberships: memberships.map((m) => ({ societyId: m.societyId, societyName: m.societyName })),
    };
  }

  const membership = memberships[0] as ResolvedMembership;
  const db = await tenantFor(membership);
  const user = await db.collection('users').findById(membership.userId);
  if (!user) return { expiresInSeconds: 900 };

  const resetToken = signOneTimeToken(
    { sub: membership.userId, soc: membership.societyId, purpose: 'PASSWORD_RESET' },
    900,
  );
  await db.collection('users').updateOne(
    { _id: user._id },
    { $set: { invitationTokenHash: hashSecret(resetToken) } },
  );
  await logSystemAudit(db, {
    societyId: membership.societyId,
    action: 'OTP_SENT',
    module: 'auth',
    recordId: membership.userId,
    severity: 'NOTICE',
    actor: { id: membership.userId, name: String(user.fullName), type: 'USER' },
  });

  return { resetToken, expiresInSeconds: 900 };
}

export async function resetPasswordWithToken(resetToken: string, newPassword: string): Promise<void> {
  const payload = verifyOneTimeToken<{ sub: string; soc: string; purpose: string }>(resetToken);
  if (payload.purpose !== 'PASSWORD_RESET') throw ApiError.badRequest('This reset link is not valid');

  const platform = await databases.platform();
  const society = await platform.collection('societies').findById(payload.soc);
  if (!society) throw ApiError.notFound('Society');
  const handle = await databases.forSociety({
    id: String(society._id),
    slug: String(society.slug),
    databaseName: String(society.databaseName),
  });
  const db = handle.db;

  const user = await db.collection('users').findById(payload.sub);
  if (!user) throw ApiError.notFound('Account');
  // The stored hash binds the token to this account: a token cannot be replayed after use.
  if (!user.invitationTokenHash || user.invitationTokenHash !== hashSecret(resetToken)) {
    throw ApiError.badRequest('This reset link has already been used. Please request a new one.');
  }

  const passwordHash = await hashPassword(newPassword);
  await db.collection('users').updateOne(
    { _id: user._id },
    { $set: { passwordHash, invitationTokenHash: null, mustChangePassword: false, failedLoginAttempts: 0, status: user.status === 'LOCKED' ? 'ACTIVE' : user.status, lockedUntil: null } },
  );
  await db.collection('sessions').updateMany(
    { societyId: String(society._id), userId: user._id, isActive: true },
    { $set: { isActive: false, revokedAt: new Date(), revokeReason: 'PASSWORD_RESET' } },
  );
  await logSystemAudit(db, {
    societyId: String(society._id),
    action: 'PASSWORD_CHANGED',
    module: 'auth',
    recordId: String(user._id),
    severity: 'NOTICE',
    actor: { id: String(user._id), name: String(user.fullName), type: 'USER' },
  });
}

/* ------------------------------- app PIN (§74) ----------------------------- */

export async function setAppPin(ctx: RequestContext, pin: string, enableBiometric: boolean): Promise<void> {
  const { db, principal } = ctx;
  if (!db) throw ApiError.forbidden('No society context');
  await db.collection('users').updateOne(
    { _id: principal.userId },
    { $set: { appPinHash: hashSecret(pin), biometricEnabled: enableBiometric } },
  );
  await new AuditService(ctx).log({ action: 'UPDATE', module: 'auth', recordId: principal.userId, severity: 'NOTICE' });
}

export async function verifyAppPin(ctx: RequestContext, pin: string): Promise<boolean> {
  const { db, principal } = ctx;
  if (!db) return false;
  const user = await db.collection('users').findById(principal.userId);
  if (!user?.appPinHash) return false;
  return hashSecret(pin) === String(user.appPinHash);
}

export async function disableAppPin(ctx: RequestContext, pin: string): Promise<void> {
  const valid = await verifyAppPin(ctx, pin);
  if (!valid) throw ApiError.badRequest('Incorrect PIN');
  const { db, principal } = ctx;
  await db!.collection('users').updateOne({ _id: principal.userId }, { $set: { appPinHash: null, biometricEnabled: false } });
}

/* ------------------------------ push tokens -------------------------------- */

export async function registerPushToken(ctx: RequestContext, token: string, platform: string, deviceId?: string): Promise<void> {
  const { db, society, principal } = ctx;
  if (!db || !society) throw ApiError.forbidden('No society context');
  await db.collection('push_tokens').updateOne(
    { societyId: society.id, token },
    {
      $set: {
        societyId: society.id,
        userId: principal.userId,
        sessionId: principal.sessionId,
        provider: env.PUSH_PROVIDER === 'expo' ? 'EXPO' : 'FCM',
        platform,
        deviceId: deviceId ?? principal.deviceId,
        isActive: true,
        lastUsedAt: new Date(),
        failureCount: 0,
      },
      $setOnInsert: { _id: newId('push_tokens') },
    },
    { upsert: true },
  );
}

export async function unregisterPushToken(ctx: RequestContext, token: string): Promise<void> {
  const { db, society } = ctx;
  if (!db || !society) return;
  await db.collection('push_tokens').updateOne({ societyId: society.id, token }, { $set: { isActive: false } });
}

/* ------------------------------ profile update ----------------------------- */

export async function updateOwnProfile(
  ctx: RequestContext,
  patch: { fullName?: string; email?: string; avatarUrl?: string; gender?: string; dateOfBirth?: Date; preferences?: Document },
): Promise<Document> {
  const { db, society, principal } = ctx;
  if (!db) throw ApiError.forbidden('No society context');

  const update: Document = {};
  if (patch.fullName) update.fullName = formatPersonName(patch.fullName);
  if (patch.email !== undefined) update.email = patch.email ? patch.email.toLowerCase() : null;
  if (patch.avatarUrl !== undefined) update.avatarUrl = patch.avatarUrl;
  if (patch.gender !== undefined) update.gender = patch.gender;
  if (patch.dateOfBirth !== undefined) update.dateOfBirth = patch.dateOfBirth;
  if (patch.preferences) update.preferences = patch.preferences;

  const collectionName = principal.isPlatformUser ? 'platform_users' : 'users';
  const users = db.collection(collectionName);
  const before = await users.findById(principal.userId);
  if (!before) throw ApiError.notFound('Account');

  const after = await users.findOneAndUpdate({ _id: principal.userId }, { $set: update }, { returnDocument: 'after' });
  if (!after) throw ApiError.notFound('Account');

  if (society && (update.fullName || update.email)) {
    // Keep the resident record in sync with the login name so both screens agree.
    if (ctx.membership.residentId) {
      await db.collection('residents').updateOne(
        { societyId: society.id, _id: ctx.membership.residentId },
        { $set: { ...(update.fullName ? { fullName: update.fullName } : {}), ...(update.email !== undefined ? { email: update.email } : {}) } },
      );
    }
    await upsertMembership({
      societyId: society.id,
      societyName: society.name,
      societySlug: society.slug,
      userId: principal.userId,
      phone: after.phone ? String(after.phone) : null,
      email: after.email ? String(after.email) : null,
      roles: Array.isArray(after.roles) ? (after.roles as string[]) : [],
      status: String(after.status ?? 'ACTIVE'),
      isActive: true,
    });
    invalidateSociety(society.id);
  }

  await new AuditService(ctx).updated('auth', before, after);
  return after;
}
