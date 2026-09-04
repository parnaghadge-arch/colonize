/**
 * Platform-side types (§41, §45, §46, §79).
 *
 * Field names mirror the platform `societies` document exactly — including `pincode` and
 * `websiteUrl`, which the tenant-facing self-service API historically misspelt as `postalCode` and
 * `website`. Getting these right matters: a name the server does not store is a setting that
 * appears to save and does not.
 */

/**
 * The 24 feature modules a plan can entitle a society to. Mirrors `MODULE_KEYS` in
 * @colonize/shared; re-declared here so the control plane has one import surface for its enums.
 */
export const MODULE_KEYS = [
  'residents', 'visitorManagement', 'notices', 'complaints', 'serviceRequests', 'amenities',
  'payments', 'maintenanceBilling', 'accounting', 'vendorManagement', 'workOrders', 'polls',
  'events', 'documents', 'emergency', 'staffAttendance', 'vehiclesParking', 'deliveries',
  'cabs', 'advancedReports', 'automation', 'communityChat', 'multiGate', 'gstBilling',
] as const;
export type ModuleKey = (typeof MODULE_KEYS)[number];

/** The catalogue the platform actually seeds. Kept in step with `PLAN_TIERS` in @colonize/shared. */
export const PLAN_CODES = ['FREE', 'BASIC', 'STANDARD', 'PREMIUM', 'ENTERPRISE'] as const;
export type PlanCode = (typeof PLAN_CODES)[number];

export const SOCIETY_STATUSES = ['ONBOARDING', 'ACTIVE', 'SUSPENDED', 'INACTIVE', 'ARCHIVED'] as const;
export type SocietyStatus = (typeof SOCIETY_STATUSES)[number];

export const SUBSCRIPTION_STATUSES = ['TRIAL', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED', 'SUSPENDED'] as const;

export const RENEWAL_MODES = ['MONTHLY', 'QUARTERLY', 'ANNUAL'] as const;

/**
 * Roles that count as an administrator of a society.
 *
 * Mirrors `SOCIETY_ADMIN_ROLES` in the backend's societies service, which is both the filter on
 * `GET /:id/admins` and the count the activation guard requires. Offering a role outside this list
 * would create a console user who does not satisfy activation; `MANAGING_COMMITTEE` was previously
 * offered here and is not a role the platform defines at all, so it carried no permissions.
 */
export const ADMIN_ROLES = ['SOCIETY_ADMIN', 'CHAIRMAN', 'SECRETARY', 'TREASURER', 'COMMITTEE_MEMBER'] as const;

export const ONBOARDING_STEPS = ['PROFILE', 'STRUCTURE', 'ADMIN', 'SETTINGS', 'ACTIVATION'] as const;

export interface Subscription {
  planId?: string | null;
  planCode?: string | null;
  tier?: string | null;
  status?: string | null;
  renewalMode?: string | null;
  billingCycle?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  amount?: number | null;
  autoRenew?: boolean;
  limits?: Record<string, number> | null;
  modules?: string[] | null;
  whatsappEnabled?: boolean;
  paymentGatewayEnabled?: boolean;
  biometricEnabled?: boolean;
  syncedFromPlatformAt?: string | null;
  outOfSync?: boolean;
}

export interface Society {
  _id: string;
  name: string;
  slug: string;
  legalName?: string | null;
  registrationNumber?: string | null;
  status: string;
  tier?: string | null;
  modules?: string[];
  city?: string | null;
  state?: string | null;
  country?: string | null;
  pincode?: string | null;
  address?: string | null;
  timezone?: string | null;
  currency?: string | null;
  language?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  supportContact?: string | null;
  websiteUrl?: string | null;
  logoUrl?: string | null;
  coverImageUrl?: string | null;
  gstin?: string | null;
  totalUnits?: number;
  totalResidents?: number;
  totalBuildings?: number;
  totalWings?: number;
  totalStaff?: number;
  totalGates?: number;
  databaseName?: string | null;
  databaseProvisioned?: boolean;
  databaseProvisionedAt?: string | null;
  onboardingStep?: string | null;
  onboardingStartedAt?: string | null;
  onboardingCompletedAt?: string | null;
  onboardingSource?: string | null;
  subscription?: Subscription | null;
  limits?: Record<string, number> | null;
  features?: Record<string, unknown> | null;
  isFeatured?: boolean;
  notes?: string | null;
  provisioning?: Record<string, unknown> | null;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
}

/** `GET /platform/societies/:id` adds a live unit breakdown and the onboarding state. */
export interface SocietyDetail extends Society {
  unitCounts?: Record<string, number>;
  onboarding?: OnboardingState | null;
  updatedByPlatformUserId?: string | null;
}

export interface OnboardingChecklistItem {
  key: string;
  label: string;
  done: boolean;
  required: boolean;
}

export interface OnboardingState {
  society?: { id?: string; name?: string; slug?: string; status?: string; tier?: string };
  currentStep?: string;
  completedSteps?: string[];
  databaseProvisioned?: boolean;
  counts?: Record<string, number>;
  checklist?: OnboardingChecklistItem[];
  readyToActivate?: boolean;
  blockers?: string[];
}

export interface SocietyStats {
  society?: { id?: string; name?: string; slug?: string; status?: string; tier?: string };
  units?: {
    total?: number;
    occupied?: number;
    vacant?: number;
    locked?: number;
    underMaintenance?: number;
    byOccupancy?: Record<string, number>;
  };
  residents?: number;
  staff?: number;
  vendors?: number;
  visitorsLast30Days?: number;
  openComplaints?: number;
  billedTotal?: number;
  outstanding?: number;
  collected?: number;
  activeBookings?: number;
}

export interface PlatformOverview {
  societies?: number;
  activeSocieties?: number;
  onboardingSocieties?: number;
  suspendedSocieties?: number;
  totalUnits?: number;
  totalResidents?: number;
  monthlyRecurringRevenue?: number;
  byStatus?: Record<string, number>;
  byTier?: Record<string, number>;
  byCity?: Record<string, number>;
  newThisMonth?: number;
}

export interface SocietyAdmin {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  roles: string[];
  status: string;
  lastLoginAt: string | null;
  mustChangePassword: boolean;
}

export interface PlatformAuditLog {
  _id: string;
  societyId?: string | null;
  actorId?: string | null;
  actorType?: string;
  actorName?: string | null;
  actorRoles?: string[];
  action: string;
  module?: string;
  recordId?: string | null;
  recordType?: string;
  oldValue?: Record<string, unknown> | null;
  newValue?: Record<string, unknown> | null;
  changedFields?: string[];
  severity?: string;
  status?: string;
  errorMessage?: string | null;
  requestId?: string | null;
  platform?: string | null;
  createdAt?: string;
}
