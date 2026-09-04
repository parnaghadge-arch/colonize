import { useMemo, useState, type FormEvent } from 'react';
import { api } from '../lib/api.ts';
import { useResource } from '../lib/useResource.ts';
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
  Pill,
  Select,
  Textarea,
  useToast,
} from '../components/ui.tsx';
import { day, label } from '../lib/format.ts';
import { useSession } from '../lib/session.tsx';

/** A settings value is JSON all the way down; the deepest real nesting in DEFAULT_SETTINGS is 2. */
type SettingValue = string | number | boolean | null | SettingValue[] | { [key: string]: SettingValue };

interface Namespace {
  key: string;
  label: string;
  description?: string;
  value: Record<string, SettingValue>;
  defaults: Record<string, SettingValue>;
}

interface SettingsResponse {
  namespaces: Namespace[];
  values: Record<string, Record<string, SettingValue>>;
}

interface ModuleRow {
  key: string;
  label: string;
  enabled: boolean;
  entitled: boolean;
  upgradeRequired: boolean;
}

interface ModulesResponse {
  tier: string;
  planCode?: string;
  status?: string;
  modules: ModuleRow[];
}

/** Timezones offered rather than free-typed, because a typo here silently shifts every due date. */
const TIMEZONES = [
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Australia/Sydney',
  'UTC',
];

/**
 * Society settings (§63).
 *
 * Every business rule the platform applies — SLA hours, late fees, night-entry windows, refund
 * percentages, notification channels — is stored per society and read back by the API, the jobs and
 * the mobile push copy. Nothing here is a decorative preferences blob: each field is a rule some
 * server-side code path actually branches on, so the editor shows what the built-in default was and
 * marks anything the society has changed.
 */
export function SettingsPage() {
  const { who, can } = useSession();
  const [tab, setTab] = useState<'profile' | 'settings' | 'modules'>('profile');
  const editable = canAny(can, 'society:update', 'society:manage');

  return (
    <div className="stack">
      <div className="login__tabs" style={{ alignSelf: 'flex-start' }}>
        {(['profile', 'settings', 'modules'] as const).map((t) => (
          <button
            key={t}
            type="button"
            className={`login__tab${tab === t ? ' login__tab--active' : ''}`}
            onClick={() => setTab(t)}
          >
            {t === 'profile' ? 'Profile' : t === 'settings' ? 'Rules & settings' : 'Plan & modules'}
          </button>
        ))}
      </div>

      {tab === 'profile' ? <ProfileTab editable={editable} /> : null}
      {tab === 'settings' ? <SettingsTab editable={editable} /> : null}
      {tab === 'modules' ? <ModulesTab timezone={who?.society?.timezone} /> : null}
    </div>
  );
}

/** `can` accepts exactly one permission, so alternatives need this. */
function canAny(can: (permission: string) => boolean, ...permissions: string[]): boolean {
  return permissions.some((p) => can(p));
}

/* ---------------------------------- profile --------------------------------- */

const PROFILE_FIELDS = [
  'registrationNumber',
  'address',
  'city',
  'state',
  'pincode',
  'timezone',
  'contactPhone',
  'contactEmail',
  'websiteUrl',
  'logoUrl',
  'gstin',
] as const;

type ProfileField = (typeof PROFILE_FIELDS)[number];

interface Subscription {
  planCode?: string;
  tier?: string;
  status?: string;
  startDate?: string | null;
  endDate?: string | null;
  billingCycle?: string;
  autoRenew?: boolean;
}

interface SocietyProfile {
  _id: string;
  name: string;
  slug?: string;
  legalName?: string | null;
  status?: string;
  tier?: string;
  currency?: string;
  country?: string;
  pincode?: string | null;
  createdAt?: string;
  totalUnits?: number;
  totalResidents?: number;
  subscription?: Subscription | null;
  [key: string]: unknown;
}

/** `GET /society` wraps the document with its live entitlements and counters. */
interface SocietyResponse {
  society: SocietyProfile;
  subscription?: Subscription | null;
  enabledModules?: string[];
  counts?: Record<string, number>;
}

