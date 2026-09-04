import type { Response } from 'express';
import type { ApiMeta, FieldError } from '@colonize/shared';
import { buildMeta } from '@colonize/shared';
import { ApiError } from './errors.js';

/**
 * Consistent response envelope (§52).
 *
 *   success → { success: true,  message, data, meta }
 *   failure → { success: false, message, errors?, code? }
 */

export function ok<T>(res: Response, data: T, message = 'Operation successful', meta?: ApiMeta, status = 200) {
  return res.status(status).json({ success: true, message, data, ...(meta ? { meta } : {}) });
}

export function created<T>(res: Response, data: T, message = 'Created successfully') {
  return res.status(201).json({ success: true, message, data });
}

export function noContent(res: Response) {
  return res.status(204).send();
}

export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
}

/** List response with pagination meta. */
export function paginated<T>(res: Response, result: PageResult<T>, message = 'Fetched successfully') {
  const meta = buildMeta(
    result.total,
    result.page,
    result.limit,
    result.sortBy ?? 'createdAt',
    result.sortDir ?? 'desc',
  );
  return res.status(200).json({ success: true, message, data: { items: result.items }, meta });
}

export function fail(
  res: Response,
  status: number,
  message: string,
  errors: FieldError[] = [],
  code?: string,
  extra?: Record<string, unknown>,
) {
  return res.status(status).json({
    success: false,
    message,
    ...(errors.length > 0 ? { errors } : {}),
    ...(code ? { code } : {}),
    ...(extra ? { meta: extra } : {}),
  });
}

export function sendError(res: Response, err: ApiError) {
  return res.status(err.statusCode).json(err.toJSON());
}

/** Helper used inside services to build an envelope without a Response object. */
export function envelope<T>(data: T, message = 'Operation successful', meta?: ApiMeta) {
  return { success: true as const, message, data, ...(meta ? { meta } : {}) };
}
