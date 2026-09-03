import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { ModuleKey } from '@colonize/shared';
import {
  createFamilyMemberSchema,
  createResidentSchema,
  createVehicleSchema,
  createParkingAreaSchema,
  createParkingSlotSchema,
  updateResidentSchema,
  updateVehicleSchema,
  updateParkingSlotSchema,
} from '@colonize/shared/validation';
import { buildCrudRouter } from '../_shared/crud.js';
import { authenticate, requireTenantContext } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/permissions.js';
import { asyncHandler } from '../../middleware/errors.js';
import { validate } from '../../middleware/validate.js';
import { ok, created } from '../../utils/response.js';
import { ApiError } from '../../utils/errors.js';
import { newId } from '../../db/ids.js';
import { RESIDENT_CSV_ALIASES } from './residentsService.js';
import * as residentsService from './residentsService.js';
import { refreshUnitCounters } from '../structure/structureService.js';

/**
 * Residents, family, vehicles and parking (§11, §12, §13, §19).
 *
 *   /api/residents               admin directory of everyone living in the society
 *   /api/residents/my-unit       the resident app's own household
 *   /api/family-members          residents manage their own family (unit resolved server-side)
 *   /api/vehicles                vehicles per unit + gate verification
 *   /api/parking-slots           allotment and release
 */

const moveOutSchema = z.object({
  moveOutDate: z.string().trim().max(30).optional(),
  reason: z.string().trim().max(400).optional(),
  deactivateLogin: z.boolean().default(true),
});

const transferSchema = z.object({
  toUnitId: z.string().min(3).max(40),
  moveDate: z.string().trim().max(30).optional(),
  kind: z.enum(['OWNER', 'TENANT', 'FAMILY', 'COMPANY_GUEST']).optional(),
});

/* -------------------------------- residents -------------------------------- */

/**
 * Bespoke routes are registered before the CRUD factory is mounted: the factory owns
 * `GET /:id`, so `/my-unit` and `/import/template` would otherwise be read as resident ids.
 */
export const residentsRouter: Router = Router();

const residentsCrud = buildCrudRouter<z.infer<typeof createResidentSchema>, z.infer<typeof updateResidentSchema>>({
  collection: 'residents',
  permission: 'resident',
  moduleKey: 'residents' as ModuleKey,
  label: 'Resident',
  createSchema: createResidentSchema,
  updateSchema: updateResidentSchema,
  searchFields: ['fullName', 'phone', 'email', 'occupation'],
  filterFields: ['unitId', 'buildingId', 'wingId', 'kind', 'isPrimary', 'status', 'isActive'],
  sortableFields: ['fullName', 'kind', 'moveInDate', 'createdAt'],
  defaultSort: 'fullName',
  serialise: { revealContact: true, omit: ['idProofNumber', 'passwordHash'] },
  prepareCreate: async (ctx, body) => {
    const resident = await residentsService.createResident(
      { db: ctx.db!, societyId: ctx.society!.id, actorId: ctx.principal.userId, actorName: ctx.principal.fullName },
      { ...body, createLogin: true },
    );
    // The factory persists the returned document, so hand it back minus the id.
    const { _id, ...rest } = resident;
    void _id;
    return rest;
  },
});

