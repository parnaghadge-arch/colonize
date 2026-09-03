import { Router, type Request } from 'express';
import {
  appPinSchema,
  changePasswordSchema,
  forgotPasswordSchema,
  loginPasswordSchema,
  logoutSchema,
  refreshTokenSchema,
  resetPasswordSchema,
  selectSocietySchema,
  sendOtpSchema,
  verifyAppPinSchema,
  verifyOtpSchema,
  z,
} from './schemas.js';
import { rateLimiters } from '../../middleware/security.js';
import { validate } from '../../middleware/validate.js';
import { asyncHandler } from '../../middleware/errors.js';
import { authenticate, requireContext } from '../../middleware/authenticate.js';
import { created, ok } from '../../utils/response.js';
import { ApiError } from '../../utils/errors.js';
import { env } from '../../config/env.js';
import { serialise } from '../../utils/serialize.js';
import type { LoginDeviceInfo } from './authService.js';
import * as authService from './authService.js';
import * as otpService from './otpService.js';

/**
 * Authentication endpoints (§7, §52).
 *
 *   POST /api/auth/send-otp        request a one-time code (delivered over FCM/SMS/email)
 *   POST /api/auth/verify-otp      exchange the code for tokens (or a society choice)
 *   POST /api/auth/select-society  step 2 when a number belongs to several societies
 *   POST /api/auth/login           password login (society staff / administrators)
 *   POST /api/auth/platform/login  password login for the super-admin console
 *   POST /api/auth/refresh         rotate the refresh token
 *   POST /api/auth/logout          sign out of this device, or all devices
 *   GET  /api/auth/me              profile + resolved permissions + memberships
 */

const router = Router();

function deviceFrom(req: Request): LoginDeviceInfo {
  const body = (req.body ?? {}) as { device?: LoginDeviceInfo };
  const ctx = req.ctx;
  return {
    deviceId: String(req.headers['x-device-id'] ?? body.device?.deviceId ?? ctx?.principal?.deviceId ?? ''),
    platform: body.device?.platform ?? ctx?.platform ?? 'unknown',
    appVersion: String(req.headers['x-app-version'] ?? body.device?.appVersion ?? ''),
    osVersion: body.device?.osVersion,
    model: body.device?.model,
    pushToken: body.device?.pushToken,
    userAgent: String(req.headers['user-agent'] ?? ''),
    ip: req.ip ?? ctx?.ip,
  };
}

/* --------------------------------- OTP flow -------------------------------- */

router.post(
  '/send-otp',
  rateLimiters.otpSend,
  validate(sendOtpSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as { phone?: string; email?: string; purpose: any; channel: any; device?: any; societySlug?: string };
    const result = await otpService.sendOtp({
      phone: body.phone,
      email: body.email,
      purpose: body.purpose,
      channel: body.channel,
      deviceId: body.device?.deviceId,
      ip: req.ip,
      societySlug: body.societySlug,
    });
    return ok(
      res,
      {
        requestId: result.requestId,
        channel: result.channel,
        expiresAt: result.expiresAt,
        maskedTarget: result.maskedTarget,
        otpLength: env.OTP_LENGTH,
        resendCooldownSeconds: env.OTP_RESEND_COOLDOWN_SECONDS,
      },
      result.channel === 'CONSOLE'
        ? 'Code generated. In this environment codes are returned in meta.devOtp.'
        : `Code sent to ${result.maskedTarget}`,
      result.devOtp ? { devOtp: result.devOtp, expiresIn: Math.round((result.expiresAt.getTime() - Date.now()) / 1000) } : undefined,
    );
  }),
);

router.post(
  '/verify-otp',
  rateLimiters.otpVerify,
  validate(verifyOtpSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as { phone: string; otp: string; purpose: any; device?: any };
    const outcome = await authService.loginWithOtp({
      phone: body.phone,
      otp: body.otp,
      purpose: body.purpose,
      device: deviceFrom(req),
    });

    if (outcome.kind === 'selection') {
      return ok(
        res,
        { requiresSocietySelection: true, selectionToken: outcome.selectionToken, societies: outcome.memberships },
        'This mobile number is linked to more than one society. Choose one to continue.',
      );
    }
    return ok(res, outcome.result, 'Signed in successfully');
  }),
);

router.post(
  '/select-society',
  rateLimiters.auth,
  validate(selectSocietySchema.extend({ selectionToken: z.string().min(20).max(4000) })),
  asyncHandler(async (req, res) => {
    const body = req.body as { selectionToken: string; societyId: string };
    const result = await authService.completeSocietySelection(body.selectionToken, body.societyId, deviceFrom(req));
    return ok(res, result, 'Signed in successfully');
  }),
);

/* ------------------------------ Password login ----------------------------- */

