/**
 * Domain shapes as the API returns them (resident-app subset).
 *
 * Only the fields the app renders are declared — the API returns more, and index
 * signatures keep that from becoming a type error. Keep in sync with the web
 * console's `types.ts`; the full contract lives in `@colonize/shared`.
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

export interface OtpChallenge {
  requestId: string;
  channel: string;
  maskedTarget: string;
  otpLength: number;
  resendCooldownSeconds: number;
  expiresAt: string;
  /** Present only when the backend runs with EXPOSE_DEV_OTP=true. */
  devOtp?: string;
}

/* --------------------------------- units ----------------------------------- */

export interface UnitRef {
  _id: string;
  label?: string;
  unitNumber?: string;
  building?: { name: string; code?: string };
  [key: string]: unknown;
}

/* --------------------------------- complaints ------------------------------ */

export const COMPLAINT_CATEGORIES = [
  'PLUMBING',
  'ELECTRICAL',
  'LIFT',
  'SECURITY',
  'CLEANING',
  'PARKING',
  'WATER',
  'GARBAGE',
  'MAINTENANCE',
  'COMMON_AREA',
  'PEST_CONTROL',
  'GARDEN',
  'NOISE',
  'NETWORK',
  'OTHER',
] as const;
export type ComplaintCategory = (typeof COMPLAINT_CATEGORIES)[number];

export const COMPLAINT_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;

export interface Complaint {
  _id: string;
  referenceNumber?: string;
  category: string;
  title: string;
  description?: string;
  status: string;
  priority?: string;
  locationType?: string;
  locationText?: string;
  unitLabel?: string;
  raisedBy?: string;
  assigneeName?: string | null;
  workOrderId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  resolvedAt?: string | null;
  [key: string]: unknown;
}

export interface ComplaintComment {
  _id?: string;
  body?: string;
  comment?: string;
  authorName?: string;
  createdAt?: string;
  [key: string]: unknown;
}

/* ---------------------------------- bills ---------------------------------- */

export interface Bill {
  _id: string;
  invoiceNumber?: string;
  unitId: string;
  unitLabel?: string | null;
  residentName?: string | null;
  period: string;
  periodStart?: string | null;
  periodEnd?: string | null;
  dueDate: string;
  status: string;
  subtotal?: number;
  totalTax?: number;
  penalty?: number;
  lateFee?: number;
  totalAmount: number;
  paidAmount: number;
  dueAmount: number;
  currency?: string;
  createdAt?: string;
  items?: Array<{ description?: string; label?: string; name?: string; amount: number }>;
  [key: string]: unknown;
}

export interface PaymentOrder {
  orderId: string;
  amount?: number;
  currency?: string;
  /** Present for the mock gateway so a dev client can complete the flow end to end. */
  mockPaymentId?: string;
  mockSignature?: string;
  [key: string]: unknown;
}

export interface Payment {
  _id: string;
  receiptNumber?: string | null;
  unitId?: string | null;
  billId?: string | null;
  purpose?: string | null;
  amount?: number | null;
  mode?: string | null;
  method?: string | null;
  status: string;
  transactionId?: string | null;
  paidAt?: string | null;
  [key: string]: unknown;
}

export interface VerifyResult {
  payment: Payment;
  receipt?: { receiptNumber?: string; [key: string]: unknown } | null;
  alreadyProcessed?: boolean;
}

/* --------------------------------- visitors -------------------------------- */

export const VISITOR_TYPES = ['GUEST', 'RELATIVE', 'FRIEND', 'CAB', 'DELIVERY'] as const;

export interface Visitor {
  _id: string;
  visitorName?: string;
  name?: string;
  visitorPhone?: string;
  phone?: string;
  purpose?: string;
  visitorType?: string;
  status: string;
  unitId?: string;
  unitLabel?: string;
  visitDate?: string;
  expectedArrival?: string | null;
  expectedDeparture?: string | null;
  vehicleNumber?: string | null;
  numberOfVisitors?: number;
  checkInAt?: string | null;
  checkOutAt?: string | null;
  gateName?: string;
  notes?: string | null;
  createdAt?: string;
  [key: string]: unknown;
}

export interface QrPass {
  passId: string;
  token: string;
  dataUrl: string;
  validFrom?: string;
  validTill?: string;
  entriesUsed?: number;
  maxEntries?: number;
  visitor?: { name?: string; purpose?: string; visitorType?: string };
}

/* --------------------------------- amenities -------------------------------- */

export interface Amenity {
  _id: string;
  name: string;
  type?: string | null;
  description?: string | null;
  rules?: string[];
  capacity?: number | null;
  openTime?: string | null;
  closeTime?: string | null;
  slotDurationMinutes?: number | null;
  bookingFee?: number | null;
  deposit?: number | null;
  requireApproval?: boolean;
  allowCancellation?: boolean;
  isActive?: boolean;
  location?: string | null;
  [key: string]: unknown;
}

export interface AmenitySlot {
  slotId: string;
  startTime: string;
  endTime: string;
  capacity: number;
  booked: number;
  remaining: number;
  fee: number;
  deposit: number;
  available: boolean;
  isPast: boolean;
}

export interface Availability {
  amenityId: string;
  date: string;
  timezone?: string;
  closed: boolean;
  slots: AmenitySlot[];
}

export interface AmenityBooking {
  _id: string;
  referenceNumber?: string;
  amenityId?: string;
  slotId?: string | null;
  date: string;
  startTime?: string;
  endTime?: string;
  numberOfPeople?: number | null;
  status: string;
  fee?: number | null;
  deposit?: number | null;
  totalAmount?: number | null;
  isPaid?: boolean;
  passId?: string | null;
  rejectReason?: string | null;
  createdAt?: string;
  amenity?: { name?: string } | null;
  unitLabel?: string;
  amenityName?: string;
  [key: string]: unknown;
}
