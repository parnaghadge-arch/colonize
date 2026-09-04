import type { Role } from '../constants/roles.js';

/**
 * API contract types. Every endpoint returns the envelope defined in §52.
 */

export interface ApiSuccess<T = unknown> {
  success: true;
  message: string;
  data: T;
  meta?: ApiMeta;
}

export interface ApiFailure {
  success: false;
  message: string;
  errors?: FieldError[];
  code?: string;
  meta?: ApiMeta;
}

export type ApiResponse<T = unknown> = ApiSuccess<T> | ApiFailure;

export interface FieldError {
  field?: string;
  message: string;
  code?: string;
}

export interface ApiMeta {
  page?: number;
  limit?: number;
  total?: number;
  totalPages?: number;
  hasNext?: boolean;
  hasPrev?: boolean;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  /** Development-only: surfaced OTP so the flow is testable without an SMS gateway. */
  devOtp?: string;
  requestId?: string;
  tookMs?: number;
  [key: string]: unknown;
}

/* --------------------------------- auth --------------------------------- */

export interface AuthenticatedUser {
  id: string;
  email?: string | null;
  phone?: string | null;
  fullName: string;
  roles: Role[];
  permissions: string[];
  /** Society memberships this user holds (a user may belong to several societies). */
  memberships: SocietyMembership[];
  isPlatformUser: boolean;
  avatarUrl?: string | null;
  status: string;
  preferredSocietyId?: string | null;
}

export interface SocietyMembership {
  societyId: string;
  societyName: string;
  societySlug: string;
  roles: Role[];
  /** Unit links for resident-scope users. */
  unitIds?: string[];
  primaryUnitId?: string | null;
  designation?: string | null;
  isActive: boolean;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

export interface LoginResult extends AuthTokens {
  user: AuthenticatedUser;
  /** Set when the user belongs to >1 society and must pick one to continue. */
  requiresSocietySelection?: boolean;
}

export interface DeviceInfo {
  deviceId?: string;
  platform?: 'ios' | 'android' | 'web' | 'unknown';
  appVersion?: string;
  osVersion?: string;
  model?: string;
  pushToken?: string;
  userAgent?: string;
  ip?: string;
}

/* ------------------------------ list responses --------------------------- */

export interface ListResult<T> {
  items: T[];
  meta: Required<Pick<ApiMeta, 'page' | 'limit' | 'total' | 'totalPages'>> & ApiMeta;
}

/* --------------------------------- domain -------------------------------- */

export interface Address {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface AuditStamp {
  createdBy?: string | null;
  updatedBy?: string | null;
  createdAt?: string | Date;
  updatedAt?: string | Date;
  deletedAt?: string | Date | null;
}

export interface AttachmentRef {
  id: string;
  url: string;
  name: string;
  mimeType?: string;
  size?: number;
  kind?: 'image' | 'video' | 'pdf' | 'other';
}

export interface Money {
  amount: number;
  currency: string;
}

/** Timeline entry embedded in complaints / work orders / visitors. */
export interface TimelineEvent {
  at: Date | string;
  actorId?: string | null;
  actorName?: string | null;
  actorRole?: string | null;
  action: string;
  note?: string;
  meta?: Record<string, unknown>;
}

export interface QrPass {
  /** The value encoded in the QR image: an opaque signed token, never PII (§12). */
  token: string;
  kind: 'VISITOR' | 'VEHICLE' | 'STAFF' | 'AMENITY_BOOKING' | 'SOCIETY_ACCESS';
  validFrom: string;
  validTill: string;
  /** PNG data URL, ready to render in a mobile <Image />. */
  dataUrl?: string;
  maxEntries?: number;
  entriesUsed?: number;
  status: 'ACTIVE' | 'USED' | 'EXPIRED' | 'REVOKED';
}

export interface DashboardStats {
  totalUnits: number;
  occupiedUnits: number;
  vacantUnits: number;
  owners: number;
  tenants: number;
  familyMembers: number;
  visitorsToday: number;
  visitorsInside: number;
  deliveriesToday: number;
  staffPresent: number;
  staffTotal: number;
  openComplaints: number;
  overdueComplaints: number;
  pendingPayments: number;
  collectionThisMonth: number;
  outstandingAmount: number;
  expensesThisMonth: number;
  amenityBookingsToday: number;
  activeEmergencies: number;
  pendingAcknowledgements: number;
}

export interface ChartPoint {
  label: string;
  value: number;
  secondaryValue?: number;
}

export interface NotificationDto {
  id: string;
  type: string;
  title: string;
  message: string;
  data?: Record<string, unknown>;
  readAt?: string | null;
  createdAt: string;
  deepLink?: string;
  priority?: string;
}

export interface SelectOption {
  label: string;
  value: string;
}
