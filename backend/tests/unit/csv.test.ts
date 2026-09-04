import { describe, expect, it } from 'vitest';
import {
  normaliseHeader,
  parseCsv,
  toCsv,
  RESIDENT_IMPORT_ALIASES,
  UNIT_IMPORT_ALIASES,
} from '../../src/utils/csv.js';

/**
 * CSV import/export (§41 "import units through Excel/CSV", §43 report exports).
 *
 * Deliberately tolerant: societies export resident lists from spreadsheets with inconsistent
 * headers, so headers are normalised and matched against aliases, and row-level problems are
 * returned as a list instead of aborting the whole import.
 */
describe('normaliseHeader', () => {
  it.each([
    [' Flat No ', 'flat_no'],
    ['Owner Name', 'owner_name'],
    ['owner-name', 'owner_name'],
    ['OWNER   EMAIL', 'owner_email'],
    ['  ', ''],
  ])('normalises %j to %j', (input, expected) => {
    expect(normaliseHeader(input)).toBe(expected);
  });

  it('strips a UTF-8 byte-order mark so the first column still matches', () => {
    expect(normaliseHeader('\uFEFFOwner Name')).toBe('owner_name');
  });

  it('is idempotent', () => {
    const once = normaliseHeader('Flat No');
    expect(normaliseHeader(once)).toBe(once);
  });
});

describe('parseCsv', () => {
  it('reads a simple comma-separated sheet', () => {
    const result = parseCsv('Flat No,Owner\nA-101,Ravi\nA-102,Sita');
    expect(result.totalRows).toBe(2);
    expect(result.errors).toEqual([]);
    expect(result.rows).toEqual([
      { flat_no: 'A-101', owner: 'Ravi' },
      { flat_no: 'A-102', owner: 'Sita' },
    ]);
  });

  it('detects a semicolon delimiter (common in European spreadsheet exports)', () => {
    const result = parseCsv('a;b\n1;2');
    expect(result.rows).toEqual([{ a: '1', b: '2' }]);
  });

  it('maps messy headers onto canonical fields through the alias table', () => {
    const result = parseCsv('Flat,Owner Name\nA-101,Ravi', { aliases: UNIT_IMPORT_ALIASES });
    expect(result.rows[0]).toMatchObject({ unitNumber: 'A-101', ownerName: 'Ravi' });
  });

  it('exposes alias tables for both supported imports', () => {
    expect(Object.keys(UNIT_IMPORT_ALIASES)).toContain('unitNumber');
    expect(Object.keys(UNIT_IMPORT_ALIASES)).toContain('ownerPhone');
    expect(Object.keys(RESIDENT_IMPORT_ALIASES).length).toBeGreaterThan(0);
  });

  it('reports an empty upload as an error rather than silently importing nothing', () => {
    const result = parseCsv('   ');
    expect(result.rows).toEqual([]);
    expect(result.totalRows).toBe(0);
    expect(result.errors).toEqual([{ row: 0, message: 'The file is empty' }]);
  });

  it('honours maxRows and tells the user the file was truncated', () => {
    const lines = ['a,b', ...Array.from({ length: 50 }, (_, i) => `${i},x`)];
    const result = parseCsv(lines.join('\n'), { maxRows: 10 });
    expect(result.rows).toHaveLength(10);
    expect(result.errors.some((e) => /only the first 10 rows/i.test(e.message))).toBe(true);
  });

  it('skips blank lines', () => {
    const result = parseCsv('a,b\n1,2\n\n\n3,4\n');
    expect(result.totalRows).toBe(2);
  });

  it('trims surrounding whitespace from values', () => {
    const result = parseCsv('a,b\n  1  ,  2  ');
    expect(result.rows[0]).toEqual({ a: '1', b: '2' });
  });

  it('does not throw on a short row', () => {
    const result = parseCsv('a,b,c\n1,2');
    expect(result.rows.length).toBeLessThanOrEqual(1);
    expect(result.rows[0]?.a).toBe('1');
  });

  it('keeps quoted values containing commas intact', () => {
    const result = parseCsv('name,notes\n"Kumar, Ravi","said ""hello"""');
    expect(result.rows[0]).toEqual({ name: 'Kumar, Ravi', notes: 'said "hello"' });
  });
});

describe('toCsv', () => {
  it('escapes values containing commas, quotes and newlines', () => {
    const csv = toCsv([{ a: 1, b: 'x,y', c: 'say "hi"' }]);
    expect(csv.split('\r\n')[0]).toBe('a,b,c');
    expect(csv).toContain('"x,y"');
    expect(csv).toContain('"say ""hi"""');
  });

  it('uses CRLF line endings so Excel opens it correctly', () => {
    expect(toCsv([{ a: 1 }, { a: 2 }])).toBe('a\r\n1\r\n2');
  });

  it('emits only the requested columns, with friendly labels', () => {
    const csv = toCsv(
      [{ unit: 'A-101', owner: 'Ravi', secret: 'x' }],
      [
        { key: 'unit', label: 'Flat No' },
        { key: 'owner', label: 'Owner Name' },
      ],
    );
    expect(csv).toBe('Flat No,Owner Name\r\nA-101,Ravi');
    expect(csv).not.toContain('secret');
  });

  it('emits a header-only document for an empty result set', () => {
    expect(toCsv([], [{ key: 'a', label: 'A' }])).toBe('A');
  });

  it('drops audit columns when inferring the header row', () => {
    const csv = toCsv([{ name: 'x', createdAt: new Date(), updatedAt: new Date(), deletedAt: null, __v: 0 }]);
    expect(csv.split('\r\n')[0]).toBe('name');
  });

  it('serialises arrays and dates readably', () => {
    const csv = toCsv([{ tags: ['a', 'b'], at: new Date('2026-01-02T03:04:05.000Z') }]);
    expect(csv).toContain('a; b');
    expect(csv).toContain('2026-01-02T03:04:05.000Z');
  });

  it('renders null and undefined as empty cells', () => {
    expect(toCsv([{ a: null, b: undefined, c: 'x' }])).toBe('a,b,c\r\n,,x');
  });
});
