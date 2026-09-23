import { describe, expect, it } from 'vitest';
import {
  buildStructureSetup,
  emptyStructureDraft,
  formatSetupSummary,
  parseNumberList,
  planApartmentNumbers,
  withEachPlot,
  withPlotCount,
  withTowerCount,
} from '@colonize/shared';

describe('planApartmentNumbers', () => {
  it('numbers 4 per floor as 101, 102… then 201', () => {
    expect(planApartmentNumbers(6, 4).map((item) => item.unitNumber)).toEqual(['101', '102', '103', '104', '201', '202']);
    expect(planApartmentNumbers(6, 4).map((item) => item.floor)).toEqual([1, 1, 1, 1, 2, 2]);
  });

  it('puts a small tower on floor 1', () => {
    expect(planApartmentNumbers(2, 4).map((item) => item.unitNumber)).toEqual(['101', '102']);
  });
});

describe('parseNumberList', () => {
  it('accepts commas, spaces and ranges', () => {
    expect(parseNumberList('3, 7, 11-13').numbers).toEqual([3, 7, 11, 12, 13]);
    expect(parseNumberList('').numbers).toEqual([]);
  });

  it('rejects a word', () => {
    expect(parseNumberList('3, plot').error).toMatch(/plot number/);
  });
});

describe('buildStructureSetup', () => {
  it('asks only for towers on a building society, even if plot fields are filled', () => {
    const draft = withPlotCount(withTowerCount(emptyStructureDraft(), 2), 10);
    const built = buildStructureSetup({ ...draft, apartmentsEach: 4 }, 'BUILDING');
    expect(built.error).toBeNull();
    expect(built.payload?.towers).toEqual([
      { name: 'Tower 1', apartments: 4 },
      { name: 'Tower 2', apartments: 4 },
    ]);
    expect(built.payload?.plots).toEqual([]);
    expect(built.summary).toBe('This will add 2 towers (8 apartments).');
  });

  it('asks only for plots on a layout society', () => {
    const draft = { ...withPlotCount(emptyStructureDraft(), 3), towerCount: 2, defaultKind: 'HOUSE' as const };
    const built = buildStructureSetup(draft, 'PLOT');
    expect(built.payload?.towers).toEqual([]);
    expect(built.payload?.plots).toEqual([
      { number: 1, kind: 'HOUSE' },
      { number: 2, kind: 'HOUSE' },
      { number: 3, kind: 'HOUSE' },
    ]);
    expect(built.lines).toEqual(['Plots 1–3 — houses']);
  });

  it('lets each plot be a vacant plot, a house, or a tower with apartments', () => {
    const draft = withEachPlot(withPlotCount(emptyStructureDraft(), 3), true);
    draft.plots = [
      { kind: 'HOUSE', apartments: 4 },
      { kind: 'VACANT', apartments: 4 },
      { kind: 'TOWER', apartments: 2 },
    ];
    const built = buildStructureSetup(draft, 'PLOT');
    expect(built.error).toBeNull();
    expect(built.payload?.plots).toEqual([
      { number: 1, kind: 'HOUSE' },
      { number: 2, kind: 'VACANT' },
      { number: 3, kind: 'TOWER', apartments: 2 },
    ]);
    expect(built.summary).toBe('This will add 1 house, 1 vacant plot and 1 tower on a plot (2 apartments).');
  });

  it('refuses a tower plot with no apartments', () => {
    const draft = withEachPlot(withPlotCount(emptyStructureDraft(), 1), true);
    draft.plots = [{ kind: 'TOWER', apartments: 0 }];
    expect(buildStructureSetup(draft, 'PLOT').error).toMatch(/how many apartments/);
  });

  it('on a mixed society, a zero skips that side', () => {
    const draft = { ...withTowerCount(emptyStructureDraft(), 1), plotCount: 0, apartmentsEach: 6 };
    const built = buildStructureSetup(draft, 'MIXED');
    expect(built.error).toBeNull();
    expect(built.payload?.plots).toEqual([]);
    expect(built.payload?.towers).toHaveLength(1);
  });

  it('refuses an empty mixed form', () => {
    const draft = { ...emptyStructureDraft(), towerCount: 0, plotCount: 0 };
    expect(buildStructureSetup(draft, 'MIXED').error).toMatch(/at least one/);
  });

  it('expands exception lists when there are too many plots for a row each', () => {
    const draft = withEachPlot(withPlotCount({ ...emptyStructureDraft(), defaultKind: 'HOUSE' }, 50), true);
    draft.vacantNumbers = '2, 4-5';
    draft.towerPlots = [{ number: '9', apartments: '3' }];
    const built = buildStructureSetup(draft, 'PLOT');
    expect(built.error).toBeNull();
    expect(built.payload?.plots.filter((plot) => plot.kind === 'VACANT').map((plot) => plot.number)).toEqual([2, 4, 5]);
    expect(built.payload?.plots.find((plot) => plot.number === 9)).toEqual({ number: 9, kind: 'TOWER', apartments: 3 });
    expect(built.payload?.plots.filter((plot) => plot.kind === 'HOUSE')).toHaveLength(46);
  });

  it('rejects a plot listed twice in the exceptions', () => {
    const draft = withEachPlot(withPlotCount(emptyStructureDraft(), 50), true);
    draft.vacantNumbers = '4';
    draft.houseNumbers = '4';
    expect(buildStructureSetup(draft, 'PLOT').error).toMatch(/listed both/);
  });
});

describe('formatSetupSummary', () => {
  it('uses the past tense after a save', () => {
    expect(
      formatSetupSummary(
        { towers: 1, towerApartments: 4, houses: 0, vacantPlots: 0, plotTowers: 0, plotApartments: 0 },
        'past',
      ),
    ).toBe('Added 1 tower (4 apartments).');
  });
});
