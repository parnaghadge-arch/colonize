import { normalisePhone } from '@colonize/shared';
import type { Document, TenantDatabase } from '../../db/drivers/types.js';
import { newId } from '../../db/ids.js';
import { databases } from '../../db/manager.js';
import { ApiError } from '../../utils/errors.js';
import { hashPassword, randomBytesBuffer } from '../../services/crypto.js';
import { upsertMembership } from '../../services/identityDirectory.js';
import { getSettings } from '../../services/settings.js';
import { nextReference } from '../../services/counters.js';
import { NotificationService } from '../../services/notifications/index.js';
import { emitLive } from '../../services/notifications/index.js';
import { logger } from '../../config/logger.js';

/**
 * Help desk: complaints, service requests and work orders (§23, §24, §31, §36, §54).
 *
 * The full loop from the acceptance scenario lives here:
 *
 *   resident raises → auto-assigned from the society's own category rules → work order to the
 *   vendor/staff → work done → resident verifies → closed (or reopened inside the window)
 *
 * Nothing about who handles what is hard-coded: `complaint.defaultCategoryAssignments` in
 * society settings decides, and an administrator can change it without a deploy.
 */

export interface HelpDeskContext {
  db: TenantDatabase;
  societyId: string;
  actorId: string;
  actorName?: string | null;
  actorRoles?: string[];
}

export type ComplaintStatus = 'OPEN' | 'ASSIGNED' | 'IN_PROGRESS' | 'ON_HOLD' | 'RESOLVED' | 'CLOSED' | 'REJECTED' | 'REOPENED';
export type WorkOrderStatus = 'REQUESTED' | 'CREATED' | 'ASSIGNED' | 'STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'VERIFIED' | 'CLOSED' | 'CANCELLED' | 'ON_HOLD';

interface ComplaintSettings {
  slaHoursByPriority: Record<string, number>;
  autoAssign: boolean;
  requireResidentVerification: boolean;
  reopenWindowDays: number;
  escalationAfterHours: number;
  defaultCategoryAssignments: Record<string, { type: 'STAFF' | 'VENDOR'; staffType?: string; serviceCategory?: string }>;
}

async function helpDeskSettings(ctx: HelpDeskContext): Promise<ComplaintSettings> {
  return getSettings<ComplaintSettings>({ db: ctx.db, societyId: ctx.societyId }, 'complaint');
}

function timeline(action: string, actorId: string | null, actorName: string | null, meta: Document = {}): Document {
  return { at: new Date(), action, actorId, actorName, ...meta };
}

async function pushTimeline(ctx: HelpDeskContext, complaintId: string, action: string, meta: Document = {}): Promise<void> {
  await ctx.db.collection('complaints').updateOne(
    { societyId: ctx.societyId, _id: complaintId },
    { $push: { timeline: timeline(action, ctx.actorId, ctx.actorName ?? null, meta) } },
  );
}

function slaDueAt(priority: string, settings: ComplaintSettings, from = new Date()): Date | null {
  const hours = Number(settings.slaHoursByPriority?.[priority] ?? settings.slaHoursByPriority?.MEDIUM ?? 72);
  if (!hours) return null;
  return new Date(from.getTime() + hours * 3_600_000);
}

/* -------------------------------- complaints -------------------------------- */

export interface CreateComplaintInput extends Document {
  category: string;
  title: string;
  description: string;
  priority?: string;
  source?: string;
  locationType?: string;
  unitId?: string | null;
  residentId?: string | null;
  amenityId?: string | null;
  locationText?: string | null;
  attachments?: Document[];
  isAnonymous?: boolean;
  preferredContactTime?: string | null;
  billableToResident?: boolean;
}

export async function createComplaint(ctx: HelpDeskContext, input: CreateComplaintInput): Promise<Document> {
  const settings = await helpDeskSettings(ctx);
  const now = new Date();

  const locationType = String(input.locationType ?? 'UNIT');
  let unitId = input.unitId ? String(input.unitId) : null;
  if (locationType === 'UNIT' && !unitId) throw ApiError.badRequest('A flat must be selected for this complaint');
  if (unitId) {
    const unit = await ctx.db.collection('units').findOne({ societyId: ctx.societyId, _id: unitId });
    if (!unit) throw ApiError.notFound('Unit');
  }

  const referenceNumber = await nextReference({ db: ctx.db, societyId: ctx.societyId, kind: 'COMPLAINT' });
  const priority = String(input.priority ?? 'MEDIUM').toUpperCase();

  const complaintId = newId('complaints');
  const complaint = await ctx.db.collection('complaints').create({
    _id: complaintId,
    societyId: ctx.societyId,
    referenceNumber,
    category: String(input.category).toUpperCase(),
    title: String(input.title).trim(),
    description: String(input.description).trim(),
    priority,
    status: 'OPEN',
    source: String(input.source ?? 'RESIDENT').toUpperCase(),
    locationType,
    unitId,
    residentId: input.residentId ? String(input.residentId) : null,
    amenityId: input.amenityId ? String(input.amenityId) : null,
    locationText: input.locationText ?? null,
    geo: input.geo ?? null,
    attachments: input.attachments ?? [],
    assigneeType: null,
    assigneeId: null,
    assigneeName: null,
    workOrderId: null,
    serviceRequestId: null,
    slaDueAt: slaDueAt(priority, settings, now),
    slaBreached: false,
    firstResponseAt: null,
    assignedAt: null,
    startedAt: null,
    resolvedAt: null,
    closedAt: null,
    rejectedAt: null,
    reopenCount: 0,
    resolutionSummary: null,
    resolvedByName: null,
    verifiedByResident: false,
    verifiedAt: null,
    rating: null,
    feedback: null,
    qualityRating: null,
    timelinessRating: null,
    isAnonymous: Boolean(input.isAnonymous),
    isEscalated: false,
    escalationLevel: 0,
    preferredContactTime: input.preferredContactTime ?? null,
    timeline: [timeline('CREATED', ctx.actorId, ctx.actorName ?? null, { referenceNumber, category: input.category, priority })],
    commentCount: 0,
    charges: 0,
    billableToResident: Boolean(input.billableToResident),
    createdBy: ctx.actorId,
    updatedBy: ctx.actorId,
  });

  // Auto-assignment uses the society's own category → handler rules (§24).
  let assignment: Document | null = null;
  if (settings.autoAssign) {
    assignment = await autoAssign(ctx, complaint, settings);
  }

  await notifyCreated(ctx, complaint, assignment);
  emitLive(ctx.societyId, 'complaint:created', { complaintId, referenceNumber, category: complaint.category, priority }, ['admins']);

  logger.info({ societyId: ctx.societyId, complaintId, referenceNumber }, 'complaint raised');
  return { ...complaint, ...(assignment ? { assigneeType: assignment.assigneeType, assigneeId: assignment.assigneeId, assigneeName: assignment.assigneeName, status: 'ASSIGNED' } : {}) };
}

