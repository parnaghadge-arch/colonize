import type { RequestContext } from '../middleware/context.js';

/**
 * Express request augmentation: `req.ctx` is populated by `authenticate` and carries the
 * fully resolved principal, society, membership and database handle for this request.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ctx?: RequestContext;
      /** Set by the idempotency middleware when a stored response is replayed. */
      idempotencyReplay?: boolean;
    }
  }
}

export {};
