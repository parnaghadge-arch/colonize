import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROLE_PERMISSIONS,
  DEFAULT_TIER_MODULES,
  MODULE_KEYS,
  PERMISSION_ACTIONS,
  PLAN_TIERS,
  ROLE_SCOPE,
  SENSITIVE_FIELDS,
  chunk,
  escapeRegex,
  expandPermissions,
  formatCurrency,
  formatIndianNumber,
  formatPercent,
  formatVehicleNumber,
  fromPaise,
  humaniseEnum,
  initials,
  maskEmail,
  maskPhone,
  normalisePhone,
  omitSensitive,
  parsePagination,
  round2,
  sequentialRef,
  toArray,
  toPaise,
  truncate,
} from '@colonize/shared';

/**
 * The shared domain library: money, phone numbers, permissions and plan tiers.
 *
 * These are the values every client and every server module agree on, so a silent change here
 * breaks four apps at once.
 */

describe('Indian money formatting', () => {
  // Regression guard: this used to emit Western grouping (1,234,567.50), which is wrong for
  // every society the platform serves and for the GST invoices it prints.
  it.each([
    [0, '0'],
    [999, '999'],
    [1000, '1,000'],
    [1234.5, '1,234.50'],
    [100000, '1,00,000'],
    [1234567.5, '12,34,567.50'],
    [12345678, '1,23,45,678'],
    [50000000, '5,00,00,000'],
    [1000000000, '1,00,00,00,000'],
  ])('groups %i as %s', (value, expected) => {
    expect(formatIndianNumber(value)).toBe(expected);
  });

  it('never produces a Western 3-3-3 grouping for a lakh or crore', () => {
    expect(formatIndianNumber(100000)).not.toBe('100,000');
    expect(formatIndianNumber(10000000)).not.toBe('10,000,000');
  });

  it('keeps the sign and two decimals', () => {
    expect(formatIndianNumber(-1500.5)).toBe('-1,500.50');
    expect(formatIndianNumber(1500)).toBe('1,500');
  });

  it('returns 0 for a non-finite value instead of printing NaN', () => {
    expect(formatIndianNumber(Number.NaN)).toBe('0');
    expect(formatIndianNumber(Number.POSITIVE_INFINITY)).toBe('0');
  });

  it('prefixes the rupee symbol', () => {
    expect(formatCurrency(1234.5)).toBe('₹1,234.50');
    expect(formatCurrency(100000)).toBe('₹1,00,000');
  });

  it('puts the minus sign before the symbol', () => {
    expect(formatCurrency(-500)).toBe('-₹500');
  });

  it('falls back to a currency code for non-INR', () => {
    expect(formatCurrency(1500, 'USD')).toBe('USD 1,500');
  });

  it('coerces null, undefined and junk to zero', () => {
    expect(formatCurrency(null)).toBe('₹0');
    expect(formatCurrency(undefined)).toBe('₹0');
    expect(formatCurrency('not-a-number')).toBe('₹0');
    expect(formatCurrency('1500')).toBe('₹1,500');
  });

  it('converts to and from paise without drifting', () => {
    expect(toPaise(12.34)).toBe(1234);
    expect(fromPaise(1234)).toBe(12.34);
    // 0.1 + 0.2 style drift must not survive the round trip.
    expect(fromPaise(toPaise(19.99))).toBe(19.99);
    expect(fromPaise(toPaise(0))).toBe(0);
    expect(toPaise(1500)).toBe(150000);
    // This is why money is stored in paise: 1.005 is not exactly representable in binary
    // floating point, so it rounds down. Callers must not rely on half-paisa precision.
    expect(toPaise(1.005)).toBe(100);
  });

  it('rounds to two decimals', () => {
    expect(round2(1.234)).toBe(1.23);
    expect(round2(1.236)).toBe(1.24);
    expect(round2(10)).toBe(10);
    expect(round2(-2.345)).toBe(-2.35);
  });
});

describe('phone numbers', () => {
  it.each([
    ['9876543210', '+919876543210'],
    ['+91 98765 43210', '+919876543210'],
    ['0091-9876543210', '+919876543210'],
    ['+919876543210', '+919876543210'],
  ])('normalises %j to %j', (input, expected) => {
    expect(normalisePhone(input)).toBe(expected);
  });

  it('means the same resident is matched however their number was typed', () => {
    const forms = ['9876543210', '+919876543210', '09876543210', '+91 98765-43210'];
    expect(new Set(forms.map((f) => normalisePhone(f))).size).toBe(1);
  });

  it('returns input it cannot confidently normalise rather than inventing a number', () => {
    expect(normalisePhone('123')).toBe('123');
    expect(normalisePhone(null)).toBe('');
    expect(normalisePhone(undefined)).toBe('');
  });

  it('masks the middle digits for list views', () => {
    expect(maskPhone('+919876543210')).toBe('+91•••••••210');
  });

  it('keeps the country code and the last three digits visible', () => {
    const masked = maskPhone('+919876543210');
    expect(masked.startsWith('+91')).toBe(true);
    expect(masked.endsWith('210')).toBe(true);
    expect(masked).not.toContain('9876543');
  });

  it('masks an email to its first characters plus the domain', () => {
    expect(maskEmail('ravi.kumar@example.com')).toBe('ra••••••@example.com');
  });

  it('masks junk contact values without throwing', () => {
    expect(() => maskPhone(null)).not.toThrow();
    expect(() => maskEmail(undefined)).not.toThrow();
  });
});