async function notifyCreated(ctx: HelpDeskContext, complaint: Document, assignment: Document | null): Promise<void> {
  await NotificationService.send({
    db: ctx.db,
    societyId: ctx.societyId,
    type: 'COMPLAINT_CREATED',
    audience: { type: 'USERS', userIds: complaint.isAnonymous ? [] : [String(complaint.createdBy)] },
    data: { referenceNumber: complaint.referenceNumber, title: complaint.title, category: complaint.category },
    deepLink: `/complaints/${complaint._id}`,
  });
  await NotificationService.send({
    db: ctx.db,
    societyId: ctx.societyId,
    type: 'COMPLAINT_CREATED',
    audience: { type: 'ROLE', roles: ['SOCIETY_ADMIN', 'FACILITY_MANAGER', 'MANAGING_COMMITTEE'] },
    data: {
      referenceNumber: complaint.referenceNumber,
      title: complaint.title,
      category: complaint.category,
      priority: complaint.priority,
      assignedTo: assignment?.assigneeName ?? null,
      complaintId: complaint._id,
    },
    deepLink: `/complaints/${complaint._id}`,
    priority: complaint.priority === 'URGENT' ? 'CRITICAL' : 'NORMAL',
  });
}

/**
 * Resolve the right handler from the society's own rules, then find a concrete person.
 *
 * Rules look like `PLUMBING → { type: 'STAFF', staffType: 'PLUMBER' }` or
 * `LIFT → { type: 'VENDOR', serviceCategory: 'LIFT_MAINTENANCE' }`. If no rule matches, or no
 * matching handler is available, the complaint stays OPEN for manual assignment rather than
 * being silently dropped.
 */
export async function autoAssign(ctx: HelpDeskContext, complaint: Document, settings: ComplaintSettings): Promise<Document | null> {
  const rule = settings.defaultCategoryAssignments?.[String(complaint.category)];
  if (!rule) return null;

  if (rule.type === 'STAFF') {
    const staff = await ctx.db.collection('staff').findOne({
      societyId: ctx.societyId,
      staffType: rule.staffType,
      isActive: true,
      status: 'ACTIVE',
    });
    if (!staff) return null;
    return applyAssignment(ctx, complaint, {
      assigneeType: 'STAFF',
      assigneeId: String(staff._id),
      assigneeName: String(staff.fullName),
      userId: staff.userId ? String(staff.userId) : null,
      reason: `Auto-assigned by category rule (${complaint.category} → ${rule.staffType})`,
    });
  }

  const vendor = await ctx.db.collection('vendors').find(
    { societyId: ctx.societyId, status: 'ACTIVE', serviceCategories: rule.serviceCategory },
    { limit: 20 },
  );
  if (vendor.length === 0) return null;
  // Spread the load: pick whoever has the fewest open work orders.
  const loads = await Promise.all(
    vendor.map(async (v) => ({
      v,
      open: await ctx.db.collection('work_orders').countDocuments({ societyId: ctx.societyId, vendorId: v._id, status: { $nin: ['CLOSED', 'CANCELLED', 'COMPLETED', 'VERIFIED'] } }),
    })),
  );
  loads.sort((a, b) => a.open - b.open);
  const chosen = loads[0].v;

  return applyAssignment(ctx, complaint, {
    assigneeType: 'VENDOR',
    assigneeId: String(chosen._id),
    assigneeName: String(chosen.businessName),
    userId: chosen.userId ? String(chosen.userId) : null,
    vendorId: String(chosen._id),
    reason: `Auto-assigned to the vendor with the fewest open jobs (${chosen.businessName})`,
  });
}

