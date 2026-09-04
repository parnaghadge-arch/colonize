import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import {
  assignComplaintSchema,
  complaintCommentSchema,
  complaintFeedbackSchema,
  complaintStatusChangeSchema,
  createComplaintSchema,
  createServiceRequestSchema,
  createWorkOrderSchema,
  updateComplaintSchema,
  updateWorkOrderSchema,
  workOrderProgressSchema,
  idSchema,
} from '@colonize/shared/validation';
import type { ModuleKey } from '@colonize/shared';
import { buildCrudRouter } from '../_shared/crud.js';
import { authenticate, requireTenantContext } from '../../middleware/authenticate.js';
import { requirePermission } from '../../middleware/permissions.js';
import { asyncHandler } from '../../middleware/errors.js';
import { validate } from '../../middleware/validate.js';
import { ok, created } from '../../utils/response.js';
import { ApiError } from '../../utils/errors.js';
import { serialise } from '../../utils/serialize.js';
import { newId } from '../../db/ids.js';
import type { Document } from '../../db/drivers/types.js';
import { nextReference } from '../../services/counters.js';
import type { HelpDeskContext } from './helpdeskService.js';
import * as helpdeskService from './helpdeskService.js';

/**
 * Help desk endpoints (§23, §24, §31, §36, §54).
 *
 *   POST /api/complaints                     resident or admin raises a complaint
 *   POST /api/complaints/:id/assign          admin assigns staff/vendor → work order
 *   PATCH /api/work-orders/:id/status        assignee moves the job forward
 *   POST /api/complaints/:id/verify          resident confirms the work (closes it)
 *   POST /api/complaints/:id/reopen          resident reopens inside the window
 *   GET  /api/complaints/mine                the resident app's list
 *   GET  /api/work-orders/my                 the staff/vendor app's queue
 */

function ctxFrom(req: import('express').Request): HelpDeskContext {
  const c = requireTenantContext(req);
  return {
    db: c.db,
    societyId: c.society.id,
    actorId: c.principal.userId,
    actorName: c.principal.fullName,
    actorRoles: c.principal.roles,
  };
}

/** True for anyone who works for the society rather than living in it. */
function callerIsStaff(req: import('express').Request): boolean {
  const c = requireTenantContext(req);
  return !c.principal.isResidentScope;
}

/* -------------------------------- complaints -------------------------------- */

const complaintsCrud = buildCrudRouter<z.infer<typeof createComplaintSchema>, z.infer<typeof updateComplaintSchema>>({
  collection: 'complaints',
  permission: 'complaint',
  moduleKey: 'complaints' as ModuleKey,
  label: 'Complaint',
  updateSchema: updateComplaintSchema,
  searchFields: ['referenceNumber', 'title', 'description', 'assigneeName'],
  filterFields: ['category', 'status', 'priority', 'source', 'locationType', 'unitId', 'assigneeType', 'assigneeId', 'slaBreached', 'isEscalated', 'workOrderId'],
  dateRangeField: 'createdAt',
  sortableFields: ['createdAt', 'priority', 'status', 'slaDueAt', 'category', 'referenceNumber'],
  defaultSort: 'createdAt',
  defaultSortDir: 'desc',
  allowCreate: false,
  residentCanUpdate: false,
  residentCanDelete: false,
  populate: [
    { field: 'unitId', collection: 'units', pick: ['label', 'unitNumber'], as: 'unit' },
    { field: 'residentId', collection: 'residents', pick: ['fullName', 'phone'], as: 'resident' },
    { field: 'amenityId', collection: 'amenities', pick: ['name'], as: 'amenity' },
  ],
});

export const complaintsRouter: Router = Router();

