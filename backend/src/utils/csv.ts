import { parse as csvParse } from 'csv-parse/sync';
import type { Document } from '../db/drivers/types.js';

/**
 * CSV parsing helpers for bulk onboarding (§41 "import units through Excel/CSV") and for
 * report exports (§43).
 *
 * Deliberately tolerant: societies export their resident lists from spreadsheets with
 * inconsistent headers ("Flat No", "flat_no", "FlatNo"), so headers are normalised before
 * matching, and a row-level error list is returned instead of aborting the whole import.
 */

export interface CsvParseOptions {
  /** Header aliases, keyed by the canonical field name. */
  aliases?: Record<string, string[]>;
  /** Maximum rows to read (protects memory on a huge upload). */
  maxRows?: number;
}

export interface CsvParseResult<T = Record<string, string>> {
  rows: T[];
  headers: string[];
  errors: Array<{ row: number; message: string }>;
  totalRows: number;
}

export function normaliseHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/^\uFEFF/, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function parseCsv<T = Record<string, string>>(raw: string, options: CsvParseOptions = {}): CsvParseResult<T> {
  const { aliases = {}, maxRows = 100_000 } = options;
  const errors: Array<{ row: number; message: string }> = [];

  if (!raw || !raw.trim()) return { rows: [], headers: [], errors: [{ row: 0, message: 'The file is empty' }], totalRows: 0 };

  let records: Record<string, string>[];
  try {
    records = csvParse(raw, {
      columns: (headers: string[]) => headers.map((h: string) => normaliseHeader(String(h))),
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      bom: true,
      delimiter: detectDelimiter(raw),
    }) as Record<string, string>[];
  } catch (err) {
    return { rows: [], headers: [], errors: [{ row: 0, message: `Could not parse CSV: ${(err as Error).message}` }], totalRows: 0 };
  }

  if (records.length > maxRows) {
    errors.push({ row: 0, message: `Only the first ${maxRows} rows were read` });
    records = records.slice(0, maxRows);
  }

  // Build a reverse alias map: normalised alias → canonical field.
  const aliasMap = new Map<string, string>();
  for (const [canonical, list] of Object.entries(aliases)) {
    aliasMap.set(normaliseHeader(canonical), canonical);
    for (const alias of list) aliasMap.set(normaliseHeader(alias), canonical);
  }

  const rows = records.map((record, index) => {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(record)) {
      const canonical = aliasMap.get(key) ?? key;
      out[canonical] = String(value ?? '').trim();
    }
    return out as T;
  });

  const headers = records.length > 0 ? Object.keys(records[0] as Record<string, string>) : [];
  return { rows, headers, errors, totalRows: records.length };
}

/** Sniff `,` `;` or tab so exports from Excel (locale-dependent) still import. */
function detectDelimiter(sample: string): string {
  const firstLine = sample.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  const counts: Array<[string, number]> = [
    [',', (firstLine.match(/,/g) ?? []).length],
    [';', (firstLine.match(/;/g) ?? []).length],
    ['\t', (firstLine.match(/\t/g) ?? []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0] && counts[0][1] > 0 ? counts[0][0] : ',';
}

/** Column aliases accepted for a unit import. */
export const UNIT_IMPORT_ALIASES: Record<string, string[]> = {
  building: ['tower', 'block', 'building_name', 'tower_name', 'building_code'],
  buildingCode: ['tower_code', 'block_code'],
  wing: ['wing_name', 'wing_code', 'section'],
  floor: ['floor_no', 'floor_number', 'level'],
  unitNumber: ['flat', 'flat_no', 'flat_number', 'unit', 'unit_no', 'house_no', 'door_no'],
  type: ['unit_type', 'flat_type'],
  carpetAreaSqft: ['carpet_area', 'area', 'area_sqft', 'sqft', 'built_up_area', 'carpet_area_sqft'],
  bedrooms: ['bhk', 'bedroom', 'bedrooms_count'],
  ownerName: ['owner', 'owner_name', 'first_owner'],
  ownerPhone: ['owner_mobile', 'owner_phone', 'owner_contact'],
  ownerEmail: ['owner_mail'],
  tenantName: ['tenant', 'tenant_name', 'renter_name'],
  tenantPhone: ['tenant_mobile', 'tenant_phone', 'tenant_contact'],
  tenantEmail: ['tenant_mail'],
  status: ['occupancy', 'unit_status', 'occupancy_status'],
  moveInDate: ['move_in', 'occupancy_from', ' possession_date', 'possession_date'],
  parkingSlot: ['parking', 'parking_slot', 'slot'],
};

/** Column aliases accepted for a resident import. */
export const RESIDENT_IMPORT_ALIASES: Record<string, string[]> = {
  fullName: ['name', 'resident_name', 'member_name', 'full_name'],
  phone: ['mobile', 'mobile_number', 'contact', 'phone_number', 'contact_number'],
  email: ['email_id', 'mail'],
  building: ['tower', 'block'],
  wing: ['wing_name'],
  floor: ['floor_no'],
  unitNumber: ['flat', 'flat_no', 'flat_number', 'unit', 'unit_no'],
  kind: ['type', 'resident_type', 'owner_tenant', 'category'],
  moveInDate: ['move_in', 'move_in_date', 'from_date'],
  gender: ['sex'],
  dateOfBirth: ['dob', 'birth_date'],
  occupation: ['profession'],
  vehicleNumber: ['vehicle', 'car_number', 'vehicle_no'],
};

/** Serialise rows to CSV text (used by every export endpoint). */
export function toCsv(rows: Document[], columns?: Array<{ key: string; label: string }>): string {
  if (rows.length === 0) return columns ? columns.map((c) => c.label).join(',') : '';
  const cols =
    columns ??
    Array.from(
      new Set(
        rows.flatMap((r) =>
          Object.keys(r).filter((k) => !['createdAt', 'updatedAt', 'deletedAt', '__v'].includes(k)),
        ),
      ),
    ).map((key) => ({ key, label: key }));

  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const text = value instanceof Date ? value.toISOString() : Array.isArray(value) ? value.join('; ') : typeof value === 'object' ? JSON.stringify(value) : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const lines = [cols.map((c) => escape(c.label)).join(',')];
  for (const row of rows) lines.push(cols.map((c) => escape(row[c.key])).join(','));
  return lines.join('\r\n');
}
