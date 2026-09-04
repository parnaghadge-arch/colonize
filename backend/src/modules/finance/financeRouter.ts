import { Router, raw as rawBody, type RequestHandler } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  createBillSchema,
  generateBillsSchema,
  waiveBillSchema,
  createPaymentIntentSchema,
  verifyPaymentSchema,
  recordOfflinePaymentSchema,
  refundPaymentSchema,
  createLedgerSchema,
  updateLedgerSchema,
  createJournalEntrySchema,
  createExpenseSchema,
  updateExpenseSchema,
  createIncomeSchema,
  trialBalanceQuerySchema,
  idSchema,
} from '@colonize/shared/validation';
import { parsePagination, escapeRegex } from '@colonize/shared';
import type { ModuleKey } from '@colonize/shared';
import { authenticate, requireTenantContext } from '../../middleware/authenticate.js';
import { requirePermission, requireModule } from '../../middleware/permissions.js';
import { asyncHandler } from '../../middleware/errors.js';
import { validate } from '../../middleware/validate.js';
import { ok, created, paginated } from '../../utils/response.js';
import { ApiError } from '../../utils/errors.js';
import { serialise, serialiseMany } from '../../utils/serialize.js';
import { unitScopeFilter, type RequestContext } from '../../middleware/context.js';
import type { Document } from '../../db/drivers/types.js';
import * as billing from './billingService.js';
import * as accounting from './accountingService.js';
import * as payments from './paymentsService.js';
import type { GatewayProvider } from '../../services/paymentGateway.js';

/**
 * Finance endpoints (§27, §28, §29, §43, §53, §59) — the "bill → pay → ledger → receipt" leg
 * of the §80 acceptance scenario.
 *
 *   GET  /api/bills/mine                 the resident app's bill list + what they owe
 *   POST /api/bills/generate             the treasurer generates the month's bills
 *   GET  /api/bills/:id/invoice.pdf      the tax invoice, rendered server-side
 *   POST /api/payments/intent            start a payment (amount is computed server-side)
 *   POST /api/payments/verify            gateway callback → signature check → capture
 *   GET  /api/payments/:id/receipt.pdf   the receipt
 *   POST /api/payments/offline           cash/cheque collected at the office
 *   GET  /api/accounting/trial-balance   the books
 *
 * Money is never created or updated through a generic CRUD route: a bill exists only via
 * generation/`createBill`, and a payment only via an intent, an offline collection or a
 * verified webhook — so every rupee in the system has a journal entry behind it.
 */

/* --------------------------------- contexts -------------------------------- */

function billingCtx(req: Request): billing.BillingContext {
  const c = requireTenantContext(req);
  return { db: c.db, societyId: c.society.id, actorId: c.principal.userId, actorName: c.principal.fullName };
}

function accountingCtx(req: Request): accounting.AccountingContext {
  const c = requireTenantContext(req);
  return { db: c.db, societyId: c.society.id, actorId: c.principal.userId, actorName: c.principal.fullName };
}

function paymentsCtx(req: Request): payments.PaymentsContext {
  const c = requireTenantContext(req);
  return {
    db: c.db,
    societyId: c.society.id,
    actorId: c.principal.userId,
    actorName: c.principal.fullName,
    unitIds: c.membership.unitIds,
    isResidentScope: c.principal.isResidentScope,
  };
}

/**
 * A resident may only touch records belonging to a flat linked to their own account (§51).
 * Staff and committee members are unrestricted inside their society.
 */
function assertUnitAccess(c: RequestContext, unitId: unknown): void {
  if (!c.principal.isResidentScope) return;
  if (!unitId) throw ApiError.forbidden('You can only access records for your own flat');
  if (!c.membership.unitIds.includes(String(unitId))) {
    throw ApiError.forbidden('You can only access records for your own flat');
  }
}

function startOfDay(value: string | Date): Date {
  const d = new Date(value);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function endOfDay(value: string | Date): Date {
  const d = new Date(value);
  d.setUTCHours(23, 59, 59, 999);
  return d;
}

/** Fields never exposed to clients. */
const BILL_OMIT = ['configSnapshot'] as const;

/* ---------------------------------- bills ---------------------------------- */

export const billsRouter: Router = Router();

const billListQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  sortBy: z.enum(['dueDate', 'period', 'totalAmount', 'dueAmount', 'createdAt', 'invoiceNumber']).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  status: z.string().trim().max(40).optional(),
  period: z.string().trim().regex(/^\d{4}-\d{2}$/).optional(),
  unitId: idSchema.optional(),
  buildingId: idSchema.optional(),
  overdue: z.coerce.boolean().optional(),
  search: z.string().trim().max(120).optional(),
});

/** The resident app's home screen: their bills plus what they currently owe. */
billsRouter.get(
  '/mine',
  authenticate({ clientScopes: ['resident', 'console'] }),
  requireModule('maintenanceBilling' as ModuleKey),
  requirePermission('bill:view'),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const unitIds = c.membership.unitIds;
    if (!unitIds.length) return ok(res, { bills: [], totals: { billed: 0, paid: 0, due: 0, overdue: 0 } }, 'No flat is linked to your account');

    const bills = await c.db.collection('maintenance_bills').find(
      { societyId: c.society.id, unitId: { $in: unitIds } },
      { sort: { dueDate: -1 }, limit: 100 },
    );
    const units = await c.db.collection('units').find({ societyId: c.society.id, _id: { $in: unitIds } }, { limit: unitIds.length });
    const unitById = new Map(units.map((u) => [String(u._id), u]));

    const now = Date.now();
    let billed = 0;
    let paid = 0;
    let due = 0;
    let overdue = 0;
    for (const b of bills) {
      billed += Number(b.totalAmount ?? 0);
      paid += Number(b.paidAmount ?? 0);
      const outstanding = Number(b.dueAmount ?? 0);
      due += outstanding;
      if (outstanding > 0 && new Date(b.dueDate as string | Date).getTime() < now) overdue += outstanding;
    }
    const round = (n: number) => Math.round(n * 100) / 100;

    return ok(
      res,
      {
        bills: bills.map((b) => ({
          ...serialise(b, { omit: [...BILL_OMIT] }),
          unit: unitById.get(String(b.unitId))?.label ?? unitById.get(String(b.unitId))?.unitNumber ?? null,
          isOverdue: Number(b.dueAmount ?? 0) > 0 && new Date(b.dueDate as string | Date).getTime() < now,
        })),
        totals: { billed: round(billed), paid: round(paid), due: round(due), overdue: round(overdue) },
      },
      'Fetched successfully',
    );
  }),
);

