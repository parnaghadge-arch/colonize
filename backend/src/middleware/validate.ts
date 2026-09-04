import type { NextFunction, Request, Response } from 'express';
import { z, type ZodTypeAny } from 'zod';
import { ApiError } from '../utils/errors.js';
import type { FieldError } from '@colonize/shared';

/**
 * Request validation (§51 "API validation", §81.11 "implement proper validation").
 *
 * The parsed (and therefore transformed) value replaces the raw input on `req`, so
 * downstream code always works with normalised data — phone numbers are already E.164,
 * names are trimmed, numeric strings are numbers.
 */

type Source = 'body' | 'query' | 'params';

function toFieldErrors(error: z.ZodError): FieldError[] {
  return error.issues.slice(0, 30).map((issue) => ({
    field: issue.path.join('.') || undefined,
    message: issue.message,
    code: issue.code,
  }));
}

export function validate(schema: ZodTypeAny, source: Source = 'body') {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      next(
        ApiError.validation(
          source === 'body' ? 'Validation failed' : `Invalid ${source} parameters`,
          toFieldErrors(result.error as z.ZodError),
        ),
      );
      return;
    }

    const data = result.data as Record<string, unknown>;
    if (source === 'params') {
      Object.defineProperty(req, 'params', { value: data, writable: true, configurable: true });
    } else if (source === 'query') {
      // Express 5 exposes `query` as a prototype getter — redefine on the instance.
      Object.defineProperty(req, 'query', { value: data, writable: true, configurable: true });
    } else {
      Object.defineProperty(req, 'body', { value: data, writable: true, configurable: true });
    }
    next();
  };
}

/** Params of the shape `{ id }` (or a custom name). */
export function validateIdParam(name = 'id') {
  return validate(z.object({ [name]: z.string().trim().min(3).max(64) }), 'params');
}

/** Params containing several ids at once. */
export function validateIdParams(...names: string[]) {
  return validate(z.object(Object.fromEntries(names.map((n) => [n, z.string().trim().min(3).max(64)]))), 'params');
}
