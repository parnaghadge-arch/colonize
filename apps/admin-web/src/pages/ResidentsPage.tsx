import { useState, type FormEvent } from 'react';
import { api } from '../lib/api.ts';
import { useList } from '../lib/useResource.ts';
import {
  Button,
  Card,
  DataTable,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  KeyValue,
  Loading,
  Modal,
  Pagination,
  Pill,
  Select,
  StatusPill,
  useToast,
} from '../components/ui.tsx';
import { UnitPicker } from '../components/UnitPicker.tsx';
import { day, hiddenEmail, hiddenPhone, initials } from '../lib/format.ts';
import { useSession } from '../lib/session.tsx';
import type { Resident } from '../lib/types.ts';

interface FamilyMember {
  _id: string;
  fullName: string;
  relationship?: string;
  age?: number | null;
  phone?: string;
  canLogin?: boolean;
  isActive?: boolean;
}

interface Vehicle {
  _id: string;
  vehicleNumber: string;
  type?: string;
  brand?: string | null;
  model?: string | null;
  color?: string | null;
  isPrimary?: boolean;
}

/**
 * Residents (§34). Owners, tenants and family members, always scoped to the units of this
 * society — the server enforces that, the UI only presents it.
 */
export function ResidentsPage() {
  const { can } = useSession();
  const toast = useToast();

  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('');
  const [page, setPage] = useState(1);
  const limit = 25;

  const residents = useList<Resident>('/residents', {
    page,
    limit,
    search: search || undefined,
    kind: kind || undefined,
  }, [page, search, kind]);

  const [selected, setSelected] = useState<Resident | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<unknown>(null);

  return (
    <div className="stack">
      {residents.error ? <ErrorAlert error={residents.error} /> : null}

      <Card
        title="Residents"
        subtitle={`${residents.page.total} people registered in this society`}
        actions={
          can('resident:create') ? (
            <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
              Add resident
            </Button>
          ) : null
        }
        flush
      >
        <div className="card__body" style={{ paddingBottom: 0 }}>
          <div className="toolbar">
            <Input
              placeholder="Search by name, phone or email"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              style={{ minWidth: 260 }}
            />
            <Select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All kinds</option>
              {['OWNER', 'TENANT', 'FAMILY', 'COMPANY'].map((k) => (
                <option key={k} value={k}>
                  {k.charAt(0) + k.slice(1).toLowerCase()}
                </option>
              ))}
            </Select>
            <div className="toolbar__spacer" />
            {search || kind ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setSearch('');
                  setKind('');
                  setPage(1);
                }}
              >
                Clear
              </Button>
            ) : null}
          </div>
        </div>

        {residents.loading ? (
          <Loading />
        ) : (
          <DataTable
            rows={residents.page.items}
            onRowClick={setSelected}
            empty={<EmptyState title="No residents found" hint="Adjust the search, or add the first resident." />}
            columns={[
              {
                key: 'name',
                header: 'Resident',
                render: (r) => (
                  <div className="row" style={{ gap: 9 }}>
                    <Avatar name={r.fullName} />
                    <div>
                      <div>
                        <b>{r.fullName}</b> {r.isPrimary ? <Pill tone="brand">Primary</Pill> : null}
                      </div>
                      <div className="faint small">{hiddenEmail(r.email)}</div>
                    </div>
                  </div>
                ),
              },
              { key: 'phone', header: 'Phone', render: (r) => <span className="mono small">{hiddenPhone(r.phone)}</span> },
              { key: 'kind', header: 'Kind', render: (r) => <Pill tone={r.kind === 'OWNER' ? 'success' : 'info'}>{r.kind ?? '—'}</Pill> },
              { key: 'unit', header: 'Unit', render: (r) => String(r.unitLabel ?? r.unitId ?? '—') },
              { key: 'moved', header: 'Moved in', align: 'right', render: (r) => <span className="small muted">{day(r.moveInDate)}</span> },
              { key: 'status', header: 'Status', render: (r) => <StatusPill status={r.status ?? (r.isActive ? 'ACTIVE' : 'INACTIVE')} /> },
            ]}
          />
        )}

        <div className="card__foot">
          <Pagination page={page} limit={limit} total={residents.page.total} onPage={setPage} />
        </div>
      </Card>

      {selected ? (
        <ResidentDetail resident={selected} onClose={() => setSelected(null)} />
      ) : null}

      {creating ? (
        <CreateResidentForm
          error={createError}
          setError={setCreateError}
          onClose={() => {
            setCreating(false);
            setCreateError(null);
          }}
          onDone={() => {
            setCreating(false);
            setCreateError(null);
            toast.success('Resident added');
            residents.reload();
          }}
        />
      ) : null}
    </div>
  );
}

