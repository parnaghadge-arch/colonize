import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  PER_PLOT_LIST_LIMIT,
  SOCIETY_LAYOUT_LABELS,
  buildStructureSetup,
  emptyStructureDraft,
  sectionsForLayout,
  withApartmentsEach,
  withEachPlot,
  withPlotCount,
  withTowerCount,
  type PlotKind,
  type StructureDraft,
  type StructureSetupPayload,
} from '@colonize/shared';
import { Alert, Button, ErrorAlert, Field, Input, Select } from './ui.tsx';

/**
 * The only questions a person has to answer to add units.
 *
 * Building → how many towers, then how many apartments in each tower.
 * Layout   → how many plots, then what is on each (vacant plot / house / tower).
 *            A tower asks how many apartments. Nothing else.
 * Both     → those two, one under the other. A count of 0 skips that side.
 *
 * Floors and apartment numbers are filled in. The optional numbering control stays closed.
 */

const PLOT_KIND_OPTIONS: Array<{ id: PlotKind; label: string }> = [
  { id: 'VACANT', label: 'Vacant plot' },
  { id: 'HOUSE', label: 'House' },
  { id: 'TOWER', label: 'Tower' },
];

function initialDraft(layout: string | null | undefined): StructureDraft {
  const sections = sectionsForLayout(layout);
  const both = sections.towers && sections.plots;
  let draft: StructureDraft = { ...emptyStructureDraft(), sameApartments: false, eachPlot: true };
  draft = withTowerCount(draft, sections.towers && !both ? 1 : 0);
  draft = withPlotCount(draft, sections.plots && !both ? 1 : 0);
  return withEachPlot({ ...draft, sameApartments: false }, true);
}

function Question({ n, title, hint, children }: { n: number; title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="q-block">
      <span className="q-num" aria-hidden>
        {n}
      </span>
      <div className="stack" style={{ gap: 8 }}>
        <div>
          <div className="q-title">{title}</div>
          {hint ? <p className="small muted" style={{ margin: '2px 0 0' }}>{hint}</p> : null}
        </div>
        {children}
      </div>
    </div>
  );
}

