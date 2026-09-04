import { formatTitle } from '@colonize/shared';
import type { Document, TenantDatabase } from '../../db/drivers/types.js';
import { newId } from '../../db/ids.js';
import { ApiError } from '../../utils/errors.js';
import { parseCsv, UNIT_IMPORT_ALIASES, RESIDENT_IMPORT_ALIASES } from '../../utils/csv.js';
import { logger } from '../../config/logger.js';

/**
 * Society structure: buildings / towers → wings → floors → units (§5, §10).
 *
 * The hierarchy is data, not code: a society can be a single building with no wings, five
 * towers with twenty wings, or a villa row with no floors at all. Unit labels are derived
 * from whatever levels exist, so "A-101, Tower A" and "12, Villa Row" both work.
 */

export interface StructureContext {
  db: TenantDatabase;
  societyId: string;
  actorId: string;
}

/* -------------------------------- buildings -------------------------------- */

export async function createBuilding(ctx: StructureContext, input: Document): Promise<Document> {
  const code = String(input.code ?? input.name ?? '').trim().toUpperCase();
  if (!code) throw ApiError.badRequest('A building code is required');

  const existing = await ctx.db.collection('buildings').findOne({ societyId: ctx.societyId, code });
  if (existing) throw ApiError.duplicate(`Building code "${code}" already exists in this society`);

  const doc = await ctx.db.collection('buildings').create({
    _id: newId('buildings'),
    societyId: ctx.societyId,
    name: formatTitle(input.name ?? code),
    code,
    type: input.type ?? 'TOWER',
    totalFloors: Number(input.totalFloors ?? 1),
    unitsPerFloor: Number(input.unitsPerFloor ?? 0),
    hasWings: Boolean(input.hasWings),
    address: input.address ?? null,
    yearBuilt: input.yearBuilt ?? null,
    liftCount: Number(input.liftCount ?? 0),
    isActive: input.isActive !== false,
    unitCount: 0,
    order: Number(input.order ?? 0),
    createdBy: ctx.actorId,
    updatedBy: ctx.actorId,
  });

  // Create the declared wings and floors in one pass so an admin never has to click 40 times.
  if (input.hasWings && Array.isArray(input.wings) && input.wings.length > 0) {
    for (const wing of input.wings as Document[]) {
      await createWing(ctx, { ...wing, buildingId: doc._id });
    }
  }
  const floors = Number(input.totalFloors ?? 0);
  if (floors > 0 && input.createFloors !== false) {
    await createFloorsForBuilding(ctx, String(doc._id), null, floors);
  }
  return doc;
}

export async function createFloorsForBuilding(
  ctx: StructureContext,
  buildingId: string,
  wingId: string | null,
  totalFloors: number,
  startFloor = 1,
): Promise<number> {
  const floors = ctx.db.collection('floors');
  let created = 0;
  for (let n = startFloor; n < startFloor + totalFloors; n += 1) {
    const exists = await floors.findOne({ societyId: ctx.societyId, buildingId, wingId: wingId ?? null, number: n });
    if (exists) continue;
    await floors.create({
      _id: newId('floors'),
      societyId: ctx.societyId,
      buildingId,
      wingId,
      number: n,
      name: n < 0 ? `Basement ${Math.abs(n)}` : n === 0 ? 'Ground' : `Floor ${n}`,
      isActive: true,
      unitCount: 0,
      createdBy: ctx.actorId,
      updatedBy: ctx.actorId,
    });
    created += 1;
  }
  return created;
}

/* --------------------------------- wings ---------------------------------- */