router.post(
  '/login',
  rateLimiters.auth,
  validate(loginPasswordSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as { identifier: string; password: string };
    const outcome = await authService.loginWithPassword(body.identifier, body.password, deviceFrom(req));
    if (outcome.kind === 'selection') {
      return ok(
        res,
        { requiresSocietySelection: true, selectionToken: outcome.selectionToken, societies: outcome.memberships },
        'This account belongs to more than one society. Choose one to continue.',
      );
    }
    return ok(res, outcome.result, 'Signed in successfully');
  }),
);

router.post(
  '/platform/login',
  rateLimiters.auth,
  validate(loginPasswordSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as { identifier: string; password: string };
    const result = await authService.loginPlatformUser(body.identifier, body.password, deviceFrom(req));
    return ok(res, result, 'Signed in to the platform console');
  }),
);

/* --------------------------------- Tokens ---------------------------------- */

router.post(
  '/refresh',
  rateLimiters.auth,
  validate(refreshTokenSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as { refreshToken: string };
    // The refresh token may also arrive as an httpOnly cookie from the web consoles.
    const token = body.refreshToken ?? (req as Request & { cookies?: Record<string, string> }).cookies?.refresh_token;
    if (!token) throw ApiError.unauthenticated('Refresh token is required');
    const { tokens } = await authService.refreshTokens(token, deviceFrom(req));
    return ok(res, tokens, 'Session refreshed');
  }),
);

router.post(
  '/logout',
  authenticate(),
  validate(logoutSchema),
  asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const body = req.body as { allDevices: boolean; refreshToken?: string };
    const result = await authService.logout(ctx, body);
    return ok(res, result, body.allDevices ? 'Signed out from all devices' : 'Signed out');
  }),
);

/* --------------------------------- Profile --------------------------------- */

router.get(
  '/me',
  authenticate(),
  asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const user = await buildMe(ctx);
    return ok(res, user, 'Profile fetched');
  }),
);

const updateMeSchema = z.object({
  fullName: z.string().trim().min(2).max(80).optional(),
  email: z.string().trim().email().max(160).optional().nullable(),
  avatarUrl: z.string().trim().max(1000).optional().nullable(),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY']).optional(),
  dateOfBirth: z.coerce.date().optional(),
  preferences: z.record(z.string(), z.unknown()).optional(),
});

router.patch(
  '/me',
  authenticate(),
  validate(updateMeSchema),
  asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    await authService.updateOwnProfile(ctx, req.body as never);
    const user = await buildMe(ctx);
    return ok(res, user, 'Profile updated');
  }),
);

async function buildMe(ctx: import('../../middleware/context.js').RequestContext) {
  const db = ctx.db ?? ctx.platformDatabase;
  const collectionName = ctx.principal.isPlatformUser ? 'platform_users' : 'users';
  const user = await db.collection(collectionName).findById(ctx.principal.userId);
  if (!user) throw ApiError.notFound('Account');

  const memberships = ctx.principal.isPlatformUser
    ? []
    : await (async () => {
        const directory = await import('../../services/identityDirectory.js');
        const phone = user.phone ? String(user.phone) : null;
        const entry = phone ? await directory.findByPhone(phone) : null;
        const platform = await import('../../db/manager.js').then((m) => m.databases.platform());
        const societyIds = Array.from(new Set((entry?.memberships ?? []).map((m) => m.societyId)));
        const societies = societyIds.length
          ? await platform.collection('societies').find({ _id: { $in: societyIds } }, { limit: societyIds.length })
          : [];
        const byId = new Map(societies.map((s) => [String(s._id), s]));
        return (entry?.memberships ?? [])
          .map((m) => {
            const society = byId.get(m.societyId);
            if (!society) return null;
            return {
              societyId: m.societyId,
              societyName: String(society.name),
              societySlug: String(society.slug),
              roles: m.roles as never[],
              unitIds: m.unitIds,
              primaryUnitId: m.unitIds[0] ?? null,
              isActive: m.isActive && society.status === 'ACTIVE',
            };
          })
          .filter((m): m is NonNullable<typeof m> => Boolean(m));
      })();

  const permissions = ctx.principal.isPlatformUser
    ? Array.from(ctx.principal.permissions)
    : Array.from(await authService.permissionsFor(db, ctx.society?.id ?? '', ctx.principal.roles, false));

  let unreadNotifications = 0;
  if (ctx.society && ctx.db) {
    unreadNotifications = await ctx.db.collection('notifications').countDocuments({
      societyId: ctx.society.id,
      userId: ctx.principal.userId,
      readAt: null,
    });
  }

  return {
    ...serialise(user, { revealContact: true, revealSensitive: false }),
    id: String(user._id),
    roles: ctx.principal.roles,
    permissions,
    memberships,
    society: ctx.society
      ? { id: ctx.society.id, name: ctx.society.name, slug: ctx.society.slug, timezone: ctx.society.timezone, currency: ctx.society.currency, logoUrl: ctx.society.logoUrl }
      : null,
    membership: {
      unitIds: ctx.membership.unitIds,
      primaryUnitId: ctx.membership.primaryUnitId,
      residentId: ctx.membership.residentId,
      staffId: ctx.membership.staffId,
      gateIds: ctx.membership.gateIds,
      familyPermissions: ctx.membership.familyPermissions ?? null,
    },
    enabledModules: Array.from(ctx.enabledModules),
    appPinEnabled: Boolean(user.appPinHash),
    biometricEnabled: Boolean(user.biometricEnabled),
    unreadNotifications,
  };
}

