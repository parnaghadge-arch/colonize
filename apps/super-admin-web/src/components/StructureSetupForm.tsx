import { useMemo, useState, type FormEvent } from 'react';
import {
  PER_PLOT_LIST_LIMIT,
  PLOT_KIND_LABELS,
  SOCIETY_LAYOUT_LABELS,
  buildStructureSetup,
  emptyStructureDraft,
  sectionsForLayout,
  withApartmentsEach,
  withDefaultKind,
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
 * Building → how many towers, how many apartments in each.
 * Layout   → how many plots, and what is on each (vacant plot / house / tower).
 * Both     → those two, one under the other.
 *
 * Floors, wings and numbering are filled in by the server. The preview sentence is the
 * confirmation — there is no second screen.
 */
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
  const [draft, setDraft] = useState<StructureDraft>(emptyStructureDraft);
  const sections = sectionsForLayout(layout);
  const preview = useMemo(() => buildStructureSetup(draft, layout), [draft, layout]);
  const layoutName =
    layout === 'BUILDING' || layout === 'PLOT' || layout === 'MIXED' ? SOCIETY_LAYOUT_LABELS[layout] : null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!preview.payload || busy) return;
    try {
      await onSubmit(preview.payload);
      if (resetOnSuccess) setDraft(emptyStructureDraft());
    } catch {
      // The parent shows the error. Leaving the draft in place lets them correct it.
    }
  }

  const showPlotList = sections.plots && draft.eachPlot && draft.plotCount > 0 && draft.plotCount <= PER_PLOT_LIST_LIMIT;
  const showPlotExceptions = sections.plots && draft.eachPlot && draft.plotCount > PER_PLOT_LIST_LIMIT;

  return (
    <form onSubmit={submit} className="stack" style={{ gap: 14 }}>
      {error ? <ErrorAlert error={error} /> : null}

      <p className="small muted" style={{ margin: 0 }}>
        {layoutName ? (
          <>
            This society is <b>{layoutName}</b>.{' '}
          </>
        ) : (
          <>This society's layout is not on file, so the tower questions are shown. </>
        )}
        {sections.towers && sections.plots
          ? 'Fill in the towers, the plots, or both. Leave a count at zero if you are not adding that today.'
          : sections.plots
            ? 'Say how many plots, then what is on each one. A tower asks how many apartments — nothing else.'
            : 'Say how many towers, and how many apartments each one has. Numbers and floors are filled in for you.'}
      </p>

      {sections.towers ? (
        <section className="stack" style={{ gap: 10 }}>
          {sections.plots ? <h3>Towers</h3> : null}
          <div className="form-row">
            <Field label="How many towers?" hint="Tower 1, Tower 2, …">
              <Input
                type="number"
                min={0}
                max={100}
                value={String(draft.towerCount)}
                onChange={(e) => setDraft((prev) => withTowerCount(prev, Number(e.target.value)))}
              />
            </Field>
            {draft.sameApartments ? (
              <Field label="Apartments in each tower" hint="The same number for every tower">
                <Input
                  type="number"
                  min={1}
                  max={2000}
                  value={String(draft.apartmentsEach)}
                  onChange={(e) => setDraft((prev) => withApartmentsEach(prev, Number(e.target.value)))}
                  disabled={draft.towerCount < 1}
                />
              </Field>
            ) : (
              <Field label="Apartments per floor" hint="Only changes numbering: 101, 102, then 201">
                <Input
                  type="number"
                  min={1}
                  max={20}
                  value={String(draft.apartmentsPerFloor)}
                  onChange={(e) =>
                    setDraft((prev) => ({ ...prev, apartmentsPerFloor: Math.max(1, Number(e.target.value) || 4) }))
                  }
                />
              </Field>
            )}
          </div>
          <label className="row" style={{ gap: 8 }}>
            <input
              type="checkbox"
              checked={!draft.sameApartments}
              onChange={(e) => setDraft((prev) => ({ ...prev, sameApartments: !e.target.checked }))}
            />
            <span className="small">Towers have different names or apartment counts</span>
          </label>
          {!draft.sameApartments && draft.towerCount > 0 ? (
            <div className="setup-list">
              {draft.towers.slice(0, draft.towerCount).map((tower, index) => (
                <div key={index} className="setup-row">
                  <span className="small muted">Tower {index + 1}</span>
                  <Input
                    value={tower.name}
                    aria-label={`Name of tower ${index + 1}`}
                    onChange={(e) =>
                      setDraft((prev) => ({
                        ...prev,
                        towers: prev.towers.map((row, i) => (i === index ? { ...row, name: e.target.value } : row)),
                      }))
                    }
                  />
                  <Input
                    type="number"
                    min={1}
                    max={2000}
                    aria-label={`Apartments in tower ${index + 1}`}
                    value={String(tower.apartments)}
                    onChange={(e) =>
                      setDraft((prev) => ({
                        ...prev,
                        towers: prev.towers.map((row, i) =>
                          i === index ? { ...row, apartments: Number(e.target.value) } : row,
                        ),
                      }))
                    }
                  />
                </div>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      {sections.plots ? (
        <section className="stack" style={{ gap: 10 }}>
          {sections.towers ? <h3>Plots</h3> : null}
          <div className="form-row">
            <Field label="How many plots?">
              <Input
                type="number"
                min={0}
                max={2000}
                value={String(draft.plotCount)}
                onChange={(e) => setDraft((prev) => withPlotCount(prev, Number(e.target.value)))}
              />
            </Field>
            {!draft.eachPlot ? (
              <Field label="What is on each plot?">
                <Select
                  value={draft.defaultKind}
                  onChange={(e) => setDraft((prev) => withDefaultKind(prev, e.target.value as PlotKind))}
                  disabled={draft.plotCount < 1}
                >
                  <option value="HOUSE">House</option>
                  <option value="VACANT">Vacant plot</option>
                  <option value="TOWER">Tower</option>
                </Select>
              </Field>
            ) : (
              <span />
            )}
          </div>
          {!draft.eachPlot && draft.defaultKind === 'TOWER' && draft.plotCount > 0 ? (
            <Field label="Apartments in each tower" hint="Every plot is a tower with this many apartments">
              <Input
                type="number"
                min={1}
                max={500}
                value={String(draft.defaultApartments)}
                onChange={(e) => setDraft((prev) => ({ ...prev, defaultApartments: Number(e.target.value) }))}
              />
            </Field>
          ) : null}
          <label className="row" style={{ gap: 8 }}>
            <input
              type="checkbox"
              checked={draft.eachPlot}
              onChange={(e) => setDraft((prev) => withEachPlot(prev, e.target.checked))}
              disabled={draft.plotCount < 1}
            />
            <span className="small">
              Some plots are different
              {draft.eachPlot ? ' — turning this off sets every plot back to the choice above' : ''}
            </span>
          </label>

          {showPlotList ? (
            <>
              <div className="row row--wrap" style={{ gap: 6 }}>
                <span className="small muted">Set every plot to</span>
                {(['HOUSE', 'VACANT', 'TOWER'] as const).map((kind) => (
                  <Button
                    key={kind}
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setDraft((prev) => ({
                        ...prev,
                        defaultKind: kind,
                        plots: prev.plots.map((plot) => ({ ...plot, kind, apartments: prev.defaultApartments || 4 })),
                      }))
                    }
                  >
                    {PLOT_KIND_LABELS[kind]}
                  </Button>
                ))}
              </div>
              <div className="setup-list">
                {draft.plots.slice(0, draft.plotCount).map((plot, index) => (
                  <div key={index} className="setup-row">
                    <span className="small">Plot {index + 1}</span>
                    <Select
                      aria-label={`What is on plot ${index + 1}`}
                      value={plot.kind}
                      onChange={(e) =>
                        setDraft((prev) => ({
                          ...prev,
                          plots: prev.plots.map((row, i) =>
                            i === index ? { ...row, kind: e.target.value as PlotKind } : row,
                          ),
                        }))
                      }
                    >
                      <option value="HOUSE">House</option>
                      <option value="VACANT">Vacant plot</option>
                      <option value="TOWER">Tower</option>
                    </Select>
                    {plot.kind === 'TOWER' ? (
                      <Input
                        type="number"
                        min={1}
                        max={500}
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
            </>
          ) : null}

          {showPlotExceptions ? (
            <div className="stack" style={{ gap: 8 }}>
              <p className="small muted" style={{ margin: 0 }}>
                {draft.plotCount} plots is a long list. Everything you don't name below stays a{' '}
                <b>{PLOT_KIND_LABELS[draft.defaultKind].toLowerCase()}</b>. Use commas or a range, like 3, 7, 11-14.
              </p>
              {draft.defaultKind !== 'VACANT' ? (
                <Field label="Vacant plot numbers">
                  <Input
                    value={draft.vacantNumbers}
                    placeholder="3, 7, 11-14"
                    onChange={(e) => setDraft((prev) => ({ ...prev, vacantNumbers: e.target.value }))}
                  />
                </Field>
              ) : null}
              {draft.defaultKind !== 'HOUSE' ? (
                <Field label="House plot numbers">
                  <Input
                    value={draft.houseNumbers}
                    placeholder="1-20, 24"
                    onChange={(e) => setDraft((prev) => ({ ...prev, houseNumbers: e.target.value }))}
                  />
                </Field>
              ) : null}
              <Field label="Towers on plots" hint="One plot number, and how many apartments that tower has">
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
            </div>
          ) : null}
        </section>
      ) : null}

      {(sections.towers && draft.sameApartments) || (!sections.towers && preview.counts.plotApartments > 0) ? (
        <Field label="Apartments per floor" hint="Does not change the total. 4 per floor numbers them 101, 102, 103, 104, then 201.">
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
      ) : null}

      {preview.error ? (
        <Alert tone="warning">{preview.error}</Alert>
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