export async function createWing(ctx: StructureContext, input: Document): Promise<Document> {
  const buildingId = String(input.buildingId ?? '');
  const building = await ctx.db.collection('buildings').findOne({ societyId: ctx.societyId, _id: buildingId });
  if (!building) throw ApiError.notFound('Building');

  const code = String(input.code ?? input.name ?? '').trim().toUpperCase();
  const existing = await ctx.db.collection('wings').findOne({ societyId: ctx.societyId, buildingId, code });
  if (existing) throw ApiError.duplicate(`Wing "${code}" already exists in ${building.name}`);

  const doc = await ctx.db.collection('wings').create({
    _id: newId('wings'),
    societyId: ctx.societyId,
    buildingId,
    name: formatTitle(input.name ?? code),
    code,
    totalFloors: Number(input.totalFloors ?? building.totalFloors ?? 1),
    isActive: input.isActive !== false,
    unitCount: 0,
    order: Number(input.order ?? 0),
    createdBy: ctx.actorId,
    updatedBy: ctx.actorId,
  });

  await ctx.db.collection('buildings').updateOne({ _id: buildingId }, { $set: { hasWings: true } });
  if (doc.totalFloors > 0 && input.createFloors !== false) {
    await createFloorsForBuilding(ctx, buildingId, String(doc._id), Number(doc.totalFloors));
  }
  return doc;
}

/* --------------------------------- floors --------------------------------- */

export async function createFloor(ctx: StructureContext, input: Document): Promise<Document> {
  const buildingId = String(input.buildingId ?? '');
  const wingId = input.wingId ? String(input.wingId) : null;
  const number = Number(input.number);
  if (!Number.isFinite(number)) throw ApiError.badRequest('A floor number is required');

  const existing = await ctx.db.collection('floors').findOne({ societyId: ctx.societyId, buildingId, wingId, number });
  if (existing) return existing;

  return ctx.db.collection('floors').create({
    _id: newId('floors'),
    societyId: ctx.societyId,
    buildingId,
    wingId,
    number,
    name: input.name ?? (number < 0 ? `Basement ${Math.abs(number)}` : number === 0 ? 'Ground' : `Floor ${number}`),
    isActive: input.isActive !== false,
    unitCount: 0,
    createdBy: ctx.actorId,
    updatedBy: ctx.actorId,
  });
}

/* ---------------------------------- units --------------------------------- */

export interface CreateUnitInput extends Document {
  buildingId: string;
  wingId?: string | null;
  floorId?: string | null;
  floorNumber?: number;
  unitNumber: string;
}

export async function createUnit(ctx: StructureContext, input: CreateUnitInput): Promise<Document> {
  const buildingId = String(input.buildingId);
  const building = await ctx.db.collection('buildings').findOne({ societyId: ctx.societyId, _id: buildingId });
  if (!building) throw ApiError.notFound('Building');

  const wingId = input.wingId ? String(input.wingId) : null;
  if (wingId) {
    const wing = await ctx.db.collection('wings').findOne({ societyId: ctx.societyId, _id: wingId, buildingId });
    if (!wing) throw ApiError.badRequest('That wing does not belong to this building');
  }

  const unitNumber = String(input.unitNumber ?? '').trim().toUpperCase();
  if (!unitNumber) throw ApiError.badRequest('A unit number is required');

  const existing = await ctx.db.collection('units').findOne({ societyId: ctx.societyId, buildingId, wingId, unitNumber });
  if (existing) throw ApiError.duplicate(`Unit "${unitNumber}" already exists`);

  const floorNumber = Number(input.floorNumber ?? inferFloorNumber(unitNumber));
  let floorId = input.floorId ? String(input.floorId) : null;
  if (!floorId && Number.isFinite(floorNumber)) {
    const floor = await ctx.db.collection('floors').findOne({ societyId: ctx.societyId, buildingId, wingId, number: floorNumber });
    floorId = floor ? String(floor._id) : null;
  }

  const label = await buildUnitLabel(building, wingId, unitNumber, floorNumber, ctx);
  const doc = await ctx.db.collection('units').create({
    _id: newId('units'),
    societyId: ctx.societyId,
    buildingId,
    wingId,
    floorId,
    floorNumber,
    unitNumber,
    label,
    type: input.type ?? 'FLAT',
    carpetAreaSqft: input.carpetAreaSqft ?? null,
    builtUpAreaSqft: input.builtUpAreaSqft ?? null,
    bedrooms: input.bedrooms ?? null,
    bathrooms: input.bathrooms ?? null,
    balconies: input.balconies ?? null,
    status: input.status ?? 'VACANT',
    occupancyType: input.occupancyType ?? 'VACANT',
    parkingSlotIds: input.parkingSlotIds ?? [],
    maintenanceRate: input.maintenanceRate ?? null,
    waterCharge: Number(input.waterCharge ?? 0),
    parkingCharge: Number(input.parkingCharge ?? 0),
    isActive: input.isActive !== false,
    ownerCount: 0,
    tenantCount: 0,
    familyCount: 0,
    vehicleCount: 0,
    outstandingAmount: 0,
    createdBy: ctx.actorId,
    updatedBy: ctx.actorId,
  });

  await incrementCounters(ctx, buildingId, wingId, floorId, 1);
  return doc;
}

