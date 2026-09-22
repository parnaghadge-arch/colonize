import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { databases } from '../../src/db/manager.js';
import { newId } from '../../src/db/ids.js';
import {
  SOCIETY_ADMIN_ROLES,
  activateSociety,
  createSociety,
  createSocietyAdmin,
  provisionSocietyDatabase,
  setSocietyStatus,
  type SocietiesContext,
} from '../../src/modules/societies/societiesService.js';
import type { StructureContext } from '../../src/modules/structure/structureService.js';
import { loadSocietyById, loadSocietyBySlug } from '../../src/middleware/authenticate.js';
import { findByIdentifier } from '../../src/services/identityDirectory.js';
import { hashPassword } from '../../src/services/crypto.js';
import { loginWithPassword } from '../../src/modules/auth/authService.js';

/**
 * Society lifecycle: create → provision → administrator → activate → suspend → reinstate.
 *
 * These tests pin three defects that each made the onboarding path a dead end rather than a
 * feature. None of them were visible from a single route in isolation, which is why they are
 * exercised here as a sequence:
 *
 *  1. **Activation deadlock.** `activateSociety` required at least one *already active* user, but
 *     the onboarding wizard creates the first administrator PENDING and relies on activation to
 *     flip them. Every society created through the panel was therefore permanently unactivatable.
 *  2. **Login directory gating.** Sign-in resolves identifiers through the platform identity
 *     directory, not the tenant `users` collection. The entry is registered resolvable at
 *     creation time — the USER's PENDING status is the real gate, and activation refreshes the
 *     entry. Registering the entry inactive until activation made pre-activation sign-in fail
 *     with a generic "Invalid credentials" and no hint of what was missing.
 *  3. **Unenforced suspension.** `authenticate` rejects a non-ACTIVE society on every request, but
 *     `invalidateSociety` dropped prefixes that did not match the keys `loadSocietyById` writes
 *     (`soc:id:<id>`, not `soc:<id>`), and status changes never invalidated at all — so a suspended
 *     society kept serving holders of a live token for up to the 60s TTL.
 */

let platform: SocietiesContext['platform'];
let ctx: SocietiesContext;

/** Create, provision and return a society with its tenant handle ready to use. */
async function newSociety(slugSeed: string, tier: 'FREE' | 'STANDARD' = 'FREE') {
  const society = await createSociety(ctx, {
    name: `Lifecycle ${slugSeed}`,
    slug: `lifecycle-${slugSeed}-${Date.now().toString(36)}`,
    city: 'Nagpur',
    tier,
  });
  await provisionSocietyDatabase(society);
  const db = await databases.tenantDb(String(society._id));
  return { society, id: String(society._id), db };
}

function structureCtx(id: string, db: StructureContext['db']): StructureContext {
  return { db, societyId: id, actorId: 'usr_platform_test' };
}

/** One unit is the minimum `activateSociety` will accept. */
async function seedUnit(societyId: string, db: StructureContext['db'], unitNumber = '101') {
  await db.collection('units').create({
    _id: newId('units'),
    societyId,
    buildingId: newId('buildings'),
    unitNumber,
    label: unitNumber,
  });
}

beforeEach(async () => {
  await databases.resetEmbedded();
  platform = await databases.platform();
  ctx = { platform, actorId: 'usr_platform_test', actorName: 'Lifecycle Test' };
});

afterAll(async () => {
  await databases.closeAll().catch(() => undefined);
});

