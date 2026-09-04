import jwt from 'jsonwebtoken';
import type { SignOptions } from 'jsonwebtoken';
import { env } from '../config/env.js';
import { ApiError } from '../utils/errors.js';
import { randomHex } from './crypto.js';

/**
 * Access / refresh token issuing (§7).
 *
 * Access tokens are short lived and carry only claims needed for routing + display.
 * Authorisation is **never** taken from the token alone: `authenticate` re-reads the user's
 * roles and the society's role→permission matrix from the database on every request, so
 * revoking a permission takes effect immediately.
 *
 * Refresh tokens are opaque random strings; only their SHA-256 hash is stored, together with
 * a `tokenFamily`. Rotation issues a new token and marks the old one used. Presenting an
 * already-used token revokes the entire family (replay/theft detection).
 */

export type TokenScope = 'platform' | 'tenant';

export interface AccessTokenClaims {
  sub: string;
  scope: TokenScope;
  soc?: string;
  sid?: string;
  rol?: string[];
  typ: 'access';
}

export interface RefreshTokenClaims {
  sub: string;
  scope: TokenScope;
  soc?: string;
  sid: string;
  fam: string;
  jti: string;
  typ: 'refresh';
}

function secondsFromExpiry(value: string): number {
  const match = /^(\d+)([smhd])$/.exec(value.trim());
  if (!match) return 900;
  const n = Number(match[1]);
  const unit = match[2];
  if (unit === 's') return n;
  if (unit === 'm') return n * 60;
  if (unit === 'h') return n * 3600;
  return n * 86400;
}

export const ACCESS_TOKEN_TTL_SECONDS = secondsFromExpiry(env.JWT_EXPIRES_IN);
export const REFRESH_TOKEN_TTL_SECONDS = secondsFromExpiry(env.JWT_REFRESH_EXPIRES_IN);

const baseOptions: SignOptions = {
  issuer: env.JWT_ISSUER,
  audience: env.JWT_AUDIENCE,
};

export function signAccessToken(claims: Omit<AccessTokenClaims, 'typ'>): string {
  return jwt.sign({ ...claims, typ: 'access' }, env.JWT_SECRET, {
    ...baseOptions,
    expiresIn: env.JWT_EXPIRES_IN as SignOptions['expiresIn'],
    algorithm: 'HS256',
  });
}

export function signRefreshToken(claims: Omit<RefreshTokenClaims, 'typ'>): string {
  return jwt.sign({ ...claims, typ: 'refresh' }, env.JWT_REFRESH_SECRET, {
    ...baseOptions,
    expiresIn: env.JWT_REFRESH_EXPIRES_IN as SignOptions['expiresIn'],
    algorithm: 'HS256',
  });
}

export function newTokenFamily(): string {
  return randomHex(8);
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      algorithms: ['HS256'],
    }) as AccessTokenClaims;
    if (decoded.typ !== 'access') throw ApiError.unauthenticated('Wrong token type', 'TOKEN_INVALID');
    return decoded;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if ((err as Error).name === 'TokenExpiredError') {
      throw ApiError.unauthenticated('Session expired. Please sign in again.', 'TOKEN_EXPIRED');
    }
    throw ApiError.unauthenticated('Invalid authentication token', 'TOKEN_INVALID');
  }
}

export function verifyRefreshToken(token: string): RefreshTokenClaims {
  try {
    const decoded = jwt.verify(token, env.JWT_REFRESH_SECRET, {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      algorithms: ['HS256'],
    }) as RefreshTokenClaims;
    if (decoded.typ !== 'refresh') throw ApiError.unauthenticated('Wrong token type', 'TOKEN_INVALID');
    return decoded;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if ((err as Error).name === 'TokenExpiredError') {
      throw ApiError.unauthenticated('Refresh token expired. Please sign in again.', 'TOKEN_EXPIRED');
    }
    throw ApiError.unauthenticated('Invalid refresh token', 'TOKEN_INVALID');
  }
}

/** Single-use password-reset / invitation token (short lived, opaque payload). */
export function signOneTimeToken(payload: Record<string, unknown>, ttlSeconds = 900): string {
  return jwt.sign({ ...payload, typ: 'otp-action' }, env.JWT_SECRET, {
    ...baseOptions,
    expiresIn: ttlSeconds,
    algorithm: 'HS256',
  });
}

export function verifyOneTimeToken<T extends Record<string, unknown>>(token: string): T {
  try {
    return jwt.verify(token, env.JWT_SECRET, {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      algorithms: ['HS256'],
    }) as T;
  } catch {
    throw ApiError.badRequest('This link has expired. Please request a new one.');
  }
}
