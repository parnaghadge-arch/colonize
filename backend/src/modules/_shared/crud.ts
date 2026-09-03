import { Router, type Request, type Response } from 'express';
import type { ZodTypeAny } from 'zod';
import { parsePagination, escapeRegex } from '@colonize/shared';
import type { Document } from '../../db/drivers/types.js';
import { newId } from '../../db/ids.js';
import { ApiError } from '../../utils/errors.js';
import { created, ok, paginated } from '../../utils/response.js';
import { asyncHandler } from '../../middleware/errors.js';
import { validate } from '../../middleware/validate.js';
import { authenticate, requireTenantContext } from '../../middleware/authenticate.js';
import { requireModule, requirePermission } from '../../middleware/permissions.js';
import { scopedFilter, unitScopeFilter, assertSameSociety, type RequestContext } from '../../middleware/context.js';
import { AuditService } from '../../services/audit.js';
import { serialise, serialiseMany, type SerialiseOptions } from '../../utils/serialize.js';

/**
 * CRUD router factory.
 *
 * Every collection module in the platform gets the same, complete behaviour (§75):
 *   • search across declared text fields, with escaped regex
 *   • filters (status / date range / hierarchy ids / arbitrary equals)
 *   • pagination with a bounded page size and an index-friendly sort whitelist
 *   • Zod validation on create/update/list
 *   • RBAC + subscription-module gating
 *   • automatic tenant scoping and resident unit scoping
 *   • audit logging of create / update / delete with an old→new diff
 *   • a standard response envelope and consistent error shapes
 *
 * Modules then add only their bespoke endpoints on top.
 */

export interface CrudConfig<TCreate = unknown, TUpdate = unknown> {
  /** Registry collection name. */
  collection: string;
  /** Permission namespace, e.g. `visitor` → `visitor:view`, `visitor:create`. */
  permission: string;
  /** Subscription module key that must be enabled. */
  moduleKey?: string;
  /** Human label used in audit entries and 404 messages. */
  label: string;
  /** Audit module name. */
  auditModule?: string;

  createSchema?: ZodTypeAny;
  updateSchema?: ZodTypeAny;
  listSchema?: ZodTypeAny;

  /** Fields searched by `?search=`. */
  searchFields?: string[];
  /** Fields a client may sort by (anything else falls back to createdAt). */
  sortableFields?: string[];
  /** Extra equality filters accepted from the query string. */
  filterFields?: string[];
  /** Date-range filters, mapped to a document field. */
  dateRangeField?: string;

  /** Build the document to insert. Runs inside the request context. */
  prepareCreate?: (ctx: RequestContext, body: TCreate, req: Request) => Promise<Document> | Document;
  /** Build the `$set` payload for an update. */
  prepareUpdate?: (ctx: RequestContext, existing: Document, body: TUpdate, req: Request) => Promise<Document> | Document;
  /** Extra filter applied to every list/read (e.g. only my unit's records). */
  listFilter?: (ctx: RequestContext, query: Record<string, unknown>) => Document;
  /** Post-create hook (notifications, counters, QR passes…). */
  afterCreate?: (ctx: RequestContext, doc: Document) => Promise<void>;
  /** Post-update hook. */
  afterUpdate?: (ctx: RequestContext, before: Document, after: Document) => Promise<void>;
  /** Post-delete hook. */
  afterDelete?: (ctx: RequestContext, doc: Document) => Promise<void>;

  /** Whether residents may create records of this kind (defaults to false). */
  residentCanCreate?: boolean;
  residentCanUpdate?: boolean;
  residentCanDelete?: boolean;
  /** Whether residents see only their own unit's records (default true). */
  unitScoped?: boolean;

  allowCreate?: boolean;
  allowUpdate?: boolean;
  allowDelete?: boolean;
  /** Hard delete instead of soft delete (registry-level softDelete still applies). */
  hardDelete?: boolean;

  serialise?: SerialiseOptions;
  /** Populate related labels for list views (kept cheap: one extra query per relation). */
  populate?: Array<{ field: string; collection: string; pick: string[]; as: string }>;
  /** Default sort for list views. */
  defaultSort?: string;
  defaultSortDir?: 'asc' | 'desc';
  /** Extra middleware mounted before the handlers (e.g. gate access checks). */
  extraMiddleware?: Array<(req: Request, res: Response, next: () => void) => void>;
}

interface PopulatedDoc extends Document {
  [key: string]: unknown;
}

