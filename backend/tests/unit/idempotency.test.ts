import { describe, expect, it } from 'vitest';
import { idempotencyKeyFrom, stableStringify } from '../../src/services/idempotency.js';
import { inlineReference } from '../../src/services/counters.js';

/**
 * Idempotency (§58) and reference numbering (§59).
 *
 * A resident tapping "Pay" twice on a flaky mobile connection must not produce two receipts.
 * The request fingerprint has to be stable regardless of JSON key order, otherwise the second
 * tap looks like a brand-new request.
 */
describe('stableStringify', () => {
  it('ignores property order', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });

  it('ignores property order in nested objects too', () => {
    expect(stableStringify({ x: { b: 1, a: 2 } })).toBe(stableStringify({ x: { a: 2, b: 1 } }));
  });

  it('preserves array order (order is meaningful there)', () => {
    expect(stableStringify([1, 2, 3])).not.toBe(stableStringify([3, 2, 1]));
  });

  it('normalises objects nested inside arrays', () => {
    expect(stableStringify([{ b: 1, a: 2 }])).toBe(stableStringify([{ a: 2, b: 1 }]));
  });

  it('drops undefined values so an omitted field matches an absent one', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
  });

  it('keeps null distinct from undefined', () => {
    expect(stableStringify({ a: null })).not.toBe(stableStringify({}));
  });

  it('distinguishes values that differ only by type', () => {
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: '1' }));
  });

  it('serialises primitives', () => {
    expect(stableStringify(5)).toBe('5');
    expect(stableStringify('x')).toBe('"x"');
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify(true)).toBe('true');
  });
});

describe('idempotencyKeyFrom', () => {
  it('prefers the header', () => {
    expect(idempotencyKeyFrom({ 'x-idempotency-key': 'key-123456' }, { clientRequestId: 'other-123' }))
      .toBe('key-123456');
  });

  it('trims surrounding whitespace', () => {
    expect(idempotencyKeyFrom({ 'x-idempotency-key': '  key-123456  ' }, {})).toBe('key-123456');
  });

  it('falls back to clientRequestId in the body', () => {
    expect(idempotencyKeyFrom({}, { clientRequestId: 'req-abcdef' })).toBe('req-abcdef');
  });

  it('rejects a key too short to be unique', () => {
    expect(idempotencyKeyFrom({ 'x-idempotency-key': 'ab' }, {})).toBeNull();
    expect(idempotencyKeyFrom({}, { clientRequestId: 'ab' })).toBeNull();
  });

  it('returns null when the client sent nothing', () => {
    expect(idempotencyKeyFrom({}, {})).toBeNull();
    expect(idempotencyKeyFrom({}, null)).toBeNull();
  });

  it('ignores a non-string header value', () => {
    expect(idempotencyKeyFrom({ 'x-idempotency-key': ['a', 'b'] }, {})).toBeNull();
    expect(idempotencyKeyFrom({ 'x-idempotency-key': 123456 }, {})).toBeNull();
  });

  it('caps the key length so a hostile client cannot bloat the index', () => {
    const key = idempotencyKeyFrom({ 'x-idempotency-key': 'k'.repeat(5000) }, {});
    expect(key).toHaveLength(120);
  });
});

describe('inlineReference', () => {
  it.each([
    ['INVOICE', 123, 'INV-2026-000123'],
    ['RECEIPT', 7, 'RCP-2026-000007'],
    ['WORK_ORDER', 1, 'WO-2026-000001'],
    ['COMPLAINT', 788, 'CMP-2026-000788'],
    ['JOURNAL', 9, 'JE-2026-000009'],
    ['BOOKING', 42, 'BKG-2026-000042'],
    ['SERVICE_REQUEST', 5, 'SRQ-2026-000005'],
    ['TICKET', 3, 'TCK-2026-000003'],
    ['EXPENSE', 11, 'EXP-2026-000011'],
  ] as const)('formats %s #%i as %s', (kind, seq, expected) => {
    expect(inlineReference(kind, 2026, seq)).toBe(expected);
  });

  it('zero-pads to six digits by default', () => {
    expect(inlineReference('INVOICE', 2026, 1)).toBe('INV-2026-000001');
  });

  it('does not truncate a sequence longer than the padding', () => {
    expect(inlineReference('INVOICE', 2026, 1234567)).toBe('INV-2026-1234567');
  });

  it('embeds the year so numbering restarts cleanly each financial year', () => {
    expect(inlineReference('INVOICE', 2025, 1)).toBe('INV-2025-000001');
    expect(inlineReference('INVOICE', 2026, 1)).toBe('INV-2026-000001');
  });
});
