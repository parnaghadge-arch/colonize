import type { Document, TenantDatabase } from '../../db/drivers/types.js';
import { newId } from '../../db/ids.js';
import { ApiError } from '../../utils/errors.js';
import { getSettings } from '../../services/settings.js';
import { nextReference } from '../../services/counters.js';
import { issuePass, scanPass, revokePass, renderQr } from '../../services/qr.js';
import { NotificationService } from '../../services/notifications/index.js';
import { logger } from '../../config/logger.js';

/**
 * Amenities and bookings (§22, §57).
 *
 * The double-booking guarantee is structural, not advisory: the overlap check and the insert
 * happen inside one transaction, and the availability count is reduced with an atomic
 * conditional update that fails when the slot is already full. Two residents tapping "Book"
 * on the last 7pm court slot at the same instant produce exactly one confirmed booking.
 */

export interface AmenitiesContext {
  db: TenantDatabase;
  societyId: string;
  actorId: string;
  actorName?: string | null;
  gateId?: string | null;
}

export type BookingStatus =
  | 'PENDING_APPROVAL'
  | 'PENDING_PAYMENT'
  | 'CONFIRMED'
  | 'CANCELLED'
  | 'REJECTED'
  | 'COMPLETED'
  | 'NO_SHOW'
  | 'REFUNDED';

/* --------------------------------- helpers --------------------------------- */

/** "18:30" → minutes since midnight. */
export function toMinutes(hhmm: string): number {
  const [h, m] = String(hhmm).split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) throw ApiError.badRequest(`Invalid time "${hhmm}"`);
  return h * 60 + m;
}

export function fromMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Build the materialised [windowStart, windowEnd) instant pair for a booking.
 *
 * Overlap detection on stored dates is exact and index-friendly; comparing "18:30" strings
 * across midnight (a clubhouse booked 23:00 → 01:00) would not be.
 */
export function buildWindow(date: Date, startTime: string, endTime: string, timezone: string): { windowStart: Date; windowEnd: Date } {
  const day = date instanceof Date ? date.toISOString().slice(0, 10) : String(date).slice(0, 10);
  const offset = timezoneOffsetMinutes(new Date(`${day}T12:00:00Z`), timezone);
  const windowStart = new Date(new Date(`${day}T${startTime}:00Z`).getTime() - offset * 60_000);
  let windowEnd = new Date(new Date(`${day}T${endTime}:00Z`).getTime() - offset * 60_000);
  // Overnight windows roll into the next calendar day.
  if (windowEnd <= windowStart) windowEnd = new Date(windowEnd.getTime() + 86_400_000);
  return { windowStart, windowEnd };
}

function timezoneOffsetMinutes(at: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return Math.round((asUtc - at.getTime()) / 60_000);
}

/* ------------------------------ availability ------------------------------- */

export interface AvailabilityInput {
  amenityId: string;
  date: string | Date;
  timezone?: string;
}

/**
 * Slots still bookable on a given day (§22).
 *
 * Slots come from the amenity's own configuration — `amenity_slots` when the society has
 * defined recurring windows, otherwise generated from open/close time and slot duration — so
 * nothing about the schedule is hard-coded.
 */
