import {
  formatCurrency as sharedCurrency,
  formatIndianNumber,
  formatPercent,
  humaniseEnum,
  localDateString,
  localTime,
  maskEmail,
  maskPhone,
  normalisePhone,
} from '@colonize/shared';

/**
 * Display helpers. Money and date formatting come from the shared library so the console,
 * the mobile apps and the printed PDFs all agree on what a rupee amount looks like.
 */

export const money = (value: number | string | null | undefined, currency = 'INR'): string =>
  sharedCurrency(value, currency);

export const number = (value: number | null | undefined): string =>
  value === null || value === undefined || !Number.isFinite(Number(value)) ? '—' : formatIndianNumber(Number(value));

export const percent = (value: number | null | undefined): string =>
  value === null || value === undefined ? '—' : formatPercent(Number(value));

export const label = (value: unknown): string => (value ? humaniseEnum(String(value)) : '—');

/** "2026-03-15T18:30:00.000Z" → "15 Mar 2026" in the society's timezone. */
export function day(value: string | Date | null | undefined, timezone?: string): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    ...(timezone ? { timeZone: timezone } : {}),
  });
}

/** "2026-03-15T18:30:00.000Z" → "15 Mar 2026, 12:00 am". */
export function dateTime(value: string | Date | null | undefined, timezone?: string): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    ...(timezone ? { timeZone: timezone } : {}),
  });
}

export const clock = (value: string | Date | null | undefined, timezone?: string): string =>
  !value ? '—' : localTime(value instanceof Date ? value : new Date(value), timezone);

export const today = (timezone?: string): string => localDateString(new Date(), timezone);

/** Compact relative time for activity feeds. */
export function ago(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const then = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (Number.isNaN(then)) return '—';
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return day(value);
}

export const phone = (value: string | null | undefined): string => (value ? normalisePhone(value) : '—');
export const hiddenPhone = (value: unknown): string => (value ? maskPhone(value) : '—');
export const hiddenEmail = (value: unknown): string => (value ? maskEmail(value) : '—');

/** Initials for an avatar chip. */
export function initials(name: string | null | undefined): string {
  if (!name) return '?';
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
}
