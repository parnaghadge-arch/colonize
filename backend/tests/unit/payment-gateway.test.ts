import { describe, expect, it } from 'vitest';
import {
  isLiveProvider,
  mockSignature,
  resolveProvider,
  verifyPayment,
  verifyWebhookSignature,
} from '../../src/services/paymentGateway.js';
import { env } from '../../src/config/env.js';

/**
 * Payment verification (§58).
 *
 * The signature is recomputed server-side from the provider secret, so a client can never claim
 * a payment succeeded. A bill is only marked paid when verification passes.
 */
describe('mockSignature', () => {
  it('is a deterministic HMAC over "orderId|paymentId"', () => {
    const sig = mockSignature('order_mock_1', 'pay_mock_1');
    expect(sig).toBe(mockSignature('order_mock_1', 'pay_mock_1'));
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when either id changes', () => {
    const base = mockSignature('order_1', 'pay_1');
    expect(mockSignature('order_2', 'pay_1')).not.toBe(base);
    expect(mockSignature('order_1', 'pay_2')).not.toBe(base);
  });

  it('is order-sensitive (the separator prevents id-swapping)', () => {
    // Without a delimiter, ("ab","c") and ("a","bc") would collide.
    expect(mockSignature('ab', 'c')).not.toBe(mockSignature('a', 'bc'));
  });
});

describe('verifyPayment (mock provider)', () => {
  const orderId = 'order_mock_abc123';
  const paymentId = 'pay_mock_def456';

  it('accepts a correctly signed callback', () => {
    const result = verifyPayment({
      provider: 'mock',
      orderId,
      paymentId,
      signature: mockSignature(orderId, paymentId),
    });
    expect(result.verified).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('rejects a fabricated signature', () => {
    const result = verifyPayment({
      provider: 'mock',
      orderId,
      paymentId,
      signature: 'deadbeef'.repeat(8),
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/signature/i);
  });

  it('rejects a signature computed for a different order', () => {
    const result = verifyPayment({
      provider: 'mock',
      orderId,
      paymentId,
      signature: mockSignature('order_mock_other', paymentId),
    });
    expect(result.verified).toBe(false);
  });

  it('rejects a truncated signature rather than throwing on length mismatch', () => {
    const full = mockSignature(orderId, paymentId);
    const result = verifyPayment({ provider: 'mock', orderId, paymentId, signature: full.slice(0, 32) });
    expect(result.verified).toBe(false);
  });

  it.each([
    ['no order id', { orderId: '', paymentId, signature: 'x' }],
    ['no payment id', { orderId, paymentId: '', signature: 'x' }],
    ['no signature', { orderId, paymentId, signature: '' }],
  ])('rejects a callback with %s', (_label, partial) => {
    const result = verifyPayment({ provider: 'mock', ...partial } as never);
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/missing/i);
  });

  it('accepts uppercase hex only if the provider produced it (signature is compared exactly)', () => {
    const upper = mockSignature(orderId, paymentId).toUpperCase();
    expect(verifyPayment({ provider: 'mock', orderId, paymentId, signature: upper }).verified).toBe(false);
  });
});

describe('verifyPayment (razorpay provider)', () => {
  it('refuses to verify when the gateway secret is not configured', () => {
    // The test environment has no Razorpay credentials, which is the realistic unsafe state:
    // verification must fail closed rather than accept an unsigned callback.
    if (env.RAZORPAY_KEY_SECRET) return;
    const result = verifyPayment({
      provider: 'razorpay',
      orderId: 'order_1',
      paymentId: 'pay_1',
      signature: 'anything',
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/not configured/i);
  });
});

describe('provider resolution', () => {
  it('honours an explicitly requested provider', () => {
    expect(resolveProvider('mock')).toBe('mock');
  });

  it('falls back to mock when nothing usable is configured', () => {
    expect(resolveProvider(null)).toBe('mock');
    expect(resolveProvider(undefined)).toBe('mock');
    expect(resolveProvider('none')).toBe('mock');
  });

  it('never reports the mock gateway as live', () => {
    expect(isLiveProvider('mock')).toBe(false);
  });

  it('reports a real gateway as live so the UI can hide demo hints', () => {
    expect(isLiveProvider('razorpay')).toBe(true);
  });
});

describe('verifyWebhookSignature', () => {
  it('rejects a webhook whose signature does not match the raw body', () => {
    const body = JSON.stringify({ event: 'payment.captured', payload: { id: 'pay_1' } });
    expect(verifyWebhookSignature(body, 'not-the-real-signature', 'razorpay')).toBe(false);
  });

  it('rejects an empty signature', () => {
    expect(verifyWebhookSignature('{}', '', 'razorpay')).toBe(false);
  });
});