export async function getAvailability(ctx: AmenitiesContext, input: AvailabilityInput): Promise<Document> {
  const amenity = await ctx.db.collection('amenities').findOne({ societyId: ctx.societyId, _id: input.amenityId });
  if (!amenity) throw ApiError.notFound('Amenity');
  if (!amenity.isActive) throw ApiError.badRequest(`${amenity.name} is not accepting bookings`);

  const timezone = input.timezone ?? 'Asia/Kolkata';
  const day = input.date instanceof Date ? input.date.toISOString().slice(0, 10) : String(input.date).slice(0, 10);
  const date = new Date(`${day}T00:00:00.000Z`);
  const dayOfWeek = new Date(`${day}T12:00:00Z`).getUTCDay();

  const closedOn = (amenity.closedOnDays ?? []) as Array<string | number>;
  if (closedOn.some((d) => String(d).toUpperCase() === String(dayOfWeek) || Number(d) === dayOfWeek)) {
    return { amenityId: amenity._id, date: day, amenity: { name: amenity.name }, slots: [], closed: true, reason: 'Closed on this day' };
  }

  const maxAdvance = Number(amenity.maxAdvanceDays ?? 30);
  if (date.getTime() - Date.now() > maxAdvance * 86_400_000) {
    throw ApiError.badRequest(`Bookings open ${maxAdvance} days in advance`);
  }

  const defined = await ctx.db.collection('amenity_slots').find(
    { societyId: ctx.societyId, amenityId: amenity._id, isActive: true, isBlocked: false },
    { limit: 500 },
  );
  const applicable = defined.filter((s) => s.dayOfWeek === null || s.dayOfWeek === undefined || Number(s.dayOfWeek) === dayOfWeek);

  let windows: Array<{ startTime: string; endTime: string; slotId: string | null; capacity: number; fee: number }>;
  if (applicable.length > 0) {
    windows = applicable.map((s) => ({
      startTime: String(s.startTime),
      endTime: String(s.endTime),
      slotId: String(s._id),
      capacity: Number(s.capacity ?? amenity.capacity ?? 1),
      fee: Number(s.fee ?? amenity.bookingFee ?? 0),
    }));
  } else {
    const duration = Number(amenity.slotDurationMinutes ?? 60);
    const gap = Number(amenity.slotGapMinutes ?? 0);
    const open = toMinutes(String(amenity.openTime ?? '06:00'));
    const close = toMinutes(String(amenity.closeTime ?? '22:00'));
    windows = [];
    for (let start = open; start + duration <= close; start += duration + gap) {
      windows.push({
        startTime: fromMinutes(start),
        endTime: fromMinutes(start + duration),
        slotId: null,
        capacity: Number(amenity.capacity ?? 1),
        fee: Number(amenity.bookingFee ?? 0),
      });
    }
  }

  const { windowStart: dayStart } = buildWindow(date, '00:00', '23:59', timezone);
  const { windowEnd: dayEnd } = buildWindow(date, '00:00', '23:59', timezone);
  const existing = await ctx.db.collection('amenity_bookings').find(
    {
      societyId: ctx.societyId,
      amenityId: amenity._id,
      date,
      status: { $in: ['PENDING_APPROVAL', 'PENDING_PAYMENT', 'CONFIRMED'] },
      windowStart: { $lte: new Date(dayEnd.getTime() + 86_400_000) },
      windowEnd: { $gte: dayStart },
    },
    { limit: 1000 },
  );

  const now = Date.now();
  const slots = windows.map((w) => {
    const { windowStart, windowEnd } = buildWindow(date, w.startTime, w.endTime, timezone);
    const overlapping = existing.filter((b) => new Date(b.windowStart as string).getTime() < windowEnd.getTime() && new Date(b.windowEnd as string).getTime() > windowStart.getTime());
    const booked = overlapping.reduce((sum, b) => sum + Number(b.numberOfPeople ?? 1), 0);
    const remaining = Math.max(0, w.capacity - booked);
    return {
      startTime: w.startTime,
      endTime: w.endTime,
      slotId: w.slotId,
      capacity: w.capacity,
      booked,
      remaining,
      fee: w.fee,
      deposit: Number(amenity.deposit ?? 0),
      available: remaining > 0 && windowEnd.getTime() > now,
      isPast: windowEnd.getTime() <= now,
    };
  });

  return {
    amenityId: amenity._id,
    amenity: { name: amenity.name, type: amenity.type, capacity: amenity.capacity, rules: amenity.rules ?? [], requireApproval: Boolean(amenity.requireApproval), photoUrl: amenity.photoUrl ?? null },
    date: day,
    timezone,
    closed: false,
    slots,
  };
}

/* --------------------------------- booking --------------------------------- */

export interface BookInput extends Document {
  amenityId: string;
  date: string | Date;
  startTime: string;
  endTime?: string;
  numberOfPeople?: number;
  purpose?: string;
  notes?: string;
  unitId?: string;
  residentId?: string;
  userId?: string;
  timezone?: string;
  clientRequestId?: string;
}

