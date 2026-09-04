import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api.ts';
import { useList, useResource } from '../lib/useResource.ts';
import {
  Alert,
  Button,
  Card,
  DataTable,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Loading,
  Pill,
  Select,
  useToast,
} from '../components/ui.tsx';
import { ago, dateTime, number } from '../lib/format.ts';
import { useSession } from '../lib/session.tsx';
import type { Gate } from '../lib/types.ts';

interface QueueVisitor {
  id: string;
  visitorName: string;
  visitorPhone?: string;
  purpose?: string;
  visitorType?: string;
  status: string;
  numberOfVisitors?: number;
  vehicleNumber?: string;
  source?: string;
  unit?: { id: string; label: string };
  expectedArrival?: string;
  entryTime?: string;
  createdAt?: string;
  hasPass?: boolean;
}

interface QueueActivity {
  id?: string;
  _id?: string;
  visitorName?: string;
  direction?: string;
  gateName?: string;
  at?: string;
  createdAt?: string;
  unitLabel?: string;
  [key: string]: unknown;
}

interface GateQueue {
  awaitingApproval: QueueVisitor[];
  approvedNotEntered: QueueVisitor[];
  inside: QueueVisitor[];
  recentActivity: QueueActivity[];
  counts: Record<string, number>;
}

interface ScanOutcome {
  ok: boolean;
  title: string;
  detail?: string;
  code?: string;
  visitorName?: string;
  unitLabel?: string;
  vehicleNumber?: string;
  decision?: string;
}

const MODES = ['VISITOR', 'VEHICLE', 'STAFF', 'AMENITY_BOOKING', 'SOCIETY_ACCESS'] as const;
const ACTIONS = ['CHECK_IN', 'CHECK_OUT'] as const;

/**
 * Gate console (§57).
 *
 * Paste or scan a pass token and the server decides — signature, expiry, society match, validity
 * window and remaining entries are all checked there, atomically. This screen only renders the
 * verdict; it never makes the admission decision itself.
 */
