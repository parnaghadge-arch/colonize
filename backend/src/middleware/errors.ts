import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { MulterError } from 'multer';
import { ApiError, isApiError, toApiError } from '../utils/errors.js';
import { logger } from '../config/logger.js';
import { env } from '../config/env.js';

/**
 * Centralised error handling (§66).
 *
 * Users only ever see `message` + field errors. The full error (stack, cause, driver
 * diagnostics) is logged with the request id so support can correlate a report to a log line.
 */

/** 404 for unmatched API routes — returns the standard envelope, not Express's HTML page. */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    success: false,
    message: `Route ${req.method} ${req.originalUrl} does not exist`,
    code: 'NOT_FOUND',
  });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  let apiError: ApiError;

  if (isApiError(err)) {
    apiError = err;
  } else if (err instanceof ZodError) {
    apiError = ApiError.validation(
      'Validation failed',
      err.issues.slice(0, 30).map((i) => ({ field: i.path.join('.') || undefined, message: i.message, code: i.code })),
    );
  } else if (err instanceof MulterError) {
    apiError =
      err.code === 'LIMIT_FILE_SIZE'
        ? new ApiError(`File is too large. Maximum size is ${env.MAX_UPLOAD_MB} MB.`, 'UPLOAD_TOO_LARGE')
        : new ApiError(`Upload failed: ${err.message}`, 'UPLOAD_INVALID');
  } else if (err instanceof SyntaxError && 'body' in (err as object)) {
    apiError = ApiError.badRequest('Request body is not valid JSON');
  } else {
    apiError = toApiError(err);
  }

  const ctx = req.ctx;
  const logPayload = {
    err: apiError.cause ?? err,
    requestId: ctx?.requestId ?? (req.headers['x-request-id'] as string | undefined),
    method: req.method,
    path: req.originalUrl,
    status: apiError.statusCode,
    code: apiError.code,
    societyId: ctx?.society?.id,
    userId: ctx?.principal?.userId,
    roles: ctx?.principal?.roles,
    ip: ctx?.ip,
    tookMs: ctx ? Date.now() - ctx.startedAt : undefined,
    stack: apiError.statusCode >= 500 ? apiError.stack : undefined,
  };

  if (apiError.statusCode >= 500) logger.error(logPayload, apiError.message);
  else if (apiError.statusCode >= 400) logger.warn(logPayload, apiError.message);

  const body = apiError.toJSON();
  res.status(apiError.statusCode).json({
    ...body,
    meta: {
      requestId: logPayload.requestId,
      ...(env.NODE_ENV !== 'production' && apiError.statusCode >= 500 && apiError.details
        ? { debug: apiError.details }
        : {}),
    },
  });
}

/** Wrap an async route handler so rejections reach `errorHandler` (Express 5 also does this). */
export function asyncHandler<A extends unknown[]>(
  fn: (req: Request, res: Response, next: NextFunction, ...args: A) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction, ...args: A): void => {
    fn(req, res, next, ...args).catch(next);
  };
}

/** Re-export so handlers can assert their context without importing two modules. */
export { requireContext } from './authenticate.js';
