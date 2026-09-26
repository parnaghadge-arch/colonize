import { useState, type FormEvent } from 'react';
import { api } from '../lib/api.ts';
import { useSession } from '../lib/session.tsx';
import { Alert, Button, ErrorAlert, Field, Select } from './ui.tsx';
import { UnitPicker } from './UnitPicker.tsx';

/**
 * Links the signed-in society admin to a flat so the same login can act as a resident.
 * Must be called in console mode — the resident client cannot create its own membership.
 */
export function LinkHomeForm({ onLinked }: { onLinked: () => void }) {
  const { refresh } = useSession();
  const [unitId, setUnitId] = useState('');
  const [kind, setKind] = useState<'OWNER' | 'TENANT'>('OWNER');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!unitId) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/society/me/home', { unitId, kind });
      await refresh();
      onLinked();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      {error ? <ErrorAlert error={error} /> : null}
      <Alert tone="info">
        You manage this society and you also live here. Pick your flat once. After that you can
        switch between managing the society and using it as a resident — bills, visitors and payments
        for your own home.
      </Alert>
      <Field label="I live here as">
        <Select value={kind} onChange={(e) => setKind(e.target.value === 'TENANT' ? 'TENANT' : 'OWNER')}>
          <option value="OWNER">Owner</option>
          <option value="TENANT">Tenant</option>
        </Select>
      </Field>
      <UnitPicker value={unitId} onChange={setUnitId} label="My flat" hint="Search by flat number." />
      <Button variant="primary" busy={busy} disabled={!unitId} onClick={submit}>
        Link this flat
      </Button>
    </form>
  );
}
