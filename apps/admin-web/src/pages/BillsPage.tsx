import { useState, type FormEvent } from 'react';
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
  KeyValue,
  Loading,
  Modal,
  Pagination,
  Select,
  StatusPill,
  Textarea,
  useToast,
  type Tone,
} from '../components/ui.tsx';
import { day, label, money } from '../lib/format.ts';
import { useSession } from '../lib/session.tsx';
import { UnitPicker } from '../components/UnitPicker.tsx';
import type { Bill, BillItem } from '../lib/types.ts';

const STATUSES = ['DRAFT', 'GENERATED', 'SENT', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'WAIVED', 'CANCELLED', 'DISPUTED'];

/** The current month in the society's own timezone, as the `YYYY-MM` period key the API expects. */
function currentPeriod(timezone?: string): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const year = parts.find((p) => p.type === 'year')?.value ?? String(now.getFullYear());
  const month = parts.find((p) => p.type === 'month')?.value ?? String(now.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/** All the months bills could plausibly cover, newest first. */
function periodOptions(timezone?: string, count = 18): string[] {
  const out: string[] = [];
  const [yearPart, monthPart] = currentPeriod(timezone).split('-');
  const year = Number(yearPart) || new Date().getFullYear();
  const month = Number(monthPart) || 1;
  const cursor = new Date(Date.UTC(year, month - 1, 1));
  for (let i = 0; i < count; i += 1) {
    out.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`);
    cursor.setUTCMonth(cursor.getUTCMonth() - 1);
  }
  return out;
}

interface PreviewRow {
  unitId: string;
  unitLabel?: string | null;
  totalAmount?: number;
  itemCount?: number;
  arrears?: number;
  [key: string]: unknown;
}

interface GeneratePreview {
  dryRun?: boolean;
  period?: string;
  bills?: number;
  total?: number;
  items?: PreviewRow[];
  rows?: PreviewRow[];
  [key: string]: unknown;
}

/**
 * Maintenance billing (§31, §32).
 *
 * Generation is driven entirely by the society's own `maintenance` settings — rate per sq ft,
 * fixed and water charges, parking, late fees, arrears carry-forward — so nothing here decides how
 * much anyone owes. A dry run shows exactly what will be raised before a single bill is written,
 * because once issued a bill becomes a financial record that a receipt and a ledger entry point at.
 */
export function BillsPage() {
  const { who, can } = useSession();
  const toast = useToast();
  const timezone = who?.society?.timezone;

  const [period, setPeriod] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const limit = 20;

  const bills = useList<Bill>(
    '/bills',
    { page, limit, period: period || undefined, status: status || undefined, search: search || undefined, sort: 'dueDate', dir: 'desc' },
    [page, period, status, search],
  );
  const summary = useResource<{
    period: string;
    bills: number;
    billed: number;
    collected: number;
    outstanding: number;
    waived: number;
    collectionPercent: number;
    byStatus: Record<string, number>;
  }>('/bills/summary', { period: period || currentPeriod(timezone) }, [period, timezone]);

  const [detail, setDetail] = useState<Bill | null>(null);
  const [generating, setGenerating] = useState(false);
  const [recording, setRecording] = useState<Bill | null>(null);

  const s = summary.data;

  return (
    <div className="stack">
      {bills.error ? <ErrorAlert error={bills.error} /> : null}

      <div className="tiles">
        <Tile label="Bills raised" value={number(s?.bills)} tone="brand" />
        <Tile label="Billed" value={money(s?.billed ?? 0)} />
        <Tile label="Collected" value={money(s?.collected ?? 0)} tone="success" />
        <Tile label="Outstanding" value={money(s?.outstanding ?? 0)} tone={(s?.outstanding ?? 0) > 0 ? 'warning' : 'neutral'} />
        <Tile label="Collection" value={`${number(s?.collectionPercent)}%`} tone={(s?.collectionPercent ?? 0) >= 90 ? 'success' : 'warning'} />
      </div>

      <Card
        title="Maintenance bills"
        subtitle={period ? `Period ${period}` : 'All periods'}
        actions={
          can('bill:generate') ? (
            <Button size="sm" variant="primary" onClick={() => setGenerating(true)}>
              Generate bills
            </Button>
          ) : null
        }
        flush
      >
        <div className="card__body" style={{ paddingBottom: 0 }}>
          <div className="toolbar">
            <Input
              placeholder="Search invoice or unit"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              style={{ minWidth: 200 }}
            />
            <Select
              value={period}
              onChange={(e) => {
                setPeriod(e.target.value);
                setPage(1);
              }}
            >
              <option value="">Every period</option>
              {periodOptions(timezone).map((p) => (
                <option key={p} value={p}>
                  {formatPeriod(p)}
                </option>
              ))}
            </Select>
            <Select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              <option value="">Any status</option>
              {STATUSES.map((x) => (
                <option key={x} value={x}>
                  {label(x)}
                </option>
              ))}
            </Select>
            <div className="toolbar__spacer" />
            <Button size="sm" variant="ghost" onClick={() => { bills.reload(); summary.reload(); }}>
              Refresh
            </Button>
          </div>
        </div>

        {bills.loading ? (
          <Loading />
        ) : (
          <DataTable
            rows={bills.page.items}
            rowKey={(b) => b._id}
            onRowClick={setDetail}
            empty={<EmptyState title="No bills for this filter" hint="Generate a period's bills, or clear the filters." />}
            columns={[
              { key: 'invoice', header: 'Invoice', render: (b) => <code className="small">{b.invoiceNumber ?? b._id.slice(0, 12)}</code> },
              {
                key: 'unit',
                header: 'Unit',
                render: (b) => (
                  <div>
                    <b>{b.unitLabel ?? b.unitId}</b>
                    <div className="faint small">{formatPeriod(b.period)}</div>
                  </div>
                ),
              },
              { key: 'due', header: 'Due date', align: 'right', render: (b) => day(b.dueDate, timezone) },
              { key: 'total', header: 'Total', align: 'right', render: (b) => <b>{money(b.totalAmount)}</b> },
              {
                key: 'paid',
                header: 'Paid',
                align: 'right',
                render: (b) => (b.paidAmount ? money(b.paidAmount) : <span className="faint">—</span>),
              },
              {
                key: 'outstanding',
                header: 'Balance',
                align: 'right',
                render: (b) =>
                  b.dueAmount > 0 ? <span style={{ color: 'var(--danger)' }}>{money(b.dueAmount)}</span> : <span className="faint">Settled</span>,
              },
              { key: 'status', header: 'Status', render: (b) => <StatusPill status={b.status} /> },
            ]}
          />
        )}

        <div className="card__foot">
          <Pagination page={page} limit={limit} total={bills.page.total} onPage={setPage} />
        </div>
      </Card>

      {detail ? (
        <BillDetail
          bill={detail}
          timezone={timezone}
          onClose={() => setDetail(null)}
          onChanged={() => {
            bills.reload();
            summary.reload();
          }}
          onRecordPayment={() => setRecording(detail)}
        />
      ) : null}

      {recording ? (
        <RecordOfflinePaymentForm
          bill={recording}
          onClose={() => setRecording(null)}
          onDone={() => {
            setRecording(null);
            toast.success('Offline payment recorded and receipt issued');
            bills.reload();
            summary.reload();
          }}
        />
      ) : null}

      {generating ? (
        <GenerateBillsForm
          timezone={timezone}
          onClose={() => setGenerating(false)}
          onDone={(count) => {
            setGenerating(false);
            toast.success(`${count} bills generated`);
            bills.reload();
            summary.reload();
          }}
        />
      ) : null}
    </div>
  );
}

function number(value: unknown): string {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n.toLocaleString('en-IN') : '0';
}

function formatPeriod(period?: string | null): string {
  if (!period) return '—';
  const [y, m] = String(period).split('-');
  if (!y || !m) return String(period);
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, 1));
  return date.toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function Tile({ label: title, value, tone = 'neutral' }: { label: string; value: string; tone?: string }) {
  return (
    <div className={tone === 'neutral' ? 'tile' : `tile tile--${tone}`}>
      <div className="tile__label">{title}</div>
      <div className="tile__value">{value}</div>
    </div>
  );
}

function BillDetail({
  bill,
  timezone,
  onClose,
  onChanged,
  onRecordPayment,
}: {
  bill: Bill;
  timezone?: string;
  onClose: () => void;
  onChanged: () => void;
  onRecordPayment: () => void;
}) {
  const { can } = useSession();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [waiving, setWaiving] = useState(false);

  // The detail document carries the line items; the list projection does not.
  const detail = useResource<{ items?: BillItem[] }>(`/bills/${bill._id}`);
  const lineItems: BillItem[] = detail.data?.items ?? bill.items ?? [];

  async function run(kind: string, fn: () => Promise<unknown>, message: string) {
    setBusy(kind);
    setError(null);
    try {
      await fn();
      toast.success(message);
      onChanged();
    } catch (err) {
      setError(err);
      toast.error(err);
    } finally {
      setBusy(null);
    }
  }

  const tax = bill.taxBreakup ?? {};
  const hasTax = Number(bill.totalTax ?? 0) > 0;

  return (
    <Modal title={`${bill.invoiceNumber ?? 'Bill'} — ${bill.unitLabel ?? bill.unitId}`} onClose={onClose} wide>
      {error ? <ErrorAlert error={error} /> : null}

      <div className="grid grid--2">
        <Card
          title="Bill"
          actions={
            <Button size="sm" variant="ghost" onClick={() => void api.blob(`/bills/${bill._id}/invoice`).then(downloadBlob).catch(toast.error)}>
              Download invoice
            </Button>
          }
        >
          <KeyValue
            items={[
              ['Status', <StatusPill key="s" status={bill.status} />],
              ['Period', formatPeriod(bill.period)],
              ['Generated', day(bill.generatedAt ?? bill.createdAt, timezone)],
              ['Due date', day(bill.dueDate, timezone)],
              ['Resident', bill.residentName ?? bill.residentId ?? '—'],
              ['Line items', number(bill.itemCount ?? lineItems.length)],
            ]}
          />
        </Card>

        <Card title="Amounts">
          <table className="table">
            <tbody>
              <Row label="Subtotal" value={money(bill.subtotal ?? bill.totalAmount)} />
              {bill.arrears ? <Row label="Arrears carried forward" value={money(bill.arrears)} /> : null}
              {bill.lateFee ? <Row label="Late fee" value={money(bill.lateFee)} /> : null}
              {bill.penalty ? <Row label="Penalty" value={money(bill.penalty)} /> : null}
              {bill.discount ? <Row label={`Discount${bill.discountReason ? ` — ${bill.discountReason}` : ''}`} value={`− ${money(bill.discount)}`} /> : null}
              {hasTax ? <Row label="CGST" value={money(tax.cgst)} /> : null}
              {hasTax ? <Row label="SGST" value={money(tax.sgst)} /> : null}
              {hasTax ? <Row label="IGST" value={money(tax.igst)} /> : null}
              <Row label="Total" value={<b>{money(bill.totalAmount)}</b>} />
              <Row label="Paid" value={money(bill.paidAmount)} tone="success" />
              {bill.waivedAmount ? <Row label="Waived" value={money(bill.waivedAmount)} /> : null}
              {bill.refundedAmount ? <Row label="Refunded" value={money(bill.refundedAmount)} /> : null}
              <Row
                label="Balance due"
                value={<b>{money(bill.dueAmount)}</b>}
                tone={bill.dueAmount > 0 ? 'danger' : 'neutral'}
              />
            </tbody>
          </table>
        </Card>
      </div>

      {Array.isArray(lineItems) && lineItems.length > 0 ? (
        <Card title="What this bill covers" flush>
          <DataTable
            rows={lineItems}
            rowKey={(row, index) => String(row._id ?? index)}
            columns={[
              { key: 'what', header: 'Charge', render: (row) => String(row.description ?? row.label ?? row.name ?? '—') },
              { key: 'qty', header: 'Qty', align: 'right', render: (row) => (row.quantity ? number(row.quantity) : '—') },
              { key: 'amount', header: 'Amount', align: 'right', render: (row) => money(Number(row.amount ?? 0)) },
            ]}
          />
        </Card>
      ) : null}

      <div className="row row--wrap">
        {can('payment:record') && bill.dueAmount > 0 ? (
          <Button size="sm" variant="primary" onClick={onRecordPayment}>
            Record an offline payment
          </Button>
        ) : null}
        {can('bill:update') && bill.dueAmount > 0 && bill.status !== 'WAIVED' ? (
          <Button size="sm" onClick={() => setWaiving(true)}>
            Waive part or all
          </Button>
        ) : null}
        {can('bill:update') && ['GENERATED', 'SENT'].includes(String(bill.status)) ? (
          <Button
            size="sm"
            busy={busy === 'send'}
            onClick={() => void run('send', () => api.patch(`/bills/${bill._id}`, { status: 'SENT' }), 'Bill marked as sent')}
          >
            Mark as sent
          </Button>
        ) : null}
      </div>

      {bill.notes ? <p className="small muted">{String(bill.notes)}</p> : null}

      {waiving ? (
        <WaiveBillForm
          bill={bill}
          onClose={() => setWaiving(false)}
          onDone={() => {
            setWaiving(false);
            toast.success('Bill waived');
            onChanged();
          }}
        />
      ) : null}
    </Modal>
  );
}

function Row({ label: title, value, tone }: { label: string; value: React.ReactNode; tone?: Tone }) {
  const colour = tone === 'success' ? 'var(--success)' : tone === 'danger' ? 'var(--danger)' : undefined;
  return (
    <tr>
      <td className="muted">{title}</td>
      <td className="num" style={{ color: colour, textAlign: 'right' }}>
        {value}
      </td>
    </tr>
  );
}

function downloadBlob(blob: Blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = blob.type.includes('pdf') ? 'document.pdf' : 'document';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoking immediately can cancel the download in some browsers, so let it settle first.
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function WaiveBillForm({ bill, onClose, onDone }: { bill: Bill; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState(String(bill.dueAmount ?? ''));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(`/bills/${bill._id}/waive`, {
        amount: Number(amount),
        reason: reason.trim(),
        fullWaiver: Number(amount) >= Number(bill.dueAmount),
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
      title={`Waive charges on ${bill.invoiceNumber ?? 'this bill'}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={submit} disabled={!reason.trim()}>
            Waive {money(Number(amount) || 0)}
          </Button>
        </>
      }
    >
      {error ? <ErrorAlert error={error} /> : null}
      <form onSubmit={submit}>
        <Alert tone="warning">
          A waiver is a financial decision the committee has to be able to defend later, so the
          reason is recorded on the bill and in the audit trail.
        </Alert>
        <Field label="Amount to waive (₹)" required hint={`Outstanding balance is ${money(bill.dueAmount)}.`}>
          <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" required />
        </Field>
        <Field label="Reason" required>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Goodwill gesture after the water outage" required />
        </Field>
      </form>
    </Modal>
  );
}