/** Household view for the resident app — never accepts a unitId from the client. */
residentsRouter.get(
  '/my-unit',
  authenticate({ clientScopes: ['resident', 'console'] }),
  asyncHandler(async (req, res) => {
    const ctx = requireTenantContext(req);
    const unitId = ctx.membership.primaryUnitId ?? ctx.membership.unitIds[0];
    if (!unitId) throw ApiError.notFound('No unit is linked to this account yet');

    const db = ctx.db;
    const [unit, building, residents, family, vehicles, slots, permissions] = await Promise.all([
      db.collection('units').findOne({ societyId: ctx.society.id, _id: unitId }),
      db.collection('buildings').findOne({ societyId: ctx.society.id, _id: (await db.collection('units').findOne({ societyId: ctx.society.id, _id: unitId }))?.buildingId }),
      db.collection('residents').find({ societyId: ctx.society.id, unitId, status: 'ACTIVE' }, { limit: 50 }),
      db.collection('family_members').find({ societyId: ctx.society.id, unitId, isActive: true }, { limit: 50 }),
      db.collection('vehicles').find({ societyId: ctx.society.id, unitId, isActive: true }, { limit: 50 }),
      db.collection('parking_slots').find({ societyId: ctx.society.id, assignedUnitId: unitId }, { limit: 20 }),
      residentsService.effectivePermissions(
        { db, societyId: ctx.society.id, actorId: ctx.principal.userId },
        { unitId, userId: ctx.principal.userId },
      ),
    ]);
    if (!unit) throw ApiError.notFound('Unit');

    return ok(
      res,
      {
        unit: {
          id: unit._id,
          label: unit.label ?? unit.unitNumber,
          unitNumber: unit.unitNumber,
          type: unit.type,
          status: unit.status,
          building: building ? { id: building._id, name: building.name, code: building.code } : null,
          carpetAreaSqft: unit.carpetAreaSqft ?? null,
          bedrooms: unit.bedrooms ?? null,
        },
        residents: residents.map((r) => ({
          id: r._id,
          fullName: r.fullName,
          phone: r.phone,
          kind: r.kind,
          isPrimary: Boolean(r.isPrimary),
          moveInDate: r.moveInDate ?? null,
          occupation: r.occupation ?? null,
          photoUrl: r.photoUrl ?? null,
        })),
        family: family.map((f) => ({
          id: f._id,
          fullName: f.fullName,
          relationship: f.relationship,
          phone: f.phone ?? null,
          age: f.age ?? null,
          permissions: f.permissions ?? {},
          canLogin: Boolean(f.canLogin),
        })),
        vehicles: vehicles.map((v) => ({
          id: v._id,
          vehicleNumber: v.displayNumber ?? v.vehicleNumber,
          type: v.type,
          brand: v.brand ?? null,
          model: v.model ?? null,
          color: v.color ?? null,
          isPrimary: Boolean(v.isPrimary),
          parkingSlot: slots.find((s) => String(s.assignedVehicleId) === String(v._id))?.slotNumber ?? null,
        })),
        parkingSlots: slots.map((s) => ({ id: s._id, slotNumber: s.slotNumber, type: s.type, status: s.status })),
        permissions,
      },
      'Household fetched',
    );
  }),
);

residentsRouter.post(
  '/import',
  authenticate(),
  requirePermission('resident:create', 'resident:manage'),
  validate(z.object({ csv: z.string().min(10).max(4_000_000).optional(), dryRun: z.coerce.boolean().default(false) })),
  asyncHandler(async (req, res) => {
    const ctx = requireTenantContext(req);
    const body = req.body as { csv?: string; dryRun: boolean };
    const csv = body.csv ?? (req.file?.buffer ? req.file.buffer.toString('utf8') : '');
    const result = await residentsService.importResidentsFromCsv(
      { db: ctx.db, societyId: ctx.society.id, actorId: ctx.principal.userId, actorName: ctx.principal.fullName },
      csv,
      { dryRun: body.dryRun },
    );
    return ok(res, result, body.dryRun ? 'Preview ready — nothing was written' : `${result.created} residents imported`);
  }),
);

residentsRouter.get(
  '/import/template',
  authenticate(),
  requirePermission('resident:view'),
  asyncHandler(async (_req, res) =>
    ok(
      res,
      {
        columns: Object.keys(RESIDENT_CSV_ALIASES),
        aliases: RESIDENT_CSV_ALIASES,
        example: 'Tower,Flat No,Name,Mobile,Type,Vehicle No\nA,A-101,Rahul Sharma,9876543210,OWNER,MH31AB1234',
      },
      'Import template fetched',
    ),
  ),
);

residentsRouter.post(
  '/:id/move-out',
  authenticate(),
  requirePermission('resident:update', 'resident:manage'),
  validate(moveOutSchema),
  asyncHandler(async (req, res) => {
    const ctx = requireTenantContext(req);
    const result = await residentsService.moveOutResident(
      { db: ctx.db, societyId: ctx.society.id, actorId: ctx.principal.userId, actorName: ctx.principal.fullName },
      String(req.params.id),
      req.body as never,
    );
    return ok(res, result, 'Resident moved out — their login no longer has access to this flat');
  }),
);

