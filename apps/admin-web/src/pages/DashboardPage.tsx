import { Link } from 'react-router-dom';
import { useSession } from '../lib/session.tsx';
import { useResource, useList } from '../lib/useResource.ts';
import { Card, DataTable, Loading, Pill, StatusPill, EmptyState, ErrorAlert } from '../components/ui.tsx';
import { ago, day, money, number, percent } from '../lib/format.ts';
import type { Complaint, StructureCounts } from '../lib/types.ts';

interface VisitorSummary {
  days: number;
  total: number;
  currentlyInside: number;
  byStatus: Record<string, number>;
  byType: Record<string, number>;
  byGate: Array<{ gateId: string; gate: string; direction: string; count: number }>;
}

interface PaymentSummary {
  from: string;
  to: string;
  transactions: number;
  collected: number;
  failed: number;
  refunded: number;
  byPurpose: Record<string, { count: number; amount: number }>;
  billing?: {
    bills: number;
    billed: number;
    collected: number;
    outstanding: number;
    collectionPercent: number;
  };
}

/** The exact row shape `/bills/defaulters` builds — note it is NOT a paginated `items` list. */
interface DefaulterRow {
  unitId: string;
  unitLabel: string | null;
  buildingId: string | null;
  totalDue: number;
  billCount: number;
  oldestDueDate: string;
  daysOverdue: number;
  periods: string[];
}