describe('society activation', () => {
  it('activates a society whose only administrator is still PENDING', async () => {
    // This is the exact shape the panel produces: the first administrator is created inactive so
    // they cannot sign in to a half-built society, and activation is what brings them to life.
    const { id, db } = await newSociety('pending-admin');
    await createSocietyAdmin(
      structureCtx(id, db),
      { fullName: 'First Admin', email: 'first@lifecycle.test', password: 'Lifecycle@1234', roles: ['SOCIETY_ADMIN'] },
      { activate: false },
    );
    await seedUnit(id, db);

    const before = await db.collection('users').findOne({ societyId: id });
    expect(before?.status).toBe('PENDING');
    expect(before?.isActive).toBe(false);

    const result = await activateSociety(ctx, id);
    expect(result.status).toBe('ACTIVE');
    expect(result.admins).toBe(1);

    const after = await db.collection('users').findOne({ societyId: id });
    expect(after?.status).toBe('ACTIVE');
    expect(after?.isActive).toBe(true);
  });

  it('still refuses to activate a society with no units', async () => {
    const { id, db } = await newSociety('no-units');
    await createSocietyAdmin(structureCtx(id, db), { fullName: 'A', email: 'a@lifecycle.test', password: 'Lifecycle@1234' });

    await expect(activateSociety(ctx, id)).rejects.toThrow(/at least one unit/i);
  });

  it('refuses a user who holds no administrative role', async () => {
    // The old guard counted every active user, so a society full of residents and no administrator
    // would have passed it. The guard has to mean "somebody can administer this society".
    const { id, db } = await newSociety('non-admin');
    await db.collection('users').create({
      _id: newId('users'),
      societyId: id,
      fullName: 'Only A Resident',
      email: 'resident@lifecycle.test',
      roles: ['OWNER'],
      status: 'ACTIVE',
      isActive: true,
      passwordHash: await hashPassword('Lifecycle@1234'),
    });
    await seedUnit(id, db);

    await expect(activateSociety(ctx, id)).rejects.toThrow(/at least one administrator/i);
  });

  it('activates pending administrators only, leaving other pending users alone', async () => {
    const { id, db } = await newSociety('scoped-flip');
    await createSocietyAdmin(structureCtx(id, db), { fullName: 'Admin', email: 'admin@lifecycle.test', password: 'Lifecycle@1234' }, { activate: false });
    await db.collection('users').create({
      _id: newId('users'),
      societyId: id,
      fullName: 'Invited Resident',
      email: 'invited@lifecycle.test',
      roles: ['FAMILY_MEMBER'],
      status: 'PENDING',
      isActive: false,
    });
    await seedUnit(id, db);

    await activateSociety(ctx, id);

    const admin = await db.collection('users').findOne({ societyId: id, email: 'admin@lifecycle.test' });
    const resident = await db.collection('users').findOne({ societyId: id, email: 'invited@lifecycle.test' });
    expect(admin?.status).toBe('ACTIVE');
    expect(resident?.status).toBe('PENDING');
  });

  it('makes the new administrator resolvable through the login directory', async () => {
    // Sign-in looks the identifier up in the platform directory. The entry must be registered —
    // and resolvable — the moment the administrator is created: the USER's PENDING status is what
    // gates a half-built society, and the login endpoint is the only place that can explain WHY
    // sign-in fails. Hiding the membership until activation produced a generic "Invalid
    // credentials" with no hint of what the operator still had to do.
    const { id, db } = await newSociety('directory');
    const email = 'directory@lifecycle.test';
    const phone = '+919800001234';
    const device = { deviceId: 'test-device', platform: 'test' } as never;
    await createSocietyAdmin(
      structureCtx(id, db),
      { fullName: 'Directory Admin', email, phone, password: 'Lifecycle@1234', roles: ['SOCIETY_ADMIN'] },
      { activate: false },
    );
    await seedUnit(id, db);

    const early = await findByIdentifier(email);
    expect(early?.memberships?.find((m) => m.societyId === id)?.isActive).toBe(true);

    // Still blocked before activation — but the endpoint says why.
    await expect(loginWithPassword(email, 'Lifecycle@1234', device)).rejects.toMatchObject({
      code: 'SOCIETY_NOT_ACTIVATED',
    });

    await activateSociety(ctx, id);

    const byEmail = await findByIdentifier(email);
    const byPhone = await findByIdentifier(phone);
    expect(byEmail?.memberships?.find((m) => m.societyId === id)?.isActive).toBe(true);
    expect(byPhone?.memberships?.find((m) => m.societyId === id)?.isActive).toBe(true);

    // Activation flips the PENDING user to ACTIVE and the same credentials now sign in.
    const outcome = await loginWithPassword(email, 'Lifecycle@1234', device);
    expect(outcome.kind).toBe('success');
  });

  it('exposes the role list the activation guard and admin listing share', () => {
    expect(SOCIETY_ADMIN_ROLES).toContain('SOCIETY_ADMIN');
    // A role the platform does not define carries no permissions, so counting it toward "has an
    // administrator" would let a society activate with nobody able to run it.
    expect(SOCIETY_ADMIN_ROLES).not.toContain('MANAGING_COMMITTEE');
    expect(SOCIETY_ADMIN_ROLES).not.toContain('OWNER');
  });
});

