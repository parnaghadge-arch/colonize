import { useMemo, useState } from 'react';
import { useResource } from '../lib/useResource.ts';
import {
  Alert,
  Button,
  Card,
  DataTable,
  EmptyState,
  ErrorAlert,
  Input,
  KeyValue,
  Loading,
  Pill,
  Select,
  useToast,
} from '../components/ui.tsx';
import { day, label, money, number, percent } from '../lib/format.ts';
import { useSession } from '../lib/session.tsx';

/* ------------------------------- response shapes ---------------------------- */

interface BillsSummary {
  period?: string;
  bills?: number;
  billed?: number;
  collected?: number;
  outstanding?: number;
  waived?: number;
  collectionPercent?: number;
  byStatus?: Record<string, number>;
}

interface PaymentsSummary {
  from?: string;
  to?: string;
  transactions?: number;
  collected?: number;
  failed?: number;
  refunded?: number;
  byMode?: Record<string, { count?: number; amount?: number }>;
  byPurpose?: Record<string, { count?: number; amount?: number }>;
}

interface ComplaintStats {
  days?: number;
  total?: number;
  open?: number;
  closed?: number;
  slaBreached?: number;
  slaCompliancePercent?: number;
  averageRating?: number | null;
  averageResolutionHours?: number | null;
  byStatus?: Record<string, number>;
  byCategory?: Record<string, number>;
  byPriority?: Record<string, number>;
}

interface VisitorsSummary {
  days?: number;
  total?: number;
  currentlyInside?: number;
  byStatus?: Record<string, number>;
  byType?: Record<string, number>;
  byGate?: { gateId?: string; gate?: string; direction?: string; count?: number }[];
}

interface IncomeStatement {
  from?: string;
  to?: string;
  income?: { name?: string; amount?: number }[];
  expense?: { name?: string; amount?: number }[];
  totals?: { income?: number; expense?: number; net?: number };
}

interface TrialBalance {
  rows?: { ledgerId?: string; ledgerName?: string; name?: string; code?: string; debit?: number; credit?: number; balance?: number }[];
  totalDebit?: number;
  totalCredit?: number;
  balanced?: boolean;
}

interface AmenityUsage {
  _id: string;
  name?: string;
  type?: string;
  capacity?: number | null;
  bookingFee?: number | null;
  totalBookings?: number;
  totalRevenue?: number;
  isActive?: boolean;
}

interface DefaulterRow {
  unitId?: string;
  unitLabel?: string;
  buildingId?: string;
  totalDue?: number;
  billCount?: number;
  daysOverdue?: number;
  oldestDueDate?: string;
  periods?: string[];
}

interface DefaultersResponse {
  defaulters?: DefaulterRow[];
  count?: number;
}

/* ---------------------------------- helpers --------------------------------- */

/**
 * Client-side CSV export of exactly the rows on screen.
 *
 * Reports are aggregates computed server-side; there is no `/api/reports` endpoint that streams a
 * file, so the export serialises what the page already fetched rather than pretending to download
 * something the API produced.
 */
