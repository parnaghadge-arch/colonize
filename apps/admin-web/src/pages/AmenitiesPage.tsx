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
  Pill,
  Select,
  StatusPill,
  Textarea,
  useToast,
} from '../components/ui.tsx';
import { label, money, today } from '../lib/format.ts';
import { useSession } from '../lib/session.tsx';
import type { Amenity } from '../lib/types.ts';

const TYPES = [
  'CLUBHOUSE', 'SWIMMING_POOL', 'GYM', 'SPORTS_COURT', 'COMMUNITY_HALL', 'PLAYGROUND',
  'PARK', 'TERRACE', 'BANQUET_HALL', 'LIBRARY', 'YOGA_ROOM', 'OTHER',
];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface Slot {
  startTime: string;
  endTime: string;
  slotId: string | null;
  capacity: number;
  booked: number;
  remaining: number;
  fee: number;
  deposit: number;
  available: boolean;
  isPast: boolean;
}

interface Availability {
  amenityId: string;
  amenity?: Record<string, unknown>;
  date: string;
  timezone?: string;
  closed: boolean;
  slots: Slot[];
}

/**
 * Amenities (§30).
 *
 * The bookable facilities and the rules that govern them: capacity, opening hours, slot length,
 * fee, deposit, whether the committee must approve, and how far ahead a resident may book. The
 * availability viewer here calls the same endpoint the resident app does, so an administrator can
 * see exactly what a resident would be offered before changing a rule.
 */
