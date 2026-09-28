import { useState, type FormEvent } from 'react';
import { api } from '../lib/api.ts';
import { useList } from '../lib/useResource.ts';
import {
  Alert,
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
  useToast,
} from '../components/ui.tsx';
import { label } from '../lib/format.ts';
import { useSession } from '../lib/session.tsx';
import type { Gate } from '../lib/types.ts';

const GATE_TYPES = ['MAIN', 'SECONDARY', 'SERVICE', 'PARKING', 'PEDESTRIAN', 'EMERGENCY'] as const;

function number(v: unknown): string {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n.toLocaleString('en-IN') : '0';
}

export function GatesPage() {
  const { can } = useSession();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const limit = 20;

  const gates = useList<Gate>('/gates', { page, limit, search: search || undefined }, [page, search]);
  const [detail, setDetail] = useState<Gate | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <div className="stack">
      {gates.error ? <ErrorAlert error={gates.error} /> : null}

      <Card
        title="Gates"
        subtitle={`${number(gates.page.total)} entry points for this society`}
        actions={
          can('gate:create') ? (
            <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
              Add gate
            </Button>
          ) : null
        }
        flush
      >
        <div className="card__body" style={{ paddingBottom: 0 }}>
          <div className="toolbar">
            <Input
              placeholder="Search by name or code"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              style={{ minWidth: 220 }}
            />
            <div className="toolbar__spacer" />
            <Button size="sm" variant="ghost" onClick={() => gates.reload()}>
              Refresh
            </Button>
          </div>
        </div>

        {gates.loading ? (
          <Loading />
        ) : (
          <DataTable
            rows={gates.page.items}
            rowKey={(g) => g._id}
            onRowClick={setDetail}
            empty={<EmptyState title="No gates yet" hint="Add your Main Gate, Service Gate, Parking Gate, etc. Guards need a gate to start a shift." />}
            columns={[
              {
                key: 'name',
                header: 'Gate',
                render: (g) => (
                  <div>
                    <b>{g.name}</b>
                    <div className="faint small">{g.code ? `Code ${g.code}` : ''} · {label(g.type ?? 'MAIN')}</div>
                  </div>
                ),
              },
              {
                key: 'access',
                header: 'Access',
                render: (g) => (
                  <span className="small">
                    {g.allowsVehicles !== false ? 'Vehicles' : ''}{g.allowsVehicles !== false && g.allowsPedestrians !== false ? ' · ' : ''}{g.allowsPedestrians !== false ? 'Pedestrians' : '—'}
                  </span>
                ),
              },
              {
                key: 'hours',
                header: 'Hours',
                render: (g) => (
                  <span className="small">
                    {g.isOpen24x7 !== false ? '24×7' : `${g.openTime ?? '—'} – ${g.closeTime ?? '—'}`}
                  </span>
                ),
              },
              {
                key: 'today',
                header: 'Today',
                align: 'right',
                render: (g) => number((g as { entriesToday?: number }).entriesToday ?? 0),
              },
              {
                key: 'status',
                header: '',
                render: (g) => (g.isActive === false ? <Pill tone="danger">Inactive</Pill> : <Pill tone="success">Active</Pill>),
              },
            ]}
          />
        )}

        <div className="card__foot">
          <Pagination page={page} limit={limit} total={gates.page.total} onPage={setPage} />
        </div>
      </Card>

      {detail ? (
        <GateDetail
          gate={detail}
          onClose={() => setDetail(null)}
          onChanged={() => gates.reload()}
        />
      ) : null}

      {creating ? (
        <GateForm
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
            toast.success('Gate added — guards can now start a shift there');
            gates.reload();
          }}
        />
      ) : null}
    </div>
  );
}

