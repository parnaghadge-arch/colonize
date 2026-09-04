import { normalisePhone } from '@colonize/shared';
import type { Document, TenantDatabase } from '../../db/drivers/types.js';
import { newId } from '../../db/ids.js';
import { ApiError } from '../../utils/errors.js';
import { getSettings } from '../../services/settings.js';
import { issuePass, scanPass, revokePass, renderQr, expireStalePasses, type QrKind } from '../../services/qr.js';
import { NotificationService } from '../../services/notifications/index.js';
import { emitLive } from '../../services/notifications/index.js';
import { logger } from '../../config/logger.js';
import { sha256 } from '../../services/crypto.js';

/**
 * Visitor management (§11, §12, §19, §34, §57) — the heart of the acceptance scenario.
 *
 * Two entry paths converge on one state machine:
 *
 *   PRE-APPROVED  resident invites → pass minted → guard scans → INSIDE → EXITED
 *   AT-GATE       guard captures  → resident notified → APPROVED/REJECTED → INSIDE → EXITED
 *
 * Security properties that are enforced here rather than trusted from a client:
 *   • the unit a visitor is raised for comes from the caller's membership, never the request;
 *   • the QR encodes only an opaque signed token — no names, phones or flat numbers;
 *   • entry is consumed with an atomic conditional update, so two simultaneous scans at two
 *     gates can only ever produce one entry;
 *   • the guard's society is taken from their JWT and compared against the pass, so a pass
 *     minted by another society is rejected before any record is read.
 */

export interface VisitorsContext {
  db: TenantDatabase;
  societyId: string;
  actorId: string;
  actorName?: string | null;
  /** The gate the actor is posted at (guards only). */
  gateId?: string | null;
  staffId?: string | null;
}

export type VisitorStatus =
  | 'PRE_APPROVED'
  | 'AWAITING_APPROVAL'
  | 'APPROVED'
  | 'REJECTED'
  | 'IGNORED'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'INSIDE'
  | 'EXITED';

export interface VisitorSettings {
  requireResidentApproval: boolean;
  autoApprovePreApproved: boolean;
  allowNightEntry: boolean;
  nightStart: string;
  nightEnd: string;
  passValidityHours: number;
  maxVisitorsPerDay: number;
  captureVisitorPhoto: boolean;
  qrSingleUse: boolean;
  autoExpireMinutes: number;
  notifyResidentsOnArrival: boolean;
}

async function visitorSettings(ctx: VisitorsContext): Promise<VisitorSettings> {
  return getSettings<VisitorSettings>({ db: ctx.db, societyId: ctx.societyId }, 'visitor');
}

/** Append an immutable timeline event — powers the activity view residents and admins see. */
function timelineEntry(action: string, actorId: string | null, actorName: string | null, meta: Document = {}): Document {
  return { at: new Date(), action, actorId, actorName, ...meta };
}

async function appendTimeline(
  ctx: VisitorsContext,
  visitorId: string,
  action: string,
  meta: Document = {},
): Promise<void> {
  await ctx.db.collection('visitors').updateOne(
    { societyId: ctx.societyId, _id: visitorId },
    { $push: { timeline: timelineEntry(action, ctx.actorId, ctx.actorName ?? null, meta) } },
  );
}

/** "Is it night right now, in the society's own timezone?" — never the server's. */
export function isNightTime(now: Date, timezone: string, nightStart: string, nightEnd: string): boolean {
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false });
  const [hh, mm] = fmt.format(now).split(':').map(Number);
  const minutes = hh * 60 + mm;
  const [sh, sm] = String(nightStart).split(':').map(Number);
  const [eh, em] = String(nightEnd).split(':').map(Number);
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  // Overnight windows (22:00 → 06:00) wrap past midnight.
  return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end;
}

/* ------------------------------ pre-approval ------------------------------- */

export interface PreApproveInput extends Document {
  visitorName: string;
  visitorPhone?: string | null;
  visitorType?: string;
  purpose: string;
  visitDate?: string | Date;
  expectedArrival?: string | Date;
  expectedDeparture?: string | Date;
  numberOfVisitors?: number;
  vehicleNumber?: string | null;
  instructions?: string | null;
  notes?: string | null;
  /** Resolved from membership for resident callers; admins may target any unit. */
  unitId?: string;
  residentId?: string | null;
  validTill?: string | Date;
  maxEntries?: number;
}

