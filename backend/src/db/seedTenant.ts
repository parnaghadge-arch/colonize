import {
  DEFAULT_ROLE_PERMISSIONS,
  ROLE_LABELS,
  ROLE_SCOPE,
  type LedgerGroup,
  type LedgerType,
  DEFAULT_TIER_MODULES,
} from '@colonize/shared';
import type { TenantDatabase } from './drivers/types.js';
import { logger } from '../config/logger.js';

/**
 * Baseline documents every society database needs the moment it is provisioned (§41).
 *
 * Everything here is *data*, not code: an administrator can later change any role's
 * permissions, any business rule and any ledger through the UI, and the platform behaviour
 * follows the stored values.
 */

/** Standard chart of accounts for a housing society (§29). */
export const DEFAULT_LEDGERS: Array<{ name: string; type: LedgerType; group: LedgerGroup; code: string }> = [
  { code: 'INC-MAINT', name: 'Maintenance Income', type: 'MAINTENANCE_INCOME', group: 'INCOME' },
  { code: 'INC-WATER', name: 'Water Charges Income', type: 'WATER_INCOME', group: 'INCOME' },
  { code: 'INC-PARKING', name: 'Parking Income', type: 'PARKING_INCOME', group: 'INCOME' },
  { code: 'INC-AMENITY', name: 'Amenity Booking Income', type: 'AMENITY_INCOME', group: 'INCOME' },
  { code: 'INC-EVENT', name: 'Event Income', type: 'EVENT_INCOME', group: 'INCOME' },
  { code: 'INC-INTEREST', name: 'Interest Income', type: 'INTEREST_INCOME', group: 'INCOME' },
  { code: 'INC-OTHER', name: 'Other Income', type: 'OTHER_INCOME', group: 'INCOME' },
  { code: 'EXP-VENDOR', name: 'Vendor Payments', type: 'VENDOR_EXPENSE', group: 'EXPENSE' },
  { code: 'EXP-ELEC', name: 'Electricity (Common)', type: 'ELECTRICITY_EXPENSE', group: 'EXPENSE' },
  { code: 'EXP-SEC', name: 'Security Agency', type: 'SECURITY_EXPENSE', group: 'EXPENSE' },
  { code: 'EXP-HK', name: 'Housekeeping', type: 'HOUSEKEEPING_EXPENSE', group: 'EXPENSE' },
  { code: 'EXP-REP', name: 'Repairs & Maintenance', type: 'REPAIR_EXPENSE', group: 'EXPENSE' },
  { code: 'EXP-ADM', name: 'Administrative Expenses', type: 'ADMINISTRATIVE_EXPENSE', group: 'EXPENSE' },
  { code: 'EXP-SAL', name: 'Staff Salaries', type: 'SALARY_EXPENSE', group: 'EXPENSE' },
  { code: 'EXP-OTH', name: 'Other Expenses', type: 'OTHER_EXPENSE', group: 'EXPENSE' },
  { code: 'AST-BANK', name: 'Bank Account', type: 'ASSET', group: 'ASSET' },
  { code: 'AST-CASH', name: 'Cash in Hand', type: 'ASSET', group: 'ASSET' },
  { code: 'AST-RECV', name: 'Resident Receivables', type: 'ASSET', group: 'ASSET' },
  { code: 'LIA-PAY', name: 'Vendor Payables', type: 'LIABILITY', group: 'LIABILITY' },
  { code: 'LIA-SINK', name: 'Sinking Fund', type: 'LIABILITY', group: 'LIABILITY' },
  { code: 'LIA-REPF', name: 'Repair & Maintenance Fund', type: 'LIABILITY', group: 'LIABILITY' },
  { code: 'LIA-ADV', name: 'Advances & Deposits', type: 'LIABILITY', group: 'LIABILITY' },
];

