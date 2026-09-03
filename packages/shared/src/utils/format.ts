/**
 * Pure formatting helpers. These are used by the API (before persisting) and by every
 * client (before rendering) so a resident's name looks identical everywhere.
 */

/** Words that stay lowercase inside a personal name unless they are the first word. */
const NAME_PARTICLES = new Set([
  'de',
  'del',
  'della',
  'di',
  'da',
  'dos',
  'du',
  'la',
  'le',
  'van',
  'von',
  'der',
  'den',
  'ten',
  'ter',
  'bin',
  'ibn',
  'al',
  'el',
  'and',
  'the',
]);

/** Prefixes that are kept in upper case (military / academic / honorific titles). */
const NAME_PREFIXES = new Set(['dr', 'mr', 'mrs', 'ms', 'prof', 'sr', 'jr', 'capt', 'maj', 'col']);

function titleCaseWord(word: string): string {
  if (!word) return word;
  // Preserve existing all-caps tokens such as "NASA" or roman numerals "III".
  if (word.length > 1 && word === word.toUpperCase() && /[A-Z]/.test(word)) return word;

  // Hyphenated names: capitalise each segment (e.g. "anne-marie" -> "Anne-Marie").
  if (word.includes('-')) {
    return word
      .split('-')
      .map((part) => titleCaseWord(part))
      .join('-');
  }

  // Names with an apostrophe: "o'brien" -> "O'Brien", "d'souza" -> "D'Souza".
  if (word.includes("'")) {
    const [head, ...rest] = word.split("'");
    const tail = rest.join("'");
    return `${cap(head)}'${cap(tail)}`;
  }

  // Indian/McDonald style prefixes.
  const mcMatch = word.match(/^mc(.+)$/i);
  if (mcMatch && mcMatch[1]) return `Mc${cap(mcMatch[1])}`;
  const macMatch = word.match(/^mac(.{3,})$/i);
  if (macMatch && macMatch[1]) return `Mac${cap(macMatch[1])}`;

  return cap(word);
}

