import mongoose from 'mongoose';
import type { Connection, Model as MongooseModel, Schema as MongooseSchema } from 'mongoose';
import { getCollectionForScope } from '../registry/index.js';
import type { CollectionDef, FieldDef } from '../registry/fields.js';
import { newId } from '../ids.js';
import { logger } from '../../config/logger.js';
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
} from './types.js';

/**
 * MongoDB driver (Mongoose).
 *
 * One `Connection` per society database. Models are compiled from the shared registry, so
 * the schema in MongoDB is exactly the schema the embedded engine enforces.
 *
 * Every read is `.lean()` and returns plain objects with string `_id`s — the same shape the
 * embedded driver returns. Services therefore never know which driver is live.
 *
 * Connection growth is bounded by an LRU: idle society connections are closed when the cache
 * exceeds `maxCachedConnections`, which keeps a multi-tenant deployment predictable.
 */

mongoose.set('strictQuery', true);

function fieldToSchemaType(field: FieldDef): unknown {
  const base: Record<string, unknown> = {};
  if (field.required) base.required = true;
  if (field.enum) base.enum = field.enum;
  if (field.default !== undefined) {
    base.default = typeof field.default === 'function' ? field.default : field.default;
  }
  if (field.min !== undefined) base.min = field.min;
  if (field.max !== undefined) base.max = field.max;
  if (field.unique) base.unique = true;
  if (field.sparse) base.sparse = true;
  if (field.trim) base.trim = true;
  if (field.lowercase) base.lowercase = true;

  switch (field.type) {
    case 'string':
      return Object.keys(base).length ? { type: String, ...base } : String;
    case 'number':
      return Object.keys(base).length ? { type: Number, ...base } : Number;
    case 'boolean':
      return Object.keys(base).length ? { type: Boolean, ...base } : Boolean;
    case 'date':
      return Object.keys(base).length ? { type: Date, ...base } : Date;
    case 'array':
      return { type: mongoose.Schema.Types.Mixed, default: field.default ?? [] };
    case 'mixed':
    default:
      return { type: mongoose.Schema.Types.Mixed, ...base };
  }
}

export function buildSchema(def: CollectionDef): MongooseSchema {
  const shape: Record<string, unknown> = {};
  for (const [field, spec] of Object.entries(def.fields)) {
    if (field === '_id') continue;
    if (def.timestamps && (field === 'createdAt' || field === 'updatedAt')) continue;
    if (def.softDelete && field === 'deletedAt') {
      shape.deletedAt = { type: Date, default: null, index: true };
      continue;
    }
    shape[field] = fieldToSchemaType(spec);
  }

  const schema = new mongoose.Schema(shape, {
    collection: def.name,
    versionKey: false,
    timestamps: Boolean(def.timestamps),
    minimize: false,
    strict: true,
    id: false,
    toObject: { virtuals: false, getters: false },
    toJSON: { virtuals: false, getters: false },
  });

  for (const index of def.indexes ?? []) {
    const opts: Record<string, unknown> = {};
    if (index.unique) opts.unique = true;
    if (index.sparse) opts.sparse = true;
    if (index.name) opts.name = index.name;
    if (index.expireAfterSeconds !== undefined) opts.expireAfterSeconds = index.expireAfterSeconds;
    if (index.partialFilterExpression) opts.partialFilterExpression = index.partialFilterExpression;
    try {
      schema.index(index.fields, opts);
    } catch (err) {
      logger.warn({ err, collection: def.name, index }, 'mongo-driver: skipped unsupported index definition');
    }
  }

  return schema;
}

/* ------------------------------- collection ------------------------------- */

// The Mongoose model is intentionally typed as `any` at this boundary: the driver's public
// contract (`Collection<T>`) is what services see, and Mongoose's deeply-generic query types
// would otherwise leak into every call site without adding real safety.
type AnyModel = MongooseModel<any>;

class MongoCollection<T extends Document = Document> implements Collection<T> {
  constructor(
    readonly name: string,
    private readonly model: AnyModel,
    private readonly def: CollectionDef,
  ) {}

  private withSoftDeleteFilter(filter: Filter = {}, opts?: OperationOptions): Filter {
    if (!this.def.softDelete) return filter;
    if (opts?.includeDeleted) return filter;
    if (filter.deletedAt !== undefined) return filter;
    return { ...filter, deletedAt: null };
  }

  private session(opts?: OperationOptions): Record<string, unknown> {
    return opts?.session?.raw ? { session: opts.session.raw } : {};
  }

  async create(doc: Partial<T>, opts?: OperationOptions): Promise<T> {
    const payload = { ...(doc as Document) };
    if (!payload._id) payload._id = newId(this.name);
    const created = await this.model.create([payload], this.session(opts));
    const first = Array.isArray(created) ? created[0] : created;
    return first.toObject({ versionKey: false }) as T;
  }

