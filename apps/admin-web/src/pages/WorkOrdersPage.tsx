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
  Select,
  StatusPill,
  Textarea,
  useToast,
} from '../components/ui.tsx';
import { ago, dateTime, label, money } from '../lib/format.ts';
import { useSession } from '../lib/session.tsx';
import type { Vendor, WorkOrder } from '../lib/types.ts';

interface HistoryEntry {
  at: string;
  status: string;
  actorName?: string | null;
  note?: string | null;
  progressPercent?: number | null;
}

const STATUSES = ['REQUESTED', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'VERIFIED', 'CLOSED', 'CANCELLED', 'ON_HOLD'];
const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

/**
 * Work orders (§37).
 *
 * The executable half of a complaint: who does the job, when it is scheduled, and what it actually
 * cost. Status moves here mirror the vendor and staff mobile apps, so both sides read the same
 * board — and every move appends to the work order's history.
 */
export function WorkOrdersPage() {
  const { who, can } = useSession();
  const toast = useToast();
  const timezone = who?.society?.timezone;

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const limit = 20;

  const orders = useList<WorkOrder>(
    '/work-orders',
    { page, limit, search: search || undefined, status: status || undefined, sort: 'createdAt', dir: 'desc' },
    [page, search, status],
  );

  const [detail, setDetail] = useState<WorkOrder | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <div className="stack">
      {orders.error ? <ErrorAlert error={orders.error} /> : null}

      <Card
        title="Work orders"
        subtitle={`${number(orders.page.total)} jobs raised with vendors and staff`}
        actions={
          can('workorder:create') ? (
            <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
              New work order
            </Button>
          ) : null
        }
        flush
      >
        <div className="card__body" style={{ paddingBottom: 0 }}>
          <div className="toolbar">
            <Input
              placeholder="Search title or reference"
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
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {label(s)}
                </option>
              ))}
            </Select>
            <div className="toolbar__spacer" />
            <Button size="sm" variant="ghost" onClick={() => orders.reload()}>
              Refresh
            </Button>
          </div>
        </div>

        {orders.loading ? (
          <Loading />
        ) : (
          <DataTable
            rows={orders.page.items}
            onRowClick={setDetail}
            empty={<EmptyState title="No work orders" hint="Assign a complaint, or raise a job directly." />}
            columns={[
              { key: 'ref', header: 'Ref', render: (o) => <code className="small">{o.referenceNumber ?? o._id.slice(0, 12)}</code> },
              {
                key: 'title',
                header: 'Job',
                render: (o) => (
                  <div>
                    <b>{o.title}</b>
                    <div className="faint small">
                      {o.complaint?.title ? `From ${o.complaint.referenceNumber ?? 'complaint'}` : label(o.category ?? 'GENERAL')}
                      {o.unitLabel ? ` · ${o.unitLabel}` : ''}
                    </div>
                  </div>
                ),
              },
              {
                key: 'assignee',
                header: 'Assigned to',
                render: (o) => o.vendor?.businessName ?? o.assigneeName ?? <span className="faint">Unassigned</span>,
              },
              {
                key: 'due',
                header: 'Scheduled',
                align: 'right',
                render: (o) => <span className="small muted">{o.scheduledStart ? dateTime(o.scheduledStart, timezone) : '—'}</span>,
              },
              {
                key: 'cost',
                header: 'Cost',
                align: 'right',
                render: (o) => {
                  const value = o.actualCost ?? o.estimatedCost;
                  return value ? <span title={o.actualCost ? 'Actual' : 'Estimated'}>{money(value)}</span> : <span className="faint">—</span>;
                },
              },
              { key: 'priority', header: 'Priority', render: (o) => label(o.priority ?? 'MEDIUM') },
              { key: 'status', header: 'Status', render: (o) => <StatusPill status={o.status} /> },
              { key: 'age', header: 'Raised', align: 'right', render: (o) => <span className="small muted">{ago(o.createdAt)}</span> },
            ]}
          />
        )}

        <div className="card__foot">
          <Pagination page={page} limit={limit} total={orders.page.total} onPage={setPage} />
        </div>
      </Card>

      {detail ? (
        <WorkOrderDetail order={detail} timezone={timezone} onClose={() => setDetail(null)} onChanged={() => orders.reload()} />
      ) : null}
      {creating ? (
        <CreateWorkOrderForm
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
            toast.success('Work order created');
            orders.reload();
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

function WorkOrderDetail({
  order,
  timezone,
  onClose,
  onChanged,
}: {
  order: WorkOrder;
  timezone?: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { can } = useSession();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState('');
  const [actualCost, setActualCost] = useState('');

  // Not a paginated list: the endpoint returns the work order's own embedded trail.
  const trail = useResource<{ history: HistoryEntry[]; attachments: unknown[] }>(`/work-orders/${order._id}/history`);
  const history = trail.data?.history ?? [];

  async function changeStatus(status: string) {
    setBusy(status);
    setError(null);
    try {
      await api.patch(`/work-orders/${order._id}/status`, {
        status,
        note: note.trim() || undefined,
        actualCost: actualCost.trim() ? Number(actualCost) : undefined,
        progressPercent: status === 'COMPLETED' || status === 'VERIFIED' ? 100 : undefined,
      });
      toast.success(`Work order marked ${label(status).toLowerCase()}`);
      trail.reload();
      onChanged();
    } catch (err) {
      setError(err);
      toast.error(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal title={`${order.referenceNumber ?? 'Work order'} — ${order.title}`} onClose={onClose} wide>
      {error ? <ErrorAlert error={error} /> : null}
      <div className="grid grid--2">
        <Card title="Job">
          <KeyValue
            items={[
              ['Status', <StatusPill key="s" status={order.status} />],
              ['Priority', label(order.priority ?? 'MEDIUM')],
              ['Category', label(order.category ?? 'GENERAL')],
              ['Vendor', order.vendor?.businessName ?? '—'],
              ['Assignee', order.assigneeName ?? 'Unassigned'],
              ['Unit', order.unitLabel ?? order.unit?.label ?? 'Common area'],
              ['Complaint', order.complaint?.referenceNumber ?? '—'],
              ['Scheduled start', order.scheduledStart ? dateTime(order.scheduledStart, timezone) : '—'],
              ['Scheduled end', order.scheduledEnd ? dateTime(order.scheduledEnd, timezone) : '—'],
              ['Started', order.startedAt ? dateTime(order.startedAt, timezone) : '—'],
              ['Completed', order.completedAt ? dateTime(order.completedAt, timezone) : '—'],
              ['Estimated cost', order.estimatedCost ? money(order.estimatedCost) : '—'],
              ['Actual cost', order.actualCost ? money(order.actualCost) : '—'],
              ['Materials needed', order.materialRequired ? String(order.materialRequired) : '—'],
            ]}
          />
          {order.description ? (
            <p className="small muted mt" style={{ whiteSpace: 'pre-wrap' }}>
              {order.description}
            </p>
          ) : null}
        </Card>

        <div className="stack">
          {can('workorder:update') ? (
            <Card title="Update the job">
              <Field label="Note" hint="Recorded in the work order history and shown to the resident on completion.">
                <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Parts replaced, time on site…" />
              </Field>
              <Field label="Actual cost (₹)" hint="Only needed once the work is done.">
                <Input value={actualCost} onChange={(e) => setActualCost(e.target.value)} inputMode="decimal" placeholder="0" />
              </Field>
              <div className="row row--wrap">
                {STATUSES.filter((s) => s !== order.status).map((s) => (
                  <Button key={s} size="sm" busy={busy === s} onClick={() => void changeStatus(s)}>
                    → {label(s)}
                  </Button>
                ))}
              </div>
            </Card>
          ) : null}

          <Card title="History" subtitle={`${history.length} entries`}>
            {trail.loading ? (
              <Loading />
            ) : history.length === 0 ? (
              <EmptyState title="No history yet" />
            ) : (
              history.map((h, index) => (
                <div key={`${h.at}-${index}`} style={{ padding: '8px 0', borderTop: '1px solid var(--border)' }}>
                  <div className="row row--between">
                    <StatusPill status={h.status} />
                    <span className="faint small">{dateTime(h.at, timezone)}</span>
                  </div>
                  <div className="small muted">
                    {h.actorName ?? 'System'}
                    {typeof h.progressPercent === 'number' ? ` · ${h.progressPercent}%` : ''}
                    {h.note ? ` — ${h.note}` : ''}
                  </div>
                </div>
              ))
            )}
          </Card>
        </div>
      </div>
    </Modal>
  );
}

function CreateWorkOrderForm({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('MAINTENANCE');
  const [priority, setPriority] = useState('MEDIUM');
  const [vendorId, setVendorId] = useState('');
  const [scheduledStart, setStart] = useState('');
  const [scheduledEnd, setEnd] = useState('');
  const [estimatedCost, setEstimatedCost] = useState('');
  const [materialRequired, setMaterials] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const vendors = useList<Vendor>('/vendors', { limit: 100, status: 'ACTIVE' }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/work-orders', {
        title: title.trim(),
        description: description.trim() || undefined,
        category,
        priority,
        vendorId: vendorId || undefined,
        assigneeType: vendorId ? 'VENDOR' : undefined,
        assigneeId: vendorId || undefined,
        scheduledStart: scheduledStart || undefined,
        scheduledEnd: scheduledEnd || undefined,
        estimatedCost: estimatedCost.trim() ? Number(estimatedCost) : undefined,
        materialRequired: materialRequired.trim() || undefined,
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
      title="New work order"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={submit}>
            Create work order
          </Button>
        </>
      }
    >
      {error ? <ErrorAlert error={error} /> : null}
      <form onSubmit={submit}>
        <Field label="Title" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Replace the lift lobby fan" required autoFocus />
        </Field>
        <Field label="Description">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What needs doing, and any access notes" />
        </Field>
        <div className="form-row">
          <Field label="Category">
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              {['MAINTENANCE', 'PLUMBING', 'ELECTRICAL', 'CARPENTRY', 'PAINTING', 'CLEANING', 'SECURITY', 'GARDENING', 'LIFT', 'OTHER'].map((c) => (
                <option key={c} value={c}>
                  {label(c)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Priority">
            <Select value={priority} onChange={(e) => setPriority(e.target.value)}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {label(p)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Vendor" hint="Only active vendors can be assigned.">
          <Select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
            <option value="">Leave unassigned</option>
            {vendors.page.items.map((v) => (
              <option key={v._id} value={v._id}>
                {v.businessName}
                {v.serviceCategories?.length ? ` — ${v.serviceCategories.map(label).join(', ')}` : ''}
              </option>
            ))}
          </Select>
        </Field>
        <div className="form-row">
          <Field label="Scheduled start">
            <Input type="datetime-local" value={scheduledStart} onChange={(e) => setStart(e.target.value)} />
          </Field>
          <Field label="Scheduled end">
            <Input type="datetime-local" value={scheduledEnd} onChange={(e) => setEnd(e.target.value)} />
          </Field>
        </div>
        <div className="form-row">
          <Field label="Estimated cost (₹)">
            <Input value={estimatedCost} onChange={(e) => setEstimatedCost(e.target.value)} inputMode="decimal" placeholder="0" />
          </Field>
          <Field label="Materials required">
            <Input value={materialRequired} onChange={(e) => setMaterials(e.target.value)} placeholder="2 fan units, wiring" />
          </Field>
        </div>
      </form>
    </Modal>
  );
}
