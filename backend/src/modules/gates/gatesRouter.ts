import { Router } from 'express';
import { z } from 'zod';
import { createGateSchema, updateGateSchema, createGuardAssignmentSchema, guardShiftLoginSchema, idSchema } from '@colonize/shared/validation';
import { buildCrudRouter } from '../_shared/crud.js';
import { authenticate, requireTenantContext } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/permissions.js';
import { asyncHandler } from '../../middleware/errors.js';
import { validate } from '../../middleware/validate.js';
import { ok, created } from '../../utils/response.js';
import { ApiError } from '../../utils/errors.js';
import { newId } from '../../db/ids.js';
import { getSettings } from '../../services/settings.js';
import * as visitorsService from '../visitors/visitorsService.js';

/**
 * Gates, guard posting and shift tracking (§19, §34, §46).
 *
 *   GET  /api/gates                    the society's gates
 *   GET  /api/gates/my                 which gate this guard is posted at right now
 *   POST /api/gates/:id/assign         post a guard to a gate for a shift
 *   POST /api/guards/shift/login       guard starts a shift from the app
 *   POST /api/guards/shift/logout      guard ends a shift
 *   GET  /api/gates/dashboard          live numbers for the security console
 */

function ctxFrom(req: import('express').Request): visitorsService.VisitorsContext {
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

const gatesCrud = buildCrudRouter<z.infer<typeof createGateSchema>, z.infer<typeof updateGateSchema>>({
  collection: 'gates',
  unitScoped: false, // society-wide: no unitId column on this collection
  permission: 'gate',
  label: 'Gate',
  createSchema: createGateSchema,
  updateSchema: updateGateSchema,
  searchFields: ['name', 'code'],
  filterFields: ['type', 'isActive', 'allowsVehicles', 'allowsPedestrians', 'isOpen24x7'],
  sortableFields: ['name', 'code', 'type', 'entriesToday', 'createdAt'],
  defaultSort: 'name',
  prepareCreate: (ctx, body) => ({ ...body, createdBy: ctx.principal.userId, updatedBy: ctx.principal.userId }),
});

export const gatesRouter: Router = Router();

/**
 * The gate this guard is posted at.
 *
 * Resolved from an *active* guard assignment or an open shift log — never from a header the
 * client sends — so a guard cannot record entries at a gate they are not posted at.
 */
gatesRouter.get(
  '/my',
  authenticate({ clientScopes: ['security', 'console', 'staff'] }),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const staffId = c.membership.staffId;

    let gateId: string | null = c.membership.gateIds[0] ?? null;
    let assignment: Record<string, unknown> | null = null;

    if (!gateId && staffId) {
      assignment = await c.db.collection('guard_assignments').findOne({
        societyId: c.society.id,
        staffId,
        isActive: true,
        $or: [{ endDate: null }, { endDate: { $gte: new Date() } }],
      });
      gateId = assignment ? String(assignment.gateId) : null;
    }
    if (!gateId) {
      const shift = await c.db.collection('guard_shift_logs').findOne(
        { societyId: c.society.id, userId: c.principal.userId, logoutAt: null },
        { sort: { loginAt: -1 } },
      );
      gateId = shift ? String(shift.gateId) : null;
      if (shift) assignment = { shift: shift.shift, loginAt: shift.loginAt };
    }
    if (!gateId) {
      return ok(res, { gate: null, message: 'You are not posted at a gate right now. Ask your supervisor to assign you.' }, 'No active gate posting');
    }

    const gate = await c.db.collection('gates').findOne({ societyId: c.society.id, _id: gateId });
    if (!gate) throw ApiError.notFound('Gate');

    const settings = await getSettings<{ captureVisitorPhoto?: boolean; allowNightEntry?: boolean; nightStart?: string; nightEnd?: boolean }>(
      { db: c.db, societyId: c.society.id },
      'visitor',
    );
    const securitySettings = await getSettings<{ vehicleCheck?: boolean; offlineSyncEnabled?: boolean }>(
      { db: c.db, societyId: c.society.id },
      'security',
    );

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const [entriesToday, insideCount, awaitingCount] = await Promise.all([
      c.db.collection('visitor_entries').countDocuments({ societyId: c.society.id, gateId, at: { $gte: startOfDay } }),
      c.db.collection('visitors').countDocuments({ societyId: c.society.id, status: 'INSIDE' }),
      c.db.collection('visitors').countDocuments({ societyId: c.society.id, status: 'AWAITING_APPROVAL' }),
    ]);

    return ok(
      res,
      {
        gate: {
          id: gate._id,
          name: gate.name,
          code: gate.code,
          type: gate.type,
          allowsVehicles: Boolean(gate.allowsVehicles),
          allowsPedestrians: Boolean(gate.allowsPedestrians),
          isOpen24x7: Boolean(gate.isOpen24x7),
          openTime: gate.openTime ?? null,
          closeTime: gate.closeTime ?? null,
        },
        assignment,
        settings: {
          captureVisitorPhoto: settings.captureVisitorPhoto !== false,
          vehicleCheck: securitySettings.vehicleCheck !== false,
          offlineSyncEnabled: securitySettings.offlineSyncEnabled !== false,
          allowNightEntry: Boolean(settings.allowNightEntry),
          nightStart: settings.nightStart ?? '22:00',
          nightEnd: settings.nightEnd ?? '06:00',
        },
        counts: { entriesToday, inside: insideCount, awaitingApproval: awaitingCount },
      },
      `Posted at ${gate.name}`,
    );
  }),
);

