import { describe, expect, it } from 'vitest';
import { newId, randomToken, secureToken, idPrefix } from '../../src/db/ids.js';

/**
 * Identifier generation (§51).
 *
 * Ids are prefixed so a leaked id is self-describing and so a cross-collection mix-up fails
 * loudly instead of silently matching the wrong document. These tests lock that contract:
 * a regression here would let, say, a unit id resolve against the visitors collection.
 */
describe('newId', () => {
  it('prefixes ids with the collection they belong to', () => {
    expect(newId('societies')).toMatch(/^soc_/);
    expect(newId('units')).toMatch(/^unt_/);
    expect(newId('visitors')).toMatch(/^vis_/);
    expect(newId('visitor_passes')).toMatch(/^pas_/);
    expect(newId('users')).toMatch(/^usr_/);
    expect(newId('maintenance_bills')).toMatch(/^bil_/);
    expect(newId('complaints')).toMatch(/^cmp_/);
  });

  it('falls back to the first three letters for an unmapped collection', () => {
    // Still prefixed, so an unmapped collection can never collide with a mapped one's ids.
    expect(idPrefix('invoices')).toBe('inv');
    expect(newId('invoices')).toMatch(/^inv_/);
    expect(idPrefix('something_unmapped')).toBe('som');
  });

  it('uses the same prefix the registry declares', () => {
    for (const collection of ['societies', 'units', 'residents', 'gates', 'vehicles']) {
      expect(newId(collection).split('_')[0]).toBe(idPrefix(collection));
    }
  });

  it('produces unique ids across a large batch', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20_000; i += 1) seen.add(newId('units'));
    expect(seen.size).toBe(20_000);
  });

  it('never emits an id for an unknown collection without a prefix', () => {
    const id = newId('something_unmapped');
    expect(id).toContain('_');
    expect(id.length).toBeGreaterThan(4);
  });

  it('is URL-safe (no characters that need encoding)', () => {
    for (let i = 0; i < 200; i += 1) {
      const id = newId('visitors');
      expect(encodeURIComponent(id)).toBe(id);
    }
  });
});

describe('randomToken', () => {
  it('honours the requested length', () => {
    expect(randomToken(8)).toHaveLength(8);
    expect(randomToken()).toHaveLength(18);
    expect(randomToken(32)).toHaveLength(32);
  });

  it('uses only the unambiguous alphabet (no I, L, O, U)', () => {
    const token = randomToken(2000);
    expect(token).not.toMatch(/[ILOU]/);
    expect(token).toMatch(/^[0-9A-Za-z]+$/);
  });
});

describe('secureToken', () => {
  it('returns lowercase hex of the requested byte length', () => {
    expect(secureToken()).toMatch(/^[0-9a-f]{64}$/);
    expect(secureToken(16)).toMatch(/^[0-9a-f]{32}$/);
  });

  it('does not repeat', () => {
    expect(secureToken()).not.toBe(secureToken());
  });
});