async function applyAssignment(
  ctx: HelpDeskContext,
  complaint: Document,
  target: { assigneeType: string; assigneeId: string; assigneeName: string; userId?: string | null; vendorId?: string | null; reason?: string },
): Promise<Document> {
  const now = new Date();
  const workOrderId = newId('work_orders');
  const referenceNumber = await nextReference({ db: ctx.db, societyId: ctx.societyId, kind: 'WORK_ORDER' });

  await ctx.db.collection('work_orders').create({
    _id: workOrderId,
    societyId: ctx.societyId,
    referenceNumber,
    title: complaint.title,
    description: complaint.description,
    complaintId: complaint._id,
    serviceRequestId: complaint.serviceRequestId ?? null,
    category: complaint.category,
    priority: complaint.priority,
    status: 'ASSIGNED',
    assigneeType: target.assigneeType,
    assigneeId: target.assigneeId,
    assigneeName: target.assigneeName,
    vendorId: target.vendorId ?? (target.assigneeType === 'VENDOR' ? target.assigneeId : null),
    buildingId: null,
    unitId: complaint.unitId ?? null,
    amenityId: complaint.amenityId ?? null,
    scheduledStart: null,
    scheduledEnd: complaint.slaDueAt ?? null,
    startedAt: null,
    completedAt: null,
    verifiedAt: null,
    closedAt: null,
    estimatedCost: null,
    actualCost: null,
    materialCost: 0,
    labourCost: 0,
    materialRequired: null,
    progressPercent: 0,
    billId: null,
    expenseId: null,
    rating: null,
    feedback: null,
    history: [
      { at: now, status: 'CREATED', actorId: ctx.actorId, actorName: ctx.actorName ?? null, note: 'Created from complaint ' + complaint.referenceNumber },
      { at: now, status: 'ASSIGNED', actorId: ctx.actorId, actorName: ctx.actorName ?? null, note: target.reason ?? `Assigned to ${target.assigneeName}` },
    ],
    attachments: complaint.attachments ?? [],
    createdBy: ctx.actorId,
    updatedBy: ctx.actorId,
  });

  await ctx.db.collection('complaints').updateOne(
    { societyId: ctx.societyId, _id: complaint._id },
    {
      $set: {
        status: 'ASSIGNED',
        assigneeType: target.assigneeType,
        assigneeId: target.assigneeId,
        assigneeName: target.assigneeName,
        workOrderId,
        assignedAt: now,
        firstResponseAt: complaint.firstResponseAt ?? now,
        updatedBy: ctx.actorId,
      },
      $push: { timeline: timeline('ASSIGNED', ctx.actorId, ctx.actorName ?? null, { assigneeName: target.assigneeName, workOrderId, reason: target.reason ?? null }) },
    },
  );

  if (target.assigneeType === 'VENDOR') {
    await ctx.db.collection('vendors').updateOne({ societyId: ctx.societyId, _id: target.assigneeId }, { $inc: { totalWorkOrders: 1 } });
  }

  if (target.userId) {
    await NotificationService.send({
      db: ctx.db,
      societyId: ctx.societyId,
      type: 'WORK_ORDER_ASSIGNED',
      audience: { type: 'USERS', userIds: [target.userId] },
      data: { referenceNumber, title: complaint.title, category: complaint.category, priority: complaint.priority, complaintRef: complaint.referenceNumber },
      deepLink: `/work-orders/${workOrderId}`,
      priority: complaint.priority === 'URGENT' ? 'CRITICAL' : 'NORMAL',
    });
  }

  return { assigneeType: target.assigneeType, assigneeId: target.assigneeId, assigneeName: target.assigneeName, workOrderId };
}

/** Manual (re)assignment by an administrator (§36). */
export async function assignComplaint(
  ctx: HelpDeskContext,
  complaintId: string,
  input: { assigneeType: 'STAFF' | 'VENDOR' | 'USER'; assigneeId: string; note?: string; scheduledStart?: string | Date; scheduledEnd?: string | Date },
): Promise<Document> {
  const complaint = await ctx.db.collection('complaints').findOne({ societyId: ctx.societyId, _id: complaintId });
  if (!complaint) throw ApiError.notFound('Complaint');
  if (['CLOSED', 'REJECTED'].includes(String(complaint.status))) throw ApiError.conflict('This complaint is already closed');

  let assigneeName = input.assigneeId;
  let userId: string | null = null;
  if (input.assigneeType === 'STAFF') {
    const staff = await ctx.db.collection('staff').findOne({ societyId: ctx.societyId, _id: input.assigneeId });
    if (!staff) throw ApiError.notFound('Staff member');
    assigneeName = String(staff.fullName);
    userId = staff.userId ? String(staff.userId) : null;
  } else if (input.assigneeType === 'VENDOR') {
    const vendor = await ctx.db.collection('vendors').findOne({ societyId: ctx.societyId, _id: input.assigneeId });
    if (!vendor) throw ApiError.notFound('Vendor');
    assigneeName = String(vendor.businessName);
    userId = vendor.userId ? String(vendor.userId) : null;
  } else {
    const user = await ctx.db.collection('users').findOne({ societyId: ctx.societyId, _id: input.assigneeId });
    if (!user) throw ApiError.notFound('User');
    assigneeName = String(user.fullName);
    userId = String(user._id);
  }

  const result = await applyAssignment(ctx, complaint, {
    assigneeType: input.assigneeType,
    assigneeId: input.assigneeId,
    assigneeName,
    userId,
    vendorId: input.assigneeType === 'VENDOR' ? input.assigneeId : null,
    reason: input.note ?? `Assigned by ${ctx.actorName ?? 'administrator'}`,
  });

  if (input.scheduledStart || input.scheduledEnd) {
    await ctx.db.collection('work_orders').updateOne(
      { societyId: ctx.societyId, _id: result.workOrderId },
      {
        $set: {
          ...(input.scheduledStart ? { scheduledStart: new Date(String(input.scheduledStart)) } : {}),
          ...(input.scheduledEnd ? { scheduledEnd: new Date(String(input.scheduledEnd)) } : {}),
        },
      },
    );
  }
  return result;
}

/* ------------------------------- work orders -------------------------------- */