/** Live security console numbers (§34). */
gatesRouter.get(
  '/dashboard',
  authenticate({ clientScopes: ['security', 'console'] }),
  requirePermission('gate:view', 'visitor:view'),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const queue = await visitorsService.gateQueue(ctxFrom(req), { gateId: c.membership.gateIds[0] ?? null });

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const [gates, onDuty, deliveries, todaysEntries] = await Promise.all([
      c.db.collection('gates').find({ societyId: c.society.id, isActive: true }, { limit: 100 }),
      c.db.collection('guard_shift_logs').find({ societyId: c.society.id, logoutAt: null }, { limit: 200 }),
      c.db.collection('deliveries').countDocuments({ societyId: c.society.id, status: { $in: ['PENDING', 'AT_GATE', 'DELIVERED'] }, createdAt: { $gte: startOfDay } }),
      c.db.collection('visitor_entries').find({ societyId: c.society.id, at: { $gte: startOfDay } }, { limit: 5000 }),
    ]);

    // Bucketed in JS rather than with `$hour` so the embedded dev driver and MongoDB agree
    // exactly — the aggregation surface stays within what both implement.
    const timezone = c.society.timezone ?? 'Asia/Kolkata';
    const hourFormatter = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hour12: false });
    const byHour: Record<string, { in: number; out: number }> = {};
    for (const entry of todaysEntries) {
      const hour = hourFormatter.format(new Date(entry.at as string | Date)).padStart(2, '0');
      byHour[hour] ||= { in: 0, out: 0 };
      if (entry.direction === 'IN') byHour[hour].in += 1;
      else byHour[hour].out += 1;
    }
    const hourly = Object.entries(byHour)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([hour, counts]) => ({ hour, ...counts }));

    return ok(
      res,
      {
        gates: gates.map((g) => ({ id: g._id, name: g.name, code: g.code, type: g.type, entriesToday: Number(g.entriesToday ?? 0), lastEntryAt: g.lastEntryAt ?? null })),
        guardsOnDuty: onDuty.map((s) => ({ staffId: s.staffId, userId: s.userId, gateId: s.gateId, shift: s.shift, loginAt: s.loginAt })),
        deliveriesToday: deliveries,
        hourly,
        byHour,
        queue,
      },
      'Security dashboard fetched',
    );
  }),
);