complaintsRouter.post(
  '/',
  authenticate({ clientScopes: ['resident', 'console', 'security', 'staff'] }),
  requirePermission('complaint:create'),
  validate(createComplaintSchema),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const body = req.body as z.infer<typeof createComplaintSchema>;

    // §51 — a resident can only complain about their own flat; staff may target any unit or
    // a common area. The unitId in the body is ignored for resident callers.
    const locationType = body.locationType ?? 'UNIT';
    const unitId = c.principal.isResidentScope
      ? c.membership.primaryUnitId ?? c.membership.unitIds[0] ?? null
      : body.unitId ?? null;

    if (locationType === 'UNIT' && !unitId) {
      throw ApiError.badRequest(c.principal.isResidentScope ? 'Your account is not linked to a flat yet' : 'Select the flat this complaint is about');
    }

    const source = c.principal.isResidentScope ? 'RESIDENT' : c.principal.isSecurityScope ? 'SECURITY' : c.principal.isStaffScope ? 'STAFF' : 'ADMIN';
    const complaint = await helpdeskService.createComplaint(ctxFrom(req), {
      ...body,
      locationType,
      unitId,
      residentId: c.membership.residentId,
      source,
    });

    return created(
      res,
      {
        complaint: serialise(complaint),
        referenceNumber: complaint.referenceNumber,
        status: complaint.status,
        assignedTo: complaint.assigneeName ?? null,
        slaDueAt: complaint.slaDueAt ?? null,
      },
      complaint.assigneeName
        ? `Complaint ${complaint.referenceNumber} raised and assigned to ${complaint.assigneeName}`
        : `Complaint ${complaint.referenceNumber} raised — the society office will assign it shortly`,
    );
  }),
);

complaintsRouter.get(
  '/mine',
  authenticate({ clientScopes: ['resident'] }),
  validate(z.object({ status: z.string().trim().max(30).optional(), open: z.coerce.boolean().optional(), limit: z.coerce.number().int().min(1).max(100).default(25) }), 'query'),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const q = req.query as Record<string, string>;
    const filter: Record<string, unknown> = { societyId: c.society.id, unitId: { $in: c.membership.unitIds } };
    if (q.status) filter.status = q.status;
    else if (q.open === 'true') filter.status = { $nin: ['CLOSED', 'REJECTED'] };

    const items = await c.db.collection('complaints').find(filter, { sort: { createdAt: -1 }, limit: Number(q.limit ?? 25) });
    return ok(
      res,
      {
        items: items.map((cmp) => ({
          ...serialise(cmp),
          needsYourVerification: cmp.status === 'RESOLVED' && !cmp.verifiedByResident,
        })),
      },
      'Your complaints',
    );
  }),
);

/** Categories the society actually handles, with the SLA it promises for each priority. */
complaintsRouter.get(
  '/categories',
  authenticate(),
  requirePermission('complaint:view'),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const { getSettings } = await import('../../services/settings.js');
    const settings = await getSettings<Document>({ db: c.db, societyId: c.society.id }, 'complaint');
    return ok(
      res,
      {
        categories: Object.keys((settings.defaultCategoryAssignments ?? {}) as Record<string, unknown>),
        slaHoursByPriority: settings.slaHoursByPriority ?? {},
        autoAssign: Boolean(settings.autoAssign),
        requireResidentVerification: settings.requireResidentVerification !== false,
        reopenWindowDays: Number(settings.reopenWindowDays ?? 7),
      },
      'Complaint configuration fetched',
    );
  }),
);

complaintsRouter.get(
  '/stats',
  authenticate(),
  requirePermission('complaint:view'),
  validate(z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }), 'query'),
  asyncHandler(async (req, res) =>
    ok(res, await helpdeskService.complaintStats(ctxFrom(req), Number(req.query.days ?? 30)), 'Complaint statistics fetched'),
  ),
);

complaintsRouter.get(
  '/:id/comments',
  authenticate(),
  requirePermission('complaint:view'),
  asyncHandler(async (req, res) => {
    const items = await helpdeskService.listComments(ctxFrom(req), String(req.params.id), callerIsStaff(req));
    return ok(res, { items }, 'Conversation fetched');
  }),
);

complaintsRouter.post(
  '/:id/comments',
  authenticate(),
  requirePermission('complaint:view'),
  validate(complaintCommentSchema),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const body = req.body as z.infer<typeof complaintCommentSchema>;
    // A resident cannot post an internal-only comment (§36).
    const visibility = c.principal.isResidentScope ? 'ALL' : body.visibility;
    const comment = await helpdeskService.addComment(ctxFrom(req), String(req.params.id), { ...body, visibility });
    return created(res, serialise(comment), 'Comment added');
  }),
);

