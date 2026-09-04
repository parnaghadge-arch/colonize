import { Router } from 'express';
import { z } from 'zod';
import { DEFAULT_TIER_MODULES, permission, type ModuleKey } from '@colonize/shared';
import { authenticatePlatform, requirePlatformContext } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/permissions.js';
import { asyncHandler } from '../../middleware/errors.js';
import { validate } from '../../middleware/validate.js';
import { ok, created, paginated } from '../../utils/response.js';
import { ApiError } from '../../utils/errors.js';
import { databases } from '../../db/manager.js';
import { syncSubscriptionMirror } from '../../db/seedTenant.js';
import { resolvePlanId } from '../../db/seedPlatform.js';
import { serialise } from '../../utils/serialize.js';
import type { Document } from '../../db/drivers/types.js';
import { rateLimiters } from '../../middleware/security.js';
import { logSystemAudit } from '../../services/audit.js';
import { escapeRegex } from '@colonize/shared';
import { newId } from '../../db/ids.js';
import * as societiesService from './societiesService.js';
import * as structureService from '../structure/structureService.js';

/**
 * Super-admin society management (§41, §45, §46).
 *
 * Mounted at /api/platform/societies — platform tokens only. A society token can never reach
 * these routes (`authenticatePlatform` rejects tenant scope outright), and every handler
 * resolves the target society explicitly, so one society's administrator cannot act on
 * another's data even if they somehow obtained a platform token.
 */

const createSocietySchema = z.object({
  name: z.string().trim().min(3).max(120),
  slug: z
    .string()
    .trim()
    .min(3)
    .max(48)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  legalName: z.string().trim().max(160).optional(),
  registrationNumber: z.string().trim().max(60).optional(),
  city: z.string().trim().min(2).max(80),
  state: z.string().trim().max(80).optional(),
  country: z.string().trim().max(60).default('IN'),
  pincode: z.string().trim().max(12).optional(),
  address: z.string().trim().max(400).optional(),
  timezone: z.string().trim().max(60).default('Asia/Kolkata'),
  currency: z.string().trim().length(3).default('INR'),
  contactEmail: z.string().trim().email().max(160).optional(),
  contactPhone: z.string().trim().max(20).optional(),
  websiteUrl: z.string().trim().max(300).optional(),
  logoUrl: z.string().trim().max(500).optional(),
  coverImageUrl: z.string().trim().max(500).optional(),
  tier: z.enum(['FREE', 'STARTER', 'GROWTH', 'PRO', 'ENTERPRISE']).default('FREE'),
  modules: z.array(z.string().min(2).max(40)).max(60).optional(),
  onboardingSource: z.string().trim().max(40).optional(),
  admin: z
    .object({
      fullName: z.string().trim().min(2).max(80),
      email: z.string().trim().email().max(160).optional(),
      phone: z.string().trim().max(20).optional(),
      password: z.string().min(8).max(128).optional(),
    })
    .optional(),
});

const onboardingSchema = z.object({
  step: z.enum(['PROFILE', 'STRUCTURE', 'ADMIN', 'SETTINGS', 'ACTIVATION']),
  payload: z.record(z.string(), z.unknown()).default({}),
  dryRun: z.coerce.boolean().default(false),
});

