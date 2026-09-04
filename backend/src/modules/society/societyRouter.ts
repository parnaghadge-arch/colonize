import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import {
  DEFAULT_TIER_MODULES,
  MODULE_KEYS,
  MODULE_LABELS,
  parsePagination,
  type ModuleKey,
} from '@colonize/shared';
import { authenticate, requireTenantContext } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/permissions.js';
import { asyncHandler } from '../../middleware/errors.js';
import { validate } from '../../middleware/validate.js';
import { ok, paginated } from '../../utils/response.js';
import { ApiError } from '../../utils/errors.js';
import { serialise } from '../../utils/serialize.js';
import { AuditService } from '../../services/audit.js';
import { databases } from '../../db/manager.js';
import { getAllSettings, updateSettings, type SettingsNamespace } from '../../services/settings.js';
import { DEFAULT_SETTINGS } from '../../db/seedTenant.js';
import type { Document, TenantDatabase } from '../../db/drivers/types.js';

/**
 * A society managing itself (§47, §48, §63, §79).
 *
 * Everything under `/platform/societies` is the SaaS operator's view — onboarding, activation,
 * suspension, plan changes. This router is the other side of the same data: what a society's own
 * administrators may read and change about *their* society, from inside their tenant context.
 *
 * The boundary is deliberate. A society admin can correct a contact number, a logo or a billing
 * rule that their own services read. They cannot rename the society, change its slug (which
 * determines the database name), move it between plans, or alter its lifecycle status — those stay
 * with the platform, because each one has consequences outside that society's own database.
 */

/**
 * Fields a society's own administrators may change. `.strict()` matters: without it Zod strips
 * `name`, `slug`, `status` and `planCode` and the request would return 200 having changed
 * nothing, which reads to an administrator as "it worked". Renaming, re-slugging, re-planning and
 * lifecycle changes belong to the platform operator, because each one has consequences outside
 * this society's own database.
 */
const selfServiceProfileSchema = z.object({
  registrationNumber: z.string().trim().max(60).optional(),
  // A plain string, matching how the platform creates a society and how the invoice and receipt
  // PDFs render it (`[society.address, city, state, pincode].join(', ')`). Accepting a record here
  // would let an administrator store an object that every document then prints as
  // "[object Object]".
  address: z.string().trim().max(400).optional(),
  city: z.string().trim().max(80).optional(),
  state: z.string().trim().max(80).optional(),
  // Field names must match the stored document. `postalCode`/`website` would pass `.strict()`,
  // return 200, and write keys nothing ever reads — the "it worked" failure this schema exists to
  // prevent.
  pincode: z.string().trim().max(12).optional(),
  timezone: z.string().trim().max(60).optional(),
  contactPhone: z.string().trim().max(20).optional(),
  contactEmail: z.string().trim().email().max(160).optional(),
  websiteUrl: z.string().trim().url().max(300).optional(),
  logoUrl: z.string().trim().max(500).nullable().optional(),
  gstin: z.string().trim().max(20).optional(),
}).strict();

/**
 * Namespaces an administrator may edit. Settings are read by real code paths — `maintenance`
 * drives bill generation, `visitor` drives the gate, `complaint` drives SLAs — so this list is
 * the platform's configurable surface, not a decorative preferences blob.
 */
const EDITABLE_NAMESPACES = Object.keys(DEFAULT_SETTINGS) as string[];

const settingsPatchSchema = z.object({
  value: z.record(z.string(), z.unknown()),
});

const auditQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  module: z.string().trim().max(40).optional(),
  action: z.string().trim().max(60).optional(),
  actorId: z.string().trim().max(60).optional(),
  recordId: z.string().trim().max(60).optional(),
  severity: z.enum(['INFO', 'NOTICE', 'WARNING', 'CRITICAL']).optional(),
  from: z.string().trim().max(30).optional(),
  to: z.string().trim().max(30).optional(),
});

const guards: RequestHandler[] = [authenticate({ clientScopes: ['console', 'resident', 'staff', 'security', 'vendor'] })];

export const societyRouter: Router = Router();

