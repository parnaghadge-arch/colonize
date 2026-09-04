import { z } from 'zod';
import {
  AMENITY_TYPES,
  AUDIENCE_TYPES,
  BILL_ITEM_TYPES,
  COMPLAINT_CATEGORIES,
  COMPLAINT_PRIORITY,
  COMPLAINT_STATUS,
  DOCUMENT_CATEGORIES,
  DOCUMENT_VISIBILITY,
  EVENT_STATUS,
  LEDGER_TYPES,
  NOTICE_TYPES,
  PAYMENT_MODES,
  PAYMENT_PURPOSES,
  SERVICE_REQUEST_TYPES,
  TAX_TYPES,
  WORK_ORDER_STATUS,
} from '../constants/enums.js';
import {
  attachmentSchema,
  dateStringSchema,
  geoPointSchema,
  hhmmSchema,
  idSchema,
  moneySchema,
  nameSchema,
  quantitySchema,
} from './common.js';

/* ------------------------------- Complaints ------------------------------ */

export const createComplaintSchema = z.object({
  category: z.enum(COMPLAINT_CATEGORIES),
  title: z.string().trim().min(3).max(140),
  description: z.string().trim().min(3).max(4000),
  priority: z.enum(COMPLAINT_PRIORITY).default('MEDIUM'),
  /** Common area vs the caller's own unit. unitId is ignored for residents. */
  locationType: z.enum(['UNIT', 'COMMON_AREA', 'BUILDING', 'AMENITY']).default('UNIT'),
  unitId: idSchema.optional(),
  buildingId: idSchema.optional(),
  amenityId: idSchema.optional(),
  locationText: z.string().trim().max(200).optional(),
  geo: geoPointSchema.optional(),
  attachments: z.array(attachmentSchema).max(10).default([]),
  preferredContactTime: z.string().trim().max(60).optional(),
  isAnonymous: z.boolean().default(false),
});
export type CreateComplaintInput = z.infer<typeof createComplaintSchema>;

export const updateComplaintSchema = createComplaintSchema.partial().extend({
  status: z.enum(COMPLAINT_STATUS).optional(),
});
export type UpdateComplaintInput = z.infer<typeof updateComplaintSchema>;

export const assignComplaintSchema = z.object({
  assigneeType: z.enum(['STAFF', 'VENDOR', 'USER']).default('STAFF'),
  assigneeId: idSchema,
  workOrderId: idSchema.optional(),
  dueAt: z.coerce.date().optional(),
  note: z.string().trim().max(500).optional(),
});
export type AssignComplaintInput = z.infer<typeof assignComplaintSchema>;

export const complaintStatusChangeSchema = z.object({
  status: z.enum(COMPLAINT_STATUS),
  note: z.string().trim().max(1000).optional(),
  attachments: z.array(attachmentSchema).max(10).default([]),
  resolutionSummary: z.string().trim().max(2000).optional(),
  /** Resident verification step (§54 complaint flow). */
  verifiedByResident: z.boolean().optional(),
  reopenedWithinDays: z.coerce.number().int().min(0).max(60).optional(),
});
export type ComplaintStatusChangeInput = z.infer<typeof complaintStatusChangeSchema>;

export const complaintCommentSchema = z.object({
  body: z.string().trim().min(1).max(2000),
  attachments: z.array(attachmentSchema).max(6).default([]),
  /** Residents' phone numbers are never exposed in chat (§36). */
  visibility: z.enum(['ALL', 'INTERNAL', 'RESIDENT']).default('ALL'),
});
export type ComplaintCommentInput = z.infer<typeof complaintCommentSchema>;

export const complaintFeedbackSchema = z.object({
  rating: z.coerce.number().int().min(1).max(5),
  feedback: z.string().trim().max(2000).optional(),
  qualityRating: z.coerce.number().int().min(1).max(5).optional(),
  timelinessRating: z.coerce.number().int().min(1).max(5).optional(),
});
export type ComplaintFeedbackInput = z.infer<typeof complaintFeedbackSchema>;

