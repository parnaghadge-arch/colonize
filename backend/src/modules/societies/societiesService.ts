import {
  DEFAULT_ROLE_PERMISSIONS,
  DEFAULT_TIER_MODULES,
  MODULE_KEYS,
  ROLE_LABELS,
  ROLE_SCOPE,
  expandPermissions,
  normalisePhone,
  type ModuleKey,
} from '@colonize/shared';
import { databases } from '../../db/manager.js';
import type { Document, TenantDatabase } from '../../db/drivers/types.js';
import { newId } from '../../db/ids.js';
import { ApiError } from '../../utils/errors.js';
import { hashPassword } from '../../services/crypto.js';
import { logger } from '../../config/logger.js';
import { logSystemAudit } from '../../services/audit.js';
import { updateSettings } from '../../services/settings.js';
import { importUnitsFromCsv, createBuilding, createWing, generateUnits, type StructureContext } from '../structure/structureService.js';
import { upsertMembership, rebuildForSociety } from '../../services/identityDirectory.js';
import { invalidateSociety } from '../../services/cache.js';

/**
 * Society lifecycle: signup → onboarding → activation → suspension → archive (§41, §45).
 *
 * Every society lives in its own database. Provisioning is the single most important step in
 * the platform: until it succeeds the society has no data and cannot be used, so the wizard
 * tracks it explicitly and it can be retried safely (`provision` is idempotent).
 */

export type SubscriptionTier = 'FREE' | 'STARTER' | 'GROWTH' | 'PRO' | 'ENTERPRISE';
export type OnboardingStep = 'SIGNUP' | 'PROFILE' | 'STRUCTURE' | 'ADMIN' | 'SETTINGS' | 'REVIEW' | 'ACTIVATION' | 'COMPLETED';

