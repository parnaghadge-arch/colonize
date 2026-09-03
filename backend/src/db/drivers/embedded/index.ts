import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { getCollection, NEVER_SERIALISE } from '../../registry/index.js';
import type { CollectionDef } from '../../registry/fields.js';
import { newId } from '../../ids.js';
import { logger } from '../../../config/logger.js';
import {
  applyUpdate,
  matches,
  projectDocument,
  runAggregate,
  sortDocuments,
  deepEqual,
  getPath,
} from './query.js';
import type {
  Collection,
  DeleteResult,
  Document,
  Filter,
  FindOptions,
  OperationOptions,
  Pipeline,
  SessionHandle,
  TenantDatabase,
  Update,
  UpdateOptions,
  UpdateResult,
} from '../types.js';

/**
 * Embedded persistence engine.
 *
 * A real, durable document store that speaks Mongo semantics, used where a `mongod` binary
 * cannot be obtained (this sandbox, air-gapped CI). Data is kept in memory for speed and
 * flushed to `<EMBEDDED_DATA_DIR>/<dbName>/<collection>.json` (debounced + on shutdown),
 * so restarts keep state.
 *
 * Guarantees implemented here, because business logic relies on them identically on MongoDB:
 *   • unique indexes are enforced atomically within a write
 *   • `timestamps` collections get createdAt/updatedAt
 *   • `softDelete` collections get `deletedAt: null` and every default query filters them out
 *   • reads return deep clones — a caller can never mutate stored state by accident
 *   • transactions snapshot the touched collections and roll back on error
 */

/* ------------------------------- serialisation ---------------------------- */

const DATE_MARKER = '$__date';

function encode(value: unknown): unknown {
  if (value instanceof Date) return { [DATE_MARKER]: value.toISOString() };
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = encode(v);
    return out;
  }
  return value;
}

function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 1 && entries[0]?.[0] === DATE_MARKER) {
      return new Date(String(entries[0][1]));
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = decode(v);
    return out;
  }
  return value;
}

const clone = <T>(value: T): T => decode(encode(value)) as T;

/* ---------------------------------- store --------------------------------- */

interface StoreOptions {
  dataDir: string;
  persist: boolean;
}

export class EmbeddedStore {
  private readonly collections = new Map<string, Document[]>();
  private readonly dirty = new Set<string>();
  private flushTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    readonly dbName: string,
    private readonly opts: StoreOptions,
  ) {}

  private get dir(): string {
    return path.join(this.opts.dataDir, this.dbName.replace(/[^A-Za-z0-9_-]/g, '_'));
  }

  list(): Document[] {
    const out: Document[] = [];
    for (const docs of this.collections.values()) out.push(...docs);
    return out;
  }

  collection(name: string): Document[] {
    let docs = this.collections.get(name);
    if (!docs) {
      docs = this.opts.persist ? this.loadFromDisk(name) : [];
      this.collections.set(name, docs);
    }
    return docs;
  }

  private loadFromDisk(name: string): Document[] {
    const file = path.join(this.dir, `${name}.json`);
    if (!fs.existsSync(file)) return [];
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      return (decode(parsed) as Document[]) ?? [];
    } catch (err) {
      logger.error({ err, file }, 'embedded-store: failed to read collection, starting empty');
      return [];
    }
  }

  markDirty(name: string): void {
    if (!this.opts.persist || this.closed) return;
    this.dirty.add(name);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      void this.flush();
    }, 250);
    // Never keep the event loop alive just for a pending write.
    this.flushTimer.unref?.();
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.opts.persist || this.dirty.size === 0) return;
    const names = Array.from(this.dirty);
    this.dirty.clear();
    try {
      await fsp.mkdir(this.dir, { recursive: true });
      await Promise.all(
        names.map(async (name) => {
          const docs = this.collections.get(name) ?? [];
          const file = path.join(this.dir, `${name}.json`);
          const tmp = `${file}.tmp`;
          await fsp.writeFile(tmp, JSON.stringify(encode(docs)), 'utf8');
          await fsp.rename(tmp, file);
        }),
      );
    } catch (err) {
      logger.error({ err, db: this.dbName }, 'embedded-store: flush failed');
      // Re-mark so the next write retries the flush.
      names.forEach((n) => this.dirty.add(n));
    }
  }

  async drop(): Promise<void> {
    this.collections.clear();
    this.dirty.clear();
    if (this.opts.persist) await fsp.rm(this.dir, { recursive: true, force: true });
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }

  /** Names of collections currently materialised in memory. */
  knownCollections(): string[] {
    return Array.from(this.collections.keys());
  }

  /**
   * Resolve another collection's documents on demand (used by `$lookup`). Loading is lazy
   * so a database with 60 collections does not read them all into memory up front.
   */
  getCollectionDocs(name: string): Document[] {
    return this.collection(name);
  }

  stats(): { collections: number; documents: number; sizeBytes: number } {
    let documents = 0;
    let sizeBytes = 0;
    for (const docs of this.collections.values()) {
      documents += docs.length;
      for (const d of docs) sizeBytes += JSON.stringify(encode(d)).length;
    }
    return { collections: this.collections.size, documents, sizeBytes };
  }

  /** Snapshot + restore used by the transaction shim. */
  snapshot(names: string[]): Map<string, Document[]> {
    const snap = new Map<string, Document[]>();
    for (const name of names) snap.set(name, this.collection(name).map((d) => clone(d)));
    return snap;
  }

  restore(snapshot: Map<string, Document[]>): void {
    for (const [name, docs] of snapshot) {
      this.collections.set(name, docs);
      this.markDirty(name);
    }
  }
}