export async function updateWorkOrderStatus(
  ctx: HelpDeskContext,
  workOrderId: string,
  status: WorkOrderStatus,
  input: { note?: string; progressPercent?: number; actualCost?: number; materialCost?: number; labourCost?: number; attachments?: Document[]; resolutionSummary?: string } = {},
): Promise<Document> {
  const workOrder = await ctx.db.collection('work_orders').findOne({ societyId: ctx.societyId, _id: workOrderId });
  if (!workOrder) throw ApiError.notFound('Work order');
  if (['CLOSED', 'CANCELLED'].includes(String(workOrder.status))) throw ApiError.conflict('This work order is already closed');

  const now = new Date();
  const stamp: Document = {};
  if (status === 'STARTED' || status === 'IN_PROGRESS') stamp.startedAt = workOrder.startedAt ?? now;
  if (status === 'COMPLETED') stamp.completedAt = now;
  if (status === 'VERIFIED') stamp.verifiedAt = now;
  if (status === 'CLOSED') stamp.closedAt = now;
  if (status === 'CANCELLED') stamp.closedAt = now;

  // Once the work is done the job is 100% done. Leaving a caller-supplied 40% on a COMPLETED work
  // order would put contradictory numbers on the resident's screen and in every report.
  const isFinished = ['COMPLETED', 'VERIFIED', 'CLOSED'].includes(status);
  const progressPercent = isFinished ? 100 : input.progressPercent;

  await ctx.db.collection('work_orders').updateOne(
    { societyId: ctx.societyId, _id: workOrderId },
    {
      $set: {
        status,
        ...stamp,
        ...(progressPercent !== undefined ? { progressPercent: Number(progressPercent) } : {}),
        ...(input.actualCost !== undefined ? { actualCost: Number(input.actualCost) } : {}),
        ...(input.materialCost !== undefined ? { materialCost: Number(input.materialCost) } : {}),
        ...(input.labourCost !== undefined ? { labourCost: Number(input.labourCost) } : {}),
        ...(input.attachments ? { attachments: [...((workOrder.attachments as Document[]) ?? []), ...input.attachments] } : {}),
        ...(input.resolutionSummary ? { feedback: input.resolutionSummary } : {}),
        updatedBy: ctx.actorId,
      },
      $push: { history: { at: now, status, actorId: ctx.actorId, actorName: ctx.actorName ?? null, note: input.note ?? null, progressPercent: progressPercent ?? null } },
    },
  );

  // Keep the parent complaint in step with its work order.
  if (workOrder.complaintId) {
    const map: Partial<Record<WorkOrderStatus, ComplaintStatus>> = {
      STARTED: 'IN_PROGRESS',
      IN_PROGRESS: 'IN_PROGRESS',
      ON_HOLD: 'ON_HOLD',
      COMPLETED: 'RESOLVED',
      CANCELLED: 'OPEN',
    };
    const next = map[status];
    if (next) {
      await ctx.db.collection('complaints').updateOne(
        { societyId: ctx.societyId, _id: workOrder.complaintId },
        {
          $set: {
            status: next,
            ...(next === 'IN_PROGRESS' ? { startedAt: now } : {}),
            ...(next === 'RESOLVED' ? { resolvedAt: now, resolvedByName: ctx.actorName ?? null, resolutionSummary: input.resolutionSummary ?? null } : {}),
            ...(input.actualCost !== undefined ? { charges: Number(input.actualCost) } : {}),
            updatedBy: ctx.actorId,
          },
          $push: { timeline: timeline(`WORK_ORDER_${status}`, ctx.actorId, ctx.actorName ?? null, { workOrderId, note: input.note ?? null }) },
        },
      );
    }

    if (status === 'COMPLETED') {
      const complaint = await ctx.db.collection('complaints').findOne({ societyId: ctx.societyId, _id: workOrder.complaintId });
      const settings = await helpDeskSettings(ctx);
      await NotificationService.send({
        db: ctx.db,
        societyId: ctx.societyId,
        type: 'COMPLAINT_RESOLVED',
        audience: { type: 'USERS', userIds: complaint?.isAnonymous ? [] : [String(complaint?.createdBy ?? '')].filter(Boolean) },
        data: {
          referenceNumber: complaint?.referenceNumber,
          title: complaint?.title,
          resolutionSummary: input.resolutionSummary ?? null,
          requiresVerification: settings.requireResidentVerification !== false,
          complaintId: workOrder.complaintId,
        },
        deepLink: `/complaints/${workOrder.complaintId}`,
      });
      emitLive(ctx.societyId, 'complaint:resolved', { complaintId: workOrder.complaintId, workOrderId }, ['admins']);
    }
  }

  return { workOrderId, status, ...stamp };
}

/* --------------------------- resident verification --------------------------- */

/**
 * The resident confirms the work was actually done (§54).
 *
 * This is the gate before a complaint can close: with `requireResidentVerification` on, an
 * administrator marking work "done" is not enough — the person who raised it has to agree.
 */
