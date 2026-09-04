import { z } from 'zod';
import {
  CAB_TYPES,
  DELIVERY_COMPANIES,
  DELIVERY_TYPES,
  EMERGENCY_CATEGORIES,
  ENTRY_TYPES,
  VISITOR_TYPES,
} from '../constants/enums.js';
import {
  dateStringSchema,
  geoPointSchema,
  hhmmSchema,
  idSchema,
  nameSchema,
  optionalPhoneSchema,
  phoneSchema,
  quantitySchema,
  vehicleNumberSchema,
} from './common.js';

/* --------------------- Pre-approved visitor (§11) ------------------------ */

/**
 * Created by a resident from the mobile app. Note there is **no** `unitId` / `societyId`
 * field: both are derived from the authenticated caller's membership server-side.
 */
export const createPreApprovedVisitorSchema = z.object({
  visitorName: nameSchema,
  visitorPhone: optionalPhoneSchema,
  visitDate: dateStringSchema,
  expectedArrival: hhmmSchema,
  expectedDeparture: hhmmSchema.optional(),
  purpose: z.string().trim().min(1).max(120),
  visitorType: z.enum(VISITOR_TYPES).default('GUEST'),
  numberOfVisitors: quantitySchema.min(1).max(50).default(1),
  vehicleNumber: vehicleNumberSchema.optional(),
  /** Which household member(s) this pass is for (defaults to the caller's unit). */
  memberIds: z.array(idSchema).max(20).default([]),
  photoUrl: z.string().trim().max(1000).optional(),
  idProofType: z.enum(['AADHAAR', 'PAN', 'PASSPORT', 'DRIVING_LICENSE', 'OTHER']).optional(),
  notes: z.string().trim().max(500).optional(),
  generateQrPass: z.boolean().default(true),
});
export type CreatePreApprovedVisitorInput = z.infer<typeof createPreApprovedVisitorSchema>;

export const updateVisitorSchema = createPreApprovedVisitorSchema.partial();

export const cancelVisitorSchema = z.object({ reason: z.string().trim().max(200).optional() });

/* ------------------------ At-gate visitor (§11) -------------------------- */

/** Entered by a security guard at the gate. */
export const createAtGateVisitorSchema = z.object({
  visitorName: nameSchema,
  visitorPhone: optionalPhoneSchema,
  unitId: idSchema,
  purpose: z.string().trim().min(1).max(120),
  visitorType: z.enum(VISITOR_TYPES).default('GUEST'),
  numberOfVisitors: quantitySchema.min(1).max(50).default(1),
  vehicleNumber: vehicleNumberSchema.optional(),
  photoUrl: z.string().trim().max(1000).optional(),
  idProofType: z.string().trim().max(30).optional(),
  idProofNumber: z.string().trim().max(40).optional(),
  gateId: idSchema.optional(),
  address: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(300).optional(),
  location: geoPointSchema.optional(),
  /** Offline capture: the client timestamp + idempotency key (§50). */
  capturedAt: z.coerce.date().optional(),
  clientRequestId: z.string().trim().min(6).max(80).optional(),
});
export type CreateAtGateVisitorInput = z.infer<typeof createAtGateVisitorSchema>;

export const decideVisitorSchema = z.object({
  decision: z.enum(['APPROVE', 'REJECT', 'IGNORE']),
  reason: z.string().trim().max(300).optional(),
  /** Resident may allow entry with conditions (e.g. "leave at reception"). */
  instructions: z.string().trim().max(300).optional(),
});
export type DecideVisitorInput = z.infer<typeof decideVisitorSchema>;

export const recordEntrySchema = z.object({
  gateId: idSchema.optional(),
  entryTime: z.coerce.date().optional(),
  vehicleNumber: vehicleNumberSchema.optional(),
  photoUrl: z.string().trim().max(1000).optional(),
  escortedBy: z.string().trim().max(80).optional(),
  notes: z.string().trim().max(300).optional(),
  clientRequestId: z.string().trim().min(6).max(80).optional(),
});
export type RecordEntryInput = z.infer<typeof recordEntrySchema>;

export const recordExitSchema = z.object({
  gateId: idSchema.optional(),
  exitTime: z.coerce.date().optional(),
  notes: z.string().trim().max(300).optional(),
  clientRequestId: z.string().trim().min(6).max(80).optional(),
});
export type RecordExitInput = z.infer<typeof recordExitSchema>;

/* ------------------------------ QR scanning ------------------------------ */

/**
 * Security scans a QR. The payload is an opaque signed token (§12) — no PII travels in
 * the QR. `mode` selects which pass family to validate.
 */