export async function preApproveVisitor(ctx: VisitorsContext, input: PreApproveInput): Promise<Document> {
  const settings = await visitorSettings(ctx);
  const unitId = String(input.unitId ?? '');
  const unit = await ctx.db.collection('units').findOne({ societyId: ctx.societyId, _id: unitId });
  if (!unit) throw ApiError.notFound('Unit');

  await assertDailyLimit(ctx, unitId, settings);
  assertNightEntry(settings, ctx, input.expectedArrival ? new Date(String(input.expectedArrival)) : new Date());

  const visitDate = input.visitDate ? new Date(String(input.visitDate)) : input.expectedArrival ? new Date(String(input.expectedArrival)) : new Date();
  const expectedArrival = input.expectedArrival ? new Date(String(input.expectedArrival)) : null;
  const expectedDeparture = input.expectedDeparture ? new Date(String(input.expectedDeparture)) : null;
  const validFrom = expectedArrival ?? new Date();
  const validTill = input.validTill
    ? new Date(String(input.validTill))
    : new Date(Math.max(validFrom.getTime(), Date.now()) + Number(settings.passValidityHours ?? 24) * 3_600_000);

  if (validTill <= validFrom) throw ApiError.badRequest('The pass end time must be after its start time');

  const visitorId = newId('visitors');
  const now = new Date();
  const visitor = await ctx.db.collection('visitors').create({
    _id: visitorId,
    societyId: ctx.societyId,
    visitorName: String(input.visitorName ?? '').trim(),
    visitorPhone: input.visitorPhone ? normalisePhone(String(input.visitorPhone)) : null,
    unitId: unit._id,
    residentId: input.residentId ?? null,
    purpose: String(input.purpose ?? 'VISIT'),
    visitorType: String(input.visitorType ?? 'GUEST').toUpperCase(),
    source: 'PRE_APPROVED',
    status: 'PRE_APPROVED',
    numberOfVisitors: Number(input.numberOfVisitors ?? 1),
    vehicleNumber: input.vehicleNumber ? String(input.vehicleNumber).toUpperCase() : null,
    photoUrl: input.photoUrl ?? null,
    idProofType: input.idProofType ?? null,
    idProofNumber: input.idProofNumber ?? null,
    address: input.address ?? null,
    notes: input.notes ?? null,
    instructions: input.instructions ?? null,
    rejectReason: null,
    visitDate,
    expectedArrival,
    expectedDeparture,
    entryTime: null,
    exitTime: null,
    gateId: null,
    entryGateId: null,
    exitGateId: null,
    passId: null,
    decidedBy: ctx.actorId,
    decidedAt: now,
    decidedFrom: 'APP',
    recordedBy: ctx.actorId,
    location: null,
    autoExpiredAt: null,
    timeline: [timelineEntry('PRE_APPROVED', ctx.actorId, ctx.actorName ?? null, { visitorName: input.visitorName, unit: unit.label })],
    clientRequestId: input.clientRequestId ?? null,
    syncedAt: now,
    isOfflineCapture: false,
    createdBy: ctx.actorId,
    updatedBy: ctx.actorId,
  });

  // Mint the QR pass. Only the opaque token goes into the image.
  const pass = await issuePass({
    db: ctx.db,
    societyId: ctx.societyId,
    kind: 'VISITOR',
    unitId: String(unit._id),
    residentId: input.residentId ? String(input.residentId) : null,
    visitorId,
    validFrom,
    validTill,
    maxEntries: Number(input.maxEntries ?? Math.max(1, Number(settings.qrSingleUse ? 1 : 2))),
    singleUse: settings.qrSingleUse !== false,
    createdBy: ctx.actorId,
  });

  await ctx.db.collection('visitors').updateOne({ societyId: ctx.societyId, _id: visitorId }, { $set: { passId: pass._id } });

  await NotificationService.sendBestEffort({
    db: ctx.db,
    societyId: ctx.societyId,
    type: 'VISITOR_PRE_APPROVED',
    audience: { type: 'UNIT', ids: [String(unit._id)] },
    data: { visitorName: visitor.visitorName, unit: unit.label ?? unit.unitNumber, purpose: visitor.purpose, validTill: validTill.toISOString() },
    deepLink: `/visitors/${visitorId}`,
  });

  return { visitor, pass, unitLabel: unit.label ?? unit.unitNumber };
}

/* -------------------------------- at the gate ------------------------------- */

export interface AtGateInput extends Document {
  visitorName: string;
  visitorPhone?: string | null;
  unitId?: string;
  unitNumber?: string;
  buildingCode?: string;
  purpose: string;
  visitorType?: string;
  numberOfVisitors?: number;
  vehicleNumber?: string | null;
  photoUrl?: string | null;
  idProofType?: string | null;
  idProofNumber?: string | null;
  address?: string | null;
  notes?: string | null;
  gateId?: string | null;
  clientRequestId?: string | null;
  isOfflineCapture?: boolean;
}

/**
 * A guard captures a walk-in visitor (§19).
 *
 * The flat is resolved from the society's own structure; if the guard types a flat that does
 * not exist, the request fails rather than silently attaching the visit to the wrong home.
 */
