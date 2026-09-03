import { z } from 'zod';
import {
  SOCIETY_STATUS,
  SOCIETY_TYPES,
  UNIT_STATUS,
  UNIT_TYPES,
  OCCUPANCY_TYPES,
  GATE_TYPES,
  PARKING_SLOT_TYPES,
} from '../constants/enums.js';
import {
  addressSchema,
  dateStringSchema,
  emailSchema,
  geoPointSchema,
  hhmmSchema,
  idSchema,
  moneySchema,
  nameSchema,
  optionalEmailSchema,
  optionalPhoneSchema,
  phoneSchema,
  pincodeSchema,
  quantitySchema,
} from './common.js';

/* -------------------------------- Society -------------------------------- */

export const createSocietySchema = z.object({
  name: nameSchema,
  slug: z
    .string()
    .trim()
    .min(3)
    .max(60)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and dashes only')
    .optional(),
  type: z.enum(SOCIETY_TYPES).default('RESIDENTIAL_SOCIETY'),
  registrationNumber: z.string().trim().max(80).optional(),
  address: addressSchema.optional(),
  city: z.string().trim().max(80).optional(),
  state: z.string().trim().max(80).optional(),
  postalCode: pincodeSchema.optional(),
  timezone: z.string().trim().max(60).default('Asia/Kolkata'),
  currency: z.string().trim().length(3).default('INR'),
  contactPhone: optionalPhoneSchema,
  contactEmail: optionalEmailSchema,
  website: z.string().trim().url().max(200).optional(),
  logoUrl: z.string().trim().max(1000).optional(),
  totalUnits: quantitySchema.optional(),
  gstin: z.string().trim().max(20).optional(),
  pan: z.string().trim().max(15).optional(),
  location: geoPointSchema.optional(),
  planCode: z.string().trim().max(40).optional(),
  status: z.enum(SOCIETY_STATUS).default('DRAFT'),
});
export type CreateSocietyInput = z.infer<typeof createSocietySchema>;

export const updateSocietySchema = createSocietySchema.partial().omit({ slug: true });
export type UpdateSocietyInput = z.infer<typeof updateSocietySchema>;

/** Configurable business rules (§63) — nothing here is hard-coded in services. */
export const societySettingsSchema = z.object({
  visitor: z
    .object({
      requireResidentApproval: z.boolean().default(true),
      autoApprovePreApproved: z.boolean().default(true),
      allowNightEntry: z.boolean().default(false),
      nightStart: hhmmSchema.default('22:00'),
      nightEnd: hhmmSchema.default('06:00'),
      passValidityHours: z.coerce.number().int().min(1).max(720).default(24),
      maxVisitorsPerDay: z.coerce.number().int().min(1).max(500).default(50),
      captureVisitorPhoto: z.boolean().default(true),
      qrSingleUse: z.boolean().default(true),
    })
    .partial()
    .optional(),
  delivery: z
    .object({
      requireApproval: z.boolean().default(false),
      allowToDoor: z.boolean().default(false),
      maxStayMinutes: z.coerce.number().int().min(5).max(600).default(30),
    })
    .partial()
    .optional(),
  maintenance: z
    .object({
      generateDayOfMonth: z.coerce.number().int().min(1).max(28).default(1),
      dueDayOfMonth: z.coerce.number().int().min(1).max(28).default(10),
      lateFeeType: z.enum(['FIXED', 'PERCENT', 'PER_DAY']).default('FIXED'),
      lateFeeValue: moneySchema.default(0),
      graceDays: z.coerce.number().int().min(0).max(60).default(5),
      billingBasis: z.enum(['PER_UNIT', 'PER_SQFT', 'TIERED']).default('PER_SQFT'),
      ratePerSqft: moneySchema.default(0),
      autoGenerate: z.boolean().default(true),
      reminderDaysBeforeDue: z.array(z.coerce.number().int().min(0).max(30)).default([5, 2, 0]),
    })
    .partial()
    .optional(),
  amenity: z
    .object({
      requireApproval: z.boolean().default(false),
      maxAdvanceDays: z.coerce.number().int().min(1).max(180).default(30),
      cancellationHours: z.coerce.number().int().min(0).max(168).default(24),
      refundPercent: z.coerce.number().min(0).max(100).default(100),
    })
    .partial()
    .optional(),
  complaint: z
    .object({
      slaHoursByPriority: z
        .object({
          LOW: z.coerce.number().int().min(1).max(720).default(120),
          MEDIUM: z.coerce.number().int().min(1).max(720).default(72),
          HIGH: z.coerce.number().int().min(1).max(720).default(24),
          URGENT: z.coerce.number().int().min(1).max(720).default(8),
        })
        .partial()
        .optional(),
      autoAssign: z.boolean().default(false),
      requireResidentVerification: z.boolean().default(true),
      reopenWindowDays: z.coerce.number().int().min(0).max(60).default(7),
    })
    .partial()
    .optional(),
  security: z
    .object({
      gates: z.coerce.number().int().min(1).max(50).default(1),
      vehicleCheck: z.boolean().default(true),
      staffBiometric: z.boolean().default(false),
      patrolIntervalMinutes: z.coerce.number().int().min(0).max(480).default(0),
    })
    .partial()
    .optional(),
  emergency: z
    .object({
      contacts: z
        .array(
          z.object({
            label: z.string().trim().max(60),
            phone: phoneSchema,
            notify: z.boolean().default(true),
          }),
        )
        .max(20)
        .default([]),
      autoAlertAdmin: z.boolean().default(true),
      autoAlertSecurity: z.boolean().default(true),
    })
    .partial()
    .optional(),
  tax: z
    .object({
      enabled: z.boolean().default(false),
      gstin: z.string().trim().max(20).optional(),
      cgstPercent: z.coerce.number().min(0).max(50).default(0),
      sgstPercent: z.coerce.number().min(0).max(50).default(0),
      igstPercent: z.coerce.number().min(0).max(50).default(0),
    })
    .partial()
    .optional(),
  notification: z
    .object({
      pushEnabled: z.boolean().default(true),
      smsEnabled: z.boolean().default(false),
      emailEnabled: z.boolean().default(true),
      whatsappEnabled: z.boolean().default(false),
      quietHoursStart: hhmmSchema.optional(),
      quietHoursEnd: hhmmSchema.optional(),
    })
    .partial()
    .optional(),
  theme: z
    .object({
      primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#4F46E5'),
      accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#0EA5E9'),
    })
    .partial()
    .optional(),
});
export type SocietySettingsInput = z.infer<typeof societySettingsSchema>;

