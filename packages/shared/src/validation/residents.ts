import { z } from 'zod';
import { FAMILY_RELATIONSHIPS, MEMBER_KINDS } from '../constants/roles.js';
import {
  STAFF_EMPLOYMENT,
  STAFF_STATUS,
  STAFF_TYPES,
  ATTENDANCE_STATUS,
  VEHICLE_TYPES,
} from '../constants/enums.js';
import {
  addressSchema,
  dateStringSchema,
  emailSchema,
  idSchema,
  nameSchema,
  optionalEmailSchema,
  optionalPhoneSchema,
  phoneSchema,
  quantitySchema,
  vehicleNumberSchema,
} from './common.js';

/* ------------------------------- Residents ------------------------------- */

export const createResidentSchema = z.object({
  fullName: nameSchema,
  phone: phoneSchema,
  email: optionalEmailSchema,
  gender: z.enum(['MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY']).optional(),
  dateOfBirth: dateStringSchema.optional(),
  photoUrl: z.string().trim().max(1000).optional(),
  address: addressSchema.optional(),
  unitId: idSchema,
  buildingId: idSchema.optional(),
  wingId: idSchema.optional().nullable(),
  floorId: idSchema.optional().nullable(),
  /** OWNER | TENANT | FAMILY (drives `unit_members.kind` + role assignment). */
  kind: z.enum(MEMBER_KINDS).default('OWNER'),
  isPrimary: z.boolean().default(false),
  moveInDate: dateStringSchema.optional(),
  moveOutDate: dateStringSchema.optional().nullable(),
  emergencyContactName: z.string().trim().max(80).optional(),
  emergencyContactPhone: optionalPhoneSchema,
  emergencyContactRelation: z.string().trim().max(40).optional(),
  occupation: z.string().trim().max(80).optional(),
  bloodGroup: z.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'UNKNOWN']).optional(),
  idProofType: z.enum(['AADHAAR', 'PAN', 'PASSPORT', 'DRIVING_LICENSE', 'VOTER_ID', 'OTHER']).optional(),
  idProofNumber: z.string().trim().max(40).optional(),
  /** Tenant-only: who owns the unit (kept for records, never exposed cross-society). */
  ownerName: z.string().trim().max(80).optional(),
  leaseStartDate: dateStringSchema.optional(),
  leaseEndDate: dateStringSchema.optional(),
  rentAmount: z.coerce.number().min(0).max(10_000_000).optional(),
  isActive: z.boolean().default(true),
});
export type CreateResidentInput = z.infer<typeof createResidentSchema>;

export const updateResidentSchema = createResidentSchema.partial().omit({ phone: true }).extend({
  phone: phoneSchema.optional(),
});
export type UpdateResidentInput = z.infer<typeof updateResidentSchema>;

/**
 * Family members created *by a resident* — no unitId is accepted from the client.
 * The unit is always resolved from the caller's membership (§51: never trust ids from
 * the frontend).
 */
export const createFamilyMemberSchema = z.object({
  fullName: nameSchema,
  relationship: z.enum(FAMILY_RELATIONSHIPS).default('OTHER'),
  phone: optionalPhoneSchema,
  email: optionalEmailSchema,
  age: z.coerce.number().int().min(0).max(130).optional(),
  dateOfBirth: dateStringSchema.optional(),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER', 'PREFER_NOT_TO_SAY']).optional(),
  photoUrl: z.string().trim().max(1000).optional(),
  emergencyContactName: z.string().trim().max(80).optional(),
  emergencyContactPhone: optionalPhoneSchema,
  /** Configurable per-member permissions (§9). */
  permissions: z
    .object({
      canApproveVisitors: z.boolean().default(false),
      canApproveDeliveries: z.boolean().default(false),
      canRaiseComplaints: z.boolean().default(true),
      canBookAmenities: z.boolean().default(false),
      canMakePayments: z.boolean().default(false),
      canViewBills: z.boolean().default(false),
      canAddStaff: z.boolean().default(false),
      canRaiseEmergency: z.boolean().default(true),
    })
    .partial()
    .default({}),
  canLogin: z.boolean().default(false),
  isActive: z.boolean().default(true),
});
export type CreateFamilyMemberInput = z.infer<typeof createFamilyMemberSchema>;
export const updateFamilyMemberSchema = createFamilyMemberSchema.partial();

export const linkMemberToUnitSchema = z.object({
  unitId: idSchema,
  userId: idSchema.optional(),
  residentId: idSchema.optional(),
  kind: z.enum(MEMBER_KINDS).default('OWNER'),
  isPrimary: z.boolean().default(false),
  moveInDate: dateStringSchema.optional(),
});

/* -------------------------------- Vehicles ------------------------------- */