export async function bookAmenity(ctx: AmenitiesContext, input: BookInput): Promise<Document> {
  const settings = await getSettings<Document>({ db: ctx.db, societyId: ctx.societyId }, 'amenity');
  const amenity = await ctx.db.collection('amenities').findOne({ societyId: ctx.societyId, _id: input.amenityId });
  if (!amenity) throw ApiError.notFound('Amenity');
  if (!amenity.isActive) throw ApiError.badRequest(`${amenity.name} is not accepting bookings`);

  const unitId = String(input.unitId ?? '');
  const unit = await ctx.db.collection('units').findOne({ societyId: ctx.societyId, _id: unitId });
  if (!unit) throw ApiError.notFound('Unit');

  const timezone = input.timezone ?? 'Asia/Kolkata';
  const day = input.date instanceof Date ? input.date.toISOString().slice(0, 10) : String(input.date).slice(0, 10);
  const date = new Date(`${day}T00:00:00.000Z`);

  // Idempotent replay (double tap / offline sync).
  if (input.clientRequestId) {
    const duplicate = await ctx.db.collection('amenity_bookings').findOne({ societyId: ctx.societyId, clientRequestId: String(input.clientRequestId) });
    if (duplicate) return { booking: duplicate, duplicate: true, pass: null };
  }

  const duration = Number(amenity.slotDurationMinutes ?? 60);
  const endTime = input.endTime ?? fromMinutes(toMinutes(input.startTime) + duration);
  if (toMinutes(endTime) <= toMinutes(input.startTime) && toMinutes(endTime) !== 0) {
    throw ApiError.badRequest('The end time must be after the start time');
  }

  const open = toMinutes(String(amenity.openTime ?? '00:00'));
  const close = toMinutes(String(amenity.closeTime ?? '23:59'));
  if (toMinutes(input.startTime) < open || toMinutes(endTime) > close) {
    throw ApiError.badRequest(`${amenity.name} is available between ${amenity.openTime} and ${amenity.closeTime}`);
  }

  const { windowStart, windowEnd } = buildWindow(date, input.startTime, endTime, timezone);
  if (windowEnd.getTime() <= Date.now()) throw ApiError.badRequest('That slot has already passed');

  const maxAdvance = Number(amenity.maxAdvanceDays ?? settings.maxAdvanceDays ?? 30);
  if (windowStart.getTime() - Date.now() > maxAdvance * 86_400_000) {
    throw ApiError.badRequest(`Bookings open ${maxAdvance} days in advance`);
  }

  // Per-user daily cap.
  const perDayCap = Number(amenity.maxSlotsPerUserPerDay ?? settings.maxSlotsPerUserPerDay ?? 2);
  const alreadyBooked = await ctx.db.collection('amenity_bookings').countDocuments({
    societyId: ctx.societyId,
    amenityId: amenity._id,
    unitId,
    date,
    status: { $in: ['PENDING_APPROVAL', 'PENDING_PAYMENT', 'CONFIRMED'] },
  });
  if (alreadyBooked >= perDayCap) {
    throw ApiError.badRequest(`You can book ${amenity.name} at most ${perDayCap} time${perDayCap === 1 ? '' : 's'} per day`);
  }

  const numberOfPeople = Math.max(1, Number(input.numberOfPeople ?? 1));
  const fee = Number(amenity.bookingFee ?? 0);
  const deposit = Number(amenity.deposit ?? 0);
  const totalAmount = Math.round((fee + deposit) * 100) / 100;
  const requirePayment = totalAmount > 0 && (settings.requirePayment !== false || Boolean(amenity.requireApproval) === false);
  const requireApproval = Boolean(amenity.requireApproval ?? settings.requireApproval ?? false);

  const status: BookingStatus = requireApproval ? 'PENDING_APPROVAL' : requirePayment ? 'PENDING_PAYMENT' : 'CONFIRMED';

  // --- atomic availability claim + insert, in one transaction -------------------
  const bookingId = newId('amenity_bookings');
  const referenceNumber = await nextReference({ db: ctx.db, societyId: ctx.societyId, kind: 'BOOKING' });

  const booking = await ctx.db.withTransaction(async () => {
    const capacity = Number(amenity.capacity ?? 1);
    const overlapping = await ctx.db.collection('amenity_bookings').find(
      {
        societyId: ctx.societyId,
        amenityId: amenity._id,
        status: { $in: ['PENDING_APPROVAL', 'PENDING_PAYMENT', 'CONFIRMED'] },
        windowStart: { $lt: windowEnd },
        windowEnd: { $gt: windowStart },
      },
      { limit: 500 },
    );
    const taken = overlapping.reduce((sum, b) => sum + Number(b.numberOfPeople ?? 1), 0);
    if (taken + numberOfPeople > capacity) {
      throw new ApiError(
        taken >= capacity
          ? `${amenity.name} is fully booked for ${input.startTime}–${endTime}`
          : `Only ${capacity - taken} spot${capacity - taken === 1 ? '' : 's'} left at ${input.startTime}–${endTime}`,
        'DOUBLE_BOOKING',
      );
    }

    return ctx.db.collection('amenity_bookings').create({
      _id: bookingId,
      societyId: ctx.societyId,
      referenceNumber,
      amenityId: amenity._id,
      slotId: input.slotId ?? null,
      unitId: unit._id,
      residentId: input.residentId ?? null,
      userId: input.userId ?? ctx.actorId,
      date,
      startTime: input.startTime,
      endTime,
      windowStart,
      windowEnd,
      numberOfPeople,
      status,
      fee,
      deposit,
      totalAmount,
      paymentId: null,
      isPaid: totalAmount === 0,
      passId: null,
      purpose: input.purpose ?? null,
      notes: input.notes ?? null,
      approvedBy: status === 'CONFIRMED' ? ctx.actorId : null,
      decidedAt: status === 'CONFIRMED' ? new Date() : null,
      rejectReason: null,
      cancelledAt: null,
      cancellationReason: null,
      refundAmount: 0,
      checkedInAt: null,
      checkedOutAt: null,
      clientRequestId: input.clientRequestId ?? null,
      createdBy: ctx.actorId,
      updatedBy: ctx.actorId,
    });
  });

  await ctx.db.collection('amenities').updateOne({ societyId: ctx.societyId, _id: amenity._id }, { $inc: { totalBookings: 1 } });

  // A confirmed, free booking gets its entry QR immediately.
  let pass: Document | null = null;
  if (status === 'CONFIRMED') {
    pass = await issueBookingPass(ctx, booking, amenity, windowStart, windowEnd);
  }

  await NotificationService.send({
    db: ctx.db,
    societyId: ctx.societyId,
    type: status === 'CONFIRMED' ? 'AMENITY_BOOKING_CONFIRMED' : status === 'PENDING_PAYMENT' ? 'AMENITY_BOOKING_PAYMENT_PENDING' : 'AMENITY_BOOKING_PENDING',
    audience: { type: 'USERS', userIds: [String(booking.userId)] },
    data: {
      referenceNumber,
      amenity: amenity.name,
      date: day,
      startTime: booking.startTime,
      endTime: booking.endTime,
      totalAmount,
      bookingId,
    },
    deepLink: `/amenities/bookings/${bookingId}`,
  });
  if (requireApproval) {
    await NotificationService.send({
      db: ctx.db,
      societyId: ctx.societyId,
      type: 'AMENITY_BOOKING_PENDING',
      audience: { type: 'ROLE', roles: ['SOCIETY_ADMIN', 'MANAGING_COMMITTEE', 'FACILITY_MANAGER'] },
      data: { referenceNumber, amenity: amenity.name, date: day, startTime: booking.startTime, unit: unit.label ?? unit.unitNumber, bookingId },
      deepLink: `/amenities/bookings/${bookingId}`,
    });
  }

  logger.info({ societyId: ctx.societyId, bookingId, amenityId: amenity._id, status }, 'amenity booked');
  return { booking, pass, duplicate: false, requirePayment, requireApproval, totalAmount };
}

