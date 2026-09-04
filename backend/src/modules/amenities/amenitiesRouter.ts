import { Router } from 'express';
import { z } from 'zod';
import { idSchema } from '@colonize/shared/validation';
import type { ModuleKey } from '@colonize/shared';
import { buildCrudRouter } from '../_shared/crud.js';
import { authenticate, requireTenantContext } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/permissions.js';
import { asyncHandler } from '../../middleware/errors.js';
import { validate } from '../../middleware/validate.js';
import { ok, created } from '../../utils/response.js';
import { ApiError } from '../../utils/errors.js';
import { serialise } from '../../utils/serialize.js';
import { newId } from '../../db/ids.js';
import type { AmenitiesContext } from './amenityService.js';
import * as amenityService from './amenityService.js';

/**
 * Amenities and bookings (§22, §57).
 *
 *   GET  /api/amenities                     what can be booked
 *   GET  /api/amenities/:id/availability    free slots for a day
 *   POST /api/amenity-bookings              book a slot (atomic, no double booking)
 *   GET  /api/amenity-bookings/mine         the resident app's list
 *   GET  /api/amenity-bookings/:id/qr       the entry pass
 *   POST /api/amenity-bookings/:id/cancel   cancel with the amenity's refund policy
 *   POST /api/gate/scan  (mode AMENITY_BOOKING)  clubhouse/gate check-in
 */

function ctxFrom(req: import('express').Request): AmenitiesContext {
  const c = requireTenantContext(req);
  return {
    db: c.db,
    societyId: c.society.id,
    actorId: c.principal.userId,
    actorName: c.principal.fullName,
    gateId: c.membership.gateIds?.[0] ?? null,
  };
}

const amenitySchema = z.object({
  name: z.string().trim().min(2).max(80),
  type: z
    .enum([
      'CLUBHOUSE', 'SWIMMING_POOL', 'GYM', 'PARTY_HALL', 'GARDEN', 'SPORTS_COURT', 'COMMUNITY_HALL',
      'MEETING_ROOM', 'LIBRARY', 'INDOOR_GAMES', 'YOGA_DECK', 'PLAYGROUND', 'BBQ_AREA', 'AMPHITHEATRE', 'OTHER',
    ])
    .default('OTHER'),
  description: z.string().trim().max(2000).optional(),
  rules: z.array(z.string().trim().max(300)).max(30).default([]),
  capacity: z.coerce.number().int().min(1).max(10000).default(1),
  openTime: z.string().trim().regex(/^\d{2}:\d{2}$/).default('06:00'),
  closeTime: z.string().trim().regex(/^\d{2}:\d{2}$/).default('22:00'),
  slotDurationMinutes: z.coerce.number().int().min(15).max(1440).default(60),
  slotGapMinutes: z.coerce.number().int().min(0).max(240).default(0),
  bookingFee: z.coerce.number().min(0).max(1_000_000).default(0),
  deposit: z.coerce.number().min(0).max(1_000_000).default(0),
  requireApproval: z.coerce.boolean().default(false),
  allowCancellation: z.coerce.boolean().default(true),
  cancellationHoursBefore: z.coerce.number().int().min(0).max(720).default(24),
  refundPercent: z.coerce.number().int().min(0).max(100).default(100),
  maxAdvanceDays: z.coerce.number().int().min(1).max(365).default(30),
  maxSlotsPerUserPerDay: z.coerce.number().int().min(1).max(48).default(2),
  closedOnDays: z.array(z.union([z.string().trim().max(12), z.coerce.number().int().min(0).max(6)])).max(7).default([]),
  photoUrl: z.string().trim().max(1000).optional(),
  buildingId: idSchema.optional().nullable(),
  isActive: z.coerce.boolean().default(true),
});