export const scanQrSchema = z.object({
  token: z.string().trim().min(10).max(2000),
  mode: z.enum(['VISITOR', 'VEHICLE', 'STAFF', 'AMENITY_BOOKING', 'SOCIETY_ACCESS', 'AUTO']).default('AUTO'),
  gateId: idSchema.optional(),
  action: z.enum(['VALIDATE', 'CHECK_IN', 'CHECK_OUT']).default('VALIDATE'),
  photoUrl: z.string().trim().max(1000).optional(),
  vehicleNumber: vehicleNumberSchema.optional(),
  location: geoPointSchema.optional(),
  clientRequestId: z.string().trim().min(6).max(80).optional(),
});
export type ScanQrInput = z.infer<typeof scanQrSchema>;

export const revokePassSchema = z.object({ reason: z.string().trim().max(200).optional() });

/* ------------------------------- Deliveries ------------------------------ */

export const createDeliverySchema = z.object({
  deliveryPersonName: nameSchema,
  company: z.enum(DELIVERY_COMPANIES).default('OTHER'),
  companyName: z.string().trim().max(60).optional(),
  phone: optionalPhoneSchema,
  unitId: idSchema,
  deliveryType: z.enum(DELIVERY_TYPES).default('PACKAGE'),
  orderId: z.string().trim().max(60).optional(),
  packageDescription: z.string().trim().max(200).optional(),
  vehicleNumber: vehicleNumberSchema.optional(),
  photoUrl: z.string().trim().max(1000).optional(),
  gateId: idSchema.optional(),
  requiresApproval: z.boolean().optional(),
  notes: z.string().trim().max(300).optional(),
  capturedAt: z.coerce.date().optional(),
  clientRequestId: z.string().trim().min(6).max(80).optional(),
});
export type CreateDeliveryInput = z.infer<typeof createDeliverySchema>;
export const updateDeliverySchema = createDeliverySchema.partial();

/* --------------------------------- Cabs ---------------------------------- */

export const createCabEntrySchema = z.object({
  driverName: nameSchema,
  phone: optionalPhoneSchema,
  cabType: z.enum(CAB_TYPES).default('CAB'),
  provider: z.enum(['UBER', 'OLA', 'RAPIDO', 'MERU', 'PRIVATE', 'OTHER']).default('OTHER'),
  vehicleNumber: vehicleNumberSchema,
  unitId: idSchema,
  tripKind: z.enum(['PICKUP', 'DROP', 'BOTH']).default('BOTH'),
  photoUrl: z.string().trim().max(1000).optional(),
  gateId: idSchema.optional(),
  notes: z.string().trim().max(300).optional(),
  clientRequestId: z.string().trim().min(6).max(80).optional(),
});
export type CreateCabEntryInput = z.infer<typeof createCabEntrySchema>;

/** Resident-generated temporary cab access (§14). */
export const createCabAccessSchema = z.object({
  vehicleNumber: vehicleNumberSchema,
  driverName: nameSchema.optional(),
  driverPhone: optionalPhoneSchema,
  cabType: z.enum(CAB_TYPES).default('CAB'),
  validFrom: z.coerce.date().optional(),
  validTill: z.coerce.date(),
  maxEntries: z.coerce.number().int().min(1).max(20).default(1),
  purpose: z.string().trim().max(120).optional(),
});
export type CreateCabAccessInput = z.infer<typeof createCabAccessSchema>;

/* ------------------------------- Emergency ------------------------------- */

export const raiseEmergencySchema = z.object({
  category: z.enum(EMERGENCY_CATEGORIES),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('HIGH'),
  unitId: idSchema.optional(),
  location: z.string().trim().max(200).optional(),
  geo: geoPointSchema.optional(),
  description: z.string().trim().max(1000).optional(),
  photoUrls: z.array(z.string().trim().max(1000)).max(10).default([]),
  contactPhone: optionalPhoneSchema,
  notifySecurity: z.boolean().default(true),
  notifyAdmin: z.boolean().default(true),
  notifyContacts: z.boolean().default(true),
});
export type RaiseEmergencyInput = z.infer<typeof raiseEmergencySchema>;

export const updateEmergencySchema = z.object({
  status: z.enum(['ACTIVE', 'ACKNOWLEDGED', 'RESPONDING', 'RESOLVED', 'FALSE_ALARM']),
  note: z.string().trim().max(500).optional(),
  responderName: z.string().trim().max(80).optional(),
});

/* ------------------------------- Entry log ------------------------------- */

export const entryLogQuerySchema = z.object({
  from: dateStringSchema.optional(),
  to: dateStringSchema.optional(),
  entryType: z.enum(ENTRY_TYPES).optional(),
  gateId: idSchema.optional(),
  unitId: idSchema.optional(),
  status: z.string().trim().max(40).optional(),
});

export const visitorSummarySchema = z.object({
  from: dateStringSchema,
  to: dateStringSchema,
  groupBy: z.enum(['DAY', 'UNIT', 'BUILDING', 'GATE', 'TYPE']).default('DAY'),
});

export const guardActivitySchema = z.object({
  guardId: idSchema,
  from: dateStringSchema,
  to: dateStringSchema,
});