export const createVehicleSchema = z.object({
  vehicleNumber: vehicleNumberSchema,
  type: z.enum(VEHICLE_TYPES).default('CAR'),
  brand: z.string().trim().max(40).optional(),
  model: z.string().trim().max(40).optional(),
  color: z.string().trim().max(30).optional(),
  year: z.coerce.number().int().min(1950).max(2100).optional(),
  parkingSlotId: idSchema.optional().nullable(),
  isEv: z.boolean().default(false),
  stickerNumber: z.string().trim().max(20).optional(),
  insuranceExpiry: dateStringSchema.optional(),
  rcExpiry: dateStringSchema.optional(),
  isPrimary: z.boolean().default(false),
  /** Residents may only add vehicles to a unit they belong to; admins pass unitId. */
  unitId: idSchema.optional(),
  isActive: z.boolean().default(true),
});
export type CreateVehicleInput = z.infer<typeof createVehicleSchema>;
export const updateVehicleSchema = createVehicleSchema.partial();

/* --------------------------------- Staff --------------------------------- */

export const createStaffSchema = z.object({
  fullName: nameSchema,
  phone: phoneSchema,
  email: optionalEmailSchema,
  photoUrl: z.string().trim().max(1000).optional(),
  type: z.enum(STAFF_TYPES).default('OTHER'),
  employmentType: z.enum(STAFF_EMPLOYMENT).default('SOCIETY'),
  address: addressSchema.optional(),
  idProofType: z.enum(['AADHAAR', 'PAN', 'PASSPORT', 'DRIVING_LICENSE', 'VOTER_ID', 'OTHER']).optional(),
  idProofNumber: z.string().trim().max(40).optional(),
  referenceDetails: z.string().trim().max(200).optional(),
  joiningDate: dateStringSchema.optional(),
  exitDate: dateStringSchema.optional().nullable(),
  monthlySalary: z.coerce.number().min(0).max(10_000_000).optional(),
  workType: z.enum(['FULL_TIME', 'PART_TIME', 'DAILY', 'HOURLY', 'VISITING', 'CONTRACT']).default('FULL_TIME'),
  workingDays: z.array(z.coerce.number().int().min(0).max(6)).default([0, 1, 2, 3, 4, 5, 6]),
  startTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  endTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  /** Units this private staff member is allowed to visit (domestic help etc.). */
  assignedUnitIds: z.array(idSchema).max(200).default([]),
  gateId: idSchema.optional().nullable(),
  shift: z.enum(['MORNING', 'AFTERNOON', 'NIGHT', 'GENERAL']).optional(),
  vendorId: idSchema.optional().nullable(),
  allowLogin: z.boolean().default(false),
  notifyResidentsOnArrival: z.boolean().default(false),
  status: z.enum(STAFF_STATUS).default('ACTIVE'),
});
export type CreateStaffInput = z.infer<typeof createStaffSchema>;
export const updateStaffSchema = createStaffSchema.partial();

export const markAttendanceSchema = z.object({
  staffId: idSchema,
  date: dateStringSchema.optional(),
  status: z.enum(ATTENDANCE_STATUS).default('PRESENT'),
  entryTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  exitTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  gateId: idSchema.optional(),
  unitId: idSchema.optional().nullable(),
  note: z.string().trim().max(300).optional(),
  photoUrl: z.string().trim().max(1000).optional(),
  /** Client-generated idempotency key so offline sync never double-counts (§50). */
  clientRequestId: z.string().trim().min(6).max(80).optional(),
});
export type MarkAttendanceInput = z.infer<typeof markAttendanceSchema>;

export const bulkAttendanceSchema = z.object({
  date: dateStringSchema,
  records: z
    .array(
      z.object({
        staffId: idSchema,
        status: z.enum(ATTENDANCE_STATUS),
        entryTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
        clientRequestId: z.string().trim().min(6).max(80).optional(),
      }),
    )
    .min(1)
    .max(500),
});

/* -------------------------------- Vendors -------------------------------- */

export const createVendorSchema = z.object({
  businessName: nameSchema,
  contactPersonName: nameSchema.optional(),
  phone: phoneSchema,
  alternatePhone: optionalPhoneSchema,
  email: optionalEmailSchema,
  address: addressSchema.optional(),
  gstin: z.string().trim().max(20).optional(),
  pan: z.string().trim().max(15).optional(),
  serviceCategories: z.array(z.string().trim().max(40)).min(1).max(20),
  contractType: z.enum(['ONE_TIME', 'ANNUAL', 'MONTHLY', 'PER_VISIT', 'AMC']).default('PER_VISIT'),
  contractValue: z.coerce.number().min(0).max(100_000_000).optional(),
  agreementUrl: z.string().trim().max(1000).optional(),
  startDate: dateStringSchema.optional(),
  endDate: dateStringSchema.optional().nullable(),
  bankAccountName: z.string().trim().max(80).optional(),
  bankAccountNumber: z.string().trim().max(30).optional(),
  bankIfsc: z.string().trim().max(20).optional(),
  paymentTermsDays: z.coerce.number().int().min(0).max(180).default(15),
  rating: z.coerce.number().min(0).max(5).optional(),
  allowPortalLogin: z.boolean().default(false),
  status: z.enum(['ACTIVE', 'INACTIVE', 'BLACKLISTED', 'ON_HOLD']).default('ACTIVE'),
});
export type CreateVendorInput = z.infer<typeof createVendorSchema>;
export const updateVendorSchema = createVendorSchema.partial();

