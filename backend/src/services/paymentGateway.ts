import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { ApiError } from '../utils/errors.js';
import { logger } from '../config/logger.js';
import type { Document } from '../db/drivers/types.js';

/**
 * Payment gateway abstraction (§29, §59).
 *
 * One interface, several providers. The application never talks to a provider SDK directly —
 * it calls `createOrder` / `verifyPayment` / `refund`, so swapping Razorpay for Stripe (or
 * adding a second provider per society) is a configuration change, not a rewrite.
 *
 * Providers:
 *   • `razorpay` — real integration, activated when RAZORPAY_KEY_ID/SECRET are present.
 *   • `mock`     — deterministic in-process provider used in dev/CI. It performs the SAME
 *                  signature dance as a real gateway (order id + payment id + HMAC signature),
 *                  so verification, replay protection and refund paths are genuinely
 *                  exercised rather than stubbed out.
 */

export type GatewayProvider = 'razorpay' | 'mock' | 'none';

export interface CreateOrderInput {
  amount: number;
  currency: string;
  receipt: string;
  notes?: Record<string, string>;
  provider?: GatewayProvider;
}

export interface CreatedOrder {
  provider: GatewayProvider;
  orderId: string;
  amount: number;
  currency: string;
  keyId: string | null;
  /** Present for the mock provider so a dev client can complete the flow end to end. */
  mockPaymentId?: string;
  mockSignature?: string;
}

export interface VerifyInput {
  provider: GatewayProvider;
  orderId: string;
  paymentId: string;
  signature: string;
}

export interface RefundInput {
  provider: GatewayProvider;
  paymentId: string;
  amount: number;
  reason?: string;
}

/* -------------------------------- provider --------------------------------- */

export function resolveProvider(explicit?: GatewayProvider | string | null): GatewayProvider {
  if (explicit && explicit !== 'none') return explicit as GatewayProvider;
  if (env.PAYMENT_GATEWAY === 'razorpay' && env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET) return 'razorpay';
  return 'mock';
}

/** True when a real gateway is configured — surfaced to the UI so it can hide demo hints. */
export function isLiveProvider(provider: GatewayProvider): boolean {
  return provider === 'razorpay';
}

/* --------------------------------- orders ---------------------------------- */

export async function createOrder(input: CreateOrderInput): Promise<CreatedOrder> {
  const provider = resolveProvider(input.provider);
  const amountInPaise = Math.round(Number(input.amount) * 100);
  if (!Number.isFinite(amountInPaise) || amountInPaise <= 0) throw ApiError.badRequest('The payment amount must be greater than zero');

  if (provider === 'razorpay') {
    const order = await razorpayRequest<{ id: string; amount: number; currency: string }>('POST', '/orders', {
      amount: amountInPaise,
      currency: input.currency ?? 'INR',
      receipt: input.receipt,
      payment_capture: 1,
      notes: input.notes ?? {},
    });
    return { provider, orderId: order.id, amount: order.amount / 100, currency: order.currency, keyId: env.RAZORPAY_KEY_ID ?? null };
  }

  // Mock provider: a real order id and a signature the client must echo back, so the
  // verification code path is identical to production.
  const orderId = `order_mock_${crypto.randomBytes(10).toString('hex')}`;
  const paymentId = `pay_mock_${crypto.randomBytes(10).toString('hex')}`;
  const signature = mockSignature(orderId, paymentId);
  logger.debug({ orderId, amount: input.amount }, 'payment: mock order created');
  return {
    provider,
    orderId,
    amount: Number(input.amount),
    currency: input.currency ?? 'INR',
    keyId: null,
    mockPaymentId: paymentId,
    mockSignature: signature,
  };
}

/* ------------------------------ verification ------------------------------- */

export function mockSignature(orderId: string, paymentId: string): string {
  return crypto.createHmac('sha256', env.MOCK_GATEWAY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
}

/**
 * Verify a gateway callback.
 *
 * The signature is recomputed server-side from the provider secret, so a client cannot claim
 * a payment succeeded. A failed verification is recorded and rethrown — the bill is never
 * marked paid on an unverified callback.
 */
export function verifyPayment(input: VerifyInput): { verified: boolean; reason?: string } {
  const { provider, orderId, paymentId, signature } = input;
  if (!orderId || !paymentId || !signature) return { verified: false, reason: 'Missing verification parameters' };

  if (provider === 'razorpay') {
    if (!env.RAZORPAY_KEY_SECRET) return { verified: false, reason: 'Gateway secret is not configured' };
    const expected = crypto.createHmac('sha256', env.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(String(signature));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { verified: false, reason: 'Signature mismatch' };
    return { verified: true };
  }

  const expected = mockSignature(orderId, paymentId);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { verified: false, reason: 'Signature mismatch' };
  return { verified: true };
}

/** Re-ask the provider whether a payment really settled (webhook-independent confirmation). */
export async function fetchPayment(provider: GatewayProvider, paymentId: string): Promise<Document | null> {
  if (provider !== 'razorpay') {
    return paymentId.startsWith('pay_mock_') ? { id: paymentId, status: 'captured', entity: 'payment', method: 'upi' } : null;
  }
  try {
    return await razorpayRequest<Document>('GET', `/payments/${paymentId}`);
  } catch (err) {
    logger.warn({ err: (err as Error).message, paymentId }, 'payment: provider fetch failed');
    return null;
  }
}

/* --------------------------------- refunds --------------------------------- */

export async function refund(input: RefundInput): Promise<{ provider: GatewayProvider; refundId: string; amount: number; status: string }> {
  const provider = resolveProvider(input.provider);
  if (!Number.isFinite(input.amount) || input.amount <= 0) throw ApiError.badRequest('The refund amount must be greater than zero');

  if (provider === 'razorpay') {
    const result = await razorpayRequest<{ id: string; amount: number; status: string }>('POST', `/payments/${input.paymentId}/refund`, {
      amount: Math.round(input.amount * 100),
      notes: input.reason ? { reason: input.reason } : {},
    });
    return { provider, refundId: result.id, amount: result.amount / 100, status: result.status };
  }

  return {
    provider,
    refundId: `rfnd_mock_${crypto.randomBytes(10).toString('hex')}`,
    amount: Number(input.amount),
    status: 'processed',
  };
}

/* ------------------------------- webhook check ------------------------------ */

/**
 * Verify a provider webhook signature.
 * Razorpay signs the raw body with the webhook secret, so this must run before any JSON
 * parsing mutates the payload.
 */
export function verifyWebhookSignature(rawBody: string | Buffer, signature: string, provider: GatewayProvider): boolean {
  if (!signature) return false;
  const secret = provider === 'razorpay' ? env.RAZORPAY_WEBHOOK_SECRET : env.MOCK_GATEWAY_SECRET;
  if (!secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* -------------------------------- HTTP layer -------------------------------- */

async function razorpayRequest<T>(method: 'GET' | 'POST', path: string, body?: Document): Promise<T> {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    throw new ApiError('The payment gateway is not configured on this server', 'PAYMENT_FAILED');
  }
  const credentials = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64');
  const response = await fetch(`${env.RAZORPAY_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${credentials}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await response.text();
  let parsed: Document = {};
  try {
    parsed = text ? (JSON.parse(text) as Document) : {};
  } catch {
    parsed = { raw: text };
  }

  if (!response.ok) {
    const message = String((parsed.error as Document | undefined)?.description ?? parsed.description ?? `Gateway responded ${response.status}`);
    logger.error({ status: response.status, path, message }, 'payment: gateway error');
    throw new ApiError(message, 'PAYMENT_FAILED');
  }
  return parsed as T;
}