  async insertMany(docs: Partial<T>[], opts?: OperationOptions): Promise<T[]> {
    const payload = docs.map((d) => ({ ...(d as Document), _id: (d as Document)._id ?? newId(this.name) }));
    const created = await this.model.insertMany(payload, { ordered: true, ...this.session(opts) });
    return created.map((d) => d.toObject({ versionKey: false })) as T[];
  }

  async findOne(filter: Filter = {}, opts?: FindOptions): Promise<T | null> {
    const effective = this.withSoftDeleteFilter(filter, opts);
    let q: any = this.model.findOne(effective).lean().setOptions(this.session(opts));
    if (opts?.projection) q = q.select(opts.projection);
    if (opts?.sort) q = q.sort(opts.sort);
    if (opts?.skip) q = q.skip(opts.skip);
    if (opts?.limit !== undefined && opts.limit >= 0) q = q.limit(Math.max(1, opts.limit));
    return ((await q.exec()) as T) ?? null;
  }

  async find(filter: Filter = {}, opts?: FindOptions): Promise<T[]> {
    const effective = this.withSoftDeleteFilter(filter, opts);
    let q: any = this.model.find(effective).lean().setOptions(this.session(opts));
    if (opts?.projection) q = q.select(opts.projection);
    if (opts?.sort) q = q.sort(opts.sort);
    if (opts?.skip) q = q.skip(opts.skip);
    if (opts?.limit !== undefined && opts.limit >= 0) q = q.limit(opts.limit);
    return ((await q.exec()) as T[]) ?? [];
  }

  async findById(id: string, opts?: FindOptions): Promise<T | null> {
    return this.findOne({ _id: id }, opts);
  }

  async countDocuments(filter: Filter = {}, opts?: OperationOptions): Promise<number> {
    const effective = this.withSoftDeleteFilter(filter, opts);
    return this.model.countDocuments(effective).setOptions(this.session(opts)).exec();
  }

  async estimatedCount(): Promise<number> {
    return this.model.estimatedDocumentCount().exec();
  }

  async distinct(field: string, filter: Filter = {}, opts?: OperationOptions): Promise<unknown[]> {
    const effective = this.withSoftDeleteFilter(filter, opts);
    return this.model.distinct(field, effective).setOptions(this.session(opts)).exec();
  }

  async updateOne(filter: Filter, update: Update, opts: UpdateOptions = {}): Promise<UpdateResult> {
    const effective = this.withSoftDeleteFilter(filter, opts);
    const res = await this.model
      .updateOne(effective, update)
      .setOptions({ upsert: Boolean(opts.upsert), ...this.session(opts) })
      .exec();
    return {
      matched: res.matchedCount ?? 0,
      modified: res.modifiedCount ?? 0,
      upsertedId: res.upsertedId ? String(res.upsertedId) : undefined,
    };
  }

  async updateMany(filter: Filter, update: Update, opts: UpdateOptions = {}): Promise<UpdateResult> {
    const effective = this.withSoftDeleteFilter(filter, opts);
    const res = await this.model
      .updateMany(effective, update)
      .setOptions({ upsert: Boolean(opts.upsert), ...this.session(opts) })
      .exec();
    return { matched: res.matchedCount ?? 0, modified: res.modifiedCount ?? 0 };
  }

  async findOneAndUpdate(filter: Filter, update: Update, opts: UpdateOptions = {}): Promise<T | null> {
    const effective = this.withSoftDeleteFilter(filter, opts);
    const doc = await (this.model
      .findOneAndUpdate(effective, update, {
        new: (opts.returnDocument ?? 'after') === 'after',
        upsert: Boolean(opts.upsert),
      })
      .lean() as any)
      .setOptions(this.session(opts))
      .exec();
    return (doc as T) ?? null;
  }

  async findByIdAndUpdate(id: string, update: Update, opts: UpdateOptions = {}): Promise<T | null> {
    return this.findOneAndUpdate({ _id: id }, update, { returnDocument: 'after', ...opts });
  }

  async deleteOne(filter: Filter, opts: OperationOptions = {}): Promise<DeleteResult> {
    if (this.def.softDelete && !opts.includeDeleted) {
      const res = await this.updateOne(filter, { $set: { deletedAt: new Date() } }, opts);
      return { deleted: res.modified };
    }
    const effective = this.withSoftDeleteFilter(filter, opts);
    const res = await this.model.deleteOne(effective).setOptions(this.session(opts)).exec();
    return { deleted: res.deletedCount ?? 0 };
  }

