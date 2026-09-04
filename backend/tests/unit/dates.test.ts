import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMinutes,
  addMonths,
  formatDuration,
  isBetween,
  isExpired,
  localDateString,
  localDayRange,
  localMonthRange,
  localTime,
  minutesBetween,
  timeAgo,
  DEFAULT_SOCIETY_TIMEZONE,
} from '@colonize/shared';

/**
 * Date handling in the society's own timezone (§43, §57).
 *
 * Every society declares a timezone (default Asia/Kolkata). "Today" for a bill period, an
 * amenity slot or a guard shift must be the society's today — not the server's, which may be
 * anywhere. These tests pin the boundary behaviour, which is where billing bugs live.
 */
describe('timezone defaults', () => {
  it('defaults to Asia/Kolkata', () => {
    expect(DEFAULT_SOCIETY_TIMEZONE).toBe('Asia/Kolkata');
  });
});

describe('localDateString', () => {
  it('rolls the date forward when the UTC instant is already tomorrow locally', () => {
    // 20:00Z is 01:30 the next day in Kolkata.
    expect(localDateString(new Date('2026-03-15T20:00:00Z'))).toBe('2026-03-16');
  });

  it('keeps the same date when the instant is within the local day', () => {
    expect(localDateString(new Date('2026-03-15T06:00:00Z'))).toBe('2026-03-15');
  });

  it('honours an explicit timezone', () => {
    const instant = new Date('2026-03-15T20:00:00Z');
    expect(localDateString(instant, 'UTC')).toBe('2026-03-15');
    expect(localDateString(instant, 'Asia/Kolkata')).toBe('2026-03-16');
    expect(localDateString(instant, 'America/New_York')).toBe('2026-03-15');
  });

  it('accepts a string or an epoch as well as a Date', () => {
    expect(localDateString('2026-03-15T20:00:00Z', 'UTC')).toBe('2026-03-15');
    expect(localDateString(Date.parse('2026-03-15T20:00:00Z'), 'UTC')).toBe('2026-03-15');
  });
});

describe('localDayRange', () => {
  it('spans exactly one local day, inclusive of its last millisecond', () => {
    const { start, end } = localDayRange('2026-03-15');
    // Midnight in Kolkata is 18:30Z the previous day.
    expect(start.toISOString()).toBe('2026-03-14T18:30:00.000Z');
    expect(end.toISOString()).toBe('2026-03-15T18:29:59.999Z');
    expect(end.getTime() - start.getTime()).toBe(86_400_000 - 1);
  });

  it('produces a range that contains every moment of that local day', () => {
    const { start, end } = localDayRange('2026-03-15');
    expect(isBetween(new Date('2026-03-15T05:00:00Z'), start, end)).toBe(true);
    expect(isBetween(new Date('2026-03-15T18:00:00Z'), start, end)).toBe(true);
    expect(isBetween(new Date('2026-03-15T19:00:00Z'), start, end)).toBe(false);
  });
});

describe('localMonthRange', () => {
  it('covers the whole local month and echoes the period label', () => {
    const range = localMonthRange('2026-03');
    expect(range.period).toBe('2026-03');
    expect(range.start.toISOString()).toBe('2026-02-28T18:30:00.000Z');
    expect(range.end.toISOString()).toBe('2026-03-31T18:29:59.999Z');
  });

  it('handles February in a leap year', () => {
    const range = localMonthRange('2028-02', 'UTC');
    expect(range.end.toISOString()).toBe('2028-02-29T23:59:59.999Z');
  });

  it('handles the 31-day boundary', () => {
    const range = localMonthRange('2026-01', 'UTC');
    expect(range.start.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(range.end.toISOString()).toBe('2026-01-31T23:59:59.999Z');
  });
});

describe('date arithmetic', () => {
  it('adds whole days', () => {
    expect(addDays('2026-03-15T00:00:00Z', 5).toISOString()).toBe('2026-03-20T00:00:00.000Z');
    expect(addDays('2026-03-15T00:00:00Z', -5).toISOString()).toBe('2026-03-10T00:00:00.000Z');
  });

  it('adds minutes across the hour boundary', () => {
    expect(addMinutes('2026-03-15T00:00:00Z', 90).toISOString()).toBe('2026-03-15T01:30:00.000Z');
  });

  it('clamps month overflow instead of spilling into the next month', () => {
    // 31 January + 1 month must be 28 February, never 3 March.
    expect(addMonths('2026-01-31T00:00:00Z', 1).toISOString()).toBe('2026-02-28T00:00:00.000Z');
    expect(addMonths('2026-01-31T00:00:00Z', 2).toISOString()).toBe('2026-03-31T00:00:00.000Z');
  });

  it('crosses a year boundary', () => {
    expect(addMonths('2026-12-15T00:00:00Z', 1).toISOString()).toBe('2027-01-15T00:00:00.000Z');
  });
});

describe('expiry and window checks', () => {
  it('treats a past instant as expired', () => {
    expect(isExpired(new Date(Date.now() - 1000))).toBe(true);
  });

  it('treats a future instant as not expired', () => {
    expect(isExpired(new Date(Date.now() + 100_000))).toBe(false);
  });

  it('treats a missing expiry as never expiring', () => {
    expect(isExpired(null)).toBe(false);
    expect(isExpired(undefined)).toBe(false);
  });

  it('isBetween is inclusive at both ends', () => {
    const from = new Date('2026-03-15T10:00:00Z');
    const to = new Date('2026-03-15T12:00:00Z');
    expect(isBetween(from, from, to)).toBe(true);
    expect(isBetween(to, from, to)).toBe(true);
    expect(isBetween(new Date('2026-03-15T11:00:00Z'), from, to)).toBe(true);
    expect(isBetween(new Date('2026-03-15T13:00:00Z'), from, to)).toBe(false);
  });
});

describe('formatting', () => {
  it('renders a local 24h time', () => {
    expect(localTime(new Date('2026-03-15T20:00:00Z'))).toBe('01:30');
  });

  it('measures whole minutes between two instants', () => {
    expect(minutesBetween('2026-03-15T00:00:00Z', '2026-03-15T01:30:00Z')).toBe(90);
    expect(minutesBetween('2026-03-15T01:30:00Z', '2026-03-15T00:00:00Z')).toBe(-90);
  });

  it('shortens a duration for a badge', () => {
    expect(formatDuration(90_000)).toBe('2m');
  });

  it('describes a recent moment in words', () => {
    expect(timeAgo(new Date(Date.now() - 60_000))).toBe('1m ago');
  });
});
