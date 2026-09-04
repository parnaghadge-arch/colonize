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
  StatusPill,
  Textarea,
  useToast,
} from '../components/ui.tsx';
import { day, dateTime, label, money, today } from '../lib/format.ts';
import { useSession } from '../lib/session.tsx';
import type { AmenityBooking } from '../lib/types.ts';

const STATUSES = ['PENDING_APPROVAL', 'PENDING_PAYMENT', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'REJECTED', 'NO_SHOW', 'REFUNDED'];

/**
 * Amenity bookings (§30, §80 step 13).
 *
 * The committee side of the booking flow: approve or reject the ones that need a decision, see
 * which are waiting on payment, check people in at the gate, and cancel with a refund when a
 * resident pulls out inside the allowed window. The QR pass is issued only once a paid booking is
 * confirmed — that ordering is enforced server-side, not here.
 */
export function BookingsPage() {
  const { who, can } = useSession();
  const toast = useToast();
  const timezone = who?.society?.timezone;

  const [status, setStatus] = useState('');
  const [date, setDate] = useState('');
  const [page, setPage] = useState(1);
  const limit = 20;

  const bookings = useList<AmenityBooking>(
    '/amenity-bookings',
    { page, limit, status: status || undefined, date: date || undefined, sort: 'date', dir: 'desc' },
    [page, status, date],
  );

  const [detail, setDetail] = useState<AmenityBooking | null>(null);
  const [deciding, setDeciding] = useState<{ booking: AmenityBooking; decision: 'APPROVE' | 'REJECT' } | null>(null);
  const [cancelling, setCancelling] = useState<AmenityBooking | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function run(id: string, fn: () => Promise<unknown>, message: string) {
    setBusyId(id);
    try {
      await fn();
      toast.success(message);
      bookings.reload();
      setDetail(null);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusyId(null);
    }
  }

  const items = bookings.page.items;
  const awaitingApproval = items.filter((b) => b.status === 'PENDING_APPROVAL').length;
  const awaitingPayment = items.filter((b) => b.status === 'PENDING_PAYMENT').length;

  return (
    <div className="stack">
      {bookings.error ? <ErrorAlert error={bookings.error} /> : null}

      {awaitingApproval > 0 || awaitingPayment > 0 ? (
        <Alert tone="warning">
          On this page: <b>{awaitingApproval}</b> waiting for your approval
          {awaitingPayment > 0 ? (
            <>
              {' '}
              and <b>{awaitingPayment}</b> waiting for the resident to pay
            </>
          ) : null}
          .
        </Alert>
      ) : null}

      <Card
        title="Bookings"
        subtitle={`${number(bookings.page.total)} in total`}
        actions={
          <Button size="sm" variant="ghost" onClick={() => bookings.reload()}>
            Refresh
          </Button>
        }
        flush
      >
        <div className="card__body" style={{ paddingBottom: 0 }}>
          <div className="toolbar">
            <Input type="date" value={date} onChange={(e) => { setDate(e.target.value); setPage(1); }} />
            <Button size="sm" variant={date === today(timezone) ? 'primary' : 'default'} onClick={() => { setDate(today(timezone)); setPage(1); }}>
              Today
            </Button>
            <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
              <option value="">Any status</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {label(s)}
                </option>
              ))}
            </Select>
            {(date || status) && (
              <Button size="sm" variant="ghost" onClick={() => { setDate(''); setStatus(''); setPage(1); }}>
                Clear filters
              </Button>
            )}
            <div className="toolbar__spacer" />
          </div>
        </div>

        {bookings.loading ? (
          <Loading />
        ) : (
          <DataTable
            rows={items}
            rowKey={(b) => b._id}
            onRowClick={setDetail}
            empty={<EmptyState title="No bookings" hint="Nothing matches this filter." />}
            columns={[
              { key: 'ref', header: 'Ref', render: (b) => <code className="small">{b.referenceNumber ?? b._id.slice(0, 12)}</code> },
              {
                key: 'what',
                header: 'Amenity',
                render: (b) => (
                  <div>
                    <b>{b.amenity?.name ?? b.amenityId}</b>
                    <div className="faint small">
                      {b.startTime} – {b.endTime} · {number(b.numberOfPeople)} people
                    </div>
                  </div>
                ),
              },
              { key: 'when', header: 'Date', render: (b) => day(b.date, timezone) },
              {
                key: 'who',
                header: 'Booked by',
                render: (b) => b.unit?.label ?? b.unitLabel ?? b.unitId ?? '—',
              },
              {
                key: 'amount',
                header: 'Amount',
                align: 'right',
                render: (b) => (Number(b.totalAmount ?? 0) > 0 ? money(b.totalAmount) : <Pill tone="success">Free</Pill>),
              },
              {
                key: 'paid',
                header: 'Paid',
                render: (b) => (b.isPaid ? <Pill tone="success">Paid</Pill> : Number(b.totalAmount ?? 0) > 0 ? <Pill tone="warning">Unpaid</Pill> : <span className="faint">—</span>),
              },
              { key: 'status', header: 'Status', render: (b) => <StatusPill status={b.status} /> },
              {
                key: 'act',
                header: '',
                align: 'right',
                render: (b) => (
                  <div className="table__actions" onClick={(e) => e.stopPropagation()}>
                    {can('amenitybooking:approve') && b.status === 'PENDING_APPROVAL' ? (
                      <>
                        <Button size="sm" variant="primary" busy={busyId === b._id} onClick={() => setDeciding({ booking: b, decision: 'APPROVE' })}>
                          Approve
                        </Button>
                        <Button size="sm" busy={busyId === b._id} onClick={() => setDeciding({ booking: b, decision: 'REJECT' })}>
                          Reject
                        </Button>
                      </>
                    ) : null}
                    {can('amenitybooking:scan') && b.status === 'CONFIRMED' && !b.checkedInAt ? (
                      checkInWindow(b).open ? (
                        <Button
                          size="sm"
                          variant="primary"
                          busy={busyId === b._id}
                          onClick={() => void run(b._id, () => api.post(`/amenity-bookings/${b._id}/check-in`, {}), 'Checked in')}
                        >
                          Check in
                        </Button>
                      ) : (
                        <span className="faint small nowrap">
                          {checkInWindow(b).opensAt
                            ? `Gate opens ${dateTime(checkInWindow(b).opensAt, timezone)}`
                            : 'Window closed'}
                        </span>
                      )
                    ) : null}
                    {can('amenitybooking:scan') && b.checkedInAt && !b.checkedOutAt ? (
                      <Button
                        size="sm"
                        busy={busyId === b._id}
                        onClick={() => void run(b._id, () => api.post(`/amenity-bookings/${b._id}/check-out`, {}), 'Checked out')}
                      >
                        Check out
                      </Button>
                    ) : null}
                  </div>
                ),
              },
            ]}
          />
        )}

        <div className="card__foot">
          <Pagination page={page} limit={limit} total={bookings.page.total} onPage={setPage} />
        </div>
      </Card>

      {detail ? (
        <BookingDetail
          booking={detail}
          timezone={timezone}
          busy={busyId === detail._id}
          onClose={() => setDetail(null)}
          onApprove={() => setDeciding({ booking: detail, decision: 'APPROVE' })}
          onReject={() => setDeciding({ booking: detail, decision: 'REJECT' })}
          onCancel={() => setCancelling(detail)}
          onCheckIn={() => void run(detail._id, () => api.post(`/amenity-bookings/${detail._id}/check-in`, {}), 'Checked in')}
          onCheckOut={() => void run(detail._id, () => api.post(`/amenity-bookings/${detail._id}/check-out`, {}), 'Checked out')}
        />
      ) : null}

      {deciding ? (
        <DecideForm
          booking={deciding.booking}
          decision={deciding.decision}
          onClose={() => setDeciding(null)}
          onDone={(message) => {
            setDeciding(null);
            toast.success(message);
            bookings.reload();
          }}
        />
      ) : null}

      {cancelling ? (
        <CancelForm
          booking={cancelling}
          onClose={() => setCancelling(null)}
          onDone={(message) => {
            setCancelling(null);
            setDetail(null);
            toast.success(message);
            bookings.reload();
          }}
        />
      ) : null}
    </div>
  );
}

