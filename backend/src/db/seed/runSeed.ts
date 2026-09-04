/**
 * Demo seed: **Green Valley Residency** (§81).
 *
 * Scale, exactly as specified: 5 towers → 20 wings → 800 units → 1500 residents, plus 50 staff,
 * 10 vendors and 5 gates. It exists so a reviewer can log in and run the §80 acceptance scenario
 * against real data instead of an empty database.
 *
 * Two rules shape the implementation:
 *
 * 1. **It goes through the real services, not raw inserts, wherever a service exists.** Creating a
 *    resident via `createResident` also creates the login account and registers the person in the
 *    cross-society identity directory — a raw insert would produce 1500 rows nobody could sign in
 *    with, which is exactly the "looks seeded but doesn't work" failure this file must avoid.
 *
 * 2. **It is idempotent.** If any society already exists the seed refuses to run, so a restart with
 *    SEED_ON_START=true never produces a second Green Valley or duplicate residents.
 *
 * Raw collection writes are used only where no service exists yet (gates, staff, vendors,
 * amenities, parking), and those documents match the registry schema field-for-field.
 */
import { fileURLToPath } from 'node:url';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { databases } from '../../db/manager.js';
import { newId } from '../../db/ids.js';
import { ensureSubscriptionPlans } from '../seedPlatform.js';
import type { Document, TenantDatabase } from '../../db/drivers/types.js';
import { hashPassword } from '../../services/crypto.js';
import { upsertMembership } from '../../services/identityDirectory.js';
import {
  createSociety,
  provisionSocietyDatabase,
  createSocietyAdmin,
  activateSociety,
  refreshSocietyCounters,
  type SocietiesContext,
} from '../../modules/societies/societiesService.js';
import { createBuilding, generateUnits, type StructureContext } from '../../modules/structure/structureService.js';
import { createResident, addVehicle, type ResidentsContext } from '../../modules/residents/residentsService.js';

/* -------------------------------------------------------------------------- */
/* shape of the demo society                                                  */
/* -------------------------------------------------------------------------- */

const SOCIETY = {
  name: 'Green Valley Residency',
  slug: 'green-valley-residency',
  legalName: 'Green Valley Residency Co-operative Housing Society Ltd.',
  registrationNumber: 'MH/CHS/PUNE/2016/04412',
  city: 'Pune',
  state: 'Maharashtra',
  country: 'IN',
  pincode: '411045',
  address: 'Survey 88/2, Baner-Balewadi Road, Baner, Pune',
  timezone: 'Asia/Kolkata',
  currency: 'INR',
  contactEmail: 'office@greenvalley.local',
  contactPhone: '+919800000000',
  // ENTERPRISE enables every module, so no part of the §80 flow is gated off in the demo.
  tier: 'ENTERPRISE' as const,
};

const TOWERS = [
  { code: 'A', name: 'Tower A — Aman', wings: ['A1', 'A2', 'A3', 'A4'], floors: 10, unitsPerFloor: 4, area: 720 },
  { code: 'B', name: 'Tower B — Bansuri', wings: ['B1', 'B2', 'B3', 'B4'], floors: 10, unitsPerFloor: 4, area: 850 },
  { code: 'C', name: 'Tower C — Chandan', wings: ['C1', 'C2', 'C3', 'C4'], floors: 10, unitsPerFloor: 4, area: 950 },
  { code: 'D', name: 'Tower D — Devgiri', wings: ['D1', 'D2', 'D3', 'D4'], floors: 10, unitsPerFloor: 4, area: 1100 },
  { code: 'E', name: 'Tower E — Esha', wings: ['E1', 'E2', 'E3', 'E4'], floors: 10, unitsPerFloor: 4, area: 1250 },
] as const;

const GATES = [
  { code: 'G1', name: 'Main Gate', type: 'MAIN', allowsVehicles: true, allowsPedestrians: true },
  { code: 'G2', name: 'North Gate', type: 'SECONDARY', allowsVehicles: true, allowsPedestrians: true },
  { code: 'G3', name: 'Pedestrian Gate', type: 'PEDESTRIAN', allowsVehicles: false, allowsPedestrians: true },
  { code: 'G4', name: 'Parking Gate', type: 'PARKING', allowsVehicles: true, allowsPedestrians: false },
  { code: 'G5', name: 'Service Gate', type: 'SERVICE', allowsVehicles: true, allowsPedestrians: true },
] as const;

