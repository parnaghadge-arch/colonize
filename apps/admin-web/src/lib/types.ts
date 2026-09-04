/**
 * Domain shapes as the API returns them.
 *
 * Only the fields the console actually renders are declared — the API returns more, and
 * `Record<string, unknown>` index signatures keep that from being a type error.
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

export interface ClientHints {
  isResidentScope: boolean;
  isStaffScope: boolean;
  isSecurityScope: boolean;
  isVendorScope: boolean;
  isPlatformUser: boolean;
}

export interface WhoAmI {
  user: WhoAmIUser;
  society: WhoAmISociety;
  membership: WhoAmIMembership;
  permissions: string[];
  enabledModules: string[];
  clientHints: ClientHints;
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

export interface SendOtpResult {
  requestId: string;
  channel: string;
  expiresAt: string;
  maskedTarget: string;
  otpLength: number;
  resendCooldownSeconds: number;
}

/* --------------------------------- structure -------------------------------- */

export interface Building {
  _id: string;
  name: string;
  code: string;
  floors?: number;
  unitCount?: number;
  isActive?: boolean;
}

export interface Wing {
  _id: string;
  name: string;
  code: string;
  buildingId: string;
  floors?: number;
  unitCount?: number;
}

export interface Floor {
  _id: string;
  number: number;
  buildingId: string;
  wingId: string | null;
  unitCount?: number;
}

export interface Unit {
  _id: string;
  label: string;
  unitNumber: string;
  buildingId: string;
  wingId: string | null;
  floorId: string | null;
  floorNumber: number;
  type: string;
  status: string;
  occupancyType: string;
  carpetAreaSqft?: number | null;
  bedrooms?: number | null;
  ownerCount?: number;
  tenantCount?: number;
  familyCount?: number;
  vehicleCount?: number;
  outstandingAmount?: number;
  building?: { name: string; code: string };
  wing?: { name: string; code: string } | null;
}

export interface StructureCounts {
  total: number;
  occupied: number;
  vacant: number;
  locked: number;
  underMaintenance: number;
  byOccupancy: Record<string, number>;
}

export interface StructureTreeNode {
  _id: string;
  name: string;
  code?: string;
  kind?: string;
  unitCount?: number;
  wings?: StructureTreeNode[];
  floors?: StructureTreeNode[];
  units?: StructureTreeNode[];
}

/* ---------------------------------- people ---------------------------------- */

export interface Resident {
  _id: string;
  fullName: string;
  phone?: string;
  email?: string;
  kind?: string;
  unitId?: string;
  unitLabel?: string;
  isActive?: boolean;
  isPrimary?: boolean;
  moveInDate?: string | null;
  status?: string;
  occupation?: string | null;
  [key: string]: unknown;
}

export interface Address {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  pincode?: string;
}

export interface Vendor {
  _id: string;
  businessName: string;
  contactPersonName?: string | null;
  phone?: string;
  alternatePhone?: string | null;
  email?: string | null;
  address?: Address | null;
  gstin?: string | null;
  pan?: string | null;
  serviceCategories?: string[];
  contractType?: string;
  contractValue?: number;
  paymentTermsDays?: number;
  startDate?: string | null;
  endDate?: string | null;
  rating?: number;
  totalWorkOrders?: number;
  completedWorkOrders?: number;
  outstandingPayable?: number;
  allowPortalLogin?: boolean;
  status?: string;
  documents?: Array<{ _id?: string; name?: string; kind?: string }>;
  createdAt?: string;
  [key: string]: unknown;
}

export interface Staff {
  _id: string;
  fullName: string;
  phone?: string;
  email?: string | null;
  type?: string;
  employmentType?: string;
  workType?: string;
  shift?: string;
  address?: string | null;
  idProofType?: string | null;
  joiningDate?: string | null;
  exitDate?: string | null;
  monthlySalary?: number | null;
  startTime?: string | null;
  endTime?: string | null;
  gateId?: string | null;
  vendorId?: string | null;
  allowLogin?: boolean;
  status?: string;
  policeVerificationStatus?: string | null;
  rating?: number;
  lastEntryAt?: string | null;
  createdAt?: string;
  [key: string]: unknown;
}