/* ---------------------------- Service requests --------------------------- */

export const createServiceRequestSchema = z.object({
  serviceType: z.enum(SERVICE_REQUEST_TYPES),
  title: z.string().trim().min(3).max(140),
  description: z.string().trim().max(4000).optional(),
  preferredDate: dateStringSchema,
  preferredSlot: z.enum(['MORNING', 'AFTERNOON', 'EVENING', 'ANY']).default('ANY'),
  preferredTimeFrom: hhmmSchema.optional(),
  preferredTimeTo: hhmmSchema.optional(),
  vendorId: idSchema.optional(),
  estimatedCharges: moneySchema.optional(),
  attachments: z.array(attachmentSchema).max(6).default([]),
  addressNote: z.string().trim().max(200).optional(),
});
export type CreateServiceRequestInput = z.infer<typeof createServiceRequestSchema>;

export const updateServiceRequestSchema = createServiceRequestSchema.partial().extend({
  status: z
    .enum(['PENDING', 'ASSIGNED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'CLOSED'])
    .optional(),
  actualCharges: moneySchema.optional(),
});

export const serviceRequestFeedbackSchema = complaintFeedbackSchema;

/* ------------------------------- Work orders ----------------------------- */

export const createWorkOrderSchema = z.object({
  title: z.string().trim().min(3).max(140),
  description: z.string().trim().max(4000).optional(),
  complaintId: idSchema.optional(),
  serviceRequestId: idSchema.optional(),
  vendorId: idSchema.optional(),
  assigneeType: z.enum(['STAFF', 'VENDOR', 'USER']).optional(),
  assigneeId: idSchema.optional(),
  category: z.enum(COMPLAINT_CATEGORIES).optional(),
  priority: z.enum(COMPLAINT_PRIORITY).default('MEDIUM'),
  buildingId: idSchema.optional(),
  unitId: idSchema.optional(),
  amenityId: idSchema.optional(),
  scheduledStart: z.coerce.date().optional(),
  scheduledEnd: z.coerce.date().optional(),
  estimatedCost: moneySchema.optional(),
  materialRequired: z.string().trim().max(500).optional(),
});
export type CreateWorkOrderInput = z.infer<typeof createWorkOrderSchema>;
export const updateWorkOrderSchema = createWorkOrderSchema.partial().extend({
  status: z.enum(WORK_ORDER_STATUS).optional(),
});

export const workOrderProgressSchema = z.object({
  status: z.enum(WORK_ORDER_STATUS),
  progressPercent: z.coerce.number().min(0).max(100).optional(),
  note: z.string().trim().max(2000).optional(),
  attachments: z.array(attachmentSchema).max(10).default([]),
  actualCost: moneySchema.optional(),
  completedAt: z.coerce.date().optional(),
});
export type WorkOrderProgressInput = z.infer<typeof workOrderProgressSchema>;

/* -------------------------------- Amenities ------------------------------ */

export const createAmenitySchema = z.object({
  name: nameSchema,
  type: z.enum(AMENITY_TYPES).default('OTHER'),
  description: z.string().trim().max(2000).optional(),
  rules: z.array(z.string().trim().max(300)).max(30).default([]),
  capacity: z.coerce.number().int().min(1).max(100000).default(1),
  openTime: hhmmSchema.default('06:00'),
  closeTime: hhmmSchema.default('22:00'),
  slotDurationMinutes: z.coerce.number().int().min(15).max(1440).default(60),
  slotGapMinutes: z.coerce.number().int().min(0).max(240).default(0),
  bookingFee: moneySchema.default(0),
  deposit: moneySchema.default(0),
  requireApproval: z.boolean().default(false),
  allowCancellation: z.boolean().default(true),
  cancellationHoursBefore: z.coerce.number().int().min(0).max(720).default(24),
  refundPercent: z.coerce.number().min(0).max(100).default(100),
  maxAdvanceDays: z.coerce.number().int().min(1).max(365).default(30),
  maxSlotsPerUserPerDay: z.coerce.number().int().min(1).max(20).default(2),
  closedOnDays: z.array(z.coerce.number().int().min(0).max(6)).default([]),
  photoUrl: z.string().trim().max(1000).optional(),
  buildingId: idSchema.optional().nullable(),
  location: geoPointSchema.optional(),
  isActive: z.boolean().default(true),
});
export type CreateAmenityInput = z.infer<typeof createAmenitySchema>;
export const updateAmenitySchema = createAmenitySchema.partial();

export const createAmenitySlotSchema = z.object({
  amenityId: idSchema,
  dayOfWeek: z.coerce.number().int().min(0).max(6).optional(),
  startTime: hhmmSchema,
  endTime: hhmmSchema,
  capacity: z.coerce.number().int().min(1).max(100000).optional(),
  fee: moneySchema.default(0),
  isBlocked: z.boolean().default(false),
  validFrom: dateStringSchema.optional(),
  validTill: dateStringSchema.optional().nullable(),
});
export type CreateAmenitySlotInput = z.infer<typeof createAmenitySlotSchema>;

export const createBookingSchema = z.object({
  amenityId: idSchema,
  slotId: idSchema.optional(),
  date: dateStringSchema,
  startTime: hhmmSchema,
  endTime: hhmmSchema,
  numberOfPeople: z.coerce.number().int().min(1).max(100000).default(1),
  purpose: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(500).optional(),
  /** Client idempotency key — prevents duplicate bookings on retry (§22). */
  clientRequestId: z.string().trim().min(6).max(80).optional(),
});
export type CreateBookingInput = z.infer<typeof createBookingSchema>;

export const decideBookingSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT']),
  reason: z.string().trim().max(300).optional(),
});

