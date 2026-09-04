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
  useToast,
  type Tone,
} from '../components/ui.tsx';
import { day, label, money } from '../lib/format.ts';
import { useSession } from '../lib/session.tsx';
import type { Gate, Staff } from '../lib/types.ts';
import { Avatar } from './ResidentsPage.tsx';

/** The employment types the staff schema accepts. */
const STAFF_TYPES = [
  'SECURITY', 'HOUSEKEEPING', 'MAINTENANCE', 'ELECTRICAL', 'PLUMBING', 'GARDENING',
  'CLEANING', 'TECHNICIAN', 'RECEPTIONIST', 'MANAGER', 'DRIVER', 'OTHER',
];
const SHIFTS = ['MORNING', 'AFTERNOON', 'NIGHT', 'GENERAL', 'ROTATING'];
const STATUSES = ['ACTIVE', 'ON_LEAVE', 'RESIGNED', 'TERMINATED', 'SUSPENDED', 'INACTIVE'];

/** Roles the login endpoint can mint — mirrored from the backend so the picker never over-promises. */
const STAFF_ROLES = [
  'SECURITY_GUARD', 'SECURITY_SUPERVISOR', 'FACILITY_MANAGER', 'RECEPTIONIST', 'ACCOUNTANT',
  'MAINTENANCE_STAFF', 'ELECTRICIAN', 'PLUMBER', 'HOUSEKEEPING', 'GARDENER', 'DRIVER', 'DOMESTIC_STAFF',
];

interface IssuedLogin {
  userId: string;
  role: string;
  identifier: string;
  temporaryPassword: string | null;
  mustChangePassword: boolean;
}

/**
 * Society staff (§26).
 *
 * Two separate things live on a staff record: the employment details, and whether that person can
 * authenticate. Issuing a login is its own deliberate action because it creates a real user account
 * and registers it in the cross-society identity directory — the generated password is shown once
 * and never again, so this screen makes you copy it before it disappears.
 */
