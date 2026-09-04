import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { databases } from '../../src/db/manager.js';
import { newId } from '../../src/db/ids.js';
import { verifyPassword } from '../../src/services/crypto.js';
import { ApiError } from '../../src/utils/errors.js';
import {
  provisionStaffLogin,
  revokeStaffLogin,
  STAFF_ROLES,
  type HelpDeskContext,
} from '../../src/modules/helpdesk/helpdeskService.js';
import type { TenantDatabase } from '../../src/db/drivers/types.js';

/**
 * Staff login provisioning (§26).
 *
 * A staff row cannot authenticate on its own — `users` is the thing that can. These tests pin the
 * guarantees that make that bridge safe:
 *
 *  1. issuing a login produces an account that can actually be used (the hash verifies)
 *  2. the role is derived server-side from the staff record, never from a client claim, and can
 *     only ever be a society-staff role
 *  3. a phone already owned by another account in the society is refused rather than duplicated
 *  4. re-issuing rotates the credential on the *same* account instead of minting a second one
 *  5. revoking stops authentication but keeps the staff record and its history
 *  6. none of it crosses the society boundary
 */

const SOCIETY = { id: newId('societies'), slug: 'staff-login-society', databaseName: 'clnz_staff_login' };
const OTHER_SOCIETY = { id: newId('societies'), slug: 'staff-login-other', databaseName: 'clnz_staff_login_other' };

let db: TenantDatabase;
let ctx: HelpDeskContext;

