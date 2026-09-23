/**
 * Guided structure setup — the questions a person actually has to answer.
 *
 * The physical model (buildings, floors, unit numbers) stays in the API. This module turns the
 * short form into that model so the society console and the onboarding wizard cannot drift:
 *
 *  • Building — how many towers, and how many apartments in each
 *  • Layout   — how many plots; each plot is a vacant plot, a house, or a tower
 *               (a tower then asks how many apartments)
 *  • Both     — the two questions above, and nothing else
 *
 * Apartment numbers are filled in (101, 102… with a fixed count per floor) so the form never
 * has to ask about floors, wings or numbering patterns.
 */

export const PLOT_KINDS = ['VACANT', 'HOUSE', 'TOWER'] as const;
export type PlotKind = (typeof PLOT_KINDS)[number];

export const PLOT_KIND_LABELS: Record<PlotKind, string> = {
  VACANT: 'Vacant plot',
  HOUSE: 'House',
  TOWER: 'Tower',
};

/** Above this, a row per plot is a wall of fields. The form switches to "list the exceptions". */
export const PER_PLOT_LIST_LIMIT = 40;

export const MAX_TOWERS = 100;
export const MAX_PLOTS = 2000;
export const MAX_APARTMENTS = 2000;
export const MAX_PLOT_APARTMENTS = 500;
export const MAX_PER_FLOOR = 20;

export interface TowerSetup {
  name: string;
  apartments: number;
}

export interface PlotSetup {
  number: number;
  kind: PlotKind;
  apartments?: number;
}

/** What `POST /structure/setup` and the onboarding STRUCTURE step accept. */
export interface StructureSetupPayload {
  towers: TowerSetup[];
  plots: PlotSetup[];
  apartmentsPerFloor: number;
}

export interface StructureDraft {
  towerCount: number;
  /** When true, every tower uses `apartmentsEach` and is named Tower 1, Tower 2, … */
  sameApartments: boolean;
  apartmentsEach: number;
  towers: TowerSetup[];
  plotCount: number;
  /** When true, plots are not all `defaultKind`. */
  eachPlot: boolean;
  defaultKind: PlotKind;
  defaultApartments: number;
  /** Index 0 is plot 1. Used when `eachPlot` and the count fits on one list. */
  plots: Array<{ kind: PlotKind; apartments: number }>;
  /** Used when `eachPlot` and there are too many plots for a row each. */
  vacantNumbers: string;
  houseNumbers: string;
  towerPlots: Array<{ number: string; apartments: string }>;
  apartmentsPerFloor: number;
}

export interface SetupCounts {
  towers: number;
  towerApartments: number;
  houses: number;
  vacantPlots: number;
  plotTowers: number;
  plotApartments: number;
}

export interface SetupPreview {
  error: string | null;
  payload: StructureSetupPayload | null;
  /** Short lines shown under the form so the person can check before saving. */
  lines: string[];
  counts: SetupCounts;
  summary: string;
}

export function emptyStructureDraft(): StructureDraft {
  return {
    towerCount: 1,
    sameApartments: true,
    apartmentsEach: 4,
    towers: [{ name: 'Tower 1', apartments: 4 }],
    plotCount: 1,
    eachPlot: false,
    defaultKind: 'HOUSE',
    defaultApartments: 4,
    plots: [{ kind: 'HOUSE', apartments: 4 }],
    vacantNumbers: '',
    houseNumbers: '',
    towerPlots: [{ number: '', apartments: '4' }],
    apartmentsPerFloor: 4,
  };
}

export function sectionsForLayout(layout: string | null | undefined): { towers: boolean; plots: boolean } {
  if (layout === 'PLOT') return { towers: false, plots: true };
  if (layout === 'MIXED') return { towers: true, plots: true };
  // BUILDING, and any society whose layout was never recorded.
  return { towers: true, plots: false };
}

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? Math.trunc(value) : fallback;
}

export function withTowerCount(draft: StructureDraft, count: number): StructureDraft {
  const n = Math.max(0, finite(count));
  const towers = draft.towers.slice(0, n);
  while (towers.length < n) {
    towers.push({ name: `Tower ${towers.length + 1}`, apartments: draft.apartmentsEach > 0 ? draft.apartmentsEach : 4 });
  }
  return { ...draft, towerCount: n, towers };
}