export const cancelBookingSchema = z.object({
  reason: z.string().trim().max(300).optional(),
  refundRequested: z.boolean().default(true),
});

export const availabilityQuerySchema = z.object({
  amenityId: idSchema,
  date: dateStringSchema,
});

/* --------------------------- Notices / comms ----------------------------- */

export const createNoticeSchema = z.object({
  title: z.string().trim().min(3).max(160),
  body: z.string().trim().min(1).max(20000),
  type: z.enum(NOTICE_TYPES).default('GENERAL'),
  audienceType: z.enum(AUDIENCE_TYPES).default('ALL'),
  audienceIds: z.array(idSchema).max(2000).default([]),
  audienceRoles: z.array(z.string().trim().max(40)).max(20).default([]),
  attachments: z.array(attachmentSchema).max(10).default([]),
  /** Notices can be scheduled and can expire off the board. */
  publishAt: z.coerce.date().optional(),
  expiresAt: z.coerce.date().optional().nullable(),
  isPinned: z.boolean().default(false),
  requireAcknowledgement: z.boolean().default(false),
  acknowledgeBy: z.coerce.date().optional().nullable(),
  sendPush: z.boolean().default(true),
  sendEmail: z.boolean().default(false),
  sendSms: z.boolean().default(false),
  status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).default('DRAFT'),
});
export type CreateNoticeInput = z.infer<typeof createNoticeSchema>;
export const updateNoticeSchema = createNoticeSchema.partial();
export const publishNoticeSchema = z.object({ publishAt: z.coerce.date().optional() });

export const createAnnouncementSchema = createNoticeSchema.omit({ type: true, requireAcknowledgement: true, acknowledgeBy: true }).extend({
  kind: z.enum(['ANNOUNCEMENT', 'UPDATE', 'ALERT', 'REMINDER']).default('ANNOUNCEMENT'),
});
export type CreateAnnouncementInput = z.infer<typeof createAnnouncementSchema>;

/* --------------------------------- Polls --------------------------------- */