/** The grace the check-in endpoint applies on either side of the booked window. */
const CHECK_IN_GRACE_MS = 15 * 60_000;

/**
 * Whether the gate may check this booking in right now.
 *
 * Mirrors `POST /amenity-bookings/:id/check-in`, which accepts from 15 minutes before
 * `windowStart` until 15 minutes after `windowEnd` and rejects everything else. Offering the
 * button outside that window would only ever produce an error, so the row shows when it opens
 * instead.
 */
function checkInWindow(booking: AmenityBooking): { open: boolean; opensAt?: string; closed?: string } {
  if (!booking.windowStart || !booking.windowEnd) return { open: true };
  const now = Date.now();
  const from = new Date(booking.windowStart).getTime() - CHECK_IN_GRACE_MS;
  const till = new Date(booking.windowEnd).getTime() + CHECK_IN_GRACE_MS;
  if (now < from) return { open: false, opensAt: booking.windowStart };
  if (now > till) return { open: false, closed: booking.windowEnd };
  return { open: true };
}

function number(value: unknown): string {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n.toLocaleString('en-IN') : '0';
}

function BookingDetail({
  booking,
  timezone,
  busy,
  onClose,
  onApprove,
  onReject,
  onCancel,
  onCheckIn,
  onCheckOut,
}: {
  booking: AmenityBooking;
  timezone?: string;
  busy: boolean;
  onClose: () => void;
  onApprove: () => void;
  onReject: () => void;
  onCancel: () => void;
  onCheckIn: () => void;
  onCheckOut: () => void;
}) {
  const { can } = useSession();
  const [pass, setPass] = useState<{ token?: string; dataUrl?: string; passId?: string } | null>(null);
  const [passError, setPassError] = useState<string | null>(null);

  async function loadPass() {
    setPassError(null);
    try {
      const result = await api.get<{ token?: string; dataUrl?: string; passId?: string }>(`/amenity-bookings/${booking._id}/qr`);
      setPass(result);
    } catch (err) {
      setPassError(err instanceof Error ? err.message : 'Could not load the pass');
    }
  }

  const cancellable = can('amenitybooking:cancel') && !['CANCELLED', 'REJECTED', 'COMPLETED', 'REFUNDED'].includes(String(booking.status));

  return (
    <Modal
      title={`${booking.referenceNumber ?? 'Booking'} — ${booking.amenity?.name ?? booking.amenityId}`}
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          {can('amenitybooking:approve') && booking.status === 'PENDING_APPROVAL' ? (
            <>
              <Button variant="danger" busy={busy} onClick={onReject}>
                Reject
              </Button>
              <Button variant="primary" busy={busy} onClick={onApprove}>
                Approve
              </Button>
            </>
          ) : null}
          {can('amenitybooking:scan') && booking.status === 'CONFIRMED' && !booking.checkedInAt && checkInWindow(booking).open ? (
            <Button variant="primary" busy={busy} onClick={onCheckIn}>
              Check in
            </Button>
          ) : null}
          {can('amenitybooking:scan') && booking.checkedInAt && !booking.checkedOutAt ? (
            <Button busy={busy} onClick={onCheckOut}>
              Check out
            </Button>
          ) : null}
          {cancellable ? (
            <Button variant="danger" onClick={onCancel}>
              Cancel booking
            </Button>
          ) : null}
        </>
      }
    >
      <div className="grid grid--2">
        <Card title="Booking">
          <KeyValue
            items={[
              ['Status', <StatusPill key="s" status={booking.status} />],
              ['Amenity', booking.amenity?.name ?? booking.amenityId],
              ['Date', day(booking.date, timezone)],
              ['Time', `${booking.startTime} – ${booking.endTime}`],
              ['Validity window', `${dateTime(booking.windowStart, timezone)} → ${dateTime(booking.windowEnd, timezone)}`],
              ['People', number(booking.numberOfPeople)],
              ['Unit', booking.unit?.label ?? booking.unitLabel ?? booking.unitId ?? '—'],
              ['Purpose', booking.purpose ? label(booking.purpose) : '—'],
            ]}
          />
          {booking.notes ? <p className="small muted mt">{String(booking.notes)}</p> : null}
        </Card>

        <Card title="Money">
          <KeyValue
            items={[
              ['Fee', money(booking.fee ?? 0)],
              ['Deposit', Number(booking.deposit ?? 0) > 0 ? money(booking.deposit) : 'None'],
              ['Total', money(booking.totalAmount ?? 0)],
              ['Paid', booking.isPaid ? 'Yes' : 'No'],
              ['Refunded', booking.refundAmount ? money(booking.refundAmount) : '—'],
              ['Payment', booking.paymentId ? <code key="p">{String(booking.paymentId)}</code> : '—'],
            ]}
          />
          {booking.status === 'CONFIRMED' && !booking.checkedInAt && !checkInWindow(booking).open ? (
            <Alert tone="info">
              {checkInWindow(booking).opensAt
                ? `The gate can check this in from ${dateTime(checkInWindow(booking).opensAt, timezone)} (15 minutes before the slot).`
                : `This booking's window closed at ${dateTime(checkInWindow(booking).closed, timezone)}. It can no longer be checked in.`}
            </Alert>
          ) : null}
          {booking.status === 'PENDING_PAYMENT' ? (
            <Alert tone="warning">
              Waiting on the resident to pay {money(booking.totalAmount ?? 0)}. The booking is not
              confirmed and no pass exists until the payment settles.
            </Alert>
          ) : null}
          {booking.rejectReason ? <Alert tone="danger">Rejected: {String(booking.rejectReason)}</Alert> : null}
          {booking.cancellationReason ? <Alert tone="info">Cancelled: {String(booking.cancellationReason)}</Alert> : null}
        </Card>
      </div>

      <Card title="Entry pass" subtitle="Issued only once a paid booking is confirmed">
        {passError ? <ErrorAlert error={passError} /> : null}
        {pass?.dataUrl ? (
          <div className="row" style={{ gap: 16, alignItems: 'flex-start' }}>
            <img src={pass.dataUrl} alt="Booking entry QR" width={160} height={160} style={{ borderRadius: 8, background: '#fff' }} />
            <div>
              <KeyValue items={[['Pass id', pass.passId ?? '—'], ['Token', pass.token ? <code key="t" className="small">{pass.token.slice(0, 28)}…</code> : '—']]} />
              <p className="small muted mt">The gate scans this to admit the booking inside its validity window.</p>
            </div>
          </div>
        ) : (
          <div className="row">
            <Button size="sm" variant="primary" onClick={() => void loadPass()}>
              Load the entry pass
            </Button>
            {booking.checkedInAt ? <Pill tone="success">Checked in {dateTime(booking.checkedInAt, timezone)}</Pill> : null}
          </div>
        )}
      </Card>
    </Modal>
  );
}