export function buildCrudRouter<TCreate = unknown, TUpdate = unknown>(config: CrudConfig<TCreate, TUpdate>): Router {
  const router = Router();
  const auditModule = config.auditModule ?? config.collection;
  const serialiseOpts = config.serialise ?? {};
  const unitScoped = config.unitScoped !== false;

  const guards = [authenticate({ clientScopes: ['console', 'resident', 'security', 'staff', 'vendor'] })];
  if (config.moduleKey) guards.push(requireModule(config.moduleKey) as never);

  /* --------------------------------- helpers -------------------------------- */

  function baseFilter(ctx: RequestContext, query: Record<string, unknown>): Document {
    const extra: Document = {};
    for (const field of config.filterFields ?? []) {
      const value = query[field];
      if (typeof value === 'string' && value.trim()) extra[field] = value.trim();
    }
    if (typeof query.status === 'string' && query.status.trim() && !extra.status) {
      extra.status = query.status.trim();
    }
    if (config.dateRangeField) {
      const from = query.from as string | undefined;
      const to = query.to as string | undefined;
      const range: Document = {};
      if (from) range.$gte = new Date(`${from}T00:00:00.000Z`);
      if (to) range.$lte = new Date(`${to}T23:59:59.999Z`);
      if (Object.keys(range).length) extra[config.dateRangeField] = range;
    }
    if (config.searchFields?.length && typeof query.search === 'string' && query.search.trim()) {
      const term = escapeRegex(query.search.trim());
      extra.$or = config.searchFields.map((field) => ({ [field]: { $regex: term, $options: 'i' } }));
    }
    const fromList = config.listFilter?.(ctx, query) ?? {};
    return scopedFilter(ctx, { ...extra, ...fromList }, { unitScoped });
  }

  async function populateDocs(ctx: RequestContext, docs: Document[]): Promise<PopulatedDoc[]> {
    if (!config.populate?.length || docs.length === 0) return docs as PopulatedDoc[];
    const out = docs.map((d) => ({ ...d })) as PopulatedDoc[];
    for (const pop of config.populate) {
      const ids = Array.from(new Set(docs.map((d) => String(d[pop.field] ?? '')).filter((v) => v && v !== 'null')));
      if (ids.length === 0) continue;
      const projection: Document = { _id: 1 };
      for (const f of pop.pick) projection[f] = 1;
      const related = await ctx.db!.collection(pop.collection).find(
        { societyId: ctx.society!.id, _id: { $in: ids } },
        { projection, limit: ids.length },
      );
      const index = new Map(related.map((r) => [String(r._id), r]));
      for (const doc of out) {
        const found = index.get(String(doc[pop.field] ?? ''));
        doc[pop.as] = found ? Object.fromEntries(pop.pick.map((f) => [f, found[f]])) : null;
      }
    }
    return out;
  }

  function assertResidentAllowed(ctx: RequestContext, kind: 'create' | 'update' | 'delete'): void {
    if (!ctx.principal.isResidentScope) return;
    const allowed =
      kind === 'create' ? config.residentCanCreate : kind === 'update' ? config.residentCanUpdate : config.residentCanDelete;
    if (!allowed) {
      throw ApiError.forbidden(`Residents cannot ${kind} ${config.label.toLowerCase()} records`);
    }
  }

  /* ---------------------------------- routes -------------------------------- */

  /** GET / — list with search, filters, sorting and pagination. */
  router.get(
    '/',
    ...guards,
    requirePermission(`${config.permission}:view`),
    ...(config.extraMiddleware ?? []),
    config.listSchema ? validate(config.listSchema, 'query') : (req: Request, _res: Response, next: () => void) => next(),
    asyncHandler(async (req, res) => {
      const ctx = requireTenantContext(req);
      const query = req.query as unknown as Record<string, unknown>;
      const { page, limit, skip, sortBy, sortDir } = parsePagination(
        {
          page: query.page as number | string | undefined,
          limit: query.limit as number | string | undefined,
          sortBy: query.sortBy as string | undefined,
          sortDir: query.sortDir as 'asc' | 'desc' | undefined,
        },
        { allowedSort: config.sortableFields ?? ['createdAt'], defaultSort: config.defaultSort ?? 'createdAt' },
      );

      const collection = ctx.db.collection(config.collection);
      const filter = baseFilter(ctx, query);
      const [items, total] = await Promise.all([
        collection.find(filter, { sort: { [sortBy]: sortDir === 'asc' ? 1 : -1 }, skip, limit }),
        collection.countDocuments(filter),
      ]);
      const populated = await populateDocs(ctx, items);

      return paginated(res, {
        items: serialiseMany(populated, serialiseOpts),
        total,
        page,
        limit,
        sortBy,
        sortDir,
      });
    }),
  );

  /** GET /:id */
  router.get(
    '/:id',
    ...guards,
    requirePermission(`${config.permission}:view`),
    ...(config.extraMiddleware ?? []),
    asyncHandler(async (req, res) => {
      const ctx = requireTenantContext(req);
      const collection = ctx.db.collection(config.collection);
      const filter: Document = { societyId: ctx.society.id, _id: req.params.id };
      if (unitScoped && ctx.principal.isResidentScope) Object.assign(filter, unitScopeFilter(ctx));
      const doc = await collection.findOne(filter);
      assertSameSociety(doc, ctx, config.label);
      const [populated] = await populateDocs(ctx, [doc as Document]);
      return ok(res, serialise(populated, { ...serialiseOpts, revealContact: true }), `${config.label} fetched`);
    }),
  );

  /** POST / */
  if (config.allowCreate !== false) {
    router.post(
      '/',
      ...guards,
      requirePermission(`${config.permission}:create`),
      ...(config.extraMiddleware ?? []),
      config.createSchema ? validate(config.createSchema) : (req: Request, _res: Response, next: () => void) => next(),
      asyncHandler(async (req, res) => {
        const ctx = requireTenantContext(req);
        assertResidentAllowed(ctx, 'create');

        const prepared = config.prepareCreate
          ? await config.prepareCreate(ctx, req.body as TCreate, req)
          : ({ ...(req.body as Document) });

        const payload: Document = {
          _id: (prepared as Document)._id ?? newId(config.collection),
          societyId: ctx.society.id,
          ...stripReserved(prepared as Document),
          createdBy: ctx.principal.userId,
          updatedBy: ctx.principal.userId,
        };

        const doc = await ctx.db.collection(config.collection).create(payload);
        await config.afterCreate?.(ctx, doc);
        await new AuditService(ctx).created(auditModule, doc);
        return created(res, serialise(doc, serialiseOpts), `${config.label} created`);
      }),
    );
  }

  /** PUT /:id  (also accepts PATCH) */
  if (config.allowUpdate !== false) {
    const handler = asyncHandler(async (req: Request, res: Response) => {
      const ctx = requireTenantContext(req);
      assertResidentAllowed(ctx, 'update');
      const collection = ctx.db.collection(config.collection);

      const filter: Document = { societyId: ctx.society.id, _id: req.params.id };
      if (unitScoped && ctx.principal.isResidentScope) Object.assign(filter, unitScopeFilter(ctx));
      const before = await collection.findOne(filter);
      assertSameSociety(before, ctx, config.label);

      const patch = config.prepareUpdate
        ? await config.prepareUpdate(ctx, before as Document, req.body as TUpdate, req)
        : { ...(req.body as Document) };

      const update: Document = { ...stripReserved(patch), updatedBy: ctx.principal.userId };
      const after = await collection.findOneAndUpdate(filter, { $set: update }, { returnDocument: 'after' });
      if (!after) throw ApiError.notFound(config.label);

      await config.afterUpdate?.(ctx, before as Document, after);
      await new AuditService(ctx).updated(auditModule, before, after);
      return ok(res, serialise(after, serialiseOpts), `${config.label} updated`);
    });

    router.put(
      '/:id',
      ...guards,
      requirePermission(`${config.permission}:update`),
      ...(config.extraMiddleware ?? []),
      config.updateSchema ? validate(config.updateSchema) : (req: Request, _res: Response, next: () => void) => next(),
      handler,
    );
    router.patch(
      '/:id',
      ...guards,
      requirePermission(`${config.permission}:update`),
      ...(config.extraMiddleware ?? []),
      config.updateSchema ? validate(config.updateSchema) : (req: Request, _res: Response, next: () => void) => next(),
      handler,
    );
  }

  /** DELETE /:id */
  if (config.allowDelete !== false) {
    router.delete(
      '/:id',
      ...guards,
      requirePermission(`${config.permission}:delete`),
      ...(config.extraMiddleware ?? []),
      asyncHandler(async (req, res) => {
        const ctx = requireTenantContext(req);
        assertResidentAllowed(ctx, 'delete');
        const collection = ctx.db.collection(config.collection);

        const filter: Document = { societyId: ctx.society.id, _id: req.params.id };
        if (unitScoped && ctx.principal.isResidentScope) Object.assign(filter, unitScopeFilter(ctx));
        const doc = await collection.findOne(filter);
        assertSameSociety(doc, ctx, config.label);

        await collection.deleteOne(filter, { includeDeleted: config.hardDelete });
        await config.afterDelete?.(ctx, doc as Document);
        await new AuditService(ctx).deleted(auditModule, doc as Document);
        return ok(res, { id: req.params.id }, `${config.label} deleted`);
      }),
    );
  }

  return router;
}

/** Never let a client set identity, tenant or audit fields directly. */
const RESERVED_FIELDS = new Set([
  '_id',
  'societyId',
  'createdBy',
  'updatedBy',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'passwordHash',
  'otpHash',
  'refreshTokenHash',
  'tokenHash',
  'permissions',
  'roles',
  'token',
  'tokenHash',
  'sign',
]);

export function stripReserved(doc: Document): Document {
  const out: Document = {};
  for (const [key, value] of Object.entries(doc)) {
    if (RESERVED_FIELDS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

/** Load a document with the tenant + unit boundary already applied. */
export async function loadScoped(
  ctx: RequestContext,
  collection: string,
  id: string,
  label = 'Record',
  opts: { unitScoped?: boolean } = {},
): Promise<Document> {
  if (!ctx.society || !ctx.db) throw ApiError.forbidden('No society context', 'TENANT_MISMATCH');
  const filter: Document = { societyId: ctx.society.id, _id: id };
  if (opts.unitScoped !== false && ctx.principal.isResidentScope) {
    Object.assign(filter, unitScopeFilter(ctx));
  }
  const doc = await ctx.db.collection(collection).findOne(filter);
  return assertSameSociety(doc, ctx, label);
}
