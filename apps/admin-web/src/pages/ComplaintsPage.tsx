import { useState, type FormEvent } from 'react';
import { api } from '../lib/api.ts';
import { useList } from '../lib/useResource.ts';
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
  Textarea,
  useToast,
} from '../components/ui.tsx';
import { UnitPicker } from '../components/UnitPicker.tsx';
import { ago, dateTime, label } from '../lib/format.ts';
import { useSession } from '../lib/session.tsx';
import type { Complaint, ComplaintComment, Staff, Vendor } from '../lib/types.ts';
import { Avatar } from './ResidentsPage.tsx';

const CATEGORIES = [
  'PLUMBING', 'ELECTRICAL', 'LIFT', 'SECURITY', 'CLEANING', 'PARKING', 'WATER',
  'GARBAGE', 'MAINTENANCE', 'COMMON_AREA', 'PEST_CONTROL', 'GARDEN', 'NOISE', 'NETWORK', 'OTHER',
];
const STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ON_HOLD', 'RESOLVED', 'CLOSED', 'REJECTED', 'REOPENED'];
const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

/**
 * Complaints and service requests (§36).
 *
 * The full lifecycle lives here: raise → assign to a vendor or staff member (which creates a work
 * order) → move through statuses → resident verifies with a rating. Every transition is a server
 * call, so the audit trail and the notifications come for free.
 */
