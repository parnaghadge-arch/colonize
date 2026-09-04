import { useId, useState } from 'react';
import { useList } from '../lib/useResource.ts';
import { Field, Input, StatusPill } from './ui.tsx';
import type { Unit } from '../lib/types.ts';

/**
 * Searchable unit picker.
 *
 * A society has hundreds of units, so this searches server-side rather than loading them all —
 * the same component backs "add a resident" and "raise a complaint about a flat", which keeps the
 * interaction identical in both places.
 *
 * The radio group needs a unique name per instance or two pickers on one screen would fight over
 * which option is checked.
 */
export function UnitPicker({
  value,
  onChange,
  label = 'Unit',
  hint = 'Type to search the society’s units.',
  required = true,
  disabled = false,
}: {
  value: string;
  onChange: (unitId: string) => void;
  label?: string;
  hint?: string;
  required?: boolean;
  disabled?: boolean;
}) {
  const groupName = useId();
  const [search, setSearch] = useState('');
  const units = useList<Unit>('/units', { limit: 25, search: search || undefined }, [search]);

  return (
    <>
      <Field label={label} required={required} hint={hint}>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search unit number, e.g. A-1203"
          disabled={disabled}
        />
      </Field>
      <div style={{ maxHeight: 190, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
        {units.loading ? (
          <div style={{ padding: 14 }}>
            <span className="spinner" />
          </div>
        ) : units.page.items.length === 0 ? (
          <p className="small muted" style={{ padding: 14 }}>
            {search ? `No units match “${search}”.` : 'Type to search for a unit.'}
          </p>
        ) : (
          units.page.items.map((unit) => (
            <label
              key={unit._id}
              className="row"
              style={{
                padding: '8px 12px',
                borderBottom: '1px solid var(--border)',
                cursor: disabled ? 'default' : 'pointer',
                background: value === unit._id ? 'var(--brand-soft)' : undefined,
                opacity: disabled ? 0.6 : undefined,
              }}
            >
              <input
                type="radio"
                name={groupName}
                checked={value === unit._id}
                onChange={() => onChange(unit._id)}
                disabled={disabled}
                style={{ width: 'auto' }}
              />
              <span style={{ flex: 1 }}>
                <b>{unit.label || unit.unitNumber}</b>
                <span className="faint small"> · {unit.building?.name ?? ''}</span>
              </span>
              <StatusPill status={unit.status} />
            </label>
          ))
        )}
      </div>
    </>
  );
}