export async function verifyComplaint(
  ctx: HelpDeskContext,
  complaintId: string,
  input: { verified: boolean; rating?: number; qualityRating?: number; timelinessRating?: number; feedback?: string },
): Promise<Document> {
  const complaint = await ctx.db.collection('complaints').findOne({ societyId: ctx.societyId, _id: complaintId });
  if (!complaint) throw ApiError.notFound('Complaint');
  if (!['RESOLVED', 'IN_PROGRESS', 'ASSIGNED'].includes(String(complaint.status))) {
    throw ApiError.conflict(`This complaint is ${String(complaint.status).toLowerCase()} and cannot be verified`);
  }

  const now = new Date();
  if (input.verified) {
    await ctx.db.collection('complaints').updateOne(
      { societyId: ctx.societyId, _id: complaintId },
      {
        $set: {
          status: 'CLOSED',
          verifiedByResident: true,
          verifiedAt: now,
          closedAt: now,
          rating: input.rating ?? null,
          qualityRating: input.qualityRating ?? null,
          timelinessRating: input.timelinessRating ?? null,
          feedback: input.feedback ?? null,
          updatedBy: ctx.actorId,
        },
        $push: { timeline: timeline('VERIFIED_AND_CLOSED', ctx.actorId, ctx.actorName ?? null, { rating: input.rating ?? null }) },
      },
    );
    if (complaint.workOrderId) {
      await ctx.db.collection('work_orders').updateOne(
        { societyId: ctx.societyId, _id: complaint.workOrderId },
        {
          $set: { status: 'CLOSED', verifiedAt: now, closedAt: now, rating: input.rating ?? null, feedback: input.feedback ?? null },
          $push: { history: { at: now, status: 'CLOSED', actorId: ctx.actorId, actorName: ctx.actorName ?? null, note: 'Verified by resident' } },
        },
      );
    }
    // Vendor performance is derived from these ratings (§43 vendor scorecard).
    if (complaint.assigneeType === 'VENDOR' && complaint.assigneeId) {
      await refreshVendorRating(ctx, String(complaint.assigneeId));
    }
    await NotificationService.send({
      db: ctx.db,
      societyId: ctx.societyId,
      type: 'COMPLAINT_CLOSED',
      audience: { type: 'ROLE', roles: ['SOCIETY_ADMIN', 'FACILITY_MANAGER'] },
      data: { referenceNumber: complaint.referenceNumber, title: complaint.title, rating: input.rating ?? null },
      deepLink: `/complaints/${complaintId}`,
    });
    return { complaintId, status: 'CLOSED', verified: true };
  }

  // Not satisfied → back to the assignee, with the reason on the record.
  await ctx.db.collection('complaints').updateOne(
    { societyId: ctx.societyId, _id: complaintId },
    {
      $set: { status: 'REOPENED', verifiedByResident: false, resolvedAt: null, feedback: input.feedback ?? null },
      $inc: { reopenCount: 1 },
      $push: { timeline: timeline('VERIFICATION_FAILED', ctx.actorId, ctx.actorName ?? null, { feedback: input.feedback ?? null }) },
    },
  );
  if (complaint.workOrderId) {
    await ctx.db.collection('work_orders').updateOne(
      { societyId: ctx.societyId, _id: complaint.workOrderId },
      {
        $set: { status: 'IN_PROGRESS', completedAt: null },
        $push: { history: { at: now, status: 'IN_PROGRESS', actorId: ctx.actorId, actorName: ctx.actorName ?? null, note: `Resident rejected the work: ${input.feedback ?? 'no reason given'}` } },
      },
    );
  }
  await NotificationService.send({
    db: ctx.db,
    societyId: ctx.societyId,
    type: 'COMPLAINT_REOPENED',
    audience: { type: 'ROLE', roles: ['SOCIETY_ADMIN', 'FACILITY_MANAGER'] },
    data: { referenceNumber: complaint.referenceNumber, title: complaint.title, feedback: input.feedback ?? null, complaintId },
    deepLink: `/complaints/${complaintId}`,
    priority: 'HIGH',
  });
  return { complaintId, status: 'REOPENED', verified: false };
}

/** Resident reopens a closed complaint inside the society's own window (§54). */
export async function reopenComplaint(ctx: HelpDeskContext, complaintId: string, reason: string): Promise<Document> {
  const settings = await helpDeskSettings(ctx);
  const complaint = await ctx.db.collection('complaints').findOne({ societyId: ctx.societyId, _id: complaintId });
  if (!complaint) throw ApiError.notFound('Complaint');
  if (String(complaint.status) !== 'CLOSED') throw ApiError.conflict('Only a closed complaint can be reopened');

  const windowDays = Number(settings.reopenWindowDays ?? 7);
  const closedAt = complaint.closedAt ? new Date(complaint.closedAt as string | Date) : null;
  if (closedAt && Date.now() - closedAt.getTime() > windowDays * 86_400_000) {
    throw ApiError.badRequest(`This complaint was closed more than ${windowDays} days ago. Please raise a new one.`);
  }

  await ctx.db.collection('complaints').updateOne(
    { societyId: ctx.societyId, _id: complaintId },
    {
      $set: { status: 'REOPENED', closedAt: null, verifiedByResident: false, verifiedAt: null, updatedBy: ctx.actorId },
      $inc: { reopenCount: 1 },
      $push: { timeline: timeline('REOPENED', ctx.actorId, ctx.actorName ?? null, { reason }) },
    },
  );
  if (complaint.workOrderId) {
    await ctx.db.collection('work_orders').updateOne(
      { societyId: ctx.societyId, _id: complaint.workOrderId },
      {
        $set: { status: 'IN_PROGRESS', closedAt: null, verifiedAt: null },
        $push: { history: { at: new Date(), status: 'IN_PROGRESS', actorId: ctx.actorId, actorName: ctx.actorName ?? null, note: `Reopened by resident: ${reason}` } },
      },
    );
  }
  await NotificationService.send({
    db: ctx.db,
    societyId: ctx.societyId,
    type: 'COMPLAINT_REOPENED',
    audience: { type: 'ROLE', roles: ['SOCIETY_ADMIN', 'FACILITY_MANAGER'] },
    data: { referenceNumber: complaint.referenceNumber, title: complaint.title, reason, complaintId },
    deepLink: `/complaints/${complaintId}`,
    priority: 'HIGH',
  });
  return { complaintId, status: 'REOPENED', reason };
}

export async function closeComplaint(ctx: HelpDeskContext, complaintId: string, input: { resolutionSummary?: string; force?: boolean } = {}): Promise<Document> {
  const settings = await helpDeskSettings(ctx);
  const complaint = await ctx.db.collection('complaints').findOne({ societyId: ctx.societyId, _id: complaintId });
  if (!complaint) throw ApiError.notFound('Complaint');
  if (String(complaint.status) === 'CLOSED') return { complaintId, status: 'CLOSED', alreadyClosed: true };

  if (settings.requireResidentVerification !== false && !complaint.verifiedByResident && !input.force) {
    throw ApiError.conflict('This complaint needs resident verification before it can be closed');
  }

  const now = new Date();
  await ctx.db.collection('complaints').updateOne(
    { societyId: ctx.societyId, _id: complaintId },
    {
      $set: {
        status: 'CLOSED',
        closedAt: now,
        resolvedAt: complaint.resolvedAt ?? now,
        resolutionSummary: input.resolutionSummary ?? complaint.resolutionSummary ?? null,
        updatedBy: ctx.actorId,
      },
      $push: { timeline: timeline('CLOSED', ctx.actorId, ctx.actorName ?? null, { forced: Boolean(input.force), resolutionSummary: input.resolutionSummary ?? null }) },
    },
  );
  if (complaint.workOrderId) {
    await ctx.db.collection('work_orders').updateOne(
      { societyId: ctx.societyId, _id: complaint.workOrderId },
      {
        $set: { status: 'CLOSED', closedAt: now },
        $push: { history: { at: now, status: 'CLOSED', actorId: ctx.actorId, actorName: ctx.actorName ?? null, note: 'Complaint closed' } },
      },
    );
  }
  return { complaintId, status: 'CLOSED', closedAt: now };
}

