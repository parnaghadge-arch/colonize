import { formatPersonName, normalisePhone, type MemberKind, type Role } from '@colonize/shared';
import type { Document, TenantDatabase } from '../../db/drivers/types.js';
import { newId } from '../../db/ids.js';
import { ApiError } from '../../utils/errors.js';
import { hashPassword } from '../../services/crypto.js';
import { upsertMembership } from '../../services/identityDirectory.js';
import { databases } from '../../db/manager.js';
import { refreshUnitCounters } from '../structure/structureService.js';
import { logger } from '../../config/logger.js';

/**
 * Residents, family members, unit memberships and vehicles (§11, §12, §13).
 *
 * The invariant that matters: a *resident* is a person living in a unit, a *user* is something
 * that can authenticate, and `unit_members` is the link that authorises one for the other.
 * Adding a resident with a phone number creates (or upgrades) the matching user account and
 * registers it in the cross-society login directory, so the very next thing that resident can
 * do is sign in with an OTP — there is no separate "create login" step and no way to end up
 * with a resident who can never authenticate.
 */

export interface ResidentsContext {
  db: TenantDatabase;
  societyId: string;
  actorId: string;
  actorName?: string | null;
}

const MEMBER_ROLE: Record<MemberKind, Role> = {
  OWNER: 'OWNER',
  TENANT: 'TENANT',
  FAMILY: 'FAMILY_MEMBER',
  COMPANY_GUEST: 'TENANT',
};

/** Per-member capabilities (§9). Owners get everything; family members get a safe default. */
export function defaultPermissions(kind: MemberKind | 'FAMILY_MEMBER'): Document {
  if (kind === 'OWNER') {
    return {
      canApproveVisitors: true,
      canApproveDeliveries: true,
      canRaiseComplaints: true,
      canBookAmenities: true,
      canMakePayments: true,
      canViewBills: true,
      canAddStaff: true,
      canRaiseEmergency: true,
      canVoteInPolls: true,
      canManageFamily: true,
      canManageVehicles: true,
    };
  }
  if (kind === 'TENANT') {
    return {
      canApproveVisitors: true,
      canApproveDeliveries: true,
      canRaiseComplaints: true,
      canBookAmenities: true,
      canMakePayments: true,
      canViewBills: true,
      canAddStaff: false,
      canRaiseEmergency: true,
      canVoteInPolls: false,
      canManageFamily: false,
      canManageVehicles: true,
    };
  }
  return {
    canApproveVisitors: false,
    canApproveDeliveries: false,
    canRaiseComplaints: true,
    canBookAmenities: false,
    canMakePayments: false,
    canViewBills: false,
    canAddStaff: false,
    canRaiseEmergency: true,
    canVoteInPolls: false,
    canManageFamily: false,
    canManageVehicles: false,
  };
}

/* --------------------------------- residents -------------------------------- */

export interface CreateResidentInput extends Document {
  unitId: string;
  fullName: string;
  phone?: string | null;
  email?: string | null;
  kind?: MemberKind;
  isPrimary?: boolean;
  moveInDate?: string | Date | null;
  password?: string | null;
  /** Create the login account immediately (default: whenever a phone or email is present). */
  createLogin?: boolean;
}