function toCsv(filename: string, headers: string[], rows: (string | number | null | undefined)[][]): void {
  const escape = (value: string | number | null | undefined): string => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const csv = [headers.map(escape).join(','), ...rows.map((row) => row.map(escape).join(','))].join('\r\n');
  const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function monthString(offsetFromNow = 0): string {
  const date = new Date();
  date.setDate(1);
  date.setMonth(date.getMonth() + offsetFromNow);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/** Turn `{KEY: n}` into sorted `[label, n]` pairs for the bar chart. */
function entries(record: Record<string, number> | undefined): [string, number][] {
  return Object.entries(record ?? {})
    .map(([key, value]) => [label(key), Number(value ?? 0)] as [string, number])
    .sort((a, b) => b[1] - a[1]);
}

/**
 * Reports (§64).
 *
 * The backend exposes analytics per domain rather than a single reporting service, so this page
 * composes them: billing and collection summaries, payment breakdowns by mode and purpose,
 * complaint SLA performance, visitor traffic, amenity utilisation and the accounting statements.
 * Each card states the window it covers, because the domains do not all default to the same one.
 */
export function ReportsPage() {
  const { who } = useSession();
  const toast = useToast();
  const timezone = who?.society?.timezone;
  const [tab, setTab] = useState<'overview' | 'collections' | 'operations' | 'financials'>('overview');
  const [period, setPeriod] = useState(monthString());
  const [days, setDays] = useState('30');

  const bills = useResource<BillsSummary>('/bills/summary', { period }, [period]);
  const payments = useResource<PaymentsSummary>('/payments/summary', { period }, [period]);
  const complaints = useResource<ComplaintStats>('/complaints/stats', { days: Number(days) }, [days]);
  const visitors = useResource<VisitorsSummary>('/visitors/summary', { days: Number(days) }, [days]);
  const statement = useResource<IncomeStatement>('/accounting/income-statement', { period }, [period]);
  const trial = useResource<TrialBalance>('/accounting/trial-balance', {});
  const amenities = useResource<{ items: AmenityUsage[] }>('/amenities', { limit: 100 });
  const defaulters = useResource<DefaultersResponse>('/bills/defaulters', { limit: 50 });

  const anyError = bills.error ?? payments.error ?? complaints.error ?? visitors.error;

  return (
    <div className="stack">
      {anyError ? <ErrorAlert error={anyError} /> : null}

      <Card>
        <div className="toolbar">
          <label className="row" style={{ gap: 6 }}>
            <span className="small muted nowrap">Billing period</span>
            <Input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} />
          </label>
          <label className="row" style={{ gap: 6 }}>
            <span className="small muted nowrap">Operations window</span>
            <Select value={days} onChange={(e) => setDays(e.target.value)}>
              {[7, 30, 90, 180, 365].map((d) => (
                <option key={d} value={String(d)}>
                  Last {d} days
                </option>
              ))}
            </Select>
          </label>
          <div className="toolbar__spacer" />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              bills.reload();
              payments.reload();
              complaints.reload();
              visitors.reload();
              statement.reload();
              trial.reload();
              amenities.reload();
              defaulters.reload();
              toast.success('Reports refreshed');
            }}
          >
            Refresh all
          </Button>
        </div>
        <p className="small muted" style={{ marginTop: 8 }}>
          Billing and financial figures cover <b>{period}</b>. Complaint and visitor figures cover the{' '}
          <b>last {days} days</b> — those endpoints aggregate on a rolling window, not a calendar month.
        </p>
      </Card>

      <div className="login__tabs" style={{ alignSelf: 'flex-start' }}>
        {(['overview', 'collections', 'operations', 'financials'] as const).map((t) => (
          <button
            key={t}
            type="button"
            className={`login__tab${tab === t ? ' login__tab--active' : ''}`}
            onClick={() => setTab(t)}
          >
            {label(t.toUpperCase())}
          </button>
        ))}
      </div>

      {tab === 'overview' ? <Overview bills={bills} payments={payments} complaints={complaints} visitors={visitors} /> : null}
      {tab === 'collections' ? <Collections bills={bills} payments={payments} defaulters={defaulters} timezone={timezone} /> : null}
      {tab === 'operations' ? <Operations complaints={complaints} visitors={visitors} amenities={amenities} /> : null}
      {tab === 'financials' ? <Financials statement={statement} trial={trial} timezone={timezone} /> : null}
    </div>
  );
}

/* --------------------------------- overview --------------------------------- */