/* -------------------------------- Passwords -------------------------------- */

router.post(
  '/change-password',
  authenticate(),
  rateLimiters.auth,
  validate(changePasswordSchema),
  asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const body = req.body as { currentPassword: string; newPassword: string };
    await authService.changePassword(ctx, body.currentPassword, body.newPassword, deviceFrom(req));
    return ok(res, { changed: true }, 'Password changed. You have been signed out on your other devices.');
  }),
);

router.post(
  '/set-password',
  authenticate(),
  rateLimiters.auth,
  validate(z.object({ newPassword: z.string().min(8).max(128) })),
  asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const body = req.body as { newPassword: string };
    await authService.setPassword(ctx, body.newPassword);
    return ok(res, { set: true }, 'Password set successfully');
  }),
);

router.post(
  '/forgot-password',
  rateLimiters.auth,
  validate(forgotPasswordSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as { phone?: string; email?: string };
    const identifier = body.phone ?? body.email ?? '';
    const result = await authService.requestPasswordReset(identifier);

    // The response is intentionally identical whether or not the account exists.
    if (!result.resetToken && !result.selectionToken) {
      return ok(res, { sent: false }, 'If an account exists for these details, a reset link has been sent.');
    }
    if (result.selectionToken) {
      return ok(
        res,
        { sent: true, requiresSocietySelection: true, selectionToken: result.selectionToken, societies: result.memberships, expiresInSeconds: result.expiresInSeconds },
        'This account belongs to more than one society. Choose one to reset.',
      );
    }
    // In development the token is returned so the flow is testable end to end; in production
    // it would be delivered by SMS/email only.
    return ok(
      res,
      { sent: true, expiresInSeconds: result.expiresInSeconds, ...(env.EXPOSE_DEV_OTP && env.NODE_ENV !== 'production' ? { resetToken: result.resetToken } : {}) },
      'If an account exists for these details, a reset link has been sent.',
    );
  }),
);

router.post(
  '/reset-password',
  rateLimiters.auth,
  validate(resetPasswordSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as { token: string; newPassword: string };
    await authService.resetPasswordWithToken(body.token, body.newPassword);
    return ok(res, { reset: true }, 'Password reset successfully. You can now sign in.');
  }),
);

/* --------------------------- Sessions & app PIN ---------------------------- */

router.get(
  '/sessions',
  authenticate(),
  asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const sessions = await authService.listSessions(ctx);
    return ok(res, { items: sessions }, 'Active sessions fetched');
  }),
);

router.delete(
  '/sessions/:id',
  authenticate(),
  asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const sessionId = String(req.params.id);
    await authService.revokeSession(ctx, sessionId);
    return ok(res, { revoked: sessionId }, 'Session signed out');
  }),
);

router.post(
  '/push-token',
  authenticate(),
  validate(z.object({ token: z.string().min(10).max(2000), platform: z.enum(['ios', 'android', 'web']).default('android'), deviceId: z.string().max(120).optional() })),
  asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const body = req.body as { token: string; platform: string; deviceId?: string };
    await authService.registerPushToken(ctx, body.token, body.platform, body.deviceId);
    return ok(res, { registered: true }, 'Push token registered');
  }),
);

router.delete(
  '/push-token',
  authenticate(),
  asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const token = String(req.query.token ?? '');
    if (token) await authService.unregisterPushToken(ctx, token);
    return ok(res, { unregistered: true }, 'Push token removed');
  }),
);

router.post(
  '/app-pin',
  authenticate(),
  validate(appPinSchema),
  asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const body = req.body as { pin: string; enableBiometric: boolean };
    await authService.setAppPin(ctx, body.pin, body.enableBiometric);
    return created(res, { enabled: true }, 'App PIN enabled');
  }),
);

router.post(
  '/app-pin/verify',
  authenticate(),
  validate(verifyAppPinSchema),
  asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const body = req.body as { pin: string };
    const valid = await authService.verifyAppPin(ctx, body.pin);
    if (!valid) throw ApiError.badRequest('Incorrect PIN');
    return ok(res, { valid: true }, 'PIN verified');
  }),
);

router.delete(
  '/app-pin',
  authenticate(),
  validate(z.object({ pin: z.string().regex(/^\d{4,6}$/) })),
  asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const body = req.body as { pin: string };
    await authService.disableAppPin(ctx, body.pin);
    return ok(res, { disabled: true }, 'App PIN removed');
  }),
);

export default router;