  async deleteMany(filter: Filter, opts: OperationOptions = {}): Promise<DeleteResult> {
    if (this.def.softDelete && !opts.includeDeleted) {
      const res = await this.updateMany(filter, { $set: { deletedAt: new Date() } }, opts);
      return { deleted: res.modified };
    }
    const effective = this.withSoftDeleteFilter(filter, opts);
    const res = await this.model.deleteMany(effective).setOptions(this.session(opts)).exec();
    return { deleted: res.deletedCount ?? 0 };
  }

  async findByIdAndDelete(id: string, opts: OperationOptions = {}): Promise<T | null> {
    const existing = await this.findById(id, opts);
    if (!existing) return null;
    await this.deleteOne({ _id: id }, { ...opts, includeDeleted: true });
    return existing;
  }

  async aggregate<R = Document>(pipeline: Pipeline, opts?: OperationOptions): Promise<R[]> {
    const effective: Pipeline =
      this.def.softDelete && !opts?.includeDeleted ? [{ $match: { deletedAt: null } }, ...pipeline] : pipeline;
    const agg = this.model.aggregate<R>(effective as any);
    if (opts?.session?.raw) agg.session(opts.session.raw as any);
    return (await agg.exec()) as R[];
  }

  async ensureIndexes(): Promise<void> {
    await this.model.syncIndexes();
  }
}

/* --------------------------------- database -------------------------------- */

export interface MongoDatabaseOptions {
  uri: string;
  dbName: string;
  maxPoolSize?: number;
  /** Selects the schema registry: platform collections and tenant collections are not the same. */
  scope?: 'platform' | 'tenant';
}

export class MongoDatabase implements TenantDatabase {
  readonly kind = 'mongo' as const;
  private readonly collections = new Map<string, MongoCollection>();
  private connection: Connection | null = null;
  private readyPromise: Promise<Connection> | null = null;
  private _supportsTransactions = false;

  constructor(private readonly options: MongoDatabaseOptions) {}

  get name(): string {
    return this.options.dbName;
  }

  get scope(): 'platform' | 'tenant' | undefined {
    return this.options.scope;
  }

  get supportsTransactions(): boolean {
    return this._supportsTransactions;
  }

  async connect(): Promise<Connection> {
    if (this.connection && this.connection.readyState === mongoose.ConnectionStates.connected) {
      return this.connection;
    }
    if (this.readyPromise) return this.readyPromise;

    this.readyPromise = (async () => {
      const url = this.options.uri.replace(/\/[^/?]*(\?|$)/, `$1`).replace(/\/$/, '');
      const conn = await mongoose.createConnection(`${url}/${this.options.dbName}`, {
        maxPoolSize: this.options.maxPoolSize ?? 10,
        minPoolSize: 0,
        serverSelectionTimeoutMS: 10_000,
        retryWrites: true,
      }).asPromise();

      // Detect replica-set / transaction support once per connection.
      try {
        const hello = await conn.db?.command({ hello: 1 });
        this._supportsTransactions = Boolean(hello && ('setName' in hello || hello.msg === 'isdbgrid'));
      } catch {
        this._supportsTransactions = false;
      }

      this.connection = conn;
      logger.debug({ db: this.options.dbName, transactions: this._supportsTransactions }, 'mongo-driver: connected');
      return conn;
    })();

    try {
      return await this.readyPromise;
    } finally {
      this.readyPromise = null;
    }
  }

  private async modelFor(collectionName: string): Promise<{ model: MongooseModel<any>; def: CollectionDef }> {
    const conn = await this.connect();
    const def = getCollectionForScope(this.options.scope, collectionName);
    const existing = conn.models[collectionName];
    if (existing) return { model: existing, def };
    const schema = buildSchema(def);
    const model = conn.model(collectionName, schema, collectionName);
    return { model, def };
  }

  collection<T extends Document = Document>(collectionName: string): Collection<T> {
    const cached = this.collections.get(collectionName);
    if (cached) return cached as unknown as Collection<T>;
    const def = getCollectionForScope(this.options.scope, collectionName);
    // A lazily-resolved proxy: models need an async connection, but the Collection API is sync.
    const wrapper = new LazyMongoCollection<T>(collectionName, this, def);
    this.collections.set(collectionName, wrapper as unknown as MongoCollection);
    return wrapper;
  }

  /** Internal: resolve the real model (used by LazyMongoCollection). */
  async resolveModel(collectionName: string): Promise<MongooseModel<any>> {
    const { model } = await this.modelFor(collectionName);
    return model;
  }

  hasCollection(collectionName: string): boolean {
    try {
      getCollectionForScope(this.options.scope, collectionName);
      return true;
    } catch {
      return false;
    }
  }

  async listCollections(): Promise<string[]> {
    const conn = await this.connect();
    const cols = await conn.db?.listCollections().toArray();
    return (cols ?? []).map((c) => c.name);
  }