export const createPollSchema = z.object({
  question: z.string().trim().min(5).max(500),
  description: z.string().trim().max(4000).optional(),
  options: z
    .array(z.object({ label: z.string().trim().min(1).max(120), value: z.string().trim().max(60).optional() }))
    .min(2, 'A poll needs at least two options')
    .max(12),
  allowMultipleChoice: z.boolean().default(false),
  isAnonymous: z.boolean().default(false),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
  eligibleAudience: z.enum(AUDIENCE_TYPES).default('ALL'),
  eligibleAudienceIds: z.array(idSchema).max(2000).default([]),
  eligibleRoles: z.array(z.string().trim().max(40)).max(20).default([]),
  oneVotePerUnit: z.boolean().default(true),
  showResultsBeforeClose: z.boolean().default(false),
});
export type CreatePollInput = z.infer<typeof createPollSchema>;
export const updatePollSchema = createPollSchema.partial();

export const castVoteSchema = z.object({
  pollId: idSchema,
  optionIds: z.array(idSchema).min(1).max(12),
  /** Clients cannot change a vote after casting; server enforces one vote per unit/user. */
});
export type CastVoteInput = z.infer<typeof castVoteSchema>;

/* --------------------------------- Events -------------------------------- */

export const createEventSchema = z.object({
  name: nameSchema,
  description: z.string().trim().max(8000).optional(),
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
  location: z.string().trim().max(200).optional(),
  amenityId: idSchema.optional(),
  bannerUrl: z.string().trim().max(1000).optional(),
  capacity: z.coerce.number().int().min(0).max(100000).default(0),
  requiresRegistration: z.boolean().default(true),
  fee: moneySchema.default(0),
  allowGuests: z.boolean().default(true),
  maxGuestsPerRegistration: z.coerce.number().int().min(0).max(50).default(4),
  registrationDeadline: z.coerce.date().optional(),
  audienceType: z.enum(AUDIENCE_TYPES).default('ALL'),
  audienceIds: z.array(idSchema).max(2000).default([]),
  status: z.enum(EVENT_STATUS).default('DRAFT'),
});
export type CreateEventInput = z.infer<typeof createEventSchema>;
export const updateEventSchema = createEventSchema.partial();

export const rsvpSchema = z.object({
  status: z.enum(['ATTENDING', 'NOT_ATTENDING', 'MAYBE']),
  guests: z.coerce.number().int().min(0).max(50).default(0),
  note: z.string().trim().max(300).optional(),
  clientRequestId: z.string().trim().min(6).max(80).optional(),
});
export type RsvpInput = z.infer<typeof rsvpSchema>;

/* ----------------------------- Finance: bills ---------------------------- */

export const billItemSchema = z.object({
  type: z.enum(BILL_ITEM_TYPES),
  label: z.string().trim().min(1).max(120),
  amount: moneySchema,
  quantity: z.coerce.number().min(0).max(100000).default(1),
  rate: moneySchema.optional(),
  isTaxable: z.boolean().default(false),
  taxPercent: z.coerce.number().min(0).max(50).default(0),
  taxType: z.enum(TAX_TYPES).default('NONE'),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type BillItemInput = z.infer<typeof billItemSchema>;

export const createBillSchema = z.object({
  unitId: idSchema,
  /** `YYYY-MM` billing period. */
  period: z.string().regex(/^\d{4}-\d{2}$/, 'Use the format YYYY-MM'),
  dueDate: dateStringSchema,
  items: z.array(billItemSchema).min(1).max(60),
  discount: moneySchema.default(0),
  discountReason: z.string().trim().max(200).optional(),
  carryForwardArrears: z.boolean().default(true),
  notes: z.string().trim().max(1000).optional(),
  sendNotification: z.boolean().default(true),
});
export type CreateBillInput = z.infer<typeof createBillSchema>;
export const updateBillSchema = createBillSchema.partial().omit({ unitId: true, period: true });

/** Bulk generation for a whole society / building (§62 scheduled task also uses this). */
export const generateBillsSchema = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/),
  dueDate: dateStringSchema,
  scope: z.enum(['ALL', 'BUILDING', 'WING', 'UNITS']).default('ALL'),
  buildingIds: z.array(idSchema).max(500).default([]),
  wingIds: z.array(idSchema).max(2000).default([]),
  unitIds: z.array(idSchema).max(20000).default([]),
  includeFixedCharges: z.boolean().default(true),
  includeWater: z.boolean().default(true),
  includeParking: z.boolean().default(true),
  includeClubhouse: z.boolean().default(false),
  applyLateFeeOnArrears: z.boolean().default(true),
  carryForwardArrears: z.boolean().default(true),
  dryRun: z.boolean().default(false),
});
export type GenerateBillsInput = z.infer<typeof generateBillsSchema>;