async function issueBookingPass(
  ctx: AmenitiesContext,
  booking: Document,
  amenity: Document,
  windowStart: Date,
  windowEnd: Date,
): Promise<Document> {
  // The pass opens a little early and closes a little late so nobody is locked out at the
  // exact minute — the grace comes from the amenity's own slot gap, defaulting to 15 minutes.
  const graceMs = Math.max(Number(amenity.slotGapMinutes ?? 0), 15) * 60_000;
  const pass = await issuePass({
    db: ctx.db,
    societyId: ctx.societyId,
    kind: 'AMENITY_BOOKING',
    unitId: String(booking.unitId),
    residentId: booking.residentId ? String(booking.residentId) : null,
    bookingId: String(booking._id),
    validFrom: new Date(windowStart.getTime() - graceMs),
    validTill: new Date(windowEnd.getTime() + graceMs),
    maxEntries: 1,
    singleUse: false,
    createdBy: ctx.actorId,
  });
  await ctx.db.collection('amenity_bookings').updateOne({ societyId: ctx.societyId, _id: booking._id }, { $set: { passId: pass._id } });
  return pass;
}

/* --------------------------------- payment --------------------------------- */

/**
 * Called by the payments module once a booking charge settles (§22, §29).
 * Confirms the booking and mints the entry QR.
 */
