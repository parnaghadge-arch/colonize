import { describe, expect, it } from 'vitest';
import { resolveActingClient } from '../../src/middleware/actingClient.js';

/**
 * A society admin who also lives in the society must be able to choose which hat they
 * are wearing. No header must keep the console working for existing clients.
 */
describe('resolveActingClient', () => {
  const dual = { hasResidentRole: true, hasSocietyRole: true, hasSecurityRole: false, unitCount: 1 };
  const resident = { hasResidentRole: true, hasSocietyRole: false, hasSecurityRole: false, unitCount: 1 };
  const guard = { hasResidentRole: false, hasSocietyRole: false, hasSecurityRole: true, unitCount: 0 };

  it('defaults a dual-role account to the console when no client header is sent', () => {
    expect(resolveActingClient(undefined, dual)).toBe('console');
    expect(resolveActingClient('', dual)).toBe('console');
  });

  it('keeps a resident-only login in resident scope with no header', () => {
    expect(resolveActingClient(undefined, resident)).toBe('resident');
  });

  it('switches a linked admin into resident mode only when the resident app asks', () => {
    expect(resolveActingClient('resident', dual)).toBe('resident');
    expect(resolveActingClient('console', dual)).toBe('console');
  });

  it('refuses resident mode for an admin who has not linked a flat', () => {
    expect(() => resolveActingClient('resident', { ...dual, unitCount: 0 })).toThrow(/flat/i);
  });

  it('does not let a resident-only account open the console', () => {
    expect(() => resolveActingClient('console', resident)).toThrow(/manage/i);
  });

  it('keeps a guard in the security app unless they ask for something else', () => {
    expect(resolveActingClient(undefined, guard)).toBe('security');
    expect(resolveActingClient('security', guard)).toBe('security');
  });
});
