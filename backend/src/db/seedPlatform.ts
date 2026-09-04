import { DEFAULT_TIER_MODULES, PLAN_TIERS, type ModuleKey, type PlanTier } from '@colonize/shared';
import type { Document, TenantDatabase } from './drivers/types.js';
import { newId } from './ids.js';
import { logger } from '../config/logger.js';

/**
 * Platform-side baseline data (§45 "subscription plans are managed from the Super Admin panel").
 *
 * Unlike a society database, the platform database has no provisioning hook: it exists as soon
 * as the API starts. These helpers are idempotent and run both at boot and from the seed script,
 * so a fresh deployment and a re-seeded one end up with the same catalogue.
 */

interface PlanSpec {
  code: PlanTier;
  name: string;
  description: string;
  /** Flat monthly platform fee, ₹. */
  basePrice: number;
  /** Per-unit monthly fee, ₹ — the part that scales with society size. */
  pricePerUnitPerMonth: number;
  minUnits: number;
  maxUnits: number;
  trialDays: number;
  isFeatured: boolean;
  sortOrder: number;
  limits: Record<string, number>;
}

/**
 * The catalogue the platform ships with. Module sets come from `DEFAULT_TIER_MODULES` so a plan
 * and the entitlements it grants can never drift apart, and pricing/limits are the only things a
 * super admin normally edits.
 */
export const PLAN_CATALOGUE: PlanSpec[] = [
  {
    code: 'FREE',
    name: 'Free',
    description: 'Evaluation tier for a single small society. Core resident, visitor and notice features.',
    basePrice: 0,
    pricePerUnitPerMonth: 0,
    minUnits: 0,
    maxUnits: 50,
    trialDays: 0,
    isFeatured: false,
    sortOrder: 10,
    limits: { maxUnits: 50, maxAdmins: 2, maxGates: 1, smsCredits: 0, storageMb: 512 },
  },
  {
    code: 'BASIC',
    name: 'Basic',
    description: 'Gatekeeping and records for a small society: visitors, vehicles, documents, emergency.',
    basePrice: 999,
    pricePerUnitPerMonth: 2,
    minUnits: 0,
    maxUnits: 200,
    trialDays: 14,
    isFeatured: false,
    sortOrder: 20,
    limits: { maxUnits: 200, maxAdmins: 5, maxGates: 2, smsCredits: 500, storageMb: 5120 },
  },
  {
    code: 'STANDARD',
    name: 'Standard',
    description: 'The full day-to-day package: complaints, amenities, billing, payments, polls and events.',
    basePrice: 2499,
    pricePerUnitPerMonth: 4,
    minUnits: 0,
    maxUnits: 1000,
    trialDays: 14,
    isFeatured: true,
    sortOrder: 30,
    limits: { maxUnits: 1000, maxAdmins: 10, maxGates: 5, smsCredits: 2000, storageMb: 20480 },
  },
  {
    code: 'PREMIUM',
    name: 'Premium',
    description: 'Everything in Standard plus vendors, work orders, accounting and advanced reporting.',
    basePrice: 4999,
    pricePerUnitPerMonth: 6,
    minUnits: 0,
    maxUnits: 5000,
    trialDays: 14,
    isFeatured: true,
    sortOrder: 40,
    limits: { maxUnits: 5000, maxAdmins: 25, maxGates: 10, smsCredits: 5000, storageMb: 51200 },
  },
  {
    code: 'ENTERPRISE',
    name: 'Enterprise',
    description: 'Large and multi-gate communities: every module, automation, GST invoicing and community chat.',
    basePrice: 9999,
    pricePerUnitPerMonth: 8,
    minUnits: 0,
    maxUnits: 100_000,
    trialDays: 30,
    isFeatured: false,
    sortOrder: 50,
    limits: { maxUnits: 100_000, maxAdmins: 100, maxGates: 100, smsCredits: 20_000, storageMb: 204_800 },
  },
];

/**
 * Create any missing plan from the catalogue. Existing plans are left untouched so edits made in
 * the Super Admin panel (pricing, limits, deactivating a tier) survive a restart or a re-seed.
 */
export async function ensureSubscriptionPlans(db: TenantDatabase): Promise<{ created: number; total: number }> {
  const plans = db.collection('subscription_plans');
  const now = new Date();
  let created = 0;

  for (const spec of PLAN_CATALOGUE) {
    const existing = await plans.findOne({ code: spec.code });
    if (existing) continue;
    await plans.create({
      _id: newId('subscription_plans'),
      code: spec.code,
      name: spec.name,
      tier: spec.code,
      description: spec.description,
      basePrice: spec.basePrice,
      pricePerUnitPerMonth: spec.pricePerUnitPerMonth,
      minUnits: spec.minUnits,
      maxUnits: spec.maxUnits,
      modules: (DEFAULT_TIER_MODULES[spec.code] ?? []) as ModuleKey[],
      limits: spec.limits,
      trialDays: spec.trialDays,
      isActive: true,
      isFeatured: spec.isFeatured,
      sortOrder: spec.sortOrder,
      createdAt: now,
      updatedAt: now,
    } as Document);
    created += 1;
  }

  const total = await plans.countDocuments({});
  if (created > 0) logger.info({ created, total }, 'db: subscription plans seeded');
  return { created, total };
}

/**
 * Resolve the plan id for a tier code.
 *
 * `subscriptions.planId` is a required reference to `subscription_plans`, so a subscription can
 * only be written once the plan exists. Bespoke tier codes (a negotiated enterprise deal) are
 * created on the fly from the tier's default module set rather than rejecting the request.
 */
export async function resolvePlanId(db: TenantDatabase, tier: string): Promise<{ planId: string; planCode: string }> {
  const code = String(tier || 'STANDARD').toUpperCase();
  const plans = db.collection('subscription_plans');

  const existing = await plans.findOne({ code });
  if (existing) return { planId: String(existing._id), planCode: code };

  const known = (PLAN_TIERS as readonly string[]).includes(code)
    ? PLAN_CATALOGUE.find((p) => p.code === code)
    : undefined;
  const now = new Date();
  const doc = await plans.create({
    _id: newId('subscription_plans'),
    code,
    name: known?.name ?? code.charAt(0) + code.slice(1).toLowerCase(),
    tier: known?.code ?? 'ENTERPRISE',
    description: known?.description ?? `Custom ${code} plan created when a society subscription was set.`,
    basePrice: known?.basePrice ?? 0,
    pricePerUnitPerMonth: known?.pricePerUnitPerMonth ?? 0,
    minUnits: known?.minUnits ?? 0,
    maxUnits: known?.maxUnits ?? 100_000,
    modules: (DEFAULT_TIER_MODULES[code] ?? DEFAULT_TIER_MODULES.ENTERPRISE ?? []) as ModuleKey[],
    limits: known?.limits ?? {},
    trialDays: known?.trialDays ?? 14,
    isActive: true,
    isFeatured: false,
    sortOrder: known?.sortOrder ?? 90,
    createdAt: now,
    updatedAt: now,
  } as Document);

  logger.info({ code, planId: doc._id }, 'db: subscription plan created on demand');
  return { planId: String(doc._id), planCode: code };
}