export async function createResident(ctx: ResidentsContext, input: CreateResidentInput): Promise<Document> {
  const unit = await ctx.db.collection('units').findOne({ societyId: ctx.societyId, _id: input.unitId });
  if (!unit) throw ApiError.notFound('Unit');

  const phone = input.phone ? normalisePhone(String(input.phone)) : null;
  const email = input.email ? String(input.email).toLowerCase().trim() : null;
  if (!phone && !email) throw ApiError.badRequest('A resident needs a phone number or an email address');

  const kind = (input.kind ?? 'OWNER') as MemberKind;
  const fullName = formatPersonName(String(input.fullName ?? ''));
  if (!fullName) throw ApiError.badRequest('A resident name is required');

  // One phone number = one resident record per unit. Re-adding the same person updates them
  // instead of creating a duplicate the gate app would show twice.
  const existing =
    (phone ? await ctx.db.collection('residents').findOne({ societyId: ctx.societyId, unitId: unit._id, phone }) : null) ??
    (await ctx.db.collection('residents').findOne({ societyId: ctx.societyId, unitId: unit._id, fullName, kind }));

  const isFirstOwner = kind === 'OWNER' && !(await ctx.db.collection('residents').countDocuments({ societyId: ctx.societyId, unitId: unit._id, kind: 'OWNER', status: 'ACTIVE' }));

  const fields: Document = {
    fullName,
    phone,
    email,
    gender: input.gender ?? existing?.gender ?? null,
    dateOfBirth: input.dateOfBirth ? new Date(String(input.dateOfBirth)) : existing?.dateOfBirth ?? null,
    photoUrl: input.photoUrl ?? existing?.photoUrl ?? null,
    address: input.address ?? existing?.address ?? null,
    unitId: unit._id,
    kind,
    isPrimary: input.isPrimary ?? existing?.isPrimary ?? isFirstOwner,
    moveInDate: input.moveInDate ? new Date(String(input.moveInDate)) : existing?.moveInDate ?? new Date(),
    moveOutDate: input.moveOutDate ? new Date(String(input.moveOutDate)) : null,
    emergencyContactName: input.emergencyContactName ?? null,
    emergencyContactPhone: input.emergencyContactPhone ? normalisePhone(String(input.emergencyContactPhone)) : null,
    emergencyContactRelation: input.emergencyContactRelation ?? null,
    occupation: input.occupation ?? null,
    bloodGroup: input.bloodGroup ?? null,
    idProofType: input.idProofType ?? null,
    idProofNumber: input.idProofNumber ?? null,
    ownerName: input.ownerName ?? null,
    leaseStartDate: input.leaseStartDate ? new Date(String(input.leaseStartDate)) : null,
    leaseEndDate: input.leaseEndDate ? new Date(String(input.leaseEndDate)) : null,
    rentAmount: input.rentAmount ?? null,
    status: 'ACTIVE',
    isActive: true,
    tags: input.tags ?? existing?.tags ?? [],
    updatedBy: ctx.actorId,
  };

  let resident: Document;
  if (existing) {
    await ctx.db.collection('residents').updateOne({ _id: existing._id }, { $set: fields });
    resident = { ...existing, ...fields };
  } else {
    resident = await ctx.db.collection('residents').create({
      _id: newId('residents'),
      societyId: ctx.societyId,
      ...fields,
      createdBy: ctx.actorId,
    });
  }

  if (input.createLogin !== false) {
    const user = await ensureResidentUser(ctx, {
      residentId: String(resident._id),
      unitId: String(unit._id),
      fullName,
      phone,
      email,
      kind,
      isPrimary: Boolean(fields.isPrimary),
      password: input.password ?? null,
    });
    await ctx.db.collection('residents').updateOne({ _id: resident._id }, { $set: { userId: user._id } });
    resident.userId = user._id;
  }

  await refreshUnitCounters(ctx, String(unit._id));
  return resident;
}

/**
 * Create or upgrade the `users` account for a resident and register it in the cross-society
 * login directory so OTP/password login resolves to this society.
 */
export async function ensureResidentUser(
  ctx: ResidentsContext,
  input: {
    residentId: string;
    unitId: string;
    fullName: string;
    phone: string | null;
    email: string | null;
    kind: MemberKind;
    isPrimary?: boolean;
    password?: string | null;
  },
): Promise<Document> {
  if (!input.phone && !input.email) throw ApiError.badRequest('A phone number or email is required to create a login');

  const role = MEMBER_ROLE[input.kind] ?? 'RESIDENT';
  const platform = await databases.platform();
  const society = await platform.collection('societies').findById(ctx.societyId);

  let user = await ctx.db.collection('users').findOne({
    societyId: ctx.societyId,
    ...(input.phone ? { phone: input.phone } : { email: input.email }),
  });

  if (user) {
    const roles = Array.from(new Set([...((user.roles as string[]) ?? []), role]));
    const patch: Document = { roles, updatedAt: new Date() };
    if (input.password) patch.passwordHash = await hashPassword(input.password);
    if (!user.fullName) patch.fullName = input.fullName;
    if (input.email && !user.email) patch.email = input.email;
    if (input.phone && !user.phone) patch.phone = input.phone;
    await ctx.db.collection('users').updateOne({ _id: user._id }, { $set: patch });
    user = { ...user, ...patch };
  } else {
    user = await ctx.db.collection('users').create({
      _id: newId('users'),
      societyId: ctx.societyId,
      fullName: input.fullName,
      phone: input.phone,
      email: input.email,
      passwordHash: input.password ? await hashPassword(input.password) : null,
      roles: [role],
      status: 'ACTIVE',
      isActive: true,
      isVerified: false,
      mustChangePassword: false,
      avatarUrl: null,
      gender: null,
      dateOfBirth: null,
      lastLoginAt: null,
      failedLoginCount: 0,
      lockedUntil: null,
      pushTokens: [],
      preferences: {},
      createdSource: 'resident-import',
      createdBy: ctx.actorId,
      updatedBy: ctx.actorId,
    });
  }

  // `unit_members` is what authorises this account for a specific flat.
  const existingLink = await ctx.db.collection('unit_members').findOne({
    societyId: ctx.societyId,
    unitId: input.unitId,
    residentId: input.residentId,
  });
  const permissions = defaultPermissions(input.kind);
  if (existingLink) {
    await ctx.db.collection('unit_members').updateOne(
      { _id: existingLink._id },
      { $set: { kind: input.kind, userId: user._id, isActive: true, isPrimary: Boolean(input.isPrimary), permissions } },
    );
  } else {
    await ctx.db.collection('unit_members').create({
      _id: newId('unit_members'),
      societyId: ctx.societyId,
      unitId: input.unitId,
      residentId: input.residentId,
      userId: user._id,
      kind: input.kind,
      isPrimary: Boolean(input.isPrimary),
      moveInDate: new Date(),
      moveOutDate: null,
      isActive: true,
      permissions,
      createdBy: ctx.actorId,
      updatedBy: ctx.actorId,
    });
  }

  await upsertMembership({
    societyId: ctx.societyId,
    societyName: String(society?.name ?? ''),
    societySlug: String(society?.slug ?? ''),
    userId: String(user._id),
    phone: input.phone,
    email: input.email,
    roles: (user.roles as string[]) ?? [role],
    unitIds: await unitIdsForUser(ctx, String(user._id)),
    status: 'ACTIVE',
    isActive: true,
  });

  return user;
}

