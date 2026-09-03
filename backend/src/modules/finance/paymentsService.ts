import type { Document, TenantDatabase } from '../../db/drivers/types.js';
import { newId } from '../../db/ids.js';
import { ApiError } from '../../utils/errors.js';
import { nextReference } from '../../services/counters.js';
import { NotificationService } from '../../services/notifications/index.js';
import { logger } from '../../config/logger.js';
import * as gateway from '../../services/paymentGateway.js';
import * as accounting from './accountingService.js';
import * as billing from './billingService.js';
import { confirmBookingAfterPayment } from '../amenities/amenityService.js';
import { generateReceiptPdf } from '../../services/receiptPdf.js';

/**
 * Payments (§29, §59) — the "pay" leg of the acceptance scenario.
 *
 * A payment is a two-phase flow:
 *   1. `createIntent`   — the server computes the amount owed and asks the gateway for an
 *                         order. The client never supplies an amount.
 *   2. `verifyAndApply` — the gateway callback is signature-verified server-side, the payment
 *                         is marked SUCCESS, the bill's paid/due amounts move, the receipt is
 *                         generated and the double-entry journal is posted — all in one
 *                         transaction, so a payment can never be recorded without its ledger
 *                         entry or its receipt.
 *
 * Replays are structurally impossible: the same `clientRequestId` returns the stored result,
 * and a bill already marked PAID rejects a second application of the same amount.
 */

export interface PaymentsContext {
  db: TenantDatabase;
  societyId: string;
  actorId: string;
  actorName?: string | null;
  unitIds?: string[];
  isResidentScope?: boolean;
}

