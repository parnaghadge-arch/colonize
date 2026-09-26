import { ApiError } from '../utils/errors.js';

/**
 * Which client a dual-role account is using right now.
 *
 * A society admin who also lives in the society holds both a management role and a resident
 * role. The active client comes from `x-client`, not from the role list alone — otherwise
 * every admin request would look like a resident request and the console would lock itself
 * out. With no header, a management role wins so the existing admin web and acceptance
 * tests keep working. The resident app sends `x-client: resident`; the security app sends
 * `x-client: security`.
 */
export type ActingClient = 'resident' | 'console' | 'security' | 'other';

export function resolveActingClient(
  header: string | undefined,
  info: {
    hasResidentRole: boolean;
    hasSocietyRole: boolean;
    hasSecurityRole: boolean;
    unitCount: number;
  },
): ActingClient {
  const raw = String(header ?? '').trim().toLowerCase();

  if (raw === 'resident') {
    if (!info.hasResidentRole) {
      throw ApiError.forbidden('Link a flat to this account before acting as a resident.');
    }
    // A pure resident with no flat can still open the app and see an empty home.
    // A manager switching into resident mode must already be linked, or the switch is a no-op
    // that would hide the console without giving them a household.
    if (info.hasSocietyRole && info.unitCount < 1) {
      throw ApiError.forbidden('Link a flat to this account before acting as a resident.');
    }
    return 'resident';
  }

  if (raw === 'console') {
    if (!info.hasSocietyRole) throw ApiError.forbidden('This account cannot manage the society.');
    return 'console';
  }

  if (raw === 'security') {
    if (!info.hasSecurityRole) throw ApiError.forbidden('This account cannot use the security app.');
    return 'security';
  }

  if (info.hasSocietyRole) return 'console';
  if (info.hasResidentRole) return 'resident';
  if (info.hasSecurityRole) return 'security';
  return 'other';
}