complaintsRouter.post(
  '/:id/assign',
  authenticate(),
  requirePermission('complaint:assign'),
  validate(assignComplaintSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof assignComplaintSchema>;
    const result = await helpdeskService.assignComplaint(ctxFrom(req), String(req.params.id), {
      assigneeType: body.assigneeType,
      assigneeId: body.assigneeId,
      note: body.note,
      scheduledEnd: body.dueAt ? new Date(body.dueAt).toISOString() : undefined,
    });
    return ok(res, result, `Assigned to ${result.assigneeName} — work order ${result.workOrderId} created`);
  }),
);

/**
 * Complaint status transitions (§54).
 *
 * PATCH is the verb the OpenAPI contract documents (`setComplaintStatus`), and it is the correct
 * one for a partial state change; the handler was only ever registered as POST, so every client
 * built against the published docs got a 404. Both verbs now share one middleware chain, so they
 * cannot drift apart.
 */
const complaintStatusFlow: RequestHandler[] = [
  authenticate(),
  requirePermission('complaint:update'),
  validate(complaintStatusChangeSchema),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const body = req.body as z.infer<typeof complaintStatusChangeSchema>;
    const complaintId = String(req.params.id);
    const complaint = await c.db.collection('complaints').findOne({ societyId: c.society.id, _id: complaintId });
    if (!complaint) throw ApiError.notFound('Complaint');

    // Residents may not drive the status machine directly — they verify, reopen or comment.
    if (c.principal.isResidentScope) throw ApiError.forbidden('Residents cannot change a complaint status directly');

    const now = new Date();
    const stamp: Document = {};
    if (body.status === 'RESOLVED') {
      stamp.resolvedAt = now;
      stamp.resolvedByName = c.principal.fullName;
      stamp.resolutionSummary = body.resolutionSummary ?? null;
    }
    if (body.status === 'CLOSED') stamp.closedAt = now;
    if (body.status === 'REJECTED') stamp.rejectedAt = now;
    if (body.status === 'IN_PROGRESS') stamp.startedAt = complaint.startedAt ?? now;
    if (body.status === 'ASSIGNED') stamp.assignedAt = complaint.assignedAt ?? now;

    await c.db.collection('complaints').updateOne(
      { societyId: c.society.id, _id: complaintId },
      {
        $set: { status: body.status, ...stamp, ...(body.attachments?.length ? { attachments: body.attachments } : {}), updatedBy: c.principal.userId },
        $push: { timeline: { at: now, action: `STATUS_${body.status}`, actorId: c.principal.userId, actorName: c.principal.fullName, note: body.note ?? null } },
      },
    );
    if (body.note) await helpdeskService.addComment(ctxFrom(req), complaintId, { body: body.note, visibility: 'ALL', isSystem: true });

    return ok(res, { complaintId, status: body.status, ...stamp }, `Complaint marked ${body.status.toLowerCase().replace('_', ' ')}`);
  }),
];
complaintsRouter.patch('/:id/status', ...complaintStatusFlow);
complaintsRouter.post('/:id/status', ...complaintStatusFlow);

/**
 * Resident verification (§54) — the step that actually closes a complaint.
 * `verified: true` closes it; `false` sends it back to the assignee as reopened.
 */
complaintsRouter.post(
  '/:id/verify',
  authenticate({ clientScopes: ['resident', 'console'] }),
  requirePermission('complaint:view'),
  validate(complaintFeedbackSchema.extend({ verified: z.coerce.boolean().default(true) })),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const complaintId = String(req.params.id);
    const complaint = await c.db.collection('complaints').findOne({ societyId: c.society.id, _id: complaintId });
    if (!complaint) throw ApiError.notFound('Complaint');
    if (c.principal.isResidentScope && !c.membership.unitIds.includes(String(complaint.unitId))) {
      throw ApiError.forbidden('You can only verify complaints raised from your own flat');
    }

    const body = req.body as z.infer<typeof complaintFeedbackSchema> & { verified: boolean };
    const result = await helpdeskService.verifyComplaint(ctxFrom(req), complaintId, body);
    return ok(res, result, body.verified ? 'Thanks — the complaint is now closed' : 'The complaint has been sent back for more work');
  }),
);

