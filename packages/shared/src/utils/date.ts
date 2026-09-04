/**
 * Date/time helpers.
 *
 * The platform is operated in a single timezone per society (default Asia/Kolkata), but all
 * timestamps are stored as UTC `Date` values. "Day boundaries" for bills, attendance and
 * visitor reports are always computed in the *society* timezone — never the server's.
 */

export const DEFAULT_SOCIETY_TIMEZONE = 'Asia/Kolkata';

/** Offset in minutes for an IANA timezone at a given instant (handles DST correctly). */
export function timezoneOffsetMinutes(timeZone: string, at: Date = new Date()): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = dtf.formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUTC = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return Math.round((asUTC - Math.floor(at.getTime() / 1000) * 1000) / 60000);
}

/** The `YYYY-MM-DD` local date string for an instant in a timezone. */
export function localDateString(date: Date | string | number, timeZone = DEFAULT_SOCIETY_TIMEZONE): string {
  const d = toDate(date);
  const off = timezoneOffsetMinutes(timeZone, d);
  const shifted = new Date(d.getTime() + off * 60000);
  return shifted.toISOString().slice(0, 10);
}

/** Start (00:00:00.000 UTC-of-local) and end of a local day, as UTC instants. */
export function localDayRange(
  date: Date | string | number = new Date(),
  timeZone = DEFAULT_SOCIETY_TIMEZONE,
): { start: Date; end: Date } {
  const d = toDate(date);
  const off = timezoneOffsetMinutes(timeZone, d);
  const local = new Date(d.getTime() + off * 60000);
  const startLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 0, 0, 0, 0);
  const endLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 23, 59, 59, 999);
  return { start: new Date(startLocal - off * 60000), end: new Date(endLocal - off * 60000) };
}

/** First and last instant of a local month — the unit of maintenance billing. */
export function localMonthRange(
  date: Date | string | number = new Date(),
  timeZone = DEFAULT_SOCIETY_TIMEZONE,
): { start: Date; end: Date; period: string } {
  const d = toDate(date);
  const off = timezoneOffsetMinutes(timeZone, d);
  const local = new Date(d.getTime() + off * 60000);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const startLocal = Date.UTC(y, m, 1, 0, 0, 0, 0);
  const endLocal = Date.UTC(y, m + 1, 0, 23, 59, 59, 999);
  return {
    start: new Date(startLocal - off * 60000),
    end: new Date(endLocal - off * 60000),
    period: `${y}-${String(m + 1).padStart(2, '0')}`,
  };
}

export function toDate(value: Date | string | number): Date {
  return value instanceof Date ? value : new Date(value);
}

export function addDays(date: Date | string | number, days: number): Date {
  const d = toDate(date);
  return new Date(d.getTime() + days * 86400000);
}

export function addMinutes(date: Date | string | number, minutes: number): Date {
  const d = toDate(date);
  return new Date(d.getTime() + minutes * 60000);
}

export function addMonths(date: Date | string | number, months: number): Date {
  const d = toDate(date);
  const copy = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
  const day = copy.getUTCDate();
  copy.setUTCMonth(copy.getUTCMonth() + months);
  // Clamp overflow (31 Jan + 1 month -> 28/29 Feb).
  if (copy.getUTCDate() < day) copy.setUTCDate(0);
  return copy;
}

export function isExpired(date: Date | string | number | null | undefined): boolean {
  if (!date) return false;
  return toDate(date).getTime() <= Date.now();
}

export function isBetween(
  value: Date | string | number,
  start: Date | string | number,
  end: Date | string | number,
): boolean {
  const v = toDate(value).getTime();
  return v >= toDate(start).getTime() && v <= toDate(end).getTime();
}

/** Human friendly relative time, used by the mobile "recent activity" lists. */
export function timeAgo(date: Date | string | number, now: Date = new Date()): string {
  const diff = now.getTime() - toDate(date).getTime();
  const abs = Math.abs(diff);
  const future = diff < 0;
  const min = 60000;
  const hour = 60 * min;
  const day = 24 * hour;

  const fmt = (label: string) => (future ? `in ${label}` : `${label} ago`);
  if (abs < 45000) return future ? 'in a moment' : 'just now';
  if (abs < hour) return fmt(`${Math.round(abs / min)}m`);
  if (abs < day) return fmt(`${Math.round(abs / hour)}h`);
  if (abs < 30 * day) return fmt(`${Math.round(abs / day)}d`);
  if (abs < 365 * day) return fmt(`${Math.round(abs / (30 * day))}mo`);
  return fmt(`${Math.round(abs / (365 * day))}y`);
}

/** "09:15" in the society timezone — used for gate logs and attendance. */
export function localTime(date: Date | string | number, timeZone = DEFAULT_SOCIETY_TIMEZONE): string {
  const d = toDate(date);
  const off = timezoneOffsetMinutes(timeZone, d);
  return new Date(d.getTime() + off * 60000).toISOString().slice(11, 16);
}

/** "Mon, 12 Jan 2026, 09:15 AM" style display string without pulling in a date library. */
export function formatDateTime(
  date: Date | string | number,
  timeZone = DEFAULT_SOCIETY_TIMEZONE,
  opts: { withTime?: boolean } = {},
): string {
  const { withTime = true } = opts;
  const d = toDate(date);
  if (Number.isNaN(d.getTime())) return '—';
  const fmt = new Intl.DateTimeFormat('en-IN', {
    timeZone,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit', hour12: true } : {}),
  });
  return fmt.format(d);
}

export function formatDate(date: Date | string | number, timeZone = DEFAULT_SOCIETY_TIMEZONE): string {
  return formatDateTime(date, timeZone, { withTime: false });
}

/** Convert "HH:mm" (local) on a given local date into a UTC instant. */
export function localTimeToDate(
  localDate: string,
  hhmm: string,
  timeZone = DEFAULT_SOCIETY_TIMEZONE,
): Date {
  const [y, m, d] = localDate.split('-').map(Number) as [number, number, number];
  const [hh, mm] = hhmm.split(':').map(Number) as [number, number];
  const naive = Date.UTC(y, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0, 0, 0);
  const off = timezoneOffsetMinutes(timeZone, new Date(naive));
  return new Date(naive - off * 60000);
}

/** Minutes between two instants (rounded, can be negative). */
export function minutesBetween(a: Date | string | number, b: Date | string | number): number {
  return Math.round((toDate(b).getTime() - toDate(a).getTime()) / 60000);
}

/** "3h 25m" from a millisecond duration. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0m';
  const mins = Math.round(ms / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** Greeting used on the resident home screen ("Good Morning, Rajesh"). */
export function greetingFor(date: Date = new Date(), timeZone = DEFAULT_SOCIETY_TIMEZONE): string {
  const hour = Number(localTime(date, timeZone).slice(0, 2));
  if (hour < 5) return 'Good Night';
  if (hour < 12) return 'Good Morning';
  if (hour < 17) return 'Good Afternoon';
  if (hour < 21) return 'Good Evening';
  return 'Good Night';
}
