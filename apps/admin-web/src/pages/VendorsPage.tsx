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
import { ago, day, label } from '../lib/format.ts';
import { useSession } from '../lib/session.tsx';
import type { Address, Vendor } from '../lib/types.ts';

const CATEGORIES = [
  'PLUMBING', 'ELECTRICAL', 'CARPENTRY', 'PAINTING', 'CLEANING', 'SECURITY', 'HOUSEKEEPING',
  'PEST_CONTROL', 'GARDENING', 'LIFT_MAINTENANCE', 'APPLIANCE_REPAIR', 'WATER_SUPPLY',
  'WASTE_MANAGEMENT', 'CATERING', 'EVENTS', 'FACILITY_MANAGEMENT', 'OTHER',
];

const isBlocked = (vendor: Vendor): boolean =>
  ['BLOCKED', 'SUSPENDED', 'REJECTED'].includes(String(vendor.status ?? '').toUpperCase());

/**
 * Vendors and their service catalogue (§39).
 *
 * Vendors are the people who actually fix things, so approval status, rating and job history all
 * live here. Blocking a vendor takes them out of the assignment pickers immediately.
 */
export function VendorsPage() {
  const { can } = useSession();
  const toast = useToast();

  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const limit = 20;

  const vendors = useList<Vendor>(
    '/vendors',
    { page, limit, search: search || undefined, status: status || undefined },
    [page, search, status],
  );

  const [detail, setDetail] = useState<Vendor | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <div className="stack">
      {vendors.error ? <ErrorAlert error={vendors.error} /> : null}

      <Card
        title="Vendors"
        subtitle={`${number(vendors.page.total)} service providers registered`}
        actions={
          can('vendor:create') ? (
            <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
              Add vendor
            </Button>
          ) : null
        }
        flush
      >
        <div className="card__body" style={{ paddingBottom: 0 }}>
          <div className="toolbar">
            <Input
              placeholder="Search business or contact"
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
              {['ACTIVE', 'PENDING', 'APPROVED', 'BLOCKED', 'SUSPENDED', 'INACTIVE'].map((s) => (
                <option key={s} value={s}>
                  {label(s)}
                </option>
              ))}
            </Select>
            <div className="toolbar__spacer" />
            <Button size="sm" variant="ghost" onClick={() => vendors.reload()}>
              Refresh
            </Button>
          </div>
        </div>

        {vendors.loading ? (
          <Loading />
        ) : (
          <DataTable
            rows={vendors.page.items}
            onRowClick={setDetail}
            empty={<EmptyState title="No vendors" hint="Add the plumbers, electricians and agencies you work with." />}
            columns={[
              {
                key: 'who',
                header: 'Vendor',
                render: (v) => (
                  <div>
                    <b>{v.businessName}</b>
                    <div className="faint small">{v.contactPersonName ?? v.phone ?? '—'}</div>
                  </div>
                ),
              },
              {
                key: 'services',
                header: 'Services',
                render: (v) => {
                  const cats = v.serviceCategories ?? [];
                  return (
                    <div className="row row--wrap" style={{ gap: 4 }}>
                      {cats.slice(0, 3).map((c) => (
                        <Pill key={c}>{label(c)}</Pill>
                      ))}
                      {cats.length > 3 ? <span className="faint small">+{cats.length - 3}</span> : null}
                      {cats.length === 0 ? <span className="faint">—</span> : null}
                    </div>
                  );
                },
              },
              {
                key: 'rating',
                header: 'Rating',
                align: 'right',
                render: (v) => (v.rating ? `${Number(v.rating).toFixed(1)} ★` : <span className="faint">Not rated</span>),
              },
              {
                key: 'jobs',
                header: 'Jobs',
                align: 'right',
                render: (v) => `${number(v.completedWorkOrders)}/${number(v.totalWorkOrders)}`,
              },
              {
                key: 'gst',
                header: 'GSTIN',
                render: (v) => (v.gstin ? <code className="small">{v.gstin}</code> : <span className="faint">—</span>),
              },
              { key: 'status', header: 'Status', render: (v) => <Pill tone={toneFor(v.status)}>{label(v.status)}</Pill> },
            ]}
          />
        )}

        <div className="card__foot">
          <Pagination page={page} limit={limit} total={vendors.page.total} onPage={setPage} />
        </div>
      </Card>

      {detail ? <VendorDetail vendor={detail} onClose={() => setDetail(null)} onChanged={() => vendors.reload()} /> : null}
      {creating ? (
        <CreateVendorForm
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
            toast.success('Vendor added');
            vendors.reload();
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

function toneFor(status?: string | null): Tone {
  const s = String(status ?? '').toUpperCase();
  if (['ACTIVE', 'APPROVED'].includes(s)) return 'success';
  if (['BLOCKED', 'SUSPENDED', 'REJECTED', 'INACTIVE'].includes(s)) return 'danger';
  if (s === 'PENDING') return 'warning';
  return 'neutral';
}

function renderAddress(address?: Address | null): string {
  if (!address) return '—';
  return [address.line1, address.line2, address.city, address.state, address.pincode].filter(Boolean).join(', ') || '—';
}

function VendorDetail({ vendor, onClose, onChanged }: { vendor: Vendor; onClose: () => void; onChanged: () => void }) {
  const { can } = useSession();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function toggleBlock() {
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/vendors/${vendor._id}`, { status: isBlocked(vendor) ? 'ACTIVE' : 'BLOCKED' });
      toast.success(isBlocked(vendor) ? 'Vendor reinstated' : 'Vendor blocked');
      onChanged();
      onClose();
    } catch (err) {
      setError(err);
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={vendor.businessName} onClose={onClose} wide>
      {error ? <ErrorAlert error={error} /> : null}
      <div className="grid grid--2">
        <Card title="Business">
          <KeyValue
            items={[
              ['Status', <Pill key="s" tone={toneFor(vendor.status)}>{label(vendor.status)}</Pill>],
              ['Contact person', vendor.contactPersonName ?? '—'],
              ['Phone', vendor.phone ?? '—'],
              ['Alternate phone', vendor.alternatePhone ?? '—'],
              ['Email', vendor.email ?? '—'],
              ['GSTIN', vendor.gstin ? <code key="g">{vendor.gstin}</code> : '—'],
              ['PAN', vendor.pan ?? '—'],
              ['Address', renderAddress(vendor.address)],
              ['Contract', `${label(vendor.contractType)} · ${vendor.paymentTermsDays ?? 0} day payment terms`],
              ['Contract period', `${day(vendor.startDate)} → ${day(vendor.endDate)}`],
              ['Portal login', vendor.allowPortalLogin ? 'Enabled' : 'Not enabled'],
              ['Registered', ago(vendor.createdAt)],
            ]}
          />
        </Card>
        <Card title="Performance">
          <KeyValue
            items={[
              ['Rating', vendor.rating ? `${Number(vendor.rating).toFixed(1)} ★` : 'Not rated yet'],
              ['Work orders', `${number(vendor.completedWorkOrders)} completed of ${number(vendor.totalWorkOrders)}`],
              ['Services', (vendor.serviceCategories ?? []).map(label).join(', ') || '—'],
            ]}
          />
          {(vendor.serviceCategories ?? []).length > 0 ? (
            <div className="row row--wrap mt" style={{ gap: 6 }}>
              {(vendor.serviceCategories ?? []).map((c) => (
                <Pill key={c}>{label(c)}</Pill>
              ))}
            </div>
          ) : null}
        </Card>
      </div>

      {can('vendor:update') ? (
        <Alert tone={isBlocked(vendor) ? 'info' : 'warning'}>
          {isBlocked(vendor)
            ? 'Reinstating lets this vendor be assigned to new work orders again.'
            : 'Blocking removes this vendor from the assignment pickers. Open work orders stay open.'}
          <div className="mt">
            <Button size="sm" variant={isBlocked(vendor) ? 'primary' : 'danger'} busy={busy} onClick={() => void toggleBlock()}>
              {isBlocked(vendor) ? 'Reinstate vendor' : 'Block vendor'}
            </Button>
          </div>
        </Alert>
      ) : null}
    </Modal>
  );
}

function CreateVendorForm({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [businessName, setBusinessName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [contactPersonName, setContactPerson] = useState('');
  const [serviceCategories, setCategories] = useState<string[]>([]);
  const [gstin, setGstin] = useState('');
  const [contractType, setContractType] = useState('PER_VISIT');
  const [paymentTermsDays, setPaymentTerms] = useState('15');
  const [line1, setLine1] = useState('');
  const [city, setCity] = useState('');
  const [pincode, setPincode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  function toggle(category: string) {
    setCategories((prev) => (prev.includes(category) ? prev.filter((c) => c !== category) : [...prev, category]));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/vendors', {
        businessName: businessName.trim(),
        phone: phone.trim(),
        email: email.trim() || undefined,
        contactPersonName: contactPersonName.trim() || undefined,
        serviceCategories,
        gstin: gstin.trim() || undefined,
        contractType,
        paymentTermsDays: Number(paymentTermsDays) || undefined,
        address:
          line1.trim() || city.trim()
            ? { line1: line1.trim() || undefined, city: city.trim() || undefined, pincode: pincode.trim() || undefined }
            : undefined,
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
      title="Add a vendor"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={submit} disabled={serviceCategories.length === 0}>
            Add vendor
          </Button>
        </>
      }
    >
      {error ? <ErrorAlert error={error} /> : null}
      <form onSubmit={submit}>
        <Field label="Business name" required>
          <Input value={businessName} onChange={(e) => setBusinessName(e.target.value)} placeholder="Shree Plumbing Works" required autoFocus />
        </Field>
        <div className="form-row">
          <Field label="Phone" required hint="Becomes their login on the vendor app.">
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+919876543210" required />
          </Field>
          <Field label="Email">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
        </div>
        <div className="form-row">
          <Field label="Contact person">
            <Input value={contactPersonName} onChange={(e) => setContactPerson(e.target.value)} />
          </Field>
          <Field label="GSTIN">
            <Input value={gstin} onChange={(e) => setGstin(e.target.value.toUpperCase())} placeholder="27AAAAA0000A1Z5" />
          </Field>
        </div>
        <Field label="Services offered" required hint="Pick at least one — this drives who can be assigned a job.">
          <div className="row row--wrap" style={{ gap: 6 }}>
            {CATEGORIES.map((c) => (
              <Button key={c} type="button" size="sm" variant={serviceCategories.includes(c) ? 'primary' : 'default'} onClick={() => toggle(c)}>
                {label(c)}
              </Button>
            ))}
          </div>
        </Field>
        <div className="form-row">
          <Field label="Contract type">
            <Select value={contractType} onChange={(e) => setContractType(e.target.value)}>
              {['PER_VISIT', 'MONTHLY', 'ANNUAL', 'ONE_TIME', 'ON_CALL'].map((c) => (
                <option key={c} value={c}>{label(c)}</option>
              ))}
            </Select>
          </Field>
          <Field label="Payment terms (days)">
            <Input value={paymentTermsDays} onChange={(e) => setPaymentTerms(e.target.value)} inputMode="numeric" />
          </Field>
        </div>
        <div className="form-row">
          <Field label="Address">
            <Input value={line1} onChange={(e) => setLine1(e.target.value)} placeholder="18 Market Yard" />
          </Field>
          <Field label="City">
            <Input value={city} onChange={(e) => setCity(e.target.value)} placeholder="Pune" />
          </Field>
          <Field label="Pincode">
            <Input value={pincode} onChange={(e) => setPincode(e.target.value)} placeholder="411045" />
          </Field>
        </div>
      </form>
    </Modal>
  );
}