/* --------------------- Buildings / wings / floors / units ------------------- */

export const createBuildingSchema = z.object({
  name: z.string().trim().min(1).max(60),
  code: z.string().trim().min(1).max(20),
  type: z.enum(['TOWER', 'BUILDING', 'BLOCK', 'VILLA_ROW', 'COMMERCIAL']).default('TOWER'),
  totalFloors: z.coerce.number().int().min(1).max(200).default(1),
  unitsPerFloor: z.coerce.number().int().min(0).max(200).default(0),
  hasWings: z.boolean().default(false),
  address: addressSchema.optional(),
  yearBuilt: z.coerce.number().int().min(1800).max(2200).optional(),
  liftCount: z.coerce.number().int().min(0).max(20).default(0),
  isActive: z.boolean().default(true),
});
export type CreateBuildingInput = z.infer<typeof createBuildingSchema>;
export const updateBuildingSchema = createBuildingSchema.partial();

export const createWingSchema = z.object({
  buildingId: idSchema,
  name: z.string().trim().min(1).max(40),
  code: z.string().trim().min(1).max(10),
  totalFloors: z.coerce.number().int().min(1).max(200).default(1),
  isActive: z.boolean().default(true),
});
export type CreateWingInput = z.infer<typeof createWingSchema>;
export const updateWingSchema = createWingSchema.partial().omit({ buildingId: true });

export const createFloorSchema = z.object({
  buildingId: idSchema,
  wingId: idSchema.optional().nullable(),
  number: z.coerce.number().int().min(-5).max(300),
  name: z.string().trim().max(40).optional(),
  isActive: z.boolean().default(true),
});
export type CreateFloorInput = z.infer<typeof createFloorSchema>;
export const updateFloorSchema = createFloorSchema.partial();

export const createUnitSchema = z.object({
  buildingId: idSchema,
  wingId: idSchema.optional().nullable(),
  floorId: idSchema.optional().nullable(),
  floorNumber: z.coerce.number().int().min(-5).max(300).optional(),
  unitNumber: z.string().trim().min(1).max(20),
  type: z.enum(UNIT_TYPES).default('FLAT'),
  carpetAreaSqft: z.coerce.number().min(0).max(100000).optional(),
  builtUpAreaSqft: z.coerce.number().min(0).max(100000).optional(),
  bedrooms: z.coerce.number().int().min(0).max(20).optional(),
  bathrooms: z.coerce.number().int().min(0).max(20).optional(),
  balconies: z.coerce.number().int().min(0).max(20).optional(),
  status: z.enum(UNIT_STATUS).default('VACANT'),
  occupancyType: z.enum(OCCUPANCY_TYPES).default('VACANT'),
  parkingSlotIds: z.array(idSchema).max(10).default([]),
  maintenanceRate: moneySchema.optional(),
  isActive: z.boolean().default(true),
});
export type CreateUnitInput = z.infer<typeof createUnitSchema>;
export const updateUnitSchema = createUnitSchema.partial();

