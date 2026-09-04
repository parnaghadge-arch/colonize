import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { databases } from '../../src/db/manager.js';
import { newId } from '../../src/db/ids.js';
import { nextReference, currentCounter } from '../../src/services/counters.js';

/**
 * The data layer, exercised for real against the embedded driver (§10, §17).
 *
 * Two guarantees matter more than any feature:
 *  1. **per-society isolation** — society A's data must be unreachable from society B's handle
 *  2. **atomic counters** — two concurrent bill generations must never share an invoice number
 *
 * These run against a throwaway data directory (see vitest.config.ts), never backend/.runtime.
 * The driver enforces the schema registry's required fields, so the fixtures below are real
 * documents rather than loose objects — that enforcement is itself part of what is being tested.
 */

const SOCIETY_A = { id: newId('societies'), slug: 'test-society-a', databaseName: 'clnz_test_society_a' };
const SOCIETY_B = { id: newId('societies'), slug: 'test-society-b', databaseName: 'clnz_test_society_b' };

/* -------------------------------- fixtures -------------------------------- */

function unit(societyId: string, buildingId: string, unitNumber: string, extra: Record<string, unknown> = {}) {
  return { _id: newId('units'), societyId, buildingId, unitNumber, label: unitNumber, ...extra };
}

function bill(societyId: string, unitId: string, totalAmount: number, status: string) {
  return {
    _id: newId('maintenance_bills'),
    societyId,
    unitId,
    period: '2026-03',
    periodStart: new Date('2026-03-01T00:00:00Z'),
    periodEnd: new Date('2026-03-31T00:00:00Z'),
    dueDate: new Date('2026-03-15T00:00:00Z'),
    totalAmount,
    status,
  };
}

function pass(societyId: string, token: string, maxEntries = 3) {
  return {
    _id: newId('visitor_passes'),
    societyId,
    token,
    tokenHash: `hash_${token}`,
    kind: 'VISITOR',
    sign: `sign_${token}`,
    validFrom: new Date('2026-03-15T00:00:00Z'),
    validTill: new Date('2026-03-16T00:00:00Z'),
    status: 'ACTIVE',
    maxEntries,
    entriesUsed: 0,
  };
}

beforeEach(async () => {
  await databases.resetEmbedded();
});

afterAll(async () => {
  await databases.closeAll().catch(() => undefined);
});

describe('society provisioning', () => {
  it('gives every society its own database', async () => {
    const a = await databases.provision(SOCIETY_A);
    const b = await databases.provision(SOCIETY_B);
    expect(a.databaseName).not.toBe(b.databaseName);
    expect(a.societyId).toBe(SOCIETY_A.id);
    expect(b.societyId).toBe(SOCIETY_B.id);
  });

  it('is idempotent — re-provisioning does not wipe existing data', async () => {
    const first = await databases.provision(SOCIETY_A);
    await first.db.collection('units').create(unit(SOCIETY_A.id, 'bld_1', 'A-101'));

    const second = await databases.provision(SOCIETY_A);
    expect(second.databaseName).toBe(first.databaseName);
    expect(await second.db.collection('units').countDocuments({ societyId: SOCIETY_A.id })).toBe(1);
  });

  it('seeds the baseline documents every society needs to operate', async () => {
    const { db } = await databases.provision(SOCIETY_A);
    expect(await db.collection('society_settings').countDocuments({ societyId: SOCIETY_A.id })).toBeGreaterThan(0);
    expect(await db.collection('roles').countDocuments({ societyId: SOCIETY_A.id })).toBeGreaterThan(0);
  });

  it('caches the handle so repeated lookups do not reopen the store', async () => {
    const first = await databases.provision(SOCIETY_A);
    const second = await databases.forSociety(SOCIETY_A);
    expect(second).toBe(first);
  });

  it('exposes a separate platform database for SaaS data', async () => {
    const platform = await databases.platform();
    const tenant = await databases.provision(SOCIETY_A);
    expect(platform.name).not.toBe(tenant.databaseName);
  });
});