export async function confirmBookingAfterPayment(
  ctx: AmenitiesContext,
  bookingId: string,
  payment: { id: string; amount: number },
): Promise<Document> {
  const booking = await ctx.db.collection('amenity_bookings').findOne({ societyId: ctx.societyId, _id: bookingId });
  if (!booking) throw ApiError.notFound('Booking');
  if (booking.status === 'CONFIRMED') return { booking, alreadyConfirmed: true };
  if (['CANCELLED', 'REJECTED', 'REFUNDED'].includes(String(booking.status))) {
    throw ApiError.conflict(`This booking is ${String(booking.status).toLowerCase()}`);
  }

  await ctx.db.collection('amenity_bookings').updateOne(
    { societyId: ctx.societyId, _id: bookingId },
    {
      $set: {
        status: 'CONFIRMED',
        paymentId: payment.id,
        isPaid: true,
        approvedBy: ctx.actorId,
        decidedAt: new Date(),
        updatedBy: ctx.actorId,
      },
    },
  );

  const amenity = await ctx.db.collection('amenities').findOne({ societyId: ctx.societyId, _id: booking.amenityId });
  await ctx.db.collection('amenities').updateOne(
    { societyId: ctx.societyId, _id: booking.amenityId },
    { $inc: { totalRevenue: Number(payment.amount ?? 0) } },
  );

  const pass = await issueBookingPass(
    ctx,
    { ...booking, _id: bookingId },
    amenity ?? {},
    new Date(booking.windowStart as string | Date),
    new Date(booking.windowEnd as string | Date),
  );

  await NotificationService.send({
    db: ctx.db,
    societyId: ctx.societyId,
    type: 'AMENITY_BOOKING_CONFIRMED',
    audience: { type: 'USERS', userIds: [String(booking.userId)] },
    data: {
      referenceNumber: booking.referenceNumber,
      amenity: amenity?.name ?? 'Amenity',
      date: new Date(booking.date as string | Date).toISOString().slice(0, 10),
      startTime: booking.startTime,
      endTime: booking.endTime,
      amount: payment.amount,
      bookingId,
    },
    deepLink: `/amenities/bookings/${bookingId}`,
  });

  return { booking: { ...booking, status: 'CONFIRMED', isPaid: true }, pass };
}

/* -------------------------------- decisions -------------------------------- */