  async startSession(): Promise<SessionHandle> {
    const conn = await this.connect();
    const session = await conn.startSession();
    return { id: String(session.id?.id ?? `mongo_${Date.now()}`), raw: session, ended: false };
  }

  async withTransaction<R>(fn: (session: SessionHandle) => Promise<R>): Promise<R> {
    const conn = await this.connect();
    if (!this._supportsTransactions) {
      logger.warn(
        { db: this.name },
        'mongo-driver: transactions unavailable (standalone mongod). Executing sequentially without atomicity.',
      );
      const session = await this.startSession();
      try {
        return await fn(session);
      } finally {
        await (session.raw as mongoose.ClientSession)?.endSession().catch(() => undefined);
      }
    }
    const session = await conn.startSession();
    try {
      let result: R | undefined;
      await session.withTransaction(async () => {
        result = await fn({ id: String(session.id?.id ?? 'mongo_tx'), raw: session, ended: false });
      });
      return result as R;
    } finally {
      await session.endSession().catch(() => undefined);
    }
  }

  async drop(): Promise<void> {
    const conn = await this.connect();
    await conn.dropDatabase();
  }

  async close(): Promise<void> {
    this.collections.clear();
    if (this.connection) {
      await this.connection.close().catch(() => undefined);
      this.connection = null;
    }
  }

  async stats(): Promise<{ collections: number; documents: number; sizeBytes: number }> {
    const conn = await this.connect();
    const stats = await conn.db?.stats();
    return {
      collections: stats?.collections ?? 0,
      documents: Number(stats?.objects ?? 0),
      sizeBytes: Number(stats?.dataSize ?? 0),
    };
  }
}

/**
 * The `Collection` API is synchronous in its accessor (`db.collection(name)`), but a Mongoose
 * model requires an awaited connection. This thin wrapper resolves the model lazily on the
 * first operation and delegates everything else to `MongoCollection`.
 */
class LazyMongoCollection<T extends Document = Document> implements Collection<T> {
  private delegate: MongoCollection<T> | null = null;

  constructor(
    readonly name: string,
    private readonly db: MongoDatabase,
    private readonly def: CollectionDef,
  ) {}

  private async target(): Promise<MongoCollection<T>> {
    if (this.delegate) return this.delegate;
    const model = await this.db.resolveModel(this.name);
    this.delegate = new MongoCollection<T>(this.name, model as AnyModel, this.def);
    return this.delegate;
  }

  async create(doc: Partial<T>, opts?: OperationOptions) {
    return (await this.target()).create(doc, opts);
  }
  async insertMany(docs: Partial<T>[], opts?: OperationOptions) {
    return (await this.target()).insertMany(docs, opts);
  }
  async findOne(filter?: Filter, opts?: FindOptions) {
    return (await this.target()).findOne(filter, opts);
  }
  async find(filter?: Filter, opts?: FindOptions) {
    return (await this.target()).find(filter, opts);
  }
  async findById(id: string, opts?: FindOptions) {
    return (await this.target()).findById(id, opts);
  }
  async countDocuments(filter?: Filter, opts?: OperationOptions) {
    return (await this.target()).countDocuments(filter, opts);
  }
  async estimatedCount() {
    return (await this.target()).estimatedCount();
  }
  async distinct(field: string, filter?: Filter, opts?: OperationOptions) {
    return (await this.target()).distinct(field, filter, opts);
  }
  async updateOne(filter: Filter, update: Update, opts?: UpdateOptions) {
    return (await this.target()).updateOne(filter, update, opts);
  }
  async updateMany(filter: Filter, update: Update, opts?: UpdateOptions) {
    return (await this.target()).updateMany(filter, update, opts);
  }
  async findOneAndUpdate(filter: Filter, update: Update, opts?: UpdateOptions) {
    return (await this.target()).findOneAndUpdate(filter, update, opts);
  }
  async findByIdAndUpdate(id: string, update: Update, opts?: UpdateOptions) {
    return (await this.target()).findByIdAndUpdate(id, update, opts);
  }
  async deleteOne(filter: Filter, opts?: OperationOptions) {
    return (await this.target()).deleteOne(filter, opts);
  }
  async deleteMany(filter: Filter, opts?: OperationOptions) {
    return (await this.target()).deleteMany(filter, opts);
  }
  async findByIdAndDelete(id: string, opts?: OperationOptions) {
    return (await this.target()).findByIdAndDelete(id, opts);
  }
  async aggregate<R = Document>(pipeline: Pipeline, opts?: OperationOptions) {
    return (await this.target()).aggregate<R>(pipeline, opts);
  }
  async ensureIndexes() {
    return (await this.target()).ensureIndexes();
  }
}