describe('reference numbers', () => {
  it('formats KIND-YEAR-ZERO-PADDED-SEQUENCE', () => {
    expect(sequentialRef('INV', 2026, 123)).toBe('INV-2026-000123');
  });

  it('honours a custom padding', () => {
    expect(sequentialRef('RCP', 2026, 7, 4)).toBe('RCP-2026-0007');
    expect(sequentialRef('RCP', 2026, 7, 2)).toBe('RCP-2026-07');
  });

  it('does not truncate a long sequence', () => {
    expect(sequentialRef('INV', 2026, 1234567)).toBe('INV-2026-1234567');
  });
});

describe('plan tiers and module entitlements (§41, §70)', () => {
  it('declares the five commercial tiers', () => {
    expect(PLAN_TIERS).toEqual(['FREE', 'BASIC', 'STANDARD', 'PREMIUM', 'ENTERPRISE']);
  });

  it('has 24 modules in total', () => {
    expect(MODULE_KEYS).toHaveLength(24);
    expect(new Set(MODULE_KEYS).size).toBe(24);
  });

  it('grants more modules as the tier rises', () => {
    const count = (tier: keyof typeof DEFAULT_TIER_MODULES) => DEFAULT_TIER_MODULES[tier].length;
    expect(count('FREE')).toBe(3);
    expect(count('BASIC')).toBe(6);
    expect(count('STANDARD')).toBe(17);
    expect(count('PREMIUM')).toBe(MODULE_KEYS.length);
    expect(count('ENTERPRISE')).toBe(MODULE_KEYS.length);
    expect(count('FREE')).toBeLessThan(count('BASIC'));
    expect(count('BASIC')).toBeLessThan(count('STANDARD'));
    expect(count('STANDARD')).toBeLessThan(count('PREMIUM'));
  });

  it('only ever grants modules that actually exist', () => {
    for (const tier of PLAN_TIERS) {
      for (const moduleKey of DEFAULT_TIER_MODULES[tier]) {
        expect(MODULE_KEYS).toContain(moduleKey);
      }
    }
  });

  it('keeps residents, visitors and notices free — the minimum a society needs to operate', () => {
    expect(DEFAULT_TIER_MODULES.FREE).toEqual(['residents', 'visitorManagement', 'notices']);
  });

  it('gates money and advanced features behind a paid tier', () => {
    expect(DEFAULT_TIER_MODULES.FREE).not.toContain('payments');
    expect(DEFAULT_TIER_MODULES.FREE).not.toContain('accounting');
    expect(DEFAULT_TIER_MODULES.FREE).not.toContain('advancedReports');
    expect(DEFAULT_TIER_MODULES.PREMIUM).toContain('payments');
    expect(DEFAULT_TIER_MODULES.PREMIUM).toContain('advancedReports');
  });

  it('grants no duplicate modules within a tier', () => {
    for (const tier of PLAN_TIERS) {
      const modules = DEFAULT_TIER_MODULES[tier];
      expect(new Set(modules).size).toBe(modules.length);
    }
  });
});

describe('permissions and roles (§20)', () => {
  it('expands a wildcard grant into every concrete action', () => {
    const expanded = expandPermissions(['unit:*']);
    expect(expanded.size).toBe(PERMISSION_ACTIONS.length);
    for (const action of PERMISSION_ACTIONS) expect(expanded.has(`unit:${action}`)).toBe(true);
  });

  it('passes an explicit grant through unchanged', () => {
    expect(expandPermissions(['visitor:approve'])).toEqual(new Set(['visitor:approve']));
  });

  it('ignores malformed grants instead of granting everything', () => {
    const expanded = expandPermissions(['', '*', ':view', 'noseparator']);
    expect(expanded.size).toBe(0);
  });

  it('de-duplicates overlapping grants', () => {
    expect(expandPermissions(['unit:*', 'unit:view', 'unit:view']).size).toBe(PERMISSION_ACTIONS.length);
  });

  it('declares a scope for every role the platform knows', () => {
    for (const role of ['SUPER_ADMIN', 'SOCIETY_ADMIN', 'OWNER', 'TENANT', 'FAMILY_MEMBER', 'SECURITY_GUARD']) {
      expect(Object.keys(ROLE_SCOPE)).toContain(role);
    }
  });

  it('scopes each role to the right level of the hierarchy', () => {
    expect(ROLE_SCOPE.SUPER_ADMIN).toBe('platform');
    expect(ROLE_SCOPE.SOCIETY_ADMIN).toBe('society');
    expect(ROLE_SCOPE.OWNER).toBe('resident');
    expect(ROLE_SCOPE.TENANT).toBe('resident');
    expect(ROLE_SCOPE.SECURITY_GUARD).toBe('security');
  });

  it('lets an owner see and use their unit but not destroy society structure', () => {
    const owner = expandPermissions(DEFAULT_ROLE_PERMISSIONS.OWNER);
    expect(owner.has('unit:view')).toBe(true);
    expect(owner.has('resident:view')).toBe(true);
    expect(owner.has('complaint:create')).toBe(true);
    expect(owner.has('payment:create')).toBe(true);
    expect(owner.has('unit:delete')).toBe(false);
    expect(owner.has('society:delete')).toBe(false);
  });

  it('lets a resident read their bills but not raise them', () => {
    const owner = expandPermissions(DEFAULT_ROLE_PERMISSIONS.OWNER);
    expect(owner.has('bill:view')).toBe(true);
    expect(owner.has('bill:create')).toBe(false);
  });

  it('lets a guard scan visitors but never touch money or society settings', () => {
    const guard = expandPermissions(DEFAULT_ROLE_PERMISSIONS.SECURITY_GUARD);
    expect(guard.has('visitor:scan')).toBe(true);
    expect(guard.has('visitor:view')).toBe(true);
    expect(guard.has('bill:create')).toBe(false);
    expect(guard.has('payment:refund')).toBe(false);
    expect(guard.has('society:update')).toBe(false);
  });

  it('gives every role a non-empty, finite permission set', () => {
    for (const [role, grants] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
      const expanded = expandPermissions(grants);
      expect(expanded.size, `${role} has no permissions`).toBeGreaterThan(0);
      for (const permission of expanded) {
        expect(permission, `${role} granted a malformed permission`).toMatch(/^[a-z]+:[a-z]+$/);
      }
    }
  });
});