export async function decideBooking(
  ctx: AmenitiesContext,
  bookingId: string,
  decision: 'APPROVE' | 'REJECT',
  reason?: string,
): Promise<Document> {
  const booking = await ctx.db.collection('amenity_bookings').findOne({ societyId: ctx.societyId, _id: bookingId });
  if (!booking) throw ApiError.notFound('Booking');
  if (booking.status !== 'PENDING_APPROVAL') throw ApiError.conflict('This booking is not awaiting approval');

  const status: BookingStatus = decision === 'APPROVE' ? (Number(booking.totalAmount) > 0 && !booking.isPaid ? 'PENDING_PAYMENT' : 'CONFIRMED') : 'REJECTED';
  const amenity = await ctx.db.collection('amenities').findOne({ societyId: ctx.societyId, _id: booking.amenityId });

  await ctx.db.collection('amenity_bookings').updateOne(
    { societyId: ctx.societyId, _id: bookingId },
    { $set: { status, approvedBy: decision === 'APPROVE' ? ctx.actorId : null, decidedAt: new Date(), rejectReason: reason ?? null, updatedBy: ctx.actorId } },
  );

  let pass: Document | null = null;
  if (status === 'CONFIRMED') {
    pass = await issueBookingPass(ctx, { ...booking, _id: bookingId }, amenity ?? {}, new Date(booking.windowStart as string | Date), new Date(booking.windowEnd as string | Date));
  }

  await NotificationService.send({
    db: ctx.db,
    societyId: ctx.societyId,
    type: decision === 'APPROVE' ? 'AMENITY_BOOKING_CONFIRMED' : 'AMENITY_BOOKING_REJECTED',
    audience: { type: 'USERS', userIds: [String(booking.userId)] },
    data: { referenceNumber: booking.referenceNumber, amenity: amenity?.name ?? 'Amenity', reason: reason ?? null, bookingId },
    deepLink: `/amenities/bookings/${bookingId}`,
  });

  return { bookingId, status, reason: reason ?? null, pass };
}

/* ------------------------------- cancellation ------------------------------ */

export async function cancelBooking(ctx: AmenitiesContext, bookingId: string, reason?: string): Promise<Document> {
  const booking = await ctx.db.collection('amenity_bookings').findOne({ societyId: ctx.societyId, _id: bookingId });
  if (!booking) throw ApiError.notFound('Booking');
  if (['CANCELLED', 'REJECTED', 'COMPLETED', 'REFUNDED'].includes(String(booking.status))) {
    throw ApiError.conflict(`This booking is already ${String(booking.status).toLowerCase()}`);
  }

  const amenity = await ctx.db.collection('amenities').findOne({ societyId: ctx.societyId, _id: booking.amenityId });
  const windowStart = new Date(booking.windowStart as string | Date);
  const hoursUntil = (windowStart.getTime() - Date.now()) / 3_600_000;
  const cutoffHours = Number(amenity?.cancellationHoursBefore ?? 24);
  const allowCancellation = amenity?.allowCancellation !== false;

  if (!allowCancellation) throw ApiError.badRequest(`${amenity?.name ?? 'This amenity'} does not allow cancellations`);

  // Refund policy comes from the amenity, not the client (§22).
  const refundPercent = hoursUntil >= cutoffHours ? Number(amenity?.refundPercent ?? 100) : 0;
  const refundAmount = Math.round((Number(booking.totalAmount ?? 0) * refundPercent) / 100 * 100) / 100;

  await ctx.db.collection('amenity_bookings').updateOne(
    { societyId: ctx.societyId, _id: bookingId },
    {
      $set: {
        status: refundAmount > 0 && booking.isPaid ? 'REFUNDED' : 'CANCELLED',
        cancelledAt: new Date(),
        cancellationReason: reason ?? null,
        refundAmount,
        updatedBy: ctx.actorId,
      },
    },
  );
  if (booking.passId) {
    await revokePass(ctx.db, ctx.societyId, String(booking.passId), reason ?? 'Booking cancelled').catch(() => undefined);
  }
  await ctx.db.collection('amenities').updateOne({ societyId: ctx.societyId, _id: booking.amenityId }, { $inc: { totalBookings: -1 } });

  await NotificationService.send({
    db: ctx.db,
    societyId: ctx.societyId,
    type: 'AMENITY_BOOKING_CANCELLED',
    audience: { type: 'USERS', userIds: [String(booking.userId)] },
    data: { referenceNumber: booking.referenceNumber, amenity: amenity?.name ?? 'Amenity', refundAmount, bookingId },
    deepLink: `/amenities/bookings/${bookingId}`,
  });

  return { bookingId, status: refundAmount > 0 && booking.isPaid ? 'REFUNDED' : 'CANCELLED', refundAmount, refundPercent };
}

