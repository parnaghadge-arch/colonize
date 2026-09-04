import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { MongoDatabase } from './drivers/mongo.js';
import { createEmbeddedDatabase, createEmbeddedStore, EmbeddedDatabase, EmbeddedStore } from './drivers/embedded/index.js';
import { TENANT_COLLECTIONS, PLATFORM_COLLECTIONS } from './registry/index.js';
import type { TenantDatabase } from './drivers/types.js';

/**
 * Database manager / tenant resolver (§4, §5).
 *
 * Topology
 * --------
 *   platform DB  (one)     → societies, plans, subscriptions, platform users, OTPs, tickets,
 *                            platform audit log. Cross-tenant by nature.
 *   society DBs  (one each)→ every operational record for that society. Created on
 *                            onboarding; the name is derived from the society slug and stored
 *                            on the society document so a slug change never orphans data.
 *
 * Isolation
 * ---------
 * A request can only ever reach the tenant database resolved from its **JWT**, and every
 * record additionally carries `societyId` which is asserted on read. Two independent layers,
 * so a bug in one cannot leak another society's data.
 */

export interface TenantDatabaseHandle {
  db: TenantDatabase;
  societyId: string;
  slug: string;
  databaseName: string;
  lastUsedAt: number;
}

const MAX_CACHED_TENANTS = Number(process.env.MAX_CACHED_TENANT_CONNECTIONS ?? 40);

class DatabaseManager {
  private platformDb: TenantDatabase | null = null;
  private readonly tenants = new Map<string, TenantDatabaseHandle>();
  private readonly embeddedStores = new Map<string, EmbeddedStore>();
  private readonly provisioning = new Map<string, Promise<void>>();
  private memoryMongoUri: string | null = null;

  get driver(): 'mongo' | 'embedded' {
    return env.DB_DRIVER;
  }

  private get mongoUri(): string {
    if (this.memoryMongoUri) return this.memoryMongoUri;
    return env.DATABASE_URL;
  }

