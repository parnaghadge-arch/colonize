import { describe, expect, it } from 'vitest';
import {
  diffDocuments,
  maskAccount,
  maskTail,
  serialise,
  serialiseMany,
} from '../../src/utils/serialize.js';
import type { Document } from '../../src/db/drivers/types.js';

/**
 * Response serialisation (§44, §66).
 *
 * Two invariants no module may bypass:
 *  1. secrets (password / OTP / token hashes, signatures, bank and ID-proof numbers) are REMOVED
 *  2. PII a list view does not need (phone, email) is MASKED unless the caller may see it
 */

const DOC = {
  _id: 'res_1',
  name: 'Ravi Kumar',
  phone: '+919876543210',
  email: 'ravi.kumar@example.com',
  passwordHash: '$2a$10$supersecret',
  otpHash: 'otp-digest',
  refreshTokenHash: 'refresh-digest',
  tokenHash: 'token-digest',
  bankAccountNumber: '123456789012',
  idProofNumber: 'ABCD1234E',
  checksum: 'gateway-checksum',
  createdAt: new Date('2026-01-02T03:04:05.000Z'),
  tags: ['owner', 'committee'],
  address: { city: 'Pune', pincode: '411001' },
} as unknown as Document;

describe('serialise — secret removal', () => {
  const out = serialise(DOC)!;

  it.each([
    'passwordHash',
    'otpHash',
    'refreshTokenHash',
    'tokenHash',
    'bankAccountNumber',
    'idProofNumber',
    'checksum',
  ])('strips %s entirely', (field) => {
    expect(out).not.toHaveProperty(field);
  });

  it('keeps the secret values out of the serialised JSON text too', () => {
    const json = JSON.stringify(out);
    expect(json).not.toContain('supersecret');
    expect(json).not.toContain('otp-digest');
    expect(json).not.toContain('123456789012');
    expect(json).not.toContain('ABCD1234E');
  });

  it('still strips secrets even when the caller is allowed to see contact details', () => {
    const revealed = serialise(DOC, { revealContact: true, revealSensitive: true })!;
    expect(revealed).not.toHaveProperty('passwordHash');
    expect(revealed).not.toHaveProperty('bankAccountNumber');
  });
});

describe('serialise — PII masking', () => {
  it('masks phone and email by default', () => {
    const out = serialise(DOC)!;
    expect(out.phone).toBe('+91•••••••210');
    expect(out.email).toBe('ra••••••@example.com');
  });

  it('masks contact fields in nested objects and arrays as well', () => {
    const nested = { visitor: { name: 'Guest', phone: '+919000000000', email: 'guest@example.com' } } as unknown as Document;
    const out = serialise(nested)!;
    expect((out.visitor as Record<string, unknown>).phone).not.toBe('+919000000000');
    expect((out.visitor as Record<string, unknown>).email).not.toBe('guest@example.com');
  });

  it('reveals contact details only when explicitly permitted', () => {
    const out = serialise(DOC, { revealContact: true })!;
    expect(out.phone).toBe('+919876543210');
    expect(out.email).toBe('ravi.kumar@example.com');
  });

  it('honours the omit list', () => {
    const out = serialise(DOC, { omit: ['name', 'address'] })!;
    expect(out).not.toHaveProperty('name');
    expect(out).not.toHaveProperty('address');
    expect(out).toHaveProperty('_id');
  });
});

describe('serialise — shape', () => {
  it('converts Date instances to ISO strings so JSON is stable', () => {
    expect(serialise(DOC)!.createdAt).toBe('2026-01-02T03:04:05.000Z');
  });

  it('passes through primitives, arrays and plain objects', () => {
    const out = serialise(DOC)!;
    expect(out.name).toBe('Ravi Kumar');
    expect(out.tags).toEqual(['owner', 'committee']);
    expect(out.address).toEqual({ city: 'Pune', pincode: '411001' });
  });

  it('returns null for a missing document rather than an empty object', () => {
    expect(serialise(null)).toBeNull();
  });

  it('does not mutate the source document', () => {
    const source = { ...DOC } as Document;
    serialise(source);
    expect(source).toHaveProperty('passwordHash');
    expect((source as Record<string, unknown>).phone).toBe('+919876543210');
  });

  it('serialises a list the same way it serialises one document', () => {
    const many = serialiseMany([DOC, DOC]);
    expect(many).toHaveLength(2);
    const first = many[0]!;
    expect(first).not.toHaveProperty('passwordHash');
    expect(first.phone).toBe('+91•••••••210');
  });
});

describe('maskAccount / maskTail', () => {
  it('keeps only the last four digits of an account number', () => {
    expect(maskAccount('123456789012')).toBe('••••••••9012');
  });

  it('masks everything when the value is too short to be worth showing', () => {
    expect(maskAccount('12')).toBe('****');
    expect(maskAccount('1234')).toBe('****');
  });

  it('returns an empty string for an empty value', () => {
    expect(maskAccount('')).toBe('');
  });

  it('keeps the requested tail length', () => {
    expect(maskTail('ABCD1234E', 4)).toBe('•••••234E');
    expect(maskTail('ABCD1234E', 2)).toBe('•••••••4E');
  });

  it('fully masks a value shorter than the tail it would keep', () => {
    expect(maskTail('AB', 4)).toBe('••');
    expect(maskTail('', 4)).toBe('');
  });
});

describe('diffDocuments (audit trail)', () => {
  it('reports only the fields that actually changed', () => {
    const diff = diffDocuments({ a: 1, b: 2, c: 3 }, { a: 1, b: 99, c: 3 });
    expect(diff.changedFields).toEqual(['b']);
    expect(diff.oldValue).toEqual({ b: 2 });
    expect(diff.newValue).toEqual({ b: 99 });
  });

  it('detects added and removed fields', () => {
    const diff = diffDocuments({ a: 1 }, { b: 2 });
    expect(diff.changedFields.sort()).toEqual(['a', 'b']);
  });

  it('ignores timestamps so a touch-only update produces an empty diff', () => {
    const diff = diffDocuments(
      { status: 'OPEN', updatedAt: new Date('2026-01-01'), createdAt: new Date('2026-01-01') },
      { status: 'OPEN', updatedAt: new Date('2026-06-01'), createdAt: new Date('2026-01-01') },
    );
    expect(diff.changedFields).toEqual([]);
  });

  it('never writes secret values into the audit log', () => {
    const diff = diffDocuments({ passwordHash: 'old-hash' }, { passwordHash: 'new-hash' });
    expect(diff.changedFields).toEqual([]);
    expect(JSON.stringify(diff)).not.toContain('old-hash');
    expect(JSON.stringify(diff)).not.toContain('new-hash');
  });

  it('ignores noisy append-only collections', () => {
    const diff = diffDocuments({ timeline: [1, 2] }, { timeline: [1, 2, 3] });
    expect(diff.changedFields).toEqual([]);
  });

  it('treats a null before/after as an empty document', () => {
    expect(diffDocuments(null, { a: 1 }).changedFields).toEqual(['a']);
    expect(diffDocuments({ a: 1 }, undefined).changedFields).toEqual(['a']);
    expect(diffDocuments(null, null).changedFields).toEqual([]);
  });

  it('compares nested objects by value', () => {
    const same = diffDocuments({ meta: { x: 1 } }, { meta: { x: 1 } });
    const changed = diffDocuments({ meta: { x: 1 } }, { meta: { x: 2 } });
    expect(same.changedFields).toEqual([]);
    expect(changed.changedFields).toEqual(['meta']);
  });
});