/* -------------------------- Users & role assignment ---------------------- */

export const createUserSchema = z.object({
  fullName: nameSchema,
  email: emailSchema.optional(),
  phone: phoneSchema.optional(),
  password: z.string().min(8).max(128).optional(),
  roles: z.array(z.string().trim().min(2).max(40)).min(1).max(10),
  unitIds: z.array(idSchema).max(50).default([]),
  designation: z.string().trim().max(60).optional(),
  sendInvite: z.boolean().default(true),
  isActive: z.boolean().default(true),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;
export const updateUserSchema = createUserSchema.partial();

export const assignRoleSchema = z.object({
  userId: idSchema,
  roles: z.array(z.string().trim().min(2).max(40)).min(1).max(10),
  unitIds: z.array(idSchema).max(50).optional(),
  validTill: dateStringSchema.optional().nullable(),
});

export const updateRolePermissionsSchema = z.object({
  role: z.string().trim().min(2).max(40),
  grant: z.array(z.string().regex(/^[a-z]+:[a-z*]+$/i)).max(500).default([]),
  revoke: z.array(z.string().regex(/^[a-z]+:[a-z*]+$/i)).max(500).default([]),
});
export type UpdateRolePermissionsInput = z.infer<typeof updateRolePermissionsSchema>;

/* -------------------------------- Guards --------------------------------- */

export const createGuardAssignmentSchema = z.object({
  staffId: idSchema,
  gateId: idSchema,
  shift: z.enum(['MORNING', 'AFTERNOON', 'NIGHT', 'GENERAL']).default('GENERAL'),
  startDate: dateStringSchema,
  endDate: dateStringSchema.optional().nullable(),
});
export type CreateGuardAssignmentInput = z.infer<typeof createGuardAssignmentSchema>;

export const guardShiftLoginSchema = z.object({
  gateId: idSchema,
  note: z.string().trim().max(200).optional(),
  location: z.object({ lat: z.coerce.number(), lng: z.coerce.number() }).optional(),
});

export const bulkResidentsImportSchema = z.object({
  csv: z.string().min(1).max(10_000_000),
  dryRun: z.boolean().default(false),
  defaultBuildingId: idSchema.optional(),
});
export type BulkResidentsImportInput = z.infer<typeof bulkResidentsImportSchema>;

export const reassignUnitSchema = z.object({
  residentId: idSchema,
  fromUnitId: idSchema,
  toUnitId: idSchema,
  moveOutDate: dateStringSchema.optional(),
  moveInDate: dateStringSchema.optional(),
  reason: z.string().trim().max(200).optional(),
});

export const exportQuerySchema = z.object({
  format: z.enum(['csv', 'xlsx', 'pdf']).default('csv'),
  fields: z.array(z.string().trim().max(60)).max(100).optional(),
  from: dateStringSchema.optional(),
  to: dateStringSchema.optional(),
  buildingId: idSchema.optional(),
  unitId: idSchema.optional(),
  status: z.string().trim().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(100000).default(50000),
});
export type ExportQueryInput = z.infer<typeof exportQuerySchema>;

export const countSchema = z.object({ groupBy: z.string().trim().max(40).optional() });
export const unitAggregateSchema = z.object({ buildingId: idSchema.optional(), wingId: idSchema.optional() });
export const residentCountByKindSchema = z.object({ kind: z.enum(MEMBER_KINDS).optional() });
export const staffCountSchema = z.object({ type: z.enum(STAFF_TYPES).optional() });
export const vehicleCountSchema = z.object({ type: z.enum(VEHICLE_TYPES).optional() });
export const attendanceSummarySchema = z.object({
  from: dateStringSchema,
  to: dateStringSchema,
  staffId: idSchema.optional(),
});
export const outstandingByUnitSchema = z.object({ buildingId: idSchema.optional(), asOf: dateStringSchema.optional() });
export const vendorPerformanceSchema = z.object({ vendorId: idSchema, from: dateStringSchema, to: dateStringSchema });
export const parkingOccupancySchema = z.object({ areaId: idSchema.optional() });
export const unitProfileSchema = z.object({ unitId: idSchema });
export const residentProfileSchema = z.object({ residentId: idSchema });
export const gateActivitySchema = z.object({ gateId: idSchema.optional(), from: dateStringSchema, to: dateStringSchema });
