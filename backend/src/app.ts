import express, { type Express, type Request, type Response } from 'express';
import { pinoHttp } from './config/httpLogger.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { beforeBodyMiddleware, afterBodyMiddleware, csrfProtection, rateLimiters } from './middleware/security.js';
import { notFoundHandler, errorHandler } from './middleware/errors.js';
import { apiRouter } from './routes/index.js';
import { paymentWebhookRouter } from './modules/finance/financeRouter.js';
import { mountSwagger } from './docs/swagger.js';

/**
 * Application assembly (§66, §67, §75).
 *
 * Middleware order is load-bearing here, not cosmetic:
 *
 *   1. request id + security headers + CORS + compression + cookies
 *   2. request logging (needs the id from step 1)
 *   3. **gateway webhooks with a RAW body parser** — a provider signs the exact bytes it sent,
 *      so if `express.json()` ran first the HMAC would be computed over a re-serialised object
 *      and every legitimate webhook would fail verification
 *   4. JSON / urlencoded parsers with a limit sized for CSV import
 *   5. CSRF cookie + input sanitisation (strips `$`-operators so a body cannot inject a query)
 *   6. rate limiting
 *   7. the API router
 *   8. 404 + the single error handler
 *
 * There is exactly one error handler and it is registered last, so no route can respond with a
 * stack trace or an inconsistent envelope.
 */
export function createApp(): Express {
  const app = express();

  // Behind a load balancer / the sandbox proxy: without this, `req.ip` and the secure-cookie
  // decision are wrong, and rate limiting would key every request to the proxy's address.
  app.set('trust proxy', env.TRUST_PROXY);
  app.disable('x-powered-by');
  app.disable('etag');

  app.use(...beforeBodyMiddleware());
  app.use(pinoHttp());

  /* ------------------------- 3. raw-body webhook route ------------------------ */

  // Mounted before the JSON parser on purpose — see the ordering note above.
  app.use(`${env.API_PREFIX}/webhooks/payments`, rateLimiters.webhook, paymentWebhookRouter);

  /* ------------------------------ 4. body parsers ----------------------------- */

  app.use(express.json({ limit: env.BODY_LIMIT, strict: true }));
  app.use(express.urlencoded({ limit: env.BODY_LIMIT, extended: true }));

  // Text bodies (CSV import, webhook replays from tooling) are accepted but size-capped.
  app.use(express.text({ limit: env.BODY_LIMIT, type: ['text/csv', 'text/plain'] }));

  /* --------------------- 5. CSRF + sanitisation (post-parse) ------------------- */

  app.use(...afterBodyMiddleware());
  app.use(csrfProtection());

  /* ------------------------------- 6. rate limits ------------------------------ */

  if (env.RATE_LIMIT_ENABLED) {
    app.use(`${env.API_PREFIX}/auth`, rateLimiters.auth);
    app.use(env.API_PREFIX, rateLimiters.api);
  }

  /* ---------------------------------- 7. API ---------------------------------- */

  app.use(env.API_PREFIX, apiRouter);

  // Root redirect keeps a browser that lands on the bare host from seeing a 404.
  app.get('/', (_req: Request, res: Response) => {
    res.status(200).json({
      success: true,
      message: 'Colonize platform API',
      data: {
        name: 'Colonize — Community & Society Management Platform',
        version: '1.0.0',
        environment: env.NODE_ENV,
        api: env.API_PREFIX,
        health: `${env.API_PREFIX}/health`,
        docs: env.SWAGGER_ENABLED ? '/docs' : null,
      },
    });
  });

  /* --------------------------------- 8. docs ---------------------------------- */

  if (env.SWAGGER_ENABLED) mountSwagger(app);

  /* --------------------------- 9. 404 + error handler -------------------------- */

  app.use(notFoundHandler);
  app.use(errorHandler);

  // Express 5 rejects async errors into this handler; anything still unhandled is a bug and
  // must be logged loudly rather than swallowed.
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled promise rejection');
  });

  return app;
}

export default createApp;
