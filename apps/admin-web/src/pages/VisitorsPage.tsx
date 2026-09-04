import { useState, type FormEvent } from 'react';
import { api } from '../lib/api.ts';
import { useList, useResource } from '../lib/useResource.ts';
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
import { dateTime, number, today } from '../lib/format.ts';
import { useSession } from '../lib/session.tsx';
import type { PreApproveResult, Unit, Visitor } from '../lib/types.ts';

interface VisitorSummary {
  days: number;
  total: number;
  currentlyInside: number;
  byStatus: Record<string, number>;
  byType: Record<string, number>;
}

interface EntryLogRow {
  _id: string;
  visitorName?: string;
  name?: string;
  direction?: string;
  gateName?: string;
  gate?: string;
  at?: string;
  createdAt?: string;
  unitLabel?: string;
  [key: string]: unknown;
}

/**
 * Visitor management (§12, §57).
 *
 * Pre-approving mints a signed QR pass that the resident shares with their guest; the gate
 * console then scans it. The pass image is rendered straight from the `dataUrl` the API returns,
 * so the token itself is never reconstructed in the browser.
 */
export function VisitorsPage() {
  const { who, can } = useSession();
  const toast = useToast();
  const timezone = who?.society?.timezone;

  const [tab, setTab] = useState<'visitors' | 'log'>('visitors');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const limit = 25;

  const summary = useResource<VisitorSummary>('/visitors/summary');
  const visitors = useList<Visitor>(
    '/visitors',
    { page, limit, search: search || undefined, status: status || undefined },
    [page, search, status],
  );
  const entries = useList<EntryLogRow>('/visitors/entries', { page, limit }, [page, tab]);

  const [preApproving, setPreApproving] = useState(false);
  const [issued, setIssued] = useState<{ result: PreApproveResult; visitorName: string } | null>(null);
  const [detail, setDetail] = useState<Visitor | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);

  async function runAction(visitor: Visitor, action: 'check-in' | 'check-out', body?: Record<string, unknown>) {
    setActionBusy(visitor._id);
    try {
      await api.post(`/visitors/${visitor._id}/${action}`, body ?? {});
      toast.success(`Visitor ${action === 'check-in' ? 'checked in' : 'checked out'}`);
      visitors.reload();
      summary.reload();
    } catch (err) {
      toast.error(err);
    } finally {
      setActionBusy(null);
    }
  }

  async function decide(visitor: Visitor, decision: 'APPROVE' | 'DENY') {
    setActionBusy(visitor._id);
    try {
      await api.post(`/visitors/${visitor._id}/decide`, { decision });
      toast.success(decision === 'APPROVE' ? 'Visitor approved' : 'Visitor denied');
      visitors.reload();
      summary.reload();
    } catch (err) {
      toast.error(err);
    } finally {
      setActionBusy(null);
    }
  }

  const s = summary.data;

  return (
    <div className="stack">
      {visitors.error ? <ErrorAlert error={visitors.error} /> : null}

      <div className="tiles">
        <div className="tile tile--success">
          <div className="tile__label">Inside now</div>
          <div className="tile__value">{number(s?.currentlyInside ?? 0)}</div>
          <div className="tile__hint">Awaiting exit</div>
        </div>
        <div className="tile tile--brand">
          <div className="tile__label">Last {s?.days ?? 30} days</div>
          <div className="tile__value">{number(s?.total ?? 0)}</div>
          <div className="tile__hint">Visitor movements</div>
        </div>
        {Object.entries(s?.byStatus ?? {}).map(([key, value]) => (
          <div className="tile" key={key}>
            <div className="tile__label">{key.split('_').join(' ')}</div>
            <div className="tile__value">{number(value)}</div>
          </div>
        ))}
      </div>

      <Card
        title="Visitors"
        actions={
          <div className="row">
            <div className="login__tabs" style={{ margin: 0 }}>
              <button
                type="button"
                className={`login__tab${tab === 'visitors' ? ' login__tab--active' : ''}`}
                onClick={() => setTab('visitors')}
              >
                Register
              </button>
              <button
                type="button"
                className={`login__tab${tab === 'log' ? ' login__tab--active' : ''}`}
                onClick={() => setTab('log')}
              >
                Entry log
              </button>
            </div>
            {can('visitor:create') && tab === 'visitors' ? (
              <Button size="sm" variant="primary" onClick={() => setPreApproving(true)}>
                Pre-approve visitor
              </Button>
            ) : null}
          </div>
        }
        flush
      >
        {tab === 'visitors' ? (
          <>
            <div className="card__body" style={{ paddingBottom: 0 }}>
              <div className="toolbar">
                <Input
                  placeholder="Search by name or phone"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(1);
                  }}
                  style={{ minWidth: 240 }}
                />
                <Select
                  value={status}
                  onChange={(e) => {
                    setStatus(e.target.value);
                    setPage(1);
                  }}
                >
                  <option value="">Any status</option>
                  {['PRE_APPROVED', 'AT_GATE', 'WAITING', 'INSIDE', 'CHECKED_IN', 'EXITED', 'CHECKED_OUT', 'DENIED', 'CANCELLED'].map(
                    (value) => (
                      <option key={value} value={value}>
                        {value.split('_').join(' ')}
                      </option>
                    ),
                  )}
                </Select>
                <div className="toolbar__spacer" />
                <span className="small muted">{number(visitors.page.total)} records</span>
              </div>
            </div>

            {visitors.loading ? (
              <Loading />
            ) : (
              <DataTable
                rows={visitors.page.items}
                onRowClick={setDetail}
                empty={<EmptyState title="No visitors found" hint="Pre-approve one, or clear the filters." />}
                columns={[
                  {
                    key: 'name',
                    header: 'Visitor',
                    render: (v) => (
                      <div>
                        <b>{String(v.name)}</b>
                        <div className="faint small">{String(v.purpose ?? '')}</div>
                      </div>
                    ),
                  },
                  { key: 'type', header: 'Type', render: (v) => <Pill>{String(v.visitorType ?? '—')}</Pill> },
                  { key: 'unit', header: 'Unit', render: (v) => String(v.unitLabel ?? '—') },
                  {
                    key: 'expected',
                    header: 'Expected',
                    render: (v) => <span className="small muted">{dateTime(v.expectedArrival, timezone)}</span>,
                  },
                  { key: 'status', header: 'Status', render: (v) => <StatusPill status={v.status} /> },
                  {
                    key: 'actions',
                    header: '',
                    align: 'right',
                    render: (v) => (
                      <div
                        className="table__actions"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {v.status === 'AT_GATE' || v.status === 'WAITING' ? (
                          <>
                            <Button size="sm" variant="primary" busy={actionBusy === v._id} onClick={() => decide(v, 'APPROVE')}>
                              Approve
                            </Button>
                            <Button size="sm" busy={actionBusy === v._id} onClick={() => decide(v, 'DENY')}>
                              Deny
                            </Button>
                          </>
                        ) : null}
                        {v.status === 'INSIDE' || v.status === 'CHECKED_IN' ? (
                          <Button size="sm" busy={actionBusy === v._id} onClick={() => runAction(v, 'check-out')}>
                            Check out
                          </Button>
                        ) : null}
                        {v.status === 'PRE_APPROVED' ? (
                          <Button size="sm" variant="primary" busy={actionBusy === v._id} onClick={() => runAction(v, 'check-in')}>
                            Check in
                          </Button>
                        ) : null}
                      </div>
                    ),
                  },
                ]}
              />
            )}

            <div className="card__foot">
              <Pagination page={page} limit={limit} total={visitors.page.total} onPage={setPage} />
            </div>
          </>
        ) : entries.loading ? (
          <Loading />
        ) : (
          <>
            <DataTable
              rows={entries.page.items}
              empty={<EmptyState title="No movements recorded" />}
              columns={[
                {
                  key: 'visitor',
                  header: 'Visitor',
                  render: (e) => <b>{String(e.visitorName ?? e.name ?? '—')}</b>,
                },
                {
                  key: 'direction',
                  header: 'Movement',
                  render: (e) => (
                    <Pill tone={e.direction === 'IN' ? 'success' : 'info'}>
                      {e.direction === 'IN' ? 'Entry' : e.direction === 'OUT' ? 'Exit' : String(e.direction ?? '—')}
                    </Pill>
                  ),
                },
                { key: 'gate', header: 'Gate', render: (e) => String(e.gateName ?? e.gate ?? '—') },
                { key: 'unit', header: 'Unit', render: (e) => String(e.unitLabel ?? '—') },
                {
                  key: 'at',
                  header: 'When',
                  align: 'right',
                  render: (e) => <span className="small muted">{dateTime(String(e.at ?? e.createdAt ?? ''), timezone)}</span>,
                },
              ]}
            />
            <div className="card__foot">
              <Pagination page={page} limit={limit} total={entries.page.total} onPage={setPage} />
            </div>
          </>
        )}
      </Card>

      {preApproving ? (
        <PreApproveForm
          onClose={() => setPreApproving(false)}
          onDone={(result) => {
            setPreApproving(false);
            setIssued({ result, visitorName: String(result.visitor?.name ?? 'Visitor') });
            visitors.reload();
            summary.reload();
          }}
        />
      ) : null}

      {issued ? (
        <Modal title={`QR pass for ${issued.visitorName}`} onClose={() => setIssued(null)}>
          {issued.result.qr ? (
            <div style={{ textAlign: 'center' }}>
              <img
                src={issued.result.qr.dataUrl}
                alt="Visitor QR pass"
                style={{ width: 230, height: 230, border: '1px solid var(--border)', borderRadius: 10 }}
              />
              <p className="small muted mt">
                Share this with your guest. It is valid{' '}
                {issued.result.qr.validFrom ? `from ${dateTime(issued.result.qr.validFrom, timezone)}` : ''}{' '}
                {issued.result.qr.validTill ? `until ${dateTime(issued.result.qr.validTill, timezone)}` : ''}.
              </p>
              <p className="small faint mono" style={{ wordBreak: 'break-all', marginTop: 8 }}>
                Pass {issued.result.qr.passId}
              </p>
            </div>
          ) : (
            <EmptyState title="No pass was issued" hint="The visitor was created but generateQrPass was off." />
          )}
        </Modal>
      ) : null}

      {detail ? <VisitorDetail visitor={detail} timezone={timezone} onClose={() => setDetail(null)} /> : null}
    </div>
  );
}