describe('society status changes', () => {
  it('takes effect on the next authenticated request, not after the cache TTL', async () => {
    const { id, db } = await newSociety('suspend');
    await createSocietyAdmin(structureCtx(id, db), { fullName: 'A', email: 'a2@lifecycle.test', password: 'Lifecycle@1234' });
    await seedUnit(id, db);
    await activateSociety(ctx, id);

    // Warm the cache the way a live request would: this is the entry that used to survive.
    expect((await loadSocietyById(id))?.status).toBe('ACTIVE');

    await setSocietyStatus(ctx, id, 'SUSPENDED', 'non-payment');
    expect((await loadSocietyById(id))?.status).toBe('SUSPENDED');

    await setSocietyStatus(ctx, id, 'ACTIVE', 'paid');
    expect((await loadSocietyById(id))?.status).toBe('ACTIVE');
  });

  it('resolves the society by slug after a status change too', async () => {
    const { id, db, society } = await newSociety('slug-cache');
    await createSocietyAdmin(structureCtx(id, db), { fullName: 'A', email: 'a3@lifecycle.test', password: 'Lifecycle@1234' });
    await seedUnit(id, db);
    await activateSociety(ctx, id);

    const slug = String(society.slug);
    expect((await loadSocietyBySlug(slug))?.status).toBe('ACTIVE');

    await setSocietyStatus(ctx, id, 'SUSPENDED', 'probe');
    expect((await loadSocietyBySlug(slug))?.status).toBe('SUSPENDED');
  });

  it('rejects an unknown status and records the transition in the platform audit log', async () => {
    const { id } = await newSociety('audit');

    await expect(setSocietyStatus(ctx, id, 'DELETED')).rejects.toThrow(/invalid society status/i);

    await setSocietyStatus(ctx, id, 'SUSPENDED', 'probe');
    const logs = await platform
      .collection('platform_audit_logs')
      .find({ societyId: id, action: 'society.suspended' }, { limit: 5 });
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]?.severity).toBe('WARNING');
    expect(logs[0]?.newValue).toMatchObject({ status: 'SUSPENDED', reason: 'probe' });
  });
});

describe('administrator credentials', () => {
  it('reports mustChangePassword truthfully', async () => {
    // The create-society response used to hard-code `true`, telling an operator who had just set a
    // temporary password that the administrator still had none.
    const { id, db } = await newSociety('credential');
    const sctx = structureCtx(id, db);

    const withPassword = await createSocietyAdmin(sctx, {
      fullName: 'Has Password',
      email: 'has@lifecycle.test',
      password: 'Lifecycle@1234',
    });
    expect(Boolean(withPassword.mustChangePassword)).toBe(false);
    expect(withPassword.passwordHash).toBeTruthy();

    const withoutPassword = await createSocietyAdmin(sctx, {
      fullName: 'No Password',
      email: 'none@lifecycle.test',
    });
    expect(Boolean(withoutPassword.mustChangePassword)).toBe(true);
    expect(withoutPassword.passwordHash ?? null).toBeFalsy();
  });

  it('refuses an administrator with neither phone nor email', async () => {
    const { id, db } = await newSociety('no-contact');
    await expect(
      createSocietyAdmin(structureCtx(id, db), { fullName: 'Unreachable' }),
    ).rejects.toThrow(/phone number or an email/i);
  });
});