const AMENITIES = [
  { name: 'Clubhouse', type: 'CLUBHOUSE', capacity: 60, bookingFee: 1500, deposit: 2000, requireApproval: true, open: '08:00', close: '22:00', slot: 180 },
  { name: 'Swimming Pool', type: 'SWIMMING_POOL', capacity: 25, bookingFee: 0, deposit: 0, requireApproval: false, open: '06:00', close: '20:00', slot: 60 },
  { name: 'Gymnasium', type: 'GYM', capacity: 20, bookingFee: 0, deposit: 0, requireApproval: false, open: '05:00', close: '22:00', slot: 60 },
  { name: 'Tennis Court', type: 'SPORTS_COURT', capacity: 4, bookingFee: 400, deposit: 0, requireApproval: false, open: '06:00', close: '21:00', slot: 60 },
  { name: 'Community Hall', type: 'COMMUNITY_HALL', capacity: 120, bookingFee: 3500, deposit: 5000, requireApproval: true, open: '09:00', close: '22:00', slot: 240 },
  { name: 'Kids Play Area', type: 'PLAYGROUND', capacity: 30, bookingFee: 0, deposit: 0, requireApproval: false, open: '07:00', close: '20:00', slot: 120 },
] as const;

const VENDOR_DEFS = [
  { businessName: 'Shree Elevator Services', categories: ['ELECTRICAL', 'LIFT_MAINTENANCE'], contract: 'AMC', value: 180000 },
  { businessName: 'Urban Pest Control', categories: ['PEST_CONTROL'], contract: 'MONTHLY', value: 24000 },
  { businessName: 'Kaveri Housekeeping', categories: ['HOUSEKEEPING', 'CLEANING'], contract: 'ANNUAL', value: 420000 },
  { businessName: 'GreenScape Gardens', categories: ['GARDENING', 'LANDSCAPING'], contract: 'MONTHLY', value: 36000 },
  { businessName: 'SecurePro Agencies', categories: ['SECURITY'], contract: 'ANNUAL', value: 960000 },
  { businessName: 'Patil Plumbing Works', categories: ['PLUMBING'], contract: 'PER_VISIT', value: 0 },
  { businessName: 'VoltFix Electricals', categories: ['ELECTRICAL'], contract: 'PER_VISIT', value: 0 },
  { businessName: 'AquaPure Water Systems', categories: ['WATER_TREATMENT', 'RO_MAINTENANCE'], contract: 'AMC', value: 145000 },
  { businessName: 'Swift Facility Managers', categories: ['FACILITY_MANAGEMENT'], contract: 'ANNUAL', value: 600000 },
  { businessName: 'Nova Waste Management', categories: ['WASTE_MANAGEMENT'], contract: 'MONTHLY', value: 18000 },
] as const;

const STAFF_TYPES = [
  'SECURITY', 'SECURITY', 'SECURITY', 'SECURITY', 'SECURITY', 'SECURITY', 'SECURITY', 'SECURITY',
  'HOUSEKEEPING', 'HOUSEKEEPING', 'HOUSEKEEPING', 'HOUSEKEEPING', 'HOUSEKEEPING', 'HOUSEKEEPING',
  'MAINTENANCE', 'MAINTENANCE', 'MAINTENANCE', 'MAINTENANCE',
  'ELECTRICIAN', 'ELECTRICIAN', 'PLUMBER', 'PLUMBER',
  'GARDENER', 'GARDENER', 'GARDENER', 'CLEANER', 'CLEANER', 'CLEANER', 'CLEANER',
  'RECEPTIONIST', 'RECEPTIONIST', 'MANAGER', 'TECHNICIAN', 'DRIVER',
] as const;

const FIRST_NAMES = [
  'Aarav', 'Vivaan', 'Aditya', 'Vihaan', 'Arjun', 'Sai', 'Reyansh', 'Ayaan', 'Krishna', 'Ishaan',
  'Ananya', 'Aadhya', 'Aarohi', 'Diya', 'Isha', 'Kavya', 'Meera', 'Nisha', 'Priya', 'Riya',
  'Rohan', 'Karan', 'Nikhil', 'Sameer', 'Ganesh', 'Mahesh', 'Suresh', 'Ramesh', 'Dinesh', 'Rakesh',
  'Sneha', 'Pooja', 'Neha', 'Kiran', 'Shreya', 'Divya', 'Anjali', 'Swati', 'Rupali', 'Manisha',
] as const;