/**
 * Compose a unit's human-readable label: "A-1203, Wing A, Tower A — Alpha, Floor 12".
 *
 * Pure and exported so the repair script and the create path cannot drift apart.
 */
export function composeUnitLabel(parts: {
  unitNumber: string;
  wingCode?: string | null;
  buildingName?: string | null;
  buildingCode?: string | null;
  floorNumber?: number | null;
}): string {
  const segments = [String(parts.unitNumber ?? '').trim()];
  if (parts.wingCode) segments.push(`Wing ${parts.wingCode}`);
  const building = parts.buildingName ?? parts.buildingCode;
  if (building) segments.push(String(building));
  // Distinguish "ground floor" (0, shown) from "floor unknown" (null/undefined, omitted).
  // `Number(null)` is 0, so the null check has to come first.
  const floor = parts.floorNumber;
  if (floor !== null && floor !== undefined && Number.isFinite(Number(floor)) && Number(floor) >= 0) {
    segments.push(`Floor ${Number(floor)}`);
  }
  return segments.filter(Boolean).join(', ');
}

async function buildUnitLabel(
  building: Document,
  wingId: string | null,
  unitNumber: string,
  floorNumber: number,
  ctx: StructureContext,
): Promise<string> {
  const wing = wingId ? await ctx.db.collection('wings').findOne({ societyId: ctx.societyId, _id: wingId }) : null;
  return composeUnitLabel({
    unitNumber,
    wingCode: wing ? String(wing.code ?? '') : null,
    buildingName: building.name ? String(building.name) : null,
    buildingCode: building.code ? String(building.code) : null,
    floorNumber,
  });
}

/** "A-1203" → 12, "B-302" → 3, "12" → 12. A sensible default when the client omits it. */
export function inferFloorNumber(unitNumber: string): number {
  const digits = String(unitNumber).replace(/\D/g, '');
  if (digits.length >= 3) return Number(digits.slice(0, -2));
  if (digits.length > 0) return Number(digits);
  return 0;
}

async function incrementCounters(
  ctx: StructureContext,
  buildingId: string,
  wingId: string | null,
  floorId: string | null,
  delta: number,
): Promise<void> {
  await ctx.db.collection('buildings').updateOne({ societyId: ctx.societyId, _id: buildingId }, { $inc: { unitCount: delta } });
  if (wingId) await ctx.db.collection('wings').updateOne({ societyId: ctx.societyId, _id: wingId }, { $inc: { unitCount: delta } });
  if (floorId) await ctx.db.collection('floors').updateOne({ societyId: ctx.societyId, _id: floorId }, { $inc: { unitCount: delta } });
}

/**
 * Bulk unit generation for the onboarding wizard (§10, §41).
 * Produces e.g. Tower A / Floor 1 → A-101, A-102 … in one call.
 */
