/**
 * Schema registry primitives.
 *
 * The registry is the ONE place a collection's shape is declared. Two drivers compile from
 * it:
 *   - `mongo`    → a real Mongoose schema (typed fields, indexes, TTL)
 *   - `embedded` → defaults, type coercion and unique-index enforcement
 *
 * Keeping the definition driver-agnostic is what makes the two backends behave identically
 * instead of drifting apart over time.
 *
 * Identifier strategy (deliberate): every document uses an application-generated **prefixed
 * string `_id`** (e.g. `unit_9xK2…`). Benefits: identical semantics across drivers, no
 * ObjectId/string casting bugs at tenant boundaries, human-readable ids in logs, URLs and
 * audit trails. Ordering is always done on the indexed `createdAt`, never on `_id`.
 */

export type FieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'mixed'
  | 'array';

export interface FieldDef {
  type: FieldType;
  required?: boolean;
  default?: unknown | (() => unknown);
  enum?: readonly string[];
  index?: boolean;
  unique?: boolean;
  sparse?: boolean;
  min?: number;
  max?: number;
  trim?: boolean;
  lowercase?: boolean;
  /** Logical reference — documentation + used by the search/report layers. */
  ref?: string;
  /** Free-form description surfaced in generated API docs. */
  description?: string;
}

export interface IndexDef {
  fields: Record<string, 1 | -1>;
  unique?: boolean;
  sparse?: boolean;
  name?: string;
  expireAfterSeconds?: number;
  partialFilterExpression?: Record<string, unknown>;
}

export type CollectionScope = 'platform' | 'tenant';

export interface CollectionDef {
  /** Mongo collection name (snake_case, matching §53). */
  name: string;
  scope: CollectionScope;
  fields: Record<string, FieldDef>;
  indexes?: IndexDef[];
  /** Adds `createdAt` / `updatedAt` maintained by the driver. */
  timestamps?: boolean;
  /** Adds `deletedAt`; soft-deleted docs are excluded from every default query. */
  softDelete?: boolean;
  description?: string;
}

/* ------------------------------- field helpers ---------------------------- */

export const S = (opts: Partial<FieldDef> = {}): FieldDef => ({ type: 'string', ...opts });
export const N = (opts: Partial<FieldDef> = {}): FieldDef => ({ type: 'number', ...opts });
export const B = (opts: Partial<FieldDef> = {}): FieldDef => ({ type: 'boolean', ...opts });
export const D = (opts: Partial<FieldDef> = {}): FieldDef => ({ type: 'date', ...opts });
export const X = (opts: Partial<FieldDef> = {}): FieldDef => ({ type: 'mixed', ...opts });
export const A = (opts: Partial<FieldDef> = {}): FieldDef => ({ type: 'array', default: [], ...opts });

/** A reference to another document's string id. */
export const ref = (target: string, opts: Partial<FieldDef> = {}): FieldDef =>
  S({ index: true, ref: target, ...opts });

/**
 * Fields present on (almost) every tenant record, per §4:
 * societyId, buildingId, wingId, unitId, createdBy, updatedBy, createdAt, updatedAt, deletedAt.
 *
 * `societyId` is written by the tenant middleware from the **JWT**, never from the request
 * body, and is additionally used as the first field of every compound index so a query that
 * forgets the tenant filter still cannot scan another society's rows.
 */
export const tenantFields = (): Record<string, FieldDef> => ({
  societyId: S({ required: true, index: true, description: 'Owning society (from JWT, never from the client)' }),
  buildingId: ref('buildings'),
  wingId: ref('wings'),
  floorId: ref('floors'),
  unitId: ref('units'),
  createdBy: ref('users'),
  updatedBy: ref('users'),
});

export const softDeleteField = (): Record<string, FieldDef> => ({
  deletedAt: D({ index: true, description: 'Set on soft delete; null while the record is live' }),
});

/** Build a collection definition with the tenant/audit/soft-delete conventions applied. */
export function defineCollection(
  name: string,
  fields: Record<string, FieldDef>,
  opts: {
    indexes?: IndexDef[];
    softDelete?: boolean;
    timestamps?: boolean;
    description?: string;
    scope?: CollectionScope;
  } = {},
): CollectionDef {
  const { indexes = [], softDelete = true, timestamps = true, description, scope = 'tenant' } = opts;
  const all: Record<string, FieldDef> = {
    _id: S({ required: true, description: 'Application-generated prefixed identifier' }),
    ...(scope === 'tenant' ? tenantFields() : {}),
    ...fields,
    ...(timestamps
      ? {
          createdAt: D({ index: true, description: 'Creation time (UTC)' }),
          updatedAt: D({ description: 'Last modification time (UTC)' }),
        }
      : {}),
    ...(softDelete ? softDeleteField() : {}),
  };
  return { name, scope, fields: all, indexes, timestamps, softDelete, description };
}

/** Registry lookup helpers used by the drivers and by generated docs. */
export type Registry = Record<string, CollectionDef>;

export function listCollections(registry: Registry, scope?: CollectionScope): CollectionDef[] {
  return Object.values(registry).filter((c) => !scope || c.scope === scope);
}