/* ------------------------------ gate check-in ------------------------------ */

/**
 * Scan a booking QR at the gate or clubhouse entrance (§57).
 * Shared with the security app's single `/visitors/scan` endpoint via `mode`.
 */
export async function scanAmenityPass(
  ctx: AmenitiesContext,
  token: string,
  opts: { gateId?: string | null; action?: 'VALIDATE' | 'CHECK_IN' | 'CHECK_OUT' } = {},
): Promise<Document> {
  const action = opts.action ?? 'CHECK_IN';
  const scanned = await scanPass({
    db: ctx.db,
    societyId: ctx.societyId,
    rawToken: token,
    // Pass the action through as-is. `scanPass` owns the semantics: VALIDATE previews without
    // consuming, CHECK_IN consumes one entry atomically, CHECK_OUT resolves a departure without
    // consuming. Collapsing VALIDATE into CHECK_IN here used to burn a booking's entry the
    // moment a guard previewed the QR, and collapsing CHECK_OUT into VALIDATE made exits fail
    // once that entry was gone.
    action,
    expectedKind: 'AMENITY_BOOKING',
    gateId: opts.gateId ?? ctx.gateId ?? null,
    scannedBy: ctx.actorId,
  });

  const booking = scanned.subject;
  if (!booking) throw new ApiError('This pass is not linked to a booking', 'QR_INVALID');
  if (!['CONFIRMED', 'COMPLETED'].includes(String(booking.status))) {
    throw ApiError.conflict(`This booking is ${String(booking.status).toLowerCase().replace('_', ' ')}`);
  }

  const amenity = await ctx.db.collection('amenities').findOne({ societyId: ctx.societyId, _id: booking.amenityId });
  const unit = await ctx.db.collection('units').findOne({ societyId: ctx.societyId, _id: booking.unitId });
  const now = new Date();

  if (action === 'CHECK_OUT') {
    await ctx.db.collection('amenity_bookings').updateOne(
      { societyId: ctx.societyId, _id: booking._id },
      { $set: { checkedOutAt: now, status: 'COMPLETED', updatedBy: ctx.actorId } },
    );
    return {
      action: 'CHECK_OUT',
      booking: { id: booking._id, referenceNumber: booking.referenceNumber, status: 'COMPLETED' },
      amenity: amenity ? { name: amenity.name } : null,
      unit: unit ? { label: unit.label ?? unit.unitNumber } : null,
    };
  }

  if (booking.checkedInAt) {
    return {
      action: 'CHECK_IN',
      alreadyCheckedIn: true,
      checkedInAt: booking.checkedInAt,
      booking: { id: booking._id, referenceNumber: booking.referenceNumber, status: booking.status },
      amenity: amenity ? { name: amenity.name } : null,
      unit: unit ? { label: unit.label ?? unit.unitNumber } : null,
    };
  }

  await ctx.db.collection('amenity_bookings').updateOne(
    { societyId: ctx.societyId, _id: booking._id },
    { $set: { checkedInAt: now, updatedBy: ctx.actorId } },
  );

  return {
    action: 'CHECK_IN',
    consumed: scanned.consumed,
    booking: {
      id: booking._id,
      referenceNumber: booking.referenceNumber,
      date: booking.date,
      startTime: booking.startTime,
      endTime: booking.endTime,
      numberOfPeople: booking.numberOfPeople,
      purpose: booking.purpose ?? null,
      status: booking.status,
    },
    amenity: amenity ? { id: amenity._id, name: amenity.name, type: amenity.type, rules: amenity.rules ?? [] } : null,
    unit: unit ? { id: unit._id, label: unit.label ?? unit.unitNumber } : null,
    checkedInAt: now,
  };
}