complaintsRouter.post(
  '/:id/reopen',
  authenticate({ clientScopes: ['resident', 'console'] }),
  requirePermission('complaint:view'),
  validate(z.object({ reason: z.string().trim().min(3).max(500) })),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const complaintId = String(req.params.id);
    const complaint = await c.db.collection('complaints').findOne({ societyId: c.society.id, _id: complaintId });
    if (!complaint) throw ApiError.notFound('Complaint');
    if (c.principal.isResidentScope && !c.membership.unitIds.includes(String(complaint.unitId))) {
      throw ApiError.forbidden('You can only reopen complaints from your own flat');
    }
    const body = req.body as { reason: string };
    return ok(res, await helpdeskService.reopenComplaint(ctxFrom(req), complaintId, body.reason), 'Complaint reopened');
  }),
);

complaintsRouter.post(
  '/:id/close',
  authenticate(),
  requirePermission('complaint:update', 'complaint:manage'),
  validate(z.object({ resolutionSummary: z.string().trim().max(2000).optional(), force: z.coerce.boolean().default(false) })),
  asyncHandler(async (req, res) => {
    const body = req.body as { resolutionSummary?: string; force: boolean };
    const result = await helpdeskService.closeComplaint(ctxFrom(req), String(req.params.id), body);
    return ok(res, result, 'Complaint closed');
  }),
);

complaintsRouter.post(
  '/sla-sweep',
  authenticate(),
  requirePermission('complaint:manage'),
  asyncHandler(async (req, res) => ok(res, await helpdeskService.sweepSla(ctxFrom(req)), 'SLA sweep complete')),
);

complaintsRouter.use(complaintsCrud);

/* -------------------------------- work orders ------------------------------- */

const workOrdersCrud = buildCrudRouter<z.infer<typeof createWorkOrderSchema>, z.infer<typeof updateWorkOrderSchema>>({
  collection: 'work_orders',
  permission: 'workorder',
  moduleKey: 'workOrders' as ModuleKey,
  label: 'Work order',
  createSchema: createWorkOrderSchema,
  updateSchema: updateWorkOrderSchema,
  searchFields: ['referenceNumber', 'title', 'description', 'assigneeName'],
  filterFields: ['status', 'priority', 'category', 'assigneeType', 'assigneeId', 'vendorId', 'unitId', 'complaintId', 'buildingId'],
  dateRangeField: 'createdAt',
  sortableFields: ['createdAt', 'priority', 'status', 'scheduledStart', 'actualCost', 'referenceNumber'],
  defaultSort: 'createdAt',
  defaultSortDir: 'desc',
  prepareCreate: (ctx, body) => ({
    ...body,
    referenceNumber: undefined,
    history: [{ at: new Date(), status: 'CREATED', actorId: ctx.principal.userId, actorName: ctx.principal.fullName, note: 'Created manually' }],
    createdBy: ctx.principal.userId,
    updatedBy: ctx.principal.userId,
  }),
  populate: [
    { field: 'vendorId', collection: 'vendors', pick: ['businessName', 'phone'], as: 'vendor' },
    { field: 'unitId', collection: 'units', pick: ['label', 'unitNumber'], as: 'unit' },
    { field: 'complaintId', collection: 'complaints', pick: ['referenceNumber', 'title'], as: 'complaint' },
  ],
});

export const workOrdersRouter: Router = Router();

/** The staff/vendor app's own queue — scoped to the caller, never by a client-supplied id. */
workOrdersRouter.get(
  '/my',
  authenticate({ clientScopes: ['staff', 'vendor', 'security', 'console'] }),
  validate(z.object({ status: z.string().trim().max(30).optional(), open: z.coerce.boolean().default(true) }), 'query'),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const q = req.query as Record<string, string>;
    const filter: Record<string, unknown> = { societyId: c.society.id };

    if (c.membership.vendorId) filter.vendorId = c.membership.vendorId;
    else if (c.membership.staffId) filter.assigneeId = c.membership.staffId;
    else filter.assigneeId = c.principal.userId;

    if (q.status) filter.status = q.status;
    else if (q.open !== 'false') filter.status = { $nin: ['CLOSED', 'CANCELLED', 'VERIFIED'] };

    const items = await c.db.collection('work_orders').find(filter, { sort: { createdAt: -1 }, limit: 100 });
    return ok(res, { items: items.map((w) => serialise(w)), total: items.length }, 'Your work orders');
  }),
);

