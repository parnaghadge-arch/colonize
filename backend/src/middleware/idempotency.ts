import type { NextFunction, Request, Response } from 'express';
import { idempotencyKeyFrom, runIdempotent } from '../services/idempotency.js';
import { requireContext } from './authenticate.js';
import { logger } from '../config/logger.js';

/**
 * Idempotency middleware.
 *
 * Mount on POST routes that must not double-apply (payments, gate captures, attendance,
 * bookings). When no key is supplied the request simply runs normally — the guard is opt-in
 * per client, and the offline security app always sends one.
 */
export function idempotent() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = idempotencyKeyFrom(req.headers as Record<string, unknown>, req.body);
    if (!key) return next();

    try {
      const ctx = requireContext(req);
      const db = ctx.db ?? ctx.platformDatabase;
      const societyId = ctx.society?.id ?? 'platform';

      // Capture the response the handler produces so it can be stored for replays.
      const originalJson = res.json.bind(res);
      let capturedStatus = 200;
      let capturedBody: unknown;
      res.json = ((body: unknown) => {
        capturedBody = body;
        capturedStatus = res.statusCode;
        return originalJson(body);
      }) as Response['json'];

      const outcome = await runIdempotent(
        {
          db,
          societyId,
          key,
          userId: ctx.principal.userId,
          method: req.method,
          path: req.originalUrl.split('?')[0],
          requestPayload: { body: req.body, params: req.params },
        },
        async () => {
          await new Promise<void>((resolve, reject) => {
            // Run the rest of the chain, then resolve once the response has been sent.
            res.on('finish', resolve);
            res.on('close', resolve);
            next((err?: unknown) => (err ? reject(err) : undefined));
          });
          return { status: capturedStatus, body: capturedBody };
        },
      );

      if (outcome.replayed) {
        res.setHeader('Idempotency-Replayed', 'true');
        // The handler already sent the original response on the first pass; on a replay we
        // have not called next(), so send the stored one here.
        if (!res.headersSent) res.status(outcome.status).json(outcome.body);
      } else if (!res.headersSent) {
        res.status(outcome.status).json(outcome.body);
      }
      return undefined;
    } catch (err) {
      logger.debug({ err: (err as Error).message }, 'idempotency: request rejected');
      return next(err);
    }
  };
}