export async function generateUnits(
  ctx: StructureContext,
  input: {
    buildingId: string;
    wingId?: string | null;
    floors: number;
    unitsPerFloor: number;
    numberingPattern?: 'FLOOR_FIRST' | 'WING_FIRST' | 'SEQUENTIAL';
    prefix?: string;
    startNumber?: number;
    unitType?: string;
    carpetAreaSqft?: number;
    createFloors?: boolean;
  },
): Promise<{ created: number; skipped: number; units: Document[] }> {
  const building = await ctx.db.collection('buildings').findOne({ societyId: ctx.societyId, _id: input.buildingId });
  if (!building) throw ApiError.notFound('Building');

  const wingId = input.wingId ? String(input.wingId) : null;
  const pattern = input.numberingPattern ?? 'FLOOR_FIRST';
  const prefix = input.prefix ?? (pattern === 'WING_FIRST' && wingId ? String((building.code ?? 'A')).slice(0, 1) : String(building.code ?? '').slice(0, 1));

  if (input.createFloors !== false) {
    await createFloorsForBuilding(ctx, String(building._id), wingId, input.floors);
  }

  const floors = await ctx.db.collection('floors').find(
    { societyId: ctx.societyId, buildingId: building._id, wingId },
    { sort: { number: 1 }, limit: input.floors * 2 },
  );

  const created: Document[] = [];
  let skipped = 0;
  let sequential = input.startNumber ?? 1;

  for (const floor of floors) {
    const floorNumber = Number(floor.number);
    for (let i = 1; i <= input.unitsPerFloor; i += 1) {
      let unitNumber: string;
      if (pattern === 'FLOOR_FIRST') {
        unitNumber = `${prefix}${floorNumber}${String(i).padStart(2, '0')}`;
      } else if (pattern === 'SEQUENTIAL') {
        unitNumber = `${prefix}${String(sequential).padStart(4, '0')}`;
      } else {
        unitNumber = `${prefix}-${floorNumber}${String(i).padStart(2, '0')}`;
      }
      sequential += 1;

      const exists = await ctx.db.collection('units').findOne({ societyId: ctx.societyId, buildingId: building._id, wingId, unitNumber });
      if (exists) {
        skipped += 1;
        continue;
      }
      try {
        const unit = await createUnit(ctx, {
          buildingId: String(building._id),
          wingId,
          floorId: String(floor._id),
          floorNumber,
          unitNumber,
          type: input.unitType ?? 'FLAT',
          carpetAreaSqft: input.carpetAreaSqft,
        });
        created.push(unit);
      } catch (err) {
        skipped += 1;
        logger.debug({ err: (err as Error).message, unitNumber }, 'structure: unit generation skipped');
      }
    }
  }

  return { created: created.length, skipped, units: created };
}

/* ------------------------------- CSV import ------------------------------- */

export interface ImportUnitsResult {
  buildingsCreated: number;
  wingsCreated: number;
  floorsCreated: number;
  unitsCreated: number;
  skipped: number;
  errors: Array<{ row: number; message: string }>;
  sample: Document[];
}

/**
 * Import the whole structure from a CSV (§41).
 *
 * Minimum columns: `building, unit_number`. Optional: `wing, floor, area_sqft, bhk, status`.
 * Missing buildings/wings/floors are created as encountered, so one spreadsheet takes a
 * society from nothing to a full unit tree.
 */
