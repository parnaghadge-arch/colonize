// Named import: under `moduleResolution: NodeNext` the default import of this CJS package
// resolves to the module namespace, which TypeScript reports as non-callable.
import { pinoHttp as pinoHttpMiddleware } from 'pino-http';
import type { Request, Response } from 'express';
import { logger } from './logger.js';
import { env } from './env.js';

/**
 * HTTP request logging (§67).
 *
 * Built on the already-redacting `logger`, so an authorization header or a password in a body
 * never reaches a log sink. Health probes are excluded: a container liveness check every few
 * seconds would otherwise drown out real traffic.
 *
 * The pino-http factory is imported under an alias because this module exports a function of the
 * same name — without the alias the local declaration shadows the import.
 */

const QUIET_PATHS = new Set([
  `${env.API_PREFIX}/health`,
  `${env.API_PREFIX}/health/ready`,
  '/health',
  '/livez',
  '/readyz',
]);

/** Paths whose bodies must never be echoed, even at trace level. */
const SENSITIVE_PATHS = ['/auth/', '/payments/', '/webhooks/', '/otp', '/password', '/pin'];

const pathOf = (req: Request): string => String(req.originalUrl ?? req.url ?? '').split('?')[0] ?? '';

/** Request logger middleware, typed against Express's Request/Response. */
export function pinoHttp() {
  return pinoHttpMiddleware<Request, Response>({
    logger,
    // Reuse the id assigned by `requestId()` so the log line and the response header agree.
    genReqId: (req) => req.id ?? (req.headers['x-request-id'] as string | undefined) ?? 'unknown',
    customLogLevel: (_req, res, error) => {
      if (error || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    customSuccessMessage: (req, res) => `${req.method} ${req.url} → ${res.statusCode}`,
    customErrorMessage: (req, res) => `${req.method} ${req.url} → ${res.statusCode}`,
    customAttributeKeys: {
      reqId: 'requestId',
      req: 'request',
      res: 'response',
      err: 'error',
      responseTime: 'durationMs',
    },
    // Log a compact, searchable subset rather than serialising the whole request.
    customProps: (req, res) => {
      const url = String(req.originalUrl ?? req.url ?? '');
      const sensitive = SENSITIVE_PATHS.some((p) => url.includes(p));
      return {
        method: req.method,
        path: url.split('?')[0],
        statusCode: res.statusCode,
        // Naming the society and the caller is what makes a multi-tenant log greppable.
        // `ctx` is populated by `authenticate`, so it is absent for unauthenticated routes.
        societyId: req.ctx?.society?.id ?? null,
        userId: req.ctx?.principal?.userId ?? null,
        roles: req.ctx?.principal?.roles ?? null,
        requestId: req.ctx?.requestId ?? (req.id as string | undefined) ?? null,
        // Never echo a body that could carry credentials, OTPs or card data.
        ...(sensitive ? { body: '[REDACTED]' } : {}),
      };
    },
    // Skip the probe endpoints entirely.
    autoLogging: {
      ignore: (req) => QUIET_PATHS.has(pathOf(req)),
    },
  });
}