export async function createAtGateVisitor(ctx: VisitorsContext, input: AtGateInput): Promise<Document> {
  const settings = await visitorSettings(ctx);

  const unit = await resolveUnitForGate(ctx, input);
  await assertDailyLimit(ctx, String(unit._id), settings);

  const gateId = input.gateId ? String(input.gateId) : ctx.gateId ?? null;
  if (gateId) {
    const gate = await ctx.db.collection('gates').findOne({ societyId: ctx.societyId, _id: gateId });
    if (!gate) throw ApiError.notFound('Gate');
  }

  // Offline sync: the same capture uploaded twice must not create two visitors (§50).
  if (input.clientRequestId) {
    const duplicate = await ctx.db.collection('visitors').findOne({
      societyId: ctx.societyId,
      clientRequestId: String(input.clientRequestId),
    });
    if (duplicate) return { visitor: duplicate, duplicate: true, unit, notified: false };
  }

  const now = new Date();
  // Societies that do not want per-visit approval let a pre-registered guest straight in.
  const autoApprove = settings.requireResidentApproval === false;
  const status: VisitorStatus = autoApprove ? 'APPROVED' : 'AWAITING_APPROVAL';

  const visitorId = newId('visitors');
  const visitor = await ctx.db.collection('visitors').create({
    _id: visitorId,
    societyId: ctx.societyId,
    visitorName: String(input.visitorName ?? '').trim(),
    visitorPhone: input.visitorPhone ? normalisePhone(String(input.visitorPhone)) : null,
    unitId: unit._id,
    residentId: null,
    purpose: String(input.purpose ?? 'VISIT'),
    visitorType: String(input.visitorType ?? 'GUEST').toUpperCase(),
    source: 'AT_GATE',
    status,
    numberOfVisitors: Number(input.numberOfVisitors ?? 1),
    vehicleNumber: input.vehicleNumber ? String(input.vehicleNumber).toUpperCase() : null,
    photoUrl: input.photoUrl ?? null,
    idProofType: input.idProofType ?? null,
    idProofNumber: input.idProofNumber ?? null,
    address: input.address ?? null,
    notes: input.notes ?? null,
    instructions: null,
    rejectReason: null,
    visitDate: now,
    expectedArrival: now,
    expectedDeparture: null,
    entryTime: null,
    exitTime: null,
    gateId,
    entryGateId: null,
    exitGateId: null,
    passId: null,
    decidedBy: autoApprove ? ctx.actorId : null,
    decidedAt: autoApprove ? now : null,
    decidedFrom: autoApprove ? 'SECURITY' : null,
    recordedBy: ctx.actorId,
    location: input.location ?? null,
    autoExpiredAt: null,
    timeline: [
      timelineEntry('CREATED_AT_GATE', ctx.actorId, ctx.actorName ?? null, { gateId, visitorName: input.visitorName }),
      ...(autoApprove ? [timelineEntry('AUTO_APPROVED', ctx.actorId, ctx.actorName ?? null, { reason: 'Resident approval is disabled for this society' })] : []),
    ],
    clientRequestId: input.clientRequestId ?? null,
    syncedAt: input.isOfflineCapture ? now : null,
    isOfflineCapture: Boolean(input.isOfflineCapture),
    createdBy: ctx.actorId,
    updatedBy: ctx.actorId,
  });

  let notified = false;
  if (!autoApprove) {
    // Push straight to the flat so the resident's phone buzzes at the gate.
    const result = await NotificationService.sendBestEffort({
      db: ctx.db,
      societyId: ctx.societyId,
      type: 'VISITOR_AT_GATE',
      audience: { type: 'UNIT', ids: [String(unit._id)] },
      data: {
        visitorName: visitor.visitorName,
        purpose: visitor.purpose,
        unit: unit.label ?? unit.unitNumber,
        visitorId,
        gateId,
        autoExpireMinutes: Number(settings.autoExpireMinutes ?? 30),
      },
      deepLink: `/visitors/${visitorId}/approve`,
      priority: 'HIGH',
    });
    notified = result.recipients > 0;
    emitLive(
      ctx.societyId,
      'visitor:approval-requested',
      { visitorId, visitorName: visitor.visitorName, purpose: visitor.purpose, unitId: String(unit._id), gateId },
      ['security', 'admins'],
    );
  }

  return { visitor, unit, notified, autoApproved: autoApprove };
}

async function resolveUnitForGate(ctx: VisitorsContext, input: AtGateInput): Promise<Document> {
  if (input.unitId) {
    const unit = await ctx.db.collection('units').findOne({ societyId: ctx.societyId, _id: String(input.unitId) });
    if (!unit) throw ApiError.notFound('Unit');
    return unit;
  }
  const unitNumber = String(input.unitNumber ?? '').trim().toUpperCase();
  if (!unitNumber) throw ApiError.badRequest('Select or enter the flat this visitor is visiting');

  const filter: Document = { societyId: ctx.societyId, unitNumber };
  if (input.buildingCode) {
    const building = await ctx.db.collection('buildings').findOne({
      societyId: ctx.societyId,
      code: String(input.buildingCode).trim().toUpperCase(),
    });
    if (!building) throw ApiError.notFound('Building');
    filter.buildingId = building._id;
  }
  const unit = await ctx.db.collection('units').findOne(filter);
  if (!unit) throw ApiError.notFound(`Flat "${unitNumber}"`);
  return unit;
}

async function assertDailyLimit(ctx: VisitorsContext, unitId: string, settings: VisitorSettings): Promise<void> {
  const max = Number(settings.maxVisitorsPerDay ?? 0);
  if (!max) return;
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const count = await ctx.db.collection('visitors').countDocuments({
    societyId: ctx.societyId,
    unitId,
    visitDate: { $gte: startOfDay },
    status: { $nin: ['CANCELLED', 'REJECTED', 'EXPIRED'] },
  });
  if (count >= max) {
    throw ApiError.badRequest(`This flat has already received ${count} visitors today (limit ${max}). Contact the society office.`);
  }
}

