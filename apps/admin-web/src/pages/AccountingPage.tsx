import { useMemo, useState, type FormEvent } from 'react';
import { api } from '../lib/api.ts';
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
  Modal,
  Pagination,
  Pill,
  Select,
  Textarea,
  useToast,
} from '../components/ui.tsx';
import { day, label, money } from '../lib/format.ts';
import { useSession } from '../lib/session.tsx';

const LEDGER_TYPES = [
  'MAINTENANCE_INCOME', 'WATER_INCOME', 'PARKING_INCOME', 'AMENITY_INCOME', 'EVENT_INCOME',
  'INTEREST_INCOME', 'OTHER_INCOME', 'VENDOR_EXPENSE', 'ELECTRICITY_EXPENSE', 'SECURITY_EXPENSE',
  'HOUSEKEEPING_EXPENSE', 'REPAIR_EXPENSE', 'ADMINISTRATIVE_EXPENSE', 'SALARY_EXPENSE',
  'OTHER_EXPENSE', 'ASSET', 'LIABILITY',
];
const LEDGER_GROUPS = ['INCOME', 'EXPENSE', 'ASSET', 'LIABILITY', 'EQUITY'];

interface Ledger {
  _id: string;
  name: string;
  code?: string | null;
  type: string;
  group: string;
  openingBalance?: number;
  currentBalance?: number;
  isSystem?: boolean;
  isActive?: boolean;
  description?: string | null;
}

interface TrialBalanceRow {
  ledgerId: string;
  name: string;
  code?: string | null;
  type: string;
  group: string;
  openingBalance: number;
  debit: number;
  credit: number;
  closingBalance: number;
}

interface StatementLine {
  name: string;
  amount: number;
}

interface JournalEntry {
  _id: string;
  entryNumber?: string;
  date: string;
  narration: string;
  referenceType?: string | null;
  referenceId?: string | null;
  totalDebit: number;
  totalCredit: number;
  isPosted?: boolean;
  postedAt?: string | null;
  reversedByEntryId?: string | null;
  reversesEntryId?: string | null;
  lines?: Array<{ _id?: string; ledgerId: string; ledgerName?: string; type: string; amount: number; note?: string }>;
}

type Tab = 'statements' | 'ledgers' | 'journal' | 'expenses';

/**
 * Accounting (§34, §35).
 *
 * Double-entry, so the invariant that matters is that the books balance. Every screen here reads
 * the same posted journal entries: the trial balance proves debits equal credits, the income
 * statement and balance sheet are projections of them, and payments post their own entries — which
 * is why a refund has to reverse rather than delete.
 */
export function AccountingPage() {
  const [tab, setTab] = useState<Tab>('statements');

  return (
    <div className="stack">
      <div className="login__tabs" style={{ margin: 0 }}>
        {(
          [
            ['statements', 'Statements'],
            ['ledgers', 'Ledgers'],
            ['journal', 'Journal entries'],
            ['expenses', 'Expenses & income'],
          ] as Array<[Tab, string]>
        ).map(([key, title]) => (
          <button
            key={key}
            type="button"
            className={`login__tab${tab === key ? ' login__tab--active' : ''}`}
            onClick={() => setTab(key)}
          >
            {title}
          </button>
        ))}
      </div>

      {tab === 'statements' ? <Statements /> : null}
      {tab === 'ledgers' ? <Ledgers /> : null}
      {tab === 'journal' ? <Journal /> : null}
      {tab === 'expenses' ? <ExpensesAndIncome /> : null}
    </div>
  );
}

function number(value: unknown): string {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n.toLocaleString('en-IN') : '0';
}

/* -------------------------------- statements -------------------------------- */

