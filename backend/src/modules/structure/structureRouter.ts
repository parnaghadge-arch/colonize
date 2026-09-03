import { Router } from 'express';
import { z } from 'zod';
import { permission } from '@colonize/shared';
import { buildCrudRouter } from '../_shared/crud.js';
import { authenticate, requireContext } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/permissions.js';
import { asyncHandler } from '../../middleware/errors.js';
import { validate } from '../../middleware/validate.js';
import { ok, created } from '../../utils/response.js';
import { parseCsv, RESIDENT_IMPORT_ALIASES, UNIT_IMPORT_ALIASES } from '../../utils/csv.js';
import * as structureService from './structureService.js';

/**
 * Society structure endpoints (§5, §10, §41).
 *
 *   /api/buildings        towers and buildings
 *   /api/wings            wings inside a building
 *   /api/floors           floors inside a building/wing
 *   /api/units            flats, villas, shops, penthouses
 *   /api/structure/tree   the whole tree in one call (sidebar + every picker)
 *   /api/structure/counts total / occupied / vacant tiles
 *   /api/units/generate   bulk generation for onboarding
 *   /api/structure/import import the whole tree from CSV
 */

const buildingSchema = z.object({
  name: z.string().trim().min(1).max(80),
  code: z.string().trim().min(1).max(12).optional(),
  type: z.enum(['TOWER', 'BUILDING', 'BLOCK', 'VILLA_ROW', 'COMPLEX']).default('TOWER'),
  totalFloors: z.coerce.number().int().min(-5).max(200).default(1),
  unitsPerFloor: z.coerce.number().int().min(0).max(100).default(0),
  hasWings: z.coerce.boolean().default(false),
  wings: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(40),
        code: z.string().trim().min(1).max(8).optional(),
        totalFloors: z.coerce.number().int().min(-5).max(200).optional(),
        unitsPerFloor: z.coerce.number().int().min(0).max(100).optional(),
        unitPrefix: z.string().trim().max(4).optional(),
      }),
    )
    .max(100)
    .optional(),
  address: z.string().trim().max(300).optional().nullable(),
  yearBuilt: z.coerce.number().int().min(1800).max(2200).optional().nullable(),
  liftCount: z.coerce.number().int().min(0).max(50).optional(),
  order: z.coerce.number().int().min(0).max(999).optional(),
  isActive: z.coerce.boolean().optional(),
});

const wingSchema = z.object({
  buildingId: z.string().min(3).max(40),
  name: z.string().trim().min(1).max(40),
  code: z.string().trim().min(1).max(8).optional(),
  totalFloors: z.coerce.number().int().min(-5).max(200).optional(),
  order: z.coerce.number().int().min(0).max(999).optional(),
  isActive: z.coerce.boolean().optional(),
});

const floorSchema = z.object({
  buildingId: z.string().min(3).max(40),
  wingId: z.string().min(3).max(40).nullable().optional(),
  number: z.coerce.number().int().min(-10).max(300),
  name: z.string().trim().max(40).optional(),
  isActive: z.coerce.boolean().optional(),
});

const unitSchema = z.object({
  buildingId: z.string().min(3).max(40),
  wingId: z.string().min(3).max(40).nullable().optional(),
  floorId: z.string().min(3).max(40).nullable().optional(),
  floorNumber: z.coerce.number().int().min(-10).max(300).optional(),
  unitNumber: z.string().trim().min(1).max(20).transform((v) => v.toUpperCase()),
  type: z.enum(['FLAT', 'VILLA', 'PENTHOUSE', 'SHOP', 'OFFICE', 'GARAGE', 'STUDIO']).default('FLAT'),
  carpetAreaSqft: z.coerce.number().positive().max(200000).optional().nullable(),
  builtUpAreaSqft: z.coerce.number().positive().max(200000).optional().nullable(),
  bedrooms: z.coerce.number().int().min(0).max(30).optional().nullable(),
  bathrooms: z.coerce.number().int().min(0).max(30).optional().nullable(),
  balconies: z.coerce.number().int().min(0).max(20).optional().nullable(),
  status: z.enum(['VACANT', 'OCCUPIED', 'LOCKED', 'UNDER_MAINTENANCE']).default('VACANT'),
  occupancyType: z.enum(['OWNER', 'TENANT', 'OWNER_AND_TENANT', 'COMPANY', 'VACANT']).default('VACANT'),
  maintenanceRate: z.coerce.number().min(0).max(1000000).optional().nullable(),
  waterCharge: z.coerce.number().min(0).max(100000).optional(),
  parkingCharge: z.coerce.number().min(0).max(100000).optional(),
  isActive: z.coerce.boolean().optional(),
});