function assertNightEntry(settings: VisitorSettings, ctx: VisitorsContext, when: Date): void {
  if (settings.allowNightEntry) return;
  const society = (ctx as VisitorsContext & { timezone?: string }).timezone;
  if (isNightTime(when, society ?? 'Asia/Kolkata', settings.nightStart ?? '22:00', settings.nightEnd ?? '06:00')) {
    throw ApiError.badRequest(
      `Night entry is disabled for this society between ${settings.nightStart} and ${settings.nightEnd}. Ask the resident to pre-approve or contact the office.`,
    );
  }
}

/* -------------------------------- decisions -------------------------------- */

export async function decideVisitor(
  ctx: VisitorsContext,
  visitorId: string,
  decision: 'APPROVE' | 'REJECT' | 'IGNORE',
  input: { reason?: string; decidedFrom?: 'APP' | 'WEB' | 'SECURITY' } = {},
): Promise<Document> {
  const visitor = await ctx.db.collection('visitors').findOne({ societyId: ctx.societyId, _id: visitorId });
  if (!visitor) throw ApiError.notFound('Visitor');
  if (!['AWAITING_APPROVAL', 'PRE_APPROVED'].includes(String(visitor.status))) {
    throw ApiError.conflict(`This visit has already been ${String(visitor.status).toLowerCase().replace('_', ' ')}`);
  }

  const now = new Date();
  const status: VisitorStatus = decision === 'APPROVE' ? 'APPROVED' : decision === 'REJECT' ? 'REJECTED' : 'IGNORED';
  const patch: Document = {
    status,
    decidedBy: ctx.actorId,
    decidedAt: now,
    decidedFrom: input.decidedFrom ?? 'APP',
    rejectReason: decision === 'APPROVE' ? null : input.reason ?? null,
    updatedBy: ctx.actorId,
  };
  await ctx.db.collection('visitors').updateOne({ societyId: ctx.societyId, _id: visitorId }, { $set: patch });
  await appendTimeline(ctx, visitorId, status, { reason: input.reason ?? null });

  // Tell the guard immediately so the person at the gate is not left waiting.
  const unit = await ctx.db.collection('units').findOne({ societyId: ctx.societyId, _id: visitor.unitId });
  await NotificationService.sendBestEffort({
    db: ctx.db,
    societyId: ctx.societyId,
    type: decision === 'APPROVE' ? 'VISITOR_APPROVED' : 'VISITOR_REJECTED',
    audience: { type: 'ROLE', roles: ['SECURITY_GUARD', 'SECURITY_SUPERVISOR', 'GATE_KEEPER'] },
    data: {
      visitorId,
      visitorName: visitor.visitorName,
      unit: unit?.label ?? unit?.unitNumber ?? '',
      reason: input.reason ?? null,
    },
    deepLink: `/gate/visitors/${visitorId}`,
    priority: 'HIGH',
  });
  emitLive(ctx.societyId, 'visitor:decided', { visitorId, status, reason: input.reason ?? null, unitId: String(visitor.unitId) }, ['security', 'admins']);

  return { ...visitor, ...patch };
}

/* --------------------------------- check-in -------------------------------- */

export interface CheckInInput {
  /** Either a scanned QR token or an explicit visitor id (manual entry). */
  token?: string;
  visitorId?: string;
  gateId?: string | null;
  photoUrl?: string | null;
  vehicleNumber?: string | null;
  notes?: string | null;
  personCount?: number;
  method?: 'QR_SCAN' | 'MANUAL' | 'PRE_APPROVED' | 'RFID' | 'ANPR';
  clientRequestId?: string | null;
}

/**
 * Let a visitor in (§19, §57).
 *
 * The QR path consumes the pass with an atomic conditional update inside `scanPass`, so two
 * guards scanning the same code at two gates at the same instant produce exactly one entry.
 * The manual path re-checks the visitor status before writing, and both write a
 * `visitor_entries` record — the physical gate crossing log that reports are built from.
 */
