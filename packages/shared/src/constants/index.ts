export * from './roles.js';
export * from './permissions.js';
export * from './enums.js';

/**
 * Feature flags per subscription tier (§42).
 * Modules are switched on/off per society, so a Basic society never sees Complaints even
 * though the code exists. Enforced server-side in `subscription.guard`.
 */
export const MODULE_KEYS = [
  'residents',
  'visitorManagement',
  'notices',
  'complaints',
  'serviceRequests',
  'amenities',
  'payments',
  'maintenanceBilling',
  'accounting',
  'vendorManagement',
  'workOrders',
  'polls',
  'events',
  'documents',
  'emergency',
  'staffAttendance',
  'vehiclesParking',
  'deliveries',
  'cabs',
  'advancedReports',
  'automation',
  'communityChat',
  'multiGate',
  'gstBilling',
] as const;

export type ModuleKey = (typeof MODULE_KEYS)[number];

export const MODULE_LABELS: Record<ModuleKey, string> = {
  residents: 'Resident Management',
  visitorManagement: 'Visitor Management',
  notices: 'Notice Board',
  complaints: 'Complaints / Help Desk',
  serviceRequests: 'Service Requests',
  amenities: 'Amenities & Bookings',
  payments: 'Payments',
  maintenanceBilling: 'Maintenance Billing',
  accounting: 'Accounting',
  vendorManagement: 'Vendor Management',
  workOrders: 'Work Orders',
  polls: 'Polls & Voting',
  events: 'Events',
  documents: 'Documents',
  emergency: 'Emergency',
  staffAttendance: 'Staff & Attendance',
  vehiclesParking: 'Vehicles & Parking',
  deliveries: 'Deliveries',
  cabs: 'Cabs & Drivers',
  advancedReports: 'Advanced Reports',
  automation: 'Automation & Scheduling',
  communityChat: 'Community Chat',
  multiGate: 'Multiple Gates',
  gstBilling: 'GST / Tax Invoicing',
};

/** Default tier → enabled modules. Editable per plan from the Super Admin panel. */
export const DEFAULT_TIER_MODULES: Record<string, ModuleKey[]> = {
  FREE: ['residents', 'visitorManagement', 'notices'],
  BASIC: ['residents', 'visitorManagement', 'notices', 'documents', 'emergency', 'vehiclesParking'],
  STANDARD: [
    'residents',
    'visitorManagement',
    'notices',
    'documents',
    'emergency',
    'vehiclesParking',
    'complaints',
    'serviceRequests',
    'amenities',
    'payments',
    'maintenanceBilling',
    'polls',
    'events',
    'staffAttendance',
    'deliveries',
    'cabs',
    'multiGate',
  ],
  PREMIUM: [...MODULE_KEYS],
  ENTERPRISE: [...MODULE_KEYS],
};

/** Which HTTP-level rate limit bucket a route belongs to. */
export const RATE_LIMIT_BUCKETS = {
  OTP_SEND: { windowMs: 60_000, max: 5 },
  OTP_VERIFY: { windowMs: 60_000, max: 10 },
  AUTH: { windowMs: 15 * 60_000, max: 50 },
  API: { windowMs: 60_000, max: 300 },
  WRITE: { windowMs: 60_000, max: 120 },
  UPLOAD: { windowMs: 60_000, max: 30 },
  EMERGENCY: { windowMs: 60_000, max: 10 },
  EXPORT: { windowMs: 5 * 60_000, max: 10 },
} as const;
