import { Router } from 'express';
import { z } from 'zod';
import {
  cancelVisitorSchema,
  createAtGateVisitorSchema,
  createPreApprovedVisitorSchema,
  decideVisitorSchema,
  recordEntrySchema,
  recordExitSchema,
  revokePassSchema,
  scanQrSchema,
  updateVisitorSchema,
} from '@colonize/shared/validation';
import type { ModuleKey } from '@colonize/shared';
import { buildCrudRouter } from '../_shared/crud.js';
import { authenticate, requireTenantContext } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/permissions.js';
import { asyncHandler } from '../../middleware/errors.js';
import { validate } from '../../middleware/validate.js';
import { ok, created } from '../../utils/response.js';
import { ApiError } from '../../utils/errors.js';
import { serialise } from '../../utils/serialize.js';
import type { VisitorsContext } from './visitorsService.js';
import * as visitorsService from './visitorsService.js';

/**
 * Visitor management endpoints (§11, §12, §19, §34, §57).
 *
 * Resident app                Security app                  Admin console
 * ─────────────                ────────────                  ─────────────
 * POST /visitors/pre-approve   POST /visitors/at-gate        GET  /visitors
 * POST /visitors/:id/decide    POST /gate/scan               GET  /visitors/:id
 * GET  /visitors/mine          POST /visitors/:id/check-in   GET  /visitors/entries
 * GET  /visitors/:id/qr        POST /visitors/:id/check-out  POST /visitors/:id/cancel
 * POST /visitors/:id/cancel    GET  /gate/queue              GET  /visitors/summary
 */

/**
 * Combine `visitDate` + `expectedArrival` ("2026-09-05" + "18:30") into a real instant in the
 * society's own timezone. Storing a UTC guess would make every evening pass expire early for
 * societies east of Greenwich.
 */