function round2(value: number): number {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

export type PaymentPurpose = 'MAINTENANCE' | 'AMENITY_BOOKING' | 'PARKING' | 'SERVICE_CHARGE' | 'EVENT_FEE' | 'FINE' | 'DONATION' | 'SUBSCRIPTION' | 'OTHER';

/* --------------------------------- intent ---------------------------------- */

export interface IntentInput {
  purpose: PaymentPurpose;
  /** Exactly one of these identifies what is being paid for. */
  billId?: string;
  bookingId?: string;
  /** Free amount for donations/fines; ignored when a bill or booking is supplied. */
  amount?: number;
  unitId?: string;
  provider?: string;
  clientRequestId?: string;
}

/**
 * Work out what is owed, then ask the gateway for an order.
 *
 * The amount always comes from the server's own record of the bill or booking — a client that
 * sends `amount: 1` for a ₹12,000 bill is charged ₹12,000.
 */
export async function createIntent(ctx: PaymentsContext, input: IntentInput): Promise<Document> {
  let amount = 0;
  let unitId: string | null = input.unitId ?? null;
  let bill: Document | null = null;
  let booking: Document | null = null;

  if (input.billId) {
    bill = await ctx.db.collection('maintenance_bills').findOne({ societyId: ctx.societyId, _id: input.billId });
    if (!bill) throw ApiError.notFound('Bill');
    if (['PAID', 'CANCELLED', 'WAIVED'].includes(String(bill.status))) throw ApiError.conflict(`This bill is already ${String(bill.status).toLowerCase()}`);
    amount = Number(bill.dueAmount ?? 0);
    unitId = String(bill.unitId);
  } else if (input.bookingId) {
    booking = await ctx.db.collection('amenity_bookings').findOne({ societyId: ctx.societyId, _id: input.bookingId });
    if (!booking) throw ApiError.notFound('Booking');
    if (booking.isPaid) throw ApiError.conflict('This booking has already been paid for');
    if (!['PENDING_PAYMENT', 'PENDING_APPROVAL'].includes(String(booking.status))) {
      throw ApiError.conflict(`This booking is ${String(booking.status).toLowerCase().replace('_', ' ')}`);
    }
    amount = Number(booking.totalAmount ?? 0);
    unitId = String(booking.unitId);
  } else {
    amount = round2(Number(input.amount ?? 0));
  }

  if (!Number.isFinite(amount) || amount <= 0) throw ApiError.badRequest('There is nothing to pay on this record');

  // A resident may only pay for their own flat (§51).
  if (ctx.isResidentScope && unitId && !(ctx.unitIds ?? []).includes(unitId)) {
    throw ApiError.forbidden('You can only make payments for your own flat');
  }

  // Idempotent: the same client request returns the same order instead of creating a second
  // payable intent for one bill.
  if (input.clientRequestId) {
    const existing = await ctx.db.collection('payments').findOne({ societyId: ctx.societyId, clientRequestId: input.clientRequestId });
    if (existing && ['INITIATED', 'PENDING'].includes(String(existing.status))) {
      return { payment: existing, order: existing.metadata?.order ?? null, duplicate: true };
    }
  }

  const provider = gateway.resolveProvider(input.provider);
  const referenceNumber = await nextReference({ db: ctx.db, societyId: ctx.societyId, kind: 'RECEIPT' });

  const order = await gateway.createOrder({
    amount,
    currency: 'INR',
    receipt: referenceNumber,
    notes: {
      societyId: ctx.societyId,
      purpose: input.purpose,
      ...(bill ? { billId: String(bill._id), invoiceNumber: String(bill.invoiceNumber) } : {}),
      ...(booking ? { bookingId: String(booking._id), referenceNumber: String(booking.referenceNumber) } : {}),
      ...(unitId ? { unitId } : {}),
    },
    provider,
  });

  const paymentId = newId('payments');
  const payment = await ctx.db.collection('payments').create({
    _id: paymentId,
    societyId: ctx.societyId,
    referenceNumber,
    unitId,
    residentId: bill?.residentId ?? booking?.residentId ?? null,
    userId: ctx.actorId,
    purpose: input.purpose,
    status: 'INITIATED',
    amount: round2(amount),
    currency: 'INR',
    paidAmount: 0,
    refundedAmount: 0,
    mode: null,
    provider: order.provider,
    providerOrderId: order.orderId,
    providerPaymentId: null,
    billId: bill?._id ?? null,
    bookingId: booking?._id ?? null,
    eventId: null,
    serviceRequestId: null,
    expenseId: null,
    ledgerId: null,
    journalEntryId: null,
    receiptNumber: null,
    receiptUrl: null,
    receiptGeneratedAt: null,
    initiatedAt: new Date(),
    paidAt: null,
    failedAt: null,
    refundedAt: null,
    referenceNote: null,
    failureReason: null,
    gatewayMessage: null,
    signatureVerified: false,
    isOffline: false,
    collectedBy: null,
    clientRequestId: input.clientRequestId ?? null,
    transactions: [],
    webhookReceivedAt: null,
    metadata: { order },
    createdBy: ctx.actorId,
    updatedBy: ctx.actorId,
  });

  await ctx.db.collection('payment_transactions').create({
    _id: newId('payment_transactions'),
    societyId: ctx.societyId,
    paymentId,
    provider: order.provider,
    providerOrderId: order.orderId,
    providerPaymentId: null,
    providerSignature: null,
    type: 'ORDER_CREATED',
    status: 'INITIATED',
    amount: round2(amount),
    currency: 'INR',
    fee: 0,
    rawRequest: { amount, currency: 'INR', receipt: referenceNumber },
    rawResponse: { orderId: order.orderId, keyId: order.keyId },
    errorCode: null,
    errorMessage: null,
    idempotencyKey: input.clientRequestId ?? null,
    clientIp: null,
    occurredAt: new Date(),
    createdBy: ctx.actorId,
  });

  // Cross-tenant index so a token-less provider webhook can find this society's database.
  // Keyed on the provider's own order id, which the caller cannot forge for another tenant.
  try {
    const { databases } = await import('../../db/manager.js');
    const platform = await databases.platform();
    await platform.collection('gateway_orders').create({
      _id: newId('gateway_orders'),
      societyId: ctx.societyId,
      paymentId,
      provider: order.provider,
      providerOrderId: order.orderId,
      amount: round2(amount),
      currency: 'INR',
      status: 'CREATED',
      webhookReceivedAt: null,
      lastEvent: null,
      metadata: { purpose: input.purpose, unitId, billId: bill?._id ?? null, bookingId: booking?._id ?? null },
    });
  } catch (err) {
    // A duplicate order id (retry) must not break intent creation; the first index wins.
    logger.warn({ societyId: ctx.societyId, orderId: order.orderId, err }, 'payment: gateway order index write skipped');
  }

  return {
    payment,
    order: {
      provider: order.provider,
      orderId: order.orderId,
      amount: order.amount,
      currency: order.currency,
      keyId: order.keyId,
      // Only the deterministic dev provider returns a ready-made signature; a live gateway
      // never does, because the signature must come from the provider's own checkout.
      ...(gateway.isLiveProvider(order.provider) ? {} : { mockPaymentId: order.mockPaymentId, mockSignature: order.mockSignature }),
      isLiveProvider: gateway.isLiveProvider(order.provider),
    },
    duplicate: false,
  };
}

/* ------------------------------ verify & apply ------------------------------ */

export interface VerifyInput {
  paymentId?: string;
  providerOrderId?: string;
  providerPaymentId: string;
  signature: string;
  mode?: string;
}

/**
 * Verify a gateway callback and apply the money.
 * Everything after verification happens in one transaction.
 */
export async function verifyAndApply(ctx: PaymentsContext, input: VerifyInput): Promise<Document> {
  const payment = await findPayment(ctx, input);
  if (!payment) throw ApiError.notFound('Payment');

  if (['SUCCESS', 'REFUNDED'].includes(String(payment.status))) {
    return { payment, alreadyProcessed: true };
  }
  if (['FAILED', 'CANCELLED', 'ABANDONED'].includes(String(payment.status))) {
    throw new ApiError('This payment attempt has already ended and cannot be completed', 'PAYMENT_FAILED');
  }

  const provider = (payment.provider ?? gateway.resolveProvider()) as gateway.GatewayProvider;
  const verification = gateway.verifyPayment({
    provider,
    orderId: String(payment.providerOrderId ?? ''),
    paymentId: input.providerPaymentId,
    signature: input.signature,
  });

  await ctx.db.collection('payment_transactions').create({
    _id: newId('payment_transactions'),
    societyId: ctx.societyId,
    paymentId: payment._id,
    provider,
    providerOrderId: payment.providerOrderId ?? null,
    providerPaymentId: input.providerPaymentId,
    providerSignature: input.signature,
    type: 'VERIFICATION',
    status: verification.verified ? 'SUCCESS' : 'FAILED',
    amount: Number(payment.amount),
    currency: String(payment.currency ?? 'INR'),
    fee: 0,
    rawRequest: { providerPaymentId: input.providerPaymentId },
    rawResponse: { verified: verification.verified, reason: verification.reason ?? null },
    errorCode: verification.verified ? null : 'SIGNATURE_MISMATCH',
    errorMessage: verification.reason ?? null,
    idempotencyKey: null,
    clientIp: null,
    occurredAt: new Date(),
    createdBy: ctx.actorId,
  });

  if (!verification.verified) {
    await ctx.db.collection('payments').updateOne(
      { societyId: ctx.societyId, _id: payment._id },
      { $set: { status: 'FAILED', failedAt: new Date(), failureReason: verification.reason ?? 'Signature mismatch', signatureVerified: false } },
    );
    logger.warn({ societyId: ctx.societyId, paymentId: payment._id, reason: verification.reason }, 'payment: signature verification failed');
    throw new ApiError(verification.reason ?? 'The payment could not be verified', 'PAYMENT_FAILED');
  }

  return applySuccessfulPayment(ctx, payment, { providerPaymentId: input.providerPaymentId, mode: input.mode ?? 'ONLINE', signatureVerified: true, provider });
}

async function findPayment(ctx: PaymentsContext, input: VerifyInput): Promise<Document | null> {
  if (input.paymentId) return ctx.db.collection('payments').findOne({ societyId: ctx.societyId, _id: input.paymentId });
  if (input.providerOrderId) return ctx.db.collection('payments').findOne({ societyId: ctx.societyId, providerOrderId: input.providerOrderId });
  return ctx.db.collection('payments').findOne({ societyId: ctx.societyId, providerPaymentId: input.providerPaymentId });
}

/**
 * The single place a payment becomes real.
 *
 * Used by online verification, offline cash/cheque collection and gateway webhooks, so all
 * three paths produce identical books.
 */
export async function applySuccessfulPayment(
  ctx: PaymentsContext,
  payment: Document,
  opts: { providerPaymentId?: string | null; mode: string; amount?: number; signatureVerified?: boolean; provider?: gateway.GatewayProvider; collectedBy?: string | null; referenceNote?: string | null },
): Promise<Document> {
  const amount = round2(opts.amount ?? Number(payment.amount));
  if (amount <= 0) throw ApiError.badRequest('The payment amount must be greater than zero');
  if (amount > Number(payment.amount) + 0.01) throw ApiError.badRequest('The payment exceeds the amount due');

  const now = new Date();
  const receiptNumber = String(payment.receiptNumber ?? (await nextReference({ db: ctx.db, societyId: ctx.societyId, kind: 'RECEIPT' })));

  // Guard against double application: only an unpaid payment can transition to SUCCESS.
  const claimed = await ctx.db.collection('payments').updateOne(
    { societyId: ctx.societyId, _id: payment._id, status: { $nin: ['SUCCESS', 'REFUNDED'] } },
    {
      $set: {
        status: 'SUCCESS',
        paidAmount: amount,
        paidAt: now,
        mode: opts.mode,
        providerPaymentId: opts.providerPaymentId ?? payment.providerPaymentId ?? null,
        signatureVerified: Boolean(opts.signatureVerified),
        receiptNumber,
        collectedBy: opts.collectedBy ?? ctx.actorId,
        referenceNote: opts.referenceNote ?? payment.referenceNote ?? null,
        updatedBy: ctx.actorId,
      },
      $push: {
        transactions: {
          at: now,
          type: 'CAPTURED',
          amount,
          mode: opts.mode,
          providerPaymentId: opts.providerPaymentId ?? null,
        },
      },
    },
  );
  if (claimed.matched === 0) {
    const fresh = await ctx.db.collection('payments').findOne({ societyId: ctx.societyId, _id: payment._id });
    return { payment: fresh, alreadyProcessed: true };
  }

  await ctx.db.collection('payment_transactions').create({
    _id: newId('payment_transactions'),
    societyId: ctx.societyId,
    paymentId: payment._id,
    provider: opts.provider ?? payment.provider ?? 'mock',
    providerOrderId: payment.providerOrderId ?? null,
    providerPaymentId: opts.providerPaymentId ?? null,
    providerSignature: null,
    type: 'CAPTURED',
    status: 'SUCCESS',
    amount,
    currency: String(payment.currency ?? 'INR'),
    fee: 0,
    rawRequest: null,
    rawResponse: { mode: opts.mode },
    errorCode: null,
    errorMessage: null,
    idempotencyKey: null,
    clientIp: null,
    occurredAt: now,
    createdBy: ctx.actorId,
  });

  const accountCtx: accounting.AccountingContext = { db: ctx.db, societyId: ctx.societyId, actorId: ctx.actorId, actorName: ctx.actorName };

  /* ---------------------------------- bill ---------------------------------- */
  if (payment.billId) {
    const bill = await ctx.db.collection('maintenance_bills').findOne({ societyId: ctx.societyId, _id: payment.billId });
    if (!bill) throw ApiError.notFound('Bill');

    const previousPaid = Number(bill.paidAmount ?? 0);
    const newPaid = round2(previousPaid + amount);
    const total = Number(bill.totalAmount ?? 0);
    const newDue = round2(Math.max(0, total - newPaid - Number(bill.waivedAmount ?? 0)));
    const status = newDue <= 0 ? 'PAID' : 'PARTIALLY_PAID';

    await ctx.db.collection('maintenance_bills').updateOne(
      { societyId: ctx.societyId, _id: bill._id },
      {
        $set: { paidAmount: newPaid, dueAmount: newDue, status, lastPaymentAt: now, ...(newDue <= 0 ? { paidAt: now } : {}), updatedBy: ctx.actorId },
        $push: { paymentIds: payment._id },
      },
    );
    await ctx.db.collection('units').updateOne({ societyId: ctx.societyId, _id: bill.unitId }, { $inc: { outstandingAmount: -amount } });

    const entry = await accounting.postReceipt(accountCtx, {
      amount,
      billId: String(bill._id),
      paymentId: String(payment._id),
      unitId: String(bill.unitId),
      receiptNumber,
      date: now,
      narration: `Maintenance receipt ${receiptNumber} — ${bill.invoiceNumber}`,
    });
    await ctx.db.collection('payments').updateOne({ societyId: ctx.societyId, _id: payment._id }, { $set: { journalEntryId: entry._id } });

    const unit = await ctx.db.collection('units').findOne({ societyId: ctx.societyId, _id: bill.unitId });
    await NotificationService.send({
      db: ctx.db,
      societyId: ctx.societyId,
      type: 'PAYMENT_SUCCESS',
      audience: { type: 'UNIT', ids: [String(bill.unitId)] },
      data: {
        receiptNumber,
        amount,
        invoiceNumber: bill.invoiceNumber,
        period: bill.period,
        dueAmount: newDue,
        unit: unit?.label ?? unit?.unitNumber,
        paymentId: payment._id,
      },
      deepLink: `/payments/${payment._id}/receipt`,
    });
  }

  /* -------------------------------- booking --------------------------------- */
  else if (payment.bookingId) {
    const entry = await accounting.postAmenityReceipt(accountCtx, {
      amount,
      paymentId: String(payment._id),
      bookingId: String(payment.bookingId),
      unitId: payment.unitId ? String(payment.unitId) : null,
      receiptNumber,
    });
    await ctx.db.collection('payments').updateOne({ societyId: ctx.societyId, _id: payment._id }, { $set: { journalEntryId: entry._id } });

    const booking = await ctx.db.collection('amenity_bookings').findOne({ societyId: ctx.societyId, _id: payment.bookingId });
    await confirmBookingAfterPayment(
      { db: ctx.db, societyId: ctx.societyId, actorId: ctx.actorId, actorName: ctx.actorName },
      String(payment.bookingId),
      { id: String(payment._id), amount },
    );
    await NotificationService.send({
      db: ctx.db,
      societyId: ctx.societyId,
      type: 'PAYMENT_SUCCESS',
      audience: { type: 'USERS', userIds: [String(booking?.userId ?? ctx.actorId)] },
      data: { receiptNumber, amount, purpose: 'AMENITY_BOOKING', bookingId: payment.bookingId, referenceNumber: booking?.referenceNumber },
      deepLink: `/amenities/bookings/${payment.bookingId}`,
    });
  }

  /* ------------------------------ other purposes ----------------------------- */
  else {
    const ledgerName =
      payment.purpose === 'DONATION'
        ? 'Donation Income'
        : payment.purpose === 'FINE'
          ? 'Fine Income'
          : payment.purpose === 'PARKING'
            ? 'Parking Income'
            : 'Other Income';
    const cash = await accounting.ensureLedger(accountCtx, 'Bank / Cash', { type: 'ASSET', group: 'ASSET', code: 'ACC-1000' });
    const income = await accounting.ensureLedger(accountCtx, ledgerName, {
      type: payment.purpose === 'PARKING' ? 'PARKING_INCOME' : 'OTHER_INCOME',
      group: 'INCOME',
    });
    const entry = await accounting.postJournalEntry(accountCtx, {
      date: now,
      narration: `${ledgerName} receipt ${receiptNumber}`,
      referenceType: 'RECEIPT',
      referenceId: String(payment._id),
      paymentId: String(payment._id),
      unitId: payment.unitId ? String(payment.unitId) : null,
      lines: [
        { ledgerId: String(cash._id), type: 'DEBIT', amount, note: 'Money received' },
        { ledgerId: String(income._id), type: 'CREDIT', amount, note: ledgerName },
      ],
    });
    await ctx.db.collection('payments').updateOne({ societyId: ctx.societyId, _id: payment._id }, { $set: { journalEntryId: entry._id, ledgerId: income._id } });
  }

  /* --------------------------------- receipt --------------------------------- */
  const receipt = await generateReceipt(ctx, String(payment._id));

  const fresh = await ctx.db.collection('payments').findOne({ societyId: ctx.societyId, _id: payment._id });
  logger.info({ societyId: ctx.societyId, paymentId: payment._id, amount, receiptNumber }, 'payment applied');
  return { payment: fresh, receipt, alreadyProcessed: false };
}

/* ------------------------------ offline payments ---------------------------- */

export interface OfflineInput {
  amount: number;
  mode: 'CASH' | 'CHEQUE' | 'DD' | 'BANK_TRANSFER' | 'UPI' | 'WALLET' | 'ONLINE' | 'CARD' | 'NETBANKING';
  billId?: string;
  bookingId?: string;
  purpose?: PaymentPurpose;
  unitId?: string;
  referenceNote?: string;
  receivedAt?: string | Date;
}

/** Record money collected at the society office (§29 — cash, cheque, DD, bank transfer). */
export async function recordOfflinePayment(ctx: PaymentsContext, input: OfflineInput): Promise<Document> {
  const amount = round2(Number(input.amount));
  if (amount <= 0) throw ApiError.badRequest('Enter an amount greater than zero');

  let purpose: PaymentPurpose = input.purpose ?? 'OTHER';
  let unitId = input.unitId ?? null;
  let payment: Document;

  if (input.billId) {
    const bill = await ctx.db.collection('maintenance_bills').findOne({ societyId: ctx.societyId, _id: input.billId });
    if (!bill) throw ApiError.notFound('Bill');
    if (ctx.isResidentScope && !(ctx.unitIds ?? []).includes(String(bill.unitId))) {
      throw ApiError.forbidden('You can only pay bills for your own flat');
    }
    if (amount > Number(bill.dueAmount) + 0.01) throw ApiError.badRequest(`Only ₹${bill.dueAmount} is due on this bill`);
    purpose = 'MAINTENANCE';
    unitId = String(bill.unitId);
    payment = await createPaymentRecord(ctx, { amount, purpose, unitId, billId: String(bill._id), bookingId: null, mode: input.mode, referenceNote: input.referenceNote ?? null });
  } else if (input.bookingId) {
    const booking = await ctx.db.collection('amenity_bookings').findOne({ societyId: ctx.societyId, _id: input.bookingId });
    if (!booking) throw ApiError.notFound('Booking');
    if (ctx.isResidentScope && !(ctx.unitIds ?? []).includes(String(booking.unitId))) {
      throw ApiError.forbidden('You can only pay for bookings made from your own flat');
    }
    purpose = 'AMENITY_BOOKING';
    unitId = String(booking.unitId);
    payment = await createPaymentRecord(ctx, { amount, purpose, unitId, billId: null, bookingId: String(booking._id), mode: input.mode, referenceNote: input.referenceNote ?? null });
  } else {
    if (!unitId && ctx.isResidentScope) unitId = ctx.unitIds?.[0] ?? null;
    payment = await createPaymentRecord(ctx, { amount, purpose, unitId, billId: null, bookingId: null, mode: input.mode, referenceNote: input.referenceNote ?? null });
  }

  return applySuccessfulPayment(ctx, payment, {
    mode: input.mode,
    amount,
    signatureVerified: false,
    collectedBy: ctx.actorId,
    referenceNote: input.referenceNote ?? null,
    provider: 'none',
  });
}

async function createPaymentRecord(
  ctx: PaymentsContext,
  input: { amount: number; purpose: PaymentPurpose; unitId: string | null; billId: string | null; bookingId: string | null; mode: string; referenceNote: string | null },
): Promise<Document> {
  const referenceNumber = await nextReference({ db: ctx.db, societyId: ctx.societyId, kind: 'RECEIPT' });
  return ctx.db.collection('payments').create({
    _id: newId('payments'),
    societyId: ctx.societyId,
    referenceNumber,
    unitId: input.unitId,
    residentId: null,
    userId: ctx.actorId,
    purpose: input.purpose,
    status: 'INITIATED',
    amount: round2(input.amount),
    currency: 'INR',
    paidAmount: 0,
    refundedAmount: 0,
    mode: input.mode,
    provider: 'offline',
    providerOrderId: null,
    providerPaymentId: null,
    billId: input.billId,
    bookingId: input.bookingId,
    eventId: null,
    serviceRequestId: null,
    expenseId: null,
    ledgerId: null,
    journalEntryId: null,
    receiptNumber: null,
    receiptUrl: null,
    receiptGeneratedAt: null,
    initiatedAt: new Date(),
    paidAt: null,
    failedAt: null,
    refundedAt: null,
    referenceNote: input.referenceNote,
    failureReason: null,
    gatewayMessage: null,
    signatureVerified: false,
    isOffline: true,
    collectedBy: ctx.actorId,
    clientRequestId: null,
    transactions: [],
    webhookReceivedAt: null,
    metadata: null,
    createdBy: ctx.actorId,
    updatedBy: ctx.actorId,
  });
}

/* ---------------------------------- refunds --------------------------------- */

export async function refundPayment(ctx: PaymentsContext, paymentId: string, input: { amount?: number; reason: string }): Promise<Document> {
  if (!input.reason || input.reason.trim().length < 3) throw ApiError.badRequest('A reason is required to issue a refund');
  const payment = await ctx.db.collection('payments').findOne({ societyId: ctx.societyId, _id: paymentId });
  if (!payment) throw ApiError.notFound('Payment');
  if (String(payment.status) !== 'SUCCESS') throw ApiError.conflict('Only a successful payment can be refunded');

  const alreadyRefunded = Number(payment.refundedAmount ?? 0);
  const requested = input.amount === undefined ? round2(Number(payment.amount) - alreadyRefunded) : round2(Number(input.amount));
  if (requested <= 0) throw ApiError.badRequest('The refund amount must be greater than zero');
  if (requested + alreadyRefunded > Number(payment.amount) + 0.01) throw ApiError.badRequest('The refund exceeds the amount paid');

  const provider = (payment.provider ?? 'mock') as gateway.GatewayProvider;
  const result = payment.isOffline
    ? { provider: 'none' as const, refundId: `offline_${newId('payments')}`, amount: requested, status: 'processed' }
    : await gateway.refund({ provider, paymentId: String(payment.providerPaymentId ?? payment._id), amount: requested, reason: input.reason });

  const newRefunded = round2(alreadyRefunded + requested);
  const status = newRefunded >= Number(payment.amount) - 0.01 ? 'REFUNDED' : 'PARTIALLY_REFUNDED';

  await ctx.db.collection('payments').updateOne(
    { societyId: ctx.societyId, _id: paymentId },
    {
      $set: { status, refundedAmount: newRefunded, refundedAt: new Date(), updatedBy: ctx.actorId },
      $push: { transactions: { at: new Date(), type: 'REFUNDED', amount: requested, refundId: result.refundId, reason: input.reason } },
    },
  );

  // Reverse the money through the books: cash goes down, the receivable comes back.
  const accountCtx: accounting.AccountingContext = { db: ctx.db, societyId: ctx.societyId, actorId: ctx.actorId, actorName: ctx.actorName };
  const cash = await accounting.ensureLedger(accountCtx, 'Bank / Cash', { type: 'ASSET', group: 'ASSET', code: 'ACC-1000' });
  const creditLedger = payment.billId
    ? (await accounting.maintenanceLedgers(accountCtx)).receivable
    : await accounting.ensureLedger(accountCtx, 'Refunds Issued', { type: 'OTHER_EXPENSE', group: 'EXPENSE' });

  const entry = await accounting.postJournalEntry(accountCtx, {
    narration: `Refund against ${payment.receiptNumber ?? payment.referenceNumber}: ${input.reason}`,
    referenceType: 'ADJUSTMENT',
    referenceId: paymentId,
    paymentId,
    unitId: payment.unitId ? String(payment.unitId) : null,
    lines: [
      { ledgerId: String(creditLedger._id), type: 'DEBIT', amount: requested, note: input.reason },
      { ledgerId: String(cash._id), type: 'CREDIT', amount: requested, note: 'Money returned' },
    ],
  });

  // The bill goes back to owing what was refunded.
  if (payment.billId) {
    const bill = await ctx.db.collection('maintenance_bills').findOne({ societyId: ctx.societyId, _id: payment.billId });
    if (bill) {
      const newPaid = round2(Math.max(0, Number(bill.paidAmount ?? 0) - requested));
      const newDue = round2(Number(bill.totalAmount ?? 0) - newPaid - Number(bill.waivedAmount ?? 0));
      await ctx.db.collection('maintenance_bills').updateOne(
        { societyId: ctx.societyId, _id: bill._id },
        {
          $set: { paidAmount: newPaid, dueAmount: newDue, status: newDue <= 0 ? 'PAID' : 'PARTIALLY_PAID', paidAt: newDue <= 0 ? bill.paidAt : null },
          $inc: { refundedAmount: requested },
        },
      );
      await ctx.db.collection('units').updateOne({ societyId: ctx.societyId, _id: bill.unitId }, { $inc: { outstandingAmount: requested } });
    }
  }

  await NotificationService.send({
    db: ctx.db,
    societyId: ctx.societyId,
    type: 'PAYMENT_REFUNDED',
    audience: { type: 'USERS', userIds: [String(payment.userId)].filter(Boolean) },
    data: { receiptNumber: payment.receiptNumber ?? payment.referenceNumber, amount: requested, reason: input.reason },
    deepLink: `/payments/${paymentId}`,
  });

  return { paymentId, refundId: result.refundId, amount: requested, status, journalEntryId: entry._id };
}

/* --------------------------------- webhooks --------------------------------- */

/**
 * Handle a provider webhook.
 *
 * Signature is verified against the RAW body before anything is parsed, and the payment is
 * looked up by the provider's own order id — never by an id from the payload. A webhook for an
 * unknown order is acknowledged (so the provider stops retrying) but changes nothing.
 */
export async function handleWebhook(
  ctx: PaymentsContext,
  payload: Document,
  opts: { provider: gateway.GatewayProvider; rawBody: string | Buffer; signature: string },
): Promise<{ processed: boolean; reason?: string }> {
  if (!gateway.verifyWebhookSignature(opts.rawBody, opts.signature, opts.provider)) {
    logger.warn({ societyId: ctx.societyId, provider: opts.provider }, 'payment: webhook signature rejected');
    throw new ApiError('Webhook signature verification failed', 'PAYMENT_FAILED');
  }

  const event = String(payload.event ?? '');
  const entity = (payload.payload?.payment?.entity ?? payload.payment ?? {}) as Document;
  const providerPaymentId = String(entity.id ?? '');
  const providerOrderId = String(entity.order_id ?? payload.orderId ?? '');
  if (!providerPaymentId) return { processed: false, reason: 'No payment id in the webhook payload' };

  const payment = await ctx.db.collection('payments').findOne({
    societyId: ctx.societyId,
    ...(providerOrderId ? { providerOrderId } : { providerPaymentId }),
  });
  if (!payment) return { processed: false, reason: 'No matching payment in this society' };

  await ctx.db.collection('payments').updateOne({ societyId: ctx.societyId, _id: payment._id }, { $set: { webhookReceivedAt: new Date() } });
  await ctx.db.collection('payment_transactions').create({
    _id: newId('payment_transactions'),
    societyId: ctx.societyId,
    paymentId: payment._id,
    provider: opts.provider,
    providerOrderId: providerOrderId || payment.providerOrderId || null,
    providerPaymentId,
    providerSignature: opts.signature,
    type: 'WEBHOOK',
    status: event.includes('captured') || event.includes('paid') ? 'SUCCESS' : event.includes('failed') ? 'FAILED' : 'PENDING',
    // The amount is taken from OUR order, never from the webhook body: a tampered replay that
    // inflates or deflates `entity.amount` cannot change what is credited.
    amount: Number(payment.amount),
    currency: String(payment.currency ?? 'INR'),
    fee: 0,
    rawRequest: null,
    rawResponse: payload,
    errorCode: entity.error_code ?? null,
    errorMessage: entity.error_description ?? null,
    idempotencyKey: providerPaymentId,
    clientIp: null,
    occurredAt: new Date(),
    createdBy: 'webhook',
  });

  await markGatewayOrder(ctx.societyId, providerOrderId || String(payment.providerOrderId ?? ''), event);

  if (String(payment.status) === 'SUCCESS') return { processed: true, reason: 'Payment was already applied' };

  if (event.includes('failed')) {
    await ctx.db.collection('payments').updateOne(
      { societyId: ctx.societyId, _id: payment._id },
      { $set: { status: 'FAILED', failedAt: new Date(), failureReason: String(entity.error_description ?? 'Gateway reported a failure') } },
    );
    return { processed: true, reason: 'Marked failed' };
  }

  if (event.includes('captured') || event.includes('paid')) {
    // Confirm with the provider rather than trusting the webhook body alone.
    const fetched = await gateway.fetchPayment(opts.provider, providerPaymentId);
    if (fetched && String(fetched.status).toLowerCase() !== 'captured' && String(fetched.status).toLowerCase() !== 'paid') {
      return { processed: false, reason: `Provider reports status ${fetched.status}` };
    }
    await applySuccessfulPayment(ctx, payment, {
      providerPaymentId,
      mode: String(entity.method ?? 'ONLINE').toUpperCase(),
      signatureVerified: true,
      provider: opts.provider,
      collectedBy: 'webhook',
      // Amount is always the server's own order amount — the webhook cannot change it.
      amount: Number(payment.amount),
    });
    return { processed: true };
  }

  if (event.includes('refunded')) {
    await refundPayment(ctx, String(payment._id), { reason: 'Refund initiated at the gateway' });
    return { processed: true };
  }

  return { processed: false, reason: `Unhandled webhook event "${event}"` };
}

/** Update the cross-tenant order index after a webhook is processed. */
async function markGatewayOrder(societyId: string, providerOrderId: string, event: string): Promise<void> {
  if (!providerOrderId) return;
  try {
    const { databases } = await import('../../db/manager.js');
    const platform = await databases.platform();
    const status = event.includes('refunded') ? 'REFUNDED' : event.includes('failed') ? 'FAILED' : event.includes('captured') || event.includes('paid') ? 'PAID' : 'CREATED';
    await platform
      .collection('gateway_orders')
      .updateOne({ societyId, providerOrderId }, { $set: { status, lastEvent: event, webhookReceivedAt: new Date() } });
  } catch (err) {
    logger.warn({ societyId, providerOrderId, err }, 'payment: gateway order index update skipped');
  }
}

/**
 * Entry point for a token-less provider webhook.
 *
 * Resolves which society owns the order from the platform index using ONLY the provider's own
 * order/payment id, opens that society's database, and delegates to `handleWebhook`. The caller
 * never supplies a society id, so a webhook cannot be aimed at the wrong tenant.
 */
export async function processGatewayWebhook(opts: {
  provider: gateway.GatewayProvider;
  rawBody: string | Buffer;
  signature: string;
  payload: Document;
}): Promise<{ processed: boolean; societyId?: string; reason?: string }> {
  // Verify the signature BEFORE any lookup so an unauthenticated forger cannot probe order ids.
  if (!gateway.verifyWebhookSignature(opts.rawBody, opts.signature, opts.provider)) {
    logger.warn({ provider: opts.provider }, 'payment: webhook signature rejected');
    throw new ApiError('Webhook signature verification failed', 'PAYMENT_FAILED');
  }

  const entity = (opts.payload.payload?.payment?.entity ?? opts.payload.payment ?? {}) as Document;
  const providerOrderId = String(entity.order_id ?? opts.payload.orderId ?? '');
  const providerPaymentId = String(entity.id ?? '');
  if (!providerOrderId && !providerPaymentId) return { processed: false, reason: 'Webhook carried no order or payment id' };

  const { databases } = await import('../../db/manager.js');
  const platform = await databases.platform();
  const order = await platform.collection('gateway_orders').findOne(
    providerOrderId ? { providerOrderId } : { paymentId: providerPaymentId },
  );
  if (!order) return { processed: false, reason: 'Order is not recognised by this platform' };

  const societyId = String(order.societyId);
  const db = await databases.tenantDb(societyId);
  const ctx: PaymentsContext = { db, societyId, actorId: 'webhook', actorName: 'Payment Gateway' };

  const result = await handleWebhook(ctx, opts.payload, { provider: opts.provider, rawBody: opts.rawBody, signature: opts.signature });
  return { ...result, societyId };
}

/* --------------------------------- receipts --------------------------------- */

/** Generate (or regenerate) the receipt PDF for a settled payment (§59). */
/**
 * Build the receipt PDF buffer for a settled payment.
 * Pure render — no storage write — so the download endpoint can stream it on demand.
 */
export async function renderReceiptPdf(ctx: PaymentsContext, paymentId: string): Promise<{ buffer: Buffer; filename: string; receiptNumber: string }> {
  const payment = await ctx.db.collection('payments').findOne({ societyId: ctx.societyId, _id: paymentId });
  if (!payment) throw ApiError.notFound('Payment');
  if (!['SUCCESS', 'REFUNDED', 'PARTIALLY_REFUNDED'].includes(String(payment.status))) {
    throw ApiError.conflict('A receipt can only be generated for a successful payment');
  }

  const platform = await (await import('../../db/manager.js')).databases.platform();
  const society = await platform.collection('societies').findById(ctx.societyId);
  const [unit, bill] = await Promise.all([
    payment.unitId ? ctx.db.collection('units').findOne({ societyId: ctx.societyId, _id: payment.unitId }) : null,
    payment.billId ? ctx.db.collection('maintenance_bills').findOne({ societyId: ctx.societyId, _id: payment.billId }) : null,
  ]);
  const building = unit ? await ctx.db.collection('buildings').findOne({ societyId: ctx.societyId, _id: unit.buildingId }) : null;
  const items = bill ? await ctx.db.collection('bill_items').find({ societyId: ctx.societyId, billId: bill._id }, { sort: { order: 1 }, limit: 100 }) : [];

  const receiptNumber = String(payment.receiptNumber ?? payment.referenceNumber);
  const buffer = await generateReceiptPdf({
    receiptNumber,
    society: {
      name: String(society?.name ?? 'Society'),
      address: [society?.address, society?.city, society?.state, society?.pincode].filter(Boolean).join(', '),
      contactEmail: society?.contactEmail ? String(society.contactEmail) : null,
      contactPhone: society?.contactPhone ? String(society.contactPhone) : null,
      gstin: null,
      logoUrl: society?.logoUrl ? String(society.logoUrl) : null,
    },
    receivedFrom: unit ? String(unit.label ?? unit.unitNumber) : '—',
    unit: unit ? { label: String(unit.label ?? unit.unitNumber), building: building ? String(building.name) : null } : null,
    paidBy: String(payment.userId ?? ''),
    amount: Number(payment.paidAmount ?? payment.amount),
    currency: String(payment.currency ?? 'INR'),
    mode: String(payment.mode ?? 'ONLINE'),
    paidAt: payment.paidAt ? new Date(payment.paidAt as string | Date) : new Date(),
    purpose: String(payment.purpose),
    referenceNumber: String(payment.referenceNumber),
    providerPaymentId: payment.providerPaymentId ? String(payment.providerPaymentId) : null,
    invoice: bill
      ? {
          invoiceNumber: String(bill.invoiceNumber),
          period: String(bill.period),
          totalAmount: Number(bill.totalAmount),
          paidAmount: Number(bill.paidAmount),
          dueAmount: Number(bill.dueAmount),
          dueDate: bill.dueDate ? new Date(bill.dueDate as string | Date) : null,
          items: items.map((i) => ({ label: String(i.label), type: String(i.type), amount: Number(i.amount) })),
        }
      : null,
    amountInWords: amountInWords(Number(payment.paidAmount ?? payment.amount)),
  });

  return { buffer, filename: `${receiptNumber}.pdf`, receiptNumber };
}

/** Render the receipt, persist it to storage and stamp the payment record (§59). */
export async function generateReceipt(ctx: PaymentsContext, paymentId: string): Promise<Document> {
  const { buffer, filename, receiptNumber } = await renderReceiptPdf(ctx, paymentId);

  const { storage } = await import('../../services/storage.js');
  const stored = await storage.put({
    societyId: ctx.societyId,
    category: 'receipts',
    filename,
    mimeType: 'application/pdf',
    buffer,
    isPublic: false,
  });

  await ctx.db.collection('payments').updateOne(
    { societyId: ctx.societyId, _id: paymentId },
    { $set: { receiptUrl: stored.url, receiptGeneratedAt: new Date(), receiptNumber } },
  );

  return {
    receiptNumber,
    url: stored.url,
    storageKey: stored.key,
    sizeBytes: stored.sizeBytes,
    checksum: stored.checksum,
    generatedAt: new Date(),
  };
}

/** Indian-style number to words for the receipt ("Twelve Thousand Three Hundred Rupees Only"). */
export function amountInWords(amount: number): string {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

  const two = (n: number): string => (n < 20 ? ones[n] : `${tens[Math.floor(n / 10)]}${n % 10 ? ` ${ones[n % 10]}` : ''}`);
  const three = (n: number): string => (n >= 100 ? `${ones[Math.floor(n / 100)]} Hundred${n % 100 ? ` ${two(n % 100)}` : ''}` : two(n));

  const whole = Math.floor(Math.abs(amount));
  const paise = Math.round((Math.abs(amount) - whole) * 100);

  let words = '';
  const crore = Math.floor(whole / 10_000_000);
  const lakh = Math.floor((whole % 10_000_000) / 100_000);
  const thousand = Math.floor((whole % 100_000) / 1_000);
  const rest = whole % 1_000;
  if (crore) words += `${two(crore)} Crore `;
  if (lakh) words += `${two(lakh)} Lakh `;
  if (thousand) words += `${two(thousand)} Thousand `;
  if (rest) words += `${three(rest)} `;
  words = words.trim() || 'Zero';

  let out = `${words} Rupees`;
  if (paise > 0) out += ` and ${two(paise)} Paise`;
  return `${out} Only`;
}

/* --------------------------------- reporting -------------------------------- */

/** Collections summary for the admin dashboard and reports (§43). */
export async function collectionsSummary(ctx: PaymentsContext, from: Date, to: Date): Promise<Document> {
  const payments = await ctx.db.collection('payments').find(
    { societyId: ctx.societyId, status: 'SUCCESS', paidAt: { $gte: from, $lte: to } },
    { limit: 100_000 },
  );

  const byMode: Record<string, { count: number; amount: number }> = {};
  const byPurpose: Record<string, { count: number; amount: number }> = {};
  const byDay: Record<string, number> = {};
  let total = 0;

  for (const p of payments) {
    const amount = Number(p.paidAmount ?? p.amount ?? 0);
    total = round2(total + amount);
    const mode = String(p.mode ?? 'OTHER');
    byMode[mode] = { count: (byMode[mode]?.count ?? 0) + 1, amount: round2((byMode[mode]?.amount ?? 0) + amount) };
    const purpose = String(p.purpose ?? 'OTHER');
    byPurpose[purpose] = { count: (byPurpose[purpose]?.count ?? 0) + 1, amount: round2((byPurpose[purpose]?.amount ?? 0) + amount) };
    const day = new Date(p.paidAt as string | Date).toISOString().slice(0, 10);
    byDay[day] = round2((byDay[day] ?? 0) + amount);
  }

  const failed = await ctx.db.collection('payments').countDocuments({ societyId: ctx.societyId, status: 'FAILED', createdAt: { $gte: from, $lte: to } });
  const refunded = await ctx.db.collection('payments').aggregate<{ _id: null; amount: number }>([
    { $match: { societyId: ctx.societyId, status: { $in: ['REFUNDED', 'PARTIALLY_REFUNDED'] }, refundedAt: { $gte: from, $lte: to } } },
    { $group: { _id: null, amount: { $sum: '$refundedAmount' } } },
  ]);

  return {
    from,
    to,
    transactions: payments.length,
    collected: total,
    failed,
    refunded: round2(Number(refunded[0]?.amount ?? 0)),
    byMode,
    byPurpose,
    byDay,
    billing: await billing.billingSummary({ db: ctx.db, societyId: ctx.societyId, actorId: ctx.actorId }),
  };
}