const subscriptionSchema = z.object({
  tier: z.enum(['FREE', 'STARTER', 'GROWTH', 'PRO', 'ENTERPRISE']),
  modules: z.array(z.string().min(2).max(40)).max(60).optional(),
  renewalMode: z.enum(['MONTHLY', 'QUARTERLY', 'ANNUAL']).default('MONTHLY'),
  startDate: z.string().trim().max(20).optional(),
  endDate: z.string().trim().max(20).optional(),
  amount: z.coerce.number().min(0).max(10_000_000).default(0),
  maxUnits: z.coerce.number().int().min(1).max(1_000_000).optional(),
  maxAdmins: z.coerce.number().int().min(1).max(1000).optional(),
  maxGates: z.coerce.number().int().min(1).max(500).optional(),
  smsCredits: z.coerce.number().int().min(0).max(100_000_000).optional(),
  storageMb: z.coerce.number().int().min(64).max(100_000_000).optional(),
  whatsappEnabled: z.coerce.boolean().default(false),
  paymentGatewayEnabled: z.coerce.boolean().default(true),
  biometricEnabled: z.coerce.boolean().default(false),
  status: z.enum(['TRIAL', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED']).default('ACTIVE'),
  autoRenew: z.coerce.boolean().default(false),
});

const router: Router = Router();
router.use(authenticatePlatform());

/* ---------------------------------- list ----------------------------------- */

router.get(
  '/',
  requirePermission(permission('society', 'view'), permission('society', 'manage')),
  validate(z.object({
      search: z.string().trim().max(120).optional(),
      status: z.string().trim().max(30).optional(),
      tier: z.string().trim().max(30).optional(),
      city: z.string().trim().max(80).optional(),
      sortBy: z.enum(['createdAt', 'name', 'totalUnits', 'totalResidents']).default('createdAt'),
      sortDir: z.enum(['asc', 'desc']).default('desc'),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(200).default(25),
    }), 'query'),
  asyncHandler(async (req, res) => {
    const ctx = requirePlatformContext(req);
    const q = req.query as Record<string, string>;
    const filter: Record<string, unknown> = {};
    if (q.status) filter.status = q.status;
    if (q.tier) filter.tier = q.tier;
    if (q.city) filter.city = new RegExp(escapeRegex(q.city), 'i');
    if (q.search) {
      const rx = new RegExp(escapeRegex(q.search), 'i');
      filter.$or = [{ name: rx }, { slug: rx }, { city: rx }, { contactEmail: rx }, { contactPhone: rx }];
    }

    const page = Number(q.page ?? 1);
    const limit = Number(q.limit ?? 25);
    const sortBy = String(q.sortBy ?? 'createdAt');
    const sortDir = String(q.sortDir ?? 'desc') === 'asc' ? 1 : -1;
    const [items, total] = await Promise.all([
      ctx.platformDatabase.collection('societies').find(filter, {
        sort: { [sortBy]: sortDir },
        skip: (page - 1) * limit,
        limit,
      }),
      ctx.platformDatabase.collection('societies').countDocuments(filter),
    ]);

    return paginated(
      res,
      { items: items.map((s: Document) => serialise(s, { revealContact: true })), total, page, limit, sortBy, sortDir: sortDir === 1 ? 'asc' : 'desc' },
      'Societies fetched',
    );
  }),
);

/** Platform-wide numbers for the super-admin dashboard (§45). */
router.get(
  '/stats/overview',
  requirePermission(permission('dashboard', 'view')),
  asyncHandler(async (req, res) => {
    const ctx = requirePlatformContext(req);
    return ok(res, await societiesService.platformStats(ctx.platformDatabase), 'Platform statistics fetched');
  }),
);

/* --------------------------------- create ---------------------------------- */

router.post(
  '/',
  rateLimiters.auth,
  requirePermission(permission('society', 'create'), permission('society', 'manage')),
  validate(createSocietySchema),
  asyncHandler(async (req, res) => {
    const ctx = requirePlatformContext(req);
    const society = await societiesService.createSociety(
      {
        platform: ctx.platformDatabase,
        actorId: ctx.principal.userId,
        actorName: ctx.principal.email ?? ctx.principal.fullName,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      },
      req.body as never,
    );

    // If an administrator was supplied, create them straight away inside the new database so
    // the society is usable the moment the wizard finishes.
    const body = req.body as { admin?: { fullName: string; email?: string; phone?: string; password?: string } };
    let admin = null;
    if (body.admin) {
      const db = await databases.tenantDb(String(society._id));
      admin = await societiesService.createSocietyAdmin(
        { db, societyId: String(society._id), actorId: ctx.principal.userId },
        { ...body.admin, roles: ['SOCIETY_ADMIN'] },
        { activate: false },
      );
    }

    return created(
      res,
      {
        society: serialise(society, { revealContact: true }),
        admin: admin
          ? { id: admin._id, fullName: admin.fullName, email: admin.email ?? null, phone: admin.phone ?? null, mustChangePassword: true }
          : null,
      },
      `Society "${society.name}" created and its private database provisioned`,
    );
  }),
);

/* --------------------------------- detail ---------------------------------- */

router.get(
  '/:id',
  requirePermission(permission('society', 'view'), permission('society', 'manage')),
  asyncHandler(async (req, res) => {
    const ctx = requirePlatformContext(req);
    const id = String(req.params.id);
    const society = await ctx.platformDatabase.collection('societies').findOne({ _id: id });
    if (!society) throw ApiError.notFound('Society');

    const db = await databases.tenantDb(id);
    const [counts, onboarding] = await Promise.all([
      structureService.unitStatusCounts({ db, societyId: id, actorId: ctx.principal.userId }),
      societiesService.getOnboardingState(id),
    ]);
    const subscription = await ctx.platformDatabase.collection('subscriptions').findOne({ societyId: id }, { sort: { createdAt: -1 } });

    return ok(
      res,
      {
        ...serialise(society, { revealContact: true }),
        unitCounts: counts,
        onboarding,
        subscription: subscription ? serialise(subscription) : society.subscription,
      },
      'Society fetched',
    );
  }),
);

router.patch(
  '/:id',
  requirePermission(permission('society', 'update'), permission('society', 'manage')),
  validate(createSocietySchema.partial()),
  asyncHandler(async (req, res) => {
    const ctx = requirePlatformContext(req);
    const id = String(req.params.id);
    const before = await ctx.platformDatabase.collection('societies').findOne({ _id: id });
    if (!before) throw ApiError.notFound('Society');

    const body = req.body as Record<string, unknown>;
    const update: Record<string, unknown> = { ...body, updatedBy: ctx.principal.userId };
    delete update.admin;
    if (Array.isArray(body.modules)) update.modules = body.modules as ModuleKey[];

    await ctx.platformDatabase.collection('societies').updateOne({ _id: id }, { $set: update });
    const after = await ctx.platformDatabase.collection('societies').findOne({ _id: id });

    await logSystemAudit(ctx.platformDatabase, {
      collection: 'platform_audit_logs',
      societyId: id,
      module: 'society',
      action: 'society.updated',
      recordId: id,
      recordType: 'society',
      oldValue: before,
      newValue: after,
      actor: { id: ctx.principal.userId, name: ctx.principal.email ?? ctx.principal.fullName, type: 'PLATFORM' },
    });

    return ok(res, serialise(after!, { revealContact: true }), 'Society updated');
  }),
);

/* ------------------------------- onboarding -------------------------------- */

router.get(
  '/:id/onboarding',
  requirePermission(permission('society', 'view'), permission('society', 'manage')),
  asyncHandler(async (req, res) =>
    ok(res, await societiesService.getOnboardingState(String(req.params.id)), 'Onboarding state fetched'),
  ),
);

router.post(
  '/:id/onboarding',
  requirePermission(permission('society', 'update'), permission('society', 'manage')),
  validate(onboardingSchema),
  asyncHandler(async (req, res) => {
    const ctx = requirePlatformContext(req);
    const body = req.body as { step: societiesService.OnboardingStep; payload: Record<string, unknown>; dryRun: boolean };
    const result = await societiesService.runOnboardingStep(
      {
        platform: ctx.platformDatabase,
        actorId: ctx.principal.userId,
        actorName: ctx.principal.email ?? ctx.principal.fullName,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      },
      String(req.params.id),
      body.step,
      { ...body.payload, dryRun: body.dryRun },
    );
    return ok(res, result, body.dryRun ? `${body.step} previewed` : `${body.step} step completed`);
  }),
);

router.post(
  '/:id/activate',
  requirePermission(permission('society', 'update'), permission('society', 'manage')),
  asyncHandler(async (req, res) => {
    const ctx = requirePlatformContext(req);
    const result = await societiesService.activateSociety(
      { platform: ctx.platformDatabase, actorId: ctx.principal.userId, actorName: ctx.principal.email ?? ctx.principal.fullName },
      String(req.params.id),
    );
    return ok(res, result, 'Society activated — residents and guards can now sign in');
  }),
);

router.post(
  '/:id/status',
  requirePermission(permission('society', 'manage')),
  validate(
    z.object({
      status: z.enum(['ONBOARDING', 'ACTIVE', 'SUSPENDED', 'INACTIVE', 'ARCHIVED']),
      reason: z.string().trim().max(400).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const ctx = requirePlatformContext(req);
    const body = req.body as { status: string; reason?: string };
    const result = await societiesService.setSocietyStatus(
      { platform: ctx.platformDatabase, actorId: ctx.principal.userId, actorName: ctx.principal.email ?? ctx.principal.fullName },
      String(req.params.id),
      body.status,
      body.reason,
    );
    return ok(res, result, `Society marked ${body.status.toLowerCase()}`);
  }),
);

/** Re-provision a database that failed to seed (idempotent — safe to run twice). */
router.post(
  '/:id/provision',
  requirePermission(permission('society', 'manage')),
  asyncHandler(async (req, res) => {
    const ctx = requirePlatformContext(req);
    const id = String(req.params.id);
    const society = await ctx.platformDatabase.collection('societies').findOne({ _id: id });
    if (!society) throw ApiError.notFound('Society');
    await ctx.platformDatabase.collection('societies').updateOne({ _id: id }, { $set: { databaseProvisioned: false } });
    await societiesService.provisionSocietyDatabase({ ...society, databaseProvisioned: false });
    return ok(res, { provisioned: true, databaseName: society.databaseName }, 'Database provisioned with default roles, ledgers and settings');
  }),
);

router.post(
  '/:id/rebuild-directory',
  requirePermission(permission('society', 'manage')),
  asyncHandler(async (req, res) =>
    ok(res, await societiesService.rebuildIdentityDirectory(String(req.params.id)), 'Login directory rebuilt for this society'),
  ),
);

/* ------------------------------ subscription ------------------------------- */

router.put(
  '/:id/subscription',
  requirePermission(permission('subscription', 'manage'), permission('subscription', 'update')),
  validate(subscriptionSchema),
  asyncHandler(async (req, res) => {
    const ctx = requirePlatformContext(req);
    const societyId = String(req.params.id);
    const society = await ctx.platformDatabase.collection('societies').findOne({ _id: societyId });
    if (!society) throw ApiError.notFound('Society');

    const body = req.body as z.infer<typeof subscriptionSchema>;
    const modules = (body.modules?.length ? body.modules : DEFAULT_TIER_MODULES[body.tier]) as ModuleKey[];
    const now = new Date();
    const periodDays = body.renewalMode === 'ANNUAL' ? 365 : body.renewalMode === 'QUARTERLY' ? 92 : 30;
    const endDate = body.endDate ?? new Date(now.getTime() + periodDays * 86_400_000).toISOString().slice(0, 10);
    const previousLimits = (society.limits as Record<string, number> | undefined) ?? {};

    // `planId` is a required reference to `subscription_plans`; a subscription row cannot be
    // written without resolving (or creating) the plan the tier maps to.
    const { planId, planCode } = await resolvePlanId(ctx.platformDatabase, body.tier);

    const subscription = {
      societyId,
      planId,
      planCode,
      tier: body.tier,
      status: body.status,
      modules,
      renewalMode: body.renewalMode,
      startDate: body.startDate ?? now.toISOString().slice(0, 10),
      endDate,
      amount: body.amount,
      maxUnits: body.maxUnits ?? previousLimits.maxUnits ?? 500,
      maxAdmins: body.maxAdmins ?? previousLimits.maxAdmins ?? 10,
      maxGates: body.maxGates ?? previousLimits.maxGates ?? 10,
      smsCredits: body.smsCredits ?? previousLimits.smsCredits ?? 1000,
      storageMb: body.storageMb ?? previousLimits.storageMb ?? 10240,
      whatsappEnabled: body.whatsappEnabled,
      paymentGatewayEnabled: body.paymentGatewayEnabled,
      biometricEnabled: body.biometricEnabled,
      autoRenew: body.autoRenew,
      updatedBy: ctx.principal.userId,
    };

    await ctx.platformDatabase.collection('subscriptions').updateOne(
      { societyId, tier: body.tier },
      { $set: subscription, $setOnInsert: { _id: newId('subscriptions') } },
      { upsert: true },
    );
    await ctx.platformDatabase.collection('societies').updateOne(
      { _id: societyId },
      {
        $set: {
          tier: body.tier,
          modules,
          subscription: { ...(society.subscription as object), ...subscription },
          limits: {
            maxUnits: subscription.maxUnits,
            maxAdmins: subscription.maxAdmins,
            maxGates: subscription.maxGates,
            smsCredits: subscription.smsCredits,
            storageMb: subscription.storageMb,
          },
          updatedAt: new Date(),
        },
      },
    );

    // `requireModule` does not read this platform record: the authenticate middleware builds
    // `enabledModules` from the subscription mirror inside the society's own database, so that
    // authorising a request never costs a cross-database read. Updating the platform rows alone
    // would therefore leave the change inert — an upgraded society would keep being refused the
    // modules it now pays for. Re-sync the mirror so the new entitlements take effect (after the
    // middleware's short society cache expires). Societies that are not provisioned yet are
    // skipped: provisioning mirrors the plan from the platform record when it runs.
    if (society.databaseProvisioned) {
      const handle = await databases.forSocietyId(societyId);
      await syncSubscriptionMirror(handle.db, {
        societyId,
        slug: String(society.slug),
        tier: body.tier,
        modules,
        status: body.status,
        startDate: subscription.startDate,
        endDate: subscription.endDate,
        autoRenew: body.autoRenew,
        limits: {
          maxUnits: subscription.maxUnits,
          maxAdmins: subscription.maxAdmins,
          maxGates: subscription.maxGates,
          smsCredits: subscription.smsCredits,
          storageMb: subscription.storageMb,
        },
      });
    }

    await logSystemAudit(ctx.platformDatabase, {
      collection: 'platform_audit_logs',
      societyId,
      module: 'subscription',
      action: 'subscription.updated',
      recordId: societyId,
      recordType: 'society',
      oldValue: society.subscription as Record<string, unknown>,
      newValue: subscription,
      actor: { id: ctx.principal.userId, name: ctx.principal.email ?? ctx.principal.fullName, type: 'PLATFORM' },
    });

    return ok(res, { societyId, subscription }, `Subscription set to ${body.tier} with ${modules.length} modules`);
  }),
);

/* ---------------------------------- stats ---------------------------------- */

router.get(
  '/:id/stats',
  requirePermission(permission('society', 'view'), permission('society', 'manage')),
  asyncHandler(async (req, res) => {
    const ctx = requirePlatformContext(req);
    const societyId = String(req.params.id);
    const society = await ctx.platformDatabase.collection('societies').findOne({ _id: societyId });
    if (!society) throw ApiError.notFound('Society');
    const db = await databases.tenantDb(societyId);

    const [units, residents, staff, vendors, visitors, complaints, bills, payments, bookings] = await Promise.all([
      structureService.unitStatusCounts({ db, societyId, actorId: ctx.principal.userId }),
      db.collection('residents').countDocuments({ societyId }),
      db.collection('staff').countDocuments({ societyId, isActive: true }),
      db.collection('vendors').countDocuments({ societyId, isActive: true }),
      db.collection('visitor_passes').countDocuments({ societyId, createdAt: { $gte: new Date(Date.now() - 30 * 86_400_000) } }),
      db.collection('complaints').countDocuments({ societyId, status: { $ne: 'CLOSED' } }),
      db.collection('maintenance_bills').aggregate<{ _id: null; total: number; due: number }>([
        { $match: { societyId } },
        { $group: { _id: null, total: { $sum: '$totalAmount' }, due: { $sum: '$dueAmount' } } },
      ]),
      db.collection('payments').aggregate<{ _id: null; collected: number }>([
        { $match: { societyId, status: 'SUCCESS' } },
        { $group: { _id: null, collected: { $sum: '$amount' } } },
      ]),
      db.collection('amenity_bookings').countDocuments({ societyId, status: { $in: ['CONFIRMED', 'PENDING_PAYMENT'] } }),
    ]);

    return ok(
      res,
      {
        society: { id: society._id, name: society.name, slug: society.slug, status: society.status, tier: society.tier },
        units,
        residents,
        staff,
        vendors,
        visitorsLast30Days: visitors,
        openComplaints: complaints,
        billedTotal: Math.round(Number(bills[0]?.total ?? 0) * 100) / 100,
        outstanding: Math.round(Number(bills[0]?.due ?? 0) * 100) / 100,
        collected: Math.round(Number(payments[0]?.collected ?? 0) * 100) / 100,
        activeBookings: bookings,
      },
      'Society statistics fetched',
    );
  }),
);

/* ------------------------------ administrator ------------------------------ */

router.get(
  '/:id/admins',
  requirePermission(permission('society', 'view'), permission('society', 'manage')),
  asyncHandler(async (req, res) => {
    const ctx = requirePlatformContext(req);
    const societyId = String(req.params.id);
    const db = await databases.tenantDb(societyId);
    const admins = await db.collection('users').find(
      { societyId, roles: { $in: ['SOCIETY_ADMIN', 'MANAGING_COMMITTEE', 'CHAIRMAN', 'SECRETARY', 'TREASURER'] } },
      { sort: { createdAt: 1 }, limit: 200 },
    );
    return ok(
      res,
      {
        items: admins.map((a) => ({
          id: a._id,
          fullName: a.fullName,
          email: a.email ?? null,
          phone: a.phone ?? null,
          roles: a.roles,
          status: a.status ?? (a.isActive ? 'ACTIVE' : 'PENDING'),
          lastLoginAt: a.lastLoginAt ?? null,
          mustChangePassword: Boolean(a.mustChangePassword),
        })),
      },
      'Administrators fetched',
    );
  }),
);

router.post(
  '/:id/admins',
  requirePermission(permission('society', 'manage'), permission('user', 'create')),
  validate(
    z.object({
      fullName: z.string().trim().min(2).max(80),
      email: z.string().trim().email().max(160).optional(),
      phone: z.string().trim().max(20).optional(),
      password: z.string().min(8).max(128).optional(),
      roles: z.array(z.string().min(2).max(40)).min(1).max(5).default(['SOCIETY_ADMIN']),
    }),
  ),
  asyncHandler(async (req, res) => {
    const ctx = requirePlatformContext(req);
    const societyId = String(req.params.id);
    const society = await ctx.platformDatabase.collection('societies').findOne({ _id: societyId });
    if (!society) throw ApiError.notFound('Society');

    const limits = (society.limits as { maxAdmins?: number } | undefined) ?? {};
    const maxAdmins = Number(limits.maxAdmins ?? 10);
    const db = await databases.tenantDb(societyId);
    const adminCount = await db.collection('users').countDocuments({
      societyId,
      roles: { $in: ['SOCIETY_ADMIN', 'MANAGING_COMMITTEE', 'CHAIRMAN', 'SECRETARY', 'TREASURER'] },
    });
    if (adminCount >= maxAdmins) {
      throw ApiError.badRequest(`The ${society.tier} plan allows ${maxAdmins} administrators. Upgrade the plan to add more.`);
    }

    const user = await societiesService.createSocietyAdmin(
      { db, societyId, actorId: ctx.principal.userId },
      req.body as never,
      { activate: society.status === 'ACTIVE' },
    );
    await societiesService.refreshSocietyCounters(societyId);

    return created(
      res,
      {
        id: user._id,
        fullName: user.fullName,
        email: user.email ?? null,
        phone: user.phone ?? null,
        roles: user.roles,
        mustChangePassword: Boolean(user.mustChangePassword),
      },
      'Administrator created — they can sign in with this phone number or email',
    );
  }),
);

router.get(
  '/:id/audit-logs',
  requirePermission(permission('audit', 'view')),
  validate(z.object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(25),
      action: z.string().trim().max(60).optional(),
      module: z.string().trim().max(40).optional(),
    }), 'query'),
  asyncHandler(async (req, res) => {
    const ctx = requirePlatformContext(req);
    const q = req.query as Record<string, string>;
    const societyId = String(req.params.id);
    const filter: Record<string, unknown> = { societyId };
    if (q.action) filter.action = q.action;
    if (q.module) filter.module = q.module;

    const page = Number(q.page ?? 1);
    const limit = Number(q.limit ?? 25);
    const [items, total] = await Promise.all([
      ctx.platformDatabase.collection('platform_audit_logs').find(filter, { sort: { createdAt: -1 }, skip: (page - 1) * limit, limit }),
      ctx.platformDatabase.collection('platform_audit_logs').countDocuments(filter),
    ]);
    return paginated(res, { items, total, page, limit, sortBy: 'createdAt', sortDir: 'desc' }, 'Audit trail fetched');
  }),
);

export default router;
