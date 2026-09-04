import { z } from 'zod';

/**
 * Reusable validation primitives.
 *
 * `idSchema` deliberately accepts both 24-hex Mongo ObjectIds and the platform's own
 * prefixed ids (`soc_…`, `unit_…`) because the persistence layer supports more than one
 * driver. It is still strict enough to block injection-shaped input.
 */
export const idSchema = z
  .string()
  .trim()
  .min(3, 'Id is required')
  .max(64, 'Id is too long')
  .regex(/^[A-Za-z0-9_-]+$/, 'Id contains invalid characters');

export const optionalIdSchema = idSchema.optional().nullable();

export const objectIdSchema = z.string().trim().regex(/^[0-9a-fA-F]{24}$/, 'Invalid record id');

/** Indian mobile: 10 digits, optionally +91 / 0 prefixed. */
export const phoneSchema = z
  .string()
  .trim()
  .min(10, 'Mobile number is required')
  .max(16, 'Mobile number is too long')
  .regex(/^[+]?[0-9\s-]{8,16}$/, 'Enter a valid mobile number')
  .transform((v) => v.replace(/[^\d+]/g, ''));

/**
 * Optional-field helpers.
 *
 * `.optional()` must wrap the *outside* of the union/transform, not sit inside the union. Zod 4
 * decides whether an object key may be absent by inspecting the outermost schema's optionality
 * flag; a `z.union([... z.undefined()])` fed through `.transform()` does not carry that flag, so
 * `z.object({ email: optionalEmailSchema }).parse({})` fails with
 * "expected nonoptional, received undefined" even though parsing `undefined` standalone succeeds.
 * Every optional field in every request body would then be mandatory-by-accident.
 *
 * All three accept the same four shapes for consistency — a real client may send a value, an
 * empty string, an explicit `null`, or omit the key entirely:
 *   string → normalised value · '' / null / undefined / absent → undefined
 */
export const optionalPhoneSchema = z
  .union([phoneSchema, z.literal(''), z.null()])
  .transform((v) => (typeof v === 'string' && v.length > 0 ? v : undefined))
  .optional();

export const emailSchema = z.string().trim().toLowerCase().email('Enter a valid email address').max(160);
export const optionalEmailSchema = z
  .union([emailSchema, z.literal(''), z.null()])
  .transform((v) => (typeof v === 'string' && v.length > 0 ? v : undefined))
  .optional();

export const nameSchema = z
  .string()
  .trim()
  .min(2, 'Name must be at least 2 characters')
  .max(80, 'Name must be under 80 characters')
  .regex(/^[\p{L}\p{N}\s.'-]+$/u, 'Name contains invalid characters');

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password must be under 128 characters')
  .refine((v) => /[a-zA-Z]/.test(v) && /[0-9]/.test(v), {
    message: 'Password must contain at least one letter and one number',
  });

/** Indian vehicle plate: MH31AB1234 / MH 31 AB 1234. */
export const vehicleNumberSchema = z
  .string()
  .trim()
  .min(6, 'Enter a valid vehicle number')
  .max(16, 'Vehicle number is too long')
  .regex(/^[A-Z]{2,3}[\s-]?\d{1,4}[\s-]?[A-Z]{0,3}[\s-]?\d{1,4}$/i, 'Enter a valid vehicle number (e.g. MH31AB1234)')
  .transform((v) => v.toUpperCase().replace(/[\s-]/g, ''));

export const gstinSchema = z
  .string()
  .trim()
  .regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/, 'Enter a valid GSTIN');

export const panSchema = z.string().trim().regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'Enter a valid PAN');

export const ifscSchema = z.string().trim().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Enter a valid IFSC code');

export const pincodeSchema = z.string().trim().regex(/^\d{6}$/, 'Enter a valid 6-digit PIN code');

export const dateSchema = z.coerce.date();
export const optionalDateSchema = z
  .union([z.coerce.date(), z.literal(''), z.null()])
  .transform((v) => (v instanceof Date ? v : undefined))
  .optional();

/** `YYYY-MM-DD` local date, validated as a real calendar date. */
export const dateStringSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')
  .refine((v) => !Number.isNaN(new Date(`${v}T00:00:00Z`).getTime()), 'Enter a valid date');

export const hhmmSchema = z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use the format HH:mm');

/** Bounded positive money value (rupees, up to 2 decimals). */
export const moneySchema = z.coerce
  .number()
  .min(0, 'Amount cannot be negative')
  .max(100_000_000, 'Amount is too large')
  .transform((v) => Math.round(v * 100) / 100);

export const quantitySchema = z.coerce.number().int().min(0).max(100000);

export const attachmentSchema = z.object({
  id: idSchema,
  url: z.string().max(2000),
  name: z.string().max(200),
  mimeType: z.string().max(120).optional(),
  size: z.coerce.number().int().nonnegative().optional(),
  kind: z.enum(['image', 'video', 'pdf', 'other']).optional(),
});

export const addressSchema = z.object({
  line1: z.string().trim().max(200).optional(),
  line2: z.string().trim().max(200).optional(),
  city: z.string().trim().max(80).optional(),
  state: z.string().trim().max(80).optional(),
  postalCode: pincodeSchema.optional(),
  country: z.string().trim().max(80).optional(),
});

export const geoPointSchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
});

/** List/filter/pagination query accepted by every collection endpoint. */
export const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(20),
  sortBy: z.string().trim().max(60).optional(),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
  search: z.string().trim().max(120).optional(),
  status: z.string().trim().max(60).optional(),
  from: dateStringSchema.optional(),
  to: dateStringSchema.optional(),
  buildingId: optionalIdSchema,
  wingId: optionalIdSchema,
  floorId: optionalIdSchema,
  unitId: optionalIdSchema,
});
export type ListQuery = z.infer<typeof listQuerySchema>;

export const idRangeSchema = z.object({
  from: dateStringSchema.optional(),
  to: dateStringSchema.optional(),
});

/** Bulk operation payload (admin tables support multi-select actions). */
export const bulkIdsSchema = z.object({
  ids: z.array(idSchema).min(1, 'Select at least one record').max(500, 'Too many records selected'),
});
export type BulkIds = z.infer<typeof bulkIdsSchema>;

export const deviceInfoSchema = z.object({
  deviceId: z.string().trim().max(120).optional(),
  platform: z.enum(['ios', 'android', 'web', 'unknown']).optional(),
  appVersion: z.string().trim().max(40).optional(),
  osVersion: z.string().trim().max(40).optional(),
  model: z.string().trim().max(80).optional(),
  pushToken: z.string().trim().max(500).optional(),
});
export type DeviceInfoInput = z.infer<typeof deviceInfoSchema>;