function DecideForm({
  booking,
  decision,
  onClose,
  onDone,
}: {
  booking: AmenityBooking;
  decision: 'APPROVE' | 'REJECT';
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const approving = decision === 'APPROVE';

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(`/amenity-bookings/${booking._id}/decide`, {
        decision,
        reason: reason.trim() || undefined,
      });
      onDone(approving ? 'Booking approved' : 'Booking rejected');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={approving ? `Approve ${booking.referenceNumber ?? 'this booking'}` : `Reject ${booking.referenceNumber ?? 'this booking'}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={approving ? 'primary' : 'danger'} busy={busy} onClick={submit} disabled={!approving && !reason.trim()}>
            {approving ? 'Approve' : 'Reject'}
          </Button>
        </>
      }
    >
      {error ? <ErrorAlert error={error} /> : null}
      <form onSubmit={submit}>
        <Alert tone={approving ? 'info' : 'warning'}>
          {booking.amenity?.name ?? 'This amenity'} on {day(booking.date)} from {booking.startTime} to{' '}
          {booking.endTime}
          {Number(booking.totalAmount ?? 0) > 0 ? (
            approving ? (
              <>
                . Approving moves it to <b>pending payment</b> of {money(booking.totalAmount)} — it is
                not confirmed until that settles.
              </>
            ) : (
              <>
                . {money(booking.totalAmount)} would have been charged.
              </>
            )
          ) : (
            approving ? '. This amenity is free, so approval confirms it immediately.' : '.'
          )}
        </Alert>
        <Field label={approving ? 'Note (optional)' : 'Reason'} required={!approving} hint="The resident sees this.">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder={approving ? 'Enjoy your booking' : 'The hall is reserved for the society AGM'} />
        </Field>
      </form>
    </Modal>
  );
}

function CancelForm({ booking, onClose, onDone }: { booking: AmenityBooking; onClose: () => void; onDone: (message: string) => void }) {
  const [reason, setReason] = useState('');
  const [refundRequested, setRefundRequested] = useState(Boolean(booking.isPaid));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(`/amenity-bookings/${booking._id}/cancel`, {
        reason: reason.trim() || undefined,
        refundRequested,
      });
      onDone(refundRequested && booking.isPaid ? 'Booking cancelled and refund requested' : 'Booking cancelled');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Cancel ${booking.referenceNumber ?? 'this booking'}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Keep booking</Button>
          <Button variant="danger" busy={busy} onClick={submit}>
            Cancel booking
          </Button>
        </>
      }
    >
      {error ? <ErrorAlert error={error} /> : null}
      <form onSubmit={submit}>
        <Alert tone="warning">
          Cancelling releases the slot immediately. Whether any money comes back is decided by the
          amenity's own cancellation window and refund percentage, not by this form.
        </Alert>
        <Field label="Reason">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Resident asked to cancel" />
        </Field>
        {booking.isPaid ? (
          <label className="row" style={{ gap: 8 }}>
            <input type="checkbox" checked={refundRequested} onChange={(e) => setRefundRequested(e.target.checked)} />
            <span className="small">
              Request a refund of {money(booking.totalAmount ?? 0)} — the server applies the amenity's
              refund rules and may reduce or decline it.
            </span>
          </label>
        ) : null}
      </form>
    </Modal>
  );
}
