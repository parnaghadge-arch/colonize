import { describe, expect, it } from 'vitest';
import { buildToken, parseToken } from '../../src/services/qr.js';
import { hmacSign } from '../../src/services/crypto.js';
import { ApiError } from '../../src/utils/errors.js';

/**
 * Secure QR passes (§12, §57).
 *
 * A pass is `CLNZ1.<base64url(payload)>.<base64url(hmac)>`. The signature is checked *before*
 * any database lookup, so a forged or edited token is rejected cheaply, and the payload carries
 * no PII — scanning a resident's pass at a gate reveals nothing to a bystander.
 */

const SOCIETY = 'soc_AXavMVdBycyDSNyAJ6';
const PASS = 'pas_9xKd2Mq7RtVb3LpN';

function future(seconds = 3600): Date {
  return new Date(Date.now() + seconds * 1000);
}

function codeOf(err: unknown): string | undefined {
  return err instanceof ApiError ? err.code : undefined;
}

function splitToken(token: string): [string, string, string] {
  const parts = token.split('.');
  expect(parts).toHaveLength(3);
  return parts as [string, string, string];
}

function decodeBody(body: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function reencode(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

describe('buildToken', () => {
  it('produces the documented three-part CLNZ1 envelope', () => {
    const token = buildToken('VISITOR', PASS, SOCIETY, future());
    expect(token.startsWith('CLNZ1.')).toBe(true);
    const [, body, signature] = splitToken(token);
    expect(body.length).toBeGreaterThan(0);
    expect(signature.length).toBeGreaterThan(0);
  });

  it('carries only non-PII claims', () => {
    const [, body] = splitToken(buildToken('VISITOR', PASS, SOCIETY, future()));
    expect(Object.keys(decodeBody(body)).sort()).toEqual(['e', 'k', 'n', 'p', 's', 'v']);
  });

  it('never leaks a name, phone or flat number into the QR', () => {
    const token = buildToken('VISITOR', PASS, SOCIETY, future());
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    for (const secret of ['Ravi', '9876543210', 'A-1203', 'ravi@example.com']) {
      expect(token).not.toContain(secret);
      expect(decoded).not.toContain(secret);
    }
  });

  it('mints a unique token every time (nonce), so screenshots are not replayable identifiers', () => {
    const a = buildToken('VISITOR', PASS, SOCIETY, future());
    const b = buildToken('VISITOR', PASS, SOCIETY, future());
    expect(a).not.toBe(b);
  });
});

describe('parseToken', () => {
  it('round-trips the claims it was given', () => {
    const expires = future(600);
    const parsed = parseToken(buildToken('AMENITY_BOOKING', PASS, SOCIETY, expires));
    expect(parsed.version).toBe(1);
    expect(parsed.kind).toBe('AMENITY_BOOKING');
    expect(parsed.passId).toBe(PASS);
    expect(parsed.societyId).toBe(SOCIETY);
    // Expiry is stored in whole seconds.
    expect(parsed.expiresAt.getTime()).toBe(Math.floor(expires.getTime() / 1000) * 1000);
  });

  it('accepts a token whose CLNZ1 prefix was stripped by the scanner', () => {
    const [, body, signature] = splitToken(buildToken('VISITOR', PASS, SOCIETY, future()));
    const parsed = parseToken(`${body}.${signature}`);
    expect(parsed.passId).toBe(PASS);
  });

  it('tolerates surrounding whitespace and quotes from a scanned string', () => {
    const token = buildToken('VISITOR', PASS, SOCIETY, future());
    expect(parseToken(`  "${token}"  `).passId).toBe(PASS);
  });

  it('rejects an expired pass with QR_EXPIRED, not a generic error', () => {
    const token = buildToken('VISITOR', PASS, SOCIETY, new Date(Date.now() - 60_000));
    expect(() => parseToken(token)).toThrowError(/expired/i);
    try {
      parseToken(token);
      expect.unreachable('an expired token must throw');
    } catch (err) {
      expect(codeOf(err)).toBe('QR_EXPIRED');
    }
  });

  it('rejects a payload edited in place (signature no longer matches)', () => {
    const [, body, signature] = splitToken(buildToken('VISITOR', PASS, SOCIETY, future()));
    const payload = decodeBody(body);
    payload.p = 'pas_someoneElsesPass';
    const forged = `CLNZ1.${reencode(payload)}.${signature}`;
    try {
      parseToken(forged);
      expect.unreachable('a tampered token must throw');
    } catch (err) {
      expect(codeOf(err)).toBe('QR_INVALID');
    }
  });

  it('rejects a token re-pointed at another society', () => {
    const [, body, signature] = splitToken(buildToken('VISITOR', PASS, SOCIETY, future()));
    const payload = decodeBody(body);
    payload.s = 'soc_anotherSocietyEntirely';
    expect(() => parseToken(`CLNZ1.${reencode(payload)}.${signature}`)).toThrowError(/tampered/i);
  });

  it('rejects an extended expiry forged by the client', () => {
    const [, body, signature] = splitToken(buildToken('VISITOR', PASS, SOCIETY, future(60)));
    const payload = decodeBody(body);
    payload.e = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365;
    try {
      parseToken(`CLNZ1.${reencode(payload)}.${signature}`);
      expect.unreachable('a forged expiry must throw');
    } catch (err) {
      expect(codeOf(err)).toBe('QR_INVALID');
    }
  });

  it('rejects a token signed with a different key', () => {
    const [, body] = splitToken(buildToken('VISITOR', PASS, SOCIETY, future()));
    try {
      parseToken(`CLNZ1.${body}.${hmacSign(body, 'a-completely-different-key')}`);
      expect.unreachable('a foreign signature must throw');
    } catch (err) {
      expect(codeOf(err)).toBe('QR_INVALID');
    }
  });

  it.each([
    ['an empty string', ''],
    ['whitespace', '   '],
    ['a random QR from another app', 'https://example.com/menu'],
    ['a single-part string', 'CLNZ1.onlybody'],
    ['a four-part string', 'CLNZ1.a.b.c'],
    ['garbage after the prefix', 'CLNZ1.!!!not-base64!!!.sig'],
  ])('rejects %s with QR_INVALID', (_label, raw) => {
    try {
      parseToken(raw);
      expect.unreachable(`${raw} must be rejected`);
    } catch (err) {
      expect(codeOf(err)).toBe('QR_INVALID');
    }
  });

  it('rejects a null or undefined token without crashing', () => {
    expect(() => parseToken(null as unknown as string)).toThrow();
    expect(() => parseToken(undefined as unknown as string)).toThrow();
  });
});