export function withApartmentsEach(draft: StructureDraft, apartments: number): StructureDraft {
  const n = finite(apartments, 0);
  return {
    ...draft,
    apartmentsEach: n,
    towers: draft.towers.map((tower) => ({ ...tower, apartments: n > 0 ? n : tower.apartments })),
  };
}

export function withPlotCount(draft: StructureDraft, count: number): StructureDraft {
  const n = Math.max(0, finite(count));
  const plots = draft.plots.slice(0, n);
  while (plots.length < n) {
    plots.push({ kind: draft.defaultKind, apartments: draft.defaultApartments > 0 ? draft.defaultApartments : 4 });
  }
  return { ...draft, plotCount: n, plots };
}

/** Turning this on copies the "all the same" choice onto every plot. Turning it off forgets the exceptions. */
export function withEachPlot(draft: StructureDraft, on: boolean): StructureDraft {
  if (!on) return { ...draft, eachPlot: false };
  const apartments = draft.defaultApartments > 0 ? draft.defaultApartments : 4;
  return {
    ...draft,
    eachPlot: true,
    plots: Array.from({ length: Math.max(0, finite(draft.plotCount)) }, () => ({
      kind: draft.defaultKind,
      apartments,
    })),
  };
}

export function withDefaultKind(draft: StructureDraft, kind: PlotKind): StructureDraft {
  return {
    ...draft,
    defaultKind: kind,
    plots: draft.eachPlot ? draft.plots : draft.plots.map((plot) => ({ ...plot, kind })),
  };
}

/** 101, 102, 103, 104, 201… — `perFloor` apartments, then the next floor. */
export function planApartmentNumbers(count: number, perFloor: number): Array<{ floor: number; unitNumber: string }> {
  const total = Math.max(0, finite(count));
  const per = Math.min(MAX_PER_FLOOR, Math.max(1, finite(perFloor, 4) || 4));
  const out: Array<{ floor: number; unitNumber: string }> = [];
  for (let i = 0; i < total; i += 1) {
    const floor = Math.floor(i / per) + 1;
    const pos = (i % per) + 1;
    out.push({ floor, unitNumber: String(floor * 100 + pos) });
  }
  return out;
}

export function apartmentRangeLabel(count: number, perFloor: number): string {
  const numbers = planApartmentNumbers(count, perFloor).map((item) => item.unitNumber);
  if (numbers.length === 0) return '';
  if (numbers.length <= 8) return numbers.join(', ');
  const first = numbers[0] ?? '';
  const last = numbers[numbers.length - 1] ?? '';
  return `${first} … ${last}`;
}

/** "3, 7, 11-14" → [3, 7, 11, 12, 13, 14]. Blank is an empty list, not an error. */
export function parseNumberList(raw: string): { numbers: number[]; error: string | null } {
  const text = raw.trim();
  if (!text) return { numbers: [], error: null };
  const numbers: number[] = [];
  for (const part of text.split(/[,;\s]+/).filter(Boolean)) {
    const range = /^(\d+)\s*[-–]\s*(\d+)$/.exec(part);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (!Number.isFinite(from) || !Number.isFinite(to) || from < 1 || to < from || to - from > MAX_PLOTS) {
        return { numbers: [], error: `"${part}" is not a plot range. Use something like 11-14.` };
      }
      for (let n = from; n <= to; n += 1) numbers.push(n);
      continue;
    }
    if (!/^\d+$/.test(part) || Number(part) < 1) {
      return { numbers: [], error: `"${part}" is not a plot number.` };
    }
    numbers.push(Number(part));
  }
  return { numbers, error: null };
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export function formatSetupSummary(counts: SetupCounts, tense: 'future' | 'past'): string {
  const parts: string[] = [];
  if (counts.towers > 0) {
    parts.push(`${plural(counts.towers, 'tower')} (${plural(counts.towerApartments, 'apartment')})`);
  }
  const plotBits: string[] = [];
  if (counts.houses > 0) plotBits.push(plural(counts.houses, 'house', 'houses'));
  if (counts.vacantPlots > 0) plotBits.push(plural(counts.vacantPlots, 'vacant plot'));
  if (counts.plotTowers > 0) {
    const where = counts.plotTowers === 1 ? 'on a plot' : 'on plots';
    plotBits.push(`${plural(counts.plotTowers, 'tower')} ${where} (${plural(counts.plotApartments, 'apartment')})`);
  }
  if (plotBits.length > 0) parts.push(joinList(plotBits));
  if (parts.length === 0) return tense === 'past' ? 'Nothing was added.' : 'Nothing to add yet.';
  const body = joinList(parts);
  return tense === 'past' ? `Added ${body}.` : `This will add ${body}.`;
}

