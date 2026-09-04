import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';

/**
 * Cryptographic primitives (§51).
 *
 *  • passwords   → bcrypt (cost 12 in production, 10 elsewhere to keep tests fast)
 *  • tokens/OTPs → SHA-256 at rest, so a database leak never yields usable credentials
 *  • QR passes   → HMAC-SHA256 with a dedicated signing key (rotatable independently of JWT)
 *  • comparisons → constant time
 */

const BCRYPT_ROUNDS = env.NODE_ENV === 'production' ? 12 : 10;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string | null | undefined): Promise<boolean> {
  if (!hash) return false;
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Hash a bearer/refresh/OTP value for storage. Peppered so hashes are not rainbow-able. */
export function hashSecret(secret: string, pepper: string = env.JWT_REFRESH_SECRET): string {
  return sha256(`${pepper}:${secret}`);
}

export function hmacSign(payload: string, key: string = env.QR_SIGNING_SECRET): string {
  return createHmac('sha256', key).update(payload, 'utf8').digest('base64url');
}

export function hmacVerify(payload: string, signature: string, key: string = env.QR_SIGNING_SECRET): boolean {
  const expected = hmacSign(payload, key);
  return safeEqualString(expected, signature);
}

export function safeEqualString(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Compare anyway to keep timing uniform, then report false.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function randomHex(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

export function randomBytesBuffer(bytes: number): Buffer {
  return randomBytes(bytes);
}

/** Mask secrets for logging (never log a full token). */
export function fingerprint(value: string): string {
  return sha256(value).slice(0, 12);
}