/** The society document lives in the platform database; the caller's context only caches a slice. */
async function loadPlatformSociety(societyId: string): Promise<Document> {
  const platform: TenantDatabase = await databases.platform();
  const society = await platform.collection('societies').findById(societyId);
  if (!society) throw ApiError.notFound('Society');
  return society;
}

/* --------------------------------- profile ---------------------------------- */

/**
 * GET /api/society
 *
 * The society's own profile, its live entitlements and a few counters — everything the settings
 * screen needs in one round trip.
 */
societyRouter.get(
  '/',
  ...guards,
  requirePermission('society:view', 'setting:view'),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const society = await loadPlatformSociety(c.society.id);

    // The tenant `subscriptions` row is the authoritative list for `requireModule`; the platform
    // row is where a plan change starts. Showing both makes a stale mirror visible instead of
    // silently disabling features.
    const subscription = await c.db.collection('subscriptions').findOne(
      { societyId: c.society.id },
      { sort: { createdAt: -1 } },
    );
    const platformSubscription = await databases
      .platform()
      .then((p) => p.collection('subscriptions').findOne({ societyId: c.society.id }, { sort: { createdAt: -1 } }));

    const counts = await Promise.all([
      c.db.collection('units').countDocuments({ societyId: c.society.id }),
      c.db.collection('residents').countDocuments({ societyId: c.society.id, isActive: true }),
      c.db.collection('staff').countDocuments({ societyId: c.society.id, status: 'ACTIVE' }),
      c.db.collection('buildings').countDocuments({ societyId: c.society.id }),
      c.db.collection('gates').countDocuments({ societyId: c.society.id, isActive: true }),
    ]);

    return ok(
      res,
      {
        // `revealContact` because this is the society's own published office contact, not a
        // resident's personal number — masking it would make the edit form unusable.
        society: serialise(society, {
          revealContact: true,
          omit: ['provisioning', 'onboardingStep', 'createdByPlatformUserId', 'suspensionReason'],
        }),
        subscription: {
          planCode: subscription?.planCode ?? platformSubscription?.planCode ?? society.planCode ?? null,
          tier: subscription?.tier ?? platformSubscription?.tier ?? null,
          status: subscription?.status ?? platformSubscription?.status ?? null,
          startDate: subscription?.startDate ?? null,
          endDate: subscription?.endDate ?? null,
          billingCycle: subscription?.billingCycle ?? null,
          autoRenew: subscription?.autoRenew ?? null,
          limits: subscription?.limits ?? {},
          syncedFromPlatformAt: subscription?.syncedFromPlatformAt ?? null,
          /** True when the tenant mirror and the platform record disagree — worth surfacing. */
          outOfSync:
            Boolean(platformSubscription) &&
            String(platformSubscription?.planCode ?? '') !== String(subscription?.planCode ?? ''),
        },
        enabledModules: Array.from(c.enabledModules).sort(),
        counts: {
          buildings: counts[3],
          units: counts[0],
          residents: counts[1],
          staff: counts[2],
          gates: counts[4],
        },
      },
      'Society profile',
    );
  }),
);

/**
 * PATCH /api/society
 *
 * Update the self-service slice of the profile. Renaming, re-slugging, re-planning and status
 * changes are rejected rather than ignored, so a caller cannot think it worked.
 */
societyRouter.patch(
  '/',
  ...guards,
  requirePermission('society:update', 'society:manage'),
  validate(selfServiceProfileSchema),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const platform = await databases.platform();
    const before = await loadPlatformSociety(c.society.id);

    const patch = req.body as z.infer<typeof selfServiceProfileSchema>;
    const updates: Document = { ...patch, updatedByPlatformUserId: c.principal.userId };

    await platform.collection('societies').updateOne({ _id: c.society.id }, { $set: updates });
    const after = await loadPlatformSociety(c.society.id);

    await new AuditService(c).log({
      action: 'SOCIETY_PROFILE_UPDATED',
      module: 'society',
      recordId: c.society.id,
      recordType: 'society',
      oldValue: before,
      newValue: after,
    });

    return ok(
      res,
      serialise(after, {
        revealContact: true,
        omit: ['provisioning', 'onboardingStep', 'createdByPlatformUserId'],
      }),
      'Society profile updated',
    );
  }),
);

/* --------------------------------- settings --------------------------------- */