/** Society-wide billing position for the treasurer's dashboard (§43). */
billsRouter.get(
  '/summary',
  authenticate({ clientScopes: ['console'] }),
  requireModule('maintenanceBilling' as ModuleKey),
  requirePermission('bill:view'),
  validate(z.object({ period: z.string().trim().regex(/^\d{4}-\d{2}$/).optional() }), 'query'),
  asyncHandler(async (req, res) => {
    const period = (req.query as Record<string, unknown>).period as string | undefined;
    return ok(res, await billing.billingSummary(billingCtx(req), period), 'Billing summary');
  }),
);

billsRouter.get(
  '/defaulters',
  authenticate({ clientScopes: ['console'] }),
  requireModule('maintenanceBilling' as ModuleKey),
  requirePermission('bill:view'),
  validate(
    z.object({ olderThanDays: z.coerce.number().int().min(0).max(3650).optional(), limit: z.coerce.number().int().min(1).max(500).optional() }),
    'query',
  ),
  asyncHandler(async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const rows = await billing.defaulters(billingCtx(req), {
      olderThanDays: q.olderThanDays === undefined ? undefined : Number(q.olderThanDays),
      limit: q.limit === undefined ? undefined : Number(q.limit),
    });
    return ok(res, { defaulters: rows, count: rows.length }, 'Fetched successfully');
  }),
);

/** The society's billing configuration, so the admin UI can show what generation will do. */
billsRouter.get(
  '/settings',
  authenticate({ clientScopes: ['console'] }),
  requireModule('maintenanceBilling' as ModuleKey),
  requirePermission('bill:view'),
  asyncHandler(async (req, res) => ok(res, await billing.billingSettings(billingCtx(req)), 'Billing settings')),
);

/** Generate the month's bills — transactional per unit, deduped on (unit, period) (§28). */
billsRouter.post(
  '/generate',
  authenticate({ clientScopes: ['console'] }),
  requireModule('maintenanceBilling' as ModuleKey),
  requirePermission('bill:create', 'bill:generate'),
  validate(generateBillsSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof generateBillsSchema> & { sendImmediately?: boolean };
    const scope = body.scope ?? 'ALL';

    // The scope decides which ids are honoured; ids for other scopes are ignored rather than
    // silently widening the run.
    const buildingIds = scope === 'BUILDING' ? body.buildingIds : [];
    const wingIds = scope === 'WING' ? body.wingIds : [];
    const unitIds = scope === 'UNITS' ? body.unitIds : [];
    if (scope === 'BUILDING' && !buildingIds.length) throw ApiError.badRequest('Select at least one building');
    if (scope === 'WING' && !wingIds.length) throw ApiError.badRequest('Select at least one wing');
    if (scope === 'UNITS' && !unitIds.length) throw ApiError.badRequest('Select at least one flat');

    const result = await billing.generateBills(billingCtx(req), {
      period: body.period,
      dueDate: body.dueDate,
      unitIds,
      buildingIds,
      wingIds,
      mode: 'BULK',
      dryRun: body.dryRun,
      sendImmediately: body.sendImmediately ?? !body.dryRun,
      carryForwardArrears: body.carryForwardArrears,
      applyLateFeeOnArrears: body.applyLateFeeOnArrears,
      include: {
        fixed: body.includeFixedCharges,
        water: body.includeWater,
        parking: body.includeParking,
        clubhouse: body.includeClubhouse,
      },
    });

    return res
      .status(result.dryRun ? 200 : 201)
      .json({
        success: true,
        message: result.dryRun
          ? `Preview: ${result.generated} bill(s) would be raised for ₹${result.totalBilled}`
          : `Generated ${result.generated} bill(s) totalling ₹${result.totalBilled}`,
        data: result,
      });
  }),
);

/** Raise a one-off bill for a single flat (repair charge, fine, festival contribution) (§28). */
billsRouter.post(
  '/',
  authenticate({ clientScopes: ['console'] }),
  requireModule('maintenanceBilling' as ModuleKey),
  requirePermission('bill:create'),
  validate(createBillSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createBillSchema>;
    const bill = await billing.createBill(billingCtx(req), {
      unitId: body.unitId,
      period: body.period,
      dueDate: body.dueDate,
      items: body.items,
      discount: body.discount,
      discountReason: body.discountReason,
      carryForwardArrears: body.carryForwardArrears,
      notes: body.notes,
      sendNotification: body.sendNotification,
    });
    return created(res, serialise(bill, { omit: [...BILL_OMIT] }), 'Bill raised');
  }),
);

/** Apply the society's late fee to everything past its grace period (§28). */
billsRouter.post(
  '/late-fees',
  authenticate({ clientScopes: ['console'] }),
  requireModule('maintenanceBilling' as ModuleKey),
  requirePermission('bill:update', 'bill:generate'),
  validate(z.object({ period: z.string().trim().regex(/^\d{4}-\d{2}$/).optional() }), 'body'),
  asyncHandler(async (req, res) => {
    const period = (req.body as { period?: string }).period;
    return ok(res, await billing.applyLateFees(billingCtx(req), { period }), 'Late fees applied');
  }),
);

/** Nudge residents whose bills are due soon or already overdue (§64). */
billsRouter.post(
  '/reminders',
  authenticate({ clientScopes: ['console'] }),
  requireModule('maintenanceBilling' as ModuleKey),
  requirePermission('bill:update', 'notification:create'),
  asyncHandler(async (req, res) => ok(res, await billing.sendBillReminders(billingCtx(req)), 'Reminders sent')),
);

/** Admin bill list: filters, search, pagination, unit-scoped for resident callers. */
billsRouter.get(
  '/',
  authenticate({ clientScopes: ['resident', 'console'] }),
  requireModule('maintenanceBilling' as ModuleKey),
  requirePermission('bill:view'),
  validate(billListQuery, 'query'),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const q = req.query as unknown as z.infer<typeof billListQuery>;
    const { page, limit, skip, sortBy, sortDir } = parsePagination(
      { page: q.page, limit: q.limit, sortBy: q.sortBy, sortDir: q.sortDir },
      { allowedSort: ['dueDate', 'period', 'totalAmount', 'dueAmount', 'createdAt', 'invoiceNumber'], defaultSort: 'dueDate' },
    );

    const filter: Document = { societyId: c.society.id, ...unitScopeFilter(c) };
    if (q.status) filter.status = String(q.status).toUpperCase();
    if (q.period) filter.period = q.period;
    if (q.unitId) filter.unitId = q.unitId;
    if (q.buildingId) {
      const units = await c.db.collection('units').find({ societyId: c.society.id, buildingId: q.buildingId }, { limit: 20_000 });
      filter.unitId = { $in: units.map((u) => String(u._id)) };
    }
    if (q.overdue) {
      filter.dueAmount = { $gt: 0 };
      filter.dueDate = { $lt: new Date() };
    }
    if (q.search) {
      const rx = new RegExp(escapeRegex(q.search), 'i');
      filter.$or = [{ invoiceNumber: rx }];
    }

    const [items, total] = await Promise.all([
      c.db.collection('maintenance_bills').find(filter, { sort: { [sortBy]: sortDir === 'asc' ? 1 : -1 }, skip, limit }),
      c.db.collection('maintenance_bills').countDocuments(filter),
    ]);

    return paginated(res, { items: serialiseMany(items, { omit: [...BILL_OMIT] }), total, page, limit, sortBy, sortDir });
  }),
);