residentsRouter.post(
  '/:id/transfer',
  authenticate(),
  requirePermission('resident:update', 'resident:manage'),
  validate(transferSchema),
  asyncHandler(async (req, res) => {
    const ctx = requireTenantContext(req);
    const result = await residentsService.transferResident(
      { db: ctx.db, societyId: ctx.society.id, actorId: ctx.principal.userId, actorName: ctx.principal.fullName },
      String(req.params.id),
      req.body as never,
    );
    return ok(res, result, 'Resident transferred to the new unit');
  }),
);

residentsRouter.use(residentsCrud);

/* ------------------------------ family members ------------------------------ */

/**
 * Residents manage their own family here.
 *
 * `unitId` is never taken from the request: it is resolved from the caller's membership, so a
 * resident cannot add a family member to somebody else's flat (§51).
 */
const familyGuard = (req: Request, _res: Response, next: NextFunction): void => {
  try {
    const ctx = requireTenantContext(req);
    if (ctx.principal.isResidentScope && !ctx.membership.residentId) {
      throw ApiError.forbidden('Your account is not linked to a resident record in this society');
    }
    next();
  } catch (err) {
    next(err);
  }
};

const familyMembersCrud = buildCrudRouter<z.infer<typeof createFamilyMemberSchema>, z.infer<typeof createFamilyMemberSchema>>({
  collection: 'family_members',
  permission: 'family',
  moduleKey: 'residents' as ModuleKey,
  label: 'Family member',
  createSchema: createFamilyMemberSchema,
  updateSchema: createFamilyMemberSchema.partial(),
  searchFields: ['fullName', 'phone', 'relationship'],
  filterFields: ['unitId', 'parentResidentId', 'relationship', 'canLogin', 'isActive'],
  sortableFields: ['fullName', 'relationship', 'createdAt'],
  defaultSort: 'fullName',
  residentCanCreate: true,
  residentCanUpdate: true,
  residentCanDelete: true,
  extraMiddleware: [familyGuard],
  prepareCreate: (ctx, body) => {
    // For residents the parent is their own record; admins may pass parentResidentId explicitly.
    const parentResidentId = ctx.principal.isResidentScope
      ? ctx.membership.residentId
      : ((body as Record<string, unknown>).parentResidentId as string) ?? ctx.membership.residentId;
    if (!parentResidentId) throw ApiError.badRequest('A parent resident is required');
    return {
      ...body,
      parentResidentId,
      unitId: ctx.principal.isResidentScope ? ctx.membership.primaryUnitId : (body as Record<string, unknown>).unitId,
      createdBy: ctx.principal.userId,
      updatedBy: ctx.principal.userId,
    } as never;
  },
  afterCreate: async (ctx, doc) => {
    const svc = { db: ctx.db!, societyId: ctx.society!.id, actorId: ctx.principal.userId };
    // A family member allowed to log in gets a restricted resident account whose capabilities
    // come from the permissions object just saved — never from anything the client sent later.
    if (doc.canLogin && (doc.phone || doc.email)) {
      const user = await residentsService.ensureResidentUser(svc, {
        residentId: String(doc._id),
        unitId: String(doc.unitId),
        fullName: String(doc.fullName),
        phone: doc.phone ? String(doc.phone) : null,
        email: doc.email ? String(doc.email) : null,
        kind: 'FAMILY',
        isPrimary: false,
      });
      await ctx.db!.collection('family_members').updateOne({ _id: doc._id }, { $set: { userId: user._id } });
      await ctx.db!.collection('unit_members').updateOne(
        { societyId: ctx.society!.id, residentId: doc._id },
        { $set: { permissions: (doc.permissions ?? residentsService.defaultPermissions('FAMILY')) as never } },
      );
    }
    if (doc.unitId) await refreshUnitCounters(svc, String(doc.unitId));
  },
});

export const familyMembersRouter: Router = Router();