export async function checkInVisitor(ctx: VisitorsContext, input: CheckInInput): Promise<Document> {
  const settings = await visitorSettings(ctx);
  const gateId = input.gateId ? String(input.gateId) : ctx.gateId ?? null;
  if (!gateId) throw ApiError.badRequest('A gate is required to record an entry');

  const gate = await ctx.db.collection('gates').findOne({ societyId: ctx.societyId, _id: gateId });
  if (!gate) throw ApiError.notFound('Gate');
  if (!gate.isActive) throw ApiError.badRequest(`${gate.name} is not active`);

  const now = new Date();
  assertNightEntry(settings, { ...ctx, timezone: gate.timezone ?? undefined } as VisitorsContext, now);

  let visitor: Document | null = null;
  let pass: Document | null = null;
  let method = input.method ?? 'MANUAL';
  let consumed = false;

  if (input.token) {
    const scanned = await scanPass({
      db: ctx.db,
      societyId: ctx.societyId,
      rawToken: input.token,
      action: 'CHECK_IN',
      expectedKind: 'VISITOR',
      gateId,
      scannedBy: ctx.actorId,
      photoUrl: input.photoUrl ?? null,
    });
    pass = scanned.pass;
    consumed = scanned.consumed;
    visitor = scanned.subject;
    method = 'QR_SCAN';
    if (!visitor) throw new ApiError('This pass is not linked to a visitor record', 'QR_INVALID');
  } else if (input.visitorId) {
    visitor = await ctx.db.collection('visitors').findOne({ societyId: ctx.societyId, _id: String(input.visitorId) });
    if (!visitor) throw ApiError.notFound('Visitor');
    // Only an approved or pre-approved visit may be let in.
    if (!['APPROVED', 'PRE_APPROVED'].includes(String(visitor.status))) {
      throw ApiError.conflict(
        String(visitor.status) === 'AWAITING_APPROVAL'
          ? 'The resident has not approved this visit yet'
          : `This visit is ${String(visitor.status).toLowerCase()} and cannot be let in`,
      );
    }
    if (visitor.passId) {
      const stored = await ctx.db.collection('visitor_passes').findOne({ societyId: ctx.societyId, _id: visitor.passId });
      if (stored && stored.status === 'ACTIVE') {
        // Consume it atomically so a later QR scan of the same pass cannot produce a 2nd entry.
        const atomic = await ctx.db.collection('visitor_passes').updateOne(
          {
            societyId: ctx.societyId,
            _id: stored._id,
            status: 'ACTIVE',
            entriesUsed: { $lt: Number(stored.maxEntries ?? 1) },
          },
          {
            $inc: { entriesUsed: 1, scanCount: 1 },
            $set: {
              lastScannedAt: now,
              lastScannedBy: ctx.actorId,
              lastScannedGateId: gateId,
              ...(Number(stored.maxEntries ?? 1) <= Number(stored.entriesUsed ?? 0) + 1 ? { status: 'USED' } : {}),
            },
          },
        );
        consumed = atomic.matched > 0;
        pass = stored;
        method = 'PRE_APPROVED';
      }
    }
  } else {
    throw ApiError.badRequest('Provide either a scanned QR token or a visitor id');
  }

  // Idempotent replay of the same guard action (offline sync, double tap).
  if (input.clientRequestId) {
    const existingEntry = await ctx.db.collection('visitor_entries').findOne({
      societyId: ctx.societyId,
      clientRequestId: String(input.clientRequestId),
    });
    if (existingEntry) {
      return { visitor: await ctx.db.collection('visitors').findOne({ societyId: ctx.societyId, _id: visitor!._id }), entry: existingEntry, duplicate: true };
    }
  }

  if (String(visitor.status) === 'INSIDE') {
    throw ApiError.conflict('This visitor is already inside the society');
  }

  const vehicleNumber = input.vehicleNumber ? String(input.vehicleNumber).toUpperCase() : visitor.vehicleNumber ?? null;
  const unitId = String(visitor.unitId);

  const entry = await ctx.db.collection('visitor_entries').create({
    _id: newId('visitor_entries'),
    societyId: ctx.societyId,
    entryType: String(visitor.source) === 'PRE_APPROVED' ? 'PRE_APPROVED' : 'AT_GATE',
    direction: 'IN',
    visitorId: visitor._id,
    deliveryId: null,
    cabEntryId: null,
    staffId: null,
    vehicleId: null,
    passId: pass?._id ?? null,
    unitId,
    gateId,
    guardId: ctx.actorId,
    guardStaffId: ctx.staffId ?? null,
    at: now,
    vehicleNumber,
    photoUrl: input.photoUrl ?? null,
    personName: visitor.visitorName,
    personPhone: visitor.visitorPhone ?? null,
    personCount: Number(input.personCount ?? visitor.numberOfVisitors ?? 1),
    method,
    notes: input.notes ?? null,
    location: null,
    clientRequestId: input.clientRequestId ?? null,
    isOfflineCapture: Boolean(input.clientRequestId),
    syncedAt: input.clientRequestId ? now : null,
    createdBy: ctx.actorId,
  });

  await ctx.db.collection('visitors').updateOne(
    { societyId: ctx.societyId, _id: visitor._id },
    {
      $set: {
        status: 'INSIDE',
        entryTime: now,
        gateId,
        entryGateId: gateId,
        vehicleNumber,
        ...(input.photoUrl ? { photoUrl: input.photoUrl } : {}),
        updatedBy: ctx.actorId,
      },
      $push: { timeline: timelineEntry('ENTRY', ctx.actorId, ctx.actorName ?? null, { gateId, gate: gate.name, method }) },
    },
  );

  await ctx.db.collection('gates').updateOne(
    { societyId: ctx.societyId, _id: gateId },
    { $inc: { entriesToday: 1 }, $set: { lastEntryAt: now } },
  );

  if (settings.notifyResidentsOnArrival !== false) {
    await NotificationService.sendBestEffort({
      db: ctx.db,
      societyId: ctx.societyId,
      type: 'VISITOR_ENTERED',
      audience: { type: 'UNIT', ids: [unitId] },
      data: { visitorName: visitor.visitorName, gate: gate.name, at: now.toISOString() },
      deepLink: `/visitors/${visitor._id}`,
    });
  }
  emitLive(ctx.societyId, 'visitor:entered', { visitorId: visitor._id, visitorName: visitor.visitorName, unitId, gateId }, ['security', 'admins']);

  logger.info({ societyId: ctx.societyId, visitorId: visitor._id, gateId, method, consumed }, 'visitor checked in');
  return { visitor: { ...visitor, status: 'INSIDE', entryTime: now }, entry, pass, consumed, method, gate: { id: gate._id, name: gate.name } };
}

/* -------------------------------- check-out -------------------------------- */

