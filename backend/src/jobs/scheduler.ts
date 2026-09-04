/**
 * Scheduled maintenance (§61, §44).
 *
 * Every society needs the same handful of time-driven chores — QR passes expiring, unpaid
 * amenity holds being released, SLA breaches escalating, late fees accruing, payment reminders
 * going out. None of that happens because a user clicked something, so it has to run on a clock.
 *
 * Two properties matter more than the cron expressions themselves:
 *
 * 1. **Timezone correctness.** "Apply late fees at 2am" must mean 2am *where the society is*, not
 *    2am UTC — charging a Pune society a late fee at 7:30am local would be wrong and visible. So
 *    the daily jobs are driven by a frequent tick that compares the society's *own* local date
 *    against the date it last ran for, rather than by a cron expression in server time.
 *
 * 2. **Exactly-once across replicas.** Production runs several API containers, all of which tick
 *    at the same moment. Each day's run is therefore claimed with an atomic upsert keyed on
 *    `(societyId, job, dateKey)` carrying a unique claim token; only the process whose token
 *    survives `$setOnInsert` does the work. Without this, N replicas would apply late fees N times.
 *
 * A failure in one society is logged and skipped — it must never abort the sweep for the others,
 * and must never take the API process down.
 */
import { randomUUID } from 'node:crypto';
import { schedule, shutdown } from 'node-cron';
import type { ScheduledTask } from 'node-cron';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { databases } from '../db/manager.js';
import type { TenantDatabase } from '../db/drivers/types.js';
import { applyLateFees, sendBillReminders } from '../modules/finance/billingService.js';
import { expireUnpaidBookings, reconcilePastBookings } from '../modules/amenities/amenityService.js';
import { sweepSla } from '../modules/helpdesk/helpdeskService.js';
import { expireStalePasses } from '../services/qr.js';

/** Actor recorded in audit trails for changes no human initiated. */
const SYSTEM_ACTOR = 'sys:scheduler';
const SYSTEM_ACTOR_NAME = 'Scheduled Maintenance';

/** Daily jobs wait until the society's local clock passes this hour before claiming the day. */
const DAILY_RUN_AFTER_HOUR = 2;

/** Minutes an unpaid amenity hold survives before the slot is released back to inventory. */
const UNPAID_HOLD_MINUTES = 30;

export type SchedulerTaskName = 'sweep' | 'hourly' | 'daily';

interface SocietyRow {
  id: string;
  slug: string;
  timezone: string;
}

const tasks = new Map<SchedulerTaskName, ScheduledTask>();
const lastRunAt: Record<string, string | null> = { sweep: null, hourly: null, daily: null };

/* -------------------------------------------------------------------------- */
/* timezone helpers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The society's local calendar day as `YYYY-MM-DD`.
 *
 * Uses `Intl` with the `en-CA` locale purely because that locale formats as ISO order — it is a
 * formatting trick, not a language choice. Falls back to UTC if the stored timezone is invalid,
 * since a bad config value must not stop maintenance from running at all.
 */
export function localDateKey(timezone: string, now = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** The society's local hour of day, 0–23. */
export function localHour(timezone: string, now = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const hour = parts.find((p) => p.type === 'hour')?.value;
    // `en-GB` with hour12:false can yield "24" at midnight in some ICU versions.
    return hour === undefined ? now.getUTCHours() : Number(hour) % 24;
  } catch {
    return now.getUTCHours();
  }
}

/* -------------------------------------------------------------------------- */
/* day claiming                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Try to claim "this job, this society, this local day".
 *
 * Returns true only for the single caller that actually created the claim row. The claim token is
 * written with `$setOnInsert`, so a concurrent racer's upsert lands on the existing row and leaves
 * the original token untouched — comparing tokens is then an unambiguous win/lose test.
 */
async function claimDailyRun(
  db: TenantDatabase,
  societyId: string,
  job: string,
  dateKey: string,
  timezone: string,
): Promise<boolean> {
  const claimId = randomUUID();
  const collection = db.collection('scheduler_runs');

  const doc = await collection.findOneAndUpdate(
    { societyId, job, dateKey },
    {
      $setOnInsert: {
        societyId,
        job,
        dateKey,
        timezone,
        claimId,
        status: 'RUNNING',
        startedAt: new Date(),
      },
    },
    { upsert: true, returnDocument: 'after' },
  );

  return Boolean(doc) && String((doc as Record<string, unknown>).claimId ?? '') === claimId;
}