export function Avatar({ name }: { name?: string | null }) {
  return (
    <span
      aria-hidden
      style={{
        width: 30,
        height: 30,
        borderRadius: '50%',
        background: 'var(--brand-soft)',
        color: 'var(--brand-dark)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 12,
        fontWeight: 700,
        flex: '0 0 auto',
      }}
    >
      {initials(name)}
    </span>
  );
}

function ResidentDetail({ resident, onClose }: { resident: Resident; onClose: () => void }) {
  const family = useList<FamilyMember>('/family-members', { residentId: resident._id, limit: 50 }, [resident._id]);
  const vehicles = useList<Vehicle>('/vehicles', { residentId: resident._id, limit: 50 }, [resident._id]);

  return (
    <Modal title={resident.fullName} onClose={onClose} wide>
      <div className="grid grid--2">
        <Card title="Profile">
          <KeyValue
            items={[
              ['Kind', resident.kind ?? '—'],
              ['Phone', hiddenPhone(resident.phone)],
              ['Email', hiddenEmail(resident.email)],
              ['Unit', String(resident.unitLabel ?? resident.unitId ?? '—')],
              ['Primary contact', resident.isPrimary ? 'Yes' : 'No'],
              ['Moved in', day(resident.moveInDate)],
              ['Occupation', String(resident.occupation ?? '—')],
              ['Status', String(resident.status ?? (resident.isActive ? 'ACTIVE' : 'INACTIVE'))],
            ]}
          />
        </Card>

        <div className="stack">
          <Card title="Family members" subtitle={family.loading ? 'Loading…' : `${family.page.total} added`}>
            {family.loading ? (
              <Loading />
            ) : family.page.items.length === 0 ? (
              <EmptyState title="No family members" />
            ) : (
              <DataTable
                rows={family.page.items}
                columns={[
                  { key: 'name', header: 'Name', render: (f) => <b>{f.fullName}</b> },
                  { key: 'rel', header: 'Relationship', render: (f) => f.relationship ?? '—' },
                  { key: 'age', header: 'Age', align: 'right', render: (f) => (f.age ? String(f.age) : '—') },
                  { key: 'login', header: 'Can sign in', render: (f) => (f.canLogin ? <Pill tone="success">Yes</Pill> : <Pill>No</Pill>) },
                ]}
              />
            )}
          </Card>

          <Card title="Vehicles" subtitle={vehicles.loading ? 'Loading…' : `${vehicles.page.total} registered`}>
            {vehicles.loading ? (
              <Loading />
            ) : vehicles.page.items.length === 0 ? (
              <EmptyState title="No vehicles" />
            ) : (
              <DataTable
                rows={vehicles.page.items}
                columns={[
                  { key: 'plate', header: 'Plate', render: (v) => <b className="mono">{v.vehicleNumber}</b> },
                  { key: 'type', header: 'Type', render: (v) => v.type ?? '—' },
                  { key: 'make', header: 'Make', render: (v) => [v.brand, v.model].filter(Boolean).join(' ') || '—' },
                  { key: 'primary', header: 'Primary', render: (v) => (v.isPrimary ? <Pill tone="success">Yes</Pill> : <Pill>No</Pill>) },
                ]}
              />
            )}
          </Card>
        </div>
      </div>
    </Modal>
  );
}

function CreateResidentForm({
  onClose,
  onDone,
  error,
  setError,
}: {
  onClose: () => void;
  onDone: () => void;
  error: unknown;
  setError: (e: unknown) => void;
}) {
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [kind, setKind] = useState('OWNER');
  const [unitId, setUnitId] = useState('');
  const [moveInDate, setMoveInDate] = useState('');
  const [busy, setBusy] = useState(false);


  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/residents', {
        fullName: fullName.trim(),
        phone: phone.trim(),
        email: email.trim() || undefined,
        kind,
        unitId,
        isPrimary: true,
        moveInDate: moveInDate || undefined,
      });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Add a resident"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={submit} disabled={!unitId}>
            Create resident
          </Button>
        </>
      }
    >
      {error ? <ErrorAlert error={error} /> : null}
      <form onSubmit={submit}>
        <Field label="Full name" required>
          <Input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Ravi Kumar" required autoFocus />
        </Field>
        <div className="form-row">
          <Field label="Mobile number" required hint="Used for OTP sign-in.">
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+919876543210" required />
          </Field>
          <Field label="Email">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ravi@example.com" />
          </Field>
        </div>
        <div className="form-row">
          <Field label="Kind" required>
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              {['OWNER', 'TENANT', 'FAMILY', 'COMPANY'].map((k) => (
                <option key={k} value={k}>
                  {k.charAt(0) + k.slice(1).toLowerCase()}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Move-in date">
            <Input type="date" value={moveInDate} onChange={(e) => setMoveInDate(e.target.value)} />
          </Field>
        </div>

        <UnitPicker value={unitId} onChange={setUnitId} />
      </form>
    </Modal>
  );
}