const LAST_NAMES = [
  'Deshmukh', 'Kulkarni', 'Joshi', 'Patil', 'Shinde', 'Kadam', 'Sawant', 'Gaikwad', 'Bhosale',
  'Chavan', 'More', 'Pawar', 'Salunkhe', 'Thorat', 'Jadhav', 'Rane', 'Bhandari', 'Naik', 'Verma',
  'Sharma', 'Iyer', 'Nair', 'Reddy', 'Rao', 'Mehta', 'Shah', 'Patel', 'Gupta', 'Agarwal', 'Menon',
] as const;

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Run `fn` over `items` with bounded concurrency — 1500 sequential awaits is needlessly slow. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

const personName = (i: number): string =>
  `${FIRST_NAMES[i % FIRST_NAMES.length]} ${LAST_NAMES[Math.floor(i / FIRST_NAMES.length) % LAST_NAMES.length]}`;

/**
 * Deterministic, collision-free demo mobile numbers.
 *
 * The `98000xxxxx` block is reserved for the seed and starts at index 1000 so it can never clash
 * with the hand-picked numbers used for the documented demo accounts (`+919800000101` and friends).
 */
const demoPhone = (index: number): string => `+9198${String(index + 1000).padStart(8, '0')}`;

/* -------------------------------------------------------------------------- */
/* platform accounts                                                          */
/* -------------------------------------------------------------------------- */

/** Super-admin account for the platform console. Idempotent on email. */
async function seedPlatformSuperAdmin(): Promise<{ email: string; created: boolean }> {
  const platform = await databases.platform();
  const users = platform.collection('platform_users');
  const email = env.SEED_SUPER_ADMIN_EMAIL.toLowerCase();

  const existing = await users.findOne({ email });
  if (existing) return { email, created: false };

  await users.create({
    _id: newId('platform_users'),
    fullName: 'Colonize Super Admin',
    email,
    phone: null,
    passwordHash: await hashPassword(env.SEED_SUPER_ADMIN_PASSWORD),
    roles: ['SUPER_ADMIN'],
    avatarUrl: null,
    status: 'ACTIVE',
    lastLoginAt: null,
    mustChangePassword: false,
    preferences: {},
    notes: 'Created by the demo seeder.',
  });
  return { email, created: true };
}

/* -------------------------------------------------------------------------- */
/* tenant data                                                                */
/* -------------------------------------------------------------------------- */

async function seedGates(db: TenantDatabase, societyId: string, actorId: string): Promise<number> {
  const gates = db.collection('gates');
  let created = 0;
  for (const g of GATES) {
    if (await gates.findOne({ societyId, code: g.code })) continue;
    await gates.create({
      _id: newId('gates'),
      societyId,
      name: g.name,
      code: g.code,
      type: g.type,
      allowsVehicles: g.allowsVehicles,
      allowsPedestrians: g.allowsPedestrians,
      isOpen24x7: g.type !== 'SERVICE',
      openTime: '00:00',
      closeTime: '23:59',
      isActive: true,
      entriesToday: 0,
      lastEntryAt: null,
      createdBy: actorId,
      updatedBy: actorId,
    });
    created += 1;
  }
  return created;
}

async function seedAmenities(db: TenantDatabase, societyId: string, actorId: string): Promise<number> {
  const amenities = db.collection('amenities');
  let created = 0;
  for (const a of AMENITIES) {
    if (await amenities.findOne({ societyId, name: a.name })) continue;
    await amenities.create({
      _id: newId('amenities'),
      societyId,
      name: a.name,
      type: a.type,
      description: `${a.name} at ${SOCIETY.name}. Bookable from the resident app.`,
      rules: ['Members only', 'No glass containers', 'Children must be accompanied'],
      capacity: a.capacity,
      openTime: a.open,
      closeTime: a.close,
      slotDurationMinutes: a.slot,
      slotGapMinutes: 0,
      bookingFee: a.bookingFee,
      deposit: a.deposit,
      requireApproval: a.requireApproval,
      allowCancellation: true,
      cancellationHoursBefore: 12,
      refundPercent: 100,
      maxAdvanceDays: 30,
      maxSlotsPerUserPerDay: 2,
      closedOnDays: [],
      isActive: true,
      totalBookings: 0,
      totalRevenue: 0,
      createdBy: actorId,
      updatedBy: actorId,
    });
    created += 1;
  }
  return created;
}

