import { sequentialRef } from '@colonize/shared';
import type { TenantDatabase } from '../db/drivers/types.js';
import { newId } from '../db/ids.js';

/**
 * Human-readable sequential references (§59 tax invoice / receipt numbering).
 *
 * `INV-2026-000123`, `RCP-2026-000045`, `CMP-2026-000788`, `WO-2026-000012`, `JE-2026-000009`.
 *
 * Implemented as an atomic `$inc` on a per-(society, key, year) counter document, so two
 * concurrent bill generations can never produce the same number.
 */

export type CounterKind =
  | 'INVOICE'
  | 'RECEIPT'
  | 'COMPLAINT'
  | 'WORK_ORDER'
  | 'SERVICE_REQUEST'
  | 'JOURNAL'
  | 'BOOKING'
  | 'TICKET'
  | 'EXPENSE';

const COUNTER_PREFIX: Record<CounterKind, string> = {
  INVOICE: 'INV',
  RECEIPT: 'RCP',
  COMPLAINT: 'CMP',
  WORK_ORDER: 'WO',
  SERVICE_REQUEST: 'SRQ',
  JOURNAL: 'JE',
  BOOKING: 'BKG',
  TICKET: 'TCK',
  EXPENSE: 'EXP',
};

export interface NextRefOptions {
  db: TenantDatabase;
  societyId: string;
  kind: CounterKind;
  /** Defaults to the society's local year for the given date. */
  year?: number;
  pad?: number;
}

export async function nextReference(opts: NextRefOptions): Promise<string> {
  const { db, societyId, kind, pad = 6 } = opts;
  const year = opts.year ?? new Date().getFullYear();
  const key = `${COUNTER_PREFIX[kind]}-${year}`;
  const counters = db.collection('counters');

  const updated = await counters.findOneAndUpdate(
    { societyId, key },
    {
      $inc: { seq: 1 },
      $setOnInsert: { societyId, key, year, _id: newId('counters') },
    },
    { upsert: true, returnDocument: 'after' },
  );

  const seq = Number(updated?.seq ?? 1);
  return sequentialRef(COUNTER_PREFIX[kind], year, seq, pad);
}

/** Peek at the current value without consuming a number (used by dashboards). */
export async function currentCounter(
  db: TenantDatabase,
  societyId: string,
  kind: CounterKind,
  year = new Date().getFullYear(),
): Promise<number> {
  const key = `${COUNTER_PREFIX[kind]}-${year}`;
  const doc = await db.collection('counters').findOne({ societyId, key });
  return Number(doc?.seq ?? 0);
}

/** Reference number without a counter (used for tickets across the whole platform). */
export function inlineReference(kind: CounterKind, year: number, seq: number): string {
  return sequentialRef(COUNTER_PREFIX[kind], year, seq);
}