export function DashboardPage() {
  const { who } = useSession();
  const timezone = who?.society?.timezone;

  const counts = useResource<StructureCounts>('/structure/counts');
  const visitors = useResource<VisitorSummary>('/visitors/summary');
  const payments = useResource<PaymentSummary>('/payments/summary');
  const complaints = useList<Complaint>('/complaints', { limit: 6 });
  const defaulters = useResource<{ defaulters: DefaulterRow[]; count: number }>('/bills/defaulters', { limit: 6 });

  if (counts.loading && payments.loading) return <Loading label="Loading your society…" />;

  const c = counts.data;
  const p = payments.data;
  const v = visitors.data;
  const recentComplaints = complaints.page.items;
  const defaulterRows = defaulters.data?.defaulters ?? [];

  return (
    <div className="stack">
      {counts.error ? <ErrorAlert error={counts.error} /> : null}

      <div className="tiles">
        <Tile label="Units" value={number(c?.total)} hint={`${number(c?.occupied)} occupied · ${number(c?.vacant)} vacant`} tone="brand" />
        <Tile
          label="Collected (30 days)"
          value={money(p?.collected ?? 0)}
          hint={`${number(p?.transactions)} transactions`}
          tone="success"
        />
        <Tile
          label="Outstanding"
          value={money(p?.billing?.outstanding ?? 0)}
          hint={`${percent(p?.billing?.collectionPercent ?? 0)} collected`}
          tone={(p?.billing?.outstanding ?? 0) > 0 ? 'warning' : 'neutral'}
        />
        <Tile
          label="Visitors inside now"
          value={number(v?.currentlyInside ?? 0)}
          hint={`${number(v?.total ?? 0)} in the last ${v?.days ?? 30} days`}
          tone="neutral"
        />
      </div>

      <div className="grid grid--2">
        <Card
          title="Recent complaints"
          subtitle="Newest first"
          actions={
            <Link to="/complaints" className="btn btn--sm">
              Open complaints
            </Link>
          }
          flush
        >
          {complaints.loading ? (
            <Loading />
          ) : recentComplaints.length === 0 ? (
            <EmptyState title="No complaints raised" hint="When a resident raises one it appears here." />
          ) : (
            <DataTable
              rows={recentComplaints}
              columns={[
                { key: 'ref', header: 'Ref', render: (r) => <code>{r.referenceNumber ?? r._id.slice(0, 10)}</code> },
                { key: 'title', header: 'Complaint', render: (r) => <ComplaintCell row={r} /> },
                { key: 'status', header: 'Status', render: (r) => <StatusPill status={r.status} /> },
                { key: 'when', header: 'Raised', align: 'right', render: (r) => <span className="faint small">{ago(r.createdAt)}</span> },
              ]}
            />
          )}
        </Card>

        <Card
          title="Outstanding balances"
          subtitle="Units with unpaid bills"
          actions={
            <Link to="/bills" className="btn btn--sm">
              Open bills
            </Link>
          }
          flush
        >
          {defaulters.loading ? (
            <Loading />
          ) : defaulterRows.length === 0 ? (
            <EmptyState title="No outstanding balances" hint="Every bill is settled." />
          ) : (
            <DataTable
              rows={defaulterRows}
              columns={[
                {
                  key: 'unit',
                  header: 'Unit',
                  render: (r) => <b>{r.unitLabel ?? r.unitId}</b>,
                },
                {
                  key: 'bills',
                  header: 'Bills',
                  align: 'right',
                  render: (r) => number(r.billCount),
                },
                {
                  key: 'oldest',
                  header: 'Oldest due',
                  align: 'right',
                  render: (r) => <span className="small muted">{day(r.oldestDueDate, timezone)}</span>,
                },
                {
                  key: 'amount',
                  header: 'Outstanding',
                  align: 'right',
                  render: (r) => (
                    <span title={`${r.daysOverdue} days overdue · periods ${r.periods.join(', ')}`}>
                      <b>{money(r.totalDue)}</b>
                      <span className="faint small"> · {r.daysOverdue}d late</span>
                    </span>
                  ),
                },
              ]}
            />
          )}
        </Card>
      </div>

      <div className="grid grid--2">
        <Card title="Occupancy" subtitle="Across every unit in the society">
          {c ? <OccupancyBreakdown counts={c} /> : <EmptyState title="No structure data" />}
        </Card>

        <Card title="Collections by purpose" subtitle={`${day(p?.from, timezone)} — ${day(p?.to, timezone)}`}>
          {p && Object.keys(p.byPurpose ?? {}).length > 0 ? (
            <table className="table">
              <thead>
                <tr>
                  <th>Purpose</th>
                  <th className="num">Payments</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(p.byPurpose).map(([purpose, row]) => (
                  <tr key={purpose}>
                    <td>{purpose.split('_').map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(' ')}</td>
                    <td className="num">{number(row.count)}</td>
                    <td className="num">{money(row.amount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>Total</td>
                  <td className="num">{number(p.transactions)}</td>
                  <td className="num">{money(p.collected)}</td>
                </tr>
              </tfoot>
            </table>
          ) : (
            <EmptyState title="No payments recorded yet" hint="Collections appear here once residents start paying." />
          )}
        </Card>
      </div>

      <Card title="Gate activity" subtitle={`Visitor movements in the last ${v?.days ?? 30} days`}>
        {v && v.byGate && v.byGate.length > 0 ? (
          <DataTable
            rows={v.byGate.map((g, i) => ({ ...g, _id: `${g.gateId}-${g.direction}-${i}` }))}
            columns={[
              { key: 'gate', header: 'Gate', render: (r) => <b>{r.gate}</b> },
              {
                key: 'direction',
                header: 'Direction',
                render: (r) => <Pill tone={r.direction === 'IN' ? 'success' : 'info'}>{r.direction === 'IN' ? 'Entry' : 'Exit'}</Pill>,
              },
              { key: 'count', header: 'Movements', align: 'right', render: (r) => number(r.count) },
            ]}
          />
        ) : (
          <EmptyState title="No gate activity yet" />
        )}
      </Card>
    </div>
  );
}

function Tile({ label, value, hint, tone = 'neutral' }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <div className={tone === 'neutral' ? 'tile' : `tile tile--${tone}`}>
      <div className="tile__label">{label}</div>
      <div className="tile__value">{value}</div>
      {hint ? <div className="tile__hint">{hint}</div> : null}
    </div>
  );
}

function ComplaintCell({ row }: { row: Complaint }) {
  return (
    <div>
      <div>{row.title}</div>
      <div className="faint small">
        {row.category?.split('_').map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(' ')}
        {row.unitLabel ? ` · ${row.unitLabel}` : ''}
      </div>
    </div>
  );
}

function OccupancyBreakdown({ counts }: { counts: StructureCounts }) {
  const rows = Object.entries(counts.byOccupancy ?? {});
  const total = counts.total || 1;
  return (
    <div className="stack" style={{ gap: 10 }}>
      {rows.map(([kind, value]) => (
        <div key={kind}>
          <div className="row row--between small">
            <span>{kind.split('_').map((w) => w.charAt(0) + w.slice(1).toLowerCase()).join(' ')}</span>
            <span className="muted">
              {number(value)} · {percent((value / total) * 100)}
            </span>
          </div>
          <div style={{ height: 7, background: 'var(--surface-2)', borderRadius: 99, marginTop: 4, overflow: 'hidden' }}>
            <div
              style={{
                width: `${Math.min(100, (value / total) * 100)}%`,
                height: '100%',
                background: 'var(--brand)',
                borderRadius: 99,
              }}
            />
          </div>
        </div>
      ))}
      {counts.vacant > 0 ? (
        <p className="small muted">
          {number(counts.vacant)} vacant · {number(counts.locked)} locked ·{' '}
          {number(counts.underMaintenance)} under maintenance
        </p>
      ) : null}
    </div>
  );
}