export async function unitIdsForUser(ctx: ResidentsContext, userId: string): Promise<string[]> {
  const links = await ctx.db.collection('unit_members').find({ societyId: ctx.societyId, userId, isActive: true }, { limit: 20 });
  return Array.from(new Set(links.map((l) => String(l.unitId))));
}

/**
 * Effective capabilities for the caller inside one unit (§9, §51).
 *
 * Resolved server-side from `unit_members.permissions` — never from the client — and merged
 * with any family-member overrides, so a resident cannot grant themselves visitor approval by
 * editing a request body.
 */
export async function effectivePermissions(
  ctx: ResidentsContext,
  input: { unitId: string; userId?: string | null; residentId?: string | null },
): Promise<Document> {
  const link = await ctx.db.collection('unit_members').findOne({
    societyId: ctx.societyId,
    unitId: input.unitId,
    isActive: true,
    ...(input.residentId ? { residentId: input.residentId } : input.userId ? { userId: input.userId } : {}),
  });
  if (!link) return defaultPermissions('FAMILY');
  return { ...defaultPermissions(link.kind as MemberKind), ...((link.permissions ?? {}) as Document) };
}

/* ------------------------------ family members ------------------------------ */

export interface AddFamilyInput extends Document {
  /** The resident who is adding this member. Resolved from membership for resident callers. */
  parentResidentId: string;
  fullName: string;
  relationship: string;
  canLogin?: boolean;
  password?: string | null;
}

export async function addFamilyMember(ctx: ResidentsContext, input: AddFamilyInput): Promise<Document> {
  const parent = await ctx.db.collection('residents').findOne({ societyId: ctx.societyId, _id: input.parentResidentId });
  if (!parent) throw ApiError.notFound('Resident');

  const phone = input.phone ? normalisePhone(String(input.phone)) : null;
  const email = input.email ? String(input.email).toLowerCase().trim() : null;
  const fullName = formatPersonName(String(input.fullName ?? ''));
  if (!fullName) throw ApiError.badRequest('A name is required');

  const duplicate = await ctx.db.collection('family_members').findOne({
    societyId: ctx.societyId,
    parentResidentId: parent._id,
    ...(phone ? { phone } : { fullName, relationship: input.relationship }),
    isActive: true,
  });
  if (duplicate) throw ApiError.duplicate('That family member has already been added');

  const permissions = { ...defaultPermissions('FAMILY'), ...((input.permissions ?? {}) as Document) };

  const doc = await ctx.db.collection('family_members').create({
    _id: newId('family_members'),
    societyId: ctx.societyId,
    parentResidentId: parent._id,
    unitId: parent.unitId,
    userId: null,
    fullName,
    relationship: String(input.relationship ?? 'OTHER').toUpperCase(),
    phone,
    email,
    age: input.age ?? null,
    dateOfBirth: input.dateOfBirth ? new Date(String(input.dateOfBirth)) : null,
    gender: input.gender ?? null,
    photoUrl: input.photoUrl ?? null,
    emergencyContactName: input.emergencyContactName ?? null,
    emergencyContactPhone: input.emergencyContactPhone ? normalisePhone(String(input.emergencyContactPhone)) : null,
    permissions,
    canLogin: Boolean(input.canLogin ?? false),
    isActive: true,
    createdBy: ctx.actorId,
    updatedBy: ctx.actorId,
  });

  // A family member who is allowed to log in gets a restricted resident account. The
  // permissions object above is copied onto `unit_members`, which is the only place the
  // middleware reads capabilities from.
  if (doc.canLogin && (phone || email)) {
    const resident = await createResident(ctx, {
      unitId: String(parent.unitId),
      fullName,
      phone,
      email,
      kind: 'FAMILY',
      isPrimary: false,
      moveInDate: new Date(),
      gender: input.gender ?? null,
      dateOfBirth: input.dateOfBirth ?? null,
      password: input.password ?? null,
    });
    await ctx.db.collection('unit_members').updateOne(
      { societyId: ctx.societyId, residentId: resident._id },
      { $set: { permissions } },
    );
    await ctx.db.collection('family_members').updateOne({ _id: doc._id }, { $set: { userId: resident.userId ?? null } });
    doc.userId = resident.userId ?? null;
  }

  await refreshUnitCounters(ctx, String(parent.unitId));
  return doc;
}