export interface WorkOrder {
  _id: string;
  referenceNumber?: string;
  title: string;
  description?: string | null;
  status?: string;
  category?: string | null;
  priority?: string;
  complaintId?: string | null;
  serviceRequestId?: string | null;
  vendorId?: string | null;
  assigneeType?: string | null;
  assigneeId?: string | null;
  assigneeName?: string | null;
  unitId?: string | null;
  unitLabel?: string | null;
  buildingId?: string | null;
  amenityId?: string | null;
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  estimatedCost?: number | null;
  actualCost?: number | null;
  progressPercent?: number | null;
  materialRequired?: string | null;
  history?: Array<{ _id?: string; at: string; status: string; actorName?: string; note?: string }>;
  createdAt?: string;
  /** Populated server-side by the work-orders list/detail routes. */
  vendor?: { _id?: string; businessName?: string; phone?: string } | null;
  unit?: { _id?: string; label?: string; unitNumber?: string } | null;
  complaint?: { _id?: string; referenceNumber?: string; title?: string } | null;
  [key: string]: unknown;
}

/* --------------------------------- visitors --------------------------------- */

export interface Visitor {
  _id: string;
  name: string;
  phone?: string;
  purpose?: string;
  visitorType?: string;
  status: string;
  unitId?: string;
  unitLabel?: string;
  expectedArrival?: string | null;
  checkInAt?: string | null;
  checkOutAt?: string | null;
  gateName?: string;
  [key: string]: unknown;
}

export interface QrPass {
  passId: string;
  token: string;
  dataUrl: string;
  validFrom?: string;
  validTill?: string;
  maxEntries?: number;
}

export interface PreApproveResult {
  visitor: Visitor;
  unitLabel?: string;
  qr?: QrPass;
}

export interface GateQueueItem {
  _id: string;
  name: string;
  phone?: string;
  purpose?: string;
  visitorType?: string;
  unitLabel?: string;
  waitingSince?: string;
  status: string;
  [key: string]: unknown;
}

export interface ScanResult {
  decision: string;
  visitor?: Visitor;
  pass?: Record<string, unknown>;
  entry?: Record<string, unknown>;
  message?: string;
  unitLabel?: string;
  [key: string]: unknown;
}

/* --------------------------------- helpdesk --------------------------------- */

export interface Complaint {
  _id: string;
  referenceNumber?: string;
  category: string;
  title: string;
  description?: string;
  status: string;
  priority?: string;
  unitLabel?: string;
  raisedBy?: string;
  assigneeName?: string | null;
  assigneeType?: string | null;
  workOrderId?: string | null;
  createdAt?: string;
  resolvedAt?: string | null;
  [key: string]: unknown;
}

export interface ComplaintComment {
  _id: string;
  body?: string;
  comment?: string;
  authorName?: string;
  createdAt?: string;
  [key: string]: unknown;
}

/* ---------------------------------- finance --------------------------------- */

export interface Bill {
  _id: string;
  invoiceNumber?: string;
  unitId: string;
  unitLabel?: string | null;
  residentId?: string | null;
  residentName?: string | null;
  period: string;
  periodStart?: string | null;
  periodEnd?: string | null;
  generatedAt?: string | null;
  dueDate: string;
  status: string;
  subtotal?: number;
  discount?: number;
  discountReason?: string | null;
  taxBreakup?: TaxBreakup;
  totalTax?: number;
  arrears?: number;
  penalty?: number;
  lateFee?: number;
  totalAmount: number;
  paidAmount: number;
  dueAmount: number;
  waivedAmount?: number;
  refundedAmount?: number;
  currency?: string;
  notes?: string | null;
  itemCount?: number;
  paymentIds?: string[];
  items?: BillItem[];
  createdAt?: string;
  [key: string]: unknown;
}

