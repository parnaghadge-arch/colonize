import { describe, expect, it } from 'vitest';
import { parseBillingPeriod, periodBounds, scaleRecurringLines } from '../../src/modules/finance/billingService.js';

/**
 * Maintenance cycles. `YYYY-MM` must stay a single calendar month — older bills and the
 * acceptance suite depend on that. Longer cycles multiply recurring lines only.
 */
describe('billing periods', () => {
  it('keeps YYYY-MM as one calendar month', () => {
    const parsed = parseBillingPeriod('2026-09');
    expect(parsed.cycle).toBe('MONTHLY');
    expect(parsed.months).toBe(1);
    expect(periodBounds('2026-09').start.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(periodBounds('2026-09').end.toISOString()).toBe('2026-09-30T23:59:59.000Z');
  });

  it('parses quarterly, half-yearly and yearly periods', () => {
    const quarter = parseBillingPeriod('2026-Q2');
    expect(quarter).toMatchObject({ cycle: 'QUARTERLY', months: 3 });
    expect(quarter.start.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(quarter.end.toISOString()).toBe('2026-06-30T23:59:59.000Z');

    const firstHalf = periodBounds('2026-H1');
    expect(firstHalf.start.getUTCMonth()).toBe(0);
    expect(firstHalf.end.toISOString().startsWith('2026-06-30')).toBe(true);
    expect(parseBillingPeriod('2026-H2').months).toBe(6);
    expect(periodBounds('2026-H2').start.getUTCMonth()).toBe(6);

    const year = parseBillingPeriod('2026');
    expect(year.cycle).toBe('YEARLY');
    expect(year.months).toBe(12);
    expect(year.end.getUTCMonth()).toBe(11);
    expect(year.end.getUTCDate()).toBe(31);
  });

  it('rejects a period that is not a cycle key', () => {
    expect(() => periodBounds('2026-13')).toThrow(/period/i);
    expect(() => periodBounds('2026-Q5')).toThrow(/period/i);
    expect(() => periodBounds('September')).toThrow(/period/i);
  });

  it('multiplies recurring charges and leaves arrears untouched', () => {
    const lines = scaleRecurringLines(
      [
        { type: 'MAINTENANCE', label: 'Maintenance', amount: 100 },
        { type: 'ARREARS', label: 'Previous dues', amount: 40 },
      ],
      3,
    );
    expect(lines[0]).toMatchObject({ amount: 300, label: 'Maintenance × 3 months' });
    expect(lines[1]).toMatchObject({ amount: 40, label: 'Previous dues' });
    expect(scaleRecurringLines(lines, 1)[0].amount).toBe(300);
  });
});