function ProfileTab({ editable }: { editable: boolean }) {
  const toast = useToast();
  const society = useResource<SocietyResponse>('/society');
  const [form, setForm] = useState<Record<string, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const current = society.data?.society;
  const values = form ?? readProfile(current);

  function readProfile(source: SocietyProfile | null | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    for (const key of PROFILE_FIELDS) {
      const raw = source?.[key];
      out[key] = raw === null || raw === undefined ? '' : String(raw);
    }
    return out;
  }

  const changed = useMemo(() => {
    if (!form || !current) return [] as ProfileField[];
    const baseline = readProfile(current);
    return PROFILE_FIELDS.filter((key) => (form[key] ?? '') !== baseline[key]);
  }, [form, current]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form) return;
    setBusy(true);
    setError(null);
    try {
      // Send only what changed. The schema is `.strict()`, so an unknown or mis-spelled key is a
      // 422 rather than a silent no-op — which is the behaviour we want to surface, not paper over.
      const patch: Record<string, unknown> = {};
      for (const key of changed) {
        const value = (form[key] ?? '').trim();
        patch[key] = key === 'logoUrl' ? (value === '' ? null : value) : value;
      }
      await api.patch('/society', patch);
      toast.success('Society profile updated');
      setForm(null);
      society.reload();
    } catch (err) {
      setError(err);
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  if (society.loading && !current) return <Loading />;
  if (society.error) return <ErrorAlert error={society.error} />;
  if (!current) return <EmptyState title="No society" hint="Could not load this society's profile." />;

  const set = (key: string, value: string) => setForm((prev) => ({ ...(prev ?? readProfile(current)), [key]: value }));

  return (
    <form onSubmit={submit} className="stack">
      {error ? <ErrorAlert error={error} /> : null}

      <Card title={String(current.name)} subtitle={`Slug ${String(current.slug ?? '—')} · ${String(current.currency ?? 'INR')}`}>
        <KeyValue
          items={[
            ['Status', current.status ? <Pill key="s" tone="success">{String(current.status)}</Pill> : '—'],
            ['Plan', String(current.subscription?.tier ?? current.tier ?? '—')],
            ['Country', String(current.country ?? '—')],
            ['Onboarded', day(current.createdAt)],
            ['Units', String(society.data?.counts?.units ?? current.totalUnits ?? '—')],
            ['Residents', String(society.data?.counts?.residents ?? current.totalResidents ?? '—')],
          ]}
        />
        <Alert tone="info">
          The society's <b>name</b>, <b>slug</b>, <b>status</b> and <b>plan</b> are platform-operator
          fields. They are rejected here rather than ignored, because changing them has consequences
          outside this society's own database.
        </Alert>
      </Card>

      <Card
        title="Contact & address"
        subtitle="Printed on invoices and receipts"
        actions={
          editable ? (
            <div className="row">
              {form ? (
                <Button size="sm" variant="ghost" onClick={() => setForm(null)}>
                  Discard
                </Button>
              ) : (
                <Button size="sm" onClick={() => setForm(readProfile(current))}>
                  Edit
                </Button>
              )}
              <Button size="sm" variant="primary" type="submit" busy={busy} disabled={!form || changed.length === 0}>
                Save{changed.length ? ` (${changed.length})` : ''}
              </Button>
            </div>
          ) : undefined
        }
      >
        {!editable ? <Alert tone="warning">You can view this profile but not change it.</Alert> : null}
        <fieldset disabled={!editable || !form} className="grid grid--2" style={{ border: 0, padding: 0, margin: 0 }}>
          <Field label="Registration number" hint="Co-operative society / CHS registration">
            <Input value={values.registrationNumber} onChange={(e) => set('registrationNumber', e.target.value)} />
          </Field>
          <Field label="GSTIN" hint="Printed on tax invoices when set">
            <Input value={values.gstin} onChange={(e) => set('gstin', e.target.value)} placeholder="27AAGCG1234F1Z5" />
          </Field>
          <Field label="Address">
            <Textarea value={values.address} onChange={(e) => set('address', e.target.value)} rows={2} />
          </Field>
          <div className="grid grid--2">
            <Field label="City">
              <Input value={values.city} onChange={(e) => set('city', e.target.value)} />
            </Field>
            <Field label="State">
              <Input value={values.state} onChange={(e) => set('state', e.target.value)} />
            </Field>
            <Field label="Pincode">
              <Input value={values.pincode} onChange={(e) => set('pincode', e.target.value)} inputMode="numeric" />
            </Field>
            <Field label="Timezone" hint="Drives due dates, SLAs and slot times">
              <Select value={values.timezone ?? ''} onChange={(e) => set('timezone', e.target.value)}>
                {values.timezone && !TIMEZONES.includes(values.timezone) ? (
                  <option value={values.timezone}>{values.timezone}</option>
                ) : null}
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Contact phone">
            <Input value={values.contactPhone} onChange={(e) => set('contactPhone', e.target.value)} />
          </Field>
          <Field label="Contact email">
            <Input type="email" value={values.contactEmail} onChange={(e) => set('contactEmail', e.target.value)} />
          </Field>
          <Field label="Website" hint="Full URL including https://">
            <Input value={values.websiteUrl} onChange={(e) => set('websiteUrl', e.target.value)} placeholder="https://" />
          </Field>
          <Field label="Logo URL">
            <Input value={values.logoUrl} onChange={(e) => set('logoUrl', e.target.value)} placeholder="https://…/logo.png" />
          </Field>
        </fieldset>
      </Card>
    </form>
  );
}

/* --------------------------------- settings --------------------------------- */

function SettingsTab({ editable }: { editable: boolean }) {
  const toast = useToast();
  const settings = useResource<SettingsResponse>('/society/settings');
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, SettingValue> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);

  const namespaces = settings.data?.namespaces ?? [];
  const active = namespaces.find((n) => n.key === activeKey) ?? namespaces[0] ?? null;

  // The draft is keyed to the namespace so switching tabs cannot carry edits across.
  const working: Record<string, SettingValue> = active
    ? (draft && activeKey === active.key ? draft : active.value)
    : {};

  const changedKeys = useMemo(() => {
    if (!active || activeKey !== active.key || !draft) return [] as string[];
    return Object.keys(active.value).filter((k) => !deepEqual(draft[k] ?? null, active.value[k] ?? null));
  }, [active, activeKey, draft]);

  function selectNamespace(key: string) {
    if (changedKeys.length > 0 && !window.confirm('Discard unsaved changes to these settings?')) return;
    setActiveKey(key);
    setDraft(null);
    setError(null);
    setJsonError(null);
  }

  function setKey(key: string, value: SettingValue) {
    setDraft((prev) => ({ ...(prev ?? { ...(active?.value ?? {}) }), [key]: value }));
  }

  function resetKey(key: string) {
    if (!active) return;
    setKey(key, structuredClone(active.defaults[key] ?? null) as SettingValue);
  }

  async function save() {
    if (!active || !draft) return;
    setBusy(true);
    setError(null);
    try {
      // Partial patch: the server deep-merges it over defaults + stored values, so sending only the
      // keys that changed can never wipe a sibling.
      const patch: Record<string, SettingValue> = {};
      for (const key of changedKeys) patch[key] = draft[key] ?? null;
      await api.put(`/society/settings/${active.key}`, { value: patch });
      toast.success(`${active.label} saved`);
      setDraft(null);
      settings.reload();
    } catch (err) {
      setError(err);
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  if (settings.loading && !settings.data) return <Loading />;
  if (settings.error) return <ErrorAlert error={settings.error} />;
  if (!active) return <EmptyState title="No configurable settings" hint="This society has no settings namespaces." />;

  const modifiedCount = (ns: Namespace) => Object.keys(ns.value).filter((k) => !deepEqual(ns.value[k] ?? null, ns.defaults[k] ?? null)).length;

  return (
    <div className="stack">
      {error ? <ErrorAlert error={error} /> : null}
      <Alert tone="info">
        These are the rules the platform actually applies — SLA clocks, late fees, night-entry
        windows, refund percentages, notification channels. Anything left alone uses the built-in
        default; anything you change is authoritative for the API, the scheduled jobs and the mobile
        apps.
      </Alert>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(220px, 300px) 1fr', gap: 16, alignItems: 'start' }}>
        <Card title="Areas" flush>
          <div className="list">
            {namespaces.map((ns) => {
              const dirty = modifiedCount(ns);
              return (
                <button
                  key={ns.key}
                  type="button"
                  className={`list__item${ns.key === active.key ? ' list__item--active' : ''}`}
                  onClick={() => selectNamespace(ns.key)}
                  style={{ width: '100%', textAlign: 'left' }}
                >
                  <span>
                    <b>{ns.label}</b>
                    <span className="faint small" style={{ display: 'block' }}>
                      {ns.description ?? ns.key}
                    </span>
                  </span>
                  {dirty > 0 ? <Pill tone="warning">{dirty} changed</Pill> : <span className="faint small">defaults</span>}
                </button>
              );
            })}
          </div>
        </Card>

        <Card
          title={active.label}
          subtitle={active.description}
          actions={
            editable ? (
              <div className="row">
                {draft ? (
                  <Button size="sm" variant="ghost" onClick={() => { setDraft(null); setJsonError(null); }}>
                    Discard
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="primary"
                  busy={busy}
                  disabled={!draft || changedKeys.length === 0 || Boolean(jsonError)}
                  onClick={() => void save()}
                >
                  Save{changedKeys.length ? ` (${changedKeys.length})` : ''}
                </Button>
              </div>
            ) : undefined
          }
        >
          {!editable ? <Alert tone="warning">You can read these rules but not change them.</Alert> : null}
          {jsonError ? <Alert tone="danger">{jsonError}</Alert> : null}

          <fieldset disabled={!editable} style={{ border: 0, padding: 0, margin: 0 }} className="stack">
            {Object.keys(active.value).map((key) => {
              const isDirty = !deepEqual(working[key] ?? null, active.value[key] ?? null);
              const differsFromDefault = !deepEqual(active.value[key] ?? null, active.defaults[key] ?? null);
              return (
                <div key={key} className="setting-row">
                  <div className="setting-row__head">
                    <code className="small">{key}</code>
                    {differsFromDefault ? <Pill tone="warning">customised</Pill> : null}
                    {isDirty ? <Pill tone="info">unsaved</Pill> : null}
                    {editable && differsFromDefault ? (
                      <Button size="sm" variant="ghost" onClick={() => resetKey(key)}>
                        Reset to default
                      </Button>
                    ) : null}
                  </div>
                  <ValueEditor
                    value={working[key] ?? null}
                    defaultValue={active.defaults[key] ?? null}
                    onChange={(next) => setKey(key, next)}
                    onJsonError={setJsonError}
                  />
                </div>
              );
            })}
          </fieldset>
        </Card>
      </div>
    </div>
  );
}

/**
 * Renders whatever JSON shape a setting holds with a control that suits it.
 *
 * Types are inferred from the default rather than hard-coded per key, so a setting added to
 * DEFAULT_SETTINGS later shows up here with a sensible editor instead of vanishing.
 */
function ValueEditor({
  value,
  defaultValue,
  onChange,
  onJsonError,
}: {
  value: SettingValue;
  defaultValue: SettingValue;
  onChange: (next: SettingValue) => void;
  onJsonError: (message: string | null) => void;
}) {
  const reference = defaultValue === null || defaultValue === undefined ? value : defaultValue;

  if (typeof reference === 'boolean') {
    return (
      <label className="row" style={{ gap: 8 }}>
        <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
        <span className="small">{value ? 'On' : 'Off'}</span>
      </label>
    );
  }

  if (typeof reference === 'number') {
    return (
      <Input
        type="number"
        value={value === null || value === undefined ? '' : String(value)}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        style={{ maxWidth: 200 }}
      />
    );
  }

  if (typeof reference === 'string' || reference === null) {
    const text = value === null || value === undefined ? '' : String(value);
    // Shape is inferred from the value itself, so `nightStart: "22:00"` gets a time picker and
    // `primaryColor: "#4F46E5"` gets a colour picker without naming either key here.
    const isTime = /^\d{2}:\d{2}(:\d{2})?$/.test(text) || /^\d{2}:\d{2}(:\d{2})?$/.test(String(defaultValue ?? ''));
    const isColour = /^#[0-9a-fA-F]{6}$/.test(text) || /^#[0-9a-fA-F]{6}$/.test(String(defaultValue ?? ''));
    const nullable = defaultValue === null || defaultValue === undefined;
    return (
      <div className="row" style={{ gap: 8 }}>
        {isColour ? (
          <input type="color" value={text || '#4F46E5'} onChange={(e) => onChange(e.target.value)} aria-label="Colour" />
        ) : null}
        <Input
          type={isTime && !isColour ? 'time' : 'text'}
          value={text}
          placeholder={nullable ? 'Not set' : undefined}
          onChange={(e) => onChange(e.target.value === '' && nullable ? null : e.target.value)}
          style={{ maxWidth: 320 }}
        />
      </div>
    );
  }

  if (Array.isArray(reference)) {
    // Arrays of primitives edit as a comma-separated list; anything richer needs real JSON.
    const primitive = reference.every((item) => typeof item !== 'object' || item === null);
    if (primitive) {
      const text = Array.isArray(value) ? value.map((v) => String(v)).join(', ') : '';
      return (
        <div className="stack" style={{ gap: 4 }}>
          <Input
            value={text}
            onChange={(e) => {
              const parts = e.target.value.split(',').map((p) => p.trim()).filter((p) => p !== '');
              const numeric = reference.length > 0 && reference.every((item) => typeof item === 'number');
              onChange(numeric ? parts.map((p) => Number(p)).filter((n) => Number.isFinite(n)) : parts);
            }}
          />
          <span className="faint small">Comma-separated{reference.length > 0 && typeof reference[0] === 'number' ? ' numbers' : ''}</span>
        </div>
      );
    }
    return <JsonEditor value={value} onChange={onChange} onError={onJsonError} />;
  }

  if (reference && typeof reference === 'object') {
    const entries = Object.entries((value ?? {}) as Record<string, SettingValue>);
    if (entries.length === 0) return <JsonEditor value={value} onChange={onChange} onError={onJsonError} />;
    return (
      <div className="stack" style={{ gap: 8 }}>
        {entries.map(([childKey, childValue]) => (
          <div key={childKey} className="grid" style={{ gridTemplateColumns: 'minmax(140px, 220px) 1fr', gap: 8, alignItems: 'center' }}>
            <code className="small">{childKey}</code>
            <ValueEditor
              value={childValue}
              defaultValue={((defaultValue ?? {}) as Record<string, SettingValue>)[childKey] ?? null}
              onChange={(next) => onChange({ ...(value as Record<string, SettingValue>), [childKey]: next })}
              onJsonError={onJsonError}
            />
          </div>
        ))}
      </div>
    );
  }

  return <JsonEditor value={value} onChange={onChange} onError={onJsonError} />;
}

function JsonEditor({
  value,
  onChange,
  onError,
}: {
  value: SettingValue;
  onChange: (next: SettingValue) => void;
  onError: (message: string | null) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(value ?? null, null, 2));

  return (
    <Textarea
      rows={Math.min(12, Math.max(3, text.split('\n').length))}
      value={text}
      spellCheck={false}
      onChange={(e) => {
        setText(e.target.value);
        try {
          onChange(JSON.parse(e.target.value) as SettingValue);
          onError(null);
        } catch {
          onError('That value is not valid JSON yet — fix it before saving.');
        }
      }}
      style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }}
    />
  );
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/* --------------------------------- modules ---------------------------------- */

function ModulesTab({ timezone }: { timezone?: string }) {
  const modules = useResource<ModulesResponse>('/society/modules');
  const society = useResource<SocietyResponse>('/society');

  if (modules.loading || society.loading) return <Loading />;
  if (modules.error) return <ErrorAlert error={modules.error} />;
  if (!modules.data) return <EmptyState title="No entitlements" hint="Could not load this society's plan." />;

  const subscription = society.data?.subscription ?? society.data?.society.subscription;
  const rows = modules.data.modules;
  const enabled = rows.filter((m) => m.enabled).length;
  const blocked = rows.filter((m) => !m.entitled).length;

  return (
    <div className="stack">
      <Card title="Plan" subtitle="Entitlements are enforced server-side on every request">
        <KeyValue
          items={[
            ['Tier', label(modules.data.tier)],
            ['Plan code', modules.data.planCode ? String(modules.data.planCode) : '—'],
            ['Status', subscription?.status ? <Pill key="s" tone={subscription.status === 'ACTIVE' ? 'success' : 'warning'}>{String(subscription.status)}</Pill> : '—'],
            ['Billing period', subscription?.startDate && subscription?.endDate ? `${day(subscription.startDate, timezone)} → ${day(subscription.endDate, timezone)}` : '—'],
            ['Auto-renew', subscription?.autoRenew ? 'Yes' : 'No'],
            ['Modules on', `${enabled} of ${rows.length}`],
          ]}
        />
        {blocked > 0 ? (
          <Alert tone="warning">
            {blocked} module{blocked === 1 ? '' : 's'} in the catalogue are not included in this plan.
            Turning them on requires a plan change from the platform operator — the API rejects
            requests for them regardless of what this screen shows.
          </Alert>
        ) : null}
      </Card>

      <Card title="Module catalogue" flush>
        <DataTable
          rows={rows}
          rowKey={(m) => m.key}
          empty={<EmptyState title="No modules" hint="The plan exposes no modules." />}
          columns={[
            { key: 'label', header: 'Module', render: (m) => <b>{m.label}</b> },
            { key: 'key', header: 'Key', render: (m) => <code className="small">{m.key}</code> },
            {
              key: 'entitled',
              header: 'In plan',
              render: (m) => (m.entitled ? <Pill tone="success">Included</Pill> : <Pill tone="neutral">Upgrade required</Pill>),
            },
            {
              key: 'enabled',
              header: 'Turned on',
              render: (m) => (m.enabled ? <Pill tone="info">On</Pill> : <Pill tone="neutral">Off</Pill>),
            },
          ]}
        />
      </Card>
    </div>
  );
}