function Overview({
  bills,
  payments,
  complaints,
  visitors,
}: {
  bills: ReturnType<typeof useResource<BillsSummary>>;
  payments: ReturnType<typeof useResource<PaymentsSummary>>;
  complaints: ReturnType<typeof useResource<ComplaintStats>>;
  visitors: ReturnType<typeof useResource<VisitorsSummary>>;
}) {
  if (bills.loading || payments.loading || complaints.loading || visitors.loading) return <Loading />;

  const tiles = [
    { label: 'Collection rate', value: percent(bills.data?.collectionPercent ?? 0), hint: `${money(bills.data?.collected ?? 0)} of ${money(bills.data?.billed ?? 0)} billed` },
    { label: 'Outstanding', value: money(bills.data?.outstanding ?? 0), hint: `${number(bills.data?.bills ?? 0)} bills this period`, tone: (bills.data?.outstanding ?? 0) > 0 ? 'warning' : 'success' },
    { label: 'Payments received', value: money(payments.data?.collected ?? 0), hint: `${number(payments.data?.transactions ?? 0)} transactions`, tone: 'success' },
    { label: 'Refunded', value: money(payments.data?.refunded ?? 0), hint: `${number(payments.data?.failed ?? 0)} failed`, tone: (payments.data?.refunded ?? 0) > 0 ? 'danger' : undefined },
    { label: 'SLA compliance', value: percent(complaints.data?.slaCompliancePercent ?? 0), hint: `${number(complaints.data?.slaBreached ?? 0)} breached`, tone: (complaints.data?.slaCompliancePercent ?? 0) >= 90 ? 'success' : 'warning' },
    { label: 'Complaints', value: number(complaints.data?.total ?? 0), hint: `${number(complaints.data?.open ?? 0)} still open` },
    { label: 'Visitors', value: number(visitors.data?.total ?? 0), hint: `${number(visitors.data?.currentlyInside ?? 0)} inside now` },
    { label: 'Average rating', value: complaints.data?.averageRating != null ? `${Number(complaints.data.averageRating).toFixed(1)} / 5` : '—', hint: complaints.data?.averageResolutionHours != null ? `${Number(complaints.data.averageResolutionHours).toFixed(1)} h to resolve` : 'no resolutions yet' },
  ];

  return (
    <div className="stack">
      <div className="tiles">
        {tiles.map((tile) => (
          <div key={tile.label} className={`tile${tile.tone ? ` tile--${tile.tone}` : ''}`}>
            <div className="tile__label">{tile.label}</div>
            <div className="tile__value">{tile.value}</div>
            <div className="tile__hint">{tile.hint}</div>
          </div>
        ))}
      </div>

      <div className="grid grid--2">
        <Card title="Bills by status" subtitle={`Period ${bills.data?.period ?? '—'}`}>
          <Bars data={entries(bills.data?.byStatus)} empty="No bills generated for this period yet." />
        </Card>
        <Card title="Payments by mode" subtitle={`${day(payments.data?.from)} → ${day(payments.data?.to)}`}>
          <Bars
            data={Object.entries(payments.data?.byMode ?? {}).map(([key, v]) => [label(key), Number(v?.amount ?? 0)] as [string, number]).sort((a, b) => b[1] - a[1])}
            format={money}
            empty="No payments recorded in this window."
          />
        </Card>
      </div>
    </div>
  );
}

/* -------------------------------- collections ------------------------------- */

