/**
 * Process entrypoint.
 *
 * Startup order is deliberate:
 *   1. platform database reachable  — fail fast rather than serve 500s for every request
 *   2. realtime attached to the HTTP server — it must share the listener to upgrade the socket
 *   3. job handlers registered *before* the queue starts polling, or the first tick drops them
 *   4. scheduler started last, so a slow first cron run can't race an unready API
 *
 * Shutdown reverses it: stop accepting work, drain what is in flight, then release connections.
 */
import http from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { databases } from './db/manager.js';
import { initRealtime, closeRealtime, realtimeEnabled } from './realtime/gateway.js';
import { startQueue, stopQueue, drainQueue, queueStats } from './jobs/queue.js';
import { startScheduler, stopScheduler, schedulerStatus } from './jobs/scheduler.js';
import { registerNotificationJobs } from './services/notifications/index.js';
import { runSeedIfEmpty } from './db/seed/runSeed.js';
import { ensureSubscriptionPlans } from './db/seedPlatform.js';

const startedAt = Date.now();

async function bootstrap(): Promise<void> {
  // 1. Prove the platform database is usable before we accept a single request.
  const platform = await databases.platform();
  const societyCount = await platform.collection('societies').countDocuments({});
  logger.info(
    { driver: env.DB_DRIVER, societies: societyCount },
    'platform database connected',
  );

  // 1b. Plan catalogue. Unlike a society database the platform one has no provisioning hook, and
  //     `subscriptions.planId` is a required reference — without these rows no subscription can be
  //     written at all. Idempotent, and deliberately not part of the seed: an existing deployment
  //     must get the catalogue on boot too.
  const plans = await ensureSubscriptionPlans(platform);
  logger.info({ plans: plans.total, created: plans.created }, 'subscription plan catalogue ready');

  // 2. HTTP server first — Socket.IO needs the listener to attach its upgrade handler to.
  const app = createApp();
  const server = http.createServer(app);

  if (env.REALTIME_ENABLED) {
    initRealtime(server);
    logger.info({ enabled: realtimeEnabled() }, 'realtime gateway attached');
  }

  // 3. Handlers before polling: a job dequeued with no registered handler is dropped.
  //    Awaited, because handler registration itself loads the queue module asynchronously.
  await registerNotificationJobs();
  logger.info({ handlers: queueStats().handlers }, 'notification job handlers registered');

  if (env.JOBS_ENABLED) {
    startQueue();
    logger.info({ handlers: queueStats().handlers }, 'job queue started');
  }

  // 4. Optional demo data. Idempotent — it no-ops once a society exists.
  if (env.SEED_ON_START) {
    try {
      const result = await runSeedIfEmpty();
      if (result.seeded) logger.info(result, 'seed data installed');
      else logger.info(result, 'seed skipped — platform already populated');
    } catch (err) {
      // Seeding is a convenience, not a dependency: boot anyway so the API stays usable.
      logger.error({ err }, 'seed failed — continuing without demo data');
    }
  }

  startScheduler();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(env.PORT, env.HOST, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : env.PORT;
  logger.info(
    {
      port: boundPort,
      host: env.HOST,
      env: env.NODE_ENV,
      docs: env.SWAGGER_ENABLED ? `${env.SWAGGER_PATH}/` : 'disabled',
      startedInMs: Date.now() - startedAt,
    },
    `colonize api listening on http://${env.HOST}:${boundPort}`,
  );

  installShutdownHandlers(server);
}

/**
 * Graceful shutdown (§66).
 *
 * Ordering matters: stop the clocks first so no new work is created, stop accepting connections,
 * let in-flight requests finish, drain queued jobs, then close sockets and databases. Reversed, a
 * cron tick could fire against an already-closed database and log spurious failures.
 */
function installShutdownHandlers(server: http.Server): void {
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutdown initiated');

    // Hard deadline: never hang forever on a stuck connection or a wedged driver.
    const forceExit = setTimeout(() => {
      logger.error('shutdown exceeded 15s — forcing exit');
      process.exit(1);
    }, 15_000);
    forceExit.unref();

    try {
      await stopScheduler();

      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Node 18+: stop idle keep-alive sockets so `close` can actually complete.
        server.closeIdleConnections?.();
        setTimeout(() => {
          server.closeAllConnections?.();
          resolve();
        }, 5_000).unref();
      });

      if (env.JOBS_ENABLED) {
        await drainQueue(10_000).catch((err) => logger.warn({ err }, 'queue drain failed'));
        await stopQueue();
      }

      if (env.REALTIME_ENABLED) await closeRealtime();

      // Flushes the embedded driver's data to disk; a no-op round-trip for real MongoDB.
      await databases.flush().catch((err) => logger.warn({ err }, 'db flush failed'));
      await databases.closeAll();

      logger.info({ uptimeSec: Math.round((Date.now() - startedAt) / 1000) }, 'shutdown complete');
      clearTimeout(forceExit);
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'shutdown failed');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // A rejected promise outside a request handler has no Express error middleware to catch it.
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled promise rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception — shutting down');
    void shutdown('uncaughtException');
  });
}

/** Exposed for tests and for `/api/health/ready`. */
export function uptimeSeconds(): number {
  return Math.round((Date.now() - startedAt) / 1000);
}

export { schedulerStatus };

bootstrap().catch((err) => {
  logger.fatal({ err }, 'failed to start — exiting');
  process.exit(1);
});