/* --------------------------------- comments --------------------------------- */

export async function addComment(
  ctx: HelpDeskContext,
  complaintId: string,
  input: { body: string; visibility?: 'ALL' | 'INTERNAL' | 'RESIDENT'; attachments?: Document[]; isSystem?: boolean },
): Promise<Document> {
  const complaint = await ctx.db.collection('complaints').findOne({ societyId: ctx.societyId, _id: complaintId });
  if (!complaint) throw ApiError.notFound('Complaint');

  const comment = await ctx.db.collection('complaint_comments').create({
    _id: newId('complaint_comments'),
    societyId: ctx.societyId,
    complaintId,
    authorId: ctx.actorId,
    authorName: complaint.isAnonymous && ctx.actorRoles?.includes('RESIDENT') ? 'Resident' : ctx.actorName ?? 'System',
    authorRole: ctx.actorRoles?.[0] ?? null,
    body: String(input.body).trim(),
    attachments: input.attachments ?? [],
    visibility: input.visibility ?? 'ALL',
    isSystem: Boolean(input.isSystem),
    createdBy: ctx.actorId,
  });

  await ctx.db.collection('complaints').updateOne(
    { societyId: ctx.societyId, _id: complaintId },
    { $inc: { commentCount: 1 }, $set: { firstResponseAt: complaint.firstResponseAt ?? new Date() } },
  );

  const recipients =
    input.visibility === 'INTERNAL'
      ? { type: 'ROLE' as const, roles: ['SOCIETY_ADMIN', 'FACILITY_MANAGER', 'MANAGING_COMMITTEE'] }
      : { type: 'USERS' as const, userIds: [String(complaint.createdBy)].filter(Boolean) };

  await NotificationService.send({
    db: ctx.db,
    societyId: ctx.societyId,
    type: 'COMPLAINT_COMMENT',
    audience: recipients,
    data: { referenceNumber: complaint.referenceNumber, body: comment.body, authorName: comment.authorName, complaintId },
    deepLink: `/complaints/${complaintId}`,
  });

  return comment;
}

/** Comments visible to the caller — `INTERNAL` ones never reach residents (§36). */
export async function listComments(ctx: HelpDeskContext, complaintId: string, callerIsStaff: boolean): Promise<Document[]> {
  const filter: Document = { societyId: ctx.societyId, complaintId };
  if (!callerIsStaff) filter.visibility = { $ne: 'INTERNAL' };
  return ctx.db.collection('complaint_comments').find(filter, { sort: { createdAt: 1 }, limit: 500 });
}

/* --------------------------------- SLA sweep -------------------------------- */

/**
 * Flag SLA breaches and escalate stale complaints (§19, §36).
 * Runs from the scheduler; safe to call on demand.
 */
export async function sweepSla(ctx: HelpDeskContext): Promise<{ breached: number; escalated: number }> {
  const settings = await helpDeskSettings(ctx);
  const now = new Date();

  const breached = await ctx.db.collection('complaints').updateMany(
    { societyId: ctx.societyId, slaBreached: false, slaDueAt: { $lt: now }, status: { $nin: ['CLOSED', 'RESOLVED', 'REJECTED'] } },
    { $set: { slaBreached: true, updatedBy: 'system' } },
  );

  const escalationHours = Number(settings.escalationAfterHours ?? 0);
  let escalated = 0;
  if (escalationHours > 0) {
    const cutoff = new Date(now.getTime() - escalationHours * 3_600_000);
    const stale = await ctx.db.collection('complaints').find(
      { societyId: ctx.societyId, isEscalated: false, status: { $in: ['OPEN', 'ASSIGNED'] }, createdAt: { $lt: cutoff } },
      { limit: 500 },
    );
    for (const complaint of stale) {
      await ctx.db.collection('complaints').updateOne(
        { societyId: ctx.societyId, _id: complaint._id },
        {
          $set: { isEscalated: true, escalationLevel: Number(complaint.escalationLevel ?? 0) + 1 },
          $push: { timeline: timeline('ESCALATED', null, 'System', { afterHours: escalationHours }) },
        },
      );
      await NotificationService.send({
        db: ctx.db,
        societyId: ctx.societyId,
        type: 'COMPLAINT_ESCALATED',
        audience: { type: 'ROLE', roles: ['SOCIETY_ADMIN', 'CHAIRMAN', 'MANAGING_COMMITTEE'] },
        data: { referenceNumber: complaint.referenceNumber, title: complaint.title, category: complaint.category, hours: escalationHours, complaintId: complaint._id },
        deepLink: `/complaints/${complaint._id}`,
        priority: 'HIGH',
      });
      escalated += 1;
    }
  }

  if (breached.modified || escalated) logger.info({ societyId: ctx.societyId, breached: breached.modified, escalated }, 'complaint SLA sweep');
  return { breached: breached.modified, escalated };
}