/** Post a guard to a gate for a shift (§46). */
gatesRouter.post(
  '/:id/assign',
  authenticate(),
  requirePermission('guard:assign', 'gate:update'),
  validate(createGuardAssignmentSchema),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const gateId = String(req.params.id);
    const gate = await c.db.collection('gates').findOne({ societyId: c.society.id, _id: gateId });
    if (!gate) throw ApiError.notFound('Gate');

    const body = req.body as z.infer<typeof createGuardAssignmentSchema> & { userId?: string; endDate?: string };
    const staff = await c.db.collection('staff').findOne({ societyId: c.society.id, _id: (body as { staffId: string }).staffId });
    if (!staff) throw ApiError.notFound('Staff member');

    // One active posting per guard per shift — re-assigning replaces the old one instead of
    // leaving two "current" gates for the same person.
    await c.db.collection('guard_assignments').updateMany(
      { societyId: c.society.id, staffId: staff._id, isActive: true, shift: body.shift ?? 'GENERAL' },
      { $set: { isActive: false, endDate: new Date(), updatedBy: c.principal.userId } },
    );

    const assignment = await c.db.collection('guard_assignments').create({
      _id: newId('guard_assignments'),
      societyId: c.society.id,
      staffId: staff._id,
      userId: body.userId ?? staff.userId ?? null,
      gateId,
      shift: body.shift ?? 'GENERAL',
      startDate: body.startDate ? new Date(body.startDate as string) : new Date(),
      endDate: body.endDate ? new Date(String(body.endDate)) : null,
      isActive: true,
      notes: (body as { notes?: string }).notes ?? null,
      createdBy: c.principal.userId,
      updatedBy: c.principal.userId,
    });

    return created(res, { assignment, gate: { id: gate._id, name: gate.name }, staff: { id: staff._id, fullName: staff.fullName } }, `${staff.fullName} posted at ${gate.name}`);
  }),
);

gatesRouter.get(
  '/:id/assignments',
  authenticate(),
  requirePermission('gate:view', 'guard:view'),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const items = await c.db.collection('guard_assignments').find(
      { societyId: c.society.id, gateId: String(req.params.id), isActive: true },
      { sort: { shift: 1 }, limit: 200 },
    );
    const staffIds = Array.from(new Set(items.map((a) => String(a.staffId))));
    const staff = staffIds.length ? await c.db.collection('staff').find({ societyId: c.society.id, _id: { $in: staffIds } }, { limit: staffIds.length }) : [];
    const byId = new Map(staff.map((s) => [String(s._id), s]));
    return ok(
      res,
      { items: items.map((a) => ({ ...a, staff: byId.get(String(a.staffId)) ? { id: byId.get(String(a.staffId))!._id, fullName: byId.get(String(a.staffId))!.fullName, phone: byId.get(String(a.staffId))!.phone } : null })) },
      'Gate posting fetched',
    );
  }),
);

gatesRouter.use(gatesCrud);

/* --------------------------------- guards ---------------------------------- */

export const guardsRouter: Router = Router();