export async function importUnitsFromCsv(ctx: StructureContext, csv: string, opts: { dryRun?: boolean } = {}): Promise<ImportUnitsResult> {
  const parsed = parseCsv(csv, { aliases: UNIT_IMPORT_ALIASES, maxRows: 50_000 });
  const result: ImportUnitsResult = {
    buildingsCreated: 0,
    wingsCreated: 0,
    floorsCreated: 0,
    unitsCreated: 0,
    skipped: 0,
    errors: [...parsed.errors],
    sample: [],
  };
  if (parsed.rows.length === 0) {
    result.errors.push({ row: 0, message: 'No data rows found. Expected at least `building` and `unit_number` columns.' });
    return result;
  }

  const buildingCache = new Map<string, Document>();
  const wingCache = new Map<string, Document>();
  const floorCache = new Map<string, Document>();

  for (let i = 0; i < parsed.rows.length; i += 1) {
    const row = parsed.rows[i] as Record<string, string>;
    const rowNumber = i + 2; // 1-based + header
    try {
      const buildingName = String(row.building ?? row.tower ?? row.block ?? '').trim();
      const unitNumber = String(row.unit_number ?? row.unitNumber ?? row.flat ?? '').trim();
      if (!unitNumber) {
        result.errors.push({ row: rowNumber, message: 'Missing unit number' });
        result.skipped += 1;
        continue;
      }
      if (!buildingName) {
        result.errors.push({ row: rowNumber, message: 'Missing building/tower name' });
        result.skipped += 1;
        continue;
      }

      /* ---- building ---- */
      let building = buildingCache.get(buildingName.toUpperCase());
      if (!building) {
        building = (await ctx.db.collection('buildings').findOne({ societyId: ctx.societyId, name: formatTitle(buildingName) })) ?? undefined;
        if (!building && !opts.dryRun) {
          building = await ctx.db.collection('buildings').create({
            _id: newId('buildings'),
            societyId: ctx.societyId,
            name: formatTitle(buildingName),
            code: buildingName.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || `B${buildingCache.size + 1}`,
            type: 'TOWER',
            totalFloors: 1,
            unitsPerFloor: 0,
            hasWings: false,
            isActive: true,
            unitCount: 0,
            createdBy: ctx.actorId,
            updatedBy: ctx.actorId,
          });
          result.buildingsCreated += 1;
        }
        if (building) buildingCache.set(buildingName.toUpperCase(), building);
      }
      if (!building) {
        result.skipped += 1;
        continue;
      }

      /* ---- wing ---- */
      const wingName = String(row.wing ?? '').trim();
      let wing: Document | null = null;
      if (wingName) {
        const wingKey = `${building._id}:${wingName.toUpperCase()}`;
        wing = wingCache.get(wingKey) ?? null;
        if (!wing) {
          wing = await ctx.db.collection('wings').findOne({ societyId: ctx.societyId, buildingId: building._id, code: wingName.toUpperCase() });
          if (!wing && !opts.dryRun) {
            wing = await ctx.db.collection('wings').create({
              _id: newId('wings'),
              societyId: ctx.societyId,
              buildingId: building._id,
              name: formatTitle(wingName),
              code: wingName.toUpperCase().slice(0, 6),
              totalFloors: 1,
              isActive: true,
              unitCount: 0,
              createdBy: ctx.actorId,
              updatedBy: ctx.actorId,
            });
            await ctx.db.collection('buildings').updateOne({ _id: building._id }, { $set: { hasWings: true } });
            result.wingsCreated += 1;
          }
          if (wing) wingCache.set(wingKey, wing);
        }
      }

      /* ---- floor ---- */
      const floorRaw = String(row.floor ?? '').trim();
      const floorNumber = Number.isFinite(Number(floorRaw)) && floorRaw !== '' ? Number(floorRaw) : inferFloorNumber(unitNumber);
      const floorKey = `${building._id}:${wing?._id ?? ''}:${floorNumber}`;
      let floor = floorCache.get(floorKey) ?? null;
      if (!floor) {
        floor = await ctx.db.collection('floors').findOne({ societyId: ctx.societyId, buildingId: building._id, wingId: wing?._id ?? null, number: floorNumber });
        if (!floor && !opts.dryRun) {
          floor = await ctx.db.collection('floors').create({
            _id: newId('floors'),
            societyId: ctx.societyId,
            buildingId: building._id,
            wingId: wing?._id ?? null,
            number: floorNumber,
            name: floorNumber < 0 ? `Basement ${Math.abs(floorNumber)}` : floorNumber === 0 ? 'Ground' : `Floor ${floorNumber}`,
            isActive: true,
            unitCount: 0,
            createdBy: ctx.actorId,
            updatedBy: ctx.actorId,
          });
          result.floorsCreated += 1;
        }
        if (floor) floorCache.set(floorKey, floor);
      }

      /* ---- unit ---- */
      const existingUnit = await ctx.db.collection('units').findOne({
        societyId: ctx.societyId,
        buildingId: building._id,
        wingId: wing?._id ?? null,
        unitNumber: unitNumber.toUpperCase(),
      });
      if (existingUnit) {
        result.skipped += 1;
        continue;
      }

      const areaRaw = String(row.carpet_area_sqft ?? row.area_sqft ?? row.carpetAreaSqft ?? '').trim();
      const bedroomsRaw = String(row.bedrooms ?? row.bhk ?? '').trim();
      const statusRaw = String(row.status ?? '').trim().toUpperCase();

      if (!opts.dryRun) {
        const unit = await createUnit(ctx, {
          buildingId: String(building._id),
          wingId: wing ? String(wing._id) : null,
          floorId: floor ? String(floor._id) : null,
          floorNumber,
          unitNumber,
          type: (row.type ?? 'FLAT').toUpperCase(),
          carpetAreaSqft: areaRaw ? Number(areaRaw) : undefined,
          bedrooms: bedroomsRaw ? Number(bedroomsRaw) : undefined,
          status: ['VACANT', 'OCCUPIED', 'LOCKED', 'UNDER_MAINTENANCE'].includes(statusRaw) ? statusRaw : 'VACANT',
        });
        result.unitsCreated += 1;
        if (result.sample.length < 5) result.sample.push(unit);
      } else {
        result.unitsCreated += 1;
      }
    } catch (err) {
      result.errors.push({ row: rowNumber, message: (err as Error).message });
      result.skipped += 1;
    }
  }

  return result;
}