/**
 * The tax invoice as a PDF (§59).
 *
 * Registered at both the path the OpenAPI contract publishes (`/{id}/invoice`) and the `.pdf`
 * alias used by the file-download convention, so documented API clients and a direct browser
 * download resolve to one handler chain instead of one of them 404-ing.
 */
const invoicePdfFlow: RequestHandler[] = [
  authenticate({ clientScopes: ['resident', 'console'] }),
  requireModule('maintenanceBilling' as ModuleKey),
  requirePermission('bill:view'),
  validate(z.object({ id: idSchema }), 'params'),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const id = String(req.params.id);
    const bill = await c.db.collection('maintenance_bills').findOne({ societyId: c.society.id, _id: id });
    if (!bill) throw ApiError.notFound('Bill');
    assertUnitAccess(c, bill.unitId);

    const { buffer, filename } = await billing.renderInvoicePdf(billingCtx(req), id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    return res.send(buffer);
  }),
];
billsRouter.get('/:id/invoice', ...invoicePdfFlow);
billsRouter.get('/:id/invoice.pdf', ...invoicePdfFlow);

billsRouter.get(
  '/:id',
  authenticate({ clientScopes: ['resident', 'console'] }),
  requireModule('maintenanceBilling' as ModuleKey),
  requirePermission('bill:view'),
  validate(z.object({ id: idSchema }), 'params'),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const detail = await billing.getBillDetail(billingCtx(req), String(req.params.id));
    assertUnitAccess(c, detail.unitId);
    return ok(res, serialise(detail, { omit: [...BILL_OMIT] }), 'Fetched successfully');
  }),
);

/** Send (or re-send) a bill to the household (§64). */
billsRouter.post(
  '/:id/send',
  authenticate({ clientScopes: ['console'] }),
  requireModule('maintenanceBilling' as ModuleKey),
  requirePermission('bill:update', 'bill:publish'),
  validate(z.object({ id: idSchema }), 'params'),
  asyncHandler(async (req, res) => ok(res, await billing.sendBills(billingCtx(req), [String(req.params.id)]), 'Bill sent')),
);

/** Waive part or all of a bill — audited, and it moves the ledger (§28). */
billsRouter.post(
  '/:id/waive',
  authenticate({ clientScopes: ['console'] }),
  requireModule('maintenanceBilling' as ModuleKey),
  requirePermission('bill:update', 'bill:approve'),
  validate(z.object({ id: idSchema }), 'params'),
  validate(waiveBillSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof waiveBillSchema>;
    const bill = await billing.waiveBill(billingCtx(req), String(req.params.id), {
      amount: body.fullWaiver ? undefined : body.amount,
      reason: body.reason,
      waiveAll: body.fullWaiver,
    });
    return ok(res, serialise(bill, { omit: [...BILL_OMIT] }), 'Charge waived');
  }),
);

/** A resident disputes a bill; it is flagged for the committee rather than silently changed. */
billsRouter.post(
  '/:id/dispute',
  authenticate({ clientScopes: ['resident', 'console'] }),
  requireModule('maintenanceBilling' as ModuleKey),
  requirePermission('bill:view'),
  validate(z.object({ id: idSchema }), 'params'),
  validate(z.object({ reason: z.string().trim().min(5).max(1000) })),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const id = String(req.params.id);
    const bill = await c.db.collection('maintenance_bills').findOne({ societyId: c.society.id, _id: id });
    if (!bill) throw ApiError.notFound('Bill');
    assertUnitAccess(c, bill.unitId);

    const updated = await billing.disputeBill(billingCtx(req), id, String((req.body as { reason: string }).reason));
    return ok(res, serialise(updated, { omit: [...BILL_OMIT] }), 'Bill marked as disputed');
  }),
);

/* -------------------------------- payments --------------------------------- */

export const paymentsRouter: Router = Router();

const paymentListQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  sortBy: z.enum(['paidAt', 'amount', 'createdAt', 'referenceNumber']).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  status: z.string().trim().max(40).optional(),
  purpose: z.string().trim().max(40).optional(),
  mode: z.string().trim().max(40).optional(),
  unitId: idSchema.optional(),
  billId: idSchema.optional(),
  from: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/**
 * Start a payment (§29, §59).
 *
 * The client says WHAT it is paying for; the server decides HOW MUCH. A tampered `amount` is
 * ignored whenever a bill, booking, event or service request is supplied.
 */
paymentsRouter.post(
  '/intent',
  authenticate({ clientScopes: ['resident', 'console'] }),
  requireModule('payments' as ModuleKey),
  requirePermission('payment:create'),
  validate(createPaymentIntentSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createPaymentIntentSchema>;
    const result = await payments.createIntent(paymentsCtx(req), {
      purpose: body.purpose,
      billId: body.billId,
      bookingId: body.bookingId,
      eventId: body.eventId,
      serviceRequestId: body.serviceRequestId,
      amount: body.amount,
      unitId: body.unitId,
      clientRequestId: body.clientRequestId,
    });
    return created(res, { payment: serialise(result.payment), order: result.order, duplicate: Boolean(result.duplicate) }, 'Payment order created');
  }),
);

/**
 * Complete a payment after the gateway returns (§59).
 *
 * The signature is verified server-side against the order id WE issued. A bad signature marks
 * the payment FAILED; it never credits a bill.
 */