/* -------------------------------- collection ------------------------------ */

function resolveDefaults(def: CollectionDef, doc: Document): Document {
  const out: Document = { ...doc };
  for (const [field, spec] of Object.entries(def.fields)) {
    if (out[field] !== undefined) continue;
    if (spec.default !== undefined) {
      out[field] = typeof spec.default === 'function' ? (spec.default as () => unknown)() : clone(spec.default);
    } else if (spec.type === 'array') {
      out[field] = [];
    } else if (def.softDelete && field === 'deletedAt') {
      out[field] = null;
    }
  }
  return out;
}

/** Light coercion so a string date from JSON becomes a real Date, numbers become numbers. */
function coerce(def: CollectionDef, doc: Document): Document {
  const out: Document = { ...doc };
  for (const [field, spec] of Object.entries(def.fields)) {
    const value = out[field];
    if (value === undefined || value === null) continue;
    if (spec.type === 'date' && !(value instanceof Date)) {
      const d = new Date(value as string | number);
      if (!Number.isNaN(d.getTime())) out[field] = d;
    } else if (spec.type === 'number' && typeof value !== 'number') {
      const n = Number(value);
      if (Number.isFinite(n)) out[field] = n;
    } else if (spec.type === 'boolean' && typeof value !== 'boolean') {
      out[field] = value === true || value === 'true' || value === 1;
    } else if (spec.type === 'string' && typeof value === 'string') {
      let v = value;
      if (spec.trim) v = v.trim();
      if (spec.lowercase) v = v.toLowerCase();
      out[field] = v;
    }
  }
  return out;
}

function validateRequired(def: CollectionDef, doc: Document): void {
  const missing: string[] = [];
  for (const [field, spec] of Object.entries(def.fields)) {
    if (spec.required && (doc[field] === undefined || doc[field] === null || doc[field] === '')) {
      missing.push(field);
    }
  }
  if (missing.length > 0) {
    throw new Error(`[${def.name}] missing required field(s): ${missing.join(', ')}`);
  }
}

export class EmbeddedCollection<T extends Document = Document> implements Collection<T> {
  constructor(
    readonly name: string,
    private readonly store: EmbeddedStore,
    private readonly def: CollectionDef,
  ) {}

  private get docs(): Document[] {
    return this.store.collection(this.name);
  }

  private withSoftDeleteFilter(filter: Filter = {}, opts?: OperationOptions): Filter {
    if (!this.def.softDelete) return filter;
    if (opts?.includeDeleted) return filter;
    if (filter.deletedAt !== undefined) return filter;
    // Match both `null` and "field absent" — Mongo's `{deletedAt: null}` already does both.
    return { ...filter, deletedAt: null };
  }