function Collections({
  bills,
  payments,
  defaulters,
  timezone,
}: {
  bills: ReturnType<typeof useResource<BillsSummary>>;
  payments: ReturnType<typeof useResource<PaymentsSummary>>;
  defaulters: ReturnType<typeof useResource<DefaultersResponse>>;
  timezone?: string;
}) {
  const toast = useToast();
  const rows = defaulters.data?.defaulters ?? [];

  const statusRows = entries(bills.data?.byStatus);
  const modeRows = Object.entries(payments.data?.byMode ?? {})
    .map(([key, v]) => [label(key), Number(v?.count ?? 0), Number(v?.amount ?? 0)] as [string, number, number])
    .sort((a, b) => b[2] - a[2]);
  const purposeRows = Object.entries(payments.data?.byPurpose ?? {})
    .map(([key, v]) => [label(key), Number(v?.count ?? 0), Number(v?.amount ?? 0)] as [string, number, number])
    .sort((a, b) => b[2] - a[2]);

  return (
    <div className="stack">
      <Card
        title="Collection summary"
        subtitle={`Period ${bills.data?.period ?? '—'}`}
        actions={
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              toCsv(`collections-${bills.data?.period ?? 'period'}.csv`, ['Metric', 'Value'], [
                ['Period', bills.data?.period ?? ''],
                ['Bills', bills.data?.bills ?? 0],
                ['Billed amount', bills.data?.billed ?? 0],
                ['Collected', bills.data?.collected ?? 0],
                ['Outstanding', bills.data?.outstanding ?? 0],
                ['Waived', bills.data?.waived ?? 0],
                ['Collection percent', bills.data?.collectionPercent ?? 0],
              ]);
              toast.success('Collection summary downloaded');
            }}
          >
            Download CSV
          </Button>
        }
      >
        {bills.loading ? <Loading /> : (
          <KeyValue
            items={[
              ['Bills', number(bills.data?.bills ?? 0)],
              ['Billed', money(bills.data?.billed ?? 0)],
              ['Collected', money(bills.data?.collected ?? 0)],
              ['Outstanding', money(bills.data?.outstanding ?? 0)],
              ['Waived', money(bills.data?.waived ?? 0)],
              ['Collection rate', percent(bills.data?.collectionPercent ?? 0)],
            ]}
          />
        )}
      </Card>

      <div className="grid grid--2">
        <Card
          title="Bills by status"
          actions={
            <Button size="sm" variant="ghost" onClick={() => { toCsv(`bills-by-status-${bills.data?.period ?? 'period'}.csv`, ['Status', 'Count'], statusRows.map(([k, v]) => [k, v])); toast.success('Downloaded'); }}>
              Download CSV
            </Button>
          }
        >
          <Bars data={statusRows} empty="No bills in this period." />
        </Card>
        <Card
          title="Payments by purpose"
          actions={
            <Button size="sm" variant="ghost" onClick={() => { toCsv(`payments-by-purpose-${period_()}.csv`, ['Purpose', 'Count', 'Amount'], purposeRows.map(([k, c, a]) => [k, c, a])); toast.success('Downloaded'); }}>
              Download CSV
            </Button>
          }
        >
          <Bars data={purposeRows.map(([k, , a]) => [k, a] as [string, number])} format={money} empty="No payments in this window." />
        </Card>
      </div>

      <Card
        title="Payments by mode"
        subtitle="How money actually arrived"
        actions={
          <Button size="sm" variant="ghost" onClick={() => { toCsv(`payments-by-mode-${period_()}.csv`, ['Mode', 'Transactions', 'Amount'], modeRows.map(([k, c, a]) => [k, c, a])); toast.success('Downloaded'); }}>
            Download CSV
          </Button>
        }
        flush
      >
        <DataTable
          rows={modeRows}
          rowKey={(r) => r[0]}
          empty={<EmptyState title="No payments" hint="Nothing recorded in this window." />}
          columns={[
            { key: 'mode', header: 'Mode', render: (r) => <b>{r[0]}</b> },
            { key: 'count', header: 'Transactions', align: 'right', render: (r) => number(r[1]) },
            { key: 'amount', header: 'Amount', align: 'right', render: (r) => money(r[2]) },
          ]}
        />
      </Card>

      <Card
        title="Defaulters"
        subtitle={`${number(defaulters.data?.count ?? rows.length)} unit${(defaulters.data?.count ?? rows.length) === 1 ? '' : 's'} with dues`}
        actions={
          <Button
            size="sm"
            variant="ghost"
            disabled={rows.length === 0}
            onClick={() => {
              toCsv('defaulters.csv', ['Unit', 'Total due', 'Bills', 'Days overdue', 'Oldest due date', 'Periods'],
                rows.map((r) => [r.unitLabel ?? r.unitId ?? '', r.totalDue ?? 0, r.billCount ?? 0, r.daysOverdue ?? 0, r.oldestDueDate ?? '', (r.periods ?? []).join(' ')]));
              toast.success('Defaulters downloaded');
            }}
          >
            Download CSV
          </Button>
        }
        flush
      >
        {defaulters.loading ? (
          <Loading />
        ) : (
          <DataTable
            rows={rows}
            rowKey={(r) => String(r.unitId ?? r.unitLabel)}
            empty={<EmptyState title="No defaulters" hint="Every unit is up to date." />}
            columns={[
              { key: 'unit', header: 'Unit', render: (r) => <b>{r.unitLabel ?? r.unitId ?? '—'}</b> },
              { key: 'due', header: 'Total due', align: 'right', render: (r) => money(r.totalDue ?? 0) },
              { key: 'bills', header: 'Bills', align: 'right', render: (r) => number(r.billCount ?? 0) },
              {
                key: 'overdue',
                header: 'Days overdue',
                align: 'right',
                render: (r) => ((r.daysOverdue ?? 0) > 30 ? <Pill tone="danger">{number(r.daysOverdue)}</Pill> : number(r.daysOverdue ?? 0)),
              },
              { key: 'oldest', header: 'Oldest due', render: (r) => day(r.oldestDueDate, timezone) },
              { key: 'periods', header: 'Periods', render: (r) => <span className="faint small">{(r.periods ?? []).join(', ') || '—'}</span> },
            ]}
          />
        )}
      </Card>
    </div>
  );
}

/** The period is only used to name an export file; the summary itself carries the authoritative one. */
function period_(): string {
  return new Date().toISOString().slice(0, 7);
}

/* -------------------------------- operations -------------------------------- */