paymentsRouter.post(
  '/verify',
  authenticate({ clientScopes: ['resident', 'console'] }),
  requireModule('payments' as ModuleKey),
  requirePermission('payment:create', 'payment:view'),
  validate(verifyPaymentSchema),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const body = req.body as z.infer<typeof verifyPaymentSchema>;
    if (!body.signature) throw ApiError.badRequest('The gateway signature is required to complete a payment');
    if (!body.gatewayPaymentId) throw ApiError.badRequest('The gateway payment id is required to complete a payment');

    const result = await payments.verifyAndApply(paymentsCtx(req), {
      paymentId: body.paymentId,
      providerOrderId: body.gatewayOrderId,
      providerPaymentId: body.gatewayPaymentId,
      signature: body.signature,
    });
    assertUnitAccess(c, result.payment?.unitId);

    return ok(
      res,
      {
        payment: serialise(result.payment),
        receipt: result.receipt ?? null,
        alreadyProcessed: Boolean(result.alreadyProcessed),
      },
      result.alreadyProcessed ? 'This payment was already completed' : 'Payment successful',
    );
  }),
);

/** Record cash/cheque/DD/bank-transfer collected at the society office (§28, §29). */
paymentsRouter.post(
  '/offline',
  authenticate({ clientScopes: ['console'] }),
  requireModule('payments' as ModuleKey),
  requirePermission('payment:record', 'payment:create'),
  validate(recordOfflinePaymentSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof recordOfflinePaymentSchema>;
    const result = await payments.recordOfflinePayment(paymentsCtx(req), {
      amount: body.amount,
      mode: body.mode,
      billId: body.billId,
      purpose: body.purpose,
      unitId: body.unitId,
      referenceNote: [body.referenceNumber, body.note].filter(Boolean).join(' — ') || undefined,
      receivedAt: body.paidAt,
    });
    return created(res, { payment: serialise(result.payment), receipt: result.receipt ?? null }, 'Offline payment recorded');
  }),
);

/** Collections report for a date range (§43). */
paymentsRouter.get(
  '/summary',
  authenticate({ clientScopes: ['console'] }),
  requireModule('payments' as ModuleKey),
  requirePermission('payment:view', 'accounting:view'),
  validate(z.object({ from: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }), 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as { from?: string; to?: string };
    const to = endOfDay(q.to ?? new Date());
    const from = startOfDay(q.from ?? new Date(to.getTime() - 29 * 86_400_000));
    if (from > to) throw ApiError.badRequest('The "from" date must be before the "to" date');
    return ok(res, await payments.collectionsSummary(paymentsCtx(req), from, to), 'Collections summary');
  }),
);

/** The resident app's payment history. */
paymentsRouter.get(
  '/mine',
  authenticate({ clientScopes: ['resident', 'console'] }),
  requireModule('payments' as ModuleKey),
  requirePermission('payment:view'),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const filter: Document = { societyId: c.society.id };
    if (c.principal.isResidentScope) {
      // Their own flat's payments, plus anything they personally initiated.
      const unitIds = c.membership.unitIds;
      filter.$or = unitIds.length ? [{ unitId: { $in: unitIds } }, { userId: c.principal.userId }] : [{ userId: c.principal.userId }];
    }
    const items = await c.db.collection('payments').find(filter, { sort: { createdAt: -1 }, limit: 100 });
    return ok(res, { payments: serialiseMany(items), count: items.length }, 'Fetched successfully');
  }),
);

paymentsRouter.get(
  '/',
  authenticate({ clientScopes: ['resident', 'console'] }),
  requireModule('payments' as ModuleKey),
  requirePermission('payment:view'),
  validate(paymentListQuery, 'query'),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const q = req.query as unknown as z.infer<typeof paymentListQuery>;
    const { page, limit, skip, sortBy, sortDir } = parsePagination(
      { page: q.page, limit: q.limit, sortBy: q.sortBy, sortDir: q.sortDir },
      { allowedSort: ['paidAt', 'amount', 'createdAt', 'referenceNumber'], defaultSort: 'createdAt' },
    );

    const filter: Document = { societyId: c.society.id, ...unitScopeFilter(c) };
    if (q.status) filter.status = String(q.status).toUpperCase();
    if (q.purpose) filter.purpose = String(q.purpose).toUpperCase();
    if (q.mode) filter.mode = String(q.mode).toUpperCase();
    if (q.unitId) filter.unitId = q.unitId;
    if (q.billId) filter.billId = q.billId;
    if (q.from || q.to) {
      filter.paidAt = {};
      if (q.from) filter.paidAt.$gte = startOfDay(q.from);
      if (q.to) filter.paidAt.$lte = endOfDay(q.to);
    }

    const [items, total] = await Promise.all([
      c.db.collection('payments').find(filter, { sort: { [sortBy]: sortDir === 'asc' ? 1 : -1 }, skip, limit }),
      c.db.collection('payments').countDocuments(filter),
    ]);
    return paginated(res, { items: serialiseMany(items), total, page, limit, sortBy, sortDir });
  }),
);

/**
 * The receipt as a PDF (§59) — the document a resident shows as proof of payment.
 * Served at the published `/{id}/receipt` path and at a `.pdf` alias (see `invoicePdfFlow`).
 */
const receiptPdfFlow: RequestHandler[] = [
  authenticate({ clientScopes: ['resident', 'console'] }),
  requireModule('payments' as ModuleKey),
  requirePermission('payment:view'),
  validate(z.object({ id: idSchema }), 'params'),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const id = String(req.params.id);
    const payment = await c.db.collection('payments').findOne({ societyId: c.society.id, _id: id });
    if (!payment) throw ApiError.notFound('Payment');
    assertUnitAccess(c, payment.unitId);

    const { buffer, filename } = await payments.renderReceiptPdf(paymentsCtx(req), id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.length));
    return res.send(buffer);
  }),
];
paymentsRouter.get('/:id/receipt', ...receiptPdfFlow);
paymentsRouter.get('/:id/receipt.pdf', ...receiptPdfFlow);

paymentsRouter.get(
  '/:id',
  authenticate({ clientScopes: ['resident', 'console'] }),
  requireModule('payments' as ModuleKey),
  requirePermission('payment:view'),
  validate(z.object({ id: idSchema }), 'params'),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const id = String(req.params.id);
    const payment = await c.db.collection('payments').findOne({ societyId: c.society.id, _id: id });
    if (!payment) throw ApiError.notFound('Payment');
    assertUnitAccess(c, payment.unitId);

    const transactions = await c.db.collection('payment_transactions').find(
      { societyId: c.society.id, paymentId: id },
      { sort: { occurredAt: 1 }, limit: 50 },
    );
    return ok(
      res,
      {
        ...serialise(payment),
        // Staff can see the gateway trail; residents get the receipt facts only.
        transactions: c.principal.isResidentScope ? [] : serialiseMany(transactions),
      },
      'Fetched successfully',
    );
  }),
);