export const waiveBillSchema = z.object({
  amount: moneySchema.optional(),
  reason: z.string().trim().min(3).max(300),
  fullWaiver: z.boolean().default(false),
});

/* ---------------------------- Finance: payments -------------------------- */

export const createPaymentIntentSchema = z.object({
  purpose: z.enum(PAYMENT_PURPOSES),
  /** One of billId / bookingId / eventId must be supplied for linked payments. */
  billId: idSchema.optional(),
  bookingId: idSchema.optional(),
  eventId: idSchema.optional(),
  serviceRequestId: idSchema.optional(),
  amount: moneySchema.optional(),
  unitId: idSchema.optional(),
  note: z.string().trim().max(300).optional(),
  returnUrl: z.string().trim().max(500).optional(),
  /** Client idempotency key so a retried tap never creates two orders (§77). */
  clientRequestId: z.string().trim().min(6).max(80).optional(),
});
export type CreatePaymentIntentInput = z.infer<typeof createPaymentIntentSchema>;

export const verifyPaymentSchema = z.object({
  paymentId: idSchema,
  gatewayPaymentId: z.string().trim().max(200).optional(),
  gatewayOrderId: z.string().trim().max(200).optional(),
  signature: z.string().trim().max(1000).optional(),
  rawPayload: z.record(z.string(), z.unknown()).optional(),
});
export type VerifyPaymentInput = z.infer<typeof verifyPaymentSchema>;

/** Offline/cash/cheque collection recorded by an admin (§28). */
export const recordOfflinePaymentSchema = z.object({
  unitId: idSchema,
  billId: idSchema.optional(),
  purpose: z.enum(PAYMENT_PURPOSES).default('MAINTENANCE'),
  amount: moneySchema,
  mode: z.enum(PAYMENT_MODES),
  referenceNumber: z.string().trim().max(80).optional(),
  paidAt: z.coerce.date().optional(),
  note: z.string().trim().max(300).optional(),
  clientRequestId: z.string().trim().min(6).max(80).optional(),
});
export type RecordOfflinePaymentInput = z.infer<typeof recordOfflinePaymentSchema>;

export const refundPaymentSchema = z.object({
  amount: moneySchema.optional(),
  reason: z.string().trim().min(3).max(300),
  fullRefund: z.boolean().default(false),
});
export type RefundPaymentInput = z.infer<typeof refundPaymentSchema>;

export const gatewayWebhookSchema = z.object({
  provider: z.string().trim().max(40),
  event: z.string().trim().max(80),
  payload: z.record(z.string(), z.unknown()),
});

/* ----------------------------- Finance: books ---------------------------- */

export const createLedgerSchema = z.object({
  name: nameSchema,
  type: z.enum(LEDGER_TYPES),
  group: z.enum(['INCOME', 'EXPENSE', 'ASSET', 'LIABILITY', 'EQUITY']),
  openingBalance: moneySchema.default(0),
  isSystem: z.boolean().default(false),
  vendorId: idSchema.optional(),
  unitId: idSchema.optional(),
  isActive: z.boolean().default(true),
});
export type CreateLedgerInput = z.infer<typeof createLedgerSchema>;
export const updateLedgerSchema = createLedgerSchema.partial().omit({ isSystem: true });

export const journalLineSchema = z.object({
  ledgerId: idSchema,
  type: z.enum(['DEBIT', 'CREDIT']),
  amount: moneySchema,
  note: z.string().trim().max(300).optional(),
});