export function StructureSetupForm({
  layout,
  busy,
  error,
  submitLabel,
  dryRun,
  onDryRunChange,
  resetOnSuccess = true,
  onSubmit,
}: {
  layout: string | null | undefined;
  busy: boolean;
  error: unknown;
  submitLabel?: string;
  dryRun?: boolean;
  onDryRunChange?: (value: boolean) => void;
  resetOnSuccess?: boolean;
  onSubmit: (payload: StructureSetupPayload) => Promise<void> | void;
}) {
  const [draft, setDraft] = useState<StructureDraft>(() => initialDraft(layout));
  const sections = sectionsForLayout(layout);
  const preview = useMemo(() => buildStructureSetup(draft, layout), [draft, layout]);
  const layoutName =
    layout === 'BUILDING' || layout === 'PLOT' || layout === 'MIXED' ? SOCIETY_LAYOUT_LABELS[layout] : null;
  const showPlotList = sections.plots && draft.plotCount > 0 && draft.plotCount <= PER_PLOT_LIST_LIMIT;
  const showPlotGroups = sections.plots && draft.plotCount > PER_PLOT_LIST_LIMIT;

  useEffect(() => {
    setDraft(initialDraft(layout));
  }, [layout]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!preview.payload || busy) return;
    try {
      await onSubmit(preview.payload);
      if (resetOnSuccess) setDraft(initialDraft(layout));
    } catch {
      // The parent shows the error. Leaving the draft in place lets them correct it.
    }
  }

  function setAllPlots(kind: PlotKind) {
    setDraft((prev) => ({
      ...prev,
      eachPlot: true,
      defaultKind: kind,
      plots: prev.plots.map((plot) => ({
        ...plot,
        kind,
        apartments: prev.defaultApartments > 0 ? prev.defaultApartments : 4,
      })),
    }));
  }

  let step = 0;
  const nextStep = () => {
    step += 1;
    return step;
  };
  const guidance = Boolean(preview.error && /how many|at least one/i.test(preview.error));

  return (
    <form onSubmit={submit} className="stack" style={{ gap: 16 }}>
      {error ? <ErrorAlert error={error} /> : null}

      <p className="small muted" style={{ margin: 0 }}>
        {layoutName ? (
          <>
            This society is <b>{layoutName}</b>, chosen at onboarding.{' '}
          </>
        ) : (
          <>This society's layout was not set at onboarding, so the tower questions are shown. </>
        )}
        {sections.towers && sections.plots
          ? 'Fill in the towers, the plots, or both. Leave a count at 0 to skip that side.'
          : sections.plots
            ? 'Say how many plots, then what stands on each one.'
            : 'Say how many towers, and how many apartments each one has.'}
      </p>

      {sections.towers ? (
        <section className="stack" style={{ gap: 12 }}>
          {sections.plots ? <h3 style={{ margin: 0 }}>Towers</h3> : null}
          <Question
            n={nextStep()}
            title="How many towers?"
            hint={sections.plots ? 'Use 0 if you are not adding towers today. Named Tower 1, Tower 2, …' : 'Named Tower 1, Tower 2, … You can rename a tower later.'}
          >
            <Input
              type="number"
              min={0}
              max={100}
              inputMode="numeric"
              value={String(draft.towerCount)}
              onChange={(e) => setDraft((prev) => ({ ...withTowerCount(prev, Number(e.target.value)), sameApartments: false }))}
              style={{ maxWidth: 140 }}
            />
          </Question>

          {draft.towerCount > 0 ? (
            <Question n={nextStep()} title="How many apartments in each tower?" hint="Change one row if a tower is different. Numbers like 101, 102 are filled in.">
              {draft.towerCount > 1 ? (
                <div className="row row--wrap" style={{ gap: 8, alignItems: 'center' }}>
                  <Input
                    type="number"
                    min={1}
                    max={2000}
                    aria-label="Apartments to apply to every tower"
                    value={String(draft.apartmentsEach)}
                    onChange={(e) => setDraft((prev) => ({ ...prev, apartmentsEach: Number(e.target.value) }))}
                    style={{ maxWidth: 100 }}
                  />
                  <Button
                    type="button"
                    size="sm"
                    disabled={draft.apartmentsEach < 1}
                    onClick={() =>
                      setDraft((prev) => ({ ...withApartmentsEach(prev, prev.apartmentsEach), sameApartments: false }))
                    }
                  >
                    Same number in every tower
                  </Button>
                </div>
              ) : null}
              <div className={draft.towerCount > 8 ? 'setup-list setup-list--scroll' : 'setup-list'}>
                <div className="setup-row setup-row--tower setup-head">
                  <span>Tower</span>
                  <span>Apartments</span>
                </div>
                {draft.towers.slice(0, draft.towerCount).map((tower, index) => (
                  <div key={index} className="setup-row setup-row--tower">
                    <span className="small">Tower {index + 1}</span>
                    <Input
                      type="number"
                      min={1}
                      max={2000}
                      inputMode="numeric"
                      aria-label={`Apartments in tower ${index + 1}`}
                      value={String(tower.apartments)}
                      onChange={(e) =>
                        setDraft((prev) => ({
                          ...prev,
                          sameApartments: false,
                          towers: prev.towers.map((row, i) =>
                            i === index ? { ...row, apartments: Number(e.target.value) } : row,
                          ),
                        }))
                      }
                    />
                  </div>
                ))}
              </div>
            </Question>
          ) : null}
        </section>
      ) : null}

      {sections.plots ? (
        <section className="stack" style={{ gap: 12 }}>
          {sections.towers ? <h3 style={{ margin: 0 }}>Plots</h3> : null}
          <Question
            n={nextStep()}
            title="How many plots?"
            hint={sections.towers ? 'Use 0 if you are not adding plots today. Numbered Plot 1, Plot 2, …' : 'Numbered Plot 1, Plot 2, …'}
          >
            <Input
              type="number"
              min={0}
              max={2000}
              inputMode="numeric"
              value={String(draft.plotCount)}
              onChange={(e) =>
                setDraft((prev) => {
                  const next = withPlotCount(prev, Number(e.target.value));
                  return { ...next, eachPlot: true };
                })
              }
              style={{ maxWidth: 140 }}
            />
          </Question>

          {showPlotList ? (
            <Question n={nextStep()} title="What is on each plot?" hint="A tower asks how many apartments. A house or a vacant plot does not.">
              {draft.plotCount > 1 ? (
                <div className="row row--wrap" style={{ gap: 6, alignItems: 'center' }}>
                  <span className="small muted">Set every plot to</span>
                  {PLOT_KIND_OPTIONS.map((option) => (
                    <Button key={option.id} type="button" size="sm" variant="ghost" onClick={() => setAllPlots(option.id)}>
                      {option.label}
                    </Button>
                  ))}
                </div>
              ) : null}
              <div className={draft.plotCount > 8 ? 'setup-list setup-list--scroll' : 'setup-list'}>
                <div className="setup-row setup-row--plot setup-head">
                  <span>Plot</span>
                  <span>On this plot</span>
                  <span>Apartments</span>
                </div>
                {draft.plots.slice(0, draft.plotCount).map((plot, index) => (
                  <div key={index} className="setup-row setup-row--plot">
                    <span className="small">Plot {index + 1}</span>
                    <div className="kind-picks" role="radiogroup" aria-label={`What is on plot ${index + 1}`}>
                      {PLOT_KIND_OPTIONS.map((option) => {
                        const selected = plot.kind === option.id;
                        return (
                          <button
                            key={option.id}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            className={selected ? 'kind-pick kind-pick--on' : 'kind-pick'}
                            onClick={() =>
                              setDraft((prev) => ({
                                ...prev,
                                eachPlot: true,
                                plots: prev.plots.map((row, i) =>
                                  i === index
                                    ? {
                                        ...row,
                                        kind: option.id,
                                        apartments: row.apartments > 0 ? row.apartments : prev.defaultApartments || 4,
                                      }
                                    : row,
                                ),
                              }))
                            }
                          >
                            {option.label}
                          </button>
                        );
                      })}
                    </div>
                    {plot.kind === 'TOWER' ? (
                      <Input
                        type="number"
                        min={1}
                        max={500}
                        inputMode="numeric"
                        aria-label={`Apartments in the tower on plot ${index + 1}`}
                        value={String(plot.apartments)}
                        onChange={(e) =>
                          setDraft((prev) => ({
                            ...prev,
                            plots: prev.plots.map((row, i) =>
                              i === index ? { ...row, apartments: Number(e.target.value) } : row,
                            ),
                          }))
                        }
                      />
                    ) : (
                      <span className="small muted">—</span>
                    )}
                  </div>
                ))}
              </div>
            </Question>
          ) : null}

          {showPlotGroups ? (
            <Question
              n={nextStep()}
              title="What is on the plots?"
              hint={`${draft.plotCount} plots is too many to tap one by one. Pick what most plots are, then write only the plot numbers that are different. Use commas or a range, like 3, 7, 11-14.`}
            >
              <Field label="Most plots are">
                <Select
                  value={draft.defaultKind}
                  onChange={(e) => setDraft((prev) => ({ ...prev, eachPlot: true, defaultKind: e.target.value as PlotKind }))}
                >
                  {PLOT_KIND_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </Field>
              {draft.defaultKind === 'TOWER' ? (
                <Field label="Apartments in each of those towers">
                  <Input
                    type="number"
                    min={1}
                    max={500}
                    value={String(draft.defaultApartments)}
                    onChange={(e) => setDraft((prev) => ({ ...prev, defaultApartments: Number(e.target.value) }))}
                    style={{ maxWidth: 140 }}
                  />
                </Field>
              ) : null}
              {draft.defaultKind !== 'VACANT' ? (
                <Field label="Plot numbers that are vacant" hint="Leave blank if none">
                  <Input
                    value={draft.vacantNumbers}
                    placeholder="3, 7, 11-14"
                    onChange={(e) => setDraft((prev) => ({ ...prev, vacantNumbers: e.target.value }))}
                  />
                </Field>
              ) : null}
              {draft.defaultKind !== 'HOUSE' ? (
                <Field label="Plot numbers that are houses" hint="Leave blank if none">
                  <Input
                    value={draft.houseNumbers}
                    placeholder="1-20, 24"
                    onChange={(e) => setDraft((prev) => ({ ...prev, houseNumbers: e.target.value }))}
                  />
                </Field>
              ) : null}
              <Field
                label={draft.defaultKind === 'TOWER' ? 'Towers with a different apartment count' : 'Plots that are towers'}
                hint="One plot number, and how many apartments that tower has. Leave the number blank to skip a row."
              >
                <div className="stack" style={{ gap: 6 }}>
                  {draft.towerPlots.map((row, index) => (
                    <div key={index} className="form-row">
                      <Input
                        inputMode="numeric"
                        placeholder="Plot number"
                        aria-label={`Plot number for tower ${index + 1}`}
                        value={row.number}
                        onChange={(e) =>
                          setDraft((prev) => ({
                            ...prev,
                            towerPlots: prev.towerPlots.map((item, i) => (i === index ? { ...item, number: e.target.value } : item)),
                          }))
                        }
                      />
                      <Input
                        type="number"
                        min={1}
                        max={500}
                        placeholder="Apartments"
                        aria-label={`Apartments on tower plot ${index + 1}`}
                        value={row.apartments}
                        onChange={(e) =>
                          setDraft((prev) => ({
                            ...prev,
                            towerPlots: prev.towerPlots.map((item, i) =>
                              i === index ? { ...item, apartments: e.target.value } : item,
                            ),
                          }))
                        }
                      />
                    </div>
                  ))}
                  <div className="row" style={{ gap: 6 }}>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() =>
                        setDraft((prev) => ({
                          ...prev,
                          towerPlots: [...prev.towerPlots, { number: '', apartments: String(prev.defaultApartments || 4) }],
                        }))
                      }
                    >
                      Add a tower plot
                    </Button>
                    {draft.towerPlots.length > 1 ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setDraft((prev) => ({ ...prev, towerPlots: prev.towerPlots.slice(0, -1) }))}
                      >
                        Remove last
                      </Button>
                    ) : null}
                  </div>
                </div>
              </Field>
            </Question>
          ) : null}
        </section>
      ) : null}

      {preview.counts.towerApartments + preview.counts.plotApartments > 0 ? (
        <details className="setup-more">
          <summary>Apartment numbers (optional)</summary>
          <Field label="Apartments per floor" hint="Does not change how many you add. 4 per floor numbers them 101, 102, 103, 104, then 201.">
            <Input
              type="number"
              min={1}
              max={20}
              value={String(draft.apartmentsPerFloor)}
              onChange={(e) =>
                setDraft((prev) => ({ ...prev, apartmentsPerFloor: Math.max(1, Number(e.target.value) || 4) }))
              }
              style={{ maxWidth: 120 }}
            />
          </Field>
        </details>
      ) : null}

      {preview.error ? (
        <Alert tone={guidance ? 'info' : 'warning'}>{preview.error}</Alert>
      ) : (
        <Alert tone="info">
          <div>{preview.summary}</div>
          {preview.lines.length > 0 ? (
            <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {preview.lines.slice(0, 8).map((line) => (
                <li key={line}>{line}</li>
              ))}
              {preview.lines.length > 8 ? <li>and {preview.lines.length - 8} more</li> : null}
            </ul>
          ) : null}
        </Alert>
      )}

      <div className="row row--wrap" style={{ gap: 10, alignItems: 'center' }}>
        {onDryRunChange ? (
          <label className="row" style={{ gap: 6 }}>
            <input type="checkbox" checked={Boolean(dryRun)} onChange={(e) => onDryRunChange(e.target.checked)} />
            <span className="small">Dry run — show the result, save nothing</span>
          </label>
        ) : null}
        <Button type="submit" variant="primary" busy={busy} disabled={!preview.payload}>
          {submitLabel ?? (dryRun ? 'Preview' : 'Add these units')}
        </Button>
      </div>
    </form>
  );
}