/** Refund a payment — reverses through the ledger, never by editing history (§29). */
paymentsRouter.post(
  '/:id/refund',
  authenticate({ clientScopes: ['console'] }),
  requireModule('payments' as ModuleKey),
  requirePermission('payment:refund', 'payment:update'),
  validate(z.object({ id: idSchema }), 'params'),
  validate(refundPaymentSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof refundPaymentSchema>;
    const result = await payments.refundPayment(paymentsCtx(req), String(req.params.id), {
      amount: body.fullRefund ? undefined : body.amount,
      reason: body.reason,
    });
    return ok(res, result, 'Refund issued');
  }),
);

/* --------------------------- public gateway webhook -------------------------- */

/**
 * Provider webhook (§59).
 *
 * Mounted WITHOUT authentication and WITHOUT the global JSON parser: the signature is an HMAC
 * over the exact bytes the provider sent, so re-serialising a parsed object would break it.
 * Mount this router before `express.json()` in the app, e.g.
 *
 *   app.use('/api/webhooks/payments', paymentWebhookRouter);
 *
 * The society is resolved from the provider's own order id via the platform `gateway_orders`
 * index — never from anything the caller supplies — so a webhook cannot be aimed at another
 * tenant's database.
 */
export const paymentWebhookRouter: Router = Router();

const WEBHOOK_PROVIDERS = ['razorpay', 'mock'] as const;

paymentWebhookRouter.post(
  '/:provider',
  rawBody({ type: '*/*' }),
  asyncHandler(async (req: Request, res: Response) => {
    const provider = String(req.params.provider).toLowerCase();
    if (!(WEBHOOK_PROVIDERS as readonly string[]).includes(provider)) {
      throw ApiError.badRequest(`Unsupported payment provider "${provider}"`);
    }

    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {}));
    const signature = String(
      req.headers['x-razorpay-signature'] ?? req.headers['x-gateway-signature'] ?? req.headers['x-signature'] ?? '',
    );
    if (!signature) throw ApiError.badRequest('Missing webhook signature header');

    let payload: Document;
    try {
      payload = JSON.parse(raw.toString('utf8')) as Document;
    } catch {
      throw ApiError.badRequest('Webhook body is not valid JSON');
    }

    const result = await payments.processGatewayWebhook({ provider: provider as GatewayProvider, rawBody: raw, signature, payload });
    // Always 200 once the signature is valid: a non-2xx makes the provider retry an event we
    // have already recorded, and the outcome is in `processed`/`reason` for our own logs.
    return ok(res, result, result.processed ? 'Webhook processed' : `Webhook acknowledged: ${result.reason ?? 'no action taken'}`);
  }),
);

/* -------------------------------- accounting -------------------------------- */

export const accountingRouter: Router = Router();

/** Chart of accounts (§29). */
accountingRouter.get(
  '/ledgers',
  authenticate({ clientScopes: ['console'] }),
  requireModule('accounting' as ModuleKey),
  requirePermission('ledger:view', 'accounting:view'),
  validate(
    z.object({
      group: z.enum(['INCOME', 'EXPENSE', 'ASSET', 'LIABILITY', 'EQUITY']).optional(),
      isActive: z.coerce.boolean().optional(),
      search: z.string().trim().max(120).optional(),
    }),
    'query',
  ),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const q = req.query as { group?: string; isActive?: boolean; search?: string };
    const filter: Document = { societyId: c.society.id };
    if (q.group) filter.group = q.group;
    if (q.isActive !== undefined) filter.isActive = q.isActive;
    if (q.search) filter.name = new RegExp(escapeRegex(q.search), 'i');

    const ledgers = await c.db.collection('ledgers').find(filter, { sort: { group: 1, name: 1 }, limit: 1000 });
    return ok(res, { ledgers: serialiseMany(ledgers), count: ledgers.length }, 'Fetched successfully');
  }),
);

accountingRouter.post(
  '/ledgers',
  authenticate({ clientScopes: ['console'] }),
  requireModule('accounting' as ModuleKey),
  requirePermission('ledger:create', 'accounting:update'),
  validate(createLedgerSchema),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const body = req.body as z.infer<typeof createLedgerSchema>;

    const duplicate = await c.db.collection('ledgers').findOne({ societyId: c.society.id, name: body.name });
    if (duplicate) throw ApiError.conflict(`A ledger named "${body.name}" already exists`);

    // An opening balance is real money, so it is posted as a journal entry rather than written
    // straight onto the ledger — otherwise the trial balance would not foot.
    const ledgerId = await accounting.ensureLedger(accountingCtx(req), body.name, { type: body.type, group: body.group });
    await c.db.collection('ledgers').updateOne(
      { societyId: c.society.id, _id: ledgerId },
      {
        $set: {
          openingBalance: body.openingBalance,
          isSystem: false,
          vendorId: body.vendorId ?? null,
          unitId: body.unitId ?? null,
          isActive: body.isActive,
          description: `Created by ${c.principal.fullName}`,
          updatedBy: c.principal.userId,
        },
      },
    );

    if (Number(body.openingBalance) !== 0) {
      const equity = await accounting.ensureLedger(accountingCtx(req), 'Opening Balance Equity', { type: 'LIABILITY', group: 'EQUITY', code: 'EQ-3500' });
      const growsOnDebit = ['ASSET', 'EXPENSE'].includes(body.group);
      await accounting.postJournalEntry(accountingCtx(req), {
        narration: `Opening balance for ${body.name}`,
        referenceType: 'OPENING',
        referenceId: String(ledgerId),
        lines: growsOnDebit
          ? [
              { ledgerId: String(ledgerId), type: 'DEBIT', amount: Number(body.openingBalance), note: 'Opening balance' },
              { ledgerId: String(equity._id), type: 'CREDIT', amount: Number(body.openingBalance), note: 'Opening balance' },
            ]
          : [
              { ledgerId: String(equity._id), type: 'DEBIT', amount: Number(body.openingBalance), note: 'Opening balance' },
              { ledgerId: String(ledgerId), type: 'CREDIT', amount: Number(body.openingBalance), note: 'Opening balance' },
            ],
      });
    }

    const ledger = await c.db.collection('ledgers').findOne({ societyId: c.society.id, _id: ledgerId });
    return created(res, serialise(ledger), 'Ledger created');
  }),
);