/** Recompute a vendor's rating and completion counters from closed work orders (§43). */
export async function refreshVendorRating(ctx: HelpDeskContext, vendorId: string): Promise<Document> {
  const orders = await ctx.db.collection('work_orders').find({ societyId: ctx.societyId, vendorId }, { limit: 2000 });
  const rated = orders.filter((o) => o.rating !== null && o.rating !== undefined);
  const completed = orders.filter((o) => ['COMPLETED', 'VERIFIED', 'CLOSED'].includes(String(o.status))).length;
  const rating = rated.length ? rated.reduce((sum, o) => sum + Number(o.rating), 0) / rated.length : 0;
  const billed = orders.reduce((sum, o) => sum + Number(o.actualCost ?? 0), 0);

  await ctx.db.collection('vendors').updateOne(
    { societyId: ctx.societyId, _id: vendorId },
    { $set: { rating: Math.round(rating * 10) / 10, completedWorkOrders: completed, totalWorkOrders: orders.length, totalBilled: Math.round(billed * 100) / 100 } },
  );
  return { vendorId, rating: Math.round(rating * 10) / 10, totalWorkOrders: orders.length, completedWorkOrders: completed };
}

/* ---------------------------------- stats ---------------------------------- */

export async function complaintStats(ctx: HelpDeskContext, days = 30): Promise<Document> {
  const since = new Date(Date.now() - days * 86_400_000);
  const complaints = await ctx.db.collection('complaints').find({ societyId: ctx.societyId, createdAt: { $gte: since } }, { limit: 20_000 });

  const byStatus: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  const byPriority: Record<string, number> = {};
  let breached = 0;
  let rated = 0;
  let ratingSum = 0;
  let resolutionMs = 0;
  let resolvedCount = 0;

  for (const c of complaints) {
    byStatus[String(c.status)] = (byStatus[String(c.status)] ?? 0) + 1;
    byCategory[String(c.category)] = (byCategory[String(c.category)] ?? 0) + 1;
    byPriority[String(c.priority)] = (byPriority[String(c.priority)] ?? 0) + 1;
    if (c.slaBreached) breached += 1;
    if (c.rating) {
      rated += 1;
      ratingSum += Number(c.rating);
    }
    if (c.resolvedAt && c.createdAt) {
      resolutionMs += new Date(c.resolvedAt as string | Date).getTime() - new Date(c.createdAt as string | Date).getTime();
      resolvedCount += 1;
    }
  }

  return {
    days,
    total: complaints.length,
    open: (byStatus.OPEN ?? 0) + (byStatus.REOPENED ?? 0) + (byStatus.ASSIGNED ?? 0) + (byStatus.IN_PROGRESS ?? 0),
    closed: byStatus.CLOSED ?? 0,
    slaBreached: breached,
    slaCompliancePercent: complaints.length ? Math.round(((complaints.length - breached) / complaints.length) * 100) : 100,
    averageRating: rated ? Math.round((ratingSum / rated) * 10) / 10 : null,
    averageResolutionHours: resolvedCount ? Math.round((resolutionMs / resolvedCount / 3_600_000) * 10) / 10 : null,
    byStatus,
    byCategory,
    byPriority,
  };
}

/* ------------------------------ staff logins -------------------------------- */

/**
 * Roles a staff member may hold. Deliberately excludes resident and platform roles: this endpoint
 * can only ever mint a society-staff identity, never an administrator or a super-admin one.
 */
export const STAFF_ROLES = [
  'SECURITY_GUARD',
  'SECURITY_SUPERVISOR',
  'FACILITY_MANAGER',
  'RECEPTIONIST',
  'ACCOUNTANT',
  'MAINTENANCE_STAFF',
  'ELECTRICIAN',
  'PLUMBER',
  'HOUSEKEEPING',
  'GARDENER',
  'DRIVER',
  'DOMESTIC_STAFF',
] as const;

export type StaffRole = (typeof STAFF_ROLES)[number];

/** Maps the employment `type` on the staff record to the role that unlocks the right screens. */
const ROLE_FOR_STAFF_TYPE: Record<string, StaffRole> = {
  SECURITY: 'SECURITY_GUARD',
  MAINTENANCE: 'MAINTENANCE_STAFF',
  TECHNICIAN: 'MAINTENANCE_STAFF',
  ELECTRICIAN: 'ELECTRICIAN',
  PLUMBER: 'PLUMBER',
  HOUSEKEEPING: 'HOUSEKEEPING',
  CLEANER: 'HOUSEKEEPING',
  GARDENER: 'GARDENER',
  DRIVER: 'DRIVER',
  RECEPTIONIST: 'RECEPTIONIST',
  MANAGER: 'FACILITY_MANAGER',
};

function roleForStaff(staff: Document, requested?: string): StaffRole {
  if (requested && (STAFF_ROLES as readonly string[]).includes(requested)) return requested as StaffRole;
  const fromType = ROLE_FOR_STAFF_TYPE[String(staff.type ?? '').toUpperCase()];
  return fromType ?? 'MAINTENANCE_STAFF';
}

/**
 * Issue (or reset) the login for a staff member — §26.
 *
 * A staff row on its own cannot authenticate; `users` is the thing that can. This creates the
 * matching user, links it back with `staff.userId`, and registers the account in the cross-society
 * identity directory so the guard app accepts the phone number on the very first attempt.
 *
 * When no password is supplied a strong one is generated and returned exactly once, with
 * `mustChangePassword` set so it cannot survive the first sign-in.
 */