describe('schema enforcement', () => {
  it('refuses to store a document missing a required field', async () => {
    const { db } = await databases.provision(SOCIETY_A);
    await expect(
      db.collection('units').create({ _id: newId('units'), societyId: SOCIETY_A.id, label: 'A-101' } as never),
    ).rejects.toThrow(/buildingId/);
  });

  it('names every missing field at once, so a bad import is fixable in one pass', async () => {
    const { db } = await databases.provision(SOCIETY_A);
    await expect(
      db.collection('units').create({ _id: newId('units'), societyId: SOCIETY_A.id } as never),
    ).rejects.toThrow(/buildingId.*unitNumber|unitNumber.*buildingId/);
  });

  it('refuses to store a document with no society id', async () => {
    const { db } = await databases.provision(SOCIETY_A);
    // Every tenant document must name its society; an orphan record could never be scoped.
    await expect(
      db.collection('units').create({ _id: newId('units'), buildingId: 'bld_1', unitNumber: 'A-101' } as never),
    ).rejects.toThrow(/societyId/);
  });

  it('applies schema defaults so a partial insert is still complete', async () => {
    const { db } = await databases.provision(SOCIETY_A);
    const created = await db.collection('units').create(unit(SOCIETY_A.id, 'bld_1', 'A-101'));
    expect(created.status).toBe('VACANT');
    expect(created.occupancyType).toBe('VACANT');
    expect(created.isActive).toBe(true);
    expect(created.ownerCount).toBe(0);
  });
});

describe('collection CRUD', () => {
  it('creates, reads back and updates a document', async () => {
    const { db } = await databases.provision(SOCIETY_A);
    const units = db.collection('units');
    const doc = unit(SOCIETY_A.id, 'bld_1', 'A-101', { status: 'VACANT' });

    await units.create(doc);

    const found = await units.findById(doc._id);
    expect(found?.unitNumber).toBe('A-101');
    expect(found?.status).toBe('VACANT');

    await units.updateOne({ _id: doc._id }, { $set: { status: 'OCCUPIED' } });
    expect((await units.findById(doc._id))?.status).toBe('OCCUPIED');
  });

  it('filters by a query, not just by id', async () => {
    const { db } = await databases.provision(SOCIETY_A);
    const units = db.collection('units');
    await units.create(unit(SOCIETY_A.id, 'bld_1', 'A-101'));
    await units.create(unit(SOCIETY_A.id, 'bld_1', 'A-102'));
    await units.create(unit(SOCIETY_A.id, 'bld_2', 'B-101'));

    expect(await units.find({ buildingId: 'bld_1' })).toHaveLength(2);
    expect(await units.countDocuments({ buildingId: 'bld_1' })).toBe(2);
    expect(await units.countDocuments({ buildingId: 'bld_3' })).toBe(0);
  });

  it('supports the operators the modules rely on', async () => {
    const { db } = await databases.provision(SOCIETY_A);
    const bills = db.collection('maintenance_bills');
    // One bill per unit per period is enforced by a unique index, so use three units.
    await bills.create(bill(SOCIETY_A.id, newId('units'), 100, 'PAID'));
    await bills.create(bill(SOCIETY_A.id, newId('units'), 500, 'GENERATED'));
    await bills.create(bill(SOCIETY_A.id, newId('units'), 900, 'OVERDUE'));

    expect(await bills.find({ status: { $in: ['GENERATED', 'OVERDUE'] } })).toHaveLength(2);
    expect(await bills.find({ totalAmount: { $gte: 500 } })).toHaveLength(2);
    expect(await bills.find({ totalAmount: { $lt: 500 } })).toHaveLength(1);

    await bills.updateMany({ status: 'OVERDUE' }, { $set: { notes: 'reminded' } });
    expect(await bills.countDocuments({ notes: 'reminded' })).toBe(1);
  });

  it('increments atomically with findOneAndUpdate and returns the new document', async () => {
    const { db } = await databases.provision(SOCIETY_A);
    const passes = db.collection('visitor_passes');
    const doc = pass(SOCIETY_A.id, 'tok_single_entry');
    await passes.create(doc);

    const after = await passes.findOneAndUpdate(
      { _id: doc._id, status: 'ACTIVE' },
      { $inc: { entriesUsed: 1 } },
      { returnDocument: 'after' },
    );
    expect(after?.entriesUsed).toBe(1);
  });

  it('returns null for a document that does not exist', async () => {
    const { db } = await databases.provision(SOCIETY_A);
    expect(await db.collection('units').findById('unt_doesNotExist')).toBeNull();
  });
});