guardsRouter.post(
  '/shift/login',
  authenticate({ clientScopes: ['security', 'console', 'staff'] }),
  validate(guardShiftLoginSchema),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const body = req.body as z.infer<typeof guardShiftLoginSchema> & { shift?: string };

    // The gate comes from the guard's active posting unless they explicitly pass one that
    // they are actually assigned to.
    let gateId: string | null = body.gateId ? String(body.gateId) : c.membership.gateIds[0] ?? null;
    const staffId = c.membership.staffId ?? (body as { staffId?: string }).staffId ?? null;

    if (!gateId && staffId) {
      const assignment = await c.db.collection('guard_assignments').findOne({ societyId: c.society.id, staffId, isActive: true });
      gateId = assignment ? String(assignment.gateId) : null;
    }
    if (!gateId) throw ApiError.badRequest('You are not posted at a gate. Ask your supervisor to assign you first.');

    const gate = await c.db.collection('gates').findOne({ societyId: c.society.id, _id: gateId });
    if (!gate) throw ApiError.notFound('Gate');

    const openShift = await c.db.collection('guard_shift_logs').findOne({
      societyId: c.society.id,
      userId: c.principal.userId,
      logoutAt: null,
    });
    if (openShift) {
      return ok(
        res,
        { shiftLogId: openShift._id, gateId: openShift.gateId, loginAt: openShift.loginAt, alreadyOnDuty: true },
        'You are already on duty',
      );
    }

    const now = new Date();
    const shiftLog = await c.db.collection('guard_shift_logs').create({
      _id: newId('guard_shift_logs'),
      societyId: c.society.id,
      staffId,
      userId: c.principal.userId,
      gateId,
      shift: body.shift ?? 'GENERAL',
      loginAt: now,
      logoutAt: null,
      ip: c.ip,
      deviceId: c.principal.deviceId,
      location: (body as { location?: unknown }).location ?? null,
      visitorsHandled: 0,
      deliveriesHandled: 0,
      notes: null,
      createdBy: c.principal.userId,
    });

    return created(res, { shiftLogId: shiftLog._id, gate: { id: gate._id, name: gate.name }, loginAt: now, shift: shiftLog.shift }, `Shift started at ${gate.name}`);
  }),
);

guardsRouter.post(
  '/shift/logout',
  authenticate({ clientScopes: ['security', 'console', 'staff'] }),
  validate(z.object({ notes: z.string().trim().max(500).optional() })),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const body = req.body as { notes?: string };
    const openShift = await c.db.collection('guard_shift_logs').findOne({
      societyId: c.society.id,
      userId: c.principal.userId,
      logoutAt: null,
    });
    if (!openShift) throw ApiError.badRequest('You are not currently on duty');

    const now = new Date();
    const startOfDay = new Date(openShift.loginAt as string | Date);
    const [visitorsHandled, deliveriesHandled] = await Promise.all([
      c.db.collection('visitor_entries').countDocuments({
        societyId: c.society.id,
        guardId: c.principal.userId,
        at: { $gte: new Date(openShift.loginAt as string | Date) },
      }),
      c.db.collection('deliveries').countDocuments({
        societyId: c.society.id,
        recordedBy: c.principal.userId,
        createdAt: { $gte: new Date(openShift.loginAt as string | Date) },
      }),
    ]);
    void startOfDay;

    await c.db.collection('guard_shift_logs').updateOne(
      { _id: openShift._id },
      { $set: { logoutAt: now, visitorsHandled, deliveriesHandled, notes: body.notes ?? openShift.notes ?? null } },
    );

    const minutes = Math.max(0, Math.round((now.getTime() - new Date(openShift.loginAt as string | Date).getTime()) / 60_000));
    return ok(
      res,
      { shiftLogId: openShift._id, logoutAt: now, durationMinutes: minutes, visitorsHandled, deliveriesHandled },
      `Shift ended after ${Math.floor(minutes / 60)}h ${minutes % 60}m`,
    );
  }),
);

guardsRouter.get(
  '/shift/current',
  authenticate({ clientScopes: ['security', 'console', 'staff'] }),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const shift = await c.db.collection('guard_shift_logs').findOne({ societyId: c.society.id, userId: c.principal.userId, logoutAt: null });
    if (!shift) return ok(res, { onDuty: false }, 'You are not on duty');
    const gate = await c.db.collection('gates').findOne({ societyId: c.society.id, _id: shift.gateId });
    return ok(
      res,
      { onDuty: true, shiftLogId: shift._id, gate: gate ? { id: gate._id, name: gate.name, code: gate.code } : null, shift: shift.shift, loginAt: shift.loginAt },
      `On duty at ${gate?.name ?? 'your gate'}`,
    );
  }),
);

