import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
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
  Loading,
  Modal,
  Pagination,
  Pill,
  Select,
  Textarea,
  useToast,
} from '../components/ui.tsx';
import { day, label, number } from '../lib/format.ts';
import { useSession } from '../lib/session.tsx';
import { ADMIN_ROLES, PLAN_CODES, SOCIETY_STATUSES, type Society } from '../lib/types.ts';

const SORTS = [
  { value: 'createdAt', label: 'Newest first' },
  { value: 'name', label: 'Name' },
  { value: 'totalUnits', label: 'Units' },
  { value: 'totalResidents', label: 'Residents' },
];

const TIMEZONES = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'America/New_York', 'UTC'];

/**
 * Societies (§41, §46).
 *
 * The tenant list. Creating one here provisions a dedicated database with default roles, ledgers
 * and settings — it does not merely insert a row, which is why the form collects the first
 * administrator at the same time: a provisioned society nobody can sign in to is not usable.
 */
export function SocietiesPage() {
  const { canAny } = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();

  const [search, setSearch] = useState(params.get('search') ?? '');
  const [status, setStatus] = useState(params.get('status') ?? '');
  const [tier, setTier] = useState(params.get('tier') ?? '');
  const [city, setCity] = useState(params.get('city') ?? '');
  const [sortBy, setSortBy] = useState(params.get('sortBy') ?? 'createdAt');
  const [sortDir, setSortDir] = useState(params.get('sortDir') ?? 'desc');
  const [page, setPage] = useState(1);
  const limit = 25;

  const societies = useList<Society>(
    '/platform/societies',
    {
      page,
      limit,
      search: search || undefined,
      status: status || undefined,
      tier: tier || undefined,
      city: city || undefined,
      sortBy,
      sortDir,
    },
    [page, search, status, tier, city, sortBy, sortDir],
  );

  const [creating, setCreating] = useState(false);

  function applyFilter(next: Record<string, string>) {
    setPage(1);
    const merged = { search, status, tier, city, sortBy, sortDir, ...next };
    setParams(
      Object.fromEntries(Object.entries(merged).filter(([, value]) => value && value !== 'createdAt' && value !== 'desc')),
      { replace: true },
    );
  }

  const filtered = Boolean(search || status || tier || city);
  const canCreate = canAny('society:create', 'society:manage');

  return (
    <div className="stack">
      {societies.error ? <ErrorAlert error={societies.error} /> : null}

      <Card
        title="Societies"
        subtitle={`${number(societies.page.total)} tenant${societies.page.total === 1 ? '' : 's'} on the platform`}
        actions={
          canCreate ? (
            <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
              Onboard a society
            </Button>
          ) : undefined
        }
        flush
      >
        <div className="card__body" style={{ paddingBottom: 0 }}>
          <div className="toolbar">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applyFilter({ search });
              }}
              placeholder="Search name, slug or city…"
              style={{ maxWidth: 260 }}
            />
            <Select value={status} onChange={(e) => { setStatus(e.target.value); applyFilter({ status: e.target.value }); }}>
              <option value="">Any status</option>
              {SOCIETY_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {label(s)}
                </option>
              ))}
            </Select>
            <Select value={tier} onChange={(e) => { setTier(e.target.value); applyFilter({ tier: e.target.value }); }}>
              <option value="">Any plan</option>
              {PLAN_CODES.map((t) => (
                <option key={t} value={t}>
                  {label(t)}
                </option>
              ))}
            </Select>
            <Input
              value={city}
              onChange={(e) => setCity(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') applyFilter({ city });
              }}
              placeholder="City"
              style={{ maxWidth: 140 }}
            />
            <Select value={sortBy} onChange={(e) => { setSortBy(e.target.value); applyFilter({ sortBy: e.target.value }); }}>
              {SORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
            <Button size="sm" variant="ghost" onClick={() => { setSortDir(sortDir === 'asc' ? 'desc' : 'asc'); applyFilter({ sortDir: sortDir === 'asc' ? 'desc' : 'asc' }); }}>
              {sortDir === 'asc' ? '↑ Ascending' : '↓ Descending'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setSearch(''); setStatus(''); setTier(''); setCity(''); applyFilter({ search: '', status: '', tier: '', city: '' }); }}>
              Search
            </Button>
            <div className="toolbar__spacer" />
            {filtered ? <Pill tone="info">Filtered</Pill> : null}
          </div>
        </div>

        {societies.loading ? (
          <Loading />
        ) : (
          <DataTable
            rows={societies.page.items}
            rowKey={(s) => s._id}
            onRowClick={(s) => navigate(`/societies/${s._id}`)}
            empty={
              <EmptyState
                title={filtered ? 'No societies match' : 'No societies yet'}
                hint={filtered ? 'Widen the filters to see more tenants.' : 'Onboard the first society to provision its database.'}
              />
            }
            columns={[
              {
                key: 'name',
                header: 'Society',
                render: (s) => (
                  <div>
                    <b>{s.name}</b>
                    <div className="faint small">
                      {s.slug} · {s.city ?? '—'}
                      {s.state ? `, ${s.state}` : ''}
                    </div>
                  </div>
                ),
              },
              {
                key: 'status',
                header: 'Status',
                render: (s) => (
                  <Pill tone={s.status === 'ACTIVE' ? 'success' : s.status === 'SUSPENDED' ? 'danger' : s.status === 'ARCHIVED' ? undefined : 'warning'}>
                    {label(s.status)}
                  </Pill>
                ),
              },
              { key: 'tier', header: 'Plan', render: (s) => <Pill tone={s.tier === 'ENTERPRISE' ? 'brand' : undefined}>{label(s.tier ?? 'FREE')}</Pill> },
              { key: 'units', header: 'Units', align: 'right', render: (s) => number(s.totalUnits ?? 0) },
              { key: 'residents', header: 'Residents', align: 'right', render: (s) => number(s.totalResidents ?? 0) },
              {
                key: 'db',
                header: 'Database',
                render: (s) =>
                  s.databaseProvisioned ? (
                    <Pill tone="success">Provisioned</Pill>
                  ) : (
                    <Pill tone="danger">Not provisioned</Pill>
                  ),
              },
              {
                key: 'onboarding',
                header: 'Onboarding',
                render: (s) => (s.onboardingStep === 'COMPLETED' ? <span className="faint small">Complete</span> : <span className="small">{label(s.onboardingStep ?? 'NOT_STARTED')}</span>),
              },
              { key: 'created', header: 'Created', render: (s) => <span className="small">{day(s.createdAt)}</span> },
            ]}
          />
        )}

        <div className="card__foot">
          <Pagination page={page} limit={limit} total={societies.page.total} onPage={setPage} />
        </div>
      </Card>

      {creating ? (
        <CreateSocietyForm
          onClose={() => setCreating(false)}
          onCreated={(society, admin) => {
            setCreating(false);
            toast.success(
              admin?.mustChangePassword
                ? `${society.name} created. ${admin.fullName ?? 'The administrator'} has no password yet — they must set one before signing in.`
                : `${society.name} created — its database is being provisioned`,
            );
            navigate(`/societies/${society._id}`);
          }}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------ create society ------------------------------ */

interface CreateForm {
  name: string;
  slug: string;
  legalName: string;
  registrationNumber: string;
  city: string;
  state: string;
  country: string;
  pincode: string;
  address: string;
  timezone: string;
  currency: string;
  contactEmail: string;
  contactPhone: string;
  websiteUrl: string;
  tier: string;
  notes: string;
  adminFullName: string;
  adminEmail: string;
  adminPhone: string;
  adminPassword: string;
  adminRoles: string[];
}

const EMPTY_FORM: CreateForm = {
  name: '',
  slug: '',
  legalName: '',
  registrationNumber: '',
  city: '',
  state: '',
  country: 'IN',
  pincode: '',
  address: '',
  timezone: 'Asia/Kolkata',
  currency: 'INR',
  contactEmail: '',
  contactPhone: '',
  websiteUrl: '',
  tier: 'FREE',
  notes: '',
  adminFullName: '',
  adminEmail: '',
  adminPhone: '',
  adminPassword: '',
  adminRoles: ['SOCIETY_ADMIN'],
};

function CreateSocietyForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (society: Society, admin?: { fullName?: string; mustChangePassword?: boolean }) => void;
}) {
  const [form, setForm] = useState<CreateForm>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const toast = useToast();

  const set = <K extends keyof CreateForm>(key: K, value: CreateForm[K]) => setForm((prev) => ({ ...prev, [key]: value }));

  /** Slug must be lowercase alphanumerics and dashes; derive it from the name until edited. */
  function onNameChange(value: string) {
    setForm((prev) => ({
      ...prev,
      name: value,
      slug: prev.slug || value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48),
    }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        city: form.city.trim(),
        country: form.country.trim() || 'IN',
        timezone: form.timezone,
        currency: form.currency.trim() || 'INR',
        tier: form.tier,
      };
      // Only send the optional strings the operator actually filled in. The schema is strict about
      // formats — an empty `websiteUrl` is a 422, not a blank field.
      const optional: [keyof CreateForm, string][] = [
        ['slug', 'slug'],
        ['legalName', 'legalName'],
        ['registrationNumber', 'registrationNumber'],
        ['state', 'state'],
        ['pincode', 'pincode'],
        ['address', 'address'],
        ['contactEmail', 'contactEmail'],
        ['contactPhone', 'contactPhone'],
        ['websiteUrl', 'websiteUrl'],
      ];
      for (const [key, target] of optional) {
        const value = String(form[key] ?? '').trim();
        if (value) body[target] = value;
      }
      if (form.adminFullName.trim()) {
        const admin: Record<string, unknown> = { fullName: form.adminFullName.trim(), roles: form.adminRoles };
        if (form.adminEmail.trim()) admin.email = form.adminEmail.trim();
        if (form.adminPhone.trim()) admin.phone = form.adminPhone.trim();
        if (form.adminPassword) admin.password = form.adminPassword;
        body.admin = admin;
      }

      // The response carries the society *and* the administrator it created, so the operator can be
      // told straight away whether that person will need a password reset before they can sign in.
      const created = await api.post<{ society: Society; admin?: { fullName?: string; mustChangePassword?: boolean } }>(
        '/platform/societies',
        body,
      );
      onCreated(created.society, created.admin);
    } catch (err) {
      setError(err);
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  const slugValid = form.slug === '' || /^[a-z0-9-]{3,48}$/.test(form.slug);

  return (
    <Modal
      title="Onboard a society"
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            busy={busy}
            onClick={submit}
            disabled={
              !form.name.trim() ||
              form.name.trim().length < 3 ||
              !form.city.trim() ||
              !slugValid ||
              // An administrator with a name but no password is an account nobody can use.
              (Boolean(form.adminFullName.trim()) && !form.adminPassword)
            }
          >
            Create and provision
          </Button>
        </>
      }
    >
      {error ? <ErrorAlert error={error} /> : null}
      <form onSubmit={submit} className="stack">
        <Alert tone="info">
          Creating a society provisions a <b>dedicated database</b> for it and seeds default roles,
          ledgers and settings. That is what makes its data unreachable from every other tenant.
        </Alert>

        <div className="grid grid--2">
          <Field label="Name" required hint="3–120 characters">
            <Input value={form.name} onChange={(e) => onNameChange(e.target.value)} required autoFocus />
          </Field>
          <Field label="Slug" hint="Lowercase letters, numbers and dashes" error={slugValid ? undefined : 'Must match ^[a-z0-9-]{3,48}$'}>
            <Input value={form.slug} onChange={(e) => set('slug', e.target.value.toLowerCase())} placeholder="Derived from the name if left blank" />
          </Field>
          <Field label="Legal name">
            <Input value={form.legalName} onChange={(e) => set('legalName', e.target.value)} placeholder="… Co-operative Housing Society Ltd." />
          </Field>
          <Field label="Registration number">
            <Input value={form.registrationNumber} onChange={(e) => set('registrationNumber', e.target.value)} />
          </Field>
          <Field label="City" required>
            <Input value={form.city} onChange={(e) => set('city', e.target.value)} required />
          </Field>
          <Field label="State">
            <Input value={form.state} onChange={(e) => set('state', e.target.value)} />
          </Field>
          <Field label="Pincode">
            <Input value={form.pincode} onChange={(e) => set('pincode', e.target.value)} inputMode="numeric" />
          </Field>
          <Field label="Country" hint="ISO 3166-1 alpha-2">
            <Input value={form.country} onChange={(e) => set('country', e.target.value.toUpperCase())} maxLength={2} />
          </Field>
        </div>

        <Field label="Address">
          <Textarea rows={2} value={form.address} onChange={(e) => set('address', e.target.value)} />
        </Field>

        <div className="grid grid--3">
          <Field label="Timezone">
            <Select value={form.timezone} onChange={(e) => set('timezone', e.target.value)}>
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Currency" hint="3-letter code">
            <Input value={form.currency} onChange={(e) => set('currency', e.target.value.toUpperCase())} maxLength={3} />
          </Field>
          <Field label="Opening plan">
            <Select value={form.tier} onChange={(e) => set('tier', e.target.value)}>
              {PLAN_CODES.map((t) => (
                <option key={t} value={t}>
                  {label(t)}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="grid grid--3">
          <Field label="Contact email">
            <Input type="email" value={form.contactEmail} onChange={(e) => set('contactEmail', e.target.value)} />
          </Field>
          <Field label="Contact phone">
            <Input value={form.contactPhone} onChange={(e) => set('contactPhone', e.target.value)} placeholder="+91…" />
          </Field>
          <Field label="Website" hint="Full URL">
            <Input value={form.websiteUrl} onChange={(e) => set('websiteUrl', e.target.value)} placeholder="https://" />
          </Field>
        </div>

        <Card title="First administrator" subtitle="Optional, but a society nobody can sign in to is not usable">
          <Alert tone="warning">
            Leave the password blank and the account is created with <b>no password at all</b> — the
            server generates nothing and returns nothing, so that administrator cannot sign in until
            you set one. Set it here.
          </Alert>
          <div className="grid grid--2">
            <Field label="Full name" hint="Required if adding an administrator">
              <Input value={form.adminFullName} onChange={(e) => set('adminFullName', e.target.value)} />
            </Field>
            <Field label="Email">
              <Input type="email" value={form.adminEmail} onChange={(e) => set('adminEmail', e.target.value)} />
            </Field>
            <Field label="Phone">
              <Input value={form.adminPhone} onChange={(e) => set('adminPhone', e.target.value)} placeholder="+91…" />
            </Field>
            <Field
              label="Temporary password"
              hint="At least 8 characters with a letter and a number"
              error={form.adminFullName.trim() && !form.adminPassword ? 'Required: no password is generated, and none is returned after creation' : undefined}
            >
              <Input type="text" value={form.adminPassword} onChange={(e) => set('adminPassword', e.target.value)} placeholder="Set one now — it is not recoverable later" />
            </Field>
          </div>
          <Field label="Roles">
            <div className="row row--wrap" style={{ gap: 10 }}>
              {ADMIN_ROLES.map((role) => (
                <label key={role} className="row" style={{ gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={form.adminRoles.includes(role)}
                    onChange={(e) =>
                      set('adminRoles', e.target.checked ? [...form.adminRoles, role] : form.adminRoles.filter((r) => r !== role))
                    }
                  />
                  <span className="small">{label(role)}</span>
                </label>
              ))}
            </div>
          </Field>
        </Card>
      </form>
    </Modal>
  );
}