/**
 * Record a cash, cheque, UPI or bank-transfer payment against a bill.
 *
 * This is the money-moving path: the backend takes an idempotency key so a double-click cannot
 * record the same receipt twice, and writes the payment, the bill update and the ledger entry
 * together.
 */
function RecordOfflinePaymentForm({ bill, onClose, onDone }: { bill: Bill; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState(String(bill.dueAmount ?? ''));
  const [mode, setMode] = useState('CASH');
  const [referenceNumber, setReference] = useState('');
  const [paidAt, setPaidAt] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/payments/offline', {
        unitId: bill.unitId,
        billId: bill._id,
        purpose: 'MAINTENANCE',
        amount: Number(amount),
        mode,
        referenceNumber: referenceNumber.trim() || undefined,
        paidAt: paidAt || undefined,
        note: note.trim() || undefined,
        // A client-generated key means a retry after a network blip cannot double-collect.
        clientRequestId: `${bill._id}-${Date.now()}`,
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
      title={`Record a payment for ${bill.invoiceNumber ?? 'this bill'}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={submit} disabled={!Number(amount)}>
            Record {money(Number(amount) || 0)}
          </Button>
        </>
      }
    >
      {error ? <ErrorAlert error={error} /> : null}
      <form onSubmit={submit}>
        <Alert tone="info">
          Balance due is <b>{money(bill.dueAmount)}</b>. Recording this creates a receipt and posts
          the matching ledger entry in the same transaction.
        </Alert>
        <div className="form-row">
          <Field label="Amount (₹)" required>
            <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" required autoFocus />
          </Field>
          <Field label="Mode" required>
            <Select value={mode} onChange={(e) => setMode(e.target.value)}>
              {['CASH', 'CHEQUE', 'DD', 'UPI', 'CARD', 'NETBANKING', 'BANK_TRANSFER', 'WALLET'].map((m) => (
                <option key={m} value={m}>
                  {label(m)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="form-row">
          <Field label="Reference number" hint="Cheque number, UTR or transaction id.">
            <Input value={referenceNumber} onChange={(e) => setReference(e.target.value)} placeholder="Cheque 445566" />
          </Field>
          <Field label="Received on">
            <Input type="date" value={paidAt} onChange={(e) => setPaidAt(e.target.value)} />
          </Field>
        </div>
        <Field label="Note">
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Received at the society office" />
        </Field>
      </form>
    </Modal>
  );
}

/**
 * Generate a period's bills.
 *
 * Two stages on purpose: a dry run first, which shows the exact bills and total the society's own
 * maintenance settings would produce, and only then the real generation.
 */
function GenerateBillsForm({
  timezone,
  onClose,
  onDone,
}: {
  timezone?: string;
  onClose: () => void;
  onDone: (count: number) => void;
}) {
  const [period, setPeriod] = useState(currentPeriod(timezone));
  const [dueDay, setDueDay] = useState('15');
  const [scope, setScope] = useState<'ALL' | 'UNITS'>('ALL');
  const [unitId, setUnitId] = useState('');
  const [carryForwardArrears, setArrears] = useState(true);
  const [applyLateFeeOnArrears, setLateFee] = useState(true);
  const [preview, setPreview] = useState<GeneratePreview | null>(null);
  const [busy, setBusy] = useState<'preview' | 'generate' | null>(null);
  const [error, setError] = useState<unknown>(null);

  const dueDate = `${period}-${String(Number(dueDay) || 1).padStart(2, '0')}`;

  function payload(dryRun: boolean) {
    return {
      period,
      dueDate,
      scope: scope === 'UNITS' ? 'UNITS' : 'ALL',
      unitIds: scope === 'UNITS' && unitId ? [unitId] : undefined,
      carryForwardArrears,
      applyLateFeeOnArrears,
      dryRun,
    };
  }

  async function runPreview() {
    setBusy('preview');
    setError(null);
    try {
      const result = await api.post<GeneratePreview>('/bills/generate', payload(true));
      setPreview(result);
    } catch (err) {
      setError(err);
      setPreview(null);
    } finally {
      setBusy(null);
    }
  }

  async function generate() {
    setBusy('generate');
    setError(null);
    try {
      const result = await api.post<GeneratePreview>('/bills/generate', payload(false));
      onDone(Number(result.bills ?? result.count ?? 0));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  const rows = (preview?.items ?? preview?.rows ?? []) as PreviewRow[];

  return (
    <Modal
      title="Generate maintenance bills"
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button busy={busy === 'preview'} onClick={() => void runPreview()}>
            Preview without saving
          </Button>
          <Button
            variant="primary"
            busy={busy === 'generate'}
            onClick={() => void generate()}
            disabled={scope === 'UNITS' && !unitId}
          >
            Generate bills
          </Button>
        </>
      }
    >
      {error ? <ErrorAlert error={error} /> : null}

      <Alert tone="info">
        Charges come from this society's <b>maintenance settings</b> — rate per sq ft, fixed and
        water charges, parking, late fees. Change them under Settings to change what is billed.
      </Alert>

      <div className="form-row">
        <Field label="Billing period" required>
          <Select value={period} onChange={(e) => { setPeriod(e.target.value); setPreview(null); }}>
            {periodOptions(timezone).map((p) => (
              <option key={p} value={p}>
                {formatPeriod(p)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Due on day" required hint={`Bills will be due ${day(dueDate, timezone)}.`}>
          <Input value={dueDay} onChange={(e) => { setDueDay(e.target.value.replace(/\D/g, '').slice(0, 2)); setPreview(null); }} inputMode="numeric" />
        </Field>
      </div>

      <Field label="Scope" required>
        <div className="row" style={{ gap: 12 }}>
          <Button type="button" size="sm" variant={scope === 'ALL' ? 'primary' : 'default'} onClick={() => { setScope('ALL'); setPreview(null); }}>
            Every occupied unit
          </Button>
          <Button type="button" size="sm" variant={scope === 'UNITS' ? 'primary' : 'default'} onClick={() => { setScope('UNITS'); setPreview(null); }}>
            Specific units
          </Button>
        </div>
      </Field>

      {scope === 'UNITS' ? <UnitPicker value={unitId} onChange={(id) => { setUnitId(id); setPreview(null); }} label="Which unit?" /> : null}

      <div className="row" style={{ gap: 18 }}>
        <label className="row" style={{ gap: 6 }}>
          <input type="checkbox" checked={carryForwardArrears} onChange={(e) => { setArrears(e.target.checked); setPreview(null); }} />
          <span className="small">Carry forward arrears</span>
        </label>
        <label className="row" style={{ gap: 6 }}>
          <input type="checkbox" checked={applyLateFeeOnArrears} onChange={(e) => { setLateFee(e.target.checked); setPreview(null); }} />
          <span className="small">Apply late fee on arrears</span>
        </label>
      </div>

      {preview ? (
        <div className="mt">
          <Alert tone="success">
            Preview only — nothing has been saved. This would raise{' '}
            <b>{number(preview.bills ?? rows.length)}</b> bills totalling{' '}
            <b>{money(Number(preview.total ?? 0))}</b>.
          </Alert>
          {rows.length > 0 ? (
            <div style={{ maxHeight: 240, overflowY: 'auto' }}>
              <DataTable
                rows={rows}
                rowKey={(row, index) => String(row.unitId ?? index)}
                columns={[
                  { key: 'unit', header: 'Unit', render: (row) => String(row.unitLabel ?? row.unitId) },
                  { key: 'items', header: 'Charges', align: 'right', render: (row) => number(row.itemCount) },
                  { key: 'arrears', header: 'Arrears', align: 'right', render: (row) => (row.arrears ? money(Number(row.arrears)) : '—') },
                  { key: 'total', header: 'Total', align: 'right', render: (row) => <b>{money(Number(row.totalAmount ?? 0))}</b> },
                ]}
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}