async function seedVendors(db: TenantDatabase, societyId: string, actorId: string): Promise<number> {
  const vendors = db.collection('vendors');
  let created = 0;
  for (let i = 0; i < VENDOR_DEFS.length; i += 1) {
    const v = VENDOR_DEFS[i];
    if (!v) continue;
    if (await vendors.findOne({ societyId, businessName: v.businessName })) continue;
    await vendors.create({
      _id: newId('vendors'),
      societyId,
      businessName: v.businessName,
      contactPersonName: personName(i + 7),
      phone: demoPhone(9000 + i),
      alternatePhone: null,
      email: `contact${i + 1}@vendor.local`,
      userId: null,
      address: { line1: `${i + 12} Market Yard`, city: SOCIETY.city, state: SOCIETY.state, pincode: SOCIETY.pincode },
      gstin: null,
      pan: null,
      serviceCategories: [...v.categories],
      contractType: v.contract,
      contractValue: v.value,
      startDate: new Date(),
      endDate: new Date(Date.now() + 365 * 86_400_000),
      paymentTermsDays: 15,
      rating: 0,
      totalWorkOrders: 0,
      completedWorkOrders: 0,
      totalBilled: 0,
      totalPaid: 0,
      outstandingPayable: 0,
      allowPortalLogin: false,
      status: 'ACTIVE',
      documents: [],
      createdBy: actorId,
      updatedBy: actorId,
    });
    created += 1;
  }
  return created;
}

/**
 * 50 staff records. The first eight are security guards with real login accounts, because the
 * gate/security mobile app authenticates as a guard — a staff row with no user cannot scan a pass.
 */
async function seedStaff(
  db: TenantDatabase,
  societyId: string,
  actorId: string,
  gateIds: string[],
): Promise<{ staff: number; guardLogins: number }> {
  const staffColl = db.collection('staff');
  const users = db.collection('users');
  const assignments = db.collection('guard_assignments');
  const society = { id: societyId, name: SOCIETY.name, slug: SOCIETY.slug };

  const TARGET = 50;
  let created = 0;
  let guardLogins = 0;

  for (let i = 0; i < TARGET; i += 1) {
    const type = STAFF_TYPES[i % STAFF_TYPES.length] ?? 'OTHER';
    const name = personName(i + 200);
    // Guards get the reserved demo number for the first one so the docs can quote it exactly.
    const isFirstGuard = type === 'SECURITY' && guardLogins === 0;
    const phone = isFirstGuard ? env.SEED_GUARD_PHONE : demoPhone(5000 + i);

    if (await staffColl.findOne({ societyId, phone })) continue;

    const isGuard = type === 'SECURITY';
    let userId: string | null = null;

    // Guards authenticate into the security app, so they need a user account and a directory entry.
    if (isGuard) {
      userId = newId('users');
      await users.create({
        _id: userId,
        societyId,
        fullName: name,
        phone,
        email: null,
        passwordHash: await hashPassword(isFirstGuard ? env.SEED_GUARD_PASSWORD : 'Guard@1234'),
        roles: [guardLogins === 0 ? 'SECURITY_SUPERVISOR' : 'SECURITY_GUARD'],
        status: 'ACTIVE',
        isActive: true,
        isVerified: true,
        avatarUrl: null,
        gender: null,
        dateOfBirth: null,
        lastLoginAt: null,
        failedLoginCount: 0,
        lockedUntil: null,
        mustChangePassword: false,
        pushTokens: [],
        preferences: {},
        createdSource: 'seed',
        createdBy: actorId,
        updatedBy: actorId,
      });
      await upsertMembership({
        societyId,
        societyName: society.name,
        societySlug: society.slug,
        userId,
        phone,
        roles: [guardLogins === 0 ? 'SECURITY_SUPERVISOR' : 'SECURITY_GUARD'],
        unitIds: [],
        isActive: true,
      });
      guardLogins += 1;
    }

    // The staff row is created before any guard assignment, because `guard_assignments.staffId`
    // is a required reference — creating the assignment first would need a placeholder the
    // driver rightly rejects.
    const staffId = newId('staff');
    await staffColl.create({
      _id: staffId,
      societyId,
      fullName: name,
      phone,
      email: null,
      photoUrl: null,
      type,
      employmentType: 'SOCIETY',
      userId,
      address: null,
      idProofType: 'AADHAAR',
      idProofNumber: null,
      joiningDate: new Date(Date.now() - (i + 1) * 30 * 86_400_000),
      exitDate: null,
      monthlySalary: isGuard ? 22000 : 15000,
      workType: 'FULL_TIME',
      workingDays: [0, 1, 2, 3, 4, 5, 6],
      startTime: '08:00',
      endTime: '20:00',
      assignedUnitIds: [],
      gateId: isGuard ? (gateIds[guardLogins % Math.max(1, gateIds.length)] ?? null) : null,
      shift: isGuard ? (['MORNING', 'AFTERNOON', 'NIGHT'] as const)[guardLogins % 3] : 'GENERAL',
      vendorId: null,
      allowLogin: isGuard,
      notifyResidentsOnArrival: false,
      status: 'ACTIVE',
      policeVerificationStatus: isGuard ? 'VERIFIED' : 'NOT_REQUIRED',
      rating: 0,
      lastEntryAt: null,
      createdBy: actorId,
      updatedBy: actorId,
    });

    // Post the guard to a gate so the security console has a live shift to show.
    if (isGuard && userId && gateIds.length > 0) {
      const gateId = gateIds[guardLogins % gateIds.length] ?? gateIds[0];
      if (gateId) {
        await assignments.create({
          _id: newId('guard_assignments'),
          societyId,
          staffId,
          userId,
          gateId,
          shift: (['MORNING', 'AFTERNOON', 'NIGHT'] as const)[guardLogins % 3] ?? 'GENERAL',
          startDate: new Date(),
          endDate: null,
          isActive: true,
          notes: 'Seeded assignment',
          createdBy: actorId,
          updatedBy: actorId,
        });
      }
    }

    created += 1;
  }

  return { staff: created, guardLogins };
}