/** Bulk unit generation used by the onboarding wizard. */
export const generateUnitsSchema = z.object({
  buildingId: idSchema,
  wingId: idSchema.optional().nullable(),
  floors: z.coerce.number().int().min(1).max(200),
  unitsPerFloor: z.coerce.number().int().min(1).max(100),
  numberingPattern: z.enum(['FLOOR_FIRST', 'WING_FIRST', 'SEQUENTIAL']).default('FLOOR_FIRST'),
  prefix: z.string().trim().max(6).default(''),
  startNumber: z.coerce.number().int().min(0).max(9999).default(1),
  unitType: z.enum(UNIT_TYPES).default('FLAT'),
  carpetAreaSqft: z.coerce.number().min(0).max(100000).optional(),
  createFloors: z.boolean().default(true),
});
export type GenerateUnitsInput = z.infer<typeof generateUnitsSchema>;

/** CSV/Excel import of units + residents during onboarding (§41). */
export const importUnitsSchema = z.object({
  buildingId: idSchema.optional(),
  /** Raw CSV text; parsed server-side so no client library is required. */
  csv: z.string().min(1).max(5_000_000),
  createBuildings: z.boolean().default(true),
  createFloors: z.boolean().default(true),
  dryRun: z.boolean().default(false),
});
export type ImportUnitsInput = z.infer<typeof importUnitsSchema>;

/* --------------------------------- Gates --------------------------------- */

export const createGateSchema = z.object({
  name: z.string().trim().min(1).max(60),
  code: z.string().trim().min(1).max(20),
  type: z.enum(GATE_TYPES).default('MAIN'),
  allowsVehicles: z.boolean().default(true),
  allowsPedestrians: z.boolean().default(true),
  isOpen24x7: z.boolean().default(true),
  openTime: hhmmSchema.optional(),
  closeTime: hhmmSchema.optional(),
  location: geoPointSchema.optional(),
  isActive: z.boolean().default(true),
});
export type CreateGateInput = z.infer<typeof createGateSchema>;
export const updateGateSchema = createGateSchema.partial();

/* ------------------------------- Parking --------------------------------- */

export const createParkingAreaSchema = z.object({
  name: z.string().trim().min(1).max(60),
  code: z.string().trim().min(1).max(20),
  level: z.string().trim().max(20).optional(),
  buildingId: idSchema.optional().nullable(),
  capacity: quantitySchema.default(0),
  isActive: z.boolean().default(true),
});
export type CreateParkingAreaInput = z.infer<typeof createParkingAreaSchema>;

export const createParkingSlotSchema = z.object({
  areaId: idSchema.optional().nullable(),
  slotNumber: z.string().trim().min(1).max(20),
  type: z.enum(PARKING_SLOT_TYPES).default('RESERVED'),
  capacity: z.coerce.number().int().min(1).max(10).default(1),
  isEv: z.boolean().default(false),
  hasCharger: z.boolean().default(false),
  monthlyCharge: moneySchema.default(0),
  buildingId: idSchema.optional().nullable(),
  assignedUnitId: idSchema.optional().nullable(),
  isActive: z.boolean().default(true),
});
export type CreateParkingSlotInput = z.infer<typeof createParkingSlotSchema>;
export const updateParkingSlotSchema = createParkingSlotSchema.partial();

export const assignParkingSlotSchema = z.object({
  unitId: idSchema,
  vehicleId: idSchema.optional(),
  startDate: dateStringSchema.optional(),
});

/* ------------------------------ Onboarding ------------------------------- */

export const onboardingStepSchema = z.discriminatedUnion('step', [
  z.object({ step: z.literal('society'), payload: createSocietySchema }),
  z.object({ step: z.literal('buildings'), payload: z.array(createBuildingSchema).min(1).max(500) }),
  z.object({
    step: z.literal('wings'),
    payload: z.array(createWingSchema).max(2000),
  }),
  z.object({ step: z.literal('floors'), payload: z.array(createFloorSchema).max(20000) }),
  z.object({
    step: z.literal('units'),
    payload: z.union([z.array(createUnitSchema).max(50000), generateUnitsSchema, importUnitsSchema]),
  }),
  z.object({
    step: z.literal('admin'),
    payload: z.object({
      fullName: nameSchema,
      email: emailSchema,
      phone: phoneSchema,
      role: z.enum(['SOCIETY_ADMIN', 'CHAIRMAN', 'SECRETARY']).default('SOCIETY_ADMIN'),
      password: z.string().min(8).max(128).optional(),
    }),
  }),
  z.object({
    step: z.literal('subscription'),
    payload: z.object({
      planId: idSchema,
      billingCycle: z.enum(['MONTHLY', 'QUARTERLY', 'YEARLY']).default('MONTHLY'),
      trialDays: z.coerce.number().int().min(0).max(90).default(14),
    }),
  }),
  z.object({
    step: z.literal('configuration'),
    payload: z.object({
      settings: societySettingsSchema.optional(),
      gates: z.array(createGateSchema).max(50).optional(),
      amenities: z.array(z.object({ name: z.string().trim().min(1).max(60) })).max(100).optional(),
    }),
  }),
  z.object({ step: z.literal('activate'), payload: z.object({ confirm: z.literal(true) }) }),
]);
export type OnboardingStepInput = z.infer<typeof onboardingStepSchema>;