  /**
   * Optional: start a real in-memory mongod (replica set, so transactions work) for local
   * development and tests. Requires a downloadable MongoDB binary; when unavailable the
   * caller falls back to the embedded driver.
   */
  async startMemoryMongo(): Promise<string | null> {
    if (this.memoryMongoUri) return this.memoryMongoUri;
    try {
      const { MongoMemoryReplSet } = await import('mongodb-memory-server');
      const replSet = await MongoMemoryReplSet.create({
        replSet: { count: 1, storageEngine: 'wiredTiger' },
      });
      this.memoryMongoUri = replSet.getUri();
      logger.info({ uri: this.memoryMongoUri.replace(/\/\/.*@/, '//***@') }, 'db: started in-memory MongoDB replica set');
      return this.memoryMongoUri;
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        'db: could not start an in-memory MongoDB (binary unavailable). Falling back to DB_DRIVER=embedded.',
      );
      return null;
    }
  }

  /**
   * @param scope selects the schema registry. Platform and tenant registries both declare
   *   `subscriptions`, `jobs`, `idempotency_keys` and `notification_templates`, with different
   *   required fields, so the database has to know which one it is.
   */
  private makeDatabase(dbName: string, scope: 'platform' | 'tenant'): TenantDatabase {
    if (this.driver === 'mongo') {
      return new MongoDatabase({ uri: this.mongoUri, dbName, scope });
    }
    let store = this.embeddedStores.get(dbName);
    if (!store) {
      store = createEmbeddedStore(dbName, env.EMBEDDED_DATA_DIR, env.EMBEDDED_PERSIST);
      this.embeddedStores.set(dbName, store);
    }
    return createEmbeddedDatabase(dbName, store, scope) as EmbeddedDatabase;
  }

  /** The single platform (SaaS operator) database. */
  async platform(): Promise<TenantDatabase> {
    if (!this.platformDb) {
      this.platformDb = this.makeDatabase(env.PLATFORM_DB_NAME, 'platform');
      await this.ensureIndexes(this.platformDb, Object.keys(PLATFORM_COLLECTIONS));
    }
    return this.platformDb;
  }

  private async ensureIndexes(db: TenantDatabase, names: string[]): Promise<void> {
    if (db.kind !== 'mongo') return;
    for (const name of names) {
      try {
        await db.collection(name).ensureIndexes();
      } catch (err) {
        logger.warn({ err, db: db.name, collection: name }, 'db: index sync failed (non-fatal)');
      }
    }
  }

  /**
   * Resolve (and cache) the database for a society.
   *
   * `databaseName` is supplied by the caller from the *platform* society document — never
   * from a request body — so a client cannot point a session at another tenant's database.
   */
  async forSociety(society: { id: string; slug: string; databaseName: string }): Promise<TenantDatabaseHandle> {
    const cached = this.tenants.get(society.id);
    if (cached) {
      cached.lastUsedAt = Date.now();
      return cached;
    }

    const db = this.makeDatabase(society.databaseName, 'tenant');
    const handle: TenantDatabaseHandle = {
      db,
      societyId: society.id,
      slug: society.slug,
      databaseName: society.databaseName,
      lastUsedAt: Date.now(),
    };
    this.tenants.set(society.id, handle);
    await this.evictIfNeeded();
    return handle;
  }

  /**
   * Resolve a society's database from just its id.
   *
   * The society record (and therefore `databaseName`) is always read from the platform
   * database — never from a request body — so a client cannot redirect a session into
   * another tenant's data. Used by platform-side modules, jobs and the scheduler, which
   * legitimately need to act on a society without a resident/guard token.
   */
  async forSocietyId(societyId: string, opts: { provision?: boolean } = {}): Promise<TenantDatabaseHandle> {
    const platform = await this.platform();
    const society = await platform.collection('societies').findById(societyId);
    if (!society) throw new Error(`Society ${societyId} not found`);
    const target = {
      id: String(society._id),
      slug: String(society.slug),
      databaseName: String(society.databaseName),
      // Carry the real entitlements so provisioning mirrors the plan the society actually has.
      planTier: society.tier ? String(society.tier) : undefined,
      modules: Array.isArray(society.modules) ? (society.modules as string[]) : undefined,
    };
    return opts.provision ? this.provision(target) : this.forSociety(target);
  }

  /** Same as `forSocietyId` but returns the resolved database handle directly. */
  async tenantDb(societyId: string): Promise<TenantDatabase> {
    const handle = await this.forSocietyId(societyId);
    return handle.db;
  }

  private async evictIfNeeded(): Promise<void> {
    if (this.tenants.size <= MAX_CACHED_TENANTS) return;
    const entries = Array.from(this.tenants.entries()).sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    const toEvict = entries.slice(0, this.tenants.size - MAX_CACHED_TENANTS);
    for (const [key, handle] of toEvict) {
      this.tenants.delete(key);
      await handle.db.close().catch(() => undefined);
      logger.debug({ society: handle.slug }, 'db: evicted idle tenant connection');
    }
  }

  /**
   * Resolve the plan a society is actually entitled to before provisioning.
   *
   * Provisioning writes the subscription mirror that `requireModule` gates every feature on, so
   * it must reflect the real plan. Most callers only hold `{ id, slug, databaseName }` — that is
   * all `forSociety` needs — and defaulting the mirror to STANDARD in that case silently locked
   * PREMIUM/ENTERPRISE societies out of modules they pay for. Read the plan from the platform
   * record (the source of truth) whenever the caller did not supply it.
   */
  private async resolveEntitlements(
    society: { id: string; slug: string; databaseName: string; planTier?: string; modules?: string[] },
  ): Promise<{ id: string; slug: string; databaseName: string; planTier?: string; modules?: string[] }> {
    if (society.planTier || society.modules?.length) return society;
    const platform = await this.platform();
    const doc = await platform.collection('societies').findById(society.id);
    if (!doc) return society;
    return {
      ...society,
      planTier: doc.tier ? String(doc.tier) : undefined,
      modules: Array.isArray(doc.modules) ? (doc.modules as string[]) : undefined,
    };
  }

  /**
   * Provision a brand-new society database (§41): create indexes and the baseline documents
   * every society needs (roles, settings, ledgers, counters). Idempotent — safe to re-run.
   */
  async provision(
    society: { id: string; slug: string; databaseName: string; planTier?: string; modules?: string[] },
  ): Promise<TenantDatabaseHandle> {
    const handle = await this.forSociety(society);
    const inFlight = this.provisioning.get(society.id);
    if (inFlight) {
      await inFlight;
      return handle;
    }
    const task = (async () => {
      await this.ensureIndexes(handle.db, Object.keys(TENANT_COLLECTIONS));
      const { seedTenantBasics } = await import('./seedTenant.js');
      await seedTenantBasics(handle.db, await this.resolveEntitlements(society));
      logger.info({ society: society.slug, db: society.databaseName }, 'db: society database provisioned');
    })();
    this.provisioning.set(society.id, task);
    try {
      await task;
    } finally {
      this.provisioning.delete(society.id);
    }
    return handle;
  }

  /** Flush embedded stores (called on shutdown so no queued write is lost). */
  async flush(): Promise<void> {
    await Promise.all(Array.from(this.embeddedStores.values()).map((s) => s.flush()));
  }

  async closeAll(): Promise<void> {
    await this.flush();
    await Promise.all(Array.from(this.tenants.values()).map((h) => h.db.close().catch(() => undefined)));
    this.tenants.clear();
    if (this.platformDb) await this.platformDb.close().catch(() => undefined);
    this.platformDb = null;
    this.embeddedStores.clear();
  }

  /** Drop every embedded store — used by the test harness between suites. */
  async resetEmbedded(): Promise<void> {
    for (const store of this.embeddedStores.values()) await store.drop();
    this.embeddedStores.clear();
    this.tenants.clear();
    this.platformDb = null;
  }

  stats(): { driver: string; cachedTenants: number } {
    return { driver: this.driver, cachedTenants: this.tenants.size };
  }
}

export const databases = new DatabaseManager();

/** Convenience accessor used by platform-scoped modules (societies, plans, tickets). */
export async function platformDb(): Promise<TenantDatabase> {
  return databases.platform();
}