/* -------------------------------- buildings -------------------------------- */

export const buildingsRouter = buildCrudRouter<z.infer<typeof buildingSchema>, z.infer<typeof buildingSchema>>({
  collection: 'buildings',
  permission: 'building',
  label: 'Building',
  createSchema: buildingSchema,
  updateSchema: buildingSchema.partial(),
  searchFields: ['name', 'code'],
  filterFields: ['type', 'isActive', 'hasWings'],
  sortableFields: ['name', 'code', 'totalFloors', 'unitCount', 'createdAt', 'order'],
  defaultSort: 'order',
  prepareCreate: (ctx, body) => ({
    ...body,
    createdBy: ctx.principal.userId,
    updatedBy: ctx.principal.userId,
  }),
});

/* --------------------------------- wings ---------------------------------- */

export const wingsRouter = buildCrudRouter<z.infer<typeof wingSchema>, z.infer<typeof wingSchema>>({
  collection: 'wings',
  permission: 'wing',
  label: 'Wing',
  createSchema: wingSchema,
  updateSchema: wingSchema.partial(),
  searchFields: ['name', 'code'],
  filterFields: ['buildingId', 'isActive'],
  sortableFields: ['name', 'code', 'unitCount', 'createdAt', 'order'],
  defaultSort: 'code',
  prepareCreate: (ctx, body) => ({ ...body, createdBy: ctx.principal.userId, updatedBy: ctx.principal.userId }),
});

/* --------------------------------- floors --------------------------------- */

export const floorsRouter = buildCrudRouter<z.infer<typeof floorSchema>, z.infer<typeof floorSchema>>({
  collection: 'floors',
  permission: 'floor',
  label: 'Floor',
  createSchema: floorSchema,
  updateSchema: floorSchema.partial(),
  searchFields: ['name'],
  filterFields: ['buildingId', 'wingId', 'number', 'isActive'],
  sortableFields: ['number', 'name', 'unitCount', 'createdAt'],
  defaultSort: 'number',
  prepareCreate: (ctx, body) => ({ ...body, createdBy: ctx.principal.userId, updatedBy: ctx.principal.userId }),
});

/* --------------------------------- units ---------------------------------- */

export const unitsRouter = buildCrudRouter<z.infer<typeof unitSchema>, z.infer<typeof unitSchema>>({
  collection: 'units',
  permission: 'unit',
  label: 'Unit',
  createSchema: unitSchema,
  updateSchema: unitSchema.partial(),
  searchFields: ['unitNumber', 'label'],
  filterFields: ['buildingId', 'wingId', 'floorId', 'floorNumber', 'type', 'status', 'occupancyType', 'isActive'],
  sortableFields: ['unitNumber', 'label', 'floorNumber', 'status', 'occupancyType', 'carpetAreaSqft', 'outstandingAmount', 'createdAt'],
  defaultSort: 'unitNumber',
  prepareCreate: (ctx, body) => ({ ...body, createdBy: ctx.principal.userId, updatedBy: ctx.principal.userId }),
  afterCreate: async (ctx, doc) => {
    await structureService.refreshUnitCounters({ db: ctx.db!, societyId: ctx.society!.id, actorId: ctx.principal.userId }, String(doc._id));
  },
  afterUpdate: async (ctx, _before, after) => {
    await structureService.refreshUnitCounters({ db: ctx.db!, societyId: ctx.society!.id, actorId: ctx.principal.userId }, String(after._id));
  },
  populate: [
    { field: 'buildingId', collection: 'buildings', pick: ['name', 'code'], as: 'building' },
    { field: 'wingId', collection: 'wings', pick: ['name', 'code'], as: 'wing' },
    { field: 'floorId', collection: 'floors', pick: ['name', 'number'], as: 'floor' },
  ],
});