export interface BillItem {
  _id?: string;
  description?: string;
  label?: string;
  name?: string;
  amount: number;
  quantity?: number;
  rate?: number;
  category?: string;
}

export interface TaxBreakup {
  cgst?: number;
  sgst?: number;
  igst?: number;
  cess?: number;
  taxableAmount?: number;
}

export interface Payment {
  _id: string;
  societyId?: string;
  receiptNumber?: string | null;
  unitId?: string | null;
  userId?: string | null;
  billId?: string | null;
  purpose?: string | null;
  amount?: number | null;
  mode?: string | null;
  method?: string | null;
  status: string;
  gateway?: string | null;
  transactionId?: string | null;
  referenceNumber?: string | null;
  paidAt?: string | null;
  refundedAmount?: number | null;
  refundAmount?: number | null;
  note?: string | null;
  recordedBy?: string | null;
  createdAt?: string;
  updatedAt?: string;
  unit?: { label?: string; unitNumber?: string } | null;
  bill?: { billNumber?: string; period?: string; status?: string; totalAmount?: number } | null;
  unitLabel?: string;
}

export interface BillSummary {
  period?: string;
  billCount?: number;
  unitCount?: number;
  generated?: number;
  collected?: number;
  outstanding?: number;
  collectionRate?: number;
  totalAmount?: number;
  paid?: number;
  unpaid?: number;
  overdue?: number;
  partiallyPaid?: number;
  waived?: number;
}

export interface TrialBalanceRow {
  ledgerId?: string;
  ledgerName?: string;
  code?: string;
  debit?: number;
  credit?: number;
  balance?: number;
  [key: string]: unknown;
}

/* --------------------------------- amenities -------------------------------- */

export interface Amenity {
  _id: string;
  societyId?: string;
  name: string;
  type?: string | null;
  description?: string | null;
  rules?: string[];
  capacity?: number | null;
  openTime?: string | null;
  closeTime?: string | null;
  slotDurationMinutes?: number | null;
  slotGapMinutes?: number | null;
  bookingFee?: number | null;
  deposit?: number | null;
  requireApproval?: boolean;
  allowCancellation?: boolean;
  cancellationHoursBefore?: number | null;
  refundPercent?: number | null;
  maxAdvanceDays?: number | null;
  maxSlotsPerUserPerDay?: number | null;
  closedOnDays?: string[];
  isActive?: boolean;
  location?: string | null;
  totalBookings?: number;
  totalRevenue?: number;
  createdAt?: string;
  updatedAt?: string;
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
  amenity?: { name?: string };
  date: string;
  timezone: string;
  closed: boolean;
  slots: AmenitySlot[];
}

export interface AmenityBooking {
  _id: string;
  societyId?: string;
  referenceNumber?: string;
  amenityId?: string;
  slotId?: string | null;
  unitId?: string | null;
  residentId?: string | null;
  userId?: string | null;
  date: string;
  startTime?: string;
  endTime?: string;
  windowStart?: string | null;
  windowEnd?: string | null;
  numberOfPeople?: number | null;
  status: string;
  fee?: number | null;
  deposit?: number | null;
  totalAmount?: number | null;
  paymentId?: string | null;
  isPaid?: boolean;
  passId?: string | null;
  purpose?: string | null;
  notes?: string | null;
  approvedBy?: string | null;
  decidedAt?: string | null;
  rejectReason?: string | null;
  cancelledAt?: string | null;
  cancellationReason?: string | null;
  refundAmount?: number | null;
  checkedInAt?: string | null;
  checkedOutAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  amenity?: { name?: string; type?: string } | null;
  unit?: { label?: string; unitNumber?: string } | null;
  unitLabel?: string;
  amenityName?: string;
  bookedByName?: string;
}

/* ---------------------------------- gates ----------------------------------- */

export interface Gate {
  _id: string;
  name: string;
  code?: string;
  type?: string;
  isActive?: boolean;
  allowsVisitorEntry?: boolean;
  [key: string]: unknown;
}