export const createJournalEntrySchema = z.object({
  date: dateStringSchema,
  narration: z.string().trim().min(3).max(500),
  lines: z.array(journalLineSchema).min(2).max(40),
  referenceType: z
    .enum(['PAYMENT', 'RECEIPT', 'EXPENSE', 'INCOME', 'BILL', 'ADJUSTMENT', 'OPENING'])
    .default('ADJUSTMENT'),
  referenceId: idSchema.optional(),
  /** Server validates debits === credits before posting. */
});
export type CreateJournalEntryInput = z.infer<typeof createJournalEntrySchema>;

export const createExpenseSchema = z.object({
  title: z.string().trim().min(3).max(140),
  ledgerId: idSchema,
  vendorId: idSchema.optional(),
  amount: moneySchema,
  date: dateStringSchema,
  category: z.string().trim().max(60).optional(),
  gstin: z.string().trim().max(20).optional(),
  taxableAmount: moneySchema.optional(),
  cgst: moneySchema.default(0),
  sgst: moneySchema.default(0),
  igst: moneySchema.default(0),
  invoiceNumber: z.string().trim().max(60).optional(),
  paymentMode: z.enum(PAYMENT_MODES).optional(),
  attachments: z.array(attachmentSchema).max(10).default([]),
  note: z.string().trim().max(1000).optional(),
  isPaid: z.boolean().default(false),
  approvedBy: idSchema.optional(),
});
export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;
export const updateExpenseSchema = createExpenseSchema.partial();

export const createIncomeSchema = createExpenseSchema.omit({ vendorId: true }).extend({
  unitId: idSchema.optional(),
  source: z.string().trim().max(60).optional(),
});
export type CreateIncomeInput = z.infer<typeof createIncomeSchema>;

export const trialBalanceQuerySchema = z.object({
  asOf: dateStringSchema.optional(),
  from: dateStringSchema.optional(),
  to: dateStringSchema.optional(),
});

/* ------------------------------- Documents ------------------------------- */

export const uploadDocumentMetaSchema = z.object({
  title: z.string().trim().min(2).max(160),
  category: z.enum(DOCUMENT_CATEGORIES).default('OTHER'),
  visibility: z.enum(DOCUMENT_VISIBILITY).default('RESIDENTS'),
  description: z.string().trim().max(2000).optional(),
  unitId: idSchema.optional(),
  buildingId: idSchema.optional(),
  vendorId: idSchema.optional(),
  billId: idSchema.optional(),
  requireAcknowledgement: z.boolean().default(false),
  acknowledgeBy: z.coerce.date().optional().nullable(),
  tags: z.array(z.string().trim().max(40)).max(20).default([]),
  validTill: z.coerce.date().optional().nullable(),
});
export type UploadDocumentMetaInput = z.infer<typeof uploadDocumentMetaSchema>;
export const updateDocumentSchema = uploadDocumentMetaSchema.partial();

export const acknowledgeDocumentSchema = z.object({
  note: z.string().trim().max(500).optional(),
  /** Client asserts the resident viewed the document; server records device + IP (§38). */
  viewedSeconds: z.coerce.number().int().min(0).max(100000).optional(),
});

/* --------------------------- Support tickets ----------------------------- */

export const createSupportTicketSchema = z.object({
  subject: z.string().trim().min(3).max(160),
  body: z.string().trim().min(3).max(8000),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).default('MEDIUM'),
  category: z.string().trim().max(60).optional(),
  societyId: idSchema.optional(),
  attachments: z.array(attachmentSchema).max(10).default([]),
});
export type CreateSupportTicketInput = z.infer<typeof createSupportTicketSchema>;

export const ticketReplySchema = z.object({
  body: z.string().trim().min(1).max(8000),
  isInternal: z.boolean().default(false),
  status: z.enum(['OPEN', 'IN_PROGRESS', 'WAITING_ON_CUSTOMER', 'RESOLVED', 'CLOSED']).optional(),
  attachments: z.array(attachmentSchema).max(10).default([]),
});