/** Attendance roster for the security supervisor (§46). */
guardsRouter.get(
  '/on-duty',
  authenticate(),
  requirePermission('guard:view', 'gate:view'),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const shifts = await c.db.collection('guard_shift_logs').find({ societyId: c.society.id, logoutAt: null }, { sort: { loginAt: -1 }, limit: 200 });
    const staffIds = Array.from(new Set(shifts.map((s) => String(s.staffId)).filter((v) => v && v !== 'null')));
    const gateIds = Array.from(new Set(shifts.map((s) => String(s.gateId))));
    const [staff, gates] = await Promise.all([
      staffIds.length ? c.db.collection('staff').find({ societyId: c.society.id, _id: { $in: staffIds } }, { limit: staffIds.length }) : [],
      gateIds.length ? c.db.collection('gates').find({ societyId: c.society.id, _id: { $in: gateIds } }, { limit: gateIds.length }) : [],
    ]);
    const staffById = new Map(staff.map((s) => [String(s._id), s]));
    const gateById = new Map(gates.map((g) => [String(g._id), g]));

    return ok(
      res,
      {
        items: shifts.map((s) => ({
          shiftLogId: s._id,
          loginAt: s.loginAt,
          shift: s.shift,
          staff: staffById.get(String(s.staffId)) ? { id: s.staffId, fullName: staffById.get(String(s.staffId))!.fullName, phone: staffById.get(String(s.staffId))!.phone } : null,
          gate: gateById.get(String(s.gateId)) ? { id: s.gateId, name: gateById.get(String(s.gateId))!.name } : null,
        })),
        total: shifts.length,
      },
      'Guards on duty',
    );
  }),
);

guardsRouter.get(
  '/assignments',
  authenticate(),
  requirePermission('guard:view', 'gate:view'),
  validate(z.object({ gateId: idSchema.optional(), isActive: z.coerce.boolean().default(true) }), 'query'),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const q = req.query as Record<string, string>;
    const filter: Record<string, unknown> = { societyId: c.society.id, isActive: q.isActive !== 'false' };
    if (q.gateId) filter.gateId = q.gateId;
    const items = await c.db.collection('guard_assignments').find(filter, { sort: { gateId: 1, shift: 1 }, limit: 500 });

    const staffIds = Array.from(new Set(items.map((a) => String(a.staffId))));
    const gateIds = Array.from(new Set(items.map((a) => String(a.gateId))));
    const [staff, gates] = await Promise.all([
      staffIds.length ? c.db.collection('staff').find({ societyId: c.society.id, _id: { $in: staffIds } }, { limit: staffIds.length }) : [],
      gateIds.length ? c.db.collection('gates').find({ societyId: c.society.id, _id: { $in: gateIds } }, { limit: gateIds.length }) : [],
    ]);
    const staffById = new Map(staff.map((s) => [String(s._id), s]));
    const gateById = new Map(gates.map((g) => [String(g._id), g]));

    return ok(
      res,
      {
        items: items.map((a) => ({
          id: a._id,
          shift: a.shift,
          startDate: a.startDate,
          endDate: a.endDate ?? null,
          staff: staffById.get(String(a.staffId)) ? { id: a.staffId, fullName: staffById.get(String(a.staffId))!.fullName, phone: staffById.get(String(a.staffId))!.phone } : null,
          gate: gateById.get(String(a.gateId)) ? { id: a.gateId, name: gateById.get(String(a.gateId))!.name, code: gateById.get(String(a.gateId))!.code } : null,
        })),
      },
      'Guard postings fetched',
    );
  }),
);

guardsRouter.delete(
  '/assignments/:id',
  authenticate(),
  requirePermission('guard:assign', 'gate:update'),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const result = await c.db.collection('guard_assignments').updateOne(
      { societyId: c.society.id, _id: String(req.params.id) },
      { $set: { isActive: false, endDate: new Date(), updatedBy: c.principal.userId } },
    );
    if (result.matched === 0) throw ApiError.notFound('Guard assignment');
    return ok(res, { removed: String(req.params.id) }, 'Guard unposted from that gate');
  }),
);

export default gatesRouter;
