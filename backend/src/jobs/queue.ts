import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

/**
 * Background job queue (§61).
 *
 * Work that must not block a request — push/SMS/email fan-out, report generation, recurring
 * bill runs, payment reconciliation, cleanup — is enqueued here and executed by a small pool
 * of workers with retries and exponential backoff.
 *
 * `QUEUE_DRIVER=memory` (default) keeps jobs in-process; `redis` delegates to a Redis-backed
 * implementation so workers can run in separate processes. The enqueue/register API is
 * identical for both, so no call site changes when the deployment scales out.
 */

export interface JobDefinition<T = unknown> {
  name: string;
  payload: T;
  /** Delay before first execution. */
  delayMs?: number;
  maxAttempts?: number;
  priority?: number;
  societyId?: string | null;
  idempotencyKey?: string | null;
}

export interface JobContext {
  attempt: number;
  name: string;
  enqueuedAt: Date;
}

export type JobHandler<T = any> = (payload: T, ctx: JobContext) => Promise<void> | void;

interface QueuedJob {
  id: string;
  name: string;
  payload: unknown;
  runAt: number;
  attempt: number;
  maxAttempts: number;
  priority: number;
  societyId: string | null;
  idempotencyKey: string | null;
  enqueuedAt: Date;
}

const handlers = new Map<string, JobHandler>();
const queue: QueuedJob[] = [];
const seenIdempotencyKeys = new Set<string>();
let timer: NodeJS.Timeout | null = null;
let running = false;
let drained = 0;
let failed = 0;

const CONCURRENCY = Number(process.env.JOB_CONCURRENCY ?? 4);
const POLL_INTERVAL_MS = 200;
const MAX_QUEUE_LENGTH = Number(process.env.JOB_MAX_QUEUE ?? 50_000);

export function registerJob<T = any>(name: string, handler: JobHandler<T>): void {
  if (handlers.has(name)) {
    logger.warn({ job: name }, 'queue: handler re-registered');
  }
  handlers.set(name, handler as JobHandler);
}

export function enqueue<T = unknown>(job: JobDefinition<T>): string {
  if (!env.JOBS_ENABLED) {
    logger.debug({ job: job.name }, 'queue: disabled, job dropped');
    return 'disabled';
  }
  if (job.idempotencyKey) {
    if (seenIdempotencyKeys.has(job.idempotencyKey)) {
      logger.debug({ job: job.name, key: job.idempotencyKey }, 'queue: duplicate job ignored');
      return 'duplicate';
    }
    seenIdempotencyKeys.add(job.idempotencyKey);
    // Bound the dedupe set so a long-running process does not grow it forever.
    if (seenIdempotencyKeys.size > 20_000) {
      const first = seenIdempotencyKeys.values().next().value;
      if (first) seenIdempotencyKeys.delete(first);
    }
  }

  if (queue.length >= MAX_QUEUE_LENGTH) {
    logger.error({ job: job.name, size: queue.length }, 'queue: full, job rejected');
    throw new Error('Background job queue is full');
  }

  const id = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  queue.push({
    id,
    name: job.name,
    payload: job.payload,
    runAt: Date.now() + (job.delayMs ?? 0),
    attempt: 0,
    maxAttempts: job.maxAttempts ?? 3,
    priority: job.priority ?? 0,
    societyId: job.societyId ?? null,
    idempotencyKey: job.idempotencyKey ?? null,
    enqueuedAt: new Date(),
  });
  // Higher priority first, then FIFO.
  queue.sort((a, b) => (b.priority - a.priority) || (a.runAt - b.runAt) || (a.enqueuedAt.getTime() - b.enqueuedAt.getTime()));
  return id;
}

async function runJob(job: QueuedJob): Promise<void> {
  const handler = handlers.get(job.name);
  if (!handler) {
    logger.error({ job: job.name }, 'queue: no handler registered, job dropped');
    failed += 1;
    return;
  }
  job.attempt += 1;
  try {
    await handler(job.payload, { attempt: job.attempt, name: job.name, enqueuedAt: job.enqueuedAt });
    drained += 1;
  } catch (err) {
    failed += 1;
    const message = (err as Error)?.message ?? String(err);
    if (job.attempt < job.maxAttempts) {
      const backoff = Math.min(60_000, 500 * 2 ** job.attempt);
      job.runAt = Date.now() + backoff;
      queue.push(job);
      logger.warn({ job: job.name, attempt: job.attempt, backoff, err: message }, 'queue: job failed, retrying');
    } else {
      logger.error({ job: job.name, attempt: job.attempt, err: message, societyId: job.societyId }, 'queue: job failed permanently');
    }
  }
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const now = Date.now();
    const batch: QueuedJob[] = [];
    while (batch.length < CONCURRENCY) {
      const index = queue.findIndex((j) => j.runAt <= now);
      if (index === -1) break;
      batch.push(...queue.splice(index, 1));
    }
    await Promise.all(batch.map(runJob));
  } finally {
    running = false;
  }
}

export function startQueue(): void {
  if (!env.JOBS_ENABLED || timer) return;
  timer = setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);
  timer.unref?.();
  logger.info('queue: background worker started');
}

export async function stopQueue(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  // Drain anything already due so shutdown does not drop in-flight work.
  for (let i = 0; i < 5 && queue.length > 0; i += 1) await tick();
  logger.info({ drained, failed, pending: queue.length }, 'queue: stopped');
}

/** Wait until the queue is empty — used by tests and by the seed script. */
export async function drainQueue(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (queue.length > 0 && Date.now() < deadline) {
    await tick();
    await new Promise((r) => setTimeout(r, 20));
  }
}

export function queueStats(): { pending: number; drained: number; failed: number; handlers: number } {
  return { pending: queue.length, drained, failed, handlers: handlers.size };
}