const bookSchema = z.object({
  amenityId: idSchema,
  date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/),
  startTime: z.string().trim().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().trim().regex(/^\d{2}:\d{2}$/).optional(),
  slotId: idSchema.optional().nullable(),
  numberOfPeople: z.coerce.number().int().min(1).max(10000).default(1),
  purpose: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(500).optional(),
  clientRequestId: z.string().trim().min(6).max(80).optional(),
});

/* -------------------------------- amenities -------------------------------- */

const amenitiesCrud = buildCrudRouter<z.infer<typeof amenitySchema>, z.infer<typeof amenitySchema>>({
  collection: 'amenities',
  unitScoped: false, // society-wide: no unitId column on this collection
  permission: 'amenity',
  moduleKey: 'amenities' as ModuleKey,
  label: 'Amenity',
  createSchema: amenitySchema,
  updateSchema: amenitySchema.partial(),
  searchFields: ['name', 'description', 'type'],
  filterFields: ['type', 'isActive', 'requireApproval', 'buildingId'],
  sortableFields: ['name', 'type', 'bookingFee', 'capacity', 'totalBookings', 'createdAt'],
  defaultSort: 'name',
  prepareCreate: (ctx, body) => ({ ...body, createdBy: ctx.principal.userId, updatedBy: ctx.principal.userId }),
});

export const amenitiesRouter: Router = Router();

amenitiesRouter.get(
  '/:id/availability',
  authenticate(),
  requirePermission('amenity:view'),
  validate(z.object({ date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/) }), 'query'),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const result = await amenityService.getAvailability(ctxFrom(req), {
      amenityId: String(req.params.id),
      date: String(req.query.date),
      timezone: c.society.timezone,
    });
    return ok(res, result, result.closed ? `${result.reason}` : 'Availability fetched');
  }),
);

/** Recurring slot windows an admin defines ("Pool: Mon–Fri 06:00–08:00, capacity 20"). */
amenitiesRouter.post(
  '/:id/slots',
  authenticate(),
  requirePermission('amenity:update', 'amenity:manage'),
  validate(
    z.object({
      dayOfWeek: z.coerce.number().int().min(0).max(6).nullable().optional(),
      startTime: z.string().trim().regex(/^\d{2}:\d{2}$/),
      endTime: z.string().trim().regex(/^\d{2}:\d{2}$/),
      capacity: z.coerce.number().int().min(1).max(10000).optional(),
      fee: z.coerce.number().min(0).max(1_000_000).optional(),
      isBlocked: z.coerce.boolean().default(false),
      validFrom: z.string().trim().max(30).optional(),
      validTill: z.string().trim().max(30).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const amenityId = String(req.params.id);
    const amenity = await c.db.collection('amenities').findOne({ societyId: c.society.id, _id: amenityId });
    if (!amenity) throw ApiError.notFound('Amenity');
    const body = req.body as Record<string, unknown>;

    const slot = await c.db.collection('amenity_slots').create({
      _id: newId('amenity_slots'),
      societyId: c.society.id,
      amenityId,
      dayOfWeek: body.dayOfWeek ?? null,
      startTime: body.startTime,
      endTime: body.endTime,
      capacity: Number(body.capacity ?? amenity.capacity ?? 1),
      fee: Number(body.fee ?? amenity.bookingFee ?? 0),
      isBlocked: Boolean(body.isBlocked),
      validFrom: body.validFrom ? new Date(String(body.validFrom)) : null,
      validTill: body.validTill ? new Date(String(body.validTill)) : null,
      isActive: true,
      createdBy: c.principal.userId,
      updatedBy: c.principal.userId,
    });
    return created(res, slot, 'Availability window added');
  }),
);

amenitiesRouter.get(
  '/:id/slots',
  authenticate(),
  requirePermission('amenity:view'),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const items = await c.db.collection('amenity_slots').find(
      { societyId: c.society.id, amenityId: String(req.params.id) },
      { sort: { dayOfWeek: 1, startTime: 1 }, limit: 500 },
    );
    return ok(res, { items }, 'Availability windows fetched');
  }),
);