async function seedParking(db: TenantDatabase, societyId: string, actorId: string, buildingIds: string[]): Promise<{ areas: number; slots: number }> {
  const areas = db.collection('parking_areas');
  const slots = db.collection('parking_slots');
  let areasCreated = 0;
  let slotsCreated = 0;

  const defs = [
    { name: 'Basement Level 1', code: 'P-B1', level: 'B1', kind: 'RESERVED', count: 120 },
    { name: 'Basement Level 2', code: 'P-B2', level: 'B2', kind: 'RESERVED', count: 80 },
    { name: 'Open Parking — East', code: 'P-OP', level: 'Ground', kind: 'COMMON', count: 40 },
    { name: 'Visitor Parking', code: 'P-VIS', level: 'Ground', kind: 'VISITOR', count: 20 },
    { name: 'Two-Wheeler Zone', code: 'P-2W', level: 'Ground', kind: 'TWO_WHEELER', count: 140 },
  ] as const;

  for (const def of defs) {
    let area = await areas.findOne({ societyId, code: def.code });
    if (!area) {
      area = await areas.create({
        _id: newId('parking_areas'),
        societyId,
        name: def.name,
        code: def.code,
        level: def.level,
        buildingId: buildingIds[0] ?? null,
        capacity: def.count,
        isActive: true,
        createdBy: actorId,
        updatedBy: actorId,
      });
      areasCreated += 1;
    }

    const existing = await slots.countDocuments({ societyId, areaId: area._id });
    for (let n = existing + 1; n <= def.count; n += 1) {
      await slots.create({
        _id: newId('parking_slots'),
        societyId,
        areaId: area._id,
        slotNumber: `${def.code}-${String(n).padStart(3, '0')}`,
        type: def.kind,
        status: 'AVAILABLE',
        capacity: def.kind === 'TWO_WHEELER' ? 2 : 1,
        isEv: def.kind === 'RESERVED' && n % 20 === 0,
        hasCharger: def.kind === 'RESERVED' && n % 20 === 0,
        monthlyCharge: def.kind === 'RESERVED' ? 300 : def.kind === 'TWO_WHEELER' ? 100 : 0,
        buildingId: buildingIds[0] ?? null,
        assignedUnitId: null,
        assignedVehicleId: null,
        assignedFrom: null,
        assignedTill: null,
        isActive: true,
        createdBy: actorId,
        updatedBy: actorId,
      });
      slotsCreated += 1;
    }
  }

  return { areas: areasCreated, slots: slotsCreated };
}

