/**
 * Persistence driver contract.
 *
 * Every service in the platform talks to this interface only. Two implementations exist:
 *
 *   `mongo`    — Mongoose against a real MongoDB deployment (production, Docker, CI with
 *                a reachable mongod). Each society gets its own database + connection.
 *   `embedded` — an in-process engine that implements the same Mongo query/update/aggregation
 *                semantics and persists to disk. Used for local development and tests in
 *                environments where no mongod binary can be obtained.
 *
 * Because both compile from the same schema registry (§db/registry), business logic never
 * branches on the driver.
 */

export type Document = Record<string, any>;
export type Filter = Record<string, any>;
export type Update = Record<string, any>;
export type Projection = Record<string, 0 | 1>;
export type SortSpec = Record<string, 1 | -1>;
export type Pipeline = Record<string, any>[];

export interface SessionHandle {
  id: string;
  /** Opaque driver session (a Mongoose `ClientSession` for the mongo driver). */
  raw?: unknown;
  ended: boolean;
}

export interface OperationOptions {
  session?: SessionHandle;
  /** Skip the automatic `deletedAt: null` filter (admin "restore" flows). */
  includeDeleted?: boolean;
  /** Bypass unique-index checks — never used outside provisioning/repair scripts. */
  skipUniqueCheck?: boolean;
}

export interface FindOptions extends OperationOptions {
  sort?: SortSpec;
  skip?: number;
  limit?: number;
  projection?: Projection;
}

export interface UpdateOptions extends OperationOptions {
  upsert?: boolean;
  /** `after` (default) returns the post-update document, matching `{ new: true }`. */
  returnDocument?: 'before' | 'after';
}

export interface UpdateResult {
  matched: number;
  modified: number;
  upsertedId?: string;
}

export interface DeleteResult {
  deleted: number;
}

export interface Collection<T extends Document = Document> {
  readonly name: string;

  create(doc: Partial<T>, opts?: OperationOptions): Promise<T>;
  insertMany(docs: Partial<T>[], opts?: OperationOptions): Promise<T[]>;

  findOne(filter?: Filter, opts?: FindOptions): Promise<T | null>;
  find(filter?: Filter, opts?: FindOptions): Promise<T[]>;
  findById(id: string, opts?: FindOptions): Promise<T | null>;

  countDocuments(filter?: Filter, opts?: OperationOptions): Promise<number>;
  distinct(field: string, filter?: Filter, opts?: OperationOptions): Promise<unknown[]>;

  updateOne(filter: Filter, update: Update, opts?: UpdateOptions): Promise<UpdateResult>;
  updateMany(filter: Filter, update: Update, opts?: UpdateOptions): Promise<UpdateResult>;
  findOneAndUpdate(filter: Filter, update: Update, opts?: UpdateOptions): Promise<T | null>;
  findByIdAndUpdate(id: string, update: Update, opts?: UpdateOptions): Promise<T | null>;

  deleteOne(filter: Filter, opts?: OperationOptions): Promise<DeleteResult>;
  deleteMany(filter: Filter, opts?: OperationOptions): Promise<DeleteResult>;
  findByIdAndDelete(id: string, opts?: OperationOptions): Promise<T | null>;

  aggregate<R = Document>(pipeline: Pipeline, opts?: OperationOptions): Promise<R[]>;

  ensureIndexes(): Promise<void>;
  estimatedCount(): Promise<number>;
}

export interface TenantDatabase {
  readonly kind: 'mongo' | 'embedded';
  readonly name: string;
  readonly supportsTransactions: boolean;
  /**
   * Which schema registry applies here. Four collection names are declared in both the platform
   * and tenant registries with different required fields, so definition resolution has to know
   * the scope — see `getCollectionForScope`.
   */
  readonly scope?: 'platform' | 'tenant';

  collection<T extends Document = Document>(name: string): Collection<T>;
  hasCollection(name: string): boolean;
  listCollections(): Promise<string[]>;

  startSession(): Promise<SessionHandle>;
  /**
   * Run `fn` atomically. Falls back to sequential execution (with a warning) when the
   * deployment has no transaction support (a standalone mongod without a replica set).
   */
  withTransaction<R>(fn: (session: SessionHandle) => Promise<R>): Promise<R>;

  drop(): Promise<void>;
  close(): Promise<void>;
  stats(): Promise<{ collections: number; documents: number; sizeBytes: number }>;
}