function Statements() {
  const { who } = useSession();
  const timezone = who?.society?.timezone;
  const [asOf, setAsOf] = useState('');

  const trial = useResource<{ rows: TrialBalanceRow[]; totalDebit: number; totalCredit: number; balanced: boolean }>(
    '/accounting/trial-balance',
    asOf ? { asOf } : undefined,
    [asOf],
  );
  const profit = useResource<{ from: string; to: string; income: StatementLine[]; expense: StatementLine[]; netIncome?: number; net?: number }>(
    '/accounting/income-statement',
    asOf ? { to: asOf } : undefined,
    [asOf],
  );
  const balance = useResource<{
    asOf: string;
    assets: StatementLine[];
    liabilities: StatementLine[];
    equity?: StatementLine[];
    totalAssets: number;
    totalLiabilities?: number;
    totalEquity?: number;
  }>('/accounting/balance-sheet', asOf ? { asOf } : undefined, [asOf]);

  const rows = trial.data?.rows ?? [];
  const movement = useMemo(() => rows.filter((r) => r.debit !== 0 || r.credit !== 0), [rows]);

  const incomeTotal = (profit.data?.income ?? []).reduce((sum, line) => sum + Number(line.amount ?? 0), 0);
  const expenseTotal = (profit.data?.expense ?? []).reduce((sum, line) => sum + Number(line.amount ?? 0), 0);
  const net = profit.data?.netIncome ?? profit.data?.net ?? incomeTotal - expenseTotal;

  return (
    <div className="stack">
      <div className="toolbar">
        <Field label="As at">
          <Input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </Field>
        <div className="toolbar__spacer" />
        <Button size="sm" variant="ghost" onClick={() => { trial.reload(); profit.reload(); balance.reload(); }}>
          Recalculate
        </Button>
      </div>

      {trial.error ? <ErrorAlert error={trial.error} /> : null}

      {trial.data ? (
        <Alert tone={trial.data.balanced ? 'success' : 'danger'}>
          {trial.data.balanced
            ? `The books balance: ${money(trial.data.totalDebit)} of debits against ${money(trial.data.totalCredit)} of credits across ${number(rows.length)} ledgers.`
            : `OUT OF BALANCE — debits ${money(trial.data.totalDebit)} do not equal credits ${money(trial.data.totalCredit)}. Investigate before closing the period.`}
        </Alert>
      ) : null}

      <div className="grid grid--2">
        <Card title="Income statement" subtitle={profit.data ? `${day(profit.data.from, timezone)} — ${day(profit.data.to, timezone)}` : undefined}>
          {profit.loading ? (
            <Loading />
          ) : (
            <>
              <StatementTable title="Income" lines={profit.data?.income ?? []} total={incomeTotal} />
              <StatementTable title="Expenses" lines={profit.data?.expense ?? []} total={expenseTotal} />
              <div className="row row--between mt" style={{ borderTop: '2px solid var(--border)', paddingTop: 10 }}>
                <b>{net >= 0 ? 'Surplus' : 'Deficit'}</b>
                <b style={{ color: net >= 0 ? 'var(--success)' : 'var(--danger)' }}>{money(Math.abs(net))}</b>
              </div>
            </>
          )}
        </Card>

        <Card title="Balance sheet" subtitle={balance.data ? `As at ${day(balance.data.asOf, timezone)}` : undefined}>
          {balance.loading ? (
            <Loading />
          ) : (
            <>
              <StatementTable title="Assets" lines={balance.data?.assets ?? []} total={Number(balance.data?.totalAssets ?? 0)} />
              <StatementTable
                title="Liabilities"
                lines={balance.data?.liabilities ?? []}
                total={Number(balance.data?.totalLiabilities ?? 0)}
              />
              {balance.data?.equity?.length ? (
                <StatementTable title="Equity" lines={balance.data.equity} total={Number(balance.data?.totalEquity ?? 0)} />
              ) : null}
            </>
          )}
        </Card>
      </div>

      <Card
        title="Trial balance"
        subtitle={`${number(movement.length)} ledgers with movement · ${number(rows.length)} in total`}
        flush
      >
        {trial.loading ? (
          <Loading />
        ) : rows.length === 0 ? (
          <EmptyState title="No ledgers yet" />
        ) : (
          <DataTable
            rows={rows}
            rowKey={(r) => r.ledgerId}
            columns={[
              {
                key: 'ledger',
                header: 'Ledger',
                render: (r) => (
                  <div>
                    <b>{r.name}</b>
                    <div className="faint small">
                      {r.code ?? ''} · {label(r.group)}
                    </div>
                  </div>
                ),
              },
              { key: 'opening', header: 'Opening', align: 'right', render: (r) => money(r.openingBalance) },
              { key: 'debit', header: 'Debit', align: 'right', render: (r) => (r.debit ? money(r.debit) : <span className="faint">—</span>) },
              { key: 'credit', header: 'Credit', align: 'right', render: (r) => (r.credit ? money(r.credit) : <span className="faint">—</span>) },
              { key: 'closing', header: 'Closing', align: 'right', render: (r) => <b>{money(r.closingBalance)}</b> },
            ]}
            footer={
              <tr>
                <td>
                  <b>Totals</b>
                </td>
                <td />
                <td className="num">
                  <b>{money(trial.data?.totalDebit ?? 0)}</b>
                </td>
                <td className="num">
                  <b>{money(trial.data?.totalCredit ?? 0)}</b>
                </td>
                <td />
              </tr>
            }
          />
        )}
      </Card>
    </div>
  );
}

