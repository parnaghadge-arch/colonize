import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { databases } from '../../src/db/manager.js';
import { newId } from '../../src/db/ids.js';
import {
  activateSociety,
  clearSocietyData,
  createSociety,
  createSocietyAdmin,
  deleteSociety,
  provisionSocietyDatabase,
  type SocietiesContext,
} from '../../src/modules/societies/societiesService.js';
import type { StructureContext } from '../../src/modules/structure/structureService.js';
import { findByIdentifier, upsertMembership } from '../../src/services/identityDirectory.js';
import { hashPassword } from '../../src/services/crypto.js';
import { loginWithPassword } from '../../src/modules/auth/authService.js';

/**
 * Super admin can wipe a society's operational data without taking away administrator
 * logins, or delete the society entirely. Both require the society name, so a mis-click
 * cannot do it.
 */

let ctx: SocietiesContext;

async function newSociety(slug: string, name = `Reset ${slug}`) {
  const society = await createSociety(ctx, {
    name,
    slug,
    city: 'Nagpur',
    tier: 'FREE',
  });
  await provisionSocietyDatabase(society);
  const id = String(society._id);
  const db = await databases.tenantDb(id);
  const structure: StructureContext = { db, societyId: id, actorId: 'usr_platform_test' };
  return { society, id, db, structure, name: String(society.name), slug: String(society.slug) };
}

beforeEach(async () => {
  await databases.resetEmbedded();
  const platform = await databases.platform();
  ctx = { platform, actorId: 'usr_platform_test', actorName: 'Reset Test' };
});

afterAll(async () => {
  await databases.closeAll().catch(() => undefined);
});

describe('clearSocietyData', () => {
  it('removes units and resident logins, and the administrator signs in with the same password', async () => {
    const { id, db, structure, name } = await newSociety(`clear-${Date.now().toString(36)}`);
    const email = 'kept-admin@reset.test';
    const phone = '+919811110001';
    await createSocietyAdmin(structure, {
      fullName: 'Kept Admin',
      email,
      phone,
      password: 'Reset@1234',
      roles: ['SOCIETY_ADMIN'],
    });
    await createSocietyAdmin(structure, {
      fullName: 'Chair',
      email: 'chair@reset.test',
      phone: '+919811110002',
      password: 'Reset@1234',
      roles: ['CHAIRMAN'],
    });
    await db.collection('units').create({
      _id: newId('units'),
      societyId: id,
      buildingId: newId('buildings'),
      unitNumber: '101',
      label: '101',
    });
    const residentId = newId('users');
    await db.collection('users').create({
      _id: residentId,
      societyId: id,
      fullName: 'A Resident',
      phone: '+919811110099',
      email: 'resident@reset.test',
      roles: ['RESIDENT'],
      status: 'ACTIVE',
      passwordHash: await hashPassword('Reset@1234'),
    });
    await db.collection('residents').create({
      _id: newId('residents'),
      societyId: id,
      fullName: 'A Resident',
      phone: '+919811110099',
      userId: residentId,
    });
    await upsertMembership({
      societyId: id,
      societyName: name,
      societySlug: 'unused',
      userId: residentId,
      phone: '+919811110099',
      email: 'resident@reset.test',
      roles: ['RESIDENT'],
      status: 'ACTIVE',
      isActive: true,
    });
    await activateSociety(ctx, id);

    const result = await clearSocietyData(ctx, id, { confirmName: name.toLowerCase(), reason: 'Demo data' });

    expect(result.adminsKept).toBe(2);
    expect(result.unitsRemoved).toBe(1);
    expect(result.residentsRemoved).toBe(1);
    expect(await db.collection('units').countDocuments({ societyId: id })).toBe(0);
    expect(await db.collection('residents').countDocuments({ societyId: id })).toBe(0);
    expect(await db.collection('users').countDocuments({ societyId: id })).toBe(2);

    const society = await ctx.platform.collection('societies').findById(id);
    expect(society?.status).toBe('ACTIVE');
    expect(society?.totalUnits).toBe(0);

    expect(await findByIdentifier('resident@reset.test')).toBeNull();
    expect((await findByIdentifier(email))?.memberships?.some((m) => m.societyId === id)).toBe(true);

    const outcome = await loginWithPassword(email, 'Reset@1234', { deviceId: 'test', platform: 'test' } as never);
    expect(outcome.kind).toBe('success');
  });

  it('refuses a wrong name and changes nothing', async () => {
    const { id, db, structure, name } = await newSociety(`clear-guard-${Date.now().toString(36)}`);
    await createSocietyAdmin(structure, {
      fullName: 'Admin',
      email: 'guard@reset.test',
      password: 'Reset@1234',
      roles: ['SOCIETY_ADMIN'],
    });
    await db.collection('units').create({
      _id: newId('units'),
      societyId: id,
      buildingId: newId('buildings'),
      unitNumber: '12',
      label: '12',
    });

    await expect(clearSocietyData(ctx, id, { confirmName: 'not the name', reason: 'oops' })).rejects.toThrow(/Expected/);
    expect(await db.collection('units').countDocuments({ societyId: id })).toBe(1);
    expect(String((await ctx.platform.collection('societies').findById(id))?.name)).toBe(name);
  });
});

describe('deleteSociety', () => {
  it('removes the society, its logins, and frees the slug', async () => {
    const slug = `gone-${Date.now().toString(36)}`;
    const { id, structure, name } = await newSociety(slug, 'Gone Society');
    const email = 'gone-admin@reset.test';
    await createSocietyAdmin(structure, {
      fullName: 'Gone Admin',
      email,
      phone: '+919811110003',
      password: 'Reset@1234',
      roles: ['SOCIETY_ADMIN'],
    });
    expect(await findByIdentifier(email)).not.toBeNull();

    const result = await deleteSociety(ctx, id, { confirmName: 'gone society', reason: 'Created by mistake' });
    expect(result.deleted).toBe(true);
    expect(await ctx.platform.collection('societies').findById(id)).toBeNull();
    expect(await findByIdentifier(email)).toBeNull();

    const again = await createSociety(ctx, { name: 'Gone Society', slug, city: 'Nagpur', tier: 'FREE' });
    expect(String(again.slug)).toBe(slug);
    expect(String(again._id)).not.toBe(id);
  });
});