export function GateConsolePage() {
  const { who } = useSession();
  const toast = useToast();
  const timezone = who?.society?.timezone;

  const [token, setToken] = useState('');
  const [mode, setMode] = useState<(typeof MODES)[number]>('VISITOR');
  const [action, setAction] = useState<(typeof ACTIONS)[number]>('CHECK_IN');
  const [gateId, setGateId] = useState('');
  const [scanning, setScanning] = useState(false);
  const [outcome, setOutcome] = useState<ScanOutcome | null>(null);

  const gates = useList<Gate>('/gates', { limit: 50 }, []);
  const queue = useResource<GateQueue>('/gate/queue');
  const [busyId, setBusyId] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const queueReload = queue.reload;

  // A hardware scanner acts as a keyboard and ends with Enter, so keep focus on the field.
  useEffect(() => {
    inputRef.current?.focus();
  }, [outcome]);

  const scan = useCallback(
    async (rawToken?: string) => {
      const value = (rawToken ?? token).trim();
      if (!value) return;
      setScanning(true);
      setOutcome(null);
      try {
        const result = await api.post<Record<string, unknown>>('/gate/scan', {
          token: value,
          mode,
          action,
          gateId: gateId || undefined,
        });
        const visitor = (result.visitor ?? result.pass ?? {}) as Record<string, unknown>;
        const unit = (visitor.unit ?? result.unit ?? {}) as Record<string, unknown>;
        setOutcome({
          ok: true,
          title: action === 'CHECK_IN' ? 'Entry recorded' : 'Exit recorded',
          detail: typeof result.message === 'string' ? result.message : undefined,
          decision: typeof result.decision === 'string' ? result.decision : undefined,
          visitorName: typeof visitor.name === 'string' ? visitor.name : (visitor.visitorName as string | undefined),
          unitLabel: typeof unit.label === 'string' ? unit.label : (result.unitLabel as string | undefined),
          vehicleNumber: typeof visitor.vehicleNumber === 'string' ? visitor.vehicleNumber : undefined,
        });
        setToken('');
        queueReload();
      } catch (err) {
        const apiError = err instanceof ApiError ? err : null;
        setOutcome({
          ok: false,
          title: titleForCode(apiError?.code),
          detail: apiError?.message ?? (err instanceof Error ? err.message : 'Scan failed'),
          code: apiError?.code,
        });
      } finally {
        setScanning(false);
        inputRef.current?.focus();
      }
    },
    [token, mode, action, gateId, queueReload],
  );

  async function decide(visitor: QueueVisitor, decision: 'APPROVE' | 'DENY') {
    setBusyId(visitor.id);
    try {
      await api.post(`/visitors/${visitor.id}/decide`, { decision });
      toast.success(decision === 'APPROVE' ? `${visitor.visitorName} approved` : `${visitor.visitorName} denied`);
      queueReload();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusyId(null);
    }
  }

  async function checkInOut(visitor: QueueVisitor, direction: 'check-in' | 'check-out') {
    setBusyId(visitor.id);
    try {
      await api.post(`/visitors/${visitor.id}/${direction}`, {});
      toast.success(`${visitor.visitorName} ${direction === 'check-in' ? 'checked in' : 'checked out'}`);
      queueReload();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusyId(null);
    }
  }

  const q = queue.data;
  const counts = q?.counts ?? {};

  return (
    <div className="stack">
      <div className="grid grid--3">
        <Card title="Scan a pass" subtitle="Signature, expiry and validity are verified server-side">
          <Field label="Pass token" hint="Paste the token, or use a hardware scanner.">
            <Input
              ref={inputRef}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void scan();
                }
              }}
              placeholder="CLNZ1.…"
              className="mono"
              disabled={scanning}
            />
          </Field>
          <div className="form-row">
            <Field label="Pass kind">
              <Select value={mode} onChange={(e) => setMode(e.target.value as (typeof MODES)[number])}>
                {MODES.map((m) => (
                  <option key={m} value={m}>
                    {m.split('_').map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(' ')}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Movement">
              <Select value={action} onChange={(e) => setAction(e.target.value as (typeof ACTIONS)[number])}>
                {ACTIONS.map((a) => (
                  <option key={a} value={a}>
                    {a === 'CHECK_IN' ? 'Entry' : 'Exit'}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Gate" hint="Optional — defaults to the guard's assigned gate.">
            <Select value={gateId} onChange={(e) => setGateId(e.target.value)}>
              <option value="">Auto-detect</option>
              {gates.page.items.map((gate) => (
                <option key={gate._id} value={gate._id}>
                  {gate.name}
                  {gate.code ? ` (${gate.code})` : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Button variant="primary" className="btn--block" busy={scanning} onClick={() => void scan()} disabled={!token.trim()}>
            {action === 'CHECK_IN' ? 'Record entry' : 'Record exit'}
          </Button>

          {outcome ? (
            <div style={{ marginTop: 14 }}>
              <Alert tone={outcome.ok ? 'success' : 'danger'}>
                <b>{outcome.title}</b>
                {outcome.detail ? <div style={{ marginTop: 3 }}>{outcome.detail}</div> : null}
                {outcome.visitorName ? <div style={{ marginTop: 6 }}>Visitor: {outcome.visitorName}</div> : null}
                {outcome.unitLabel ? <div>Unit: {outcome.unitLabel}</div> : null}
                {outcome.vehicleNumber ? <div>Vehicle: {outcome.vehicleNumber}</div> : null}
                {outcome.code ? (
                  <div className="mono" style={{ marginTop: 6, opacity: 0.8 }}>
                    {outcome.code}
                  </div>
                ) : null}
              </Alert>
            </div>
          ) : null}
        </Card>

        <div className="grid" style={{ gridColumn: 'span 2', gap: 16 }}>
          <div className="tiles">
            <Tile label="Awaiting approval" value={number(counts.awaitingApproval ?? q?.awaitingApproval?.length ?? 0)} tone="warning" />
            <Tile label="Approved, not entered" value={number(counts.approvedNotEntered ?? q?.approvedNotEntered?.length ?? 0)} tone="brand" />
            <Tile label="Inside" value={number(counts.inside ?? q?.inside?.length ?? 0)} tone="success" />
            <Tile label="Recent movements" value={number(q?.recentActivity?.length ?? 0)} />
          </div>

          <Card
            title="Awaiting a decision"
            subtitle="Unannounced visitors waiting for the resident to respond"
            flush
          >
            {queue.loading ? (
              <Loading />
            ) : (q?.awaitingApproval?.length ?? 0) === 0 ? (
              <EmptyState title="Nobody is waiting" hint="Unannounced visitors appear here for approval." />
            ) : (
              <DataTable
                rows={q!.awaitingApproval}
                rowKey={(v) => v.id}
                columns={[
                  {
                    key: 'who',
                    header: 'Visitor',
                    render: (v) => (
                      <div>
                        <b>{v.visitorName}</b>
                        <div className="faint small">
                          {v.purpose} · {number(v.numberOfVisitors ?? 1)} person
                        </div>
                      </div>
                    ),
                  },
                  { key: 'unit', header: 'Unit', render: (v) => v.unit?.label ?? '—' },
                  {
                    key: 'since',
                    header: 'Waiting',
                    align: 'right',
                    render: (v) => <span className="small muted">{ago(v.createdAt ?? v.expectedArrival)}</span>,
                  },
                  {
                    key: 'act',
                    header: '',
                    align: 'right',
                    render: (v) => (
                      <div className="table__actions">
                        <Button size="sm" variant="primary" busy={busyId === v.id} onClick={() => decide(v, 'APPROVE')}>
                          Approve
                        </Button>
                        <Button size="sm" busy={busyId === v.id} onClick={() => decide(v, 'DENY')}>
                          Deny
                        </Button>
                      </div>
                    ),
                  },
                ]}
              />
            )}
          </Card>
        </div>
      </div>

      {queue.error ? <ErrorAlert error={queue.error} /> : null}

      <div className="grid grid--2">
        <Card title="Inside the society" subtitle="Checked in and not yet out" flush>
          {(q?.inside?.length ?? 0) === 0 ? (
            <EmptyState title="Nobody inside" />
          ) : (
            <DataTable
              rows={q!.inside}
              rowKey={(v) => v.id}
              columns={[
                {
                  key: 'who',
                  header: 'Visitor',
                  render: (v) => (
                    <div>
                      <b>{v.visitorName}</b>
                      <div className="faint small">
                        {v.visitorType} · {v.unit?.label ?? '—'}
                      </div>
                    </div>
                  ),
                },
                { key: 'vehicle', header: 'Vehicle', render: (v) => <span className="mono small">{v.vehicleNumber || '—'}</span> },
                {
                  key: 'in',
                  header: 'Entered',
                  align: 'right',
                  render: (v) => <span className="small muted">{dateTime(v.entryTime ?? v.createdAt, timezone)}</span>,
                },
                {
                  key: 'act',
                  header: '',
                  align: 'right',
                  render: (v) => (
                    <Button size="sm" busy={busyId === v.id} onClick={() => checkInOut(v, 'check-out')}>
                      Check out
                    </Button>
                  ),
                },
              ]}
            />
          )}
        </Card>

        <Card
          title="Approved, not yet entered"
          subtitle="Pre-approved guests still expected"
          actions={<Button size="sm" variant="ghost" onClick={() => queueReload()}>Refresh</Button>}
          flush
        >
          {(q?.approvedNotEntered?.length ?? 0) === 0 ? (
            <EmptyState title="Nobody expected right now" />
          ) : (
            <DataTable
              rows={q!.approvedNotEntered}
              rowKey={(v) => v.id}
              columns={[
                { key: 'who', header: 'Visitor', render: (v) => <b>{v.visitorName}</b> },
                { key: 'unit', header: 'Unit', render: (v) => v.unit?.label ?? '—' },
                {
                  key: 'eta',
                  header: 'Expected',
                  align: 'right',
                  render: (v) => <span className="small muted">{dateTime(v.expectedArrival, timezone)}</span>,
                },
                { key: 'pass', header: 'Pass', render: (v) => (v.hasPass ? <Pill tone="success">Issued</Pill> : <Pill>None</Pill>) },
                {
                  key: 'act',
                  header: '',
                  align: 'right',
                  render: (v) => (
                    <Button size="sm" variant="primary" busy={busyId === v.id} onClick={() => checkInOut(v, 'check-in')}>
                      Check in
                    </Button>
                  ),
                },
              ]}
            />
          )}
        </Card>
      </div>

      <Card title="Recent gate activity" flush>
        {(q?.recentActivity?.length ?? 0) === 0 ? (
          <EmptyState title="No movements recorded yet" />
        ) : (
          <DataTable
            rows={q!.recentActivity.slice(0, 20)}
            rowKey={(row, i) => String(row._id ?? row.id ?? i)}
            columns={[
              { key: 'who', header: 'Visitor', render: (row) => <b>{String(row.visitorName ?? '—')}</b> },
              {
                key: 'dir',
                header: 'Movement',
                render: (row) => (
                  <Pill tone={row.direction === 'IN' ? 'success' : 'info'}>
                    {row.direction === 'IN' ? 'Entry' : row.direction === 'OUT' ? 'Exit' : String(row.direction ?? '—')}
                  </Pill>
                ),
              },
              { key: 'gate', header: 'Gate', render: (row) => String(row.gateName ?? '—') },
              { key: 'unit', header: 'Unit', render: (row) => String(row.unitLabel ?? '—') },
              {
                key: 'at',
                header: 'When',
                align: 'right',
                render: (row) => <span className="small muted">{ago(String(row.at ?? row.createdAt ?? ''))}</span>,
              },
            ]}
          />
        )}
      </Card>
    </div>
  );
}

function Tile({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: string }) {
  return (
    <div className={tone === 'neutral' ? 'tile' : `tile tile--${tone}`}>
      <div className="tile__label">{label}</div>
      <div className="tile__value">{value}</div>
    </div>
  );
}

function titleForCode(code?: string): string {
  switch (code) {
    case 'QR_INVALID':
      return 'Not a valid Colonize pass';
    case 'QR_EXPIRED':
      return 'This pass has expired';
    case 'QR_ALREADY_USED':
      return 'This pass was already used';
    case 'QR_NOT_YET_VALID':
      return 'This pass is not valid yet';
    case 'QR_WRONG_SOCIETY':
      return 'This pass belongs to another society';
    case 'FORBIDDEN':
      return 'You are not allowed to scan here';
    default:
      return 'Scan rejected';
  }
}