/** Record how the claimed run finished, so a stuck `RUNNING` row is diagnosable. */
async function finishDailyRun(
  db: TenantDatabase,
  societyId: string,
  job: string,
  dateKey: string,
  outcome: { status: 'COMPLETED' | 'FAILED'; result?: unknown; error?: string },
): Promise<void> {
  await db
    .collection('scheduler_runs')
    .updateOne(
      { societyId, job, dateKey },
      { $set: { status: outcome.status, finishedAt: new Date(), result: outcome.result ?? null, lastError: outcome.error ?? null } },
    )
    .catch((err) => logger.warn({ err, societyId, job }, 'scheduler: could not record run outcome'));
}

/* -------------------------------------------------------------------------- */
/* society iteration                                                          */
/* -------------------------------------------------------------------------- */

/** Active societies from the platform database — the authoritative tenant list. */
async function activeSocieties(): Promise<SocietyRow[]> {
  const platform = await databases.platform();
  const rows = await platform
    .collection('societies')
    .find({ status: 'ACTIVE' }, { limit: 5_000 });
  return rows.map((r) => ({
    id: String(r._id),
    slug: String(r.slug ?? ''),
    timezone: String(r.timezone ?? env.DEFAULT_TIMEZONE),
  }));
}

/** Run `fn` for every active society, isolating failures per tenant. */
async function forEachSociety(
  label: string,
  fn: (db: TenantDatabase, society: SocietyRow) => Promise<void>,
): Promise<void> {
  let societies: SocietyRow[];
  try {
    societies = await activeSocieties();
  } catch (err) {
    logger.error({ err, label }, 'scheduler: could not list societies — skipping this tick');
    return;
  }

  for (const society of societies) {
    try {
      const db = await databases.tenantDb(society.id);
      await fn(db, society);
    } catch (err) {
      // One broken tenant must not stop the rest, and must not crash the API process.
      logger.error({ err, label, societyId: society.id, slug: society.slug }, 'scheduler: task failed for society');
    }
  }
}

/* -------------------------------------------------------------------------- */
/* tasks                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Fast sweep (every 5 minutes): things that are simply *stale*.
 *
 * Expiring a pass or releasing an unpaid hold is interval-based, not calendar-based, so it needs
 * no timezone handling and no once-per-day claim — it is safe to run as often as we like.
 */
export async function runSweep(): Promise<void> {
  const started = Date.now();
  let passesExpired = 0;
  let holdsReleased = 0;

  await forEachSociety('sweep', async (db, society) => {
    passesExpired += await expireStalePasses(db, society.id);
    holdsReleased += await expireUnpaidBookings(
      { db, societyId: society.id, actorId: SYSTEM_ACTOR, actorName: SYSTEM_ACTOR_NAME },
      UNPAID_HOLD_MINUTES,
    );
  });

  lastRunAt.sweep = new Date().toISOString();
  logger.debug({ passesExpired, holdsReleased, tookMs: Date.now() - started }, 'scheduler: sweep complete');
}

/**
 * Hourly sweep: state transitions that need to happen reasonably promptly but not instantly.
 *
 * SLA breaches escalate complaints nobody has touched; past bookings are reconciled so a slot the
 * resident never used stops showing as "upcoming" and inventory reports stay honest.
 */
export async function runHourly(): Promise<void> {
  const started = Date.now();
  let breached = 0;
  let escalated = 0;
  let completed = 0;
  let noShow = 0;

  await forEachSociety('hourly', async (db, society) => {
    const sla = await sweepSla({ db, societyId: society.id, actorId: SYSTEM_ACTOR, actorName: SYSTEM_ACTOR_NAME });
    breached += sla.breached;
    escalated += sla.escalated;

    const bookings = await reconcilePastBookings({
      db,
      societyId: society.id,
      actorId: SYSTEM_ACTOR,
      actorName: SYSTEM_ACTOR_NAME,
    });
    completed += bookings.completed;
    noShow += bookings.noShow;
  });

  lastRunAt.hourly = new Date().toISOString();
  logger.info({ breached, escalated, completed, noShow, tookMs: Date.now() - started }, 'scheduler: hourly sweep complete');
}

/**
 * Daily sweep: money-affecting work, claimed once per society-local day.
 *
 * Late fees are applied and reminders sent only after the society's own 2am, and only by whichever
 * replica wins the claim. Both underlying functions are themselves idempotent for a given period,
 * so the claim is defence in depth rather than the only thing standing between us and double
 * charges.
 */