accountingRouter.get(
  '/ledgers/:id',
  authenticate({ clientScopes: ['console'] }),
  requireModule('accounting' as ModuleKey),
  requirePermission('ledger:view', 'accounting:view'),
  validate(z.object({ id: idSchema }), 'params'),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const id = String(req.params.id);
    const ledger = await c.db.collection('ledgers').findOne({ societyId: c.society.id, _id: id });
    if (!ledger) throw ApiError.notFound('Ledger');

    // The ledger statement: every journal line touching this account, newest first.
    const entries = await c.db.collection('journal_entries').find(
      { societyId: c.society.id, 'lines.ledgerId': id },
      { sort: { date: -1 }, limit: 500 },
    );
    const lines: Document[] = [];
    for (const entry of entries) {
      for (const line of (entry.lines as Document[]) ?? []) {
        if (String(line.ledgerId) !== id) continue;
        const growsOnDebit = ['ASSET', 'EXPENSE'].includes(String(ledger.group));
        const debit = line.type === 'DEBIT' ? Number(line.amount) : 0;
        const credit = line.type === 'CREDIT' ? Number(line.amount) : 0;
        lines.push({
          date: entry.date,
          entryNumber: entry.entryNumber,
          entryId: entry._id,
          narration: entry.narration,
          referenceType: entry.referenceType,
          referenceId: entry.referenceId,
          debit,
          credit,
          // Running balance in the ledger's own natural direction.
          sign: growsOnDebit ? debit - credit : credit - debit,
        });
      }
    }
    lines.sort((a, b) => new Date(b.date as string | Date).getTime() - new Date(a.date as string | Date).getTime());
    let running = Number(ledger.openingBalance ?? 0);
    for (const line of lines.reverse()) {
      running = Math.round((running + Number(line.sign)) * 100) / 100;
      line.balance = running;
    }
    lines.reverse();

    return ok(res, { ...serialise(ledger), statement: lines }, 'Fetched successfully');
  }),
);

accountingRouter.patch(
  '/ledgers/:id',
  authenticate({ clientScopes: ['console'] }),
  requireModule('accounting' as ModuleKey),
  requirePermission('ledger:update', 'accounting:update'),
  validate(z.object({ id: idSchema }), 'params'),
  validate(updateLedgerSchema),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const id = String(req.params.id);
    const ledger = await c.db.collection('ledgers').findOne({ societyId: c.society.id, _id: id });
    if (!ledger) throw ApiError.notFound('Ledger');

    const body = req.body as z.infer<typeof updateLedgerSchema>;
    // System ledgers hold the platform's own accounting wiring; renaming or deactivating one
    // would orphan every entry already posted to it.
    if (ledger.isSystem) {
      const forbidden: Array<keyof typeof body> = ['name', 'type', 'group', 'isActive', 'openingBalance'];
      const attempted = forbidden.filter((f) => body[f] !== undefined);
      if (attempted.length) throw ApiError.forbidden(`System ledgers cannot have ${attempted.join(', ')} changed`);
    }

    const update: Document = { updatedBy: c.principal.userId };
    for (const field of ['name', 'type', 'group', 'vendorId', 'unitId', 'isActive'] as const) {
      if (body[field] !== undefined) update[field] = body[field];
    }
    if (body.openingBalance !== undefined && !ledger.isSystem) update.openingBalance = body.openingBalance;

    await c.db.collection('ledgers').updateOne({ societyId: c.society.id, _id: id }, { $set: update });
    const updated = await c.db.collection('ledgers').findOne({ societyId: c.society.id, _id: id });
    return ok(res, serialise(updated), 'Ledger updated');
  }),
);

accountingRouter.delete(
  '/ledgers/:id',
  authenticate({ clientScopes: ['console'] }),
  requireModule('accounting' as ModuleKey),
  requirePermission('ledger:delete', 'accounting:update'),
  validate(z.object({ id: idSchema }), 'params'),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const id = String(req.params.id);
    const ledger = await c.db.collection('ledgers').findOne({ societyId: c.society.id, _id: id });
    if (!ledger) throw ApiError.notFound('Ledger');
    if (ledger.isSystem) throw ApiError.forbidden('System ledgers cannot be deleted');

    const used = await c.db.collection('journal_entries').countDocuments({ societyId: c.society.id, 'lines.ledgerId': id });
    if (used > 0) throw ApiError.conflict(`This ledger has ${used} journal entry(ies) and cannot be deleted — deactivate it instead`);

    await c.db.collection('ledgers').deleteOne({ societyId: c.society.id, _id: id });
    return ok(res, { id }, 'Ledger deleted');
  }),
);

/* ------------------------------- journal entries ----------------------------- */

accountingRouter.get(
  '/journal-entries',
  authenticate({ clientScopes: ['console'] }),
  requireModule('accounting' as ModuleKey),
  requirePermission('accounting:view', 'ledger:view'),
  validate(
    z.object({
      page: z.coerce.number().int().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
      referenceType: z.enum(['PAYMENT', 'RECEIPT', 'EXPENSE', 'INCOME', 'BILL', 'ADJUSTMENT', 'OPENING']).optional(),
      ledgerId: idSchema.optional(),
      from: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }),
    'query',
  ),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const q = req.query as { page?: number; limit?: number; referenceType?: string; ledgerId?: string; from?: string; to?: string };
    const { page, limit, skip } = parsePagination({ page: q.page, limit: q.limit }, { defaultSort: 'date' });

    const filter: Document = { societyId: c.society.id };
    if (q.referenceType) filter.referenceType = q.referenceType;
    if (q.ledgerId) filter['lines.ledgerId'] = q.ledgerId;
    if (q.from || q.to) {
      filter.date = {};
      if (q.from) filter.date.$gte = startOfDay(q.from);
      if (q.to) filter.date.$lte = endOfDay(q.to);
    }

    const [items, total] = await Promise.all([
      c.db.collection('journal_entries').find(filter, { sort: { date: -1, createdAt: -1 }, skip, limit }),
      c.db.collection('journal_entries').countDocuments(filter),
    ]);
    return paginated(res, { items: serialiseMany(items), total, page, limit, sortBy: 'date', sortDir: 'desc' });
  }),
);

/** Post a manual journal entry. Debits must equal credits or it is rejected outright (§29). */
accountingRouter.post(
  '/journal-entries',
  authenticate({ clientScopes: ['console'] }),
  requireModule('accounting' as ModuleKey),
  requirePermission('accounting:update', 'accounting:create'),
  validate(createJournalEntrySchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createJournalEntrySchema>;
    const entry = await accounting.postJournalEntry(accountingCtx(req), {
      date: body.date,
      narration: body.narration,
      lines: body.lines.map((l) => ({ ledgerId: l.ledgerId, type: l.type, amount: l.amount, note: l.note ?? null })),
      referenceType: body.referenceType,
      referenceId: body.referenceId ?? null,
    });
    return created(res, serialise(entry), 'Journal entry posted');
  }),
);