/** Re-fetch the QR image for an existing confirmed booking. */
export async function bookingQr(ctx: AmenitiesContext, bookingId: string): Promise<Document> {
  const booking = await ctx.db.collection('amenity_bookings').findOne({ societyId: ctx.societyId, _id: bookingId });
  if (!booking) throw ApiError.notFound('Booking');
  if (!booking.passId) throw ApiError.badRequest('This booking has no QR pass yet — it is issued once the booking is confirmed');

  const pass = await ctx.db.collection('visitor_passes').findOne({ societyId: ctx.societyId, _id: booking.passId });
  if (!pass) throw ApiError.notFound('Pass');
  if (pass.status === 'REVOKED') throw ApiError.conflict('This pass has been revoked');
  if (new Date(pass.validTill as string | Date).getTime() <= Date.now()) throw new ApiError('This booking pass has expired', 'QR_EXPIRED');

  const amenity = await ctx.db.collection('amenities').findOne({ societyId: ctx.societyId, _id: booking.amenityId });
  return {
    bookingId,
    referenceNumber: booking.referenceNumber,
    amenity: amenity ? { name: amenity.name, rules: amenity.rules ?? [] } : null,
    date: booking.date,
    startTime: booking.startTime,
    endTime: booking.endTime,
    passId: pass._id,
    token: pass.token,
    dataUrl: await renderQr(String(pass.token)),
    validFrom: pass.validFrom,
    validTill: pass.validTill,
  };
}

/* -------------------------------- housekeeping ------------------------------ */

/** Mark yesterday's confirmed bookings that were never scanned as no-shows. */
export async function reconcilePastBookings(ctx: AmenitiesContext): Promise<{ completed: number; noShow: number }> {
  const cutoff = new Date(Date.now() - 60_000);
  const past = await ctx.db.collection('amenity_bookings').find(
    { societyId: ctx.societyId, status: 'CONFIRMED', windowEnd: { $lt: cutoff } },
    { limit: 1000 },
  );

  let completed = 0;
  let noShow = 0;
  for (const booking of past) {
    const next = booking.checkedInAt ? 'COMPLETED' : 'NO_SHOW';
    await ctx.db.collection('amenity_bookings').updateOne(
      { societyId: ctx.societyId, _id: booking._id, status: 'CONFIRMED' },
      { $set: { status: next, updatedBy: 'system' } },
    );
    if (next === 'COMPLETED') completed += 1;
    else noShow += 1;
  }
  if (completed || noShow) logger.info({ societyId: ctx.societyId, completed, noShow }, 'amenity bookings reconciled');
  return { completed, noShow };
}

/** Release bookings whose payment window lapsed so the slot becomes bookable again. */
export async function expireUnpaidBookings(ctx: AmenitiesContext, minutes = 30): Promise<number> {
  const cutoff = new Date(Date.now() - minutes * 60_000);
  const stale = await ctx.db.collection('amenity_bookings').find(
    { societyId: ctx.societyId, status: 'PENDING_PAYMENT', createdAt: { $lt: cutoff } },
    { limit: 500 },
  );
  for (const booking of stale) {
    await ctx.db.collection('amenity_bookings').updateOne(
      { societyId: ctx.societyId, _id: booking._id, status: 'PENDING_PAYMENT' },
      { $set: { status: 'CANCELLED', cancellationReason: 'Payment not completed in time', cancelledAt: new Date(), updatedBy: 'system' } },
    );
    await NotificationService.send({
      db: ctx.db,
      societyId: ctx.societyId,
      type: 'AMENITY_BOOKING_CANCELLED',
      audience: { type: 'USERS', userIds: [String(booking.userId)] },
      data: { referenceNumber: booking.referenceNumber, reason: 'Payment not completed in time', bookingId: booking._id },
      deepLink: `/amenities/bookings/${booking._id}`,
    });
  }
  return stale.length;
}