function Operations({
  complaints,
  visitors,
  amenities,
}: {
  complaints: ReturnType<typeof useResource<ComplaintStats>>;
  visitors: ReturnType<typeof useResource<VisitorsSummary>>;
  amenities: ReturnType<typeof useResource<{ items: AmenityUsage[] }>>;
}) {
  const toast = useToast();
  const amenityRows = useMemo(
    () =>
      (amenities.data?.items ?? [])
        .map((a) => ({ ...a, totalBookings: Number(a.totalBookings ?? 0), totalRevenue: Number(a.totalRevenue ?? 0) }))
        .sort((a, b) => b.totalBookings - a.totalBookings),
    [amenities.data],
  );

  const gateRows = visitors.data?.byGate ?? [];

  return (
    <div className="stack">
      <Card title="Complaint & SLA performance" subtitle={`Last ${number(complaints.data?.days ?? 0)} days`}>
        {complaints.loading ? <Loading /> : (
          <>
            <KeyValue
              items={[
                ['Total', number(complaints.data?.total ?? 0)],
                ['Open', number(complaints.data?.open ?? 0)],
                ['Closed', number(complaints.data?.closed ?? 0)],
                ['SLA breached', number(complaints.data?.slaBreached ?? 0)],
                ['SLA compliance', percent(complaints.data?.slaCompliancePercent ?? 0)],
                ['Average rating', complaints.data?.averageRating != null ? `${Number(complaints.data.averageRating).toFixed(2)} / 5` : '—'],
                ['Average resolution', complaints.data?.averageResolutionHours != null ? `${Number(complaints.data.averageResolutionHours).toFixed(1)} hours` : '—'],
              ]}
            />
            <Button
              size="sm"
              variant="ghost"
              className="mt"
              onClick={() => {
                toCsv('complaint-stats.csv', ['Metric', 'Value'], [
                  ['Window days', complaints.data?.days ?? 0],
                  ['Total', complaints.data?.total ?? 0],
                  ['Open', complaints.data?.open ?? 0],
                  ['Closed', complaints.data?.closed ?? 0],
                  ['SLA breached', complaints.data?.slaBreached ?? 0],
                  ['SLA compliance percent', complaints.data?.slaCompliancePercent ?? 0],
                  ['Average rating', complaints.data?.averageRating ?? ''],
                  ['Average resolution hours', complaints.data?.averageResolutionHours ?? ''],
                ]);
                toast.success('Complaint statistics downloaded');
              }}
            >
              Download CSV
            </Button>
          </>
        )}
      </Card>

      <div className="grid grid--3">
        <Card title="By status">
          <Bars data={entries(complaints.data?.byStatus)} empty="No complaints in this window." />
        </Card>
        <Card title="By category">
          <Bars data={entries(complaints.data?.byCategory)} empty="No complaints in this window." />
        </Card>
        <Card title="By priority">
          <Bars data={entries(complaints.data?.byPriority)} empty="No complaints in this window." />
        </Card>
      </div>

      <Card
        title="Visitor traffic"
        subtitle={`Last ${number(visitors.data?.days ?? 0)} days`}
        actions={
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              toCsv('visitor-traffic.csv', ['Gate', 'Direction', 'Count'], gateRows.map((g) => [g.gate ?? g.gateId ?? '', g.direction ?? '', g.count ?? 0]));
              toast.success('Visitor traffic downloaded');
            }}
          >
            Download CSV
          </Button>
        }
      >
        {visitors.loading ? <Loading /> : (
          <>
            <KeyValue
              items={[
                ['Total visits', number(visitors.data?.total ?? 0)],
                ['Currently inside', number(visitors.data?.currentlyInside ?? 0)],
              ]}
            />
            <div className="grid grid--2 mt">
              <div>
                <h4 className="small muted">By status</h4>
                <Bars data={entries(visitors.data?.byStatus)} empty="No visits recorded." />
              </div>
              <div>
                <h4 className="small muted">By visitor type</h4>
                <Bars data={entries(visitors.data?.byType)} empty="No visits recorded." />
              </div>
            </div>
            {gateRows.length > 0 ? (
              <div className="mt">
                <h4 className="small muted">By gate and direction</h4>
                <DataTable
                  rows={gateRows}
                  rowKey={(g) => `${g.gateId ?? ''}-${g.direction ?? ''}`}
                  columns={[
                    { key: 'gate', header: 'Gate', render: (g) => g.gate ?? g.gateId ?? '—' },
                    { key: 'direction', header: 'Direction', render: (g) => (g.direction === 'IN' ? <Pill tone="success">Entry</Pill> : <Pill tone="warning">Exit</Pill>) },
                    { key: 'count', header: 'Movements', align: 'right', render: (g) => number(g.count ?? 0) },
                  ]}
                />
              </div>
            ) : null}
          </>
        )}
      </Card>

      <Card
        title="Amenity utilisation"
        subtitle="Lifetime totals held on each amenity record"
        actions={
          <Button
            size="sm"
            variant="ghost"
            disabled={amenityRows.length === 0}
            onClick={() => {
              toCsv('amenity-utilisation.csv', ['Amenity', 'Type', 'Capacity', 'Booking fee', 'Total bookings', 'Total revenue', 'Active'],
                amenityRows.map((a) => [a.name ?? '', label(a.type ?? ''), a.capacity ?? '', a.bookingFee ?? 0, a.totalBookings, a.totalRevenue, a.isActive ? 'yes' : 'no']));
              toast.success('Amenity utilisation downloaded');
            }}
          >
            Download CSV
          </Button>
        }
        flush
      >
        {amenities.loading ? (
          <Loading />
        ) : (
          <DataTable
            rows={amenityRows}
            rowKey={(a) => a._id}
            empty={<EmptyState title="No amenities" hint="Add an amenity to track its utilisation." />}
            columns={[
              { key: 'name', header: 'Amenity', render: (a) => <b>{a.name ?? '—'}</b> },
              { key: 'type', header: 'Type', render: (a) => label(a.type ?? '') },
              { key: 'capacity', header: 'Capacity', align: 'right', render: (a) => number(a.capacity ?? 0) },
              { key: 'fee', header: 'Booking fee', align: 'right', render: (a) => (Number(a.bookingFee ?? 0) > 0 ? money(a.bookingFee) : <Pill tone="success">Free</Pill>) },
              { key: 'bookings', header: 'Bookings', align: 'right', render: (a) => number(a.totalBookings) },
              { key: 'revenue', header: 'Revenue', align: 'right', render: (a) => money(a.totalRevenue) },
              { key: 'active', header: 'Active', render: (a) => (a.isActive ? <Pill tone="success">Active</Pill> : <Pill>Hidden</Pill>) },
            ]}
          />
        )}
      </Card>
    </div>
  );
}

