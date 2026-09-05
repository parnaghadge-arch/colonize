/**
 * Domain shapes as the API returns them (security-app subset).
 * Keep in sync with the web console's `types.ts`; the full contract lives in `@colonize/shared`.
 */

export interface WhoAmIUser {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  avatarUrl: string | null;
  roles: string[];
  scope: string;
}

export interface WhoAmISociety {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  currency: string;
}

export interface WhoAmIMembership {
  unitIds: string[];
  primaryUnitId: string | null;
  residentId: string | null;
  staffId: string | null;
  vendorId: string | null;
  gateIds: string[];
}

export interface WhoAmI {
  user: WhoAmIUser;
  society: WhoAmISociety;
  membership: WhoAmIMembership;
  permissions: string[];
  enabledModules: string[];
  clientHints?: {
    isResidentScope: boolean;
    isStaffScope: boolean;
    isSecurityScope: boolean;
  };
}

export interface LoginResult {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  expiresIn?: number;
  sessionId?: string;
  user: {
    id: string;
    fullName: string;
    email: string | null;
    phone: string | null;
    roles: string[];
    memberships?: Array<{ societyId: string; societyName?: string; roles?: string[] }>;
    preferredSocietyId?: string | null;
  };
  requiresSocietySelection?: boolean;
}

/* ---------------------------------- gates ---------------------------------- */

export interface Gate {
  _id: string;
  id?: string;
  name: string;
  code?: string;
  type?: string;
  isActive?: boolean;
  entriesToday?: number;
  lastEntryAt?: string | null;
  [key: string]: unknown;
}

export interface ShiftInfo {
  shiftLogId?: string;
  gateId?: string;
  loginAt?: string;
  alreadyOnDuty?: boolean;
  [key: string]: unknown;
}

/* --------------------------------- gate queue ------------------------------- */

export interface QueueUnit {
  id: string;
  label?: string;
}

export interface QueueVisitor {
  id: string;
  visitorName: string;
  visitorPhone?: string | null;
  purpose?: string;
  visitorType?: string;
  status: string;
  numberOfVisitors?: number;
  vehicleNumber?: string | null;
  source?: string;
  unit: QueueUnit | null;
  expectedArrival?: string | null;
  entryTime?: string | null;
  createdAt?: string;
  hasPass?: boolean;
  [key: string]: unknown;
}

export interface GateQueue {
  awaitingApproval: QueueVisitor[];
  approvedNotEntered: QueueVisitor[];
  inside: QueueVisitor[];
  recentActivity: GateActivity[];
  counts: {
    awaiting: number;
    inside: number;
    entriesToday: number;
    exitsToday: number;
  };
  [key: string]: unknown;
}

export interface GateActivity {
  id: string;
  direction: 'IN' | 'OUT';
  entryType?: string;
  personName?: string;
  vehicleNumber?: string | null;
  at: string;
  method?: string;
  unitId?: string;
  [key: string]: unknown;
}

/* ------------------------------ security dashboard -------------------------- */

export interface GuardOnDuty {
  staffId: string;
  userId: string;
  gateId: string;
  shift?: string;
  loginAt: string;
}

export interface HourlyCounts {
  hour: string;
  in: number;
  out: number;
}

export interface SecurityDashboard {
  gates: Gate[];
  guardsOnDuty: GuardOnDuty[];
  deliveriesToday: number;
  hourly: HourlyCounts[];
  byHour?: Record<string, { in: number; out: number }>;
  queue: GateQueue;
  [key: string]: unknown;
}

/* ---------------------------------- scanning -------------------------------- */

export interface ScanEntity {
  visitorName?: string;
  name?: string;
  unitLabel?: string;
  purpose?: string;
  vehicleNumber?: string | null;
  [key: string]: unknown;
}

export interface ScanResult {
  valid: boolean;
  kind?: string;
  reason?: string | null;
  entity?: ScanEntity | null;
  entry?: { direction?: string; at?: string; [key: string]: unknown } | null;
  visitor?: { visitorName?: string; [key: string]: unknown } | null;
  pass?: { [key: string]: unknown } | null;
  method?: string;
  durationMinutes?: number;
  [key: string]: unknown;
}

/* ---------------------------------- entry log ------------------------------- */

export interface EntryLogRow {
  _id: string;
  direction: 'IN' | 'OUT';
  entryType?: string;
  personName?: string;
  visitorName?: string;
  vehicleNumber?: string | null;
  at: string;
  method?: string;
  gateId?: string;
  unitId?: string;
  unitLabel?: string;
  notes?: string;
  [key: string]: unknown;
}