function VisitorDetail({ visitor, timezone, onClose }: { visitor: Visitor; timezone?: string; onClose: () => void }) {
  return (
    <Modal title={String(visitor.name)} onClose={onClose}>
      <KeyValue
        items={[
          ['Status', <StatusPill key="s" status={visitor.status} />],
          ['Type', String(visitor.visitorType ?? '—')],
          ['Purpose', String(visitor.purpose ?? '—')],
          ['Unit', String(visitor.unitLabel ?? '—')],
          ['Phone', String(visitor.phone ?? '—')],
          ['Expected arrival', dateTime(visitor.expectedArrival, timezone)],
          ['Checked in', dateTime(visitor.checkInAt, timezone)],
          ['Checked out', dateTime(visitor.checkOutAt, timezone)],
          ['Gate', String(visitor.gateName ?? '—')],
        ]}
      />
    </Modal>
  );
}

function PreApproveForm({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (result: PreApproveResult) => void;
}) {
  const [visitorName, setVisitorName] = useState('');
  const [visitorPhone, setVisitorPhone] = useState('');
  const [purpose, setPurpose] = useState('GUEST');
  const [visitDate, setVisitDate] = useState(today());
  const [expectedArrival, setExpectedArrival] = useState('10:00');
  const [expectedDeparture, setExpectedDeparture] = useState('18:00');
  const [numberOfVisitors, setNumberOfVisitors] = useState('1');
  const [vehicleNumber, setVehicleNumber] = useState('');
  const [unitId, setUnitId] = useState('');
  const [unitSearch, setUnitSearch] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const units = useList<Unit>('/units', { limit: 25, search: unitSearch || undefined }, [unitSearch]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<PreApproveResult>('/visitors/pre-approve', {
        visitorName: visitorName.trim(),
        visitorPhone: visitorPhone.trim() || undefined,
        purpose,
        visitDate,
        expectedArrival,
        expectedDeparture: expectedDeparture || undefined,
        numberOfVisitors: Number(numberOfVisitors),
        vehicleNumber: vehicleNumber.trim() || undefined,
        unitId,
        notes: notes.trim() || undefined,
        generateQrPass: true,
      });
      onDone(result);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Pre-approve a visitor"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={submit} disabled={!unitId}>
            Approve and issue QR
          </Button>
        </>
      }
    >
      {error ? <ErrorAlert error={error} /> : null}
      <form onSubmit={submit}>
        <div className="form-row">
          <Field label="Visitor name" required>
            <Input value={visitorName} onChange={(e) => setVisitorName(e.target.value)} placeholder="Anita Desai" required autoFocus />
          </Field>
          <Field label="Visitor phone">
            <Input value={visitorPhone} onChange={(e) => setVisitorPhone(e.target.value)} placeholder="+919876543210" />
          </Field>
        </div>
        <div className="form-row">
          <Field label="Purpose" required>
            <Select value={purpose} onChange={(e) => setPurpose(e.target.value)}>
              {['GUEST', 'CAB', 'DELIVERY', 'DOMESTIC_HELP', 'DRIVER', 'VENDOR', 'MAINTENANCE', 'COURIER', 'OTHER'].map((p) => (
                <option key={p} value={p}>
                  {p.split('_').map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(' ')}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Visit date" required>
            <Input type="date" value={visitDate} onChange={(e) => setVisitDate(e.target.value)} required />
          </Field>
        </div>
        <div className="form-row">
          <Field label="Expected arrival" required>
            <Input type="time" value={expectedArrival} onChange={(e) => setExpectedArrival(e.target.value)} required />
          </Field>
          <Field label="Expected departure">
            <Input type="time" value={expectedDeparture} onChange={(e) => setExpectedDeparture(e.target.value)} />
          </Field>
        </div>
        <div className="form-row">
          <Field label="Number of visitors">
            <Input
              type="number"
              min={1}
              value={numberOfVisitors}
              onChange={(e) => setNumberOfVisitors(e.target.value)}
            />
          </Field>
          <Field label="Vehicle number" hint="Optional — lets the gate match the plate.">
            <Input value={vehicleNumber} onChange={(e) => setVehicleNumber(e.target.value)} placeholder="MH31AB1234" />
          </Field>
        </div>

        <Field label="Unit" required hint="The visit is registered against this flat.">
          <Input value={unitSearch} onChange={(e) => setUnitSearch(e.target.value)} placeholder="Search unit, e.g. A-1203" />
        </Field>
        <div style={{ maxHeight: 170, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8, marginBottom: 13 }}>
          {units.loading ? (
            <div style={{ padding: 14 }}>
              <span className="spinner" />
            </div>
          ) : units.page.items.length === 0 ? (
            <p className="small muted" style={{ padding: 14 }}>
              No units match.
            </p>
          ) : (
            units.page.items.map((unit) => (
              <label
                key={unit._id}
                className="row"
                style={{
                  padding: '8px 12px',
                  borderBottom: '1px solid var(--border)',
                  cursor: 'pointer',
                  background: unitId === unit._id ? 'var(--brand-soft)' : undefined,
                }}
              >
                <input
                  type="radio"
                  name="visitor-unit"
                  checked={unitId === unit._id}
                  onChange={() => setUnitId(unit._id)}
                  style={{ width: 'auto' }}
                />
                <span>{unit.label || unit.unitNumber}</span>
              </label>
            ))
          )}
        </div>

        <Field label="Note for the guard">
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Expected around noon, has a bag" />
        </Field>
      </form>
    </Modal>
  );
}