/** Bulk generation — used by the onboarding wizard and by "add a whole floor". */
unitsRouter.post(
  '/generate',
  authenticate(),
  requirePermission(permission('unit', 'generate'), permission('unit', 'create')),
  validate(
    z.object({
      buildingId: z.string().min(3).max(40),
      wingId: z.string().min(3).max(40).nullable().optional(),
      floors: z.coerce.number().int().min(1).max(200),
      unitsPerFloor: z.coerce.number().int().min(1).max(100),
      numberingPattern: z.enum(['FLOOR_FIRST', 'WING_FIRST', 'SEQUENTIAL']).default('FLOOR_FIRST'),
      prefix: z.string().trim().max(4).optional(),
      startNumber: z.coerce.number().int().min(1).max(99999).optional(),
      unitType: z.string().trim().max(20).optional(),
      carpetAreaSqft: z.coerce.number().positive().optional(),
      createFloors: z.coerce.boolean().default(true),
    }),
  ),
  asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const result = await structureService.generateUnits(
      { db: ctx.db!, societyId: ctx.society!.id, actorId: ctx.principal.userId },
      req.body as never,
    );
    await structureService.unitStatusCounts({ db: ctx.db!, societyId: ctx.society!.id, actorId: ctx.principal.userId });
    return created(res, { ...result, units: result.units.slice(0, 20) }, `${result.created} units generated`);
  }),
);

/* ------------------------------- structure -------------------------------- */

export const structureRouter: Router = Router();

structureRouter.get(
  '/tree',
  authenticate(),
  asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const tree = await structureService.getStructureTree(
      { db: ctx.db!, societyId: ctx.society!.id, actorId: ctx.principal.userId },
      { buildingId: req.query.buildingId ? String(req.query.buildingId) : undefined },
    );
    return ok(res, { items: tree }, 'Structure tree fetched');
  }),
);

structureRouter.get(
  '/counts',
  authenticate(),
  asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const counts = await structureService.unitStatusCounts({ db: ctx.db!, societyId: ctx.society!.id, actorId: ctx.principal.userId });
    return ok(res, counts, 'Unit counts fetched');
  }),
);

structureRouter.get(
  '/import/templates',
  authenticate(),
  requirePermission(permission('unit', 'manage')),
  asyncHandler(async (_req, res) =>
    ok(
      res,
      {
        units: { columns: Object.keys(UNIT_IMPORT_ALIASES), aliases: UNIT_IMPORT_ALIASES },
        residents: { columns: Object.keys(RESIDENT_IMPORT_ALIASES), aliases: RESIDENT_IMPORT_ALIASES },
      },
      'Import templates fetched',
    ),
  ),
);

/** Parse a pasted spreadsheet so the wizard can preview it before writing anything. */
structureRouter.post(
  '/import/preview',
  authenticate(),
  requirePermission(permission('unit', 'manage')),
  validate(z.object({ csv: z.string().min(5).max(4_000_000) })),
  asyncHandler(async (req, res) => {
    const body = req.body as { csv: string };
    const parsed = parseCsv(body.csv, { aliases: UNIT_IMPORT_ALIASES, maxRows: 100 });
    return ok(res, { headers: parsed.headers, rows: parsed.rows.slice(0, 20), totalRows: parsed.totalRows, errors: parsed.errors }, 'Preview generated');
  }),
);

structureRouter.post(
  '/import',
  authenticate(),
  requirePermission(permission('unit', 'manage')),
  validate(z.object({ csv: z.string().min(10).max(4_000_000).optional(), dryRun: z.coerce.boolean().default(false) })),
  asyncHandler(async (req, res) => {
    const ctx = requireContext(req);
    const body = req.body as { csv?: string; dryRun: boolean };
    const csv = body.csv ?? '';
    const result = await structureService.importUnitsFromCsv(
      { db: ctx.db!, societyId: ctx.society!.id, actorId: ctx.principal.userId },
      csv,
      { dryRun: body.dryRun },
    );
    return ok(res, result, body.dryRun ? 'Preview ready — nothing was written' : `${result.unitsCreated} units imported`);
  }),
);