export function ComplaintsPage() {
  const { who, can } = useSession();
  const toast = useToast();
  const timezone = who?.society?.timezone;

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const limit = 20;

  const complaints = useList<Complaint>(
    '/complaints',
    { page, limit, search: search || undefined, status: status || undefined },
    [page, search, status],
  );

  const [detail, setDetail] = useState<Complaint | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <div className="stack">
      {complaints.error ? <ErrorAlert error={complaints.error} /> : null}

      <Card
        title="Complaints"
        subtitle={`${number(complaints.page.total)} raised in this society`}
        actions={
          can('complaint:create') ? (
            <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
              Raise a complaint
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
            <Button size="sm" variant="ghost" onClick={() => complaints.reload()}>
              Refresh
            </Button>
          </div>
        </div>

        {complaints.loading ? (
          <Loading />
        ) : (
          <DataTable
            rows={complaints.page.items}
            onRowClick={setDetail}
            empty={<EmptyState title="No complaints" hint="Nothing has been raised with this filter." />}
            columns={[
              {
                key: 'ref',
                header: 'Ref',
                render: (c) => <code className="small">{c.referenceNumber ?? c._id.slice(0, 10)}</code>,
              },
              {
                key: 'title',
                header: 'Complaint',
                render: (c) => (
                  <div>
                    <b>{c.title}</b>
                    <div className="faint small">
                      {label(c.category)} · {c.unitLabel ?? 'Common area'}
                    </div>
                  </div>
                ),
              },
              {
                key: 'priority',
                header: 'Priority',
                render: (c) => (
                  <Pill tone={c.priority === 'URGENT' ? 'danger' : c.priority === 'HIGH' ? 'warning' : 'neutral'}>
                    {label(c.priority ?? 'MEDIUM')}
                  </Pill>
                ),
              },
              {
                key: 'assignee',
                header: 'Assigned to',
                render: (c) =>
                  c.assigneeName ? (
                    <span>
                      {c.assigneeName} <span className="faint small">({c.assigneeType})</span>
                    </span>
                  ) : (
                    <span className="faint">Unassigned</span>
                  ),
              },
              { key: 'status', header: 'Status', render: (c) => <StatusPill status={c.status} /> },
              {
                key: 'age',
                header: 'Raised',
                align: 'right',
                render: (c) => <span className="small muted">{ago(c.createdAt)}</span>,
              },
            ]}
          />
        )}

        <div className="card__foot">
          <Pagination page={page} limit={limit} total={complaints.page.total} onPage={setPage} />
        </div>
      </Card>

      {detail ? (
        <ComplaintDetail
          complaint={detail}
          timezone={timezone}
          onClose={() => setDetail(null)}
          onChanged={(updated) => {
            setDetail(updated);
            complaints.reload();
          }}
        />
      ) : null}

      {creating ? (
        <CreateComplaintForm
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
            toast.success('Complaint raised');
            complaints.reload();
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

function ComplaintDetail({
  complaint,
  timezone,
  onClose,
  onChanged,
}: {
  complaint: Complaint;
  timezone?: string;
  onClose: () => void;
  onChanged: (updated: Complaint) => void;
}) {
  const { can } = useSession();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [note, setNote] = useState('');
  const [comment, setComment] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const comments = useList<ComplaintComment>('/complaints/' + complaint._id + '/comments', { limit: 50 }, [complaint._id]);

  async function refresh() {
    const updated = await api.get<Complaint>(`/complaints/${complaint._id}`);
    onChanged(updated);
    comments.reload();
  }

  async function changeStatus(status: string) {
    setBusy('status');
    setError(null);
    try {
      await api.patch(`/complaints/${complaint._id}/status`, { status, note: note.trim() || undefined });
      setNote('');
      toast.success(`Moved to ${label(status)}`);
      await refresh();
    } catch (err) {
      setError(err);
      toast.error(err);
    } finally {
      setBusy(null);
    }
  }

  async function addComment(e: FormEvent) {
    e.preventDefault();
    if (!comment.trim()) return;
    setBusy('comment');
    try {
      await api.post(`/complaints/${complaint._id}/comments`, { body: comment.trim() });
      setComment('');
      comments.reload();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  }

  async function reopen() {
    setBusy('reopen');
    try {
      await api.post(`/complaints/${complaint._id}/reopen`, { reason: note.trim() || undefined });
      toast.success('Complaint reopened');
      await refresh();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  }

  const nextStatuses = STATUSES.filter((s) => s !== complaint.status);

  return (
    <Modal title={`${complaint.referenceNumber ?? 'Complaint'} — ${complaint.title}`} onClose={onClose} wide>
      {error ? <ErrorAlert error={error} /> : null}

      <div className="grid grid--2">
        <div className="stack">
          <Card title="Details">
            <KeyValue
              items={[
                ['Status', <StatusPill key="st" status={complaint.status} />],
                ['Category', label(complaint.category)],
                ['Priority', label(complaint.priority ?? 'MEDIUM')],
                ['Unit', complaint.unitLabel ?? 'Common area'],
                ['Raised by', String(complaint.raisedBy ?? '—')],
                ['Assigned to', complaint.assigneeName ? `${complaint.assigneeName} (${complaint.assigneeType})` : 'Unassigned'],
                ['Work order', complaint.workOrderId ? <code key="wo">{String(complaint.workOrderId)}</code> : '—'],
                ['Raised', dateTime(complaint.createdAt, timezone)],
                ['Resolved', dateTime(complaint.resolvedAt, timezone)],
              ]}
            />
            {complaint.description ? (
              <p className="small muted mt" style={{ whiteSpace: 'pre-wrap' }}>
                {String(complaint.description)}
              </p>
            ) : null}
          </Card>

          {can('complaint:assign') && !complaint.assigneeName ? (
            <Card title="Assign this complaint">
              <AssignForm
                complaintId={complaint._id}
                open={assigning}
                onOpen={() => setAssigning(true)}
                onClose={() => setAssigning(false)}
                onDone={async (assigneeName) => {
                  setAssigning(false);
                  toast.success(`Assigned to ${assigneeName}`);
                  await refresh();
                }}
              />
            </Card>
          ) : null}
        </div>

        <div className="stack">
          {can('complaint:update') ? (
            <Card title="Move the complaint on">
              <Field label="Note for the resident" hint="Added to the conversation and the audit log.">
                <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="What was done?" />
              </Field>
              <div className="row row--wrap">
                {nextStatuses.map((s) => (
                  <Button key={s} size="sm" busy={busy === 'status'} onClick={() => void changeStatus(s)}>
                    → {label(s)}
                  </Button>
                ))}
              </div>
              {complaint.status === 'CLOSED' || complaint.status === 'RESOLVED' ? (
                <Button size="sm" variant="danger" className="mt" busy={busy === 'reopen'} onClick={() => void reopen()}>
                  Reopen
                </Button>
              ) : null}
              {complaint.status === 'RESOLVED' && can('complaint:approve') ? (
                <Button size="sm" variant="primary" className="mt" onClick={() => setVerifying(true)}>
                  Verify the fix
                </Button>
              ) : null}
            </Card>
          ) : null}

          <Card title="Conversation" subtitle={`${comments.page.total} updates`}>
            <form onSubmit={addComment}>
              <Field label="Add an update">
                <Textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Technician is on the way…"
                />
              </Field>
              <Button type="submit" size="sm" variant="primary" busy={busy === 'comment'} disabled={!comment.trim()}>
                Post update
              </Button>
            </form>

            <div className="mt">
              {comments.loading ? (
                <Loading />
              ) : comments.page.items.length === 0 ? (
                <EmptyState title="No updates yet" />
              ) : (
                comments.page.items.map((c) => (
                  <div key={c._id} className="row" style={{ alignItems: 'flex-start', padding: '9px 0', borderTop: '1px solid var(--border)' }}>
                    <Avatar name={c.authorName} />
                    <div style={{ flex: 1 }}>
                      <div className="row row--between">
                        <b className="small">{c.authorName ?? 'System'}</b>
                        <span className="faint small">{ago(c.createdAt)}</span>
                      </div>
                      <p className="small">{String(c.body ?? c.comment ?? '')}</p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </Card>
        </div>
      </div>

      {verifying ? (
        <VerifyForm
          complaintId={complaint._id}
          onClose={() => setVerifying(false)}
          onDone={async () => {
            setVerifying(false);
            toast.success('Fix verified — thank you');
            await refresh();
          }}
        />
      ) : null}
    </Modal>
  );
}

function AssignForm({
  complaintId,
  open,
  onOpen,
  onClose,
  onDone,
}: {
  complaintId: string;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onDone: (assigneeName: string) => void;
}) {
  const [assigneeType, setAssigneeType] = useState<'VENDOR' | 'STAFF'>('VENDOR');
  const [assigneeId, setAssigneeId] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const vendors = useList<Vendor>(assigneeType === 'VENDOR' ? '/vendors' : null, { limit: 100 }, [assigneeType]);
  const staff = useList<Staff>(assigneeType === 'STAFF' ? '/staff' : null, { limit: 100 }, [assigneeType]);

  const options: Array<{ id: string; name: string; detail: string }> =
    assigneeType === 'VENDOR'
      ? vendors.page.items.map((v) => ({
          id: v._id,
          name: v.businessName,
          detail: (v.serviceCategories ?? []).map(label).join(', '),
        }))
      : staff.page.items.map((s) => ({ id: s._id, name: s.fullName, detail: label(s.type) }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ assigneeName?: string }>(`/complaints/${complaintId}/assign`, {
        assigneeType,
        assigneeId,
        dueAt: dueAt || undefined,
      });
      onDone(result.assigneeName ?? options.find((o) => o.id === assigneeId)?.name ?? 'the assignee');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return <Button size="sm" variant="primary" onClick={onOpen}>Assign to a vendor or staff member</Button>;
  }

  return (
    <form onSubmit={submit}>
      {error ? <ErrorAlert error={error} /> : null}
      <div className="form-row">
        <Field label="Assignee type" required>
          <Select value={assigneeType} onChange={(e) => { setAssigneeType(e.target.value as 'VENDOR' | 'STAFF'); setAssigneeId(''); }}>
            <option value="VENDOR">Vendor</option>
            <option value="STAFF">Staff</option>
          </Select>
        </Field>
        <Field label="Due by">
          <Input type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
        </Field>
      </div>
      <Field label={assigneeType === 'VENDOR' ? 'Vendor' : 'Staff member'} required>
        <Select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} required>
          <option value="">Select…</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
              {o.detail ? ` — ${o.detail}` : ''}
            </option>
          ))}
        </Select>
      </Field>
      <div className="row">
        <Button type="submit" size="sm" variant="primary" busy={busy} disabled={!assigneeId}>
          Assign
        </Button>
        <Button type="button" size="sm" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function VerifyForm({
  complaintId,
  onClose,
  onDone,
}: {
  complaintId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [rating, setRating] = useState(5);
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/complaints/${complaintId}/verify`, { rating, feedback: feedback.trim() || undefined });
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Verify the fix"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Not yet</Button>
          <Button variant="primary" busy={busy} onClick={() => void submit()}>
            Confirm and close
          </Button>
        </>
      }
    >
      {error ? <ErrorAlert error={error} /> : null}
      <Field label="Rating" required hint="1 = poor, 5 = excellent. Feeds the vendor scorecard.">
        <div className="row" style={{ gap: 6 }}>
          {[1, 2, 3, 4, 5].map((value) => (
            <Button key={value} size="sm" variant={rating === value ? 'primary' : 'default'} onClick={() => setRating(value)}>
              {value} ★
            </Button>
          ))}
        </div>
      </Field>
      <Field label="Feedback">
        <Textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="Anything the society should know?" />
      </Field>
    </Modal>
  );
}

function CreateComplaintForm({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [category, setCategory] = useState('PLUMBING');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('MEDIUM');
  const [locationType, setLocationType] = useState('COMMON_AREA');
  const [locationText, setLocationText] = useState('');
  const [unitId, setUnitId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/complaints', {
        category,
        title: title.trim(),
        description: description.trim(),
        priority,
        locationType,
        locationText: locationText.trim() || undefined,
        // The API ignores a client-supplied unitId for resident callers and derives it from their
        // membership; an administrator raising on someone's behalf must say which flat.
        unitId: locationType === 'UNIT' ? unitId : undefined,
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
      title="Raise a complaint"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={submit} disabled={locationType === 'UNIT' && !unitId}>
            Raise complaint
          </Button>
        </>
      }
    >
      {error ? <ErrorAlert error={error} /> : null}
      <form onSubmit={submit}>
        <div className="form-row">
          <Field label="Category" required>
            <Select value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => (
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
        <Field label="Title" required>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Water leaking near the lift lobby" required autoFocus />
        </Field>
        <Field label="Description" required hint="What is wrong, and since when?">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} required />
        </Field>
        <div className="form-row">
          <Field label="Location type">
            <Select value={locationType} onChange={(e) => setLocationType(e.target.value)}>
              {['UNIT', 'COMMON_AREA', 'BUILDING', 'AMENITY', 'GATE'].map((l) => (
                <option key={l} value={l}>
                  {label(l)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Where exactly?">
            <Input value={locationText} onChange={(e) => setLocationText(e.target.value)} placeholder="Lift lobby, 9th floor" />
          </Field>
        </div>
        {locationType === 'UNIT' ? (
          <UnitPicker
            value={unitId}
            onChange={setUnitId}
            label="Which flat?"
            hint="An administrator raising a complaint must name the unit — a resident's own flat is filled in automatically."
          />
        ) : null}
      </form>
    </Modal>
  );
}