/* --------------------------- unit tree read model -------------------------- */

/** The full tree used by the admin sidebar and the onboarding preview (§10 example). */
export async function getStructureTree(ctx: StructureContext, opts: { buildingId?: string } = {}): Promise<Document[]> {
  const filter: Document = { societyId: ctx.societyId, isActive: true };
  if (opts.buildingId) filter._id = opts.buildingId;

  const [buildings, wings, floors] = await Promise.all([
    ctx.db.collection('buildings').find(filter, { sort: { order: 1, name: 1 }, limit: 1000 }),
    ctx.db.collection('wings').find({ societyId: ctx.societyId, isActive: true }, { sort: { code: 1 }, limit: 20_000 }),
    ctx.db.collection('floors').find({ societyId: ctx.societyId, isActive: true }, { sort: { number: 1 }, limit: 100_000 }),
  ]);

  const wingsByBuilding = groupBy(wings, (w) => String(w.buildingId));
  const floorsByBuilding = groupBy(floors, (f) => `${f.buildingId}:${f.wingId ?? ''}`);

  return buildings.map((b) => ({
    ...b,
    wings: (wingsByBuilding[String(b._id)] ?? []).map((w) => ({
      ...w,
      floors: floorsByBuilding[`${b._id}:${w._id}`] ?? [],
    })),
    floors: floorsByBuilding[`${b._id}:`] ?? [],
  }));
}