  private checkUniqueIndexes(candidate: Document, ignoreId?: string): void {
    for (const index of this.def.indexes ?? []) {
      if (!index.unique) continue;
      const keys = Object.keys(index.fields);
      const values = keys.map((k) => getPath(candidate, k));
      // Sparse unique indexes ignore documents where any key is null/undefined/''.
      const isSparseCandidate = values.some((v) => v === null || v === undefined || v === '');
      if (index.sparse && isSparseCandidate) continue;
      const filter: Filter = {};
      keys.forEach((k, i) => {
        filter[k] = values[i] === undefined ? null : values[i];
      });
      const clash = this.docs.find(
        (d) => d._id !== ignoreId && matches(d, filter),
      );
      if (clash) {
        const detail = keys.map((k, i) => `${k}=${String(values[i])}`).join(', ');
        const err = new Error(`E11000 duplicate key error collection: ${this.name} index: ${keys.join('_')} (${detail})`);
        (err as Error & { code?: number }).code = 11000;
        throw err;
      }
    }
    // `unique: true` declared directly on a field.
    for (const [field, spec] of Object.entries(this.def.fields)) {
      if (!spec.unique) continue;
      const value = candidate[field];
      if (value === undefined || value === null || value === '') continue;
      const clash = this.docs.find((d) => d._id !== ignoreId && d[field] === value);
      if (clash) {
        const err = new Error(`E11000 duplicate key error collection: ${this.name} index: ${field}_1 (${field}=${String(value)})`);
        (err as Error & { code?: number }).code = 11000;
        throw err;
      }
    }
  }

  private stamp(doc: Document, isCreate: boolean): Document {
    const now = new Date();
    if (this.def.timestamps) {
      if (isCreate && !doc.createdAt) doc.createdAt = now;
      doc.updatedAt = now;
    }
    if (this.def.softDelete && isCreate && doc.deletedAt === undefined) doc.deletedAt = null;
    return doc;
  }

  async create(doc: Partial<T>, opts?: OperationOptions): Promise<T> {
    const withId = { ...(doc as Document) };
    if (!withId._id) withId._id = newId(this.name);
    let prepared = resolveDefaults(this.def, withId);
    prepared = coerce(this.def, prepared);
    validateRequired(this.def, prepared);
    if (!opts?.skipUniqueCheck) this.checkUniqueIndexes(prepared);
    prepared = this.stamp(prepared, true);
    const stored = clone(prepared);
    this.docs.push(stored);
    this.store.markDirty(this.name);
    return clone(stored) as T;
  }

  async insertMany(docs: Partial<T>[], opts?: OperationOptions): Promise<T[]> {
    const created: T[] = [];
    for (const doc of docs) created.push(await this.create(doc, opts));
    return created;
  }

  private query(filter: Filter, opts?: FindOptions): Document[] {
    const effective = this.withSoftDeleteFilter(filter, opts);
    let result = this.docs.filter((d) => matches(d, effective));
    if (opts?.sort) result = sortDocuments(result, opts.sort);
    if (opts?.skip) result = result.slice(opts.skip);
    if (opts?.limit !== undefined && opts.limit >= 0) result = result.slice(0, opts.limit);
    if (opts?.projection) result = result.map((d) => projectDocument(d, opts.projection as Record<string, 0 | 1>));
    return result.map((d) => clone(d));
  }

  async findOne(filter: Filter = {}, opts?: FindOptions): Promise<T | null> {
    const found = this.query(filter, { ...opts, limit: opts?.limit ?? 1 });
    return (found[0] as T) ?? null;
  }

  async find(filter: Filter = {}, opts?: FindOptions): Promise<T[]> {
    return this.query(filter, opts) as T[];
  }

  async findById(id: string, opts?: FindOptions): Promise<T | null> {
    return this.findOne({ _id: id }, opts);
  }