accountingRouter.get(
  '/journal-entries/:id',
  authenticate({ clientScopes: ['console'] }),
  requireModule('accounting' as ModuleKey),
  requirePermission('accounting:view', 'ledger:view'),
  validate(z.object({ id: idSchema }), 'params'),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const entry = await c.db.collection('journal_entries').findOne({ societyId: c.society.id, _id: String(req.params.id) });
    if (!entry) throw ApiError.notFound('Journal entry');

    // Resolve ledger names so the entry reads without a second round-trip per line.
    const ledgerIds = Array.from(new Set(((entry.lines as Document[]) ?? []).map((l) => String(l.ledgerId))));
    const ledgers = ledgerIds.length
      ? await c.db.collection('ledgers').find({ societyId: c.society.id, _id: { $in: ledgerIds } }, { limit: ledgerIds.length })
      : [];
    const nameById = new Map(ledgers.map((l) => [String(l._id), String(l.name)]));

    return ok(
      res,
      {
        ...serialise(entry),
        lines: ((entry.lines as Document[]) ?? []).map((l) => ({ ...l, ledgerName: nameById.get(String(l.ledgerId)) ?? null })),
      },
      'Fetched successfully',
    );
  }),
);

/** Correct a mistake the way an auditor expects: a reversing entry, never an edit (§29). */
accountingRouter.post(
  '/journal-entries/:id/reverse',
  authenticate({ clientScopes: ['console'] }),
  requireModule('accounting' as ModuleKey),
  requirePermission('accounting:update', 'accounting:delete'),
  validate(z.object({ id: idSchema }), 'params'),
  validate(z.object({ reason: z.string().trim().min(5).max(500) })),
  asyncHandler(async (req, res) => {
    const reason = String((req.body as { reason: string }).reason);
    const reversal = await accounting.reverseJournalEntry(accountingCtx(req), String(req.params.id), reason);
    return created(res, serialise(reversal), 'Journal entry reversed');
  }),
);

/* --------------------------------- reports ---------------------------------- */

accountingRouter.get(
  '/trial-balance',
  authenticate({ clientScopes: ['console'] }),
  requireModule('accounting' as ModuleKey),
  requirePermission('accounting:view', 'report:view'),
  validate(trialBalanceQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as z.infer<typeof trialBalanceQuerySchema>;
    const to = endOfDay(q.to ?? q.asOf ?? new Date());
    const from = startOfDay(q.from ?? new Date(to.getTime() - 364 * 86_400_000));
    if (from > to) throw ApiError.badRequest('The "from" date must be before the "to" date');
    return ok(res, await accounting.trialBalance(accountingCtx(req), from, to), 'Trial balance');
  }),
);

accountingRouter.get(
  '/income-statement',
  authenticate({ clientScopes: ['console'] }),
  requireModule('accounting' as ModuleKey),
  requirePermission('accounting:view', 'report:view'),
  validate(trialBalanceQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as z.infer<typeof trialBalanceQuerySchema>;
    const to = endOfDay(q.to ?? q.asOf ?? new Date());
    const from = startOfDay(q.from ?? new Date(to.getTime() - 364 * 86_400_000));
    if (from > to) throw ApiError.badRequest('The "from" date must be before the "to" date');
    return ok(res, await accounting.incomeStatement(accountingCtx(req), from, to), 'Income statement');
  }),
);

accountingRouter.get(
  '/balance-sheet',
  authenticate({ clientScopes: ['console'] }),
  requireModule('accounting' as ModuleKey),
  requirePermission('accounting:view', 'report:view'),
  validate(trialBalanceQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as z.infer<typeof trialBalanceQuerySchema>;
    const asOf = endOfDay(q.asOf ?? q.to ?? new Date());
    return ok(res, await accounting.balanceSheet(accountingCtx(req), asOf), 'Balance sheet');
  }),
);

/** Recompute every ledger balance from the journal — the repair tool (§29). */
accountingRouter.post(
  '/rebuild-balances',
  authenticate({ clientScopes: ['console'] }),
  requireModule('accounting' as ModuleKey),
  requirePermission('accounting:update', 'accounting:manage'),
  asyncHandler(async (req, res) => ok(res, await accounting.rebuildLedgerBalances(accountingCtx(req)), 'Ledger balances rebuilt')),
);

/* --------------------------------- expenses --------------------------------- */

export const expensesRouter: Router = Router();

expensesRouter.get(
  '/',
  authenticate({ clientScopes: ['console'] }),
  requireModule('accounting' as ModuleKey),
  requirePermission('expense:view', 'accounting:view'),
  validate(
    z.object({
      page: z.coerce.number().int().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
      status: z.enum(['DRAFT', 'SUBMITTED', 'APPROVED', 'PAID', 'REJECTED']).optional(),
      isPaid: z.coerce.boolean().optional(),
      vendorId: idSchema.optional(),
      ledgerId: idSchema.optional(),
      from: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }),
    'query',
  ),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const q = req.query as { page?: number; limit?: number; status?: string; isPaid?: boolean; vendorId?: string; ledgerId?: string; from?: string; to?: string };
    const { page, limit, skip } = parsePagination({ page: q.page, limit: q.limit }, { defaultSort: 'date' });

    const filter: Document = { societyId: c.society.id };
    if (q.status) filter.status = q.status;
    if (q.isPaid !== undefined) filter.isPaid = q.isPaid;
    if (q.vendorId) filter.vendorId = q.vendorId;
    if (q.ledgerId) filter.ledgerId = q.ledgerId;
    if (q.from || q.to) {
      filter.date = {};
      if (q.from) filter.date.$gte = startOfDay(q.from);
      if (q.to) filter.date.$lte = endOfDay(q.to);
    }

    const [items, total] = await Promise.all([
      c.db.collection('expenses').find(filter, { sort: { date: -1, createdAt: -1 }, skip, limit }),
      c.db.collection('expenses').countDocuments(filter),
    ]);
    return paginated(res, { items: serialiseMany(items), total, page, limit, sortBy: 'date', sortDir: 'desc' });
  }),
);