export async function runDaily(now = new Date()): Promise<void> {
  const started = Date.now();
  let societiesProcessed = 0;
  let feesApplied = 0;
  let totalFees = 0;
  let reminders = 0;

  await forEachSociety('daily', async (db, society) => {
    // Wait until the society's local clock has passed the configured hour.
    if (localHour(society.timezone, now) < DAILY_RUN_AFTER_HOUR) return;

    const dateKey = localDateKey(society.timezone, now);
    const won = await claimDailyRun(db, society.id, 'daily-maintenance', dateKey, society.timezone);
    if (!won) return; // Another replica already ran today's maintenance for this society.

    const ctx = { db, societyId: society.id, actorId: SYSTEM_ACTOR, actorName: SYSTEM_ACTOR_NAME };
    try {
      const late = await applyLateFees(ctx);
      const reminded = await sendBillReminders(ctx);

      feesApplied += late.updated;
      totalFees += late.totalFees;
      reminders += reminded.reminded;
      societiesProcessed += 1;

      await finishDailyRun(db, society.id, 'daily-maintenance', dateKey, {
        status: 'COMPLETED',
        result: { lateFeeCount: late.updated, lateFeeTotal: late.totalFees, reminders: reminded.reminded },
      });
    } catch (err) {
      // Marking the day FAILED (rather than leaving it RUNNING) lets an operator retry deliberately.
      await finishDailyRun(db, society.id, 'daily-maintenance', dateKey, {
        status: 'FAILED',
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  });

  lastRunAt.daily = new Date().toISOString();
  logger.info(
    { societiesProcessed, feesApplied, totalFees, reminders, tookMs: Date.now() - started },
    'scheduler: daily maintenance complete',
  );
}

/* -------------------------------------------------------------------------- */
/* lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

const SCHEDULES: Record<SchedulerTaskName, { expression: string; run: () => Promise<void> }> = {
  sweep: { expression: '*/5 * * * *', run: runSweep },
  hourly: { expression: '17 * * * *', run: runHourly },
  // Frequent tick; the per-society local-date claim is what makes it "once a day".
  daily: { expression: '*/10 * * * *', run: () => runDaily() },
};

export function startScheduler(): void {
  if (!env.SCHEDULER_ENABLED) {
    logger.info('scheduler disabled (SCHEDULER_ENABLED=false)');
    return;
  }

  for (const [name, task] of Object.entries(SCHEDULES) as Array<[SchedulerTaskName, (typeof SCHEDULES)[SchedulerTaskName]]>) {
    if (tasks.has(name)) continue;
    const scheduled = schedule(
      task.expression,
      async () => {
        try {
          await task.run();
        } catch (err) {
          // A rejected cron callback would otherwise become an unhandled rejection.
          logger.error({ err, task: name }, 'scheduler: unhandled failure in scheduled task');
        }
      },
      {
        name: `colonize:${name}`,
        timezone: env.DEFAULT_TIMEZONE,
        // Never stack two runs of the same task if one is still going.
        noOverlap: true,
      },
    );
    tasks.set(name, scheduled);
    logger.info({ task: name, cron: task.expression }, 'scheduler: task registered');
  }

  logger.info({ tasks: tasks.size }, 'scheduler started');
}

export async function stopScheduler(): Promise<void> {
  for (const [name, task] of tasks) {
    try {
      await task.stop();
    } catch (err) {
      logger.warn({ err, task: name }, 'scheduler: failed to stop task');
    }
  }
  tasks.clear();
  try {
    await shutdown(5_000);
  } catch (err) {
    logger.warn({ err }, 'scheduler: shutdown timed out');
  }
  logger.info('scheduler stopped');
}

/** Run a task immediately. Used by the seed CLI and by admin "run now" controls. */
export async function runSchedulerTask(name: SchedulerTaskName): Promise<void> {
  const task = SCHEDULES[name];
  if (!task) throw new Error(`Unknown scheduler task: ${name}`);
  await task.run();
}

export function schedulerStatus(): {
  enabled: boolean;
  running: SchedulerTaskName[];
  lastRunAt: Record<string, string | null>;
} {
  return {
    enabled: env.SCHEDULER_ENABLED,
    running: Array.from(tasks.keys()),
    lastRunAt: { ...lastRunAt },
  };
}
