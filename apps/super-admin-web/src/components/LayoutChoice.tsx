import { SOCIETY_LAYOUT_LABELS, type SocietyLayout } from '../lib/types.ts';

const OPTIONS: Array<{ id: SocietyLayout; title: string; detail: string }> = [
  { id: 'BUILDING', title: 'Building', detail: 'Tower / apartments' },
  { id: 'PLOT', title: 'Layout', detail: 'Plot / houses' },
  { id: 'MIXED', title: 'Both', detail: 'Towers and plots together' },
];

/** The three layout choices, as buttons rather than a dropdown, so none of them is hidden. */
export function LayoutChoice({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (layout: SocietyLayout) => void;
  disabled?: boolean;
}) {
  return (
    <div className="choice-grid" role="radiogroup" aria-label="Society layout">
      {OPTIONS.map((option) => {
        const selected = value === option.id;
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={SOCIETY_LAYOUT_LABELS[option.id]}
            disabled={disabled}
            className={selected ? 'choice choice--on' : 'choice'}
            onClick={() => onChange(option.id)}
          >
            <strong>{option.title}</strong>
            <span>{option.detail}</span>
          </button>
        );
      })}
    </div>
  );
}

export function layoutChoiceHint(layout: string): string {
  if (layout === 'PLOT') {
    return 'Plots and houses. Adding units asks how many plots, and whether each one is a vacant plot, a house, or a tower. A plot layout starts with one street gate, so multi-gate is not turned on.';
  }
  if (layout === 'MIXED') {
    return 'Towers and plots in the same society. Adding units asks both: towers and their apartments, and plots (vacant, house, or tower).';
  }
  return 'Towers and apartments. Adding units asks how many towers, and how many apartments each tower has.';
}