function combineDateAndTime(date: string | Date, hhmm: string | undefined, timezone: string, fallbackHour = 9): Date {
  const base = new Date(date instanceof Date ? date.toISOString().slice(0, 10) : String(date).slice(0, 10));
  const [hh, mm] = (hhmm ?? '').split(':').map((v) => Number(v));
  const hour = Number.isFinite(hh) ? hh : fallbackHour;
  const minute = Number.isFinite(mm) ? mm : 0;

  // Build the wall-clock instant for that timezone, then convert to UTC.
  const guess = new Date(`${base.toISOString().slice(0, 10)}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
  const offsetMinutes = timezoneOffsetMinutes(guess, timezone);
  return new Date(guess.getTime() - offsetMinutes * 60_000);
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

function ctxFrom(req: import('express').Request): VisitorsContext {
  const c = requireTenantContext(req);
  return {
    db: c.db,
    societyId: c.society.id,
    actorId: c.principal.userId,
    actorName: c.principal.fullName,
    gateId: c.membership.gateIds?.[0] ?? null,
    staffId: c.membership.staffId ?? null,
  };
}

/** The unit a resident caller may raise a visitor for — always from their own membership. */
function ownUnitId(req: import('express').Request): string {
  const c = requireTenantContext(req);
  const unitId = c.membership.primaryUnitId ?? c.membership.unitIds[0];
  if (!unitId) throw ApiError.forbidden('Your account is not linked to a flat in this society yet');
  return unitId;
}

/* --------------------------------- listing --------------------------------- */

/**
 * Bespoke routes are registered *before* the CRUD factory is mounted, because the factory
 * owns `GET /:id` and Express matches in registration order — `/mine`, `/entries/log` and
 * `/summary` would otherwise be swallowed as visitor ids.
 */
export const visitorsRouter: Router = Router();

const visitorsCrud = buildCrudRouter<z.infer<typeof createPreApprovedVisitorSchema>, z.infer<typeof updateVisitorSchema>>({
  collection: 'visitors',
  permission: 'visitor',
  moduleKey: 'visitorManagement' as ModuleKey,
  label: 'Visitor',
  updateSchema: updateVisitorSchema,
  searchFields: ['visitorName', 'visitorPhone', 'vehicleNumber', 'purpose'],
  filterFields: ['unitId', 'status', 'visitorType', 'source', 'gateId', 'entryGateId'],
  dateRangeField: 'visitDate',
  sortableFields: ['createdAt', 'visitDate', 'entryTime', 'exitTime', 'visitorName', 'status'],
  defaultSort: 'createdAt',
  serialise: { revealContact: true, omit: ['idProofNumber'] },
  allowCreate: false,
  residentCanUpdate: false,
  residentCanDelete: false,
  populate: [
    { field: 'unitId', collection: 'units', pick: ['label', 'unitNumber', 'buildingId'], as: 'unit' },
    { field: 'gateId', collection: 'gates', pick: ['name', 'code'], as: 'gate' },
    { field: 'entryGateId', collection: 'gates', pick: ['name', 'code'], as: 'entryGate' },
    { field: 'exitGateId', collection: 'gates', pick: ['name', 'code'], as: 'exitGate' },
    { field: 'residentId', collection: 'residents', pick: ['fullName', 'kind'], as: 'resident' },
  ],
});

/** Resident app: "my visitors" — scoped to the caller's own units server-side. */
visitorsRouter.get(
  '/mine',
  authenticate({ clientScopes: ['resident'] }),
  validate(z.object({
      status: z.string().trim().max(30).optional(),
      from: z.string().trim().max(30).optional(),
      to: z.string().trim().max(30).optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(25),
    }), 'query'),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const q = req.query as Record<string, string>;
    const filter: Record<string, unknown> = { societyId: c.society.id, unitId: { $in: c.membership.unitIds } };
    if (q.status) filter.status = q.status;
    if (q.from || q.to) {
      const range: Record<string, Date> = {};
      if (q.from) range.$gte = new Date(`${q.from}T00:00:00.000Z`);
      if (q.to) range.$lte = new Date(`${q.to}T23:59:59.999Z`);
      filter.visitDate = range;
    }

    const page = Number(q.page ?? 1);
    const limit = Number(q.limit ?? 25);
    const [items, total] = await Promise.all([
      c.db.collection('visitors').find(filter, { sort: { createdAt: -1 }, skip: (page - 1) * limit, limit }),
      c.db.collection('visitors').countDocuments(filter),
    ]);

    const inside = await c.db.collection('visitors').countDocuments({ societyId: c.society.id, unitId: { $in: c.membership.unitIds }, status: 'INSIDE' });
    const awaiting = await c.db.collection('visitors').countDocuments({ societyId: c.society.id, unitId: { $in: c.membership.unitIds }, status: 'AWAITING_APPROVAL' });

    return ok(
      res,
      { items: items.map((v) => serialise(v, { revealContact: true, omit: ['idProofNumber'] })), total, page, limit, inside, awaiting },
      'Your visitors',
    );
  }),
);

/* ------------------------------ pre-approval ------------------------------- */

visitorsRouter.post(
  '/pre-approve',
  authenticate({ clientScopes: ['resident', 'console'] }),
  requirePermission('visitor:create'),
  validate(createPreApprovedVisitorSchema),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const body = req.body as z.infer<typeof createPreApprovedVisitorSchema>;
    const timezone = c.society.timezone ?? 'Asia/Kolkata';

    const arrival = combineDateAndTime(body.visitDate, body.expectedArrival, timezone, 9);
    const departure = body.expectedDeparture ? combineDateAndTime(body.visitDate, body.expectedDeparture, timezone, 21) : null;
    if (departure && departure <= arrival) throw ApiError.badRequest('The expected departure must be after the expected arrival');

    // §51: the flat comes from the caller's membership, never from the request body.
    const unitId = c.principal.isResidentScope ? ownUnitId(req) : ((body as Record<string, unknown>).unitId as string) ?? ownUnitId(req);
    const residentId = c.membership.residentId ?? null;

    const result = await visitorsService.preApproveVisitor(ctxFrom(req), {
      ...body,
      unitId,
      residentId,
      expectedArrival: arrival,
      expectedDeparture: departure ?? undefined,
      visitDate: new Date(String(body.visitDate).slice(0, 10)),
      validTill: departure ?? new Date(arrival.getTime() + 12 * 3_600_000),
    });

    return created(
      res,
      {
        visitor: serialise(result.visitor, { revealContact: true, omit: ['idProofNumber'] }),
        unitLabel: result.unitLabel,
        qr: body.generateQrPass === false ? null : {
          passId: result.pass._id,
          token: result.pass.token,
          dataUrl: result.pass.dataUrl,
          validFrom: result.pass.validFrom,
          validTill: result.pass.validTill,
        },
      },
      `${result.visitor.visitorName} has been pre-approved. Share the QR pass with them.`,
    );
  }),
);

/* -------------------------------- at the gate ------------------------------- */

visitorsRouter.post(
  '/at-gate',
  authenticate({ clientScopes: ['security', 'console'] }),
  requirePermission('visitor:create'),
  validate(createAtGateVisitorSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createAtGateVisitorSchema>;
    const result = await visitorsService.createAtGateVisitor(ctxFrom(req), { ...body, gateId: body.gateId ?? ctxFrom(req).gateId });

    return created(
      res,
      {
        visitor: serialise(result.visitor, { revealContact: true, omit: ['idProofNumber'] }),
        unit: result.unit ? { id: result.unit._id, label: result.unit.label ?? result.unit.unitNumber } : null,
        status: result.visitor.status,
        notifiedResident: result.notified,
        autoApproved: result.autoApproved ?? false,
        duplicate: Boolean(result.duplicate),
        message: result.autoApproved
          ? 'Resident approval is disabled — the visitor can be let in now'
          : result.notified
            ? 'The resident has been notified and can approve from their app'
            : 'No resident account is linked to this flat yet — ask them to approve at the office',
      },
      result.autoApproved ? 'Visitor approved' : 'Waiting for resident approval',
    );
  }),
);

/* --------------------------------- decisions -------------------------------- */

visitorsRouter.post(
  '/:id/decide',
  authenticate({ clientScopes: ['resident', 'console', 'security'] }),
  requirePermission('visitor:approve'),
  validate(decideVisitorSchema),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const body = req.body as z.infer<typeof decideVisitorSchema>;

    const visitor = await c.db.collection('visitors').findOne({ societyId: c.society.id, _id: String(req.params.id) });
    if (!visitor) throw ApiError.notFound('Visitor');
    // A resident may only decide on visits for their own flat (§51).
    if (c.principal.isResidentScope && !c.membership.unitIds.includes(String(visitor.unitId))) {
      throw ApiError.forbidden('You can only approve visitors for your own flat');
    }

    const decided = await visitorsService.decideVisitor(ctxFrom(req), String(req.params.id), body.decision, {
      reason: body.reason,
      decidedFrom: c.principal.isResidentScope ? 'APP' : c.platform === 'web' ? 'WEB' : 'SECURITY',
    });
    if (body.instructions) {
      await c.db.collection('visitors').updateOne(
        { societyId: c.society.id, _id: String(req.params.id) },
        { $set: { instructions: body.instructions } },
      );
    }

    return ok(
      res,
      { visitor: serialise(decided, { revealContact: true, omit: ['idProofNumber'] }), decision: body.decision },
      body.decision === 'APPROVE' ? 'Visitor approved — the guard has been notified' : `Visitor ${body.decision.toLowerCase()}`,
    );
  }),
);

/* ------------------------------ entry and exit ------------------------------ */

visitorsRouter.post(
  '/:id/check-in',
  authenticate({ clientScopes: ['security', 'console'] }),
  requirePermission('visitor:scan', 'visitor:update'),
  validate(recordEntrySchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof recordEntrySchema>;
    const result = await visitorsService.checkInVisitor(ctxFrom(req), {
      visitorId: String(req.params.id),
      gateId: body.gateId ?? null,
      photoUrl: body.photoUrl ?? null,
      vehicleNumber: body.vehicleNumber ?? null,
      notes: body.notes ?? null,
      clientRequestId: body.clientRequestId ?? null,
      method: 'MANUAL',
    });

    return ok(
      res,
      {
        visitor: serialise(result.visitor, { revealContact: true, omit: ['idProofNumber'] }),
        entry: result.entry,
        method: result.method,
        duplicate: Boolean(result.duplicate),
        gate: result.gate ?? null,
      },
      result.duplicate ? 'Entry already recorded' : `${result.visitor.visitorName} checked in at ${result.gate?.name ?? 'the gate'}`,
    );
  }),
);

visitorsRouter.post(
  '/:id/check-out',
  authenticate({ clientScopes: ['security', 'console'] }),
  requirePermission('visitor:scan', 'visitor:update'),
  validate(recordExitSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof recordExitSchema>;
    const result = await visitorsService.checkOutVisitor(ctxFrom(req), {
      visitorId: String(req.params.id),
      gateId: body.gateId ?? null,
      notes: body.notes ?? null,
      clientRequestId: body.clientRequestId ?? null,
    });
    return ok(
      res,
      { visitor: serialise(result.visitor, { revealContact: true, omit: ['idProofNumber'] }), entry: result.entry, durationMinutes: result.durationMinutes },
      result.duplicate ? 'Exit already recorded' : `${result.visitor.visitorName} checked out after ${result.durationMinutes} minutes`,
    );
  }),
);

/* ---------------------------------- QR pass --------------------------------- */

visitorsRouter.get(
  '/:id/qr',
  authenticate({ clientScopes: ['resident', 'console'] }),
  requirePermission('visitor:view'),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const visitor = await c.db.collection('visitors').findOne({ societyId: c.society.id, _id: String(req.params.id) });
    if (!visitor) throw ApiError.notFound('Visitor');
    if (c.principal.isResidentScope && !c.membership.unitIds.includes(String(visitor.unitId))) {
      throw ApiError.forbidden('You can only view passes for your own flat');
    }
    return ok(res, await visitorsService.passQrForVisitor(ctxFrom(req), String(req.params.id)), 'QR pass fetched');
  }),
);

visitorsRouter.post(
  '/:id/revoke-pass',
  authenticate(),
  requirePermission('visitor:update', 'visitor:manage'),
  validate(revokePassSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as { reason?: string };
    const result = await visitorsService.revokeVisitorPass(ctxFrom(req), String(req.params.id), body.reason ?? 'Revoked by administrator');
    return ok(res, result, 'QR pass revoked — it can no longer be scanned');
  }),
);

visitorsRouter.post(
  '/:id/recurring-pass',
  authenticate(),
  requirePermission('visitor:create', 'visitor:manage'),
  validate(z.object({ validDays: z.coerce.number().int().min(1).max(365).default(30), maxEntriesPerDay: z.coerce.number().int().min(1).max(20).default(2) })),
  asyncHandler(async (req, res) => {
    const body = req.body as { validDays: number; maxEntriesPerDay: number };
    const result = await visitorsService.issueDailyHelperPass(ctxFrom(req), { visitorId: String(req.params.id), ...body });
    return created(res, result, `Recurring pass issued for ${body.validDays} days`);
  }),
);

/* -------------------------------- lifecycle -------------------------------- */

visitorsRouter.post(
  '/:id/cancel',
  authenticate(),
  requirePermission('visitor:cancel', 'visitor:update'),
  validate(cancelVisitorSchema),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const visitor = await c.db.collection('visitors').findOne({ societyId: c.society.id, _id: String(req.params.id) });
    if (!visitor) throw ApiError.notFound('Visitor');
    if (c.principal.isResidentScope && !c.membership.unitIds.includes(String(visitor.unitId))) {
      throw ApiError.forbidden('You can only cancel visits for your own flat');
    }
    const body = req.body as { reason?: string };
    const result = await visitorsService.cancelVisitor(ctxFrom(req), String(req.params.id), body.reason);
    return ok(res, result, 'Visit cancelled');
  }),
);

/** Run the auto-expire sweep on demand (the scheduler also runs it every minute). */
visitorsRouter.post(
  '/expire-stale',
  authenticate(),
  requirePermission('visitor:manage'),
  asyncHandler(async (req, res) => ok(res, await visitorsService.autoExpireVisitors(ctxFrom(req)), 'Stale visits expired')),
);

/* ---------------------------------- reports --------------------------------- */

visitorsRouter.get(
  '/entries/log',
  authenticate(),
  requirePermission('visitor:view'),
  validate(z.object({
      gateId: z.string().trim().max(40).optional(),
      unitId: z.string().trim().max(40).optional(),
      direction: z.enum(['IN', 'OUT']).optional(),
      entryType: z.string().trim().max(30).optional(),
      from: z.string().trim().max(30).optional(),
      to: z.string().trim().max(30).optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }), 'query'),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const q = req.query as Record<string, string>;
    const filter: Record<string, unknown> = { societyId: c.society.id };
    if (q.gateId) filter.gateId = q.gateId;
    if (q.direction) filter.direction = q.direction;
    if (q.entryType) filter.entryType = q.entryType;
    // Residents only ever see their own flat's crossings.
    filter.unitId = c.principal.isResidentScope ? { $in: c.membership.unitIds } : q.unitId ?? undefined;
    if (q.from || q.to) {
      const range: Record<string, Date> = {};
      if (q.from) range.$gte = new Date(`${q.from}T00:00:00.000Z`);
      if (q.to) range.$lte = new Date(`${q.to}T23:59:59.999Z`);
      filter.at = range;
    }
    for (const key of Object.keys(filter)) if (filter[key] === undefined) delete filter[key];

    const page = Number(q.page ?? 1);
    const limit = Number(q.limit ?? 50);
    const [items, total] = await Promise.all([
      c.db.collection('visitor_entries').find(filter, { sort: { at: -1 }, skip: (page - 1) * limit, limit }),
      c.db.collection('visitor_entries').countDocuments(filter),
    ]);

    return ok(res, { items, total, page, limit }, 'Gate crossing log');
  }),
);

visitorsRouter.get(
  '/summary',
  authenticate(),
  requirePermission('visitor:view'),
  validate(z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }), 'query'),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const days = Number(req.query.days ?? 30);
    const since = new Date(Date.now() - days * 86_400_000);
    const scope: Record<string, unknown> = c.principal.isResidentScope ? { unitId: { $in: c.membership.unitIds } } : {};

    const [byStatus, byType, byGate, total, inside] = await Promise.all([
      c.db.collection('visitors').aggregate<{ _id: string; count: number }>([
        { $match: { societyId: c.society.id, createdAt: { $gte: since }, ...scope } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      c.db.collection('visitors').aggregate<{ _id: string; count: number }>([
        { $match: { societyId: c.society.id, createdAt: { $gte: since }, ...scope } },
        { $group: { _id: '$visitorType', count: { $sum: 1 } } },
      ]),
      c.db.collection('visitor_entries').aggregate<{ _id: { gateId: string; direction: string }; count: number }>([
        { $match: { societyId: c.society.id, at: { $gte: since } } },
        { $group: { _id: { gateId: '$gateId', direction: '$direction' }, count: { $sum: 1 } } },
      ]),
      c.db.collection('visitors').countDocuments({ societyId: c.society.id, createdAt: { $gte: since }, ...scope }),
      c.db.collection('visitors').countDocuments({ societyId: c.society.id, status: 'INSIDE', ...scope }),
    ]);

    const gates = await c.db.collection('gates').find({ societyId: c.society.id }, { limit: 100 });
    const gateName = new Map(gates.map((g) => [String(g._id), String(g.name)]));

    return ok(
      res,
      {
        days,
        total,
        currentlyInside: inside,
        byStatus: Object.fromEntries(byStatus.map((r) => [String(r._id ?? 'UNKNOWN'), Number(r.count)])),
        byType: Object.fromEntries(byType.map((r) => [String(r._id ?? 'UNKNOWN'), Number(r.count)])),
        byGate: byGate.map((r) => ({
          gateId: r._id?.gateId ?? null,
          gate: gateName.get(String(r._id?.gateId ?? '')) ?? 'Unknown gate',
          direction: r._id?.direction ?? 'IN',
          count: Number(r.count),
        })),
      },
      `Visitor summary for the last ${days} days`,
    );
  }),
);

// CRUD (list / read / update / delete) mounted last so the explicit paths above win.
visitorsRouter.use(visitorsCrud);

export default visitorsRouter;

/* ------------------------------ gate console -------------------------------- */

/**
 * The gate console's own surface (§19, §57) — what the security mobile app actually calls.
 *
 *   POST /api/gate/scan    validate / check in / check out any pass (visitor, vehicle, staff,
 *                          amenity booking) from one camera endpoint
 *   GET  /api/gate/queue   who is waiting, who is inside, what just happened at this gate
 *
 * Kept separate from `/api/visitors` because a guard scanning a clubhouse booking pass is not
 * performing a visitor operation, and the security app should not have to know which module
 * issued the pass it is pointing the camera at.
 */
export const gateConsoleRouter: Router = Router();

/**
 * The single scan endpoint used by the security app camera (§19, §57).
 *
 * `action: VALIDATE` shows who the pass belongs to without consuming it; `CHECK_IN` consumes
 * one entry atomically and writes the crossing log.
 */
gateConsoleRouter.post(
  '/scan',
  authenticate({ clientScopes: ['security', 'console'] }),
  requirePermission('visitor:scan'),
  validate(scanQrSchema),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const body = req.body as z.infer<typeof scanQrSchema>;
    const gateId = body.gateId ?? c.membership.gateIds?.[0] ?? null;
    const svc = { ...ctxFrom(req), gateId };

    if (body.action === 'VALIDATE') {
      return ok(res, await visitorsService.previewScan(svc, body.token), 'Pass validated');
    }

    if (body.mode === 'AMENITY_BOOKING') {
      const { scanAmenityPass } = await import('../amenities/amenityService.js');
      const result = await scanAmenityPass(svc, body.token, { gateId, action: body.action });
      return ok(res, result, body.action === 'CHECK_IN' ? 'Booking checked in' : 'Booking checked out');
    }

    if (body.action === 'CHECK_OUT') {
      const result = await visitorsService.checkOutVisitor(svc, {
        token: body.token,
        gateId,
        photoUrl: body.photoUrl ?? null,
        clientRequestId: body.clientRequestId ?? null,
      });
      return ok(res, { visitor: serialise(result.visitor, { revealContact: true, omit: ['idProofNumber'] }), entry: result.entry, durationMinutes: result.durationMinutes }, 'Visitor checked out');
    }

    const result = await visitorsService.checkInVisitor(svc, {
      token: body.token,
      gateId,
      photoUrl: body.photoUrl ?? null,
      vehicleNumber: body.vehicleNumber ?? null,
      clientRequestId: body.clientRequestId ?? null,
    });
    return ok(
      res,
      {
        visitor: serialise(result.visitor, { revealContact: true, omit: ['idProofNumber'] }),
        entry: result.entry,
        pass: result.pass,
        method: result.method,
        consumed: result.consumed,
        gate: result.gate ?? null,
      },
      `${result.visitor.visitorName} checked in at ${result.gate?.name ?? 'the gate'}`,
    );
  }),
);


/** What the guard sees: who is waiting, who is inside, what just happened. */
gateConsoleRouter.get(
  '/queue',
  authenticate({ clientScopes: ['security', 'console'] }),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const gateId = req.query.gateId ? String(req.query.gateId) : c.membership.gateIds?.[0] ?? null;
    const queue = await visitorsService.gateQueue(ctxFrom(req), { gateId });
    return ok(res, queue, 'Gate queue fetched');
  }),
);