amenitiesRouter.delete(
  '/slots/:slotId',
  authenticate(),
  requirePermission('amenity:update', 'amenity:manage'),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const result = await c.db.collection('amenity_slots').updateOne(
      { societyId: c.society.id, _id: String(req.params.slotId) },
      { $set: { isActive: false, deletedAt: new Date() } },
    );
    if (result.matched === 0) throw ApiError.notFound('Availability window');
    return ok(res, { removed: String(req.params.slotId) }, 'Availability window removed');
  }),
);

amenitiesRouter.use(amenitiesCrud);

/* -------------------------------- bookings --------------------------------- */

const bookingsCrud = buildCrudRouter({
  collection: 'amenity_bookings',
  permission: 'amenitybooking',
  moduleKey: 'amenities' as ModuleKey,
  label: 'Booking',
  searchFields: ['referenceNumber', 'purpose'],
  filterFields: ['amenityId', 'unitId', 'status', 'userId', 'isPaid'],
  dateRangeField: 'date',
  sortableFields: ['date', 'startTime', 'createdAt', 'totalAmount', 'status'],
  defaultSort: 'date',
  defaultSortDir: 'desc',
  allowCreate: false,
  populate: [
    { field: 'amenityId', collection: 'amenities', pick: ['name', 'type', 'photoUrl'], as: 'amenity' },
    { field: 'unitId', collection: 'units', pick: ['label', 'unitNumber'], as: 'unit' },
  ],
});

export const amenityBookingsRouter: Router = Router();

amenityBookingsRouter.post(
  '/',
  authenticate({ clientScopes: ['resident', 'console'] }),
  requirePermission('amenitybooking:book', 'amenitybooking:create'),
  validate(bookSchema),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const body = req.body as z.infer<typeof bookSchema>;

    // §51: the booking is always against the caller's own flat.
    const unitId = c.principal.isResidentScope ? c.membership.primaryUnitId ?? c.membership.unitIds[0] : (body as Record<string, unknown>).unitId as string;
    if (!unitId) throw ApiError.forbidden('Your account is not linked to a flat in this society');

    const result = await amenityService.bookAmenity(ctxFrom(req), {
      ...body,
      unitId,
      residentId: c.membership.residentId ?? undefined,
      userId: c.principal.userId,
      timezone: c.society.timezone,
    });

    return created(
      res,
      {
        booking: serialise(result.booking),
        referenceNumber: result.booking.referenceNumber,
        status: result.booking.status,
        totalAmount: result.totalAmount,
        requirePayment: result.requirePayment,
        requireApproval: result.requireApproval,
        duplicate: Boolean(result.duplicate),
        qr: result.pass ? { passId: result.pass._id, token: result.pass.token, dataUrl: result.pass.dataUrl, validFrom: result.pass.validFrom, validTill: result.pass.validTill } : null,
      },
      result.requirePayment
        ? `Slot held. Pay ₹${result.totalAmount} to confirm ${result.booking.referenceNumber}.`
        : result.requireApproval
          ? `Booking ${result.booking.referenceNumber} sent for approval`
          : `Booking ${result.booking.referenceNumber} confirmed`,
    );
  }),
);

amenityBookingsRouter.get(
  '/mine',
  authenticate({ clientScopes: ['resident'] }),
  validate(z.object({ status: z.string().trim().max(30).optional(), upcoming: z.coerce.boolean().default(true), limit: z.coerce.number().int().min(1).max(100).default(25) }), 'query'),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const q = req.query as Record<string, string>;
    const filter: Record<string, unknown> = { societyId: c.society.id, unitId: { $in: c.membership.unitIds } };
    if (q.status) filter.status = q.status;
    if (q.upcoming !== 'false') filter.windowEnd = { $gte: new Date(Date.now() - 86_400_000) };

    const items = await c.db.collection('amenity_bookings').find(filter, { sort: { date: -1, startTime: -1 }, limit: Number(q.limit ?? 25) });
    const amenityIds = Array.from(new Set(items.map((b) => String(b.amenityId))));
    const amenities = amenityIds.length
      ? await c.db.collection('amenities').find({ societyId: c.society.id, _id: { $in: amenityIds } }, { limit: amenityIds.length })
      : [];
    const byId = new Map(amenities.map((a) => [String(a._id), a]));

    return ok(
      res,
      {
        items: items.map((b) => ({
          ...serialise(b),
          amenity: byId.get(String(b.amenityId)) ? { id: byId.get(String(b.amenityId))!._id, name: byId.get(String(b.amenityId))!.name, type: byId.get(String(b.amenityId))!.type, photoUrl: byId.get(String(b.amenityId))!.photoUrl ?? null } : null,
          hasPass: Boolean(b.passId),
        })),
      },
      'Your bookings',
    );
  }),
);