export interface CheckOutInput {
  visitorId?: string;
  token?: string;
  gateId?: string | null;
  photoUrl?: string | null;
  notes?: string | null;
  clientRequestId?: string | null;
}

export async function checkOutVisitor(ctx: VisitorsContext, input: CheckOutInput): Promise<Document> {
  const gateId = input.gateId ? String(input.gateId) : ctx.gateId ?? null;
  if (!gateId) throw ApiError.badRequest('A gate is required to record an exit');
  const gate = await ctx.db.collection('gates').findOne({ societyId: ctx.societyId, _id: gateId });
  if (!gate) throw ApiError.notFound('Gate');

  let visitor: Document | null = null;
  if (input.token) {
    const scanned = await scanPass({
      db: ctx.db,
      societyId: ctx.societyId,
      rawToken: input.token,
      // CHECK_OUT, not VALIDATE: an exit must resolve even though entry already consumed the
      // single-use pass, and must never consume a second entry.
      action: 'CHECK_OUT',
      expectedKind: 'VISITOR',
      gateId,
      scannedBy: ctx.actorId,
    });
    visitor = scanned.subject;
  } else if (input.visitorId) {
    visitor = await ctx.db.collection('visitors').findOne({ societyId: ctx.societyId, _id: String(input.visitorId) });
  }
  if (!visitor) throw ApiError.notFound('Visitor');
  if (String(visitor.status) === 'EXITED') throw ApiError.conflict('This visitor has already exited');
  if (String(visitor.status) !== 'INSIDE') {
    throw ApiError.conflict('This visitor is not currently inside the society');
  }

  const now = new Date();
  if (input.clientRequestId) {
    const existingEntry = await ctx.db.collection('visitor_entries').findOne({
      societyId: ctx.societyId,
      clientRequestId: String(input.clientRequestId),
    });
    if (existingEntry) return { visitor, entry: existingEntry, duplicate: true };
  }

  const entry = await ctx.db.collection('visitor_entries').create({
    _id: newId('visitor_entries'),
    societyId: ctx.societyId,
    entryType: String(visitor.source) === 'PRE_APPROVED' ? 'PRE_APPROVED' : 'AT_GATE',
    direction: 'OUT',
    visitorId: visitor._id,
    passId: visitor.passId ?? null,
    unitId: visitor.unitId,
    gateId,
    guardId: ctx.actorId,
    guardStaffId: ctx.staffId ?? null,
    at: now,
    vehicleNumber: visitor.vehicleNumber ?? null,
    photoUrl: input.photoUrl ?? null,
    personName: visitor.visitorName,
    personPhone: visitor.visitorPhone ?? null,
    personCount: Number(visitor.numberOfVisitors ?? 1),
    method: input.token ? 'QR_SCAN' : 'MANUAL',
    notes: input.notes ?? null,
    clientRequestId: input.clientRequestId ?? null,
    isOfflineCapture: Boolean(input.clientRequestId),
    syncedAt: input.clientRequestId ? now : null,
    createdBy: ctx.actorId,
  });

  const entryTime = visitor.entryTime ? new Date(visitor.entryTime as string | Date) : now;
  const durationMinutes = Math.max(0, Math.round((now.getTime() - entryTime.getTime()) / 60_000));

  await ctx.db.collection('visitors').updateOne(
    { societyId: ctx.societyId, _id: visitor._id },
    {
      $set: {
        status: 'EXITED',
        exitTime: now,
        exitGateId: gateId,
        gateId,
        updatedBy: ctx.actorId,
      },
      $push: { timeline: timelineEntry('EXIT', ctx.actorId, ctx.actorName ?? null, { gateId, gate: gate.name, durationMinutes }) },
    },
  );

  emitLive(
    ctx.societyId,
    'visitor:exited',
    { visitorId: visitor._id, visitorName: visitor.visitorName, unitId: String(visitor.unitId), durationMinutes },
    ['security', 'admins'],
  );

  return { visitor: { ...visitor, status: 'EXITED', exitTime: now }, entry, durationMinutes };
}

/* ------------------------------- cancellation ------------------------------- */

export async function cancelVisitor(ctx: VisitorsContext, visitorId: string, reason?: string): Promise<Document> {
  const visitor = await ctx.db.collection('visitors').findOne({ societyId: ctx.societyId, _id: visitorId });
  if (!visitor) throw ApiError.notFound('Visitor');
  if (['INSIDE', 'EXITED'].includes(String(visitor.status))) {
    throw ApiError.conflict('This visitor has already entered — record an exit instead of cancelling');
  }

  await ctx.db.collection('visitors').updateOne(
    { societyId: ctx.societyId, _id: visitorId },
    {
      $set: { status: 'CANCELLED', rejectReason: reason ?? 'Cancelled', updatedBy: ctx.actorId },
      $push: { timeline: timelineEntry('CANCELLED', ctx.actorId, ctx.actorName ?? null, { reason: reason ?? null }) },
    },
  );
  if (visitor.passId) {
    await revokePass(ctx.db, ctx.societyId, String(visitor.passId), reason ?? 'Visitor cancelled').catch(() => undefined);
  }
  return { visitorId, status: 'CANCELLED' };
}

