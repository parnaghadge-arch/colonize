import { sha256 } from './crypto.js';
import { ApiError } from '../utils/errors.js';
import { env } from '../config/env.js';
import type { TenantDatabase } from '../db/drivers/types.js';

/**
 * Idempotency (§50 offline sync "never duplicate records", §77 payment retries).
 *
 * A client supplies a key (`X-Idempotency-Key` header or `clientRequestId` in the body).
 * The first execution stores the response; a replay returns the *same* response without
 * re-running the operation. A key that is still in flight returns 409 so the client retries
 * later rather than racing itself.
 *
 * Records expire via a TTL index, so the collection cannot grow unbounded.
 */

export interface IdempotencyOutcome<T> {
  replayed: boolean;
  status: number;
  body: T;
}

export interface RunIdempotentOptions {
  db: TenantDatabase;
  /** Tenant id for platform-scoped keys. */
  societyId: string;
  key: string;
  userId?: string | null;
  method?: string;
  path?: string;
  requestPayload?: unknown;
  ttlSeconds?: number;
}

const PROCESSING_TIMEOUT_MS = 30_000;

export async function runIdempotent<T>(
  opts: RunIdempotentOptions,
  executor: () => Promise<{ status: number; body: T }>,
): Promise<IdempotencyOutcome<T>> {
  const { db, societyId, key, ttlSeconds = env.IDEMPOTENCY_TTL_SECONDS } = opts;
  const collection = db.collection('idempotency_keys');
  const requestHash = sha256(stableStringify(opts.requestPayload ?? {}));

  const existing = await collection.findOne({ societyId, key });
  if (existing) {
    if (existing.status === 'COMPLETED' && existing.responseBody !== undefined) {
      // A different payload under the same key is a client bug — refuse to guess.
      if (existing.requestHash && existing.requestHash !== requestHash) {
        throw ApiError.conflict(
          'This idempotency key was already used with a different payload. Generate a new key.',
          'IDEMPOTENCY_CONFLICT',
        );
      }
      return { replayed: true, status: Number(existing.responseStatus ?? 200), body: existing.responseBody as T };
    }
    if (existing.status === 'PROCESSING') {
      const startedAt = existing.createdAt ? new Date(existing.createdAt).getTime() : 0;
      if (Date.now() - startedAt < PROCESSING_TIMEOUT_MS) {
        throw ApiError.conflict(
          'An identical request is still being processed. Please retry in a few seconds.',
          'IDEMPOTENCY_CONFLICT',
        );
      }
      // A crashed worker left the key stuck; reclaim it.
      await collection.updateOne(
        { societyId, key },
        { $set: { status: 'PROCESSING', requestHash, expiresAt: new Date(Date.now() + ttlSeconds * 1000) } },
      );
    }
    if (existing.status === 'FAILED') {
      await collection.updateOne(
        { societyId, key },
        { $set: { status: 'PROCESSING', requestHash, expiresAt: new Date(Date.now() + ttlSeconds * 1000) } },
      );
    }
  } else {
    try {
      await collection.create({
        societyId,
        key,
        userId: opts.userId ?? null,
        method: opts.method ?? null,
        path: opts.path ?? null,
        requestHash,
        status: 'PROCESSING',
        expiresAt: new Date(Date.now() + ttlSeconds * 1000),
      });
    } catch (err) {
      // Lost a race with a concurrent identical request: treat it as in-flight.
      if (/E11000|duplicate/i.test((err as Error).message)) {
        throw ApiError.conflict(
          'An identical request is still being processed. Please retry in a few seconds.',
          'IDEMPOTENCY_CONFLICT',
        );
      }
      throw err;
    }
  }

  try {
    const result = await executor();
    await collection.updateOne(
      { societyId, key },
      {
        $set: {
          status: 'COMPLETED',
          responseStatus: result.status,
          responseBody: result.body,
          expiresAt: new Date(Date.now() + ttlSeconds * 1000),
        },
      },
    );
    return { replayed: false, status: result.status, body: result.body };
  } catch (err) {
    await collection
      .updateOne({ societyId, key }, { $set: { status: 'FAILED' } })
      .catch(() => undefined);
    throw err;
  }
}

/** Deterministic JSON so key comparison does not depend on property order. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/** Extract the idempotency key from a request (header first, then body). */
export function idempotencyKeyFrom(headers: Record<string, unknown>, body: unknown): string | null {
  const header = headers['x-idempotency-key'];
  if (typeof header === 'string' && header.trim().length >= 6) return header.trim().slice(0, 120);
  const fromBody = (body as { clientRequestId?: unknown } | null)?.clientRequestId;
  if (typeof fromBody === 'string' && fromBody.trim().length >= 6) return fromBody.trim().slice(0, 120);
  return null;
}
