import type { FieldError } from '@colonize/shared';

/**
 * Typed application error (§66).
 *
 * Only `statusCode`, `message`, `code` and `errors` ever reach a client. The original
 * stack/cause is logged server-side and swallowed at the boundary.
 */

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'DUPLICATE'
  | 'RATE_LIMITED'
  | 'TENANT_MISMATCH'
  | 'MODULE_DISABLED'
  | 'SUBSCRIPTION_INACTIVE'
  | 'PAYMENT_FAILED'
  | 'PAYMENT_ALREADY_PROCESSED'
  | 'INSUFFICIENT_BALANCE'
  | 'SLOT_UNAVAILABLE'
  | 'DOUBLE_BOOKING'
  | 'QR_INVALID'
  | 'QR_EXPIRED'
  | 'QR_ALREADY_USED'
  | 'QR_NOT_YET_VALID'
  | 'QR_WRONG_SOCIETY'
  | 'OTP_INVALID'
  | 'OTP_EXPIRED'
  | 'OTP_ATTEMPTS_EXCEEDED'
  | 'OTP_COOLDOWN'
  | 'TOKEN_INVALID'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_REUSED'
  | 'ACCOUNT_LOCKED'
  | 'ACCOUNT_INACTIVE'
  | 'UPLOAD_INVALID'
  | 'UPLOAD_TOO_LARGE'
  | 'IDEMPOTENCY_CONFLICT'
  | 'STATE_CONFLICT'
  | 'DEPENDENCY_FAILED'
  | 'UNPROCESSABLE'
  | 'INTERNAL_ERROR';

const CODE_TO_STATUS: Partial<Record<ErrorCode, number>> = {
  VALIDATION_ERROR: 422,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  DUPLICATE: 409,
  RATE_LIMITED: 429,
  TENANT_MISMATCH: 403,
  MODULE_DISABLED: 403,
  SUBSCRIPTION_INACTIVE: 402,
  PAYMENT_FAILED: 402,
  PAYMENT_ALREADY_PROCESSED: 409,
  INSUFFICIENT_BALANCE: 402,
  SLOT_UNAVAILABLE: 409,
  DOUBLE_BOOKING: 409,
  QR_INVALID: 400,
  QR_EXPIRED: 410,
  QR_ALREADY_USED: 409,
  QR_NOT_YET_VALID: 425,
  QR_WRONG_SOCIETY: 403,
  OTP_INVALID: 400,
  OTP_EXPIRED: 410,
  OTP_ATTEMPTS_EXCEEDED: 429,
  OTP_COOLDOWN: 429,
  TOKEN_INVALID: 401,
  TOKEN_EXPIRED: 401,
  TOKEN_REUSED: 401,
  ACCOUNT_LOCKED: 423,
  ACCOUNT_INACTIVE: 403,
  UPLOAD_INVALID: 415,
  UPLOAD_TOO_LARGE: 413,
  IDEMPOTENCY_CONFLICT: 409,
  STATE_CONFLICT: 409,
  DEPENDENCY_FAILED: 502,
  UNPROCESSABLE: 422,
  INTERNAL_ERROR: 500,
};

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly errors: FieldError[];
  readonly details?: Record<string, unknown>;
  readonly expose: boolean;
  cause?: unknown;

  constructor(
    message: string,
    code: ErrorCode = 'INTERNAL_ERROR',
    opts: {
      statusCode?: number;
      errors?: FieldError[];
      details?: Record<string, unknown>;
      cause?: unknown;
      expose?: boolean;
    } = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.statusCode = opts.statusCode ?? CODE_TO_STATUS[code] ?? 500;
    this.errors = opts.errors ?? [];
    this.details = opts.details;
    this.cause = opts.cause;
    // 5xx messages are replaced with a generic string at the boundary unless `expose`.
    this.expose = opts.expose ?? this.statusCode < 500;
    Error.captureStackTrace?.(this, ApiError);
  }

  static badRequest(message: string, errors?: FieldError[], details?: Record<string, unknown>) {
    return new ApiError(message, 'VALIDATION_ERROR', { statusCode: 400, errors, details });
  }

  static validation(message: string, errors: FieldError[] = []) {
    return new ApiError(message, 'VALIDATION_ERROR', { errors });
  }

  static unauthenticated(message = 'Authentication required', code: ErrorCode = 'UNAUTHENTICATED') {
    return new ApiError(message, code);
  }

  static forbidden(message = 'You do not have access to this resource', code: ErrorCode = 'FORBIDDEN') {
    return new ApiError(message, code);
  }

  static notFound(resource = 'Resource') {
    return new ApiError(`${resource} not found`, 'NOT_FOUND');
  }

  static conflict(message: string, code: ErrorCode = 'CONFLICT', details?: Record<string, unknown>) {
    return new ApiError(message, code, { details });
  }

  static duplicate(message: string, details?: Record<string, unknown>) {
    return new ApiError(message, 'DUPLICATE', { details });
  }

  static tenantMismatch(message = 'Cross-society access is not permitted') {
    return new ApiError(message, 'TENANT_MISMATCH');
  }

  static moduleDisabled(moduleKey: string) {
    return new ApiError(
      `The "${moduleKey}" module is not included in this society's subscription plan.`,
      'MODULE_DISABLED',
      { details: { moduleKey } },
    );
  }

  static internal(message = 'Something went wrong', cause?: unknown) {
    return new ApiError(message, 'INTERNAL_ERROR', { cause, expose: false });
  }

  toJSON() {
    return {
      success: false as const,
      message: this.expose ? this.message : 'Something went wrong. Please try again.',
      code: this.code,
      ...(this.errors.length > 0 ? { errors: this.errors } : {}),
      ...(this.details && this.expose ? { details: this.details } : {}),
    };
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

/** Wrap an unknown thrown value into an ApiError without losing the original for logging. */
export function toApiError(err: unknown, fallbackMessage = 'Something went wrong'): ApiError {
  if (isApiError(err)) return err;
  if (err instanceof Error) {
    // Duplicate key errors surface from both persistence drivers.
    if (/E11000|duplicate key/i.test(err.message)) {
      return new ApiError('A record with these details already exists', 'DUPLICATE', { cause: err });
    }
    if (/Cast to ObjectId failed|Malformed ObjectId/i.test(err.message)) {
      return new ApiError('Invalid record identifier', 'VALIDATION_ERROR', { cause: err });
    }
    return new ApiError(fallbackMessage, 'INTERNAL_ERROR', { cause: err, expose: false });
  }
  return new ApiError(fallbackMessage, 'INTERNAL_ERROR', { cause: err, expose: false });
}