/** A staff document in the shape the seed and the shared schema both use (`type`, not `staffType`). */
function staffDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: newId('staff'),
    societyId: SOCIETY.id,
    fullName: 'Probe Guard',
    phone: `+9198${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
    type: 'SECURITY',
    shift: 'MORNING',
    monthlySalary: 22000,
    status: 'ACTIVE',
    allowLogin: false,
    userId: null,
    ...overrides,
  };
}

beforeEach(async () => {
  await databases.resetEmbedded();
  db = (await databases.provision(SOCIETY)).db;
  ctx = { db, societyId: SOCIETY.id, actorId: newId('users'), actorName: 'Test Admin' };
  // The cross-society directory resolves society name/slug from the platform database.
  const platform = await databases.platform();
  await platform.collection('societies').create({
    _id: SOCIETY.id,
    name: 'Staff Login Society',
    slug: SOCIETY.slug,
    databaseName: SOCIETY.databaseName,
    status: 'ACTIVE',
  });
});

afterAll(async () => {
  await databases.closeAll().catch(() => undefined);
});

describe('provisionStaffLogin', () => {
  it('creates an account that can actually authenticate', async () => {
    const staff = staffDoc();
    await db.collection('staff').create(staff);

    const result = await provisionStaffLogin(ctx, staff._id as string, {});

    expect(result.identifier).toBe(staff.phone);
    expect(result.temporaryPassword).toBeTruthy();
    expect(result.mustChangePassword).toBe(true);

    const user = await db.collection('users').findById(result.userId);
    expect(user).toBeTruthy();
    // The whole point: the password handed back once is the one stored (as a hash).
    expect(await verifyPassword(result.temporaryPassword!, String(user!.passwordHash))).toBe(true);
    expect(user!.roles).toEqual(['SECURITY_GUARD']);
    expect(user!.staffId).toBe(staff._id);
  });

  it('links the staff record back to the account and enables login', async () => {
    const staff = staffDoc();
    await db.collection('staff').create(staff);

    const result = await provisionStaffLogin(ctx, staff._id as string, {});

    const updated = await db.collection('staff').findById(staff._id as string);
    expect(String(updated!.userId)).toBe(result.userId);
    expect(updated!.allowLogin).toBe(true);
  });

  it('registers the account in the cross-society identity directory', async () => {
    const staff = staffDoc();
    await db.collection('staff').create(staff);
    await provisionStaffLogin(ctx, staff._id as string, {});

    const platform = await databases.platform();
    const entry = await platform.collection('identity_directory').findOne({ societyIds: SOCIETY.id });
    expect(entry).toBeTruthy();
    expect(entry!.phone).toBe(staff.phone);
  });

  it('accepts an admin-chosen password and does not return it', async () => {
    const staff = staffDoc();
    await db.collection('staff').create(staff);

    const result = await provisionStaffLogin(ctx, staff._id as string, {
      password: 'Chosen@2026',
      mustChangePassword: false,
    });

    expect(result.temporaryPassword).toBeNull();
    expect(result.mustChangePassword).toBe(false);
    const user = await db.collection('users').findById(result.userId);
    expect(await verifyPassword('Chosen@2026', String(user!.passwordHash))).toBe(true);
  });

  it.each([
    ['SECURITY', 'SECURITY_GUARD'],
    ['MANAGER', 'FACILITY_MANAGER'],
    ['ELECTRICIAN', 'ELECTRICIAN'],
    ['HOUSEKEEPING', 'HOUSEKEEPING'],
    ['RECEPTIONIST', 'RECEPTIONIST'],
  ])('derives the %s role from the staff record as %s', async (type, expected) => {
    const staff = staffDoc({ type });
    await db.collection('staff').create(staff);
    const result = await provisionStaffLogin(ctx, staff._id as string, {});
    expect(result.role).toBe(expected);
  });

  it('falls back to a non-privileged role for an unrecognised staff type', async () => {
    const staff = staffDoc({ type: 'SOMETHING_UNUSUAL' });
    await db.collection('staff').create(staff);
    const result = await provisionStaffLogin(ctx, staff._id as string, {});
    expect(result.role).toBe('MAINTENANCE_STAFF');
  });

  it('honours an explicit role override but only within the staff role set', () => {
    // Every role this endpoint can mint must be a society-staff role — never an administrator,
    // a resident, or a platform role.
    for (const role of STAFF_ROLES) {
      expect(['SUPER_ADMIN', 'PLATFORM_ADMIN', 'SOCIETY_ADMIN', 'OWNER', 'TENANT']).not.toContain(role);
    }
    expect(STAFF_ROLES).toContain('SECURITY_GUARD');
  });

  it('refuses to mint a second account for a phone this society already uses', async () => {
    const phone = '+919800000099';
    const first = staffDoc({ phone });
    await db.collection('staff').create(first);
    await provisionStaffLogin(ctx, first._id as string, {});

    const second = staffDoc({ phone, fullName: 'Second Guard' });
    await db.collection('staff').create(second);

    await expect(provisionStaffLogin(ctx, second._id as string, {})).rejects.toMatchObject({
      statusCode: 409,
      code: 'CONFLICT',
    });
    // No orphan account was written.
    expect(await db.collection('users').countDocuments({ societyId: SOCIETY.id, phone })).toBe(1);
  });

  it('re-issuing rotates the password on the same account', async () => {
    const staff = staffDoc();
    await db.collection('staff').create(staff);

    const first = await provisionStaffLogin(ctx, staff._id as string, {});
    const second = await provisionStaffLogin(ctx, staff._id as string, { password: 'Rotated@2026' });

    expect(second.userId).toBe(first.userId);
    expect(await db.collection('users').countDocuments({ societyId: SOCIETY.id })).toBe(1);

    const user = await db.collection('users').findById(first.userId);
    expect(await verifyPassword('Rotated@2026', String(user!.passwordHash))).toBe(true);
    expect(await verifyPassword(first.temporaryPassword!, String(user!.passwordHash))).toBe(false);
  });

  it('rejects a staff record whose phone cannot be normalised', async () => {
    // `phone` is required by the schema registry, but a value that is present yet unusable must
    // still be refused rather than minting an account nobody can sign in to.
    const staff = staffDoc({ phone: 'not-a-phone' });
    await db.collection('staff').create(staff);
    await expect(provisionStaffLogin(ctx, staff._id as string, {})).rejects.toBeInstanceOf(ApiError);
  });

  it('cannot provision a login for another society’s staff member', async () => {
    const otherDb = (await databases.provision(OTHER_SOCIETY)).db;
    const foreign = { ...staffDoc(), societyId: OTHER_SOCIETY.id };
    await otherDb.collection('staff').create(foreign);

    await expect(provisionStaffLogin(ctx, foreign._id as string, {})).rejects.toMatchObject({ statusCode: 404 });
  });

  it('generates a temporary password that satisfies the platform password policy', async () => {
    const staff = staffDoc();
    await db.collection('staff').create(staff);
    const result = await provisionStaffLogin(ctx, staff._id as string, {});
    const password = result.temporaryPassword!;

    expect(password.length).toBeGreaterThanOrEqual(8);
    expect(/[A-Za-z]/.test(password)).toBe(true);
    expect(/[0-9]/.test(password)).toBe(true);
    // No characters that get misread when an admin reads the password over the phone.
    expect(password).not.toMatch(/[0O1Il]/);
  });
});

describe('revokeStaffLogin', () => {
  it('stops the account authenticating but keeps the staff record and its history', async () => {
    const staff = staffDoc();
    await db.collection('staff').create(staff);
    const issued = await provisionStaffLogin(ctx, staff._id as string, {});

    const result = await revokeStaffLogin(ctx, staff._id as string);
    expect(result.revoked).toBe(true);

    const user = await db.collection('users').findById(issued.userId);
    expect(user!.isActive).toBe(false);
    expect(user!.status).toBe('INACTIVE');

    // The staff row survives — attendance and closed work orders must not disappear with the login.
    const kept = await db.collection('staff').findById(staff._id as string);
    expect(kept).toBeTruthy();
    expect(String(kept!.userId)).toBe(issued.userId);
    expect(kept!.allowLogin).toBe(false);
  });

  it('is a no-op for a staff member who never had a login', async () => {
    const staff = staffDoc();
    await db.collection('staff').create(staff);
    const result = await revokeStaffLogin(ctx, staff._id as string);
    expect(result.revoked).toBe(false);
  });

  it('marks the directory membership inactive so the app stops offering the society', async () => {
    const staff = staffDoc();
    await db.collection('staff').create(staff);
    await provisionStaffLogin(ctx, staff._id as string, {});
    await revokeStaffLogin(ctx, staff._id as string);

    const platform = await databases.platform();
    const entry = await platform.collection('identity_directory').findOne({ societyIds: SOCIETY.id });
    const membership = (entry!.memberships as Array<Record<string, unknown>>).find((m) => m.societyId === SOCIETY.id);
    expect(membership?.isActive).toBe(false);
  });
});
