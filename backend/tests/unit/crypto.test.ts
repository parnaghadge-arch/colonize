import { describe, expect, it } from 'vitest';
import {
  fingerprint,
  hashPassword,
  hashSecret,
  hmacSign,
  hmacVerify,
  randomHex,
  safeEqualString,
  sha256,
  verifyPassword,
} from '../../src/services/crypto.js';

/**
 * Cryptographic primitives (§51).
 *
 * Passwords are bcrypt; tokens and OTPs are SHA-256 at rest so a database leak never yields
 * usable credentials; QR passes use a dedicated HMAC key; every comparison is constant time.
 */
describe('password hashing', () => {
  it('round-trips a correct password', async () => {
    const hash = await hashPassword('Resident@123');
    await expect(verifyPassword('Resident@123', hash)).resolves.toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword('Resident@123');
    await expect(verifyPassword('resident@123', hash)).resolves.toBe(false);
    await expect(verifyPassword('Resident@124', hash)).resolves.toBe(false);
  });

  it('rejects against a missing or corrupt hash instead of throwing', async () => {
    await expect(verifyPassword('anything', null)).resolves.toBe(false);
    await expect(verifyPassword('anything', undefined)).resolves.toBe(false);
    await expect(verifyPassword('anything', 'not-a-bcrypt-hash')).resolves.toBe(false);
  });

  it('salts, so the same password hashes differently every time', async () => {
    const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')]);
    expect(a).not.toBe(b);
    await expect(verifyPassword('same', a)).resolves.toBe(true);
    await expect(verifyPassword('same', b)).resolves.toBe(true);
  });

  it('never stores the plaintext inside the hash', async () => {
    const hash = await hashPassword('SuperSecret@9');
    expect(hash).not.toContain('SuperSecret@9');
    expect(hash.startsWith('$2')).toBe(true);
  });
});

describe('sha256 / hashSecret', () => {
  it('is deterministic and hex-encoded', () => {
    expect(sha256('abc')).toBe(sha256('abc'));
    expect(sha256('abc')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches the known SHA-256 of "abc"', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('avalanches: a one-character change alters the whole digest', () => {
    expect(sha256('otp:123456')).not.toBe(sha256('otp:123457'));
  });

  it('peppers a secret so the stored hash is not a bare digest', () => {
    const secret = 'refresh-token-value';
    expect(hashSecret(secret)).not.toBe(sha256(secret));
    expect(hashSecret(secret)).toBe(hashSecret(secret));
  });

  it('different peppers produce different hashes for the same secret', () => {
    expect(hashSecret('tok', 'pepper-a')).not.toBe(hashSecret('tok', 'pepper-b'));
  });
});

describe('hmacSign / hmacVerify', () => {
  it('verifies a signature it produced', () => {
    const sig = hmacSign('CLNZ1.payload');
    expect(hmacVerify('CLNZ1.payload', sig)).toBe(true);
  });

  it('rejects a tampered payload', () => {
    const sig = hmacSign('pass_1|soc_1|ACTIVE');
    expect(hmacVerify('pass_1|soc_1|REVOKED', sig)).toBe(false);
  });

  it('rejects a signature made with a different key', () => {
    const sig = hmacSign('payload', 'key-one');
    expect(hmacVerify('payload', sig, 'key-two')).toBe(false);
  });

  it('is base64url (safe to put in a QR string and a URL)', () => {
    const sig = hmacSign('some payload');
    expect(sig).not.toMatch(/[+/=]/);
    expect(encodeURIComponent(sig)).toBe(sig);
  });
});

describe('safeEqualString', () => {
  it('compares equal strings', () => {
    expect(safeEqualString('abc', 'abc')).toBe(true);
  });

  it('rejects differing strings of the same length', () => {
    expect(safeEqualString('abc', 'abd')).toBe(false);
  });

  it('rejects differing lengths without throwing', () => {
    expect(safeEqualString('abc', 'abcd')).toBe(false);
    expect(safeEqualString('', 'x')).toBe(false);
    expect(safeEqualString('x', '')).toBe(false);
  });

  it('rejects non-string input rather than coercing it', () => {
    // A prototype-polluted or NoSQL-injected value must never compare equal to a string.
    expect(safeEqualString('123456', 123456 as unknown as string)).toBe(false);
    expect(safeEqualString(null as unknown as string, null as unknown as string)).toBe(false);
    expect(safeEqualString(undefined as unknown as string, 'x')).toBe(false);
  });
});

describe('randomHex / fingerprint', () => {
  it('returns hex of twice the requested byte length', () => {
    expect(randomHex()).toMatch(/^[0-9a-f]{64}$/);
    expect(randomHex(8)).toMatch(/^[0-9a-f]{16}$/);
    expect(randomHex(8)).not.toBe(randomHex(8));
  });

  it('fingerprints to a short, stable, non-reversible tag for logs', () => {
    const tag = fingerprint('a-very-long-bearer-token');
    expect(tag).toHaveLength(12);
    expect(tag).toBe(fingerprint('a-very-long-bearer-token'));
    expect(tag).not.toContain('bearer');
  });

  it('distinguishes different tokens', () => {
    expect(fingerprint('token-a')).not.toBe(fingerprint('token-b'));
  });
});