/** Same contract as complaints: PATCH is canonical, POST kept as an alias. */
const workOrderStatusFlow: RequestHandler[] = [
  authenticate({ clientScopes: ['staff', 'vendor', 'console', 'security'] }),
  requirePermission('workorder:update'),
  validate(workOrderProgressSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof workOrderProgressSchema>;
    const result = await helpdeskService.updateWorkOrderStatus(ctxFrom(req), String(req.params.id), body.status as never, {
      note: body.note,
      progressPercent: body.progressPercent,
      actualCost: body.actualCost,
      attachments: body.attachments,
      // A completion note doubles as the resolution summary shown to the resident.
      resolutionSummary: body.status === 'COMPLETED' ? body.note : undefined,
    });
    return ok(res, result, `Work order marked ${body.status.toLowerCase().replace('_', ' ')}`);
  }),
];
workOrdersRouter.patch('/:id/status', ...workOrderStatusFlow);
workOrdersRouter.post('/:id/status', ...workOrderStatusFlow);

workOrdersRouter.get(
  '/:id/history',
  authenticate(),
  requirePermission('workorder:view'),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const workOrder = await c.db.collection('work_orders').findOne({ societyId: c.society.id, _id: String(req.params.id) });
    if (!workOrder) throw ApiError.notFound('Work order');
    return ok(res, { history: workOrder.history ?? [], attachments: workOrder.attachments ?? [] }, 'Work order history fetched');
  }),
);

workOrdersRouter.use(workOrdersCrud);

/* ------------------------------ service requests ---------------------------- */

export const serviceRequestsRouter = buildCrudRouter<z.infer<typeof createServiceRequestSchema>, z.infer<typeof createServiceRequestSchema>>({
  collection: 'service_requests',
  permission: 'servicerequest',
  moduleKey: 'serviceRequests' as ModuleKey,
  label: 'Service request',
  createSchema: createServiceRequestSchema,
  updateSchema: createServiceRequestSchema.partial(),
  searchFields: ['referenceNumber', 'title', 'description'],
  filterFields: ['serviceType', 'status', 'unitId', 'vendorId', 'preferredSlot'],
  dateRangeField: 'preferredDate',
  sortableFields: ['createdAt', 'preferredDate', 'status', 'serviceType'],
  defaultSort: 'createdAt',
  defaultSortDir: 'desc',
  residentCanCreate: true,
  residentCanUpdate: false,
  residentCanDelete: false,
  prepareCreate: async (ctx, body) => {
    const unitId = ctx.principal.isResidentScope ? ctx.membership.primaryUnitId ?? ctx.membership.unitIds[0] : (body as Record<string, unknown>).unitId;
    if (!unitId) throw ApiError.badRequest('A flat is required for this service request');
    const referenceNumber = await nextReference({ db: ctx.db!, societyId: ctx.society!.id, kind: 'SERVICE_REQUEST' });
    return {
      ...body,
      referenceNumber,
      unitId,
      residentId: ctx.membership.residentId,
      userId: ctx.principal.userId,
      status: 'PENDING',
      timeline: [{ at: new Date(), action: 'CREATED', actorId: ctx.principal.userId, actorName: ctx.principal.fullName }],
      createdBy: ctx.principal.userId,
      updatedBy: ctx.principal.userId,
    } as never;
  },
  populate: [
    { field: 'unitId', collection: 'units', pick: ['label', 'unitNumber'], as: 'unit' },
    { field: 'vendorId', collection: 'vendors', pick: ['businessName', 'phone'], as: 'vendor' },
  ],
});

/* --------------------------------- vendors ---------------------------------- */

const vendorSchema = z.object({
  businessName: z.string().trim().min(2).max(120),
  contactPersonName: z.string().trim().max(80).optional(),
  phone: z.string().trim().min(7).max(20),
  alternatePhone: z.string().trim().max(20).optional(),
  email: z.string().trim().email().max(160).optional(),
  address: z.record(z.string(), z.unknown()).optional(),
  gstin: z.string().trim().max(20).optional(),
  pan: z.string().trim().max(12).optional(),
  serviceCategories: z.array(z.string().trim().max(60)).max(30).default([]),
  contractType: z.enum(['ONE_TIME', 'ANNUAL', 'MONTHLY', 'PER_VISIT', 'AMC']).default('PER_VISIT'),
  contractValue: z.coerce.number().min(0).max(100_000_000).optional(),
  agreementUrl: z.string().trim().max(500).optional(),
  startDate: z.string().trim().max(30).optional(),
  endDate: z.string().trim().max(30).optional(),
  bankAccountName: z.string().trim().max(120).optional(),
  bankAccountNumber: z.string().trim().max(30).optional(),
  bankIfsc: z.string().trim().max(12).optional(),
  paymentTermsDays: z.coerce.number().int().min(0).max(180).default(15),
  allowPortalLogin: z.coerce.boolean().default(false),
  status: z.enum(['ACTIVE', 'INACTIVE', 'BLACKLISTED', 'ON_HOLD']).default('ACTIVE'),
});