/* -------------------------------- financials -------------------------------- */

function Financials({
  statement,
  trial,
  timezone,
}: {
  statement: ReturnType<typeof useResource<IncomeStatement>>;
  trial: ReturnType<typeof useResource<TrialBalance>>;
  timezone?: string;
}) {
  const toast = useToast();
  const income = statement.data?.income ?? [];
  const expense = statement.data?.expense ?? [];
  const totalIncome = statement.data?.totals?.income ?? income.reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
  const totalExpense = statement.data?.totals?.expense ?? expense.reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
  const net = statement.data?.totals?.net ?? totalIncome - totalExpense;
  const rows = trial.data?.rows ?? [];

  return (
    <div className="stack">
      {trial.data && !trial.data.balanced ? (
        <Alert tone="danger">
          The trial balance does not balance: debits {money(trial.data.totalDebit ?? 0)} against credits{' '}
          {money(trial.data.totalCredit ?? 0)}. Every posting is written as a balanced journal entry,
          so a difference here means a ledger was edited or a posting failed mid-transaction —
          investigate before closing the books.
        </Alert>
      ) : null}

      <Card
        title="Income statement"
        subtitle={`${day(statement.data?.from, timezone)} → ${day(statement.data?.to, timezone)}`}
        actions={
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              toCsv('income-statement.csv', ['Side', 'Ledger', 'Amount'], [
                ...income.map((r) => ['Income', r.name ?? '', r.amount ?? 0] as (string | number)[]),
                ['Income', 'TOTAL', totalIncome],
                ...expense.map((r) => ['Expense', r.name ?? '', r.amount ?? 0] as (string | number)[]),
                ['Expense', 'TOTAL', totalExpense],
                ['Net', 'SURPLUS / (DEFICIT)', net],
              ]);
              toast.success('Income statement downloaded');
            }}
          >
            Download CSV
          </Button>
        }
      >
        {statement.loading ? <Loading /> : (
          <div className="grid grid--2">
            <div>
              <h4 className="small muted">Income</h4>
              <Bars data={income.filter((r) => Number(r.amount ?? 0) !== 0).map((r) => [String(r.name ?? '—'), Number(r.amount ?? 0)] as [string, number])} format={money} tone="success" empty="No income posted in this window." />
              <div className="row row--between mt">
                <b>Total income</b>
                <b>{money(totalIncome)}</b>
              </div>
            </div>
            <div>
              <h4 className="small muted">Expenses</h4>
              <Bars data={expense.filter((r) => Number(r.amount ?? 0) !== 0).map((r) => [String(r.name ?? '—'), Number(r.amount ?? 0)] as [string, number])} format={money} tone="danger" empty="No expenses posted in this window." />
              <div className="row row--between mt">
                <b>Total expense</b>
                <b>{money(totalExpense)}</b>
              </div>
            </div>
          </div>
        )}
        <div className={`row row--between mt ${net < 0 ? '' : ''}`}>
          <b>Net {net < 0 ? 'deficit' : 'surplus'}</b>
          <Pill tone={net < 0 ? 'danger' : 'success'}>{money(net)}</Pill>
        </div>
      </Card>

      <Card
        title="Trial balance"
        subtitle="Every ledger's closing debit or credit position"
        actions={
          <Button
            size="sm"
            variant="ghost"
            disabled={rows.length === 0}
            onClick={() => {
              toCsv('trial-balance.csv', ['Ledger', 'Code', 'Debit', 'Credit', 'Balance'],
                rows.map((r) => [r.ledgerName ?? r.name ?? '', r.code ?? '', r.debit ?? 0, r.credit ?? 0, r.balance ?? 0]));
              toast.success('Trial balance downloaded');
            }}
          >
            Download CSV
          </Button>
        }
        flush
      >
        {trial.loading ? (
          <Loading />
        ) : (
          <>
            <DataTable
              rows={rows}
              rowKey={(r, index) => String(r.ledgerId ?? r.code ?? r.ledgerName ?? index)}
              empty={<EmptyState title="No ledgers" hint="Nothing has been posted yet." />}
              columns={[
                { key: 'ledger', header: 'Ledger', render: (r) => r.ledgerName ?? r.name ?? '—' },
                { key: 'code', header: 'Code', render: (r) => <code className="small">{r.code ?? '—'}</code> },
                { key: 'debit', header: 'Debit', align: 'right', render: (r) => (Number(r.debit ?? 0) > 0 ? money(r.debit) : <span className="faint">—</span>) },
                { key: 'credit', header: 'Credit', align: 'right', render: (r) => (Number(r.credit ?? 0) > 0 ? money(r.credit) : <span className="faint">—</span>) },
                { key: 'balance', header: 'Balance', align: 'right', render: (r) => money(r.balance ?? 0) },
              ]}
            />
            <div className="card__foot row row--between">
              <span>
                <b>Debits</b> {money(trial.data?.totalDebit ?? 0)}
              </span>
              <span>
                <b>Credits</b> {money(trial.data?.totalCredit ?? 0)}
              </span>
              <Pill tone={trial.data?.balanced ? 'success' : 'danger'}>{trial.data?.balanced ? 'Balanced' : 'Out of balance'}</Pill>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

/* ---------------------------------- charts ---------------------------------- */

/**
 * Horizontal bars drawn with CSS.
 *
 * Deliberately not a charting library: the reports are small categorical breakdowns, and pulling in
 * a chart dependency for eight bars costs more than it adds.
 */
function Bars({
  data,
  format = number,
  tone,
  empty,
}: {
  data: [string, number][];
  format?: (value: number) => string;
  tone?: 'success' | 'warning' | 'danger';
  empty?: string;
}) {
  if (data.length === 0) return <p className="faint small">{empty ?? 'No data.'}</p>;
  const max = Math.max(...data.map(([, value]) => Math.abs(value)), 1);
  return (
    <div className="bars">
      {data.map(([key, value]) => (
        <div key={key} className="bars__row">
          <span className="small nowrap" title={key}>
            {key}
          </span>
          <span className="bars__track">
            <span
              className={`bars__fill${tone ? ` bars__fill--${tone}` : ''}`}
              style={{ width: `${Math.max(2, (Math.abs(value) / max) * 100)}%`, display: 'block' }}
            />
          </span>
          <b className="small nowrap right">{format(value)}</b>
        </div>
      ))}
    </div>
  );
}