export async function revokeVisitorPass(ctx: VisitorsContext, visitorId: string, reason: string): Promise<Document> {
  const visitor = await ctx.db.collection('visitors').findOne({ societyId: ctx.societyId, _id: visitorId });
  if (!visitor) throw ApiError.notFound('Visitor');
  if (!visitor.passId) throw ApiError.badRequest('This visit has no QR pass');
  await revokePass(ctx.db, ctx.societyId, String(visitor.passId), reason);
  await appendTimeline(ctx, visitorId, 'PASS_REVOKED', { reason });
  return { visitorId, passId: visitor.passId, revoked: true };
}

/** Regenerate a QR image for an existing, still-valid pass (resident lost the screenshot). */
export async function passQrForVisitor(ctx: VisitorsContext, visitorId: string): Promise<Document> {
  const visitor = await ctx.db.collection('visitors').findOne({ societyId: ctx.societyId, _id: visitorId });
  if (!visitor) throw ApiError.notFound('Visitor');
  if (!visitor.passId) throw ApiError.badRequest('This visit has no QR pass');

  const pass = await ctx.db.collection('visitor_passes').findOne({ societyId: ctx.societyId, _id: visitor.passId });
  if (!pass) throw ApiError.notFound('Pass');
  if (pass.status !== 'ACTIVE') throw ApiError.conflict(`This pass is ${String(pass.status).toLowerCase()}`);
  if (new Date(pass.validTill as string | Date).getTime() <= Date.now()) {
    await ctx.db.collection('visitor_passes').updateOne({ _id: pass._id }, { $set: { status: 'EXPIRED' } });
    throw new ApiError('This pass has expired', 'QR_EXPIRED');
  }
  if (sha256(String(pass.token)) !== pass.tokenHash) throw new ApiError('This pass failed its integrity check', 'QR_INVALID');

  return {
    passId: pass._id,
    token: pass.token,
    dataUrl: await renderQr(String(pass.token)),
    validFrom: pass.validFrom,
    validTill: pass.validTill,
    entriesUsed: pass.entriesUsed,
    maxEntries: pass.maxEntries,
    visitor: { name: visitor.visitorName, purpose: visitor.purpose, visitorType: visitor.visitorType },
  };
}

/* -------------------------------- gate queue -------------------------------- */

/** Everything a guard needs on one screen: who is waiting, who is inside (§34). */
export async function gateQueue(ctx: VisitorsContext, opts: { gateId?: string | null } = {}): Promise<Document> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const [awaiting, inside, today] = await Promise.all([
    ctx.db.collection('visitors').find(
      { societyId: ctx.societyId, status: { $in: ['AWAITING_APPROVAL', 'APPROVED', 'PRE_APPROVED'] }, visitDate: { $gte: startOfDay } },
      { sort: { createdAt: -1 }, limit: 200 },
    ),
    ctx.db.collection('visitors').find({ societyId: ctx.societyId, status: 'INSIDE' }, { sort: { entryTime: -1 }, limit: 500 }),
    ctx.db.collection('visitor_entries').find(
      { societyId: ctx.societyId, at: { $gte: startOfDay }, ...(opts.gateId ? { gateId: opts.gateId } : {}) },
      { sort: { at: -1 }, limit: 500 },
    ),
  ]);

  const unitIds = Array.from(new Set([...awaiting, ...inside].map((v) => String(v.unitId))));
  const units = unitIds.length
    ? await ctx.db.collection('units').find({ societyId: ctx.societyId, _id: { $in: unitIds } }, { limit: unitIds.length })
    : [];
  const unitById = new Map(units.map((u) => [String(u._id), u]));

  const shape = (v: Document): Document => ({
    id: v._id,
    visitorName: v.visitorName,
    visitorPhone: v.visitorPhone ?? null,
    purpose: v.purpose,
    visitorType: v.visitorType,
    status: v.status,
    numberOfVisitors: v.numberOfVisitors ?? 1,
    vehicleNumber: v.vehicleNumber ?? null,
    source: v.source,
    unit: unitById.get(String(v.unitId))
      ? { id: unitById.get(String(v.unitId))!._id, label: unitById.get(String(v.unitId))!.label ?? unitById.get(String(v.unitId))!.unitNumber }
      : null,
    expectedArrival: v.expectedArrival ?? null,
    entryTime: v.entryTime ?? null,
    createdAt: v.createdAt,
    hasPass: Boolean(v.passId),
  });

  return {
    awaitingApproval: awaiting.filter((v) => v.status === 'AWAITING_APPROVAL').map(shape),
    approvedNotEntered: awaiting.filter((v) => v.status !== 'AWAITING_APPROVAL').map(shape),
    inside: inside.map(shape),
    recentActivity: today.slice(0, 50).map((e) => ({
      id: e._id,
      direction: e.direction,
      entryType: e.entryType,
      personName: e.personName,
      vehicleNumber: e.vehicleNumber ?? null,
      at: e.at,
      method: e.method,
      unitId: e.unitId,
    })),
    counts: {
      awaiting: awaiting.filter((v) => v.status === 'AWAITING_APPROVAL').length,
      inside: inside.length,
      entriesToday: today.filter((e) => e.direction === 'IN').length,
      exitsToday: today.filter((e) => e.direction === 'OUT').length,
    },
  };
}

/* ------------------------------- maintenance ------------------------------- */