export interface SocietiesContext {
  platform: TenantDatabase;
  actorId: string;
  actorName?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

const STEP_ORDER: OnboardingStep[] = ['SIGNUP', 'PROFILE', 'STRUCTURE', 'ADMIN', 'SETTINGS', 'REVIEW', 'ACTIVATION', 'COMPLETED'];

/* -------------------------------- creation --------------------------------- */

export interface CreateSocietyInput {
  name: string;
  slug?: string;
  legalName?: string;
  registrationNumber?: string;
  city: string;
  state?: string;
  country?: string;
  pincode?: string;
  address?: string;
  contactEmail?: string;
  contactPhone?: string;
  timezone?: string;
  currency?: string;
  logoUrl?: string;
  coverImageUrl?: string;
  websiteUrl?: string;
  tier?: SubscriptionTier;
  modules?: ModuleKey[];
  onboardingSource?: string;
}

export async function createSociety(ctx: SocietiesContext, input: CreateSocietyInput): Promise<Document> {
  const name = String(input.name ?? '').trim();
  if (name.length < 3) throw ApiError.badRequest('A society name is required');

  const slug = await uniqueSlug(ctx.platform, input.slug || name);
  const id = newId('societies');
  const databaseName = `clnz_${slug.replace(/[^a-z0-9]/g, '_').slice(0, 48)}`;
  const tier: SubscriptionTier = input.tier ?? 'FREE';
  const modules = (input.modules?.length ? input.modules : DEFAULT_TIER_MODULES[tier]) as ModuleKey[];
  const now = new Date();
  const trialEnd = new Date(now.getTime() + 30 * 86_400_000);

  const limits = tierLimits(tier);
  const society = await ctx.platform.collection('societies').create({
    _id: id,
    name,
    slug,
    legalName: input.legalName ?? name,
    registrationNumber: input.registrationNumber ?? null,
    status: 'ONBOARDING',
    tier,
    modules,
    city: input.city ?? '',
    state: input.state ?? null,
    country: input.country ?? 'IN',
    pincode: input.pincode ?? null,
    address: input.address ?? null,
    timezone: input.timezone ?? 'Asia/Kolkata',
    currency: input.currency ?? 'INR',
    language: 'en',
    contactEmail: input.contactEmail ?? null,
    contactPhone: input.contactPhone ? normalisePhone(input.contactPhone) : null,
    supportContact: null,
    websiteUrl: input.websiteUrl ?? null,
    logoUrl: input.logoUrl ?? null,
    coverImageUrl: input.coverImageUrl ?? null,
    totalUnits: 0,
    totalResidents: 0,
    totalBuildings: 0,
    totalWings: 0,
    totalStaff: 0,
    totalGates: 0,
    databaseName,
    databaseProvisioned: false,
    databaseProvisionedAt: null,
    onboardingStep: 'SIGNUP',
    onboardingStartedAt: now,
    onboardingCompletedAt: null,
    onboardingSource: input.onboardingSource ?? 'self-serve',
    subscription: {
      tier,
      status: 'TRIAL',
      modules,
      startDate: now.toISOString().slice(0, 10),
      endDate: trialEnd.toISOString().slice(0, 10),
      trialEndsAt: trialEnd.toISOString(),
      renewalMode: 'MONTHLY',
      autoRenew: false,
      amount: 0,
      ...limits,
      whatsappEnabled: false,
      paymentGatewayEnabled: tier !== 'FREE',
      biometricEnabled: tier === 'PRO' || tier === 'ENTERPRISE',
    },
    limits,
    features: {},
    isFeatured: false,
    notes: null,
    createdBy: ctx.actorId,
    updatedBy: ctx.actorId,
  });

  await logSystemAudit(ctx.platform, {
    collection: 'platform_audit_logs',
    societyId: id,
    module: 'society',
    action: 'society.created',
    recordId: id,
    recordType: 'society',
    newValue: { name, slug, tier, databaseName },
    meta: { onboardingSource: society.onboardingSource },
    actor: { id: ctx.actorId, name: ctx.actorName ?? null, type: 'PLATFORM' },
  });

  // Provision the private database immediately so the wizard can write structure straight away.
  await provisionSocietyDatabase(society);
  return society;
}

function tierLimits(tier: SubscriptionTier): Document {
  switch (tier) {
    case 'ENTERPRISE':
      return { maxUnits: 100_000, maxAdmins: 100, maxGates: 100, smsCredits: 500_000, storageMb: 1_024_000 };
    case 'PRO':
      return { maxUnits: 5_000, maxAdmins: 50, maxGates: 25, smsCredits: 50_000, storageMb: 204_800 };
    case 'GROWTH':
      return { maxUnits: 1_500, maxAdmins: 20, maxGates: 10, smsCredits: 10_000, storageMb: 51_200 };
    case 'STARTER':
      return { maxUnits: 300, maxAdmins: 8, maxGates: 4, smsCredits: 2_000, storageMb: 10_240 };
    default:
      return { maxUnits: 50, maxAdmins: 3, maxGates: 2, smsCredits: 100, storageMb: 1_024 };
  }
}

/** Create the society's private database, indexes and baseline documents. Idempotent. */
export async function provisionSocietyDatabase(society: Document): Promise<void> {
  if (society.databaseProvisioned) return;
  const platform = await databases.platform();
  await databases.provision({
    id: String(society._id),
    slug: String(society.slug),
    databaseName: String(society.databaseName),
  });
  await platform.collection('societies').updateOne(
    { _id: society._id },
    { $set: { databaseProvisioned: true, databaseProvisionedAt: new Date() } },
  );
  logger.info({ societyId: society._id, databaseName: society.databaseName }, 'society database provisioned');
}

/* ------------------------------ onboarding -------------------------------- */

export async function getOnboardingState(societyId: string): Promise<Document> {
  const platform = await databases.platform();
  const society = await platform.collection('societies').findOne({ _id: societyId });
  if (!society) throw ApiError.notFound('Society');
  const db = await databases.tenantDb(societyId);

  const [buildings, units, users, gates, settings] = await Promise.all([
    db.collection('buildings').countDocuments({ societyId }),
    db.collection('units').countDocuments({ societyId }),
    db.collection('users').countDocuments({ societyId }),
    db.collection('gates').countDocuments({ societyId }),
    db.collection('society_settings').countDocuments({ societyId }),
  ]);

  const index = STEP_ORDER.indexOf((society.onboardingStep ?? 'SIGNUP') as OnboardingStep);
  return {
    society: { id: society._id, name: society.name, slug: society.slug, status: society.status, tier: society.tier },
    currentStep: society.onboardingStep ?? 'SIGNUP',
    completedSteps: STEP_ORDER.slice(0, Math.max(index, 0)),
    databaseProvisioned: Boolean(society.databaseProvisioned),
    counts: { buildings, units, users, gates, settings },
    checklist: [
      { key: 'profile', label: 'Society profile, city and contact details', done: Boolean(society.city && (society.contactEmail || society.contactPhone)), required: true },
      { key: 'structure', label: 'Buildings, wings, floors and units', done: units > 0, required: true },
      { key: 'admin', label: 'At least one administrator who can sign in', done: users > 0, required: true },
      { key: 'gates', label: 'Security gates for the guard app', done: gates > 0, required: false },
      { key: 'settings', label: 'Visitor, complaint and billing rules', done: settings > 0, required: false },
      { key: 'activation', label: 'Activate the society', done: society.status === 'ACTIVE', required: true },
    ],
  };
}

export async function runOnboardingStep(
  ctx: SocietiesContext,
  societyId: string,
  step: OnboardingStep,
  payload: Document,
): Promise<Document> {
  const platform = await databases.platform();
  const society = await platform.collection('societies').findOne({ _id: societyId });
  if (!society) throw ApiError.notFound('Society');
  if (society.status === 'SUSPENDED') throw ApiError.forbidden('This society is suspended', 'SUBSCRIPTION_INACTIVE');
  if (society.status === 'ARCHIVED') throw ApiError.forbidden('This society is archived');

  if (!society.databaseProvisioned) await provisionSocietyDatabase(society);
  const db = await databases.tenantDb(societyId);
  const structureCtx: StructureContext = { db, societyId, actorId: ctx.actorId };
  const dryRun = Boolean(payload.dryRun);
  let result: Document;

  switch (step) {
    case 'PROFILE': {
      const update: Document = {};
      for (const key of [
        'name', 'legalName', 'registrationNumber', 'city', 'state', 'country', 'pincode',
        'address', 'timezone', 'currency', 'logoUrl', 'coverImageUrl', 'contactEmail', 'websiteUrl',
      ]) {
        if (payload[key] !== undefined) update[key] = payload[key];
      }
      if (payload.contactPhone) update.contactPhone = normalisePhone(String(payload.contactPhone));
      update.updatedBy = ctx.actorId;
      await platform.collection('societies').updateOne({ _id: societyId }, { $set: update });
      result = { saved: true, fields: Object.keys(update) };
      break;
    }

    case 'STRUCTURE': {
      if (typeof payload.structureCsv === 'string' && payload.structureCsv.trim()) {
        const imported = await importUnitsFromCsv(structureCtx, payload.structureCsv, { dryRun });
        result = { mode: 'csv', ...imported, units: undefined };
      } else if (Array.isArray(payload.buildings)) {
        result = await applyStructureDeclaration(structureCtx, payload.buildings as Document[], dryRun);
      } else {
        throw ApiError.badRequest('Provide either `buildings` or `structureCsv` for the STRUCTURE step');
      }
      break;
    }

    case 'ADMIN': {
      const admins = (payload.admins ?? (payload.admin ? [payload.admin] : [])) as Document[];
      if (admins.length === 0) throw ApiError.badRequest('At least one administrator is required');
      const createdIds: string[] = [];
      for (const a of admins) {
        const user = await createSocietyAdmin(structureCtx, a, { activate: society.status === 'ACTIVE' });
        createdIds.push(String(user._id));
      }
      result = { adminIds: createdIds, count: createdIds.length };
      break;
    }

    case 'SETTINGS': {
      const namespaces = Object.entries((payload.settings ?? {}) as Record<string, Document>);
      for (const [namespace, values] of namespaces) {
        await updateSettings({ db, societyId }, namespace, values, ctx.actorId);
      }
      result = { namespaces: namespaces.map(([n]) => n) };
      break;
    }

    case 'ACTIVATION': {
      result = await activateSociety(ctx, societyId);
      break;
    }

    default:
      throw ApiError.badRequest(`Unknown onboarding step "${step}"`);
  }

  if (!dryRun) {
    const nextStep = STEP_ORDER[Math.min(STEP_ORDER.indexOf(step) + 1, STEP_ORDER.length - 1)];
    await platform.collection('societies').updateOne({ _id: societyId }, { $set: { onboardingStep: nextStep, updatedAt: new Date() } });
    await refreshSocietyCounters(societyId);
  }
  return { step, ...result };
}

/** Turn the wizard's declarative structure payload into buildings/wings/floors/units. */
async function applyStructureDeclaration(ctx: StructureContext, buildings: Document[], dryRun: boolean): Promise<Document> {
  let buildingsCreated = 0;
  let wingsCreated = 0;
  let unitsCreated = 0;
  const errors: Array<{ message: string }> = [];

  for (const b of buildings) {
    const code = String(b.code ?? b.name ?? '').trim().toUpperCase();
    let building = await ctx.db.collection('buildings').findOne({ societyId: ctx.societyId, code });
    if (!building) {
      if (dryRun) {
        buildingsCreated += 1;
        building = { _id: newId('buildings'), name: b.name, code };
      } else {
        building = await createBuilding(ctx, b);
        buildingsCreated += 1;
      }
    }
    const buildingId = String(building._id);

    const wings = (b.wings ?? []) as Document[];
    if (wings.length === 0) {
      const gen = await generateUnits(ctx, {
        buildingId,
        wingId: null,
        floors: Number(b.totalFloors ?? 1),
        unitsPerFloor: Number(b.unitsPerFloor ?? 0),
        numberingPattern: (b.numberingPattern ?? 'FLOOR_FIRST') as never,
        prefix: b.unitPrefix,
        unitType: b.unitType,
        carpetAreaSqft: Number(b.carpetAreaSqft ?? 0) || undefined,
        createFloors: !dryRun,
      });
      unitsCreated += gen.created;
      continue;
    }

    for (const w of wings) {
      const wingCode = String(w.code ?? w.name ?? '').trim().toUpperCase();
      let wing = await ctx.db.collection('wings').findOne({ societyId: ctx.societyId, buildingId, code: wingCode });
      if (!wing) {
        if (dryRun) {
          wingsCreated += 1;
          wing = { _id: newId('wings'), name: w.name, code: wingCode };
        } else {
          wing = await createWing(ctx, { ...w, buildingId, createFloors: false });
          wingsCreated += 1;
        }
      }
      const gen = await generateUnits(ctx, {
        buildingId,
        wingId: String(wing._id),
        floors: Number(w.totalFloors ?? b.totalFloors ?? 1),
        unitsPerFloor: Number(w.unitsPerFloor ?? b.unitsPerFloor ?? 0),
        numberingPattern: (w.numberingPattern ?? b.numberingPattern ?? 'FLOOR_FIRST') as never,
        prefix: w.unitPrefix ?? w.code ?? b.unitPrefix,
        unitType: b.unitType ?? w.unitType,
        carpetAreaSqft: Number(w.carpetAreaSqft ?? b.carpetAreaSqft ?? 0) || undefined,
        createFloors: !dryRun,
      });
      unitsCreated += gen.created;
    }
  }

  return { mode: 'structured', buildingsCreated, wingsCreated, unitsCreated, errors };
}

/** Create a society administrator inside that society's own database. */
export async function createSocietyAdmin(ctx: StructureContext, input: Document, opts: { activate?: boolean } = {}): Promise<Document> {
  const phone = input.phone ? normalisePhone(String(input.phone)) : null;
  const email = input.email ? String(input.email).toLowerCase().trim() : null;
  if (!phone && !email) throw ApiError.badRequest('An administrator needs a phone number or an email address');

  const existing = await ctx.db.collection('users').findOne({
    societyId: ctx.societyId,
    ...(phone ? { phone } : { email }),
  });

  if (existing) {
    const roles = Array.from(new Set([...((existing.roles as string[]) ?? []), ...((input.roles as string[]) ?? ['SOCIETY_ADMIN'])]));
    await ctx.db.collection('users').updateOne({ _id: existing._id }, { $set: { roles, isActive: opts.activate !== false } });
    return existing;
  }

  const passwordHash = input.password ? await hashPassword(String(input.password)) : null;
  const userId = newId('users');
  const roles = ((input.roles as string[]) ?? ['SOCIETY_ADMIN']) as string[];
  const user = await ctx.db.collection('users').create({
    _id: userId,
    societyId: ctx.societyId,
    fullName: String(input.fullName ?? 'Administrator'),
    phone,
    email,
    passwordHash,
    roles,
    status: opts.activate === false ? 'PENDING' : 'ACTIVE',
    isActive: opts.activate !== false,
    isVerified: Boolean(passwordHash),
    avatarUrl: null,
    gender: null,
    dateOfBirth: null,
    lastLoginAt: null,
    failedLoginCount: 0,
    lockedUntil: null,
    mustChangePassword: !passwordHash,
    pushTokens: [],
    preferences: {},
    createdSource: 'onboarding',
    createdBy: ctx.actorId,
    updatedBy: ctx.actorId,
  });

  // Materialise the default permission set into the society's own roles collection so an
  // administrator can later tweak individual permissions without a code change (§52).
  //
  // The lookup key is `role`, not `name`: `authenticate` and `authService` resolve effective
  // permissions with `{ societyId, role: { $in: userRoles } }`, and the collection carries a
  // unique index on `{ societyId, role }`. Writing `name` instead produced documents no
  // permission check could ever find — and collided on that unique index for every role after
  // the first, because `role` was left unset on all of them.
  const roleDocs = await ctx.db.collection('roles').find({ societyId: ctx.societyId }, { limit: 200 });
  const existingRoles = new Set(roleDocs.map((r) => String(r.role)));
  for (const role of roles) {
    if (existingRoles.has(role)) continue;
    await ctx.db.collection('roles').create({
      _id: newId('roles'),
      societyId: ctx.societyId,
      role,
      label: ROLE_LABELS[role as keyof typeof ROLE_LABELS] ?? role,
      scope: ROLE_SCOPE[role as keyof typeof ROLE_SCOPE] ?? 'society',
      description: `Default role: ${role}`,
      permissions: Array.from(expandPermissions(DEFAULT_ROLE_PERMISSIONS[role as keyof typeof DEFAULT_ROLE_PERMISSIONS] ?? [])),
      revokedPermissions: [],
      isSystem: true,
      isCustom: false,
      updatedBy: ctx.actorId,
    });
  }

  // Register in the cross-society login directory so this person can sign in immediately.
  const society = await (await databases.platform()).collection('societies').findById(ctx.societyId);
  const societyName = String(society?.name ?? '');
  const societySlug = String(society?.slug ?? '');
  const membershipBase = { societyId: ctx.societyId, societyName, societySlug, userId, roles, unitIds: [], isActive: opts.activate !== false };
  if (phone) await upsertMembership({ ...membershipBase, phone });
  if (email) await upsertMembership({ ...membershipBase, email });

  return user;
}

/* ------------------------------ activation --------------------------------- */

/**
 * Roles that make a user an administrator of their society.
 *
 * Exported so the router's admin listing and the activation guard below cannot drift apart — they
 * used to be two copies of the same literal, and the guard did not use either.
 */
export const SOCIETY_ADMIN_ROLES = ['SOCIETY_ADMIN', 'CHAIRMAN', 'SECRETARY', 'TREASURER', 'COMMITTEE_MEMBER'];

export async function activateSociety(ctx: SocietiesContext, societyId: string): Promise<Document> {
  const platform = await databases.platform();
  const society = await platform.collection('societies').findOne({ _id: societyId });
  if (!society) throw ApiError.notFound('Society');
  if (!society.databaseProvisioned) await provisionSocietyDatabase(society);

  const db = await databases.tenantDb(societyId);
  // Count users who hold an administrative role and are not disabled. PENDING counts: an
  // administrator created during onboarding is deliberately left PENDING so they cannot sign in to a
  // half-built society, and the update below is what activates them. Requiring an already-active
  // administrator here made activation unreachable — it needed the very thing it was about to do.
  const [units, admins, gates] = await Promise.all([
    db.collection('units').countDocuments({ societyId }),
    db.collection('users').countDocuments({
      societyId,
      roles: { $in: SOCIETY_ADMIN_ROLES },
      status: { $in: ['PENDING', 'ACTIVE'] },
    }),
    db.collection('gates').countDocuments({ societyId }),
  ]);
  if (units === 0) throw ApiError.badRequest('Create at least one unit before activating the society');
  if (admins === 0) throw ApiError.badRequest('Add at least one administrator before activating the society');

  await platform.collection('societies').updateOne(
    { _id: societyId },
    { $set: { status: 'ACTIVE', onboardingStep: 'COMPLETED', onboardingCompletedAt: new Date(), updatedAt: new Date() } },
  );
  // Pending administrators become active the moment the society goes live. Scoped to the
  // administrative roles so an unrelated pending user is not activated as a side effect.
  await db.collection('users').updateMany(
    { societyId, status: 'PENDING', roles: { $in: SOCIETY_ADMIN_ROLES } },
    { $set: { status: 'ACTIVE', isActive: true } },
  );

  // Same reason as setSocietyStatus: the newly ACTIVE status must be visible to the next request.
  invalidateSociety(societyId);

  // Sign-in resolves identifiers through the platform identity directory, not the tenant `users`
  // collection. An administrator created during onboarding is registered there with
  // `isActive: false` (deliberately: they must not reach a half-built society), so flipping only the
  // user document left the directory saying "inactive" and the new administrator could not sign in
  // even though activation had succeeded. Re-sync it from the users collection.
  await rebuildForSociety(db, { id: societyId, name: String(society.name), slug: String(society.slug) });

  await logSystemAudit(platform, {
    collection: 'platform_audit_logs',
    societyId,
    module: 'society',
    action: 'society.activated',
    recordId: societyId,
    recordType: 'society',
    oldValue: { status: society.status },
    newValue: { status: 'ACTIVE' },
    meta: { units, admins, gates },
    actor: { id: ctx.actorId, name: ctx.actorName ?? null, type: 'PLATFORM' },
  });

  return { activated: true, units, admins, gates, status: 'ACTIVE' };
}

export async function setSocietyStatus(ctx: SocietiesContext, societyId: string, status: string, reason?: string): Promise<Document> {
  const platform = await databases.platform();
  const society = await platform.collection('societies').findOne({ _id: societyId });
  if (!society) throw ApiError.notFound('Society');
  if (!['ONBOARDING', 'ACTIVE', 'SUSPENDED', 'INACTIVE', 'ARCHIVED'].includes(status)) {
    throw ApiError.badRequest(`Invalid society status "${status}"`);
  }

  await platform.collection('societies').updateOne(
    { _id: societyId },
    { $set: { status, updatedAt: new Date(), ...(reason ? { notes: reason } : {}) } },
  );

  // Suspending a society locks every one of its users out on their very next request:
  // middleware/authenticate re-reads the society record (60s cache) and rejects anything that
  // is not ACTIVE/ONBOARDING.
  // Suspension has to bite immediately: `authenticate` re-reads the society document on every
  // request and rejects a non-ACTIVE one, but only if the cached copy is dropped first.
  invalidateSociety(societyId);

  await logSystemAudit(platform, {
    collection: 'platform_audit_logs',
    societyId,
    module: 'society',
    action: `society.${status.toLowerCase()}`,
    recordId: societyId,
    recordType: 'society',
    oldValue: { status: society.status },
    newValue: { status, reason: reason ?? null },
    severity: status === 'SUSPENDED' || status === 'ARCHIVED' ? 'WARNING' : 'INFO',
    actor: { id: ctx.actorId, name: ctx.actorName ?? null, type: 'PLATFORM' },
  });

  return { societyId, status, previousStatus: society.status };
}

/** Rebuild the cross-society login index for one society (admin maintenance action). */
export async function rebuildIdentityDirectory(societyId: string): Promise<Document> {
  const platform = await databases.platform();
  const society = await platform.collection('societies').findById(societyId);
  if (!society) throw ApiError.notFound('Society');
  const db = await databases.tenantDb(societyId);
  return { societyId, ...(await rebuildForSociety(db, { id: societyId, name: String(society.name), slug: String(society.slug) })) };
}

/* --------------------------- counters and stats ---------------------------- */

export async function refreshSocietyCounters(societyId: string): Promise<Document> {
  const platform = await databases.platform();
  const db = await databases.tenantDb(societyId);
  const [buildings, wings, units, residents, staff, gates] = await Promise.all([
    db.collection('buildings').countDocuments({ societyId }),
    db.collection('wings').countDocuments({ societyId }),
    db.collection('units').countDocuments({ societyId }),
    db.collection('residents').countDocuments({ societyId }),
    db.collection('staff').countDocuments({ societyId, isActive: true }),
    db.collection('gates').countDocuments({ societyId }),
  ]);
  const counts = { totalBuildings: buildings, totalWings: wings, totalUnits: units, totalResidents: residents, totalStaff: staff, totalGates: gates };
  await platform.collection('societies').updateOne({ _id: societyId }, { $set: { ...counts, updatedAt: new Date() } });
  return counts;
}

export async function platformStats(platform: TenantDatabase): Promise<Document> {
  const societies = await platform.collection('societies').find({}, { limit: 10_000 });
  const subscriptions = await platform.collection('subscriptions').find(
    { status: { $in: ['ACTIVE', 'TRIAL'] } },
    { limit: 10_000 },
  );

  const byStatus: Record<string, number> = {};
  const byTier: Record<string, number> = {};
  const byCity: Record<string, number> = {};
  let totalUnits = 0;
  let totalResidents = 0;
  let newThisMonth = 0;
  const cutoff = Date.now() - 30 * 86_400_000;

  for (const s of societies) {
    const status = String(s.status ?? 'UNKNOWN');
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    const tier = String(s.tier ?? 'FREE');
    byTier[tier] = (byTier[tier] ?? 0) + 1;
    const city = String(s.city ?? 'Unknown');
    byCity[city] = (byCity[city] ?? 0) + 1;
    totalUnits += Number(s.totalUnits ?? 0);
    totalResidents += Number(s.totalResidents ?? 0);
    if (new Date(String(s.createdAt)).getTime() > cutoff) newThisMonth += 1;
  }

  const mrr = subscriptions.reduce(
    (sum: number, sub: Document) => sum + Number(sub.amount ?? 0) * (sub.renewalMode === 'ANNUAL' ? 1 / 12 : sub.renewalMode === 'QUARTERLY' ? 1 / 3 : 1),
    0,
  );

  return {
    societies: societies.length,
    activeSocieties: byStatus.ACTIVE ?? 0,
    onboardingSocieties: byStatus.ONBOARDING ?? 0,
    suspendedSocieties: byStatus.SUSPENDED ?? 0,
    totalUnits,
    totalResidents,
    monthlyRecurringRevenue: Math.round(mrr * 100) / 100,
    byStatus,
    byTier,
    byCity,
    newThisMonth,
  };
}

async function uniqueSlug(platform: TenantDatabase, candidate: string, attempt = 0): Promise<string> {
  const base =
    String(candidate)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'society';
  const slug = attempt === 0 ? base : `${base}-${attempt + 1}`;
  const existing = await platform.collection('societies').findOne({ slug });
  if (existing) return uniqueSlug(platform, candidate, attempt + 1);
  return slug;
}

export { STEP_ORDER, MODULE_KEYS };