describe('per-society data isolation', () => {
  it("cannot see another society's records through its own handle", async () => {
    const a = await databases.provision(SOCIETY_A);
    const b = await databases.provision(SOCIETY_B);

    const doc = unit(SOCIETY_A.id, 'bld_1', 'A-101');
    await a.db.collection('units').create(doc);

    expect(await a.db.collection('units').findById(doc._id)).not.toBeNull();
    expect(await b.db.collection('units').findById(doc._id)).toBeNull();
    expect(await b.db.collection('units').countDocuments({})).toBe(0);
  });

  it('does not leak an id across tenants even when the query names the other society', async () => {
    const a = await databases.provision(SOCIETY_A);
    const b = await databases.provision(SOCIETY_B);

    const doc = unit(SOCIETY_A.id, 'bld_1', 'A-101');
    await a.db.collection('units').create(doc);

    // Asking society B's database for society A's id must find nothing — isolation is at the
    // database level, so no query written against B can reach A.
    expect(await b.db.collection('units').findOne({ _id: doc._id, societyId: SOCIETY_A.id })).toBeNull();
    expect(await b.db.collection('units').countDocuments({ societyId: SOCIETY_A.id })).toBe(0);
  });

  it('keeps counters independent per society', async () => {
    const a = await databases.provision(SOCIETY_A);
    const b = await databases.provision(SOCIETY_B);

    const refA = await nextReference({ db: a.db, societyId: SOCIETY_A.id, kind: 'INVOICE', year: 2026 });
    const refB = await nextReference({ db: b.db, societyId: SOCIETY_B.id, kind: 'INVOICE', year: 2026 });

    expect(refA).toBe('INV-2026-000001');
    expect(refB).toBe('INV-2026-000001');
  });

  it('enforces a unique constraint inside a society', async () => {
    const { db } = await databases.provision(SOCIETY_A);
    const passes = db.collection('visitor_passes');
    await passes.create(pass(SOCIETY_A.id, 'tok_unique'));
    await expect(passes.create(pass(SOCIETY_A.id, 'tok_unique'))).rejects.toThrow();
  });

  it('refuses a second bill for the same unit and period (§53)', async () => {
    const { db } = await databases.provision(SOCIETY_A);
    const bills = db.collection('maintenance_bills');
    const unitId = newId('units');
    await bills.create(bill(SOCIETY_A.id, unitId, 1500, 'GENERATED'));
    // Double-billing a resident for one month must fail at the storage layer, not rely on
    // every caller remembering to check first.
    await expect(bills.create(bill(SOCIETY_A.id, unitId, 1500, 'GENERATED'))).rejects.toThrow(/duplicate/i);
    expect(await bills.countDocuments({ unitId, period: '2026-03' })).toBe(1);
  });

  it('allows the same unit to be billed in a different period', async () => {
    const { db } = await databases.provision(SOCIETY_A);
    const bills = db.collection('maintenance_bills');
    const unitId = newId('units');
    await bills.create(bill(SOCIETY_A.id, unitId, 1500, 'GENERATED'));
    const nextMonth = { ...bill(SOCIETY_A.id, unitId, 1500, 'GENERATED'), period: '2026-04' };
    await expect(bills.create(nextMonth)).resolves.toBeTruthy();
    expect(await bills.countDocuments({ unitId })).toBe(2);
  });

  it('allows two societies to bill the same period independently', async () => {
    const a = await databases.provision(SOCIETY_A);
    const b = await databases.provision(SOCIETY_B);
    const sharedUnitId = newId('units');
    await a.db.collection('maintenance_bills').create(bill(SOCIETY_A.id, sharedUnitId, 1500, 'GENERATED'));
    await expect(
      b.db.collection('maintenance_bills').create(bill(SOCIETY_B.id, sharedUnitId, 1500, 'GENERATED')),
    ).resolves.toBeTruthy();
  });
});