function emptyCounts(): SetupCounts {
  return { towers: 0, towerApartments: 0, houses: 0, vacantPlots: 0, plotTowers: 0, plotApartments: 0 };
}

function plotLines(plots: PlotSetup[]): string[] {
  const lines: string[] = [];
  let index = 0;
  while (index < plots.length) {
    const plot = plots[index];
    if (!plot) break;
    if (plot.kind === 'TOWER') {
      const apartments = plot.apartments ?? 0;
      lines.push(`Plot ${plot.number} — tower, ${plural(apartments, 'apartment')}`);
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < plots.length) {
      const next = plots[end];
      const prev = plots[end - 1];
      if (!next || !prev || next.kind !== plot.kind || next.number !== prev.number + 1) break;
      end += 1;
    }
    const last = plots[end - 1];
    const word = plot.kind === 'HOUSE' ? (end - index === 1 ? 'house' : 'houses') : end - index === 1 ? 'vacant plot' : 'vacant plots';
    lines.push(last && last.number !== plot.number ? `Plots ${plot.number}–${last.number} — ${word}` : `Plot ${plot.number} — ${word}`);
    index = end;
  }
  return lines;
}

function countsOf(towers: TowerSetup[], plots: PlotSetup[]): SetupCounts {
  const counts = emptyCounts();
  counts.towers = towers.length;
  counts.towerApartments = towers.reduce((sum, tower) => sum + tower.apartments, 0);
  for (const plot of plots) {
    if (plot.kind === 'HOUSE') counts.houses += 1;
    else if (plot.kind === 'VACANT') counts.vacantPlots += 1;
    else {
      counts.plotTowers += 1;
      counts.plotApartments += plot.apartments ?? 0;
    }
  }
  return counts;
}

/**
 * Turn the form into the payload the API writes, or a single sentence explaining what to fix.
 * Layout decides which half of the form counts — a plot society never sends towers by accident.
 */