export function StaffPage() {
  const { can, hasModule } = useSession();
  const toast = useToast();

  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const limit = 20;

  const staff = useList<Staff>(
    '/staff',
    { page, limit, search: search || undefined, type: type || undefined, status: status || undefined },
    [page, search, type, status],
  );
  const gates = useList<Gate>(hasModule('multiGate') ? '/gates' : null, { limit: 50 }, [hasModule('multiGate')]);

  const [detail, setDetail] = useState<Staff | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <div className="stack">
      {staff.error ? <ErrorAlert error={staff.error} /> : null}

      <Card
        title="Staff"
        subtitle={`${number(staff.page.total)} people employed by the society`}
        actions={
          can('staff:create') ? (
            <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
              Add staff member
            </Button>
          ) : null
        }
        flush
      >
        <div className="card__body" style={{ paddingBottom: 0 }}>
          <div className="toolbar">
            <Input
              placeholder="Search by name or phone"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              style={{ minWidth: 220 }}
            />
            <Select
              value={type}
              onChange={(e) => {
                setType(e.target.value);
                setPage(1);
              }}
            >
              <option value="">All roles</option>
              {STAFF_TYPES.map((t) => (
                <option key={t} value={t}>
                  {label(t)}
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
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {label(s)}
                </option>
              ))}
            </Select>
            <div className="toolbar__spacer" />
            <Button size="sm" variant="ghost" onClick={() => staff.reload()}>
              Refresh
            </Button>
          </div>
        </div>

        {staff.loading ? (
          <Loading />
        ) : (
          <DataTable
            rows={staff.page.items}
            onRowClick={setDetail}
            empty={<EmptyState title="No staff yet" hint="Add your guards, housekeeping and maintenance team." />}
            columns={[
              {
                key: 'who',
                header: 'Staff member',
                render: (s) => (
                  <div className="row">
                    <Avatar name={s.fullName} />
                    <div>
                      <b>{s.fullName}</b>
                      <div className="faint small">{s.phone}</div>
                    </div>
                  </div>
                ),
              },
              { key: 'type', header: 'Role', render: (s) => <Pill>{label(s.type)}</Pill> },
              { key: 'shift', header: 'Shift', render: (s) => label(s.shift ?? 'GENERAL') },
              {
                key: 'gate',
                header: 'Gate',
                render: (s) => {
                  if (!s.gateId) return <span className="faint">—</span>;
                  return gates.page.items.find((g) => g._id === s.gateId)?.name ?? <code className="small">{String(s.gateId).slice(0, 10)}</code>;
                },
              },
              { key: 'joined', header: 'Joined', align: 'right', render: (s) => day(s.joiningDate) },
              {
                key: 'salary',
                header: 'Monthly',
                align: 'right',
                render: (s) => (s.monthlySalary ? money(s.monthlySalary) : <span className="faint">—</span>),
              },
              {
                key: 'login',
                header: 'App login',
                render: (s) =>
                  s.allowLogin ? <Pill tone="success">Enabled</Pill> : <Pill tone="neutral">None</Pill>,
              },
              { key: 'status', header: 'Status', render: (s) => <Pill tone={statusTone(s.status)}>{label(s.status)}</Pill> },
            ]}
          />
        )}

        <div className="card__foot">
          <Pagination page={page} limit={limit} total={staff.page.total} onPage={setPage} />
        </div>
      </Card>

      {detail ? (
        <StaffDetail member={detail} gates={gates.page.items} onClose={() => setDetail(null)} onChanged={() => staff.reload()} />
      ) : null}
      {creating ? (
        <CreateStaffForm
          gates={gates.page.items}
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
            toast.success('Staff member added');
            staff.reload();
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

function statusTone(status?: string | null): Tone {
  const s = String(status ?? '').toUpperCase();
  if (s === 'ACTIVE') return 'success';
  if (['RESIGNED', 'TERMINATED', 'SUSPENDED', 'INACTIVE'].includes(s)) return 'danger';
  if (s === 'ON_LEAVE') return 'warning';
  return 'neutral';
}

function StaffDetail({
  member,
  gates,
  onClose,
  onChanged,
}: {
  member: Staff;
  gates: Gate[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const { can } = useSession();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState(false);
  const [issued, setIssued] = useState<IssuedLogin | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);

  const [form, setForm] = useState({
    monthlySalary: String(member.monthlySalary ?? ''),
    shift: String(member.shift ?? 'GENERAL'),
    gateId: String(member.gateId ?? ''),
    type: String(member.type ?? 'OTHER'),
    status: String(member.status ?? 'ACTIVE'),
  });

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

  const patch = () =>
    run(
      'save',
      () =>
        api.patch(`/staff/${member._id}`, {
          monthlySalary: form.monthlySalary.trim() ? Number(form.monthlySalary) : undefined,
          shift: form.shift,
          gateId: form.gateId || null,
          type: form.type,
          status: form.status,
        }),
      'Staff record updated',
    );

  return (
    <Modal title={member.fullName} onClose={onClose} wide>
      {error ? <ErrorAlert error={error} /> : null}

      {issued ? (
        <Alert tone="success">
          <b>Login issued for {issued.identifier}</b>
          <div className="small" style={{ marginTop: 4 }}>
            Role {label(issued.role)}
            {issued.mustChangePassword ? ' — they will be asked to change the password at first sign-in.' : '.'}
          </div>
          {issued.temporaryPassword ? (
            <>
              <div className="small" style={{ marginTop: 8 }}>
                Temporary password — shown once, copy it now:
              </div>
              <div className="row" style={{ marginTop: 4, gap: 8 }}>
                <code className="mono" style={{ fontSize: 18, letterSpacing: 1 }}>
                  {issued.temporaryPassword}
                </code>
                <Button
                  size="sm"
                  onClick={() => {
                    void navigator.clipboard?.writeText(issued.temporaryPassword!);
                    toast.success('Copied to clipboard');
                  }}
                >
                  Copy
                </Button>
              </div>
            </>
          ) : (
            <div className="small" style={{ marginTop: 4 }}>
              The password you chose is now active.
            </div>
          )}
        </Alert>
      ) : null}

      <div className="grid grid--2">
        <Card
          title="Employment"
          actions={
            can('staff:update') ? (
              <Button size="sm" variant="ghost" onClick={() => setEditing((v) => !v)}>
                {editing ? 'Done' : 'Edit'}
              </Button>
            ) : null
          }
        >
          {editing ? (
            <div className="stack">
              <div className="form-row">
                <Field label="Role">
                  <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                    {STAFF_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {label(t)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Shift">
                  <Select value={form.shift} onChange={(e) => setForm({ ...form, shift: e.target.value })}>
                    {SHIFTS.map((s) => (
                      <option key={s} value={s}>
                        {label(s)}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <div className="form-row">
                <Field label="Monthly salary (₹)">
                  <Input value={form.monthlySalary} onChange={(e) => setForm({ ...form, monthlySalary: e.target.value })} inputMode="numeric" />
                </Field>
                <Field label="Status">
                  <Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {label(s)}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Field label="Assigned gate" hint="Where this person is expected on shift.">
                <Select value={form.gateId} onChange={(e) => setForm({ ...form, gateId: e.target.value })}>
                  <option value="">No fixed gate</option>
                  {gates.map((g) => (
                    <option key={g._id} value={g._id}>
                      {g.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button size="sm" variant="primary" busy={busy === 'save'} onClick={() => void patch()}>
                Save changes
              </Button>
            </div>
          ) : (
            <KeyValue
              items={[
                ['Status', <Pill key="s" tone={statusTone(member.status)}>{label(member.status)}</Pill>],
                ['Role', label(member.type)],
                ['Employment', label(member.employmentType ?? 'FULL_TIME')],
                ['Work type', label(member.workType ?? '—')],
                ['Shift', label(member.shift ?? 'GENERAL')],
                ['Hours', member.startTime && member.endTime ? `${member.startTime}–${member.endTime}` : '—'],
                ['Joined', day(member.joiningDate)],
                ['Left', member.exitDate ? day(member.exitDate) : 'Still employed'],
                ['Monthly salary', member.monthlySalary ? money(member.monthlySalary) : '—'],
                ['Police verification', label(member.policeVerificationStatus ?? 'PENDING')],
                ['ID proof', member.idProofType ? label(member.idProofType) : 'Not recorded'],
              ]}
            />
          )}
        </Card>

        <div className="stack">
          <Card title="Contact">
            <KeyValue
              items={[
                ['Phone', member.phone ?? '—'],
                ['Email', member.email ?? '—'],
                ['Address', member.address ?? '—'],
                ['Rating', member.rating ? `${Number(member.rating).toFixed(1)} ★` : 'Not rated'],
                ['Last seen at gate', member.lastEntryAt ? day(member.lastEntryAt) : 'Never'],
              ]}
            />
          </Card>

          {can('staff:update') ? (
            <Card title="App login" subtitle="Guards and managers need one to use the mobile apps">
              {member.allowLogin ? (
                <>
                  <Alert tone="info">
                    This person can sign in with their phone number. Revoking stops authentication
                    immediately but keeps their attendance and work-order history.
                  </Alert>
                  <div className="row row--wrap mt">
                    <Button size="sm" onClick={() => setLoginOpen(true)}>
                      Reset password
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      busy={busy === 'revoke'}
                      onClick={() =>
                        void run('revoke', () => api.del(`/staff/${member._id}/login`), 'Login revoked')
                      }
                    >
                      Revoke login
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <p className="small muted">
                    No login yet — this staff record cannot authenticate. Issue one to let them use the
                    security or staff app.
                  </p>
                  <Button size="sm" variant="primary" className="mt" onClick={() => setLoginOpen(true)}>
                    Issue a login
                  </Button>
                </>
              )}
            </Card>
          ) : null}
        </div>
      </div>

      {loginOpen ? (
        <IssueLoginForm
          member={member}
          onClose={() => setLoginOpen(false)}
          onDone={(result) => {
            setLoginOpen(false);
            setIssued(result);
            onChanged();
          }}
        />
      ) : null}
    </Modal>
  );
}

function IssueLoginForm({
  member,
  onClose,
  onDone,
}: {
  member: Staff;
  onClose: () => void;
  onDone: (result: IssuedLogin) => void;
}) {
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<IssuedLogin>(`/staff/${member._id}/login`, {
        password: password.trim() || undefined,
        role: role || undefined,
        mustChangePassword: password.trim() ? true : undefined,
      });
      onDone(result);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Issue a login for ${member.fullName}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={submit}>
            Issue login
          </Button>
        </>
      }
    >
      {error ? <ErrorAlert error={error} /> : null}
      <form onSubmit={submit}>
        <Alert tone="warning">
          They will sign in with <b>{member.phone}</b>. Leave the password blank to generate a
          temporary one — it is shown exactly once and must be changed at first sign-in.
        </Alert>
        <Field label="Role" hint="Defaults from their staff role; override only if it is wrong.">
          <Select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="">Derive from staff role ({label(member.type)})</option>
            {STAFF_ROLES.map((r) => (
              <option key={r} value={r}>
                {label(r)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Password" hint="At least 8 characters with a letter and a number.">
          <Input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Generate one for me" />
        </Field>
      </form>
    </Modal>
  );
}

function CreateStaffForm({
  gates,
  onClose,
  onDone,
}: {
  gates: Gate[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [type, setType] = useState('SECURITY');
  const [shift, setShift] = useState('MORNING');
  const [gateId, setGateId] = useState('');
  const [joiningDate, setJoiningDate] = useState('');
  const [monthlySalary, setSalary] = useState('');
  const [employmentType, setEmploymentType] = useState('FULL_TIME');
  const [idProofType, setIdProofType] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/staff', {
        fullName: fullName.trim(),
        phone: phone.trim(),
        email: email.trim() || undefined,
        type,
        shift,
        gateId: gateId || undefined,
        joiningDate: joiningDate || undefined,
        monthlySalary: monthlySalary.trim() ? Number(monthlySalary) : undefined,
        employmentType,
        idProofType: idProofType || undefined,
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
      title="Add a staff member"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={submit}>
            Add staff member
          </Button>
        </>
      }
    >
      {error ? <ErrorAlert error={error} /> : null}
      <form onSubmit={submit}>
        <div className="form-row">
          <Field label="Full name" required>
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Suresh Yadav" required autoFocus />
          </Field>
          <Field label="Phone" required hint="Unique across the society — this becomes their login.">
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+919876543210" required />
          </Field>
        </div>
        <div className="form-row">
          <Field label="Role" required>
            <Select value={type} onChange={(e) => setType(e.target.value)}>
              {STAFF_TYPES.map((t) => (
                <option key={t} value={t}>
                  {label(t)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Employment">
            <Select value={employmentType} onChange={(e) => setEmploymentType(e.target.value)}>
              {['FULL_TIME', 'PART_TIME', 'CONTRACT', 'HOURLY', 'AGENCY'].map((t) => (
                <option key={t} value={t}>
                  {label(t)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="form-row">
          <Field label="Shift">
            <Select value={shift} onChange={(e) => setShift(e.target.value)}>
              {SHIFTS.map((s) => (
                <option key={s} value={s}>
                  {label(s)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Assigned gate">
            <Select value={gateId} onChange={(e) => setGateId(e.target.value)}>
              <option value="">No fixed gate</option>
              {gates.map((g) => (
                <option key={g._id} value={g._id}>
                  {g.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="form-row">
          <Field label="Joining date">
            <Input type="date" value={joiningDate} onChange={(e) => setJoiningDate(e.target.value)} />
          </Field>
          <Field label="Monthly salary (₹)">
            <Input value={monthlySalary} onChange={(e) => setSalary(e.target.value)} inputMode="numeric" placeholder="22000" />
          </Field>
        </div>
        <div className="form-row">
          <Field label="Email">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="ID proof type">
            <Select value={idProofType} onChange={(e) => setIdProofType(e.target.value)}>
              <option value="">Not recorded</option>
              {['AADHAAR', 'PAN', 'VOTER_ID', 'PASSPORT', 'DRIVING_LICENCE'].map((t) => (
                <option key={t} value={t}>
                  {label(t)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Alert tone="info">
          This only records the employment. Open the person's record afterwards and choose
          <b> Issue a login</b> if they need app access.
        </Alert>
      </form>
    </Modal>
  );
}
