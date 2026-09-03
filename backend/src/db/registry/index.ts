import { PLATFORM_COLLECTIONS } from './platform.js';
import { TENANT_COLLECTIONS } from './tenant.js';
import type { CollectionDef, Registry } from './fields.js';

export * from './fields.js';
export { PLATFORM_COLLECTIONS, TENANT_COLLECTIONS };

/** Every collection known to the platform, keyed by name. */
export const ALL_COLLECTIONS: Registry = { ...PLATFORM_COLLECTIONS, ...TENANT_COLLECTIONS };

export const PLATFORM_COLLECTION_NAMES = Object.keys(PLATFORM_COLLECTIONS);
export const TENANT_COLLECTION_NAMES = Object.keys(TENANT_COLLECTIONS);

export function getCollection(name: string): CollectionDef {
  const def = ALL_COLLECTIONS[name];
  if (!def) throw new Error(`Unknown collection "${name}" — add it to the schema registry first.`);
  return def;
}

/**
 * Fields that hold a reference to another collection. Used by the search index, by cascade
 * checks before a delete, and by generated API documentation.
 */
export function referenceFields(def: CollectionDef): { field: string; target: string }[] {
  return Object.entries(def.fields)
    .filter(([, f]) => Boolean(f.ref))
    .map(([field, f]) => ({ field, target: f.ref as string }));
}

/** Fields that must never be returned to a client (secrets / PII at rest). */
export const NEVER_SERIALISE = new Set([
  'passwordHash',
  'appPinHash',
  'otpHash',
  'refreshTokenHash',
  'tokenHash',
  'invitationTokenHash',
  'sign',
  'bankAccountNumber',
  'idProofNumber',
  'requestHash',
  'checksum',
]);

/** Fields that are masked (not removed) when serialised. */
export const MASKED_FIELDS = new Set(['bankAccountNumber', 'idProofNumber', 'phone', 'email']);