/** Default business rules. Copied into `society_settings` so they become editable per society. */
export const DEFAULT_SETTINGS: Record<string, Record<string, unknown>> = {
  visitor: {
    requireResidentApproval: true,
    autoApprovePreApproved: true,
    allowNightEntry: false,
    nightStart: '22:00',
    nightEnd: '06:00',
    passValidityHours: 24,
    maxVisitorsPerDay: 50,
    captureVisitorPhoto: true,
    qrSingleUse: true,
    autoExpireMinutes: 30,
    notifyResidentsOnArrival: true,
  },
  delivery: {
    requireApproval: false,
    allowToDoor: false,
    maxStayMinutes: 30,
    notifyResidents: true,
    knownCompanies: [
      'AMAZON', 'FLIPKART', 'SWIGGY', 'ZOMATO', 'BLINKIT', 'ZEPTO', 'BIGBASKET',
      'DELHIVERY', 'BLUEDART', 'DTDC', 'OTHER',
    ],
  },
  maintenance: {
    generateDayOfMonth: 1,
    dueDayOfMonth: 10,
    graceDays: 5,
    lateFeeType: 'FIXED',
    lateFeeValue: 100,
    billingBasis: 'PER_SQFT',
    ratePerSqft: 3,
    fixedChargePerUnit: 500,
    waterChargePerUnit: 200,
    parkingChargeTwoWheeler: 100,
    parkingChargeFourWheeler: 300,
    clubhouseChargePerUnit: 0,
    autoGenerate: true,
    reminderDaysBeforeDue: [5, 2, 0],
    billableMemberKind: 'OWNER',
    includeSinkingFund: false,
    sinkingFundPerUnit: 0,
  },
  amenity: {
    requireApproval: false,
    maxAdvanceDays: 30,
    cancellationHours: 24,
    refundPercent: 100,
    maxSlotsPerUserPerDay: 2,
    requirePayment: true,
  },
  complaint: {
    slaHoursByPriority: { LOW: 120, MEDIUM: 72, HIGH: 24, URGENT: 8 },
    autoAssign: false,
    requireResidentVerification: true,
    reopenWindowDays: 7,
    escalationAfterHours: 48,
    defaultCategoryAssignments: {
      PLUMBING: { type: 'STAFF', staffType: 'PLUMBER' },
      ELECTRICAL: { type: 'STAFF', staffType: 'ELECTRICIAN' },
      LIFT: { type: 'VENDOR', serviceCategory: 'LIFT_MAINTENANCE' },
      CLEANING: { type: 'STAFF', staffType: 'HOUSEKEEPING' },
      GARBAGE: { type: 'STAFF', staffType: 'HOUSEKEEPING' },
      SECURITY: { type: 'STAFF', staffType: 'SECURITY' },
      GARDEN: { type: 'STAFF', staffType: 'GARDENER' },
    },
  },
  security: {
    gates: 1,
    vehicleCheck: true,
    staffBiometric: false,
    patrolIntervalMinutes: 0,
    offlineSyncEnabled: true,
    maxOfflineQueueSize: 500,
  },
  emergency: {
    contacts: [],
    autoAlertAdmin: true,
    autoAlertSecurity: true,
    autoAlertCommittee: false,
    maxActiveAlerts: 50,
  },
  tax: {
    enabled: false,
    gstin: null,
    cgstPercent: 0,
    sgstPercent: 0,
    igstPercent: 0,
    invoicePrefix: 'INV',
    receiptPrefix: 'RCP',
  },
  notification: {
    pushEnabled: true,
    smsEnabled: false,
    emailEnabled: true,
    whatsappEnabled: false,
    quietHoursStart: null,
    quietHoursEnd: null,
    channelsByEvent: {
      EMERGENCY_ALERT: ['PUSH', 'IN_APP', 'SMS'],
      VISITOR_ARRIVED: ['PUSH', 'IN_APP'],
      DELIVERY_ARRIVED: ['PUSH', 'IN_APP'],
      BILL_GENERATED: ['PUSH', 'IN_APP', 'EMAIL'],
      PAYMENT_RECEIVED: ['PUSH', 'IN_APP', 'EMAIL'],
      NOTICE_PUBLISHED: ['PUSH', 'IN_APP'],
    },
  },
  theme: {
    primaryColor: '#4F46E5',
    accentColor: '#0EA5E9',
    logoUrl: null,
  },
  access: {
    familyMemberCanApproveVisitors: false,
    tenantCanViewBills: true,
    tenantCanMakePayments: true,
    residentCanSeeOtherResidents: true,
    exposePhoneNumbers: false,
  },
};

