import { describe, expect, it } from 'vitest';
import { composeUnitLabel, inferFloorNumber } from '../../src/modules/structure/structureService.js';

/**
 * Unit labels (§39).
 *
 * The label is what a resident, a guard and a printed bill all show instead of a bare flat
 * number — "A-1203, Wing A, Tower A — Alpha, Floor 12". A regression here once stored a
 * Promise (serialised to `{}`) in place of the string, blanking every unit label in the
 * platform, so the composition is tested directly.
 */
describe('composeUnitLabel', () => {
  it('builds the full label for a unit in a winged tower', () => {
    expect(
      composeUnitLabel({
        unitNumber: 'A-1203',
        wingCode: 'A',
        buildingName: 'Tower A — Alpha',
        buildingCode: 'A',
        floorNumber: 12,
      }),
    ).toBe('A-1203, Wing A, Tower A — Alpha, Floor 12');
  });

  it('omits the wing for a building that has none (villa rows, standalone towers)', () => {
    expect(
      composeUnitLabel({ unitNumber: 'V-12', wingCode: null, buildingName: 'Villa Row', floorNumber: 0 }),
    ).toBe('V-12, Villa Row, Floor 0');
  });

  it('falls back to the building code when the building has no name', () => {
    expect(composeUnitLabel({ unitNumber: 'A-101', buildingCode: 'A', floorNumber: 1 })).toBe(
      'A-101, A, Floor 1',
    );
  });

  it('omits the floor when it is unknown or negative (basements, plots)', () => {
    expect(composeUnitLabel({ unitNumber: 'P-7', buildingName: 'Podium', floorNumber: -1 })).toBe('P-7, Podium');
    expect(composeUnitLabel({ unitNumber: 'P-7', buildingName: 'Podium', floorNumber: null })).toBe('P-7, Podium');
  });

  it('always returns a non-empty string, never an object', () => {
    const label = composeUnitLabel({ unitNumber: 'A-101' });
    expect(typeof label).toBe('string');
    expect(label.length).toBeGreaterThan(0);
    expect(label).toBe('A-101');
  });

  it('trims a padded unit number', () => {
    expect(composeUnitLabel({ unitNumber: '  A-101  ' })).toBe('A-101');
  });

  it('is synchronous — it can never resolve to a Promise that serialises as {}', () => {
    const label = composeUnitLabel({ unitNumber: 'A-101', wingCode: 'A', buildingName: 'Tower A', floorNumber: 1 });
    expect(label).not.toBeInstanceOf(Promise);
    expect(JSON.stringify({ label })).toBe('{"label":"A-101, Wing A, Tower A, Floor 1"}');
  });
});

describe('inferFloorNumber', () => {
  it.each([
    ['A-1203', 12],
    ['B-302', 3],
    ['12', 12],
    ['E4904', 49],
  ])('infers floor %i from %j', (unitNumber, expected) => {
    expect(inferFloorNumber(unitNumber)).toBe(expected);
  });

  it('returns 0 when no floor can be inferred', () => {
    expect(inferFloorNumber('PENTHOUSE')).toBe(0);
    expect(inferFloorNumber('')).toBe(0);
  });
});