/* ------------------------- Subscriptions & plans ------------------------- */

export const createPlanSchema = z.object({
  code: z.string().trim().min(2).max(40).toUpperCase(),
  name: nameSchema,
  tier: z.enum(['FREE', 'BASIC', 'STANDARD', 'PREMIUM', 'ENTERPRISE']).default('BASIC'),
  description: z.string().trim().max(1000).optional(),
  pricePerUnitPerMonth: moneySchema.default(0),
  basePrice: moneySchema.default(0),
  minUnits: quantitySchema.default(0),
  maxUnits: quantitySchema.default(100000),
  modules: z.array(z.string().trim().max(60)).min(1).max(60),
  limits: z
    .object({
      maxUnits: quantitySchema.optional(),
      maxUsers: quantitySchema.optional(),
      maxStorageMb: quantitySchema.optional(),
      maxGates: quantitySchema.optional(),
      smsCredits: quantitySchema.optional(),
    })
    .partial()
    .default({}),
  trialDays: z.coerce.number().int().min(0).max(90).default(14),
  isActive: z.boolean().default(true),
  isFeatured: z.boolean().default(false),
});
export type CreatePlanInput = z.infer<typeof createPlanSchema>;
export const updatePlanSchema = createPlanSchema.partial().omit({ code: true });

export const createSubscriptionSchema = z.object({
  societyId: idSchema,
  planId: idSchema,
  billingCycle: z.enum(['MONTHLY', 'QUARTERLY', 'YEARLY']).default('MONTHLY'),
  startDate: dateStringSchema,
  endDate: dateStringSchema,
  unitsBilled: quantitySchema.default(0),
  amount: moneySchema.default(0),
  status: z.enum(['TRIAL', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED', 'SUSPENDED']).default('TRIAL'),
  autoRenew: z.boolean().default(true),
});
export type CreateSubscriptionInput = z.infer<typeof createSubscriptionSchema>;
export const updateSubscriptionSchema = createSubscriptionSchema.partial().omit({ societyId: true });

/* --------------------------------- Search -------------------------------- */

export const globalSearchSchema = z.object({
  q: z.string().trim().min(1).max(120),
  scopes: z
    .array(
      z.enum([
        'resident',
        'unit',
        'vehicle',
        'visitor',
        'staff',
        'vendor',
        'complaint',
        'payment',
        'invoice',
        'document',
        'amenity',
        'notice',
      ]),
    )
    .max(12)
    .optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
export type GlobalSearchInput = z.infer<typeof globalSearchSchema>;

/* ------------------------------- Reports --------------------------------- */

export const reportRequestSchema = z.object({
  report: z.enum([
    'RESIDENT_LIST',
    'OWNER_LIST',
    'TENANT_LIST',
    'VACANT_UNITS',
    'DAILY_VISITORS',
    'MONTHLY_VISITORS',
    'VISITOR_HISTORY',
    'ENTRY_EXIT',
    'GUARD_ATTENDANCE',
    'GATE_ACTIVITY',
    'COLLECTION',
    'OUTSTANDING',
    'EXPENSES',
    'INCOME',
    'VENDOR_PAYMENTS',
    'COMPLAINTS_OPEN',
    'COMPLAINTS_CLOSED',
    'COMPLAINTS_SLA',
    'AMENITY_BOOKINGS',
    'AMENITY_REVENUE',
    'AMENITY_UTILIZATION',
    'TRIAL_BALANCE',
    'LEDGER_STATEMENT',
    'STAFF_ATTENDANCE',
    'VEHICLE_LIST',
    'PARKING_UTILIZATION',
  ]),
  from: dateStringSchema.optional(),
  to: dateStringSchema.optional(),
  format: z.enum(['json', 'csv', 'xlsx', 'pdf']).default('json'),
  buildingId: idSchema.optional(),
  wingId: idSchema.optional(),
  unitId: idSchema.optional(),
  groupBy: z.string().trim().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200000).default(50000),
});
export type ReportRequestInput = z.infer<typeof reportRequestSchema>;