/** Update a family member's capabilities (§9 — "permissions are configurable per member"). */
export async function updateFamilyPermissions(
  ctx: ResidentsContext,
  familyMemberId: string,
  patch: Document,
): Promise<Document> {
  const member = await ctx.db.collection('family_members').findOne({ societyId: ctx.societyId, _id: familyMemberId });
  if (!member) throw ApiError.notFound('Family member');

  const merged = { ...((member.permissions ?? {}) as Document), ...patch };
  await ctx.db.collection('family_members').updateOne(
    { _id: familyMemberId },
    { $set: { permissions: merged, updatedBy: ctx.actorId } },
  );

  // Mirror onto the linked unit membership, which is what authorisation actually reads.
  if (member.userId) {
    await ctx.db.collection('unit_members').updateOne(
      { societyId: ctx.societyId, userId: member.userId, unitId: member.unitId, isActive: true },
      { $set: { permissions: merged } },
    );
  }
  return { ...member, permissions: merged };
}

export async function removeFamilyMember(ctx: ResidentsContext, familyMemberId: string): Promise<Document> {
  const member = await ctx.db.collection('family_members').findOne({ societyId: ctx.societyId, _id: familyMemberId });
  if (!member) throw ApiError.notFound('Family member');

  await ctx.db.collection('family_members').updateOne(
    { _id: familyMemberId },
    { $set: { isActive: false, deletedAt: new Date(), updatedBy: ctx.actorId } },
  );
  if (member.userId) {
    await ctx.db.collection('unit_members').updateMany(
      { societyId: ctx.societyId, userId: member.userId, unitId: member.unitId },
      { $set: { isActive: false, moveOutDate: new Date() } },
    );
    const remaining = await ctx.db.collection('unit_members').countDocuments({ societyId: ctx.societyId, userId: member.userId, isActive: true });
    if (remaining === 0) await ctx.db.collection('users').updateOne({ _id: member.userId }, { $set: { isActive: false, status: 'INACTIVE' } });
  }
  await refreshUnitCounters(ctx, String(member.unitId));
  return { familyMemberId, removed: true };
}

/* --------------------------------- vehicles --------------------------------- */

export interface AddVehicleInput extends Document {
  unitId: string;
  vehicleNumber: string;
  type?: string;
  residentId?: string | null;
}