function StatementTable({ title, lines, total }: { title: string; lines: StatementLine[]; total: number }) {
  const nonZero = lines.filter((line) => Number(line.amount ?? 0) !== 0);
  return (
    <div className="mt">
      <div className="small muted" style={{ textTransform: 'uppercase', letterSpacing: 0.6 }}>
        {title}
      </div>
      {nonZero.length === 0 ? (
        <p className="small faint" style={{ padding: '6px 0' }}>
          Nothing posted.
        </p>
      ) : (
        nonZero.map((line) => (
          <div key={line.name} className="row row--between" style={{ padding: '5px 0', borderBottom: '1px solid var(--border)' }}>
            <span className="small">{line.name}</span>
            <span className="small">{money(line.amount)}</span>
          </div>
        ))
      )}
      <div className="row row--between" style={{ padding: '7px 0' }}>
        <b className="small">Total {title.toLowerCase()}</b>
        <b className="small">{money(total)}</b>
      </div>
    </div>
  );
}

/* --------------------------------- ledgers ---------------------------------- */

function Ledgers() {
  const { can } = useSession();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [group, setGroup] = useState('');

  // Not a paginated list: the endpoint returns the whole chart of accounts under `ledgers`.
  const resource = useResource<{ ledgers: Ledger[]; count: number }>('/accounting/ledgers');
  const ledgers = (resource.data?.ledgers ?? []).filter((l) => !group || l.group === group);

  return (
    <div className="stack">
      {resource.error ? <ErrorAlert error={resource.error} /> : null}
      <Card
        title="Chart of accounts"
        subtitle={`${number(resource.data?.count)} ledgers`}
        actions={
          can('ledger:create') ? (
            <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
              Add ledger
            </Button>
          ) : null
        }
        flush
      >
        <div className="card__body" style={{ paddingBottom: 0 }}>
          <div className="toolbar">
            <Select value={group} onChange={(e) => setGroup(e.target.value)}>
              <option value="">Every group</option>
              {LEDGER_GROUPS.map((g) => (
                <option key={g} value={g}>
                  {label(g)}
                </option>
              ))}
            </Select>
            <div className="toolbar__spacer" />
            <Button size="sm" variant="ghost" onClick={() => resource.reload()}>
              Refresh
            </Button>
          </div>
        </div>

        {resource.loading ? (
          <Loading />
        ) : ledgers.length === 0 ? (
          <EmptyState title="No ledgers" hint="System ledgers are created when the society is provisioned." />
        ) : (
          <DataTable
            rows={ledgers}
            rowKey={(l) => l._id}
            columns={[
              {
                key: 'name',
                header: 'Ledger',
                render: (l) => (
                  <div>
                    <b>{l.name}</b>
                    {l.description ? <div className="faint small">{String(l.description)}</div> : null}
                  </div>
                ),
              },
              { key: 'code', header: 'Code', render: (l) => (l.code ? <code className="small">{l.code}</code> : <span className="faint">—</span>) },
              { key: 'type', header: 'Type', render: (l) => <span className="small">{label(l.type)}</span> },
              { key: 'group', header: 'Group', render: (l) => <Pill>{label(l.group)}</Pill> },
              { key: 'opening', header: 'Opening', align: 'right', render: (l) => money(l.openingBalance ?? 0) },
              { key: 'balance', header: 'Current balance', align: 'right', render: (l) => <b>{money(l.currentBalance ?? 0)}</b> },
              {
                key: 'system',
                header: '',
                render: (l) => (l.isSystem ? <Pill tone="info">System</Pill> : null),
              },
            ]}
          />
        )}
      </Card>

      {creating ? (
        <CreateLedgerForm
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
            toast.success('Ledger added');
            resource.reload();
          }}
        />
      ) : null}
    </div>
  );
}

