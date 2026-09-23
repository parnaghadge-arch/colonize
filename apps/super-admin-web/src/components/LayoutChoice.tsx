import { SOCIETY_LAYOUT_LABELS, type SocietyLayout } from '../lib/types.ts';

const OPTIONS: Array<{ id: SocietyLayout; title: string; detail: string; later: string }> = [
  {
    id: 'BUILDING',
    title: 'Building',
    detail: 'Tower / apartments',
    later: 'Adding units asks how many towers, and apartments in each.',
  },
  {
    id: 'PLOT',
    title: 'Layout',
    detail: 'Plot / houses',
    later: 'Adding units asks how many plots, then vacant, house, or tower.',
  },
  {
    id: 'MIXED',
    title: 'Both',
    detail: 'Towers and plots together',
    later: 'Adding units asks both. A count of 0 skips that side.',
  },
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
            <span className="choice__later">{option.later}</span>
          </button>
        );
      })}
    </div>
  );
}

export function layoutChoiceHint(layout: string): string {
  return OPTIONS.find((option) => option.id === layout)?.later ?? OPTIONS[0]!.later;
}