  async countDocuments(filter: Filter = {}, opts?: OperationOptions): Promise<number> {
    const effective = this.withSoftDeleteFilter(filter, opts);
    return this.docs.filter((d) => matches(d, effective)).length;
  }

  async estimatedCount(): Promise<number> {
    return this.docs.length;
  }

  async distinct(field: string, filter: Filter = {}, opts?: OperationOptions): Promise<unknown[]> {
    const effective = this.withSoftDeleteFilter(filter, opts);
    const seen = new Set<unknown>();
    for (const d of this.docs) {
      if (!matches(d, effective)) continue;
      const value = getPath(d, field);
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) value.forEach((v) => seen.add(v));
      else seen.add(value);
    }
    return Array.from(seen);
  }

  private performUpdate(
    filter: Filter,
    update: Update,
    opts: UpdateOptions,
    multi: boolean,
  ): { matched: number; modified: number; upsertedId?: string; first?: Document } {
    const effective = this.withSoftDeleteFilter(filter, opts);
    const targets = this.docs.filter((d) => matches(d, effective));
    const selected = multi ? targets : targets.slice(0, 1);

    if (selected.length === 0) {
      if (!opts.upsert) return { matched: 0, modified: 0 };
      // Build the insert document from equality clauses in the filter.
      const seed: Document = {};
      for (const [key, value] of Object.entries(filter)) {
        if (key.startsWith('$')) continue;
        if (value && typeof value === 'object') continue; // operator clause — not a literal
        seed[key] = value;
      }
      if (!seed._id) seed._id = newId(this.name);
      let doc = resolveDefaults(this.def, seed);
      doc = coerce(this.def, doc);
      applyUpdate(doc, update, { isInsert: true });
      doc = this.stamp(doc, true);
      validateRequired(this.def, doc);
      this.checkUniqueIndexes(doc);
      const stored = clone(doc);
      this.docs.push(stored);
      this.store.markDirty(this.name);
      return { matched: 0, modified: 1, upsertedId: String(stored._id), first: clone(stored) };
    }

    let modified = 0;
    let first: Document | undefined;
    for (const target of selected) {
      const before = clone(target);
      const working = clone(target);
      const changed = applyUpdate(working, update, {});
      if (this.def.timestamps) working.updatedAt = new Date();
      if (changed || !deepEqual(before, working)) {
        this.checkUniqueIndexes(working, String(working._id));
        Object.assign(target, working);
        modified += 1;
      }
      if (!first) first = opts.returnDocument === 'before' ? before : clone(target);
    }
    if (modified > 0) this.store.markDirty(this.name);
    return { matched: selected.length, modified, first };
  }

  async updateOne(filter: Filter, update: Update, opts: UpdateOptions = {}): Promise<UpdateResult> {
    const { matched, modified, upsertedId } = this.performUpdate(filter, update, opts, false);
    return { matched, modified, upsertedId };
  }

  async updateMany(filter: Filter, update: Update, opts: UpdateOptions = {}): Promise<UpdateResult> {
    const { matched, modified } = this.performUpdate(filter, update, opts, true);
    return { matched, modified };
  }

  async findOneAndUpdate(filter: Filter, update: Update, opts: UpdateOptions = {}): Promise<T | null> {
    const result = this.performUpdate(filter, update, { returnDocument: 'after', ...opts }, false);
    return (result.first as T) ?? null;
  }

  async findByIdAndUpdate(id: string, update: Update, opts: UpdateOptions = {}): Promise<T | null> {
    return this.findOneAndUpdate({ _id: id }, update, { returnDocument: 'after', ...opts });
  }

  async deleteOne(filter: Filter, opts: OperationOptions = {}): Promise<DeleteResult> {
    if (this.def.softDelete && !opts.includeDeleted) {
      // Soft delete: honour the contract without callers having to know which driver is live.
      const res = this.performUpdate(filter, { $set: { deletedAt: new Date() } }, {}, false);
      return { deleted: res.modified };
    }
    const effective = this.withSoftDeleteFilter(filter, opts);
    const index = this.docs.findIndex((d) => matches(d, effective));
    if (index === -1) return { deleted: 0 };
    this.docs.splice(index, 1);
    this.store.markDirty(this.name);
    return { deleted: 1 };
  }

  async deleteMany(filter: Filter, opts: OperationOptions = {}): Promise<DeleteResult> {
    if (this.def.softDelete && !opts.includeDeleted) {
      const res = this.performUpdate(filter, { $set: { deletedAt: new Date() } }, {}, true);
      return { deleted: res.modified };
    }
    const effective = this.withSoftDeleteFilter(filter, opts);
    const before = this.docs.length;
    const kept = this.docs.filter((d) => !matches(d, effective));
    this.collections_replace(kept);
    return { deleted: before - kept.length };
  }

  private collections_replace(kept: Document[]): void {
    const docs = this.docs;
    docs.length = 0;
    docs.push(...kept);
    this.store.markDirty(this.name);
  }

  async findByIdAndDelete(id: string, opts: OperationOptions = {}): Promise<T | null> {
    const existing = await this.findById(id, opts);
    if (!existing) return null;
    await this.deleteOne({ _id: id }, { ...opts, includeDeleted: true });
    return existing;
  }

  async aggregate<R = Document>(pipeline: Pipeline, _opts?: OperationOptions): Promise<R[]> {
    const effective = this.def.softDelete
      ? [{ $match: { deletedAt: null } }, ...pipeline]
      : pipeline;
    return runAggregate(
      this.docs,
      effective,
      { getCollectionDocs: (name) => this.store.getCollectionDocs(name) },
      this.name,
    ) as R[];
  }

  async ensureIndexes(): Promise<void> {
    // Indexes are logical here: uniqueness is enforced in `checkUniqueIndexes`.
    return;
  }
}