export function normaliseVehicleNumber(raw: string): string {
  return String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export async function addVehicle(ctx: ResidentsContext, input: AddVehicleInput): Promise<Document> {
  const unit = await ctx.db.collection('units').findOne({ societyId: ctx.societyId, _id: input.unitId });
  if (!unit) throw ApiError.notFound('Unit');

  const displayNumber = String(input.vehicleNumber ?? '').trim().toUpperCase();
  const vehicleNumber = normaliseVehicleNumber(displayNumber);
  if (!/^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{3,4}$/.test(vehicleNumber) && vehicleNumber.length < 6) {
    throw ApiError.badRequest('Enter a valid vehicle number, for example MH31AB1234');
  }

  const existing = await ctx.db.collection('vehicles').findOne({ societyId: ctx.societyId, vehicleNumber });
  if (existing && String(existing.unitId) !== String(unit._id)) {
    throw ApiError.duplicate(`${displayNumber} is already registered to another flat`);
  }

  const fields: Document = {
    displayNumber,
    vehicleNumber,
    type: String(input.type ?? 'CAR').toUpperCase(),
    brand: input.brand ?? null,
    model: input.model ?? null,
    color: input.color ?? null,
    year: input.year ?? null,
    unitId: unit._id,
    residentId: input.residentId ?? null,
    staffId: input.staffId ?? null,
    parkingSlotId: input.parkingSlotId ?? null,
    isEv: Boolean(input.isEv ?? ['EV_CAR', 'EV_BIKE'].includes(String(input.type ?? '').toUpperCase())),
    stickerNumber: input.stickerNumber ?? null,
    insuranceExpiry: input.insuranceExpiry ? new Date(String(input.insuranceExpiry)) : null,
    rcExpiry: input.rcExpiry ? new Date(String(input.rcExpiry)) : null,
    isPrimary: Boolean(input.isPrimary),
    isActive: true,
    updatedBy: ctx.actorId,
  };

  let vehicle: Document;
  if (existing) {
    await ctx.db.collection('vehicles').updateOne({ _id: existing._id }, { $set: fields });
    vehicle = { ...existing, ...fields };
  } else {
    vehicle = await ctx.db.collection('vehicles').create({
      _id: newId('vehicles'),
      societyId: ctx.societyId,
      ...fields,
      createdBy: ctx.actorId,
    });
  }

  if (vehicle.parkingSlotId) await assignParkingSlot(ctx, String(vehicle.parkingSlotId), { vehicleId: String(vehicle._id), unitId: String(unit._id) });
  await refreshUnitCounters(ctx, String(unit._id));
  return vehicle;
}

/**
 * Verify a vehicle number at the gate (§19).
 *
 * Returns the flat and resident so the guard sees "MH31AB1234 → A-1203, Tower A" instead of
 * having to look anything up. Unknown plates come back `found: false` and the guard records
 * them as a visitor vehicle instead. Matching ignores spaces and dashes because plates are
 * typed by hand at the gate.
 */
export async function verifyVehicle(ctx: ResidentsContext, rawNumber: string): Promise<Document> {
  const target = normaliseVehicleNumber(rawNumber);
  if (!target) return { found: false, vehicleNumber: rawNumber };

  const vehicles = await ctx.db.collection('vehicles').find({ societyId: ctx.societyId, isActive: true }, { limit: 10_000 });
  const match =
    vehicles.find((v) => normaliseVehicleNumber(String(v.vehicleNumber)) === target) ??
    vehicles.find((v) => normaliseVehicleNumber(String(v.displayNumber ?? '')) === target);
  if (!match) return { found: false, vehicleNumber: rawNumber };

  const [unit, resident, staff] = await Promise.all([
    ctx.db.collection('units').findOne({ societyId: ctx.societyId, _id: match.unitId }),
    match.residentId ? ctx.db.collection('residents').findOne({ societyId: ctx.societyId, _id: match.residentId }) : null,
    match.staffId ? ctx.db.collection('staff').findOne({ societyId: ctx.societyId, _id: match.staffId }) : null,
  ]);
  const building = unit ? await ctx.db.collection('buildings').findOne({ societyId: ctx.societyId, _id: unit.buildingId }) : null;

  return {
    found: true,
    vehicle: {
      id: match._id,
      vehicleNumber: match.displayNumber ?? match.vehicleNumber,
      type: match.type,
      brand: match.brand,
      model: match.model,
      color: match.color,
      isEv: Boolean(match.isEv),
      stickerNumber: match.stickerNumber ?? null,
    },
    unit: unit ? { id: unit._id, label: unit.label, unitNumber: unit.unitNumber, building: building?.name ?? null } : null,
    resident: resident ? { id: resident._id, fullName: resident.fullName, kind: resident.kind, phone: resident.phone } : null,
    staff: staff ? { id: staff._id, fullName: staff.fullName, role: staff.role } : null,
    isStaffVehicle: Boolean(match.staffId),
  };
}

/* ------------------------------- parking slots ------------------------------ */

export async function assignParkingSlot(
  ctx: ResidentsContext,
  slotId: string,
  target: { vehicleId?: string | null; unitId?: string | null; fromDate?: string | Date | null; tillDate?: string | Date | null },
): Promise<Document> {
  const slot = await ctx.db.collection('parking_slots').findOne({ societyId: ctx.societyId, _id: slotId });
  if (!slot) throw ApiError.notFound('Parking slot');
  if (slot.status === 'OCCUPIED' && slot.assignedVehicleId && target.vehicleId && String(slot.assignedVehicleId) !== String(target.vehicleId)) {
    throw ApiError.conflict(`Slot ${slot.slotNumber} is already allotted to another vehicle`);
  }

  await ctx.db.collection('parking_slots').updateOne(
    { _id: slotId },
    {
      $set: {
        assignedVehicleId: target.vehicleId ?? null,
        assignedUnitId: target.unitId ?? slot.assignedUnitId ?? null,
        status: 'OCCUPIED',
        assignedFrom: target.fromDate ? new Date(target.fromDate as string) : slot.assignedFrom ?? new Date(),
        assignedTill: target.tillDate ? new Date(target.tillDate as string) : null,
        updatedBy: ctx.actorId,
      },
    },
  );

  if (target.vehicleId) {
    await ctx.db.collection('vehicles').updateOne({ societyId: ctx.societyId, _id: target.vehicleId }, { $set: { parkingSlotId: slotId } });
  }
  if (target.unitId) {
    const unit = await ctx.db.collection('units').findOne({ societyId: ctx.societyId, _id: target.unitId });
    const slots = Array.from(new Set([...((unit?.parkingSlotIds as string[]) ?? []), slotId]));
    await ctx.db.collection('units').updateOne({ _id: target.unitId }, { $set: { parkingSlotIds: slots } });
  }
  return { slotId, status: 'OCCUPIED', assignedVehicleId: target.vehicleId ?? null, assignedUnitId: target.unitId ?? null };
}

export async function releaseParkingSlot(ctx: ResidentsContext, slotId: string): Promise<Document> {
  const slot = await ctx.db.collection('parking_slots').findOne({ societyId: ctx.societyId, _id: slotId });
  if (!slot) throw ApiError.notFound('Parking slot');

  await ctx.db.collection('parking_slots').updateOne(
    { _id: slotId },
    { $set: { assignedVehicleId: null, assignedUnitId: null, status: 'AVAILABLE', assignedTill: new Date(), updatedBy: ctx.actorId } },
  );
  if (slot.assignedVehicleId) {
    await ctx.db.collection('vehicles').updateOne({ societyId: ctx.societyId, _id: slot.assignedVehicleId }, { $set: { parkingSlotId: null } });
  }
  if (slot.assignedUnitId) {
    const unit = await ctx.db.collection('units').findOne({ societyId: ctx.societyId, _id: slot.assignedUnitId });
    const slots = ((unit?.parkingSlotIds as string[]) ?? []).filter((s) => String(s) !== slotId);
    await ctx.db.collection('units').updateOne({ _id: slot.assignedUnitId }, { $set: { parkingSlotIds: slots } });
  }
  return { slotId, status: 'AVAILABLE' };
}

/* --------------------------------- move out --------------------------------- */

/**
 * Move a resident out (§12).
 *
 * Never deletes history — the resident, their visits and their bills stay for audit — but the
 * login account loses access to the unit immediately, so a former tenant cannot raise visitor
 * passes for a flat they no longer occupy.
 */
export async function moveOutResident(
  ctx: ResidentsContext,
  residentId: string,
  input: { moveOutDate?: string | Date; reason?: string; deactivateLogin?: boolean },
): Promise<Document> {
  const resident = await ctx.db.collection('residents').findOne({ societyId: ctx.societyId, _id: residentId });
  if (!resident) throw ApiError.notFound('Resident');

  const moveOutDate = input.moveOutDate ? new Date(input.moveOutDate as string) : new Date();

  await ctx.db.collection('residents').updateOne(
    { _id: residentId },
    { $set: { status: 'MOVED_OUT', moveOutDate, isActive: false, isPrimary: false, updatedBy: ctx.actorId } },
  );
  await ctx.db.collection('family_members').updateMany(
    { societyId: ctx.societyId, parentResidentId: residentId },
    { $set: { isActive: false } },
  );
  await ctx.db.collection('unit_members').updateMany(
    { societyId: ctx.societyId, residentId },
    { $set: { isActive: false, moveOutDate } },
  );
  await ctx.db.collection('vehicles').updateMany({ societyId: ctx.societyId, residentId }, { $set: { isActive: false } });

  const slots = await ctx.db.collection('parking_slots').find({ societyId: ctx.societyId, assignedUnitId: resident.unitId }, { limit: 50 });
  for (const slot of slots) await releaseParkingSlot(ctx, String(slot._id));

  if (input.deactivateLogin !== false && resident.userId) {
    const remaining = await ctx.db.collection('unit_members').countDocuments({
      societyId: ctx.societyId,
      userId: resident.userId,
      isActive: true,
    });
    if (remaining === 0) {
      await ctx.db.collection('users').updateOne({ _id: resident.userId }, { $set: { isActive: false, status: 'INACTIVE' } });
      const platform = await databases.platform();
      const society = await platform.collection('societies').findById(ctx.societyId);
      await upsertMembership({
        societyId: ctx.societyId,
        societyName: String(society?.name ?? ''),
        societySlug: String(society?.slug ?? ''),
        userId: String(resident.userId),
        roles: [],
        unitIds: [],
        status: 'MOVED_OUT',
        isActive: false,
      });
    }
  }

  await refreshUnitCounters(ctx, String(resident.unitId));
  logger.info({ societyId: ctx.societyId, residentId }, 'resident moved out');
  return { residentId, status: 'MOVED_OUT', moveOutDate, reason: input.reason ?? null };
}

/** Move a resident (or a whole household) to another unit — §12 "transfer within society". */
export async function transferResident(
  ctx: ResidentsContext,
  residentId: string,
  input: { toUnitId: string; moveDate?: string | Date; kind?: MemberKind },
): Promise<Document> {
  const resident = await ctx.db.collection('residents').findOne({ societyId: ctx.societyId, _id: residentId });
  if (!resident) throw ApiError.notFound('Resident');
  const toUnit = await ctx.db.collection('units').findOne({ societyId: ctx.societyId, _id: input.toUnitId });
  if (!toUnit) throw ApiError.notFound('Target unit');
  if (String(toUnit._id) === String(resident.unitId)) throw ApiError.badRequest('The resident already lives in that unit');

  const moveDate = input.moveDate ? new Date(input.moveDate as string) : new Date();
  const fromUnitId = String(resident.unitId);

  await ctx.db.collection('residents').updateOne({ _id: residentId }, { $set: { unitId: toUnit._id, updatedBy: ctx.actorId } });
  await ctx.db.collection('unit_members').updateMany(
    { societyId: ctx.societyId, residentId },
    { $set: { unitId: toUnit._id, moveInDate: moveDate } },
  );
  await ctx.db.collection('family_members').updateMany({ societyId: ctx.societyId, parentResidentId: residentId }, { $set: { unitId: toUnit._id } });
  await ctx.db.collection('vehicles').updateMany({ societyId: ctx.societyId, residentId }, { $set: { unitId: toUnit._id, parkingSlotId: null } });

  const slots = await ctx.db.collection('parking_slots').find({ societyId: ctx.societyId, assignedUnitId: fromUnitId }, { limit: 50 });
  for (const slot of slots) await releaseParkingSlot(ctx, String(slot._id));

  if (resident.userId) {
    await upsertMembership({
      societyId: ctx.societyId,
      societyName: '',
      societySlug: '',
      userId: String(resident.userId),
      roles: (await ctx.db.collection('users').findById(String(resident.userId)))?.roles as string[] ?? [],
      unitIds: await unitIdsForUser(ctx, String(resident.userId)),
      status: 'ACTIVE',
      isActive: true,
    });
  }

  await Promise.all([refreshUnitCounters(ctx, fromUnitId), refreshUnitCounters(ctx, String(toUnit._id))]);
  return { residentId, fromUnitId, toUnitId: String(toUnit._id), moveDate };
}

/* -------------------------------- CSV import -------------------------------- */

export const RESIDENT_CSV_ALIASES: Record<string, string[]> = {
  fullName: ['name', 'resident_name', 'member_name', 'full_name'],
  phone: ['mobile', 'mobile_number', 'contact', 'phone_number', 'contact_number'],
  email: ['email_id', 'mail'],
  building: ['tower', 'block', 'building_name'],
  wing: ['wing_name', 'wing_code'],
  unitNumber: ['flat', 'flat_no', 'flat_number', 'unit', 'unit_no', 'house_no'],
  kind: ['type', 'resident_type', 'owner_tenant', 'category', 'occupancy'],
  moveInDate: ['move_in', 'move_in_date', 'from_date', 'possession_date'],
  gender: ['sex'],
  dateOfBirth: ['dob', 'birth_date'],
  occupation: ['profession'],
  vehicleNumber: ['vehicle', 'car_number', 'vehicle_no', 'vehicle_registration'],
  vehicleType: ['vehicle_type'],
};

export interface ImportResidentsResult {
  created: number;
  updated: number;
  vehiclesCreated: number;
  skipped: number;
  errors: Array<{ row: number; message: string }>;
}

export async function importResidentsFromCsv(
  ctx: ResidentsContext,
  csv: string,
  opts: { dryRun?: boolean } = {},
): Promise<ImportResidentsResult> {
  const { parseCsv } = await import('../../utils/csv.js');
  const parsed = parseCsv(csv, { aliases: RESIDENT_CSV_ALIASES, maxRows: 20_000 });
  const result: ImportResidentsResult = { created: 0, updated: 0, vehiclesCreated: 0, skipped: 0, errors: [...parsed.errors] };
  if (parsed.rows.length === 0) {
    result.errors.push({ row: 0, message: 'No data rows found. Expected at least `name`, `mobile` and `flat_no` columns.' });
    return result;
  }

  const [buildings, wings, units] = await Promise.all([
    ctx.db.collection('buildings').find({ societyId: ctx.societyId }, { limit: 500 }),
    ctx.db.collection('wings').find({ societyId: ctx.societyId }, { limit: 5_000 }),
    ctx.db.collection('units').find({ societyId: ctx.societyId }, { limit: 100_000 }),
  ]);

  const buildingByName = new Map<string, Document>();
  for (const b of buildings) {
    buildingByName.set(String(b.name).toUpperCase(), b);
    buildingByName.set(String(b.code).toUpperCase(), b);
  }
  const unitByKey = new Map<string, Document>();
  const unitByNumber = new Map<string, Document>();
  for (const u of units) {
    unitByKey.set(`${u.buildingId}|${u.wingId ?? ''}|${String(u.unitNumber).toUpperCase()}`, u);
    if (!unitByNumber.has(String(u.unitNumber).toUpperCase())) unitByNumber.set(String(u.unitNumber).toUpperCase(), u);
  }

  for (let i = 0; i < parsed.rows.length; i += 1) {
    const row = parsed.rows[i] as Record<string, string>;
    const rowNumber = i + 2;
    try {
      const fullName = String(row.fullName ?? '').trim();
      const unitNumber = String(row.unitNumber ?? '').trim().toUpperCase();
      if (!fullName) {
        result.errors.push({ row: rowNumber, message: 'Missing resident name' });
        result.skipped += 1;
        continue;
      }
      if (!unitNumber) {
        result.errors.push({ row: rowNumber, message: `Missing flat/unit number for ${fullName}` });
        result.skipped += 1;
        continue;
      }

      let unit: Document | undefined;
      const buildingName = String(row.building ?? '').trim();
      if (buildingName) {
        const building = buildingByName.get(buildingName.toUpperCase());
        if (!building) {
          result.errors.push({ row: rowNumber, message: `Unknown building/tower "${buildingName}" — create the structure first` });
          result.skipped += 1;
          continue;
        }
        const wingName = String(row.wing ?? '').trim().toUpperCase();
        const wing = wingName
          ? wings.find((w) => String(w.buildingId) === String(building._id) && String(w.code).toUpperCase() === wingName)
          : null;
        if (wingName && !wing) {
          result.errors.push({ row: rowNumber, message: `Unknown wing "${wingName}" in ${buildingName}` });
          result.skipped += 1;
          continue;
        }
        unit = unitByKey.get(`${building._id}|${wing?._id ?? ''}|${unitNumber}`);
      } else {
        unit = unitByNumber.get(unitNumber);
      }
      if (!unit) {
        result.errors.push({ row: rowNumber, message: `Unit "${unitNumber}" does not exist — create the structure first` });
        result.skipped += 1;
        continue;
      }

      const phone = row.phone ? normalisePhone(row.phone) : null;
      const email = row.email ? row.email.toLowerCase().trim() : null;
      if (!phone && !email) {
        result.errors.push({ row: rowNumber, message: `${fullName} has no phone or email — a login cannot be created` });
        result.skipped += 1;
        continue;
      }

      const rawKind = String(row.kind ?? '').trim().toUpperCase();
      const kind: MemberKind = (['OWNER', 'TENANT', 'FAMILY', 'COMPANY_GUEST'].includes(rawKind) ? rawKind : 'OWNER') as MemberKind;
      const isUpdate = Boolean(phone && (await ctx.db.collection('residents').findOne({ societyId: ctx.societyId, unitId: unit._id, phone })));

      if (!opts.dryRun) {
        const resident = await createResident(ctx, {
          unitId: String(unit._id),
          fullName,
          phone,
          email,
          kind,
          moveInDate: row.moveInDate || null,
          gender: row.gender ? row.gender.toUpperCase() : null,
          dateOfBirth: row.dateOfBirth || null,
          occupation: row.occupation || null,
        });

        const vehicleNumber = String(row.vehicleNumber ?? '').trim();
        if (vehicleNumber) {
          try {
            await addVehicle(ctx, {
              unitId: String(unit._id),
              residentId: String(resident._id),
              vehicleNumber,
              type: String(row.vehicleType ?? 'CAR').toUpperCase(),
              isPrimary: true,
            });
            result.vehiclesCreated += 1;
          } catch (err) {
            result.errors.push({ row: rowNumber, message: `Resident imported, vehicle failed: ${(err as Error).message}` });
          }
        }
      }

      if (isUpdate) result.updated += 1;
      else result.created += 1;
    } catch (err) {
      result.errors.push({ row: rowNumber, message: (err as Error).message });
      result.skipped += 1;
    }
  }

  return result;
}