describe('aggregation', () => {
  it('returns a compound $group _id as an object, matching MongoDB', async () => {
    const { db } = await databases.provision(SOCIETY_A);
    const units = db.collection('units');
    await units.create(unit(SOCIETY_A.id, 'bld_1', 'A-101', { status: 'OCCUPIED', occupancyType: 'OWNER' }));
    await units.create(unit(SOCIETY_A.id, 'bld_1', 'A-102', { status: 'OCCUPIED', occupancyType: 'OWNER' }));
    await units.create(unit(SOCIETY_A.id, 'bld_1', 'A-103', { status: 'VACANT', occupancyType: 'VACANT' }));

    const rows = await units.aggregate<{ _id: { status: string; occupancyType: string }; count: number }>([
      { $match: { societyId: SOCIETY_A.id } },
      { $group: { _id: { status: '$status', occupancyType: '$occupancyType' }, count: { $sum: 1 } } },
    ]);

    // Regression: the embedded driver used to stringify the compound key, so callers reading
    // `row._id.status` got undefined and every dashboard total collapsed to zero.
    const occupied = rows.find((r) => r._id.status === 'OCCUPIED');
    expect(occupied).toBeDefined();
    expect(occupied?.count).toBe(2);
    expect(occupied?._id.occupancyType).toBe('OWNER');

    const vacant = rows.find((r) => r._id.status === 'VACANT');
    expect(vacant?.count).toBe(1);
  });

  it('still groups by a single field path', async () => {
    const { db } = await databases.provision(SOCIETY_A);
    const units = db.collection('units');
    await units.create(unit(SOCIETY_A.id, 'bld_1', 'A-101'));
    await units.create(unit(SOCIETY_A.id, 'bld_2', 'B-101'));
    await units.create(unit(SOCIETY_A.id, 'bld_2', 'B-102'));

    const rows = await units.aggregate<{ _id: string; count: number }>([
      { $match: { societyId: SOCIETY_A.id } },
      { $group: { _id: '$buildingId', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);
    expect(rows[0]).toMatchObject({ _id: 'bld_2', count: 2 });
    expect(rows[1]).toMatchObject({ _id: 'bld_1', count: 1 });
  });

  it('accumulates $sum over a field, not just a count', async () => {
    const { db } = await databases.provision(SOCIETY_A);
    const bills = db.collection('maintenance_bills');
    await bills.create(bill(SOCIETY_A.id, newId('units'), 1000, 'PAID'));
    await bills.create(bill(SOCIETY_A.id, newId('units'), 2500, 'PAID'));
    await bills.create(bill(SOCIETY_A.id, newId('units'), 900, 'OVERDUE'));

    const rows = await bills.aggregate<{ _id: string; total: number }>([
      { $match: { societyId: SOCIETY_A.id } },
      { $group: { _id: '$status', total: { $sum: '$totalAmount' } } },
    ]);
    expect(rows.find((r) => r._id === 'PAID')?.total).toBe(3500);
    expect(rows.find((r) => r._id === 'OVERDUE')?.total).toBe(900);
  });
});

describe('sequential references (§59)', () => {
  it('starts at one and increments per society, kind and year', async () => {
    const { db } = await databases.provision(SOCIETY_A);
    const opts = { db, societyId: SOCIETY_A.id, kind: 'INVOICE' as const };

    expect(await nextReference({ ...opts, year: 2026 })).toBe('INV-2026-000001');
    expect(await nextReference({ ...opts, year: 2026 })).toBe('INV-2026-000002');
    expect(await nextReference({ ...opts, year: 2027 })).toBe('INV-2027-000001');
  });

  it('keeps separate sequences per document kind', async () => {
    const { db } = await databases.provision(SOCIETY_A);
    expect(await nextReference({ db, societyId: SOCIETY_A.id, kind: 'INVOICE', year: 2026 })).toBe('INV-2026-000001');
    expect(await nextReference({ db, societyId: SOCIETY_A.id, kind: 'RECEIPT', year: 2026 })).toBe('RCP-2026-000001');
  });

  it('never hands out the same number twice under concurrency', async () => {
    const { db } = await databases.provision(SOCIETY_A);
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        nextReference({ db, societyId: SOCIETY_A.id, kind: 'RECEIPT', year: 2026 }),
      ),
    );
    expect(new Set(results).size).toBe(50);
    expect(await currentCounter(db, SOCIETY_A.id, 'RECEIPT', 2026)).toBe(50);
  });

  it('can be read without consuming a number', async () => {
    const { db } = await databases.provision(SOCIETY_A);
    await nextReference({ db, societyId: SOCIETY_A.id, kind: 'COMPLAINT', year: 2026 });
    expect(await currentCounter(db, SOCIETY_A.id, 'COMPLAINT', 2026)).toBe(1);
    expect(await currentCounter(db, SOCIETY_A.id, 'COMPLAINT', 2026)).toBe(1);
    expect(await nextReference({ db, societyId: SOCIETY_A.id, kind: 'COMPLAINT', year: 2026 })).toBe('CMP-2026-000002');
  });
});