/**
 * GET /api/society/settings
 *
 * Every namespace, merged over the built-in defaults, plus which ones this deployment actually
 * reads. An administrator can therefore see the effective value of a rule without guessing
 * whether a blank means "off" or "never configured".
 */
societyRouter.get(
  '/settings',
  ...guards,
  requirePermission('setting:view', 'society:view'),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const settings = await getAllSettings({ db: c.db, societyId: c.society.id });

    return ok(
      res,
      {
        namespaces: EDITABLE_NAMESPACES.map((key) => ({
          key,
          label: NAMESPACE_LABELS[key] ?? key,
          description: NAMESPACE_DESCRIPTIONS[key] ?? null,
          value: settings[key] ?? {},
          defaults: DEFAULT_SETTINGS[key] ?? {},
        })),
        values: settings,
      },
      'Society settings',
    );
  }),
);

/**
 * PUT /api/society/settings/:namespace
 *
 * Merge a patch into one namespace. Rejecting unknown namespaces matters: a typo would otherwise
 * create a settings row nothing ever reads, and the administrator would believe they had changed
 * a rule.
 */
societyRouter.put(
  '/settings/:namespace',
  ...guards,
  requirePermission('setting:update', 'setting:manage', 'society:update'),
  validate(settingsPatchSchema),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const namespace = String(req.params.namespace) as SettingsNamespace;
    if (!EDITABLE_NAMESPACES.includes(String(namespace))) {
      throw ApiError.badRequest(`"${namespace}" is not a configurable settings namespace`, [
        { field: 'namespace', message: 'Unknown settings namespace', code: 'UNKNOWN_SETTINGS_NAMESPACE' },
      ]);
    }

    const before = await getAllSettings({ db: c.db, societyId: c.society.id });
    const body = req.body as z.infer<typeof settingsPatchSchema>;
    const value = await updateSettings({ db: c.db, societyId: c.society.id }, namespace, body.value, c.principal.userId);

    await new AuditService(c).log({
      action: 'SOCIETY_SETTINGS_UPDATED',
      module: 'setting',
      recordId: String(namespace),
      recordType: 'society_settings',
      oldValue: (before[String(namespace)] ?? {}) as Document,
      newValue: value,
      severity: 'NOTICE',
    });

    return ok(res, { namespace, value }, `${NAMESPACE_LABELS[String(namespace)] ?? namespace} settings saved`);
  }),
);

/* ---------------------------------- modules --------------------------------- */

/**
 * GET /api/society/modules
 *
 * What this society is entitled to, what is actually switched on, and what its plan would allow.
 * Module gating is enforced by `requireModule` on every route, so this is a read-only view of a
 * decision the platform owns — a society cannot enable a module for itself.
 */
societyRouter.get(
  '/modules',
  ...guards,
  requirePermission('society:view', 'setting:view'),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const subscription = await c.db.collection('subscriptions').findOne(
      { societyId: c.society.id },
      { sort: { createdAt: -1 } },
    );
    const tier = String(subscription?.tier ?? 'FREE');
    const entitled = new Set<string>((DEFAULT_TIER_MODULES[tier] ?? DEFAULT_TIER_MODULES.FREE ?? []) as string[]);
    const enabled = new Set(Array.from(c.enabledModules));

    return ok(
      res,
      {
        tier,
        planCode: subscription?.planCode ?? null,
        status: subscription?.status ?? null,
        modules: MODULE_KEYS.map((key: ModuleKey) => ({
          key,
          label: MODULE_LABELS[key] ?? key,
          enabled: enabled.has(key),
          entitled: entitled.has(key),
          /** On today's plan but not switched on — the platform can enable it, the society cannot. */
          upgradeRequired: !entitled.has(key),
        })),
        summary: {
          total: MODULE_KEYS.length,
          enabled: enabled.size,
          entitled: entitled.size,
        },
      },
      'Module entitlements',
    );
  }),
);

/* ----------------------------------- roles ---------------------------------- */

/**
 * GET /api/society/roles
 *
 * The role catalogue for this society with each role's effective permissions. Roles are seeded per
 * society and can have platform defaults revoked locally, so the effective set is
 * `permissions` minus `revokedPermissions` — that subtraction is what `authenticate` applies.
 */