export async function provisionStaffLogin(
  ctx: HelpDeskContext,
  staffId: string,
  input: { password?: string; role?: string; mustChangePassword?: boolean },
): Promise<{ staffId: string; userId: string; role: StaffRole; identifier: string; temporaryPassword: string | null; mustChangePassword: boolean }> {
  const staff = await ctx.db.collection('staff').findOne({ societyId: ctx.societyId, _id: staffId });
  if (!staff) throw ApiError.notFound('Staff member');

  const phone = normalisePhone(String(staff.phone ?? ''));
  if (!phone) throw ApiError.badRequest('This staff member has no phone number to sign in with');

  const role = roleForStaff(staff, input.role);
  const temporaryPassword = input.password ? null : generateTemporaryPassword();
  const password = input.password ?? temporaryPassword!;
  const passwordHash = await hashPassword(password);
  // A generated password is always single-use; an admin-chosen one only if they asked for it.
  const mustChangePassword = temporaryPassword ? true : (input.mustChangePassword ?? false);

  const existingUserId = staff.userId ? String(staff.userId) : null;
  let user = existingUserId ? await ctx.db.collection('users').findById(existingUserId) : null;

  if (user) {
    // Re-issuing for someone who already has an account: rotate the credential and the role.
    const patch: Document = {
      passwordHash,
      roles: [role],
      mustChangePassword,
      status: 'ACTIVE',
      isActive: true,
      failedLoginCount: 0,
      lockedUntil: null,
      fullName: String(staff.fullName ?? user.fullName),
      // `users.staffId` is the back-link the auth layer uses to resolve a staff membership.
      staffId,
      updatedBy: ctx.actorId,
    };
    await ctx.db.collection('users').updateOne({ _id: user._id }, { $set: patch });
    user = { ...user, ...patch };
  } else {
    // The phone may already belong to another account in this society — never mint a duplicate.
    const clash = await ctx.db.collection('users').findOne({ societyId: ctx.societyId, phone });
    if (clash) {
      throw ApiError.conflict('Another account in this society already uses that phone number');
    }

    user = await ctx.db.collection('users').create({
      _id: newId('users'),
      societyId: ctx.societyId,
      fullName: String(staff.fullName ?? ''),
      phone,
      email: staff.email ? String(staff.email) : null,
      passwordHash,
      roles: [role],
      staffId,
      status: 'ACTIVE',
      isActive: true,
      isVerified: true,
      mustChangePassword,
      avatarUrl: staff.photoUrl ? String(staff.photoUrl) : null,
      gender: null,
      dateOfBirth: null,
      lastLoginAt: null,
      failedLoginCount: 0,
      lockedUntil: null,
      pushTokens: [],
      preferences: {},
      createdSource: 'staff-provisioning',
      createdBy: ctx.actorId,
      updatedBy: ctx.actorId,
    });
  }

  await ctx.db.collection('staff').updateOne(
    { societyId: ctx.societyId, _id: staffId },
    { $set: { userId: user._id, allowLogin: true, updatedBy: ctx.actorId } },
  );

  const platform = await databases.platform();
  const society = await platform.collection('societies').findById(ctx.societyId);
  await upsertMembership({
    societyId: ctx.societyId,
    societyName: String(society?.name ?? ''),
    societySlug: String(society?.slug ?? ''),
    userId: String(user._id),
    phone,
    email: staff.email ? String(staff.email) : undefined,
    roles: [role],
    unitIds: [],
    status: 'ACTIVE',
    isActive: true,
  });

  logger.info({ societyId: ctx.societyId, staffId, userId: String(user._id), role }, 'staff login provisioned');

  return {
    staffId,
    userId: String(user._id),
    role,
    identifier: phone,
    temporaryPassword,
    mustChangePassword,
  };
}

/**
 * Deactivate a staff login without deleting the staff record: attendance and work-order history
 * must survive, but the account stops authenticating.
 */
export async function revokeStaffLogin(ctx: HelpDeskContext, staffId: string): Promise<{ staffId: string; revoked: boolean }> {
  const staff = await ctx.db.collection('staff').findOne({ societyId: ctx.societyId, _id: staffId });
  if (!staff) throw ApiError.notFound('Staff member');
  if (!staff.userId) return { staffId, revoked: false };

  await ctx.db.collection('users').updateOne(
    { _id: String(staff.userId) },
    { $set: { isActive: false, status: 'INACTIVE', updatedBy: ctx.actorId } },
  );
  await ctx.db.collection('staff').updateOne(
    { societyId: ctx.societyId, _id: staffId },
    { $set: { allowLogin: false, updatedBy: ctx.actorId } },
  );

  const platform = await databases.platform();
  const society = await platform.collection('societies').findById(ctx.societyId);
  await upsertMembership({
    societyId: ctx.societyId,
    societyName: String(society?.name ?? ''),
    societySlug: String(society?.slug ?? ''),
    userId: String(staff.userId),
    phone: staff.phone ? normalisePhone(String(staff.phone)) : undefined,
    roles: [],
    unitIds: [],
    status: 'INACTIVE',
    isActive: false,
  });

  logger.info({ societyId: ctx.societyId, staffId }, 'staff login revoked');
  return { staffId, revoked: true };
}

/**
 * A temporary password the admin can read out over the phone: unambiguous characters only, and it
 * always satisfies the platform password policy (length + letter + number).
 */
function generateTemporaryPassword(): string {
  // Every alphabet below omits the characters that get misread when an administrator reads a
  // password out over the phone: no 0/O, no 1/I/l.
  const consonants = 'BCDFGHJKMNPQRSTVWXZ';
  const vowels = 'AEU';
  const digits = '23456789';
  const pick = (alphabet: string): string => alphabet[randomInt(alphabet.length)];

  // Four letter pairs plus four digits, shuffled, keeps it pronounceable but not guessable.
  const body: string[] = [];
  for (let i = 0; i < 4; i += 1) {
    body.push(pick(consonants), pick(vowels));
  }
  for (let i = 0; i < 4; i += 1) body.push(pick(digits));

  for (let i = body.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [body[i], body[j]] = [body[j], body[i]];
  }
  return body.join('');
}

/** Unbiased integer in [0, max) — `randomBytes` rather than `Math.random` for credential material. */
function randomInt(max: number): number {
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  let value = randomBytesBuffer(4).readUInt32BE(0);
  while (value >= limit) value = randomBytesBuffer(4).readUInt32BE(0);
  return value % max;
}