/* -------------------------------------------------------------------------- */
/* structure + residents                                                      */
/* -------------------------------------------------------------------------- */

async function seedStructure(
  structureCtx: StructureContext,
): Promise<{ buildings: number; wings: number; floors: number; units: number; unitIds: string[]; buildingIds: string[] }> {
  const db = structureCtx.db;
  const societyId = structureCtx.societyId;
  let buildings = 0;
  let wings = 0;
  let floors = 0;
  let units = 0;
  const unitIds: string[] = [];
  const buildingIds: string[] = [];

  for (const tower of TOWERS) {
    let building = await db.collection('buildings').findOne({ societyId, code: tower.code });
    if (!building) {
      building = await createBuilding(structureCtx, {
        name: tower.name,
        code: tower.code,
        type: 'TOWER',
        totalFloors: tower.floors,
        unitsPerFloor: tower.unitsPerFloor,
        hasWings: true,
        liftCount: 2,
        yearBuilt: 2018,
        // Floors belong to wings here; suppress the building-level floor sweep.
        createFloors: false,
        wings: tower.wings.map((code) => ({ name: `Wing ${code}`, code, totalFloors: tower.floors })),
      });
      buildings += 1;
    }
    buildingIds.push(String(building._id));

    const wingDocs = await db
      .collection('wings')
      .find({ societyId, buildingId: building._id }, { sort: { code: 1 }, limit: 50 });
    wings += wingDocs.length;

    for (const wing of wingDocs) {
      const floorCount = await db
        .collection('floors')
        .countDocuments({ societyId, buildingId: building._id, wingId: wing._id });
      floors += floorCount;

      const existingUnits = await db.collection('units').countDocuments({ societyId, wingId: wing._id });
      if (existingUnits >= tower.floors * tower.unitsPerFloor) {
        const already = await db
          .collection('units')
          .find({ societyId, wingId: wing._id }, { limit: 500, projection: { _id: 1 } });
        unitIds.push(...already.map((u) => String(u._id)));
        units += already.length;
        continue;
      }

      const generated = await generateUnits(structureCtx, {
        buildingId: String(building._id),
        wingId: String(wing._id),
        floors: tower.floors,
        unitsPerFloor: tower.unitsPerFloor,
        numberingPattern: 'FLOOR_FIRST',
        prefix: String(wing.code),
        unitType: 'FLAT',
        carpetAreaSqft: tower.area,
        // createWing already created these floors.
        createFloors: false,
      });

      units += generated.created;
      unitIds.push(...generated.units.map((u) => String(u._id)));
    }
  }

  return { buildings, wings, floors, units, unitIds, buildingIds };
}

/**
 * 1500 residents across 800 units: one primary owner everywhere, plus a second household member
 * in the first 700 units. Every resident goes through `createResident`, so each one gets a login
 * account and an identity-directory entry — i.e. they can actually sign in to the app.
 */