societyRouter.get(
  '/roles',
  ...guards,
  requirePermission('role:view', 'society:view'),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const roles = await c.db.collection('roles').find(
      { societyId: c.society.id },
      { sort: { scope: 1, role: 1 }, limit: 200 },
    );

    return ok(
      res,
      {
        items: roles.map((role) => {
          const granted = new Set((role.permissions as string[] | undefined) ?? []);
          for (const revoked of (role.revokedPermissions as string[] | undefined) ?? []) granted.delete(revoked);
          return {
            _id: role._id,
            role: role.role,
            label: role.label,
            scope: role.scope,
            description: role.description ?? null,
            isSystem: Boolean(role.isSystem),
            isCustom: Boolean(role.isCustom),
            permissions: Array.from(granted).sort(),
            revokedPermissions: (role.revokedPermissions as string[] | undefined) ?? [],
          };
        }),
        total: roles.length,
      },
      'Roles and permissions',
    );
  }),
);

/* -------------------------------- audit log --------------------------------- */

/**
 * GET /api/society/audit-logs
 *
 * The society's own audit trail (§79). Scoped by the caller's society id from the verified token —
 * never by a query parameter — so one society cannot read another's history even by guessing.
 */
societyRouter.get(
  '/audit-logs',
  ...guards,
  requirePermission('audit:view', 'society:manage'),
  validate(auditQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const q = req.query as z.infer<typeof auditQuerySchema>;
    const { page, limit, skip, sortBy, sortDir } = parsePagination({ ...q, sortBy: 'createdAt', sortDir: 'desc' });

    const filter: Document = { societyId: c.society.id };
    if (q.module) filter.module = q.module;
    if (q.action) filter.action = q.action;
    if (q.actorId) filter.actorId = q.actorId;
    if (q.recordId) filter.recordId = q.recordId;
    if (q.severity) filter.severity = q.severity;
    if (q.from || q.to) {
      const range: Document = {};
      if (q.from) range.$gte = new Date(q.from);
      if (q.to) range.$lte = new Date(q.to);
      filter.createdAt = range;
    }

    const [items, total] = await Promise.all([
      c.db.collection('audit_logs').find(filter, { sort: { [sortBy]: sortDir === 'asc' ? 1 : -1 }, skip, limit }),
      c.db.collection('audit_logs').countDocuments(filter),
    ]);

    return paginated(
      res,
      {
        items: items.map((entry) => serialise(entry, { omit: ['userAgent'] })),
        total,
        page,
        limit,
        sortBy,
        sortDir,
      },
      'Audit trail',
    );
  }),
);

/** Human-readable names for the settings namespaces, so the UI never shows a raw key. */
const NAMESPACE_LABELS: Record<string, string> = {
  visitor: 'Visitors and gate',
  delivery: 'Deliveries',
  maintenance: 'Maintenance billing',
  amenity: 'Amenities and bookings',
  complaint: 'Complaints and SLAs',
  security: 'Security operations',
  emergency: 'Emergency response',
  tax: 'Tax and invoicing',
  notification: 'Notifications',
  theme: 'Branding',
  access: 'Access rules',
};

/** What actually reads each namespace — the reason changing it has an effect. */
const NAMESPACE_DESCRIPTIONS: Record<string, string> = {
  visitor: 'Approval rules, night entry, pass validity and QR reuse at the gate.',
  delivery: 'Whether deliveries need approval, how long they may stay, and who is notified.',
  maintenance: 'Bill generation day, due day, grace period, late fees and the charges per unit.',
  amenity: 'Approval, how far ahead residents may book, cancellation windows and refunds.',
  complaint: 'SLA hours by priority, auto-assignment rules and the resident verification window.',
  security: 'Gate count, vehicle checks, patrol intervals and offline sync for the guard app.',
  emergency: 'Who is alerted when an emergency is raised, and how many alerts may be open.',
  tax: 'GST registration, tax percentages and the invoice and receipt number prefixes.',
  notification: 'Which channels are live, quiet hours, and the channel mix per event.',
  theme: 'Colours and logo used across the resident and staff apps.',
  access: 'What family members, tenants and residents may see and do.',
};