function CreateLedgerForm({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [group, setGroup] = useState('EXPENSE');
  const [type, setType] = useState('OTHER_EXPENSE');
  const [openingBalance, setOpening] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // The type must belong to the group, otherwise the statements cannot place the ledger.
  const typesForGroup = useMemo(() => {
    if (group === 'ASSET') return ['ASSET'];
    if (group === 'LIABILITY') return ['LIABILITY'];
    if (group === 'INCOME') return LEDGER_TYPES.filter((t) => t.endsWith('_INCOME'));
    if (group === 'EXPENSE') return LEDGER_TYPES.filter((t) => t.endsWith('_EXPENSE'));
    return LEDGER_TYPES;
  }, [group]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/accounting/ledgers', {
        name: name.trim(),
        type,
        group,
        openingBalance: openingBalance.trim() ? Number(openingBalance) : undefined,
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
      title="Add a ledger"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={submit}>
            Add ledger
          </Button>
        </>
      }
    >
      {error ? <ErrorAlert error={error} /> : null}
      <form onSubmit={submit}>
        <Field label="Ledger name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Lift maintenance contract" required autoFocus />
        </Field>
        <div className="form-row">
          <Field label="Group" required hint="Decides which statement the ledger appears on.">
            <Select
              value={group}
              onChange={(e) => {
                const next = e.target.value;
                setGroup(next);
                const allowed =
                  next === 'INCOME'
                    ? LEDGER_TYPES.filter((t) => t.endsWith('_INCOME'))
                    : next === 'EXPENSE'
                      ? LEDGER_TYPES.filter((t) => t.endsWith('_EXPENSE'))
                      : [next];
                if (!allowed.includes(type)) setType(allowed[0] ?? type);
              }}
            >
              {LEDGER_GROUPS.map((g) => (
                <option key={g} value={g}>
                  {label(g)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Type" required>
            <Select value={type} onChange={(e) => setType(e.target.value)}>
              {typesForGroup.map((t) => (
                <option key={t} value={t}>
                  {label(t)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Opening balance (₹)">
          <Input value={openingBalance} onChange={(e) => setOpening(e.target.value)} inputMode="decimal" placeholder="0" />
        </Field>
      </form>
    </Modal>
  );
}

/* --------------------------------- journal ---------------------------------- */

function Journal() {
  const { who, canAny } = useSession();
  const toast = useToast();
  const timezone = who?.society?.timezone;
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const limit = 20;

  const entries = useList<JournalEntry>('/accounting/journal-entries', { page, limit, sort: 'date', dir: 'desc' }, [page]);

  return (
    <div className="stack">
      {entries.error ? <ErrorAlert error={entries.error} /> : null}
      <Card
        title="Journal entries"
        subtitle={`${number(entries.page.total)} posted`}
        actions={
          canAny('journal:create', 'accounting:create', 'accounting:book') ? (
            <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
              New entry
            </Button>
          ) : null
        }
        flush
      >
        {entries.loading ? (
          <Loading />
        ) : entries.page.items.length === 0 ? (
          <EmptyState title="No journal entries" hint="Payments and bills post their own entries automatically." />
        ) : (
          <DataTable
            rows={entries.page.items}
            rowKey={(e) => e._id}
            columns={[
              { key: 'ref', header: 'Entry', render: (e) => <code className="small">{e.entryNumber ?? e._id.slice(0, 12)}</code> },
              { key: 'date', header: 'Date', render: (e) => day(e.date, timezone) },
              {
                key: 'narration',
                header: 'Narration',
                render: (e) => (
                  <div>
                    <b>{e.narration}</b>
                    {e.referenceType ? <div className="faint small">{label(e.referenceType)}</div> : null}
                  </div>
                ),
              },
              { key: 'debit', header: 'Debit', align: 'right', render: (e) => money(e.totalDebit) },
              { key: 'credit', header: 'Credit', align: 'right', render: (e) => money(e.totalCredit) },
              {
                key: 'balanced',
                header: '',
                render: (e) =>
                  Number(e.totalDebit) === Number(e.totalCredit) ? (
                    <Pill tone="success">Balanced</Pill>
                  ) : (
                    <Pill tone="danger">Unbalanced</Pill>
                  ),
              },
              {
                key: 'posted',
                header: 'Status',
                render: (e) =>
                  e.reversedByEntryId ? (
                    <Pill tone="warning">Reversed</Pill>
                  ) : e.isPosted ? (
                    <Pill tone="info">Posted</Pill>
                  ) : (
                    <Pill>Draft</Pill>
                  ),
              },
            ]}
          />
        )}
        <div className="card__foot">
          <Pagination page={page} limit={limit} total={entries.page.total} onPage={setPage} />
        </div>
      </Card>

      {creating ? (
        <CreateJournalEntryForm
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
            toast.success('Journal entry posted');
            entries.reload();
          }}
        />
      ) : null}
    </div>
  );
}

function CreateJournalEntryForm({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [narration, setNarration] = useState('');
  const [lines, setLines] = useState<Array<{ ledgerId: string; type: 'DEBIT' | 'CREDIT'; amount: string }>>([
    { ledgerId: '', type: 'DEBIT', amount: '' },
    { ledgerId: '', type: 'CREDIT', amount: '' },
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const ledgers = useResource<{ ledgers: Ledger[] }>('/accounting/ledgers');

  const debitTotal = lines.filter((l) => l.type === 'DEBIT').reduce((sum, l) => sum + (Number(l.amount) || 0), 0);
  const creditTotal = lines.filter((l) => l.type === 'CREDIT').reduce((sum, l) => sum + (Number(l.amount) || 0), 0);
  const balanced = debitTotal > 0 && Math.abs(debitTotal - creditTotal) < 0.005;
  const complete = lines.every((l) => l.ledgerId && Number(l.amount) > 0);

  function update(index: number, patch: Partial<(typeof lines)[number]>) {
    setLines((prev) => prev.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/accounting/journal-entries', {
        date,
        narration: narration.trim(),
        lines: lines.map((l) => ({ ledgerId: l.ledgerId, type: l.type, amount: Number(l.amount) })),
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
      title="New journal entry"
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={submit} disabled={!balanced || !complete || !narration.trim()}>
            Post entry
          </Button>
        </>
      }
    >
      {error ? <ErrorAlert error={error} /> : null}
      <form onSubmit={submit}>
        <div className="form-row">
          <Field label="Date" required>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </Field>
          <Field label="Narration" required hint="What this entry records.">
            <Input value={narration} onChange={(e) => setNarration(e.target.value)} placeholder="Opening balance for the lift contract" required />
          </Field>
        </div>

        {ledgers.loading ? <Loading /> : null}

        <div className="stack" style={{ gap: 8 }}>
          {lines.map((line, index) => (
            <div key={index} className="form-row">
              <Field label={index === 0 ? 'Ledger' : undefined}>
                <Select value={line.ledgerId} onChange={(e) => update(index, { ledgerId: e.target.value })} required>
                  <option value="">Select a ledger…</option>
                  {(ledgers.data?.ledgers ?? []).map((l) => (
                    <option key={l._id} value={l._id}>
                      {l.name} ({label(l.group)})
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={index === 0 ? 'Side' : undefined}>
                <Select value={line.type} onChange={(e) => update(index, { type: e.target.value as 'DEBIT' | 'CREDIT' })}>
                  <option value="DEBIT">Debit</option>
                  <option value="CREDIT">Credit</option>
                </Select>
              </Field>
              <Field label={index === 0 ? 'Amount (₹)' : undefined}>
                <Input value={line.amount} onChange={(e) => update(index, { amount: e.target.value })} inputMode="decimal" required />
              </Field>
              {lines.length > 2 ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setLines((prev) => prev.filter((_, i) => i !== index))}
                >
                  Remove
                </Button>
              ) : null}
            </div>
          ))}
        </div>

        <div className="row" style={{ gap: 10 }}>
          <Button type="button" size="sm" onClick={() => setLines((prev) => [...prev, { ledgerId: '', type: 'DEBIT', amount: '' }])}>
            Add debit line
          </Button>
          <Button type="button" size="sm" onClick={() => setLines((prev) => [...prev, { ledgerId: '', type: 'CREDIT', amount: '' }])}>
            Add credit line
          </Button>
        </div>

        <div className="mt">
          <Alert tone={balanced ? 'success' : 'warning'}>
            Debits <b>{money(debitTotal)}</b> · Credits <b>{money(creditTotal)}</b> —{' '}
            {balanced ? 'balanced, ready to post.' : `out of balance by ${money(Math.abs(debitTotal - creditTotal))}.`}
          </Alert>
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------ expenses & income ---------------------------- */

function ExpensesAndIncome() {
  const { can } = useSession();
  const toast = useToast();
  const [kind, setKind] = useState<'expenses' | 'incomes'>('expenses');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const limit = 20;

  const rows = useList<{ _id: string; title: string; amount: number; date: string; ledgerId?: string; ledgerName?: string; category?: string; isPaid?: boolean; note?: string }>(
    `/${kind}`,
    { page, limit, sort: 'date', dir: 'desc' },
    [kind, page],
  );

  return (
    <div className="stack">
      {rows.error ? <ErrorAlert error={rows.error} /> : null}
      <Card
        title={kind === 'expenses' ? 'Expenses' : 'Other income'}
        subtitle={`${number(rows.page.total)} recorded`}
        actions={
          <>
            <div className="row" style={{ gap: 6 }}>
              <Button size="sm" variant={kind === 'expenses' ? 'primary' : 'default'} onClick={() => { setKind('expenses'); setPage(1); }}>
                Expenses
              </Button>
              <Button size="sm" variant={kind === 'incomes' ? 'primary' : 'default'} onClick={() => { setKind('incomes'); setPage(1); }}>
                Income
              </Button>
            </div>
            {can(kind === 'expenses' ? 'expense:create' : 'accounting:create') ? (
              <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
                Record {kind === 'expenses' ? 'an expense' : 'income'}
              </Button>
            ) : null}
          </>
        }
        flush
      >
        {rows.loading ? (
          <Loading />
        ) : rows.page.items.length === 0 ? (
          <EmptyState title={`No ${kind} recorded`} hint="Entries post to the ledger you choose and appear on the income statement." />
        ) : (
          <DataTable
            rows={rows.page.items}
            rowKey={(r) => r._id}
            columns={[
              { key: 'title', header: 'Title', render: (r) => <b>{r.title}</b> },
              { key: 'ledger', header: 'Ledger', render: (r) => r.ledgerName ?? label(r.category ?? '—') },
              { key: 'date', header: 'Date', align: 'right', render: (r) => day(r.date) },
              { key: 'amount', header: 'Amount', align: 'right', render: (r) => <b>{money(r.amount)}</b> },
              {
                key: 'paid',
                header: 'Paid',
                render: (r) =>
                  kind === 'expenses' ? (
                    r.isPaid === false ? <Pill tone="warning">Unpaid</Pill> : <Pill tone="success">Paid</Pill>
                  ) : null,
              },
            ]}
          />
        )}
        <div className="card__foot">
          <Pagination page={page} limit={limit} total={rows.page.total} onPage={setPage} />
        </div>
      </Card>

      {creating ? (
        <RecordMoneyForm
          kind={kind}
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
            toast.success(kind === 'expenses' ? 'Expense recorded' : 'Income recorded');
            rows.reload();
          }}
        />
      ) : null}
    </div>
  );
}

function RecordMoneyForm({ kind, onClose, onDone }: { kind: 'expenses' | 'incomes'; onClose: () => void; onDone: () => void }) {
  const isExpense = kind === 'expenses';
  const [title, setTitle] = useState('');
  const [ledgerId, setLedgerId] = useState('');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const ledgers = useResource<{ ledgers: Ledger[] }>('/accounting/ledgers');
  // An expense posts to an expense ledger and income to an income ledger; offering the wrong set
  // would produce an entry the statements place on the wrong side.
  const options = (ledgers.data?.ledgers ?? []).filter((l) => (isExpense ? l.group === 'EXPENSE' : l.group === 'INCOME'));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(`/${kind}`, {
        title: title.trim(),
        ledgerId,
        amount: Number(amount),
        date,
        note: note.trim() || undefined,
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
      title={isExpense ? 'Record an expense' : 'Record income'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={submit} disabled={!ledgerId || !Number(amount)}>
            Save
          </Button>
        </>
      }
    >
      {error ? <ErrorAlert error={error} /> : null}
      <form onSubmit={submit}>
        <Field label="Title" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={isExpense ? 'Lift AMC — September' : 'Interest on fixed deposit'} required autoFocus />
        </Field>
        <Field label="Ledger" required hint={ledgers.loading ? 'Loading the chart of accounts…' : undefined}>
          <Select value={ledgerId} onChange={(e) => setLedgerId(e.target.value)} required>
            <option value="">Select a ledger…</option>
            {options.map((l) => (
              <option key={l._id} value={l._id}>
                {l.name}
                {l.code ? ` (${l.code})` : ''}
              </option>
            ))}
          </Select>
        </Field>
        <div className="form-row">
          <Field label="Amount (₹)" required>
            <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" required />
          </Field>
          <Field label="Date" required>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </Field>
        </div>
        <Field label="Note">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}