amenityBookingsRouter.get(
  '/calendar',
  authenticate(),
  requirePermission('amenitybooking:view'),
  validate(z.object({ amenityId: idSchema.optional(), from: z.string().trim().max(30).optional(), to: z.string().trim().max(30).optional() }), 'query'),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const q = req.query as Record<string, string>;
    const filter: Record<string, unknown> = { societyId: c.society.id, status: { $nin: ['CANCELLED', 'REJECTED'] } };
    if (q.amenityId) filter.amenityId = q.amenityId;
    if (q.from || q.to) {
      const range: Record<string, Date> = {};
      if (q.from) range.$gte = new Date(`${q.from}T00:00:00.000Z`);
      if (q.to) range.$lte = new Date(`${q.to}T23:59:59.999Z`);
      filter.date = range;
    }
    const items = await c.db.collection('amenity_bookings').find(filter, { sort: { date: 1, startTime: 1 }, limit: 2000 });

    const byDate: Record<string, unknown[]> = {};
    for (const b of items) {
      const key = new Date(b.date as string | Date).toISOString().slice(0, 10);
      (byDate[key] ||= []).push({
        id: b._id,
        referenceNumber: b.referenceNumber,
        amenityId: b.amenityId,
        startTime: b.startTime,
        endTime: b.endTime,
        status: b.status,
        numberOfPeople: b.numberOfPeople,
      });
    }
    return ok(res, { from: q.from ?? null, to: q.to ?? null, days: byDate, total: items.length }, 'Booking calendar fetched');
  }),
);

amenityBookingsRouter.get(
  '/:id/qr',
  authenticate({ clientScopes: ['resident', 'console'] }),
  requirePermission('amenitybooking:view'),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const booking = await c.db.collection('amenity_bookings').findOne({ societyId: c.society.id, _id: String(req.params.id) });
    if (!booking) throw ApiError.notFound('Booking');
    if (c.principal.isResidentScope && !c.membership.unitIds.includes(String(booking.unitId))) {
      throw ApiError.forbidden('You can only view passes for bookings made from your own flat');
    }
    return ok(res, await amenityService.bookingQr(ctxFrom(req), String(req.params.id)), 'Booking pass fetched');
  }),
);

amenityBookingsRouter.post(
  '/:id/decide',
  authenticate(),
  requirePermission('amenitybooking:approve'),
  validate(z.object({ decision: z.enum(['APPROVE', 'REJECT']), reason: z.string().trim().max(300).optional() })),
  asyncHandler(async (req, res) => {
    const body = req.body as { decision: 'APPROVE' | 'REJECT'; reason?: string };
    const result = await amenityService.decideBooking(ctxFrom(req), String(req.params.id), body.decision, body.reason);
    return ok(res, result, body.decision === 'APPROVE' ? 'Booking approved' : 'Booking rejected');
  }),
);