/** Unit counts by status — the "Total / Occupied / Vacant" tiles on the dashboard (§39). */
export async function unitStatusCounts(ctx: StructureContext): Promise<Document> {
  const rows = await ctx.db.collection('units').aggregate<Document>([
    { $match: { societyId: ctx.societyId, deletedAt: null } },
    { $group: { _id: { status: '$status', occupancyType: '$occupancyType' }, count: { $sum: 1 } } },
  ]);
  const out: Document = { total: 0, occupied: 0, vacant: 0, locked: 0, underMaintenance: 0, byOccupancy: {} };
  for (const row of rows) {
    const key = row._id as { status?: string; occupancyType?: string };
    const count = Number(row.count ?? 0);
    out.total += count;
    if (key.status === 'OCCUPIED') out.occupied += count;
    else if (key.status === 'VACANT') out.vacant += count;
    else if (key.status === 'LOCKED') out.locked += count;
    else if (key.status === 'UNDER_MAINTENANCE') out.underMaintenance += count;
    const occ = key.occupancyType ?? 'UNKNOWN';
    (out.byOccupancy as Document)[occ] = Number((out.byOccupancy as Document)[occ] ?? 0) + count;
  }
  return out;
}

/**
 * Resolve a unit from a client-supplied reference.
 *
 * Residents can only ever resolve their own units (enforced by the caller passing the
 * membership), so a guessed unit id from another flat cannot be used to raise a visitor.
 */
export async function resolveUnit(
  ctx: StructureContext,
  reference: { unitId?: string; buildingCode?: string; unitNumber?: string },
): Promise<Document> {
  if (reference.unitId) {
    const unit = await ctx.db.collection('units').findOne({ societyId: ctx.societyId, _id: reference.unitId });
    if (!unit) throw ApiError.notFound('Unit');
    return unit;
  }
  if (reference.unitNumber) {
    const filter: Document = { societyId: ctx.societyId, unitNumber: reference.unitNumber.toUpperCase() };
    if (reference.buildingCode) {
      const building = await ctx.db.collection('buildings').findOne({ societyId: ctx.societyId, code: reference.buildingCode.toUpperCase() });
      if (!building) throw ApiError.notFound('Building');
      filter.buildingId = building._id;
    }
    const unit = await ctx.db.collection('units').findOne(filter);
    if (!unit) throw ApiError.notFound('Unit');
    return unit;
  }
  throw ApiError.badRequest('A unit id or unit number is required');
}

/** Recompute cached counters on a unit (owners/tenants/family/vehicles/outstanding). */
export async function refreshUnitCounters(ctx: StructureContext, unitId: string): Promise<void> {
  const [members, vehicles, bills] = await Promise.all([
    ctx.db.collection('unit_members').find({ societyId: ctx.societyId, unitId, isActive: true }, { limit: 200 }),
    ctx.db.collection('vehicles').countDocuments({ societyId: ctx.societyId, unitId, isActive: true }),
    ctx.db.collection('maintenance_bills').find(
      { societyId: ctx.societyId, unitId, status: { $in: ['GENERATED', 'SENT', 'PARTIALLY_PAID', 'OVERDUE'] } },
      { projection: { dueAmount: 1 }, limit: 1000 },
    ),
  ]);

  const owners = members.filter((m) => m.kind === 'OWNER').length;
  const tenants = members.filter((m) => m.kind === 'TENANT').length;
  const family = members.filter((m) => m.kind === 'FAMILY').length;
  const outstanding = bills.reduce((sum, b) => sum + Number(b.dueAmount ?? 0), 0);
  const occupancyType = owners > 0 && tenants > 0 ? 'OWNER_AND_TENANT' : owners > 0 ? 'OWNER' : tenants > 0 ? 'TENANT' : 'VACANT';
  const status = members.length > 0 ? 'OCCUPIED' : 'VACANT';

  await ctx.db.collection('units').updateOne(
    { societyId: ctx.societyId, _id: unitId },
    {
      $set: {
        ownerCount: owners,
        tenantCount: tenants,
        familyCount: family,
        vehicleCount: vehicles,
        outstandingAmount: Math.round(outstanding * 100) / 100,
        occupancyType,
        status,
      },
    },
  );
}

function groupBy<T>(items: T[], key: (item: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const item of items) {
    const k = key(item);
    (out[k] ||= []).push(item);
  }
  return out;
}

export { RESIDENT_IMPORT_ALIASES };