function cap(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/**
 * Format a person's name with the first letter of each word capitalised (§8).
 *
 *   "rajesh   kumar gupta" -> "Rajesh Kumar Gupta"
 *   "anne-marie o'brien"   -> "Anne-Marie O'Brien"
 *   "DR. priya DE silva"   -> "Dr. Priya de Silva"
 *
 * Also collapses repeated whitespace and strips control characters.
 */
export function formatPersonName(input: unknown): string {
  if (input === null || input === undefined) return '';
  const raw = String(input)
    // Remove zero-width / control characters that break rendering & search.
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[^\p{L}\p{N}\s.'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return '';

  const words = raw.split(' ');
  return words
    .map((word, index) => {
      const bare = word.replace(/\./g, '').toLowerCase();
      // First and last words are always capitalised, particles in the middle are not.
      const isEdge = index === 0 || index === words.length - 1;
      if (!isEdge && NAME_PARTICLES.has(bare)) return word.toLowerCase();
      if (NAME_PREFIXES.has(bare)) {
        // Keep the trailing dot if the user typed one ("dr." -> "Dr.").
        return word.endsWith('.') ? `${cap(bare)}.` : cap(bare);
      }
      return titleCaseWord(word);
    })
    .join(' ');
}

/** Title-case any human readable label (used for addresses, business names, places). */
export function formatTitle(input: unknown): string {
  if (input === null || input === undefined) return '';
  const raw = String(input).replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  return raw
    .split(' ')
    .map((w) => titleCaseWord(w))
    .join(' ');
}

/** "PLUMBING" -> "Plumbing", "COMMON_AREA" -> "Common Area". */
export function humaniseEnum(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
    .map((w) => cap(w))
    .join(' ');
}

/** Indian vehicle plate normalisation: "mh31ab1234" -> "MH 31 AB 1234". */
export function formatVehicleNumber(input: unknown): string {
  if (input === null || input === undefined) return '';
  const raw = String(input)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (!raw) return '';
  const m = raw.match(/^([A-Z]{1,3})(\d{1,4})([A-Z]{0,3})(\d{1,4})$/);
  if (m) return [m[1], m[2], m[3], m[4]].filter(Boolean).join(' ').trim();
  // Fall back to grouped chunks so unusual plates still render consistently.
  return raw.replace(/([A-Z]+)(\d+)([A-Z]+)(\d+)/, '$1 $2 $3 $4');
}

/** +91 / 0 / bare 10-digit handling. Returns E.164 or the original digits if not Indian. */
export function normalisePhone(input: unknown, defaultCountryCode = '91'): string {
  if (input === null || input === undefined) return '';
  let raw = String(input).replace(/[^\d+]/g, '');
  if (raw.startsWith('+')) return raw;
  raw = raw.replace(/^0+/, '');
  if (raw.startsWith('00')) raw = raw.slice(2);
  if (raw.length === 10) return `+${defaultCountryCode}${raw}`;
  if (raw.length === 11 && raw.startsWith(defaultCountryCode)) return `+${raw}`;
  if (raw.length === 12 && raw.startsWith(defaultCountryCode)) return `+${raw}`;
  return raw;
}

/** Mask a phone number for display in shared screens ("+91 98••• •0210"). */
export function maskPhone(input: unknown): string {
  const p = normalisePhone(input);
  if (p.length < 6) return p;
  const head = p.slice(0, 3);
  const tail = p.slice(-3);
  return `${head}${'•'.repeat(Math.max(2, p.length - 6))}${tail}`;
}

/** Mask an email for display ("ra••••@example.com"). */
export function maskEmail(input: unknown): string {
  const e = String(input ?? '');
  const [local, domain] = e.split('@');
  if (!local || !domain) return e;
  if (local.length <= 2) return `${local[0]}•@${domain}`;
  return `${local.slice(0, 2)}${'•'.repeat(Math.min(6, local.length - 2))}@${domain}`;
}

const INR_DIGITS = /\B(?=(\d{3})+(?!\d))/g;

/** 1234567.5 -> "12,34,567.50" (Indian digit grouping). */
export function formatIndianNumber(value: number): string {
  const negative = value < 0;
  const n = Math.abs(value);
  const fixed = Number.isInteger(n) ? String(n) : n.toFixed(2);
  const [intPart, decPart] = fixed.split('.');
  if (!intPart) return fixed;
  let last3 = intPart.slice(-3);
  let other = intPart.slice(0, -3);
  if (other) last3 = `,${last3}`;
  other = other.replace(INR_DIGITS, '$&,');
  return `${negative ? '-' : ''}${other}${last3}${decPart ? `.${decPart}` : ''}`;
}

/** 1234567.5 -> "₹12,34,567.50" */
export function formatCurrency(value: number | string | null | undefined, currency = 'INR'): string {
  const n = typeof value === 'number' ? value : Number(value ?? 0);
  const safe = Number.isFinite(n) ? n : 0;
  const symbol = currency === 'INR' ? '₹' : `${currency} `;
  return `${safe < 0 ? '-' : ''}${symbol}${formatIndianNumber(Math.abs(safe))}`;
}

/** Store money as integer paise to avoid floating point drift; helpers to convert. */
export const toPaise = (rupees: number): number => Math.round(rupees * 100);
export const fromPaise = (paise: number): number => Math.round(paise) / 100;

/** Percentage with at most 1 decimal, no trailing ".0". */
export function formatPercent(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '0%';
  const rounded = Number(value.toFixed(digits));
  return `${rounded}%`;
}

/** Bytes -> human readable. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${value.toFixed(value >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Truncate with ellipsis for table cells. */
export function truncate(text: unknown, max = 80): string {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Stable initials for avatars ("Rajesh Kumar Gupta" -> "RG"). */
export function initials(name: unknown): string {
  const parts = String(name ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return (parts[0] as string).slice(0, 2).toUpperCase();
  return `${(parts[0] as string)[0]}${(parts[parts.length - 1] as string)[0]}`.toUpperCase();
}