export function AmenitiesPage() {
  const { can } = useSession();
  const toast = useToast();

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const limit = 20;

  const amenities = useList<Amenity>('/amenities', { page, limit, search: search || undefined }, [page, search]);

  const [detail, setDetail] = useState<Amenity | null>(null);
  const [availability, setAvailability] = useState<Amenity | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <div className="stack">
      {amenities.error ? <ErrorAlert error={amenities.error} /> : null}

      <Card
        title="Amenities"
        subtitle={`${number(amenities.page.total)} bookable facilities`}
        actions={
          can('amenity:create') ? (
            <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
              Add amenity
            </Button>
          ) : null
        }
        flush
      >
        <div className="card__body" style={{ paddingBottom: 0 }}>
          <div className="toolbar">
            <Input
              placeholder="Search amenity"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              style={{ minWidth: 220 }}
            />
            <div className="toolbar__spacer" />
            <Button size="sm" variant="ghost" onClick={() => amenities.reload()}>
              Refresh
            </Button>
          </div>
        </div>

        {amenities.loading ? (
          <Loading />
        ) : (
          <DataTable
            rows={amenities.page.items}
            rowKey={(a) => a._id}
            onRowClick={setDetail}
            empty={<EmptyState title="No amenities" hint="Add the clubhouse, pool, gym and courts residents can book." />}
            columns={[
              {
                key: 'name',
                header: 'Amenity',
                render: (a) => (
                  <div>
                    <b>{a.name}</b>
                    <div className="faint small">{label(a.type)}</div>
                  </div>
                ),
              },
              { key: 'capacity', header: 'Capacity', align: 'right', render: (a) => number(a.capacity) },
              {
                key: 'hours',
                header: 'Open',
                render: (a) => (
                  <span className="small">
                    {a.openTime ?? '—'} – {a.closeTime ?? '—'}
                  </span>
                ),
              },
              {
                key: 'slot',
                header: 'Slot',
                align: 'right',
                render: (a) => <span className="small">{number(a.slotDurationMinutes)} min</span>,
              },
              {
                key: 'fee',
                header: 'Fee',
                align: 'right',
                render: (a) => (Number(a.bookingFee ?? 0) > 0 ? money(a.bookingFee) : <Pill tone="success">Free</Pill>),
              },
              {
                key: 'approval',
                header: 'Approval',
                render: (a) => (a.requireApproval ? <Pill tone="warning">Required</Pill> : <Pill>Automatic</Pill>),
              },
              { key: 'bookings', header: 'Bookings', align: 'right', render: (a) => number(a.totalBookings) },
              { key: 'revenue', header: 'Revenue', align: 'right', render: (a) => money(a.totalRevenue ?? 0) },
              {
                key: 'status',
                header: '',
                render: (a) => (a.isActive === false ? <Pill tone="danger">Inactive</Pill> : <StatusPill status="ACTIVE" />),
              },
            ]}
          />
        )}

        <div className="card__foot">
          <Pagination page={page} limit={limit} total={amenities.page.total} onPage={setPage} />
        </div>
      </Card>

      {detail ? (
        <AmenityDetail
          amenity={detail}
          onClose={() => setDetail(null)}
          onAvailability={() => {
            setAvailability(detail);
            setDetail(null);
          }}
          onChanged={() => amenities.reload()}
        />
      ) : null}

      {availability ? <AvailabilityModal amenity={availability} onClose={() => setAvailability(null)} /> : null}

      {creating ? (
        <AmenityForm
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
            toast.success('Amenity added');
            amenities.reload();
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

function AmenityDetail({
  amenity,
  onClose,
  onAvailability,
  onChanged,
}: {
  amenity: Amenity;
  onClose: () => void;
  onAvailability: () => void;
  onChanged: () => void;
}) {
  const { can } = useSession();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);

  async function toggleActive() {
    setBusy(true);
    try {
      await api.patch(`/amenities/${amenity._id}`, { isActive: amenity.isActive === false });
      toast.success(amenity.isActive === false ? 'Amenity reactivated' : 'Amenity deactivated');
      onChanged();
      onClose();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  const closedOn = (amenity.closedOnDays ?? []).map((d: unknown) => DAYS[Number(d)] ?? String(d)).join(', ');

  return (
    <Modal
      title={amenity.name}
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          <Button variant="primary" onClick={onAvailability}>
            Check availability
          </Button>
          {can('amenity:update') ? (
            <Button variant={amenity.isActive === false ? 'primary' : 'danger'} busy={busy} onClick={() => void toggleActive()}>
              {amenity.isActive === false ? 'Reactivate' : 'Deactivate'}
            </Button>
          ) : null}
        </>
      }
    >
      {editing ? (
        <AmenityForm
          amenity={amenity}
          onClose={() => setEditing(false)}
          onDone={() => {
            setEditing(false);
            toast.success('Amenity updated');
            onChanged();
            onClose();
          }}
        />
      ) : (
        <div className="grid grid--2">
          <Card
            title="Facility"
            actions={can('amenity:update') ? <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Edit</Button> : null}
          >
            <KeyValue
              items={[
                ['Type', label(amenity.type)],
                ['Capacity', `${number(amenity.capacity)} people`],
                ['Open', `${amenity.openTime ?? '—'} – ${amenity.closeTime ?? '—'}`],
                ['Slot length', `${number(amenity.slotDurationMinutes)} minutes`],
                ['Gap between slots', `${number(amenity.slotGapMinutes)} minutes`],
                ['Closed on', closedOn || 'Open every day'],
                ['Status', amenity.isActive === false ? 'Inactive' : 'Active'],
              ]}
            />
            {amenity.description ? <p className="small muted mt">{String(amenity.description)}</p> : null}
          </Card>

          <Card title="Booking rules">
            <KeyValue
              items={[
                ['Fee', Number(amenity.bookingFee ?? 0) > 0 ? money(amenity.bookingFee) : 'Free'],
                ['Refundable deposit', Number(amenity.deposit ?? 0) > 0 ? money(amenity.deposit) : 'None'],
                ['Committee approval', amenity.requireApproval ? 'Required' : 'Automatic'],
                ['Bookable up to', `${number(amenity.maxAdvanceDays)} days ahead`],
                ['Slots per resident per day', number(amenity.maxSlotsPerUserPerDay)],
                ['Cancellation allowed', amenity.allowCancellation === false ? 'No' : 'Yes'],
                ['Cancel at least', `${number(amenity.cancellationHoursBefore)} hours before`],
                ['Refund on cancellation', `${number(amenity.refundPercent ?? 100)}%`],
                ['Total bookings', number(amenity.totalBookings)],
                ['Revenue', money(amenity.totalRevenue ?? 0)],
              ]}
            />
            {(amenity.rules ?? []).length > 0 ? (
              <div className="mt">
                <div className="small muted">House rules</div>
                <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  {(amenity.rules ?? []).map((rule: unknown) => (
                    <li key={String(rule)}>{String(rule)}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Card>
        </div>
      )}
    </Modal>
  );
}

/**
 * What a resident would actually be offered for a day — the same endpoint the mobile app calls,
 * so changing a rule above can be confirmed here immediately.
 */
function AvailabilityModal({ amenity, onClose }: { amenity: Amenity; onClose: () => void }) {
  const { who } = useSession();
  const [date, setDate] = useState(today(who?.society?.timezone));
  const availability = useResource<Availability>(`/amenities/${amenity._id}/availability`, { date }, [date, amenity._id]);

  const slots = availability.data?.slots ?? [];
  const free = slots.filter((slot) => slot.available && !slot.isPast);

  return (
    <Modal title={`${amenity.name} — availability`} onClose={onClose} wide>
      <div className="toolbar">
        <Field label="Date">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <div className="toolbar__spacer" />
        {availability.data ? (
          <Pill tone={availability.data.closed ? 'danger' : 'success'}>
            {availability.data.closed ? 'Closed on this day' : `${free.length} of ${slots.length} slots free`}
          </Pill>
        ) : null}
      </div>

      {availability.error ? <ErrorAlert error={availability.error} /> : null}

      {availability.loading ? (
        <Loading />
      ) : availability.data?.closed ? (
        <Alert tone="warning">
          This amenity does not open on {date}. That comes from its own `closedOnDays` rule, not
          from a lack of bookings.
        </Alert>
      ) : slots.length === 0 ? (
        <EmptyState title="No slots" hint="Define the slot grid for this amenity first." />
      ) : (
        <DataTable
          rows={slots}
          rowKey={(slot, index) => `${slot.startTime}-${index}`}
          columns={[
            {
              key: 'time',
              header: 'Slot',
              render: (slot) => (
                <b>
                  {slot.startTime} – {slot.endTime}
                </b>
              ),
            },
            {
              key: 'capacity',
              header: 'Capacity',
              align: 'right',
              render: (slot) => `${number(slot.booked)} booked / ${number(slot.capacity)}`,
            },
            { key: 'remaining', header: 'Remaining', align: 'right', render: (slot) => number(slot.remaining) },
            { key: 'fee', header: 'Fee', align: 'right', render: (slot) => (slot.fee ? money(slot.fee) : 'Free') },
            {
              key: 'deposit',
              header: 'Deposit',
              align: 'right',
              render: (slot) => (slot.deposit ? money(slot.deposit) : <span className="faint">—</span>),
            },
            {
              key: 'state',
              header: 'State',
              render: (slot) =>
                slot.isPast ? (
                  <Pill>Past</Pill>
                ) : slot.available ? (
                  <Pill tone="success">Available</Pill>
                ) : (
                  <Pill tone="danger">Full</Pill>
                ),
            },
          ]}
        />
      )}
    </Modal>
  );
}

function AmenityForm({
  amenity,
  onClose,
  onDone,
}: {
  amenity?: Amenity;
  onClose: () => void;
  onDone: () => void;
}) {
  const editing = Boolean(amenity);
  const [name, setName] = useState(amenity?.name ?? '');
  const [type, setType] = useState(String(amenity?.type ?? 'OTHER'));
  const [description, setDescription] = useState(String(amenity?.description ?? ''));
  const [capacity, setCapacity] = useState(String(amenity?.capacity ?? ''));
  const [openTime, setOpenTime] = useState(String(amenity?.openTime ?? '08:00'));
  const [closeTime, setCloseTime] = useState(String(amenity?.closeTime ?? '20:00'));
  const [slotDurationMinutes, setSlotMinutes] = useState(String(amenity?.slotDurationMinutes ?? 60));
  const [bookingFee, setFee] = useState(String(amenity?.bookingFee ?? 0));
  const [deposit, setDeposit] = useState(String(amenity?.deposit ?? 0));
  const [requireApproval, setRequireApproval] = useState(Boolean(amenity?.requireApproval));
  const [maxAdvanceDays, setMaxAdvance] = useState(String(amenity?.maxAdvanceDays ?? 30));
  const [cancellationHoursBefore, setCancelHours] = useState(String(amenity?.cancellationHoursBefore ?? 24));
  const [refundPercent, setRefund] = useState(String(amenity?.refundPercent ?? 100));
  const [rules, setRules] = useState((amenity?.rules ?? []).join('\n'));
  const [closedOnDays, setClosedOnDays] = useState<number[]>((amenity?.closedOnDays as number[] | undefined) ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  function toggleDay(day: number) {
    setClosedOnDays((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day].sort()));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const payload = {
      name: name.trim(),
      type,
      description: description.trim() || undefined,
      capacity: capacity.trim() ? Number(capacity) : undefined,
      openTime,
      closeTime,
      slotDurationMinutes: Number(slotDurationMinutes) || undefined,
      bookingFee: Number(bookingFee) || 0,
      deposit: Number(deposit) || 0,
      requireApproval,
      allowCancellation: true,
      cancellationHoursBefore: Number(cancellationHoursBefore) || undefined,
      refundPercent: Number(refundPercent) || undefined,
      maxAdvanceDays: Number(maxAdvanceDays) || undefined,
      rules: rules
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
      closedOnDays,
    };
    try {
      if (editing) await api.patch(`/amenities/${amenity!._id}`, payload);
      else await api.post('/amenities', payload);
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={editing ? `Edit ${amenity!.name}` : 'Add an amenity'}
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={submit}>
            {editing ? 'Save changes' : 'Add amenity'}
          </Button>
        </>
      }
    >
      {error ? <ErrorAlert error={error} /> : null}
      <form onSubmit={submit}>
        <div className="form-row">
          <Field label="Name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Community Hall" required autoFocus />
          </Field>
          <Field label="Type">
            <Select value={type} onChange={(e) => setType(e.target.value)}>
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {label(t)}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <Field label="Description">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>

        <div className="form-row">
          <Field label="Capacity" hint="How many people may be inside at once.">
            <Input value={capacity} onChange={(e) => setCapacity(e.target.value)} inputMode="numeric" placeholder="60" />
          </Field>
          <Field label="Slot length (minutes)">
            <Input value={slotDurationMinutes} onChange={(e) => setSlotMinutes(e.target.value)} inputMode="numeric" />
          </Field>
        </div>

        <div className="form-row">
          <Field label="Opens at">
            <Input type="time" value={openTime} onChange={(e) => setOpenTime(e.target.value)} />
          </Field>
          <Field label="Closes at">
            <Input type="time" value={closeTime} onChange={(e) => setCloseTime(e.target.value)} />
          </Field>
        </div>

        <Field label="Closed on these days">
          <div className="row row--wrap" style={{ gap: 6 }}>
            {DAYS.map((dayName, index) => (
              <Button
                key={dayName}
                type="button"
                size="sm"
                variant={closedOnDays.includes(index) ? 'danger' : 'default'}
                onClick={() => toggleDay(index)}
              >
                {dayName.slice(0, 3)}
              </Button>
            ))}
          </div>
        </Field>

        <div className="form-row">
          <Field label="Booking fee (₹)" hint="0 makes the amenity free to book.">
            <Input value={bookingFee} onChange={(e) => setFee(e.target.value)} inputMode="decimal" />
          </Field>
          <Field label="Refundable deposit (₹)">
            <Input value={deposit} onChange={(e) => setDeposit(e.target.value)} inputMode="decimal" />
          </Field>
        </div>

        <Field label="Approval">
          <div className="row" style={{ gap: 12 }}>
            <Button type="button" size="sm" variant={!requireApproval ? 'primary' : 'default'} onClick={() => setRequireApproval(false)}>
              Confirm automatically
            </Button>
            <Button type="button" size="sm" variant={requireApproval ? 'primary' : 'default'} onClick={() => setRequireApproval(true)}>
              Committee must approve
            </Button>
          </div>
        </Field>

        <div className="form-row">
          <Field label="Bookable up to (days ahead)">
            <Input value={maxAdvanceDays} onChange={(e) => setMaxAdvance(e.target.value)} inputMode="numeric" />
          </Field>
          <Field label="Cancel at least (hours before)">
            <Input value={cancellationHoursBefore} onChange={(e) => setCancelHours(e.target.value)} inputMode="numeric" />
          </Field>
          <Field label="Refund on cancellation (%)">
            <Input value={refundPercent} onChange={(e) => setRefund(e.target.value)} inputMode="numeric" />
          </Field>
        </div>

        <Field label="House rules" hint="One per line — shown to the resident before they confirm.">
          <Textarea value={rules} onChange={(e) => setRules(e.target.value)} placeholder={'Members only\nNo glass containers'} />
        </Field>
      </form>
    </Modal>
  );
}