async function seedResidents(
  residentsCtx: ResidentsContext,
  unitIds: string[],
): Promise<{ residents: number; vehicles: number }> {
  const societyId = residentsCtx.societyId;
  const db = residentsCtx.db;

  const existing = await db.collection('residents').countDocuments({ societyId });
  if (existing >= 1500) return { residents: existing, vehicles: 0 };

  // One primary per unit.
  type Assignment = { unitId: string; kind: 'OWNER' | 'FAMILY' | 'TENANT'; isPrimary: boolean; index: number };
  const assignments: Assignment[] = [];
  unitIds.forEach((unitId, i) => {
    assignments.push({ unitId, kind: 'OWNER', isPrimary: true, index: i });
  });
  // A second member in the first 700 units → 800 + 700 = 1500.
  unitIds.slice(0, 700).forEach((unitId, i) => {
    // Every tenth household is rented rather than owner-occupied, so tenant flows have data too.
    const kind = i % 10 === 9 ? 'TENANT' : 'FAMILY';
    assignments.push({ unitId, kind, isPrimary: false, index: 800 + i });
  });

  let residents = 0;
  let vehicles = 0;

  await mapLimit(assignments, 12, async (a) => {
    // The very first owner is the documented demo login for the §80 walkthrough.
    const phone = a.index === 0 ? env.SEED_DEMO_RESIDENT_PHONE : demoPhone(a.index);
    const email = a.isPrimary ? `resident${a.index + 1}@greenvalley.local` : null;

    try {
      const resident = await createResident(residentsCtx, {
        unitId: a.unitId,
        fullName: personName(a.index),
        phone,
        email,
        kind: a.kind,
        isPrimary: a.isPrimary,
        moveInDate: new Date(Date.now() - (a.index % 720) * 86_400_000),
        // Password login is a convenience for the demo; OTP remains the primary resident flow.
        password: a.isPrimary ? 'Resident@123' : null,
        createLogin: true,
      });
      residents += 1;

      // Give roughly a third of primary residents a car, so parking/vehicle flows have data.
      if (a.isPrimary && a.index % 3 === 0 && resident?._id) {
        const plate = `MH12${String.fromCharCode(65 + (a.index % 26))}${String.fromCharCode(65 + ((a.index * 7) % 26))}${String(1000 + (a.index % 8999))}`;
        await addVehicle(residentsCtx, {
          residentId: String(resident._id),
          unitId: a.unitId,
          vehicleNumber: plate,
          type: a.index % 6 === 0 ? 'TWO_WHEELER' : 'CAR',
          make: a.index % 6 === 0 ? 'Honda Activa' : 'Maruti Suzuki Baleno',
          model: null,
          color: ['White', 'Silver', 'Black', 'Red', 'Blue'][a.index % 5] ?? 'White',
          isPrimary: true,
        });
        vehicles += 1;
      }
    } catch (err) {
      // A single bad row must not abort a 1500-resident seed; log it and carry on.
      logger.warn({ err: (err as Error).message, unitId: a.unitId, index: a.index }, 'seed: resident skipped');
    }
  });

  return { residents, vehicles };
}

/* -------------------------------------------------------------------------- */
/* orchestration                                                              */
/* -------------------------------------------------------------------------- */

export interface SeedResult {
  seeded: boolean;
  reason?: string;
  societyId?: string;
  slug?: string;
  databaseName?: string;
  counts?: Record<string, number>;
  logins?: Record<string, string>;
  tookMs?: number;
}