/** Record an expense — books the journal entry at the same time (§29). */
expensesRouter.post(
  '/',
  authenticate({ clientScopes: ['console'] }),
  requireModule('accounting' as ModuleKey),
  requirePermission('expense:create', 'accounting:update'),
  validate(createExpenseSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createExpenseSchema>;
    const expense = await accounting.recordExpense(accountingCtx(req), {
      title: body.title,
      ledgerId: body.ledgerId,
      amount: body.amount,
      date: body.date,
      vendorId: body.vendorId ?? null,
      category: body.category ?? null,
      gstin: body.gstin ?? null,
      taxableAmount: body.taxableAmount ?? null,
      cgst: body.cgst,
      sgst: body.sgst,
      igst: body.igst,
      invoiceNumber: body.invoiceNumber ?? null,
      paymentMode: body.paymentMode ?? null,
      attachments: body.attachments,
      note: body.note ?? null,
      isPaid: body.isPaid,
      approvedBy: body.approvedBy ?? null,
    });
    return created(res, serialise(expense), 'Expense recorded');
  }),
);

expensesRouter.get(
  '/:id',
  authenticate({ clientScopes: ['console'] }),
  requireModule('accounting' as ModuleKey),
  requirePermission('expense:view', 'accounting:view'),
  validate(z.object({ id: idSchema }), 'params'),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const expense = await c.db.collection('expenses').findOne({ societyId: c.society.id, _id: String(req.params.id) });
    if (!expense) throw ApiError.notFound('Expense');
    return ok(res, serialise(expense), 'Fetched successfully');
  }),
);

expensesRouter.patch(
  '/:id',
  authenticate({ clientScopes: ['console'] }),
  requireModule('accounting' as ModuleKey),
  requirePermission('expense:update', 'accounting:update'),
  validate(z.object({ id: idSchema }), 'params'),
  validate(updateExpenseSchema),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const id = String(req.params.id);
    const expense = await c.db.collection('expenses').findOne({ societyId: c.society.id, _id: id });
    if (!expense) throw ApiError.notFound('Expense');
    // Once money has moved, the record is history: settle or reverse it, do not edit it.
    if (expense.isPaid) throw ApiError.conflict('A paid expense cannot be edited — record a reversal instead');

    const body = req.body as z.infer<typeof updateExpenseSchema>;
    if (body.isPaid) throw ApiError.badRequest('Use POST /:id/pay to settle an expense so the ledger entry is posted');

    const update: Document = { updatedBy: c.principal.userId };
    for (const field of ['title', 'ledgerId', 'vendorId', 'amount', 'date', 'category', 'gstin', 'taxableAmount', 'cgst', 'sgst', 'igst', 'invoiceNumber', 'paymentMode', 'attachments', 'note'] as const) {
      if (body[field] !== undefined) update[field] = body[field];
    }
    await c.db.collection('expenses').updateOne({ societyId: c.society.id, _id: id }, { $set: update });
    const updated = await c.db.collection('expenses').findOne({ societyId: c.society.id, _id: id });
    return ok(res, serialise(updated), 'Expense updated');
  }),
);

/** Settle an unpaid expense: moves it out of Sundry Creditors and through Bank / Cash. */
expensesRouter.post(
  '/:id/pay',
  authenticate({ clientScopes: ['console'] }),
  requireModule('accounting' as ModuleKey),
  requirePermission('expense:update', 'payment:record', 'accounting:update'),
  validate(z.object({ id: idSchema }), 'params'),
  validate(z.object({ paymentMode: z.string().trim().max(30).optional(), paidAt: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional() })),
  asyncHandler(async (req, res) => {
    const body = req.body as { paymentMode?: string; paidAt?: string };
    const expense = await accounting.markExpensePaid(accountingCtx(req), String(req.params.id), {
      paymentMode: body.paymentMode,
      paidAt: body.paidAt,
    });
    return ok(res, serialise(expense), 'Expense marked as paid');
  }),
);

/* --------------------------------- incomes ---------------------------------- */

export const incomesRouter: Router = Router();

incomesRouter.get(
  '/',
  authenticate({ clientScopes: ['console'] }),
  requireModule('accounting' as ModuleKey),
  requirePermission('accounting:view', 'ledger:view'),
  validate(
    z.object({
      page: z.coerce.number().int().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
      ledgerId: idSchema.optional(),
      unitId: idSchema.optional(),
      from: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      to: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }),
    'query',
  ),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const q = req.query as { page?: number; limit?: number; ledgerId?: string; unitId?: string; from?: string; to?: string };
    const { page, limit, skip } = parsePagination({ page: q.page, limit: q.limit }, { defaultSort: 'date' });

    const filter: Document = { societyId: c.society.id };
    if (q.ledgerId) filter.ledgerId = q.ledgerId;
    if (q.unitId) filter.unitId = q.unitId;
    if (q.from || q.to) {
      filter.date = {};
      if (q.from) filter.date.$gte = startOfDay(q.from);
      if (q.to) filter.date.$lte = endOfDay(q.to);
    }

    const [items, total] = await Promise.all([
      c.db.collection('incomes').find(filter, { sort: { date: -1, createdAt: -1 }, skip, limit }),
      c.db.collection('incomes').countDocuments(filter),
    ]);
    return paginated(res, { items: serialiseMany(items), total, page, limit, sortBy: 'date', sortDir: 'desc' });
  }),
);

/**
 * Record income that did not come through a bill or a booking — interest, hoarding rent,
 * donations collected offline (§29). Bill and amenity receipts post themselves.
 */
incomesRouter.post(
  '/',
  authenticate({ clientScopes: ['console'] }),
  requireModule('accounting' as ModuleKey),
  requirePermission('accounting:update', 'accounting:create'),
  validate(createIncomeSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createIncomeSchema>;
    const income = await accounting.recordIncome(accountingCtx(req), {
      title: body.title,
      ledgerId: body.ledgerId,
      amount: body.amount,
      date: body.date,
      unitId: body.unitId ?? null,
      source: body.source ?? null,
      gstin: body.gstin ?? null,
      taxableAmount: body.taxableAmount ?? null,
      cgst: body.cgst,
      sgst: body.sgst,
      igst: body.igst,
      invoiceNumber: body.invoiceNumber ?? null,
      attachments: body.attachments,
      note: body.note ?? null,
    });
    return created(res, serialise(income), 'Income recorded');
  }),
);

incomesRouter.get(
  '/:id',
  authenticate({ clientScopes: ['console'] }),
  requireModule('accounting' as ModuleKey),
  requirePermission('accounting:view', 'ledger:view'),
  validate(z.object({ id: idSchema }), 'params'),
  asyncHandler(async (req, res) => {
    const c = requireTenantContext(req);
    const income = await c.db.collection('incomes').findOne({ societyId: c.society.id, _id: String(req.params.id) });
    if (!income) throw ApiError.notFound('Income');
    return ok(res, serialise(income), 'Fetched successfully');
  }),
);
