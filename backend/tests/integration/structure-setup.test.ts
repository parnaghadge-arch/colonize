import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { databases } from '../../src/db/manager.js';
import { createSociety, provisionSocietyDatabase, runOnboardingStep, type SocietiesContext } from '../../src/modules/societies/societiesService.js';
import { setupStructure, type StructureContext } from '../../src/modules/structure/structureService.js';

/**
 * Guided structure setup: towers with apartments, and plots that are a vacant plot, a house,
 * or a tower. A conflict must save nothing — a second click that silently skips is how
 * "the edit did nothing" gets reported.
 */

let ctx: SocietiesContext;

async function newSociety(layout: 'BUILDING' | 'PLOT' | 'MIXED' = 'MIXED') {
  const society = await createSociety(ctx, {
    name: `Setup ${layout}`,
    slug: `setup-${layout.toLowerCase()}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    city: 'Nagpur',
    tier: 'FREE',
    layout,
  });
  await provisionSocietyDatabase(society);
  const id = String(society._id);
  const db = await databases.tenantDb(id);
  const structure: StructureContext = { db, societyId: id, actorId: 'usr_platform_test' };
  return { id, db, structure };
}

beforeEach(async () => {
  await databases.resetEmbedded();
  const platform = await databases.platform();
  ctx = { platform, actorId: 'usr_platform_test', actorName: 'Setup Test' };
});

afterAll(async () => {
  await databases.closeAll().catch(() => undefined);
});

describe('setupStructure', () => {
  it('creates towers and numbers apartments 101… then 201', async () => {
    const { db, structure, id } = await newSociety('BUILDING');
    const result = await setupStructure(structure, {
      towers: [
        { name: 'Tower 1', apartments: 6 },
        { name: 'Tower 2', apartments: 2 },
      ],
      apartmentsPerFloor: 4,
    });

    expect(result.unitsCreated).toBe(8);
    expect(result.summary).toBe('Added 2 towers (8 apartments).');

    const units = await db.collection('units').find({ societyId: id }, { sort: { unitNumber: 1 }, limit: 20 });
    const tower1 = units.filter((unit) => String(unit.label).includes('Tower 1')).map((unit) => unit.unitNumber);
    expect(tower1).toEqual(['101', '102', '103', '104', '201', '202']);
    expect(units.filter((unit) => String(unit.label).includes('Tower 2')).map((unit) => unit.unitNumber)).toEqual(['101', '102']);

    const floors = await db.collection('floors').countDocuments({ societyId: id });
    expect(floors).toBe(3);
  });

  it('creates vacant plots, houses, and a tower standing on a plot', async () => {
    const { db, structure, id } = await newSociety('PLOT');
    const result = await setupStructure(structure, {
      plots: [
        { number: 1, kind: 'HOUSE' },
        { number: 2, kind: 'VACANT' },
        { number: 3, kind: 'TOWER', apartments: 2 },
      ],
    });

    expect(result.unitsCreated).toBe(4);
    expect(result.summary).toMatch(/1 house, 1 vacant plot and 1 tower on a plot \(2 apartments\)/);

    const house = await db.collection('units').findOne({ societyId: id, unitNumber: 'P-1' });
    expect(house?.type).toBe('HOUSE');
    expect(house?.label).toBe('Plot 1');
    expect(house?.floorNumber).toBe(-1);

    const vacant = await db.collection('units').findOne({ societyId: id, unitNumber: 'P-2' });
    expect(vacant?.type).toBe('PLOT');
    expect(vacant?.label).toBe('Plot 2');

    const tower = await db.collection('buildings').findOne({ societyId: id, code: 'PT3' });
    expect(tower?.name).toBe('Plot 3 Tower');
    expect(tower?.type).toBe('TOWER');
    const apartments = await db.collection('units').countDocuments({ societyId: id, buildingId: tower?._id });
    expect(apartments).toBe(2);
  });

  it('writes nothing when a name already exists, including on a second click', async () => {
    const { db, structure, id } = await newSociety('BUILDING');
    await setupStructure(structure, { towers: [{ name: 'Tower 1', apartments: 2 }] });
    const before = await db.collection('units').countDocuments({ societyId: id });

    await expect(
      setupStructure(structure, {
        towers: [
          { name: 'Tower 1', apartments: 2 },
          { name: 'Tower 2', apartments: 4 },
        ],
      }),
    ).rejects.toThrow(/Nothing was saved/);

    expect(await db.collection('units').countDocuments({ societyId: id })).toBe(before);
    expect(await db.collection('buildings').countDocuments({ societyId: id, code: 'T2' })).toBe(0);
  });

  it('dry-runs the onboarding structure step without writing, then saves the same payload', async () => {
    const { db, id } = await newSociety('MIXED');
    const setup = {
      towers: [{ name: 'Tower 1', apartments: 4 }],
      plots: [
        { number: 1, kind: 'HOUSE' },
        { number: 2, kind: 'TOWER', apartments: 2 },
      ],
      apartmentsPerFloor: 4,
    };

    const preview = await runOnboardingStep(ctx, id, 'STRUCTURE', { setup, dryRun: true });
    expect(preview.dryRun).toBe(true);
    expect(preview.unitsCreated).toBe(7);
    expect(String(preview.summary)).toMatch(/^Would add/);
    expect(await db.collection('units').countDocuments({ societyId: id })).toBe(0);

    const saved = await runOnboardingStep(ctx, id, 'STRUCTURE', { setup, dryRun: false });
    expect(saved.unitsCreated).toBe(7);
    expect(await db.collection('units').countDocuments({ societyId: id })).toBe(7);
    expect(await db.collection('buildings').countDocuments({ societyId: id })).toBe(3);
  });
});