describe('sensitive-field hygiene', () => {
  it('lists every credential-bearing field', () => {
    for (const field of ['passwordHash', 'password', 'otpHash', 'otp', 'refreshTokenHash', 'tokenHash', 'pinHash', 'secret', 'apiKey']) {
      expect(SENSITIVE_FIELDS).toContain(field);
    }
  });

  it('strips them from an object', () => {
    const out = omitSensitive({ name: 'Ravi', passwordHash: 'x', otp: '123456', phone: '+919876543210' });
    expect(out).not.toHaveProperty('passwordHash');
    expect(out).not.toHaveProperty('otp');
    expect(out).toHaveProperty('name');
  });

  it('does not mutate the input', () => {
    const input = { name: 'Ravi', passwordHash: 'x' };
    omitSensitive(input);
    expect(input).toHaveProperty('passwordHash');
  });
});

describe('display formatting', () => {
  it('humanises an enum for a label', () => {
    expect(humaniseEnum('PENDING_PAYMENT')).toBe('Pending Payment');
    expect(humaniseEnum('ACTIVE')).toBe('Active');
  });

  it('formats an Indian vehicle registration plate', () => {
    expect(formatVehicleNumber('mh31ab1234')).toBe('MH 31 AB 1234');
  });

  it('derives initials from a name', () => {
    expect(initials('Ravi Kumar')).toBe('RK');
  });

  it('formats a percentage with one decimal', () => {
    expect(formatPercent(12.345)).toBe('12.3%');
    expect(formatPercent(Number.NaN)).toBe('0%');
  });

  it('truncates long text for a table cell', () => {
    const long = 'a'.repeat(200);
    expect(truncate(long, 80).length).toBeLessThanOrEqual(80);
    expect(truncate('short', 80)).toBe('short');
  });
});

describe('pagination', () => {
  it('coerces string query parameters', () => {
    const result = parsePagination({ page: '3', limit: '50' });
    expect(result).toMatchObject({ page: 3, limit: 50, skip: 100 });
  });

  it('clamps the page size to the maximum', () => {
    const result = parsePagination({ page: '1', limit: '500' });
    expect(result.limit).toBe(200);
  });

  it('defaults to the first page, newest first', () => {
    const result = parsePagination({});
    expect(result).toMatchObject({ page: 1, limit: 20, skip: 0, sortBy: 'createdAt', sortDir: 'desc' });
  });

  it('never returns a negative skip', () => {
    expect(parsePagination({ page: '-5', limit: '-10' }).skip).toBeGreaterThanOrEqual(0);
    expect(parsePagination({ page: '-5', limit: '-10' }).page).toBeGreaterThanOrEqual(1);
  });
});

describe('collection helpers', () => {
  it('toArray normalises a scalar, a list and nothing', () => {
    expect(toArray(null)).toEqual([]);
    expect(toArray(undefined)).toEqual([]);
    expect(toArray('a')).toEqual(['a']);
    expect(toArray(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('chunk splits without losing or duplicating items', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
    const flat = chunk(Array.from({ length: 100 }, (_, i) => i), 7).flat();
    expect(flat).toHaveLength(100);
  });

  it('escapeRegex neutralises user input destined for a regex query', () => {
    expect(escapeRegex('a.b*c')).toBe('a\\.b\\*c');
    // A resident searching for ".*" must not match every record in the society.
    expect(new RegExp(escapeRegex('.*')).test('anything')).toBe(false);
    expect(new RegExp(escapeRegex('.*')).test('.*')).toBe(true);
  });
});
