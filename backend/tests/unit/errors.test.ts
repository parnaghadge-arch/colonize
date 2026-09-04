import { describe, expect, it } from 'vitest';
import { ApiError, isApiError, toApiError } from '../../src/utils/errors.js';

/**
 * Typed application errors (§66).
 *
 * Only statusCode, message, code and errors ever reach a client — the stack and cause are logged
 * server-side and swallowed at the boundary, so an internal failure cannot leak implementation
 * details.
 */
describe('ApiError factories map to the right HTTP status', () => {
  it.each([
    ['badRequest', () => ApiError.badRequest('Nope'), 400],
    ['validation', () => ApiError.validation('Bad input'), 422],
    ['unauthenticated', () => ApiError.unauthenticated(), 401],
    ['forbidden', () => ApiError.forbidden(), 403],
    ['notFound', () => ApiError.notFound('Unit'), 404],
    ['conflict', () => ApiError.conflict('Already exists'), 409],
    ['duplicate', () => ApiError.duplicate('Taken'), 409],
    ['tenantMismatch', () => ApiError.tenantMismatch(), 403],
    ['moduleDisabled', () => ApiError.moduleDisabled('polls'), 403],
    ['internal', () => ApiError.internal(), 500],
  ])('%s produces HTTP %i', (_name, factory, status) => {
    expect(factory().statusCode).toBe(status);
  });

  it('gives a not-found error a readable, resource-specific message', () => {
    const err = ApiError.notFound('Amenity Booking');
    expect(err.message).toBe('Amenity Booking not found');
    expect(err.code).toBe('NOT_FOUND');
  });

  it('marks the tenant-mismatch error with its own code so clients can react to it', () => {
    expect(ApiError.tenantMismatch().code).toBe('TENANT_MISMATCH');
  });

  it('names the module that the subscription does not include', () => {
    const err = ApiError.moduleDisabled('polls');
    expect(err.code).toBe('MODULE_DISABLED');
    expect(err.message).toContain('polls');
    expect(err.message).toMatch(/plan/i);
  });

  it('carries field-level validation errors', () => {
    const err = ApiError.validation('Validation failed', [{ field: 'phone', message: 'required' }]);
    expect(err.errors).toEqual([{ field: 'phone', message: 'required' }]);
  });
});

describe('ApiError exposure', () => {
  it('is safe to expose for client errors', () => {
    expect(ApiError.badRequest('Nope').expose).toBe(true);
    expect(ApiError.notFound('X').expose).toBe(true);
    expect(ApiError.tenantMismatch().expose).toBe(true);
  });

  it('keeps the diagnostic in .message for the server-side log', () => {
    const err = ApiError.internal('connection pool exhausted at 10.0.0.4:27017');
    expect(err.message).toContain('10.0.0.4');
    expect(err.expose).toBe(false);
  });

  it('never sends an internal message to the client', () => {
    const err = ApiError.internal('connection pool exhausted at 10.0.0.4:27017');
    const body = err.toJSON();
    expect(body.message).toBe('Something went wrong. Please try again.');
    expect(body.message).not.toContain('10.0.0.4');
    expect(body.code).toBe('INTERNAL_ERROR');
  });

  it('hides internal details as well as the message', () => {
    const err = ApiError.internal('boom');
    err.details = { query: 'db.units.find()', host: '10.0.0.4' };
    expect(err.toJSON()).not.toHaveProperty('details');
  });

  it('does send details for a client error, where they help the user', () => {
    const err = ApiError.moduleDisabled('polls');
    const body = err.toJSON();
    expect(body.message).toContain('polls');
    expect(body.details).toEqual({ moduleKey: 'polls' });
  });

  it('includes field errors in the response body', () => {
    const body = ApiError.validation('Validation failed', [{ field: 'phone', message: 'required' }]).toJSON();
    expect(body.success).toBe(false);
    expect(body.errors).toEqual([{ field: 'phone', message: 'required' }]);
  });

  it('omits an empty errors array so the envelope stays clean', () => {
    expect(ApiError.notFound('X').toJSON()).not.toHaveProperty('errors');
  });

  it('is a real Error, so it can be thrown and caught normally', () => {
    const err = ApiError.notFound('X');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ApiError);
    expect(typeof err.stack).toBe('string');
  });

  it('preserves the cause for logging without serialising it', () => {
    const err = ApiError.internal('wrap me', new Error('root cause'));
    expect((err.cause as Error).message).toBe('root cause');
    expect(JSON.stringify(err.toJSON())).not.toContain('root cause');
  });
});

describe('isApiError / toApiError', () => {
  it('recognises an ApiError', () => {
    expect(isApiError(ApiError.notFound('X'))).toBe(true);
  });

  it('does not mistake a plain Error for an ApiError', () => {
    expect(isApiError(new Error('boom'))).toBe(false);
    expect(isApiError('boom')).toBe(false);
    expect(isApiError(null)).toBe(false);
    expect(isApiError(undefined)).toBe(false);
    expect(isApiError({ statusCode: 404 })).toBe(false);
  });

  it('passes an ApiError through untouched', () => {
    const err = ApiError.conflict('Already paid');
    expect(toApiError(err)).toBe(err);
  });

  it('converts an unexpected error into a generic 500 without leaking its message', () => {
    const converted = toApiError(new Error('MongoNetworkError: failed to connect to 10.1.2.3'));
    expect(converted.statusCode).toBe(500);
    expect(converted.code).toBe('INTERNAL_ERROR');
    expect(converted.message).not.toContain('10.1.2.3');
    expect(converted.message).not.toContain('MongoNetworkError');
  });

  it('uses the supplied fallback message', () => {
    expect(toApiError(new Error('x'), 'Could not generate the bill').message).toBe(
      'Could not generate the bill',
    );
  });

  it('converts non-error throwables', () => {
    expect(toApiError('a string was thrown').statusCode).toBe(500);
    expect(toApiError(null).statusCode).toBe(500);
  });
});