export async function runSeed(opts: { force?: boolean } = {}): Promise<SeedResult> {
  const startedAt = Date.now();
  const platform = await databases.platform();

  if (env.NODE_ENV === 'production' && !env.SEED_ALLOW_PRODUCTION) {
    return { seeded: false, reason: 'Refusing to seed in production without SEED_ALLOW_PRODUCTION=true' };
  }

  const existingSocieties = await platform.collection('societies').countDocuments({});
  if (existingSocieties > 0 && !opts.force) {
    return { seeded: false, reason: `Platform already has ${existingSocieties} societ${existingSocieties === 1 ? 'y' : 'ies'}` };
  }

  // Plans first: a society subscription references one, and provisioning mirrors the plan's
  // module set into the society's own database.
  const plans = await ensureSubscriptionPlans(platform);
  const superAdmin = await seedPlatformSuperAdmin();

  // The seeder acts as the super admin: every audit entry it writes has a real actor.
  const platformUsers = platform.collection('platform_users');
  const actor = await platformUsers.findOne({ email: env.SEED_SUPER_ADMIN_EMAIL.toLowerCase() });
  const actorId = String(actor?._id ?? 'sys:seed');
  const societiesCtx: SocietiesContext = { platform, actorId, actorName: 'Seed Script' };

  /* ---- society + dedicated database ---- */
  let society = await platform.collection('societies').findOne({ slug: SOCIETY.slug });
  if (!society) {
    society = await createSociety(societiesCtx, { ...SOCIETY });
    logger.info({ societyId: society._id, databaseName: society.databaseName }, 'seed: society created');
  }
  const societyId = String(society._id);
  await provisionSocietyDatabase(society);

  const db = await databases.tenantDb(societyId);
  const structureCtx: StructureContext = { db, societyId, actorId };
  const residentsCtx: ResidentsContext = { db, societyId, actorId, actorName: 'Seed Script' };

  /* ---- society admin (must exist before activation) ---- */
  await createSocietyAdmin(
    structureCtx,
    {
      fullName: 'Rajeev Kulkarni',
      email: env.SEED_SOCIETY_ADMIN_EMAIL,
      phone: env.SEED_SOCIETY_ADMIN_PHONE,
      password: env.SEED_SOCIETY_ADMIN_PASSWORD,
      roles: ['SOCIETY_ADMIN', 'CHAIRMAN'],
    },
    { activate: true },
  );
  const admin = await db.collection('users').findOne({ societyId, email: env.SEED_SOCIETY_ADMIN_EMAIL.toLowerCase() });
  const adminId = String(admin?._id ?? actorId);

  /* ---- gates, amenities, vendors ---- */
  const gatesCreated = await seedGates(db, societyId, adminId);
  const gateDocs = await db.collection('gates').find({ societyId }, { limit: 50, projection: { _id: 1 } });
  const gateIds = gateDocs.map((g) => String(g._id));

  const amenitiesCreated = await seedAmenities(db, societyId, adminId);
  const vendorsCreated = await seedVendors(db, societyId, adminId);

  /* ---- structure: 5 towers → 20 wings → 800 units ---- */
  const structure = await seedStructure(structureCtx);
  // Log the counts only — the id arrays run to 800 entries and drown the rest of the output.
  logger.info(
    {
      buildings: structure.buildings,
      wings: structure.wings,
      floors: structure.floors,
      units: structure.units,
    },
    'seed: structure ready',
  );

  /* ---- parking (needs buildings) ---- */
  const parking = await seedParking(db, societyId, adminId, structure.buildingIds);

  /* ---- staff (needs gates) ---- */
  const staff = await seedStaff(db, societyId, adminId, gateIds);

  /* ---- residents: 1500 (needs units) ---- */
  const residentResult = await seedResidents(residentsCtx, structure.unitIds);

  /* ---- activate + refresh denormalised counters ---- */
  await activateSociety(societiesCtx, societyId);
  await refreshSocietyCounters(societyId).catch((err) =>
    logger.warn({ err }, 'seed: counter refresh failed (non-fatal)'),
  );

  const finalCounts = {
    buildings: await db.collection('buildings').countDocuments({ societyId }),
    wings: await db.collection('wings').countDocuments({ societyId }),
    floors: await db.collection('floors').countDocuments({ societyId }),
    units: await db.collection('units').countDocuments({ societyId }),
    residents: await db.collection('residents').countDocuments({ societyId }),
    users: await db.collection('users').countDocuments({ societyId }),
    vehicles: await db.collection('vehicles').countDocuments({ societyId }),
    staff: await db.collection('staff').countDocuments({ societyId }),
    vendors: await db.collection('vendors').countDocuments({ societyId }),
    gates: await db.collection('gates').countDocuments({ societyId }),
    amenities: await db.collection('amenities').countDocuments({ societyId }),
    parkingSlots: await db.collection('parking_slots').countDocuments({ societyId }),
  };

  const result: SeedResult = {
    seeded: true,
    societyId,
    slug: SOCIETY.slug,
    databaseName: String(society.databaseName),
    counts: {
      ...finalCounts,
      guardLogins: staff.guardLogins,
      superAdminCreated: superAdmin.created ? 1 : 0,
      subscriptionPlans: plans.total,
    },
    logins: {
      superAdmin: `${env.SEED_SUPER_ADMIN_EMAIL} / ${env.SEED_SUPER_ADMIN_PASSWORD}`,
      societyAdmin: `${env.SEED_SOCIETY_ADMIN_EMAIL} / ${env.SEED_SOCIETY_ADMIN_PASSWORD}`,
      demoResident: `${env.SEED_DEMO_RESIDENT_PHONE} (OTP, or password Resident@123)`,
      demoGuard: `${env.SEED_GUARD_PHONE} / ${env.SEED_GUARD_PASSWORD}`,
    },
    tookMs: Date.now() - startedAt,
  };

  logger.info(result, 'seed: Green Valley Residency ready');
  return result;
}

/** Seed only when the platform is empty — the variant the server calls on boot. */
export async function runSeedIfEmpty(): Promise<SeedResult> {
  return runSeed({ force: false });
}

/* -------------------------------------------------------------------------- */
/* CLI: `npm run seed`                                                        */
/* -------------------------------------------------------------------------- */

const isDirectRun = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;

if (isDirectRun) {
  const force = process.argv.includes('--force');
  runSeed({ force })
    .then(async (result) => {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(result, null, 2));
      await databases.flush().catch(() => undefined);
      await databases.closeAll();
      process.exit(result.seeded ? 0 : 0);
    })
    .catch(async (err) => {
      logger.fatal({ err }, 'seed failed');
      await databases.closeAll().catch(() => undefined);
      process.exit(1);
    });
}