/**
 * Expire visits nobody acted on (§11 "auto-expire").
 * Runs from the scheduler; also safe to call on demand.
 */
export async function autoExpireVisitors(ctx: VisitorsContext): Promise<{ expired: number; ids: string[] }> {
  const settings = await visitorSettings(ctx);
  const minutes = Number(settings.autoExpireMinutes ?? 30);
  if (!minutes) return { expired: 0, ids: [] };

  const cutoff = new Date(Date.now() - minutes * 60_000);
  const stale = await ctx.db.collection('visitors').find(
    { societyId: ctx.societyId, status: 'AWAITING_APPROVAL', createdAt: { $lt: cutoff } },
    { limit: 500 },
  );

  const ids: string[] = [];
  for (const visitor of stale) {
    await ctx.db.collection('visitors').updateOne(
      { societyId: ctx.societyId, _id: visitor._id, status: 'AWAITING_APPROVAL' },
      {
        $set: { status: 'EXPIRED', autoExpiredAt: new Date(), updatedBy: 'system' },
        $push: { timeline: timelineEntry('AUTO_EXPIRED', null, 'System', { afterMinutes: minutes }) },
      },
    );
    ids.push(String(visitor._id));
    emitLive(ctx.societyId, 'visitor:expired', { visitorId: visitor._id, unitId: String(visitor.unitId) }, ['security', 'admins']);
  }

  const passCount = await expireStalePasses(ctx.db, ctx.societyId);
  if (ids.length || passCount) logger.info({ societyId: ctx.societyId, visitors: ids.length, passes: passCount }, 'visitors auto-expired');
  return { expired: ids.length, ids };
}

/** Recurring helpers (maid, driver, cook) get a long-lived multi-entry pass (§11). */
export async function issueDailyHelperPass(
  ctx: VisitorsContext,
  input: { visitorId: string; validDays?: number; maxEntriesPerDay?: number },
): Promise<Document> {
  const visitor = await ctx.db.collection('visitors').findOne({ societyId: ctx.societyId, _id: input.visitorId });
  if (!visitor) throw ApiError.notFound('Visitor');
  if (!['DAILY_HELP', 'SERVICES', 'TECHNICIAN', 'PRIVATE_DRIVER'].includes(String(visitor.visitorType))) {
    throw ApiError.badRequest('Recurring passes are only available for daily help, drivers and service visitors');
  }

  const days = Math.min(Math.max(Number(input.validDays ?? 30), 1), 365);
  const validFrom = new Date();
  const validTill = new Date(validFrom.getTime() + days * 86_400_000);
  const maxEntries = Math.min(Math.max(Number(input.maxEntriesPerDay ?? 2), 1), 20) * days;

  const pass = await issuePass({
    db: ctx.db,
    societyId: ctx.societyId,
    kind: 'VISITOR',
    unitId: String(visitor.unitId),
    residentId: visitor.residentId ? String(visitor.residentId) : null,
    visitorId: String(visitor._id),
    validFrom,
    validTill,
    maxEntries,
    singleUse: false,
    createdBy: ctx.actorId,
  });
  await ctx.db.collection('visitors').updateOne(
    { societyId: ctx.societyId, _id: visitor._id },
    {
      $set: { passId: pass._id, status: 'PRE_APPROVED' },
      $push: { timeline: timelineEntry('RECURRING_PASS_ISSUED', ctx.actorId, ctx.actorName ?? null, { days, maxEntries }) },
    },
  );
  return { visitorId: visitor._id, pass, validDays: days, maxEntries };
}

/**
 * Validate a token *without* consuming it.
 *
 * The guard app calls this the moment a scan lands so it can show the visitor's name and flat
 * before the guard confirms entry — a mistyped or replayed code is rejected here, and nothing
 * is written.
 */
export async function previewScan(ctx: VisitorsContext, token: string): Promise<Document> {
  const scanned = await scanPass({
    db: ctx.db,
    societyId: ctx.societyId,
    rawToken: token,
    action: 'VALIDATE',
    expectedKind: 'AUTO',
    gateId: ctx.gateId ?? null,
    scannedBy: ctx.actorId,
  });

  const unitId = scanned.subject?.unitId ?? scanned.pass?.unitId ?? null;
  const unit = unitId ? await ctx.db.collection('units').findOne({ societyId: ctx.societyId, _id: unitId }) : null;

  return {
    kind: scanned.kind as QrKind,
    valid: scanned.valid,
    subjectType: scanned.subjectType,
    subject: scanned.subject
      ? {
          id: scanned.subject._id,
          name: scanned.subject.visitorName ?? scanned.subject.fullName ?? scanned.subject.title ?? null,
          phone: scanned.subject.visitorPhone ?? scanned.subject.phone ?? null,
          purpose: scanned.subject.purpose ?? null,
          status: scanned.subject.status ?? null,
        }
      : null,
    unit: unit ? { id: unit._id, label: unit.label ?? unit.unitNumber, unitNumber: unit.unitNumber } : null,
    pass: {
      id: scanned.pass._id,
      validFrom: scanned.pass.validFrom,
      validTill: scanned.pass.validTill,
      entriesUsed: scanned.pass.entriesUsed,
      maxEntries: scanned.pass.maxEntries,
    },
  };
}