amenityBookingsRouter.post(
  '/:id/cancel',
  authenticate(),
  requirePermission('amenitybooking:cancel', 'amenitybooking:update'),
  validate(z.object({ reason: z.string().trim().max(300).optional() })),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const booking = await c.db.collection('amenity_bookings').findOne({ societyId: c.society.id, _id: String(req.params.id) });
    if (!booking) throw ApiError.notFound('Booking');
    if (c.principal.isResidentScope && !c.membership.unitIds.includes(String(booking.unitId))) {
      throw ApiError.forbidden('You can only cancel bookings made from your own flat');
    }
    const body = req.body as { reason?: string };
    const result = await amenityService.cancelBooking(ctxFrom(req), String(req.params.id), body.reason);
    return ok(
      res,
      result,
      result.refundAmount > 0 ? `Booking cancelled — ₹${result.refundAmount} will be refunded` : 'Booking cancelled',
    );
  }),
);

/** Guard/clubhouse check-in. Also reachable through POST /api/gate/scan with mode=AMENITY_BOOKING. */
amenityBookingsRouter.post(
  '/:id/check-in',
  authenticate({ clientScopes: ['security', 'console', 'staff'] }),
  requirePermission('amenitybooking:scan', 'amenitybooking:update'),
  validate(z.object({ gateId: idSchema.optional() })),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const booking = await c.db.collection('amenity_bookings').findOne({ societyId: c.society.id, _id: String(req.params.id) });
    if (!booking) throw ApiError.notFound('Booking');
    if (booking.checkedInAt) {
      return ok(res, { bookingId: booking._id, checkedInAt: booking.checkedInAt, alreadyCheckedIn: true }, 'Already checked in');
    }

    // Check-in by id (no QR): validate the booking's own window, then stamp it.
    const now = new Date();
    const start = new Date(booking.windowStart as string | Date);
    const end = new Date(booking.windowEnd as string | Date);
    if (booking.status !== 'CONFIRMED') throw ApiError.conflict(`This booking is ${String(booking.status).toLowerCase().replace('_', ' ')}`);
    if (now < new Date(start.getTime() - 15 * 60_000) || now > new Date(end.getTime() + 15 * 60_000)) {
      throw ApiError.badRequest('Outside this booking\'s time window');
    }
    await c.db.collection('amenity_bookings').updateOne(
      { societyId: c.society.id, _id: booking._id },
      { $set: { checkedInAt: now, updatedBy: c.principal.userId } },
    );
    return ok(res, { bookingId: booking._id, checkedInAt: now, referenceNumber: booking.referenceNumber }, 'Checked in');
  }),
);

amenityBookingsRouter.post(
  '/:id/check-out',
  authenticate({ clientScopes: ['security', 'console', 'staff'] }),
  requirePermission('amenitybooking:scan', 'amenitybooking:update'),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const booking = await c.db.collection('amenity_bookings').findOne({ societyId: c.society.id, _id: String(req.params.id) });
    if (!booking) throw ApiError.notFound('Booking');
    if (!booking.checkedInAt) throw ApiError.conflict('This booking was never checked in');
    const now = new Date();
    await c.db.collection('amenity_bookings').updateOne(
      { societyId: c.society.id, _id: booking._id },
      { $set: { checkedOutAt: now, status: 'COMPLETED', updatedBy: c.principal.userId } },
    );
    const minutes = Math.max(0, Math.round((now.getTime() - new Date(booking.checkedInAt as string | Date).getTime()) / 60_000));
    return ok(res, { bookingId: booking._id, checkedOutAt: now, durationMinutes: minutes }, `Checked out after ${minutes} minutes`);
  }),
);

/** Housekeeping, also run by the scheduler. */
amenityBookingsRouter.post(
  '/reconcile',
  authenticate(),
  requirePermission('amenitybooking:manage'),
  asyncHandler(async (req, res) => {
    const ctx = ctxFrom(req);
    const [reconciled, expired] = await Promise.all([
      amenityService.reconcilePastBookings(ctx),
      amenityService.expireUnpaidBookings(ctx),
    ]);
    return ok(res, { ...reconciled, unpaidExpired: expired }, 'Bookings reconciled');
  }),
);

amenityBookingsRouter.use(bookingsCrud);
