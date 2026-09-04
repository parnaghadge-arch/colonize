import { useState } from 'react';
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
  Pill,
  Select,
  StatusPill,
  Textarea,
  useToast,
} from '../components/ui.tsx';
import { day, dateTime, label, money } from '../lib/format.ts';
import { useSession } from '../lib/session.tsx';
import type { Payment } from '../lib/types.ts';

const MODES = ['ONLINE', 'UPI', 'CARD', 'NETBANKING', 'CASH', 'CHEQUE', 'DD', 'BANK_TRANSFER', 'WALLET'];
const STATUSES = ['SUCCESS', 'PENDING', 'INITIATED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'CANCELLED', 'ABANDONED'];
const PURPOSES = ['MAINTENANCE', 'AMENITY_BOOKING', 'EVENT', 'SERVICE_REQUEST', 'FINE', 'DONATION', 'OTHER'];

interface PaymentSummary {
  from: string;
  to: string;
  transactions: number;
  collected: number;
  failed: number;
  refunded: number;
  byMode: Record<string, { count: number; amount: number }>;
  byPurpose: Record<string, { count: number; amount: number }>;
  byDay: Record<string, number>;
  billing: {
    period: string;
    bills: number;
    billed: number;
    collected: number;
    outstanding: number;
    waived: number;
    collectionPercent: number;
    byStatus: Record<string, number>;
  };
}

/**
 * Payments and receipts (§33).
 *
 * Every row here is a settled financial event with a receipt behind it, so the screen is mostly
 * read-only by design: the only mutating action is a refund, and that requires a reason because it
 * reverses a ledger entry that has already been posted.
 */
export function PaymentsPage() {
  const { who } = useSession();
  const toast = useToast();
  const timezone = who?.society?.timezone;

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [mode, setMode] = useState('');
  const [purpose, setPurpose] = useState('');
  const [page, setPage] = useState(1);
  const limit = 20;

  const payments = useList<Payment>(
    '/payments',
    {
      page,
      limit,
      search: search || undefined,
      status: status || undefined,
      mode: mode || undefined,
      purpose: purpose || undefined,
      sort: 'createdAt',
      dir: 'desc',
    },
    [page, search, status, mode, purpose],
  );
  const summary = useResource<PaymentSummary>('/payments/summary');

  const [detail, setDetail] = useState<Payment | null>(null);
  const [refunding, setRefunding] = useState<Payment | null>(null);

  const s = summary.data;

  return (
    <div className="stack">
      {payments.error ? <ErrorAlert error={payments.error} /> : null}
      {summary.error ? <ErrorAlert error={summary.error} /> : null}

      <div className="tiles">
        <Tile label="Transactions" value={number(s?.transactions)} tone="brand" />
        <Tile label="Collected" value={money(s?.collected ?? 0)} tone="success" />
        <Tile label="Refunded" value={money(s?.refunded ?? 0)} tone={(s?.refunded ?? 0) > 0 ? 'warning' : 'neutral'} />
        <Tile label="Failed" value={number(s?.failed)} tone={(s?.failed ?? 0) > 0 ? 'danger' : 'neutral'} />
        <Tile
          label="Collection rate"
          value={`${number(s?.billing?.collectionPercent)}%`}
          tone={(s?.billing?.collectionPercent ?? 0) >= 90 ? 'success' : 'warning'}
        />
      </div>

      <div className="grid grid--2">
        <Card title="By mode" subtitle={`${day(s?.from, timezone)} — ${day(s?.to, timezone)}`}>
          {s && Object.keys(s.byMode ?? {}).length > 0 ? (
            <BreakdownTable rows={s.byMode} total={s.collected} />
          ) : summary.loading ? (
            <Loading />
          ) : (
            <EmptyState title="No payments yet" />
          )}
        </Card>
        <Card title="By purpose">
          {s && Object.keys(s.byPurpose ?? {}).length > 0 ? (
            <BreakdownTable rows={s.byPurpose} total={s.collected} />
          ) : summary.loading ? (
            <Loading />
          ) : (
            <EmptyState title="No payments yet" />
          )}
        </Card>
      </div>

      <Card
        title="Transactions"
        subtitle={`${number(payments.page.total)} recorded`}
        actions={
          <Button size="sm" variant="ghost" onClick={() => { payments.reload(); summary.reload(); }}>
            Refresh
          </Button>
        }
        flush
      >
        <div className="card__body" style={{ paddingBottom: 0 }}>
          <div className="toolbar">
            <Input
              placeholder="Search receipt or reference"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              style={{ minWidth: 210 }}
            />
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
            <Select
              value={mode}
              onChange={(e) => {
                setMode(e.target.value);
                setPage(1);
              }}
            >
              <option value="">Any mode</option>
              {MODES.map((m) => (
                <option key={m} value={m}>
                  {label(m)}
                </option>
              ))}
            </Select>
            <Select
              value={purpose}
              onChange={(e) => {
                setPurpose(e.target.value);
                setPage(1);
              }}
            >
              <option value="">Any purpose</option>
              {PURPOSES.map((p) => (
                <option key={p} value={p}>
                  {label(p)}
                </option>
              ))}
            </Select>
            <div className="toolbar__spacer" />
          </div>
        </div>

        {payments.loading ? (
          <Loading />
        ) : (
          <DataTable
            rows={payments.page.items}
            rowKey={(p) => p._id}
            onRowClick={setDetail}
            empty={<EmptyState title="No transactions" hint="Nothing matches this filter." />}
            columns={[
              { key: 'ref', header: 'Receipt', render: (p) => <code className="small">{p.referenceNumber ?? p._id.slice(0, 12)}</code> },
              {
                key: 'what',
                header: 'For',
                render: (p) => (
                  <div>
                    <b>{label(p.purpose)}</b>
                    <div className="faint small">{p.unitLabel ?? p.unitId ?? '—'}</div>
                  </div>
                ),
              },
              { key: 'mode', header: 'Mode', render: (p) => <Pill>{label(p.mode)}</Pill> },
              { key: 'amount', header: 'Amount', align: 'right', render: (p) => <b>{money(p.amount)}</b> },
              {
                key: 'refunded',
                header: 'Refunded',
                align: 'right',
                render: (p) => (p.refundedAmount ? money(p.refundedAmount) : <span className="faint">—</span>),
              },
              { key: 'status', header: 'Status', render: (p) => <StatusPill status={p.status} /> },
              {
                key: 'when',
                header: 'When',
                align: 'right',
                render: (p) => <span className="small muted">{dateTime(p.paidAt ?? p.createdAt, timezone)}</span>,
              },
            ]}
          />
        )}

        <div className="card__foot">
          <Pagination page={page} limit={limit} total={payments.page.total} onPage={setPage} />
        </div>
      </Card>

      {detail ? (
        <PaymentDetail
          payment={detail}
          timezone={timezone}
          onClose={() => setDetail(null)}
          onRefund={() => setRefunding(detail)}
        />
      ) : null}

      {refunding ? (
        <RefundForm
          payment={refunding}
          onClose={() => setRefunding(null)}
          onDone={() => {
            setRefunding(null);
            setDetail(null);
            toast.success('Refund recorded and ledger reversed');
            payments.reload();
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

function Tile({ label: title, value, tone = 'neutral' }: { label: string; value: string; tone?: string }) {
  return (
    <div className={tone === 'neutral' ? 'tile' : `tile tile--${tone}`}>
      <div className="tile__label">{title}</div>
      <div className="tile__value">{value}</div>
    </div>
  );
}

function BreakdownTable({ rows, total }: { rows: Record<string, { count: number; amount: number }>; total: number }) {
  const entries = Object.entries(rows).sort((a, b) => b[1].amount - a[1].amount);
  return (
    <table className="table">
      <thead>
        <tr>
          <th>Bucket</th>
          <th className="num">Count</th>
          <th className="num">Amount</th>
          <th className="num">Share</th>
        </tr>
      </thead>
      <tbody>
        {entries.map(([key, value]) => (
          <tr key={key}>
            <td>{label(key)}</td>
            <td className="num">{number(value.count)}</td>
            <td className="num">{money(value.amount)}</td>
            <td className="num faint">{total ? `${Math.round((value.amount / total) * 100)}%` : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PaymentDetail({
  payment,
  timezone,
  onClose,
  onRefund,
}: {
  payment: Payment;
  timezone?: string;
  onClose: () => void;
  onRefund: () => void;
}) {
  const { can } = useSession();
  const toast = useToast();
  const refundable = Number(payment.amount ?? 0) - Number(payment.refundedAmount ?? 0);

  return (
    <Modal
      title={`${payment.referenceNumber ?? 'Payment'} — ${money(payment.amount)}`}
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button
            variant="primary"
            onClick={() =>
              void api
                .blob(`/payments/${payment._id}/receipt`)
                .then((blob) => {
                  const url = URL.createObjectURL(blob);
                  const anchor = document.createElement('a');
                  anchor.href = url;
                  anchor.download = `${payment.referenceNumber ?? 'receipt'}.pdf`;
                  document.body.appendChild(anchor);
                  anchor.click();
                  anchor.remove();
                  setTimeout(() => URL.revokeObjectURL(url), 4000);
                })
                .catch(toast.error)
            }
          >
            Download receipt
          </Button>
          {can('payment:refund') && refundable > 0 && payment.status === 'SUCCESS' ? (
            <Button variant="danger" onClick={onRefund}>
              Refund
            </Button>
          ) : null}
        </>
      }
    >
      <div className="grid grid--2">
        <Card title="Payment">
          <KeyValue
            items={[
              ['Status', <StatusPill key="s" status={payment.status} />],
              ['Purpose', label(payment.purpose)],
              ['Mode', label(payment.mode)],
              ['Amount', money(payment.amount)],
              ['Paid', money(payment.amount)],
              ['Refunded', payment.refundedAmount ? money(payment.refundedAmount) : '—'],
              ['Received', dateTime(payment.paidAt ?? payment.createdAt, timezone)],
            ]}
          />
        </Card>
        <Card title="Traceability" subtitle="What this payment is linked to">
          <KeyValue
            items={[
              ['Unit', payment.unit?.label ?? payment.unitLabel ?? payment.unitId ?? '—'],
              ['Bill', payment.bill?.billNumber ?? payment.billId ? <code key="b">{String(payment.bill?.billNumber ?? payment.billId)}</code> : '—'],
              ['Gateway', payment.gateway ?? '—'],
              ['Transaction id', payment.transactionId ? <code key="t">{String(payment.transactionId)}</code> : '—'],
              ['Reference', payment.referenceNumber ?? '—'],
              ['Recorded by', payment.recordedBy ? <code key="r">{String(payment.recordedBy)}</code> : '—'],
              ['Created', dateTime(payment.createdAt, timezone)],
            ]}
          />
        </Card>
      </div>
      {payment.note ? <p className="small muted">{String(payment.note)}</p> : null}
      {refundable <= 0 && payment.status === 'SUCCESS' ? (
        <Alert tone="info">This payment has been fully refunded.</Alert>
      ) : null}
    </Modal>
  );
}

function RefundForm({ payment, onClose, onDone }: { payment: Payment; onClose: () => void; onDone: () => void }) {
  const refundable = Number(payment.amount ?? 0) - Number(payment.refundedAmount ?? 0);
  const [amount, setAmount] = useState(String(refundable));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/payments/${payment._id}/refund`, {
        amount: Number(amount),
        reason: reason.trim(),
        fullRefund: Number(amount) >= refundable,
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
      title={`Refund ${payment.referenceNumber ?? 'this payment'}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" busy={busy} onClick={() => void submit()} disabled={!reason.trim() || !Number(amount)}>
            Refund {money(Number(amount) || 0)}
          </Button>
        </>
      }
    >
      {error ? <ErrorAlert error={error} /> : null}
      <Alert tone="warning">
        A refund reverses the ledger entry that was posted when this payment was received, and
        reopens the balance on the bill it settled. Up to <b>{money(refundable)}</b> is refundable.
      </Alert>
      <Field label="Amount to refund (₹)" required>
        <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" required autoFocus />
      </Field>
      <Field label="Reason" required hint="Recorded on the payment and in the audit trail.">
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Booking cancelled within the refund window" required />
      </Field>
    </Modal>
  );
}