function GateDetail({ gate, onClose, onChanged }: { gate: Gate; onClose: () => void; onChanged: () => void }) {
  const { can } = useSession();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);

  async function toggleActive() {
    setBusy(true);
    try {
      await api.patch(`/gates/${gate._id}`, { isActive: gate.isActive === false });
      toast.success(gate.isActive === false ? 'Gate reactivated' : 'Gate deactivated');
      onChanged();
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Delete ${gate.name}? This cannot be undone. Guards posted there will lose their posting.`)) return;
    setBusy(true);
    try {
      await api.del(`/gates/${gate._id}`);
      toast.success('Gate deleted');
      onChanged();
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={gate.name}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          {can('gate:update') ? (
            <Button variant={gate.isActive === false ? 'primary' : 'default'} busy={busy} onClick={() => void toggleActive()}>
              {gate.isActive === false ? 'Reactivate' : 'Deactivate'}
            </Button>
          ) : null}
          {can('gate:delete') ? (
            <Button variant="danger" busy={busy} onClick={() => void remove()}>
              Delete
            </Button>
          ) : null}
        </>
      }
    >
      {editing ? (
        <GateForm
          gate={gate}
          onClose={() => setEditing(false)}
          onDone={() => {
            setEditing(false);
            toast.success('Gate updated');
            onChanged();
            onClose();
          }}
        />
      ) : (
        <div className="stack">
          <Card
            title="Gate details"
            actions={can('gate:update') ? <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Edit</Button> : null}
          >
            <KeyValue
              items={[
                ['Name', gate.name],
                ['Code', gate.code ?? '—'],
                ['Type', label(gate.type ?? 'MAIN')],
                ['Vehicles', gate.allowsVehicles === false ? 'No' : 'Yes'],
                ['Pedestrians', gate.allowsPedestrians === false ? 'No' : 'Yes'],
                ['Open', gate.isOpen24x7 === false ? `${gate.openTime ?? '—'} – ${gate.closeTime ?? '—'}` : '24×7'],
                ['Status', gate.isActive === false ? 'Inactive' : 'Active'],
              ]}
            />
          </Card>

          <Alert tone="info">
            Guards pick this gate in the security app when they <b>Start shift</b>. If no gates exist, the app shows <i>“A gate is required to record an entry”</i> on every scan and manual check-in.
          </Alert>
        </div>
      )}
    </Modal>
  );
}

function GateForm({ gate, onClose, onDone }: { gate?: Gate; onClose: () => void; onDone: () => void }) {
  const editing = Boolean(gate);
  const [name, setName] = useState(gate?.name ?? '');
  const [code, setCode] = useState(gate?.code ?? '');
  const [type, setType] = useState(String(gate?.type ?? 'MAIN'));
  const [allowsVehicles, setAllowsVehicles] = useState(gate?.allowsVehicles !== false);
  const [allowsPedestrians, setAllowsPedestrians] = useState(gate?.allowsPedestrians !== false);
  const [isOpen24x7, setIsOpen24x7] = useState(gate?.isOpen24x7 !== false);
  const [openTime, setOpenTime] = useState(String(gate?.openTime ?? '06:00'));
  const [closeTime, setCloseTime] = useState(String(gate?.closeTime ?? '20:00'));
  const [isActive, setIsActive] = useState(gate?.isActive !== false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const payload: Record<string, unknown> = {
      name: name.trim(),
      code: code.trim() || undefined,
      type,
      allowsVehicles,
      allowsPedestrians,
      isOpen24x7,
      isActive,
      ...(isOpen24x7 ? {} : { openTime, closeTime }),
    };
    try {
      if (editing) await api.patch(`/gates/${gate!._id}`, payload);
      else await api.post('/gates', payload);
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={editing ? `Edit ${gate!.name}` : 'Add a gate'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={submit}>
            {editing ? 'Save changes' : 'Add gate'}
          </Button>
        </>
      }
    >
      {error ? <ErrorAlert error={error} /> : null}
      <form onSubmit={submit} className="stack">
        <div className="form-row">
          <Field label="Gate name" required hint="e.g. Main Gate, Tower A Gate">
            <Input value={name} onChange={(e) => setName(e.target.value)} required autoFocus placeholder="Main Gate" />
          </Field>
          <Field label="Code" hint="Short code for reports">
            <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="MAIN" />
          </Field>
        </div>

        <Field label="Type">
          <Select value={type} onChange={(e) => setType(e.target.value)}>
            {GATE_TYPES.map((t) => (
              <option key={t} value={t}>
                {label(t)}
              </option>
            ))}
          </Select>
        </Field>

        <div className="form-row">
          <Field label="Vehicles">
            <Select value={allowsVehicles ? 'yes' : 'no'} onChange={(e) => setAllowsVehicles(e.target.value === 'yes')}>
              <option value="yes">Allowed</option>
              <option value="no">Not allowed</option>
            </Select>
          </Field>
          <Field label="Pedestrians">
            <Select value={allowsPedestrians ? 'yes' : 'no'} onChange={(e) => setAllowsPedestrians(e.target.value === 'yes')}>
              <option value="yes">Allowed</option>
              <option value="no">Not allowed</option>
            </Select>
          </Field>
        </div>

        <Field label="Hours">
          <Select value={isOpen24x7 ? '24' : 'custom'} onChange={(e) => setIsOpen24x7(e.target.value === '24')}>
            <option value="24">Open 24×7</option>
            <option value="custom">Custom hours</option>
          </Select>
        </Field>

        {!isOpen24x7 ? (
          <div className="form-row">
            <Field label="Opens at">
              <Input type="time" value={openTime} onChange={(e) => setOpenTime(e.target.value)} />
            </Field>
            <Field label="Closes at">
              <Input type="time" value={closeTime} onChange={(e) => setCloseTime(e.target.value)} />
            </Field>
          </div>
        ) : null}

        <Field label="Status">
          <Select value={isActive ? 'active' : 'inactive'} onChange={(e) => setIsActive(e.target.value === 'active')}>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </Select>
        </Field>

        <Alert tone="info">
          After adding a gate, guards will see it in the security app under <b>Start shift → Select your gate</b>. Without at least one active gate, every scan shows “A gate is required”.
        </Alert>
      </form>
    </Modal>
  );
}