export function buildStructureSetup(draft: StructureDraft, layout: string | null | undefined): SetupPreview {
  const fail = (error: string): SetupPreview => ({
    error,
    payload: null,
    lines: [],
    counts: emptyCounts(),
    summary: error,
  });

  const sections = sectionsForLayout(layout);
  const perFloor = Math.min(MAX_PER_FLOOR, Math.max(1, finite(draft.apartmentsPerFloor, 4) || 4));

  if (sections.towers && draft.towerCount > MAX_TOWERS) {
    return fail(`Add at most ${MAX_TOWERS} towers at a time. You can add more afterwards.`);
  }
  if (sections.plots && draft.plotCount > MAX_PLOTS) {
    return fail(`Add at most ${MAX_PLOTS.toLocaleString('en-IN')} plots at a time. You can add more afterwards.`);
  }

  const towers: TowerSetup[] = [];
  if (sections.towers && draft.towerCount > 0) {
    const count = finite(draft.towerCount);
    const names = new Set<string>();
    for (let i = 0; i < count; i += 1) {
      const row = draft.towers[i];
      const name = (draft.sameApartments ? `Tower ${i + 1}` : row?.name.trim() || `Tower ${i + 1}`).trim();
      const apartments = draft.sameApartments ? finite(draft.apartmentsEach) : finite(row?.apartments ?? 0);
      if (!name) return fail(`Tower ${i + 1} needs a name.`);
      const key = name.toLowerCase();
      if (names.has(key)) return fail(`Two towers are both named "${name}". Give each tower its own name.`);
      names.add(key);
      if (apartments < 1) return fail(`${name} needs at least 1 apartment.`);
      if (apartments > MAX_APARTMENTS) return fail(`${name} has too many apartments (maximum ${MAX_APARTMENTS}).`);
      towers.push({ name, apartments });
    }
  }

  const plots: PlotSetup[] = [];
  if (sections.plots && draft.plotCount > 0) {
    const count = finite(draft.plotCount);
    const useRows = draft.eachPlot && count <= PER_PLOT_LIST_LIMIT;
    if (!draft.eachPlot || useRows) {
      for (let i = 0; i < count; i += 1) {
        const row = useRows ? draft.plots[i] : undefined;
        const kind = row?.kind ?? draft.defaultKind;
        const apartments = row?.apartments ?? draft.defaultApartments;
        if (kind === 'TOWER') {
          const n = finite(apartments);
          if (n < 1) return fail(`Plot ${i + 1} is a tower — say how many apartments it has.`);
          if (n > MAX_PLOT_APARTMENTS) return fail(`Plot ${i + 1} has too many apartments (maximum ${MAX_PLOT_APARTMENTS}).`);
          plots.push({ number: i + 1, kind, apartments: n });
        } else {
          plots.push({ number: i + 1, kind });
        }
      }
    } else {
      const kinds: PlotKind[] = Array.from({ length: count }, () => draft.defaultKind);
      const apartments = Array.from({ length: count }, () => finite(draft.defaultApartments, 4));
      const claimed = new Map<number, string>();
      const claim = (numbers: number[], source: string): string | null => {
        for (const n of numbers) {
          if (n < 1 || n > count) return `Plot ${n} is outside 1–${count}.`;
          const previous = claimed.get(n);
          if (previous && previous !== source) return `Plot ${n} is listed both as ${previous} and as ${source}.`;
          claimed.set(n, source);
        }
        return null;
      };

      const vacant = parseNumberList(draft.vacantNumbers);
      if (vacant.error) return fail(vacant.error);
      const houses = parseNumberList(draft.houseNumbers);
      if (houses.error) return fail(houses.error);
      const vacantError = claim(vacant.numbers, 'a vacant plot');
      if (vacantError) return fail(vacantError);
      const houseError = claim(houses.numbers, 'a house');
      if (houseError) return fail(houseError);

      const towerNumbers: number[] = [];
      for (const row of draft.towerPlots) {
        if (!row.number.trim()) continue;
        const parsed = parseNumberList(row.number);
        if (parsed.error) return fail(parsed.error);
        if (parsed.numbers.length !== 1) return fail('Enter one plot number per tower row.');
        const n = parsed.numbers[0] ?? 0;
        const apartmentsN = finite(Number(row.apartments));
        if (apartmentsN < 1) return fail(`Plot ${n} is a tower — say how many apartments it has.`);
        if (apartmentsN > MAX_PLOT_APARTMENTS) return fail(`Plot ${n} has too many apartments (maximum ${MAX_PLOT_APARTMENTS}).`);
        towerNumbers.push(n);
        const towerError = claim([n], 'a tower');
        if (towerError) return fail(towerError);
        kinds[n - 1] = 'TOWER';
        apartments[n - 1] = apartmentsN;
      }
      for (const n of vacant.numbers) kinds[n - 1] = 'VACANT';
      for (const n of houses.numbers) kinds[n - 1] = 'HOUSE';

      if (draft.defaultKind === 'TOWER') {
        const fallback = finite(draft.defaultApartments);
        if (fallback < 1) return fail('Say how many apartments are in each tower.');
        for (let i = 0; i < count; i += 1) {
          if (kinds[i] === 'TOWER' && !towerNumbers.includes(i + 1)) apartments[i] = fallback;
        }
      }

      for (let i = 0; i < count; i += 1) {
        const kind = kinds[i] ?? 'HOUSE';
        if (kind === 'TOWER') plots.push({ number: i + 1, kind, apartments: apartments[i] ?? 4 });
        else plots.push({ number: i + 1, kind });
      }
    }
  }

  if (towers.length === 0 && plots.length === 0) {
    if (sections.towers && sections.plots) {
      return fail('Add at least one tower or one plot. Leave the other at zero if you are not adding it today.');
    }
    return fail(sections.plots ? 'Say how many plots.' : 'Say how many towers.');
  }

  const counts = countsOf(towers, plots);
  const lines = [
    ...towers.map((tower) => `${tower.name} — ${plural(tower.apartments, 'apartment')}`),
    ...plotLines(plots),
  ];
  return {
    error: null,
    payload: { towers, plots, apartmentsPerFloor: perFloor },
    lines,
    counts,
    summary: formatSetupSummary(counts, 'future'),
  };
}