familyMembersRouter.post(
  '/:id/permissions',
  authenticate({ clientScopes: ['resident', 'console'] }),
  familyGuard,
  validate(
    z.object({
      canApproveVisitors: z.boolean().optional(),
      canApproveDeliveries: z.boolean().optional(),
      canRaiseComplaints: z.boolean().optional(),
      canBookAmenities: z.boolean().optional(),
      canMakePayments: z.boolean().optional(),
      canViewBills: z.boolean().optional(),
      canAddStaff: z.boolean().optional(),
      canRaiseEmergency: z.boolean().optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const ctx = requireTenantContext(req);
    // A resident may only change permissions for family in their own unit.
    const existing = await ctx.db.collection('family_members').findOne({ societyId: ctx.society.id, _id: String(req.params.id) });
    if (!existing) throw ApiError.notFound('Family member');
    if (ctx.principal.isResidentScope && !ctx.membership.unitIds.includes(String(existing.unitId))) {
      throw ApiError.forbidden('You can only manage family members in your own flat');
    }
    const result = await residentsService.updateFamilyPermissions(
      { db: ctx.db, societyId: ctx.society.id, actorId: ctx.principal.userId },
      String(req.params.id),
      req.body as never,
    );
    return ok(res, result, 'Permissions updated');
  }),
);

familyMembersRouter.use(familyMembersCrud);

/* --------------------------------- vehicles --------------------------------- */

const vehiclesCrud = buildCrudRouter<z.infer<typeof createVehicleSchema>, z.infer<typeof updateVehicleSchema>>({
  collection: 'vehicles',
  permission: 'vehicle',
  moduleKey: 'vehiclesParking' as ModuleKey,
  label: 'Vehicle',
  createSchema: createVehicleSchema,
  updateSchema: updateVehicleSchema,
  searchFields: ['vehicleNumber', 'displayNumber', 'brand', 'model', 'stickerNumber'],
  filterFields: ['unitId', 'residentId', 'type', 'isEv', 'isPrimary', 'parkingSlotId', 'isActive'],
  sortableFields: ['vehicleNumber', 'type', 'createdAt'],
  defaultSort: 'vehicleNumber',
  residentCanCreate: true,
  residentCanUpdate: true,
  residentCanDelete: true,
  prepareCreate: (ctx, body) => {
    const unitId = ctx.principal.isResidentScope ? ctx.membership.primaryUnitId : (body as Record<string, unknown>).unitId;
    if (!unitId) throw ApiError.badRequest('A unit is required');
    return { ...body, unitId, createdBy: ctx.principal.userId, updatedBy: ctx.principal.userId } as never;
  },
});

export const vehiclesRouter: Router = Router();

/** Gate lookup — the guard types a plate and sees whose flat it belongs to (§19). */
vehiclesRouter.get(
  '/verify/:number',
  authenticate({ clientScopes: ['security', 'console', 'resident'] }),
  asyncHandler(async (req, res) => {
    const ctx = requireTenantContext(req);
    const result = await residentsService.verifyVehicle(
      { db: ctx.db, societyId: ctx.society.id, actorId: ctx.principal.userId },
      String(req.params.number),
    );
    return ok(res, result, result.found ? 'Vehicle found' : 'No vehicle matches that number');
  }),
);

vehiclesRouter.use(vehiclesCrud);

/* --------------------------------- parking ---------------------------------- */

export const parkingAreasRouter = buildCrudRouter<z.infer<typeof createParkingAreaSchema>, z.infer<typeof createParkingAreaSchema>>({
  collection: 'parking_areas',
  permission: 'parking',
  moduleKey: 'vehiclesParking' as ModuleKey,
  label: 'Parking area',
  createSchema: createParkingAreaSchema,
  updateSchema: createParkingAreaSchema.partial(),
  searchFields: ['name', 'code', 'level'],
  filterFields: ['buildingId', 'isActive'],
  sortableFields: ['name', 'code', 'createdAt'],
  defaultSort: 'name',
});

const parkingSlotsCrud = buildCrudRouter<z.infer<typeof createParkingSlotSchema>, z.infer<typeof updateParkingSlotSchema>>({
  collection: 'parking_slots',
  permission: 'parking',
  moduleKey: 'vehiclesParking' as ModuleKey,
  label: 'Parking slot',
  createSchema: createParkingSlotSchema,
  updateSchema: updateParkingSlotSchema,
  searchFields: ['slotNumber'],
  filterFields: ['areaId', 'buildingId', 'type', 'status', 'assignedUnitId', 'assignedVehicleId', 'isEv', 'isActive'],
  sortableFields: ['slotNumber', 'status', 'type', 'createdAt'],
  defaultSort: 'slotNumber',
});

export const parkingSlotsRouter: Router = Router();

parkingSlotsRouter.post(
  '/:id/assign',
  authenticate(),
  requirePermission('parking:update', 'parking:manage'),
  validate(
    z.object({
      unitId: z.string().min(3).max(40).optional(),
      vehicleId: z.string().min(3).max(40).optional().nullable(),
      fromDate: z.string().trim().max(30).optional(),
      tillDate: z.string().trim().max(30).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const ctx = requireTenantContext(req);
    const result = await residentsService.assignParkingSlot(
      { db: ctx.db, societyId: ctx.society.id, actorId: ctx.principal.userId },
      String(req.params.id),
      req.body as never,
    );
    return ok(res, result, 'Slot allotted');
  }),
);

parkingSlotsRouter.post(
  '/:id/release',
  authenticate(),
  requirePermission('parking:update', 'parking:manage'),
  asyncHandler(async (req, res) => {
    const ctx = requireTenantContext(req);
    const result = await residentsService.releaseParkingSlot(
      { db: ctx.db, societyId: ctx.society.id, actorId: ctx.principal.userId },
      String(req.params.id),
    );
    return ok(res, result, 'Slot released');
  }),
);

/** Generate a block of numbered slots in one call ("Basement 1, slots 1–120"). */
parkingSlotsRouter.post(
  '/generate',
  authenticate(),
  requirePermission('parking:create', 'parking:manage'),
  validate(
    z.object({
      areaId: z.string().min(3).max(40).optional().nullable(),
      buildingId: z.string().min(3).max(40).optional().nullable(),
      prefix: z.string().trim().max(6).default('P'),
      from: z.coerce.number().int().min(1).max(10000).default(1),
      to: z.coerce.number().int().min(1).max(10000),
      type: z.enum(['RESERVED', 'VISITOR', 'EV', 'STAFF', 'TWO_WHEELER', 'DISABLED', 'COMMON']).default('RESERVED'),
      monthlyCharge: z.coerce.number().min(0).max(100000).default(0),
    }),
  ),
  asyncHandler(async (req, res) => {
    const ctx = requireTenantContext(req);
    const body = req.body as { areaId?: string | null; buildingId?: string | null; prefix: string; from: number; to: number; type: string; monthlyCharge: number };
    if (body.to < body.from) throw ApiError.badRequest('The end number must be greater than the start number');
    if (body.to - body.from > 5000) throw ApiError.badRequest('Generate at most 5,000 slots at a time');

    let createdCount = 0;
    let skipped = 0;
    for (let n = body.from; n <= body.to; n += 1) {
      const slotNumber = `${body.prefix}${n}`;
      const exists = await ctx.db.collection('parking_slots').findOne({
        societyId: ctx.society.id,
        areaId: body.areaId ?? null,
        slotNumber,
      });
      if (exists) {
        skipped += 1;
        continue;
      }
      await ctx.db.collection('parking_slots').create({
        _id: newId('parking_slots'),
        societyId: ctx.society.id,
        areaId: body.areaId ?? null,
        buildingId: body.buildingId ?? null,
        slotNumber,
        type: body.type,
        status: 'AVAILABLE',
        capacity: 1,
        isEv: body.type === 'EV',
        hasCharger: body.type === 'EV',
        monthlyCharge: body.monthlyCharge,
        assignedUnitId: null,
        assignedVehicleId: null,
        isActive: true,
        createdBy: ctx.principal.userId,
        updatedBy: ctx.principal.userId,
      });
      createdCount += 1;
    }
    return created(res, { created: createdCount, skipped }, `${createdCount} parking slots generated`);
  }),
);

parkingSlotsRouter.use(parkingSlotsCrud);

/* ------------------------------- unit members ------------------------------- */

export const unitMembersRouter = buildCrudRouter({
  collection: 'unit_members',
  permission: 'resident',
  moduleKey: 'residents' as ModuleKey,
  label: 'Unit membership',
  searchFields: [],
  filterFields: ['unitId', 'residentId', 'userId', 'kind', 'isPrimary', 'isActive'],
  sortableFields: ['kind', 'createdAt'],
  defaultSort: 'createdAt',
  allowCreate: false,
  allowUpdate: false,
  allowDelete: false,
});