export interface SeedTenantInput {
  id: string;
  slug: string;
  databaseName: string;
  planTier?: string;
  modules?: string[];
  timezone?: string;
  currency?: string;
}

/**
 * Seed roles, settings, ledgers and the subscription mirror. Idempotent: re-running on an
 * already-provisioned society only fills in what is missing, never overwrites edits.
 */
export async function seedTenantBasics(db: TenantDatabase, society: SeedTenantInput): Promise<void> {
  const societyId = society.id;
  const now = new Date();

  /* ---- roles & permissions ---- */
  const roles = db.collection('roles');
  const existingRoles = new Set((await roles.find({}, { projection: { role: 1 } })).map((r) => r.role));
  const toCreate = Object.entries(DEFAULT_ROLE_PERMISSIONS)
    .filter(([role]) => !existingRoles.has(role))
    // Platform-scope roles are not granted inside a society database.
    .filter(([role]) => ROLE_SCOPE[role as keyof typeof ROLE_SCOPE] !== 'platform')
    .map(([role, permissions]) => ({
      _id: `rol_${role.toLowerCase()}`,
      societyId,
      role,
      label: ROLE_LABELS[role as keyof typeof ROLE_LABELS] ?? role,
      scope: ROLE_SCOPE[role as keyof typeof ROLE_SCOPE] ?? 'society',
      permissions,
      revokedPermissions: [],
      isSystem: true,
      isCustom: false,
      description: 'System role — permissions can be customised for this society.',
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }));
  if (toCreate.length > 0) await roles.insertMany(toCreate, { skipUniqueCheck: true });

  /* ---- settings ---- */
  const settings = db.collection('society_settings');
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    const existing = await settings.findOne({ societyId, key });
    if (existing) continue;
    await settings.create({
      _id: `set_${key}`,
      societyId,
      key,
      value,
      description: `Default ${key} configuration — editable by society administrators.`,
    });
  }

  /* ---- ledgers ---- */
  const ledgers = db.collection('ledgers');
  const existingLedgers = new Set((await ledgers.find({}, { projection: { name: 1 } })).map((l) => l.name));
  const ledgersToCreate = DEFAULT_LEDGERS.filter((l) => !existingLedgers.has(l.name)).map((l) => ({
    societyId,
    name: l.name,
    code: l.code,
    type: l.type,
    group: l.group,
    openingBalance: 0,
    currentBalance: 0,
    isSystem: true,
    isActive: true,
    description: 'System ledger created during society provisioning.',
  }));
  if (ledgersToCreate.length > 0) await ledgers.insertMany(ledgersToCreate, { skipUniqueCheck: true });

  /* ---- subscription mirror (module gating without a cross-database read) ---- */
  const subscriptions = db.collection('subscriptions');
  const tier = society.planTier ?? 'STANDARD';
  const modules = society.modules ?? DEFAULT_TIER_MODULES[tier] ?? DEFAULT_TIER_MODULES.STANDARD;
  const existingSub = await subscriptions.findOne({ societyId });
  if (!existingSub) {
    await subscriptions.create({
      _id: `sub_${society.slug}`,
      societyId,
      planId: `plan_${tier.toLowerCase()}`,
      planCode: tier,
      tier,
      status: 'TRIAL',
      startDate: now,
      endDate: new Date(now.getTime() + 14 * 86400000),
      billingCycle: 'MONTHLY',
      modules,
      limits: {},
      autoRenew: true,
      syncedFromPlatformAt: now,
    });
  }

  logger.debug({ society: society.slug, roles: toCreate.length, ledgers: ledgersToCreate.length }, 'db: tenant baseline seeded');
}