/* --------------------------------- database -------------------------------- */

export class EmbeddedDatabase implements TenantDatabase {
  readonly kind = 'embedded' as const;
  /** True because the transaction shim snapshots + restores collections atomically. */
  readonly supportsTransactions = true;
  private readonly collections = new Map<string, EmbeddedCollection>();

  constructor(
    readonly name: string,
    private readonly store: EmbeddedStore,
  ) {}

  collection<T extends Document = Document>(collectionName: string): Collection<T> {
    const existing = this.collections.get(collectionName);
    if (existing) return existing as unknown as Collection<T>;
    const def = getCollection(collectionName);
    const created = new EmbeddedCollection<T>(collectionName, this.store, def);
    this.collections.set(collectionName, created as unknown as EmbeddedCollection);
    return created;
  }

  hasCollection(collectionName: string): boolean {
    try {
      getCollection(collectionName);
      return true;
    } catch {
      return false;
    }
  }

  async listCollections(): Promise<string[]> {
    return Array.from(this.store.knownCollections());
  }

  async startSession(): Promise<SessionHandle> {
    return { id: `embedded_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, ended: false };
  }

  /**
   * Snapshot-based transaction. All writes inside `fn` are visible to reads in the same
   * function (they hit the live arrays), and any throw restores the snapshot — the same
   * observable contract the Mongo driver provides through a real transaction.
   */
  async withTransaction<R>(fn: (session: SessionHandle) => Promise<R>): Promise<R> {
    const snapshot = this.store.snapshot(this.store.knownCollections());
    const session = await this.startSession();
    try {
      const result = await fn(session);
      return result;
    } catch (err) {
      this.store.restore(snapshot);
      throw err;
    }
  }

  async drop(): Promise<void> {
    this.collections.clear();
    await this.store.drop();
  }

  async close(): Promise<void> {
    await this.store.close();
  }

  async stats(): Promise<{ collections: number; documents: number; sizeBytes: number }> {
    return this.store.stats();
  }
}

export function createEmbeddedStore(dbName: string, dataDir: string, persist: boolean): EmbeddedStore {
  return new EmbeddedStore(dbName, { dataDir, persist });
}

export function createEmbeddedDatabase(dbName: string, store: EmbeddedStore): EmbeddedDatabase {
  return new EmbeddedDatabase(dbName, store);
}

/** Fields that must never be serialised (re-exported for the driver layer). */
export { NEVER_SERIALISE };