export const vendorsRouter = buildCrudRouter<z.infer<typeof vendorSchema>, z.infer<typeof vendorSchema>>({
  collection: 'vendors',
  unitScoped: false, // society-wide: no unitId column on this collection
  permission: 'vendor',
  moduleKey: 'vendorManagement' as ModuleKey,
  label: 'Vendor',
  createSchema: vendorSchema,
  updateSchema: vendorSchema.partial(),
  searchFields: ['businessName', 'contactPersonName', 'phone', 'email', 'gstin'],
  filterFields: ['status', 'contractType', 'serviceCategories', 'allowPortalLogin'],
  sortableFields: ['businessName', 'rating', 'totalWorkOrders', 'outstandingPayable', 'createdAt'],
  defaultSort: 'businessName',
  serialise: { omit: ['bankAccountNumber', 'pan'] },
  prepareCreate: (ctx, body) => ({ ...body, createdBy: ctx.principal.userId, updatedBy: ctx.principal.userId }),
});

/** Vendor scorecard (§43): rating, completion rate, billed vs paid. */
vendorsRouter.post(
  '/:id/refresh-rating',
  authenticate(),
  requirePermission('vendor:update', 'vendor:manage'),
  asyncHandler(async (req, res) =>
    ok(res, await helpdeskService.refreshVendorRating(ctxFrom(req), String(req.params.id)), 'Vendor rating recalculated'),
  ),
);

/* ---------------------------------- staff ----------------------------------- */

const staffSchema = z.object({
  fullName: z.string().trim().min(2).max(80),
  phone: z.string().trim().min(7).max(20),
  email: z.string().trim().email().max(160).optional(),
  staffType: z.string().trim().min(2).max(40),
  role: z.string().trim().max(60).optional(),
  department: z.string().trim().max(60).optional(),
  employmentType: z.enum(['FULL_TIME', 'PART_TIME', 'CONTRACT', 'HOURLY', 'AGENCY']).default('FULL_TIME'),
  salary: z.coerce.number().min(0).max(10_000_000).optional(),
  joiningDate: z.string().trim().max(30).optional(),
  address: z.record(z.string(), z.unknown()).optional(),
  idProofType: z.string().trim().max(30).optional(),
  idProofNumber: z.string().trim().max(40).optional(),
  photoUrl: z.string().trim().max(500).optional(),
  assignedBuildings: z.array(idSchema).max(50).default([]),
  assignedGates: z.array(idSchema).max(20).default([]),
  allowsUnitEntry: z.coerce.boolean().default(false),
  status: z.enum(['ACTIVE', 'ON_LEAVE', 'RESIGNED', 'TERMINATED', 'SUSPENDED']).default('ACTIVE'),
});

export const staffRouter = buildCrudRouter<z.infer<typeof staffSchema>, z.infer<typeof staffSchema>>({
  collection: 'staff',
  unitScoped: false, // society-wide: no unitId column on this collection
  permission: 'staff',
  moduleKey: 'staffAttendance' as ModuleKey,
  label: 'Staff member',
  createSchema: staffSchema,
  updateSchema: staffSchema.partial(),
  searchFields: ['fullName', 'phone', 'email', 'staffType', 'department'],
  filterFields: ['staffType', 'department', 'employmentType', 'status', 'isActive'],
  sortableFields: ['fullName', 'staffType', 'joiningDate', 'createdAt'],
  defaultSort: 'fullName',
  serialise: { revealContact: true, omit: ['idProofNumber'] },
  prepareCreate: (ctx, body) => ({ ...body, isActive: true, createdBy: ctx.principal.userId, updatedBy: ctx.principal.userId }),
});

export { newId };
