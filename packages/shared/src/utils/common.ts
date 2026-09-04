/**
 * Identifiers, pagination and misc runtime helpers shared by API + clients.
 */

/* ------------------------------ identifiers ------------------------------ */

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Minimal structural type so this package compiles for Node, browsers and React Native. */
interface RandomSource {
  getRandomValues?: <T extends Uint8Array>(array: T) => T;
}

function cryptoSource(): RandomSource | undefined {
  return typeof globalThis === 'undefined'
    ? undefined
    : (globalThis as unknown as { crypto?: RandomSource }).crypto;
}

/** URL-safe random id. Prefer native crypto when available (API + modern browsers). */
export function randomId(size = 21): string {
  const bytes = new Uint8Array(size);
  const c = cryptoSource();
  if (c?.getRandomValues) {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < size; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (let i = 0; i < size; i += 1) out += ALPHABET[(bytes[i] as number) % 64];
  return out;
}

/** Prefixed, human recognisable ids: `soc_9xK2…`, `vis_…`, `pay_…`. */
export function prefixedId(prefix: string, size = 18): string {
  return `${prefix}_${randomId(size)}`;
}

/** Numeric OTP of `length` digits, never starting with a leading-zero-only string. */
export function generateOtp(length = 6): string {
  const c = cryptoSource();
  const bytes = new Uint8Array(length);
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  let out = '';
  for (let i = 0; i < length; i += 1) out += String((bytes[i] as number) % 10);
  return out;
}

/** Deterministic reference numbers for invoices/receipts: `INV-2026-000123`. */
export function sequentialRef(prefix: string, year: number, seq: number, pad = 6): string {
  return `${prefix}-${year}-${String(seq).padStart(pad, '0')}`;
}

/* ------------------------------- pagination ------------------------------ */

export interface PaginationInput {
  page?: number | string | null;
  limit?: number | string | null;
  sortBy?: string | null;
  sortDir?: 'asc' | 'desc' | string | null;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
  sortBy: string;
  sortDir: 'asc' | 'desc';
}

export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 200;

/**
 * Normalise pagination + sorting from an untrusted query string.
 * The `allowedSort` whitelist prevents arbitrary field sorting (which would defeat indexes).
 */
export function parsePagination(
  input: PaginationInput = {},
  opts: { allowedSort?: readonly string[]; defaultSort?: string } = {},
): { page: number; limit: number; skip: number; sortBy: string; sortDir: 'asc' | 'desc' } {
  const { allowedSort, defaultSort = 'createdAt' } = opts;
  const page = Math.max(1, Number.parseInt(String(input.page ?? DEFAULT_PAGE), 10) || DEFAULT_PAGE);
  const rawLimit = Number.parseInt(String(input.limit ?? DEFAULT_LIMIT), 10) || DEFAULT_LIMIT;
  const limit = Math.min(MAX_LIMIT, Math.max(1, rawLimit));

  let sortBy = String(input.sortBy ?? defaultSort);
  if (allowedSort && allowedSort.length > 0 && !allowedSort.includes(sortBy)) sortBy = defaultSort;
  const sortDir: 'asc' | 'desc' = String(input.sortDir ?? 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';

  return { page, limit, skip: (page - 1) * limit, sortBy, sortDir };
}

export function buildMeta(
  total: number,
  page: number,
  limit: number,
  sortBy = 'createdAt',
  sortDir: 'asc' | 'desc' = 'desc',
): PaginationMeta {
  const totalPages = limit > 0 ? Math.max(1, Math.ceil(total / limit)) : 1;
  return {
    page,
    limit,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
    sortBy,
    sortDir,
  };
}

/* --------------------------------- misc --------------------------------- */

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

export function toArray<T>(v: T | T[] | null | undefined): T[] {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

export function unique<T>(items: readonly T[]): T[] {
  return Array.from(new Set(items));
}

export function groupBy<T, K extends string>(items: readonly T[], key: (item: T) => K): Record<K, T[]> {
  const out = {} as Record<K, T[]>;
  for (const item of items) {
    const k = key(item);
    (out[k] ||= []).push(item);
  }
  return out;
}

export function sum(items: readonly number[]): number {
  return items.reduce((acc, n) => acc + (Number.isFinite(n) ? n : 0), 0);
}

export function round2(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
}

/** Safe deep read: `pick(obj, 'a.b.c')`. */
export function pick<T = unknown>(obj: unknown, path: string): T | undefined {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc === null || acc === undefined) return undefined;
    if (typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj) as T | undefined;
}

/** Chunk an array — used for batch DB writes and bulk notifications. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Constant-time-ish string compare for tokens (avoids leaking length/timing signals). */
export function safeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i += 1) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/** Strip keys that must never be serialised to a client. */
export const SENSITIVE_FIELDS = [
  'passwordHash',
  'password',
  'otpHash',
  'otp',
  'refreshTokenHash',
  'tokenHash',
  'pinHash',
  'secret',
  'gatewaySecret',
  'apiKey',
] as const;

export function omitSensitive<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if ((SENSITIVE_FIELDS as readonly string[]).includes(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Build a Mongo-style text search regex, escaping user input. */
export function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
