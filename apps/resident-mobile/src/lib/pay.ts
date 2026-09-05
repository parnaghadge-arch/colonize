/**
 * The API's two-step payment contract (§29 / §59):
 *   1. POST /payments/intent — the client says WHAT it pays for; the server computes HOW MUCH.
 *   2. POST /payments/verify — with the gateway order/payment ids and signature.
 *
 * With the mock gateway (PAYMENT_GATEWAY=mock, the development default) the order carries
 * `mockPaymentId` + `mockSignature`, so this completes the real signature dance end to end.
 * With a real gateway configured, the intent is returned unverified so the caller can
 * present its own payment sheet and refresh afterwards.
 */

import { api } from './api.ts';
import type { PaymentOrder, VerifyResult } from './types.ts';

export function clientRequestId(): string {
  return `app-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface PayResult {
  /** True when the capture completed here (mock gateway) — the booking/bill is updated. */
  verified: boolean;
  order: PaymentOrder;
  result?: VerifyResult;
}

export async function payNow(input: {
  purpose: 'MAINTENANCE' | 'AMENITY_BOOKING';
  billId?: string;
  bookingId?: string;
}): Promise<PayResult> {
  const intent = await api.post<{ payment: { _id: string }; order: PaymentOrder; duplicate?: boolean }>('/payments/intent', {
    purpose: input.purpose,
    ...(input.billId ? { billId: input.billId } : {}),
    ...(input.bookingId ? { bookingId: input.bookingId } : {}),
    clientRequestId: clientRequestId(),
  });
  const { order } = intent;
  if (!order?.mockPaymentId) return { verified: false, order };
  const result = await api.post<VerifyResult>('/payments/verify', {
    paymentId: intent.payment._id,
    gatewayOrderId: order.orderId,
    gatewayPaymentId: order.mockPaymentId,
    signature: order.mockSignature ?? '',
  });
  return { verified: true, order, result };
}
