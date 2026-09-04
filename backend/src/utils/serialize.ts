import { maskEmail, maskPhone } from '@colonize/shared';
import type { Document } from '../db/drivers/types.js';
import { NEVER_SERIALISE } from '../db/registry/index.js';

/**
 * Response serialisation.
 *
 * Two rules are enforced here so no module can forget them:
 *  1. secrets (password/OTP/token hashes, HMAC signatures) are **removed**
 *  2. PII that a list view does not need (bank account, ID proof, phone/email of people who
 *     are not the caller) is **masked**
 */

const MASK_RULES: Record<string, (value: unknown, ctx: SerialiseOptions) => unknown> = {
  bankAccountNumber: (v) => maskAccount(String(v ?? '')),
  idProofNumber: (v) => maskTail(String(v ?? ''), 4),
};

export interface SerialiseOptions {
  /** When true, phone/email are returned in full (the caller is allowed to see them). */
  revealContact?: boolean;
  /** When true, masked PII fields are returned in full (admin/owner flows). */
  revealSensitive?: boolean;
  /** Extra fields to drop. */
  omit?: string[];
}

export function maskAccount(value: string): string {
  if (!value) return '';
  if (value.length <= 4) return '****';
  return `${'•'.repeat(Math.max(4, value.length - 4))}${value.slice(-4)}`;
}

export function maskTail(value: string, keep: number): string {
  if (!value) return '';
  if (value.length <= keep) return '•'.repeat(value.length);
  return `${'•'.repeat(value.length - keep)}${value.slice(-keep)}`;
}

function clean(value: unknown, opts: SerialiseOptions, depth = 0): unknown {
  if (depth > 8) return undefined;
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => clean(v, opts, depth + 1));
  if (typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (NEVER_SERIALISE.has(key)) continue;
    if (opts.omit?.includes(key)) continue;

    if (!opts.revealSensitive && MASK_RULES[key]) {
      out[key] = MASK_RULES[key](raw, opts);
      continue;
    }
    if (!opts.revealContact && (key === 'phone' || key === 'visitorPhone' || key === 'contactPhone')) {
      out[key] = maskPhone(raw);
      continue;
    }
    if (!opts.revealContact && key === 'email') {
      out[key] = maskEmail(raw);
      continue;
    }
    out[key] = clean(raw, opts, depth + 1);
  }
  return out;
}

/** Serialise one document for a response. */
export function serialise<T extends Document>(doc: T | null, opts: SerialiseOptions = {}): Record<string, unknown> | null {
  if (!doc) return null;
  return clean(doc, opts) as Record<string, unknown>;
}

/** Serialise a list of documents. */
export function serialiseMany<T extends Document>(docs: T[], opts: SerialiseOptions = {}): Record<string, unknown>[] {
  return docs.map((d) => serialise(d, opts) ?? {});
}

/**
 * Diff two versions of a document for the audit log (§44 old value / new value).
 * Secret and noisy fields are excluded from the diff so the audit trail stays readable.
 */
export const AUDIT_DIFF_IGNORE = new Set([
  'updatedAt',
  'createdAt',
  '__v',
  'timeline',
  'history',
  'deliveries',
  'transactions',
  ...NEVER_SERIALISE,
]);

export function diffDocuments(
  before: Document | null | undefined,
  after: Document | null | undefined,
): { changedFields: string[]; oldValue: Document; newValue: Document } {
  const changedFields: string[] = [];
  const oldValue: Document = {};
  const newValue: Document = {};
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const key of keys) {
    if (AUDIT_DIFF_IGNORE.has(key)) continue;
    const a = (before ?? {})[key];
    const b = (after ?? {})[key];
    if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) {
      changedFields.push(key);
      oldValue[key] = typeof a === 'object' && a !== null ? summarise(a) : a;
      newValue[key] = typeof b === 'object' && b !== null ? summarise(b) : b;
    }
  }
  return { changedFields, oldValue, newValue };
}

/** Keep audit payloads small: long arrays/objects are summarised, not copied. */
function summarise(value: unknown): unknown {
  if (Array.isArray(value)) return value.length > 20 ? `[${value.length} items]` : value;
  if (value && typeof value === 'object') {
    const text = JSON.stringify(value);
    return text.length > 2000 ? '[large object]' : value;
  }
  return value;
}
