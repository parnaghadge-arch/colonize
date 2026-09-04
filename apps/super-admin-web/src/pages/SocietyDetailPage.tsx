import { useMemo, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
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
  Textarea,
  useToast,
} from '../components/ui.tsx';
import { dateTime, day, label, money, number } from '../lib/format.ts';
import { useSession } from '../lib/session.tsx';
import {
  ADMIN_ROLES,
  MODULE_KEYS,
  PLAN_CODES,
  RENEWAL_MODES,
  SOCIETY_STATUSES,
  SUBSCRIPTION_STATUSES,
  type OnboardingState,
  type PlatformAuditLog,
  type SocietyAdmin,
  type SocietyDetail,
  type SocietyStats,
} from '../lib/types.ts';

/**
 * One society, seen from the platform (§46, §79).
 *
 * Six concerns that a super admin actually acts on, each against its own endpoint: the record,
 * onboarding state, live usage, the plan, the administrators who can sign in, and the audit trail.
 * Plan changes go through the subscription endpoint because that is the only route that resolves
 * `planId` and re-syncs the tenant mirror the API authorises against.
 */
export function SocietyDetailPage() {
  const { id = '' } = useParams();
  const { can, canAny } = useSession();
  const toast = useToast();

  const society = useResource<SocietyDetail>(`/platform/societies/${id}`);
  // Fetched here as well as on its own tab because activation has a real precondition (at least one
  // unit) that the checklist reports — the header needs it to avoid offering a button that only 400s.
  const onboarding = useResource<OnboardingState>(`/platform/societies/${id}/onboarding`);
  const [tab, setTab] = useState<'overview' | 'profile' | 'onboarding' | 'plan' | 'admins' | 'audit'>('overview');
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [statusTarget, setStatusTarget] = useState<string | null>(null);

  const canUpdate = canAny('society:update', 'society:manage');
  const canManage = can('society:manage');
  const canSubscription = canAny('subscription:manage', 'subscription:update');

  async function act(name: string, fn: () => Promise<unknown>, message: string) {
    setBusyAction(name);
    try {
      await fn();
      toast.success(message);
      society.reload();
      onboarding.reload();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusyAction(null);
    }
  }

  if (society.loading && !society.data) return <Loading />;
  if (society.error) return <ErrorAlert error={society.error} />;
  const record = society.data;
  if (!record) return <EmptyState title="Society not found" hint="It may have been archived or deleted." />;

  const provisioned = Boolean(record.databaseProvisioned);
  const isActive = record.status === 'ACTIVE';
  const blockers = (onboarding.data?.checklist ?? []).filter((item) => !item.done && item.required);
  const canActivate = blockers.length === 0;

  const tabs: { key: typeof tab; label: string; show: boolean }[] = [
    { key: 'overview', label: 'Overview', show: true },
    { key: 'profile', label: 'Profile', show: canAny('society:view', 'society:manage') },
    { key: 'onboarding', label: 'Onboarding', show: canAny('society:view', 'society:manage') },
    { key: 'plan', label: 'Plan & limits', show: canAny('society:view', 'subscription:manage', 'subscription:update') },
    { key: 'admins', label: 'Administrators', show: canAny('society:view', 'society:manage') },
    { key: 'audit', label: 'Audit trail', show: can('audit:view') },
  ];

  return (
    <div className="stack">
      <Card>
        <div className="row row--between row--wrap" style={{ gap: 12 }}>
          <div>
            <div className="row" style={{ gap: 8 }}>
              <Link to="/societies" className="small muted" style={{ textDecoration: 'none' }}>
                ← All societies
              </Link>
            </div>
            <h2 style={{ margin: '4px 0' }}>{record.name}</h2>
            <div className="faint small">
              {record.legalName ?? record.slug} · {record.city ?? '—'}
              {record.state ? `, ${record.state}` : ''} · created {day(record.createdAt)}
            </div>
            <div className="row" style={{ gap: 6, marginTop: 8 }}>
              <Pill tone={isActive ? 'success' : record.status === 'SUSPENDED' ? 'danger' : 'warning'}>{label(record.status)}</Pill>
              <Pill tone={record.tier === 'ENTERPRISE' ? 'brand' : undefined}>{label(record.tier ?? 'FREE')}</Pill>
              <Pill tone={provisioned ? 'success' : 'danger'}>{provisioned ? 'Database provisioned' : 'Database missing'}</Pill>
              <code className="small faint">{record.databaseName ?? '—'}</code>
            </div>
          </div>

          <div className="row row--wrap" style={{ gap: 8 }}>
            {!provisioned && canManage ? (
              <Button
                variant="primary"
                busy={busyAction === 'provision'}
                onClick={() => void act('provision', () => api.post(`/platform/societies/${id}/provision`, {}), 'Database provisioned with default roles, ledgers and settings')}
              >
                Provision database
              </Button>
            ) : null}
            {canManage && !isActive ? (
              <Button
                variant="primary"
                busy={busyAction === 'activate'}
                disabled={!canActivate}
                title={canActivate ? undefined : `Blocked: ${blockers.map((b) => b.label).join('; ')}`}
                onClick={() => void act('activate', () => api.post(`/platform/societies/${id}/activate`, {}), 'Society activated — residents and guards can now sign in')}
              >
                Activate
              </Button>
            ) : null}
            {canManage ? (
              <Button busy={busyAction === 'rebuild'} onClick={() => void act('rebuild', () => api.post(`/platform/societies/${id}/rebuild-directory`, {}), 'Login directory rebuilt')}>
                Rebuild login directory
              </Button>
            ) : null}
            {canManage ? (
              <Button variant="ghost" onClick={() => setStatusTarget(record.status)}>
                Change status
              </Button>
            ) : null}
          </div>
        </div>

        {!provisioned ? (
          <Alert tone="danger">
            This society has no database, so nothing in it works — not sign-in, not structure, not
            billing. Provisioning seeds default roles, ledgers and settings. It is idempotent and safe
            to re-run after a partial onboarding.
          </Alert>
        ) : null}
        {record.status === 'SUSPENDED' ? (
          <Alert tone="danger">
            Suspended: every request from this society's residents, guards and administrators is being
            rejected. Reinstate it with a status change when the issue is resolved.
          </Alert>
        ) : null}
        {!isActive && record.status !== 'SUSPENDED' ? (
          <Alert tone="warning">
            Not active yet — residents and guards cannot sign in until an operator activates this
            society.
            {blockers.length > 0 ? (
              <>
                {' '}
                Activation is blocked until: <b>{blockers.map((b) => b.label).join('; ')}</b>. The
                backend enforces this (it refuses to activate a society with no units), so the button
                stays disabled rather than failing on click.
              </>
            ) : null}
          </Alert>
        ) : null}
        {!provisioned && record.status === 'ONBOARDING' ? (
          <Alert tone="info">
            Provisioning runs in the background and usually lands within a second or two.{' '}
            <Button size="sm" variant="ghost" onClick={() => society.reload()}>
              Re-check
            </Button>
          </Alert>
        ) : null}
      </Card>

      <div className="login__tabs" style={{ alignSelf: 'flex-start' }}>
        {tabs.filter((t) => t.show).map((t) => (
          <button key={t.key} type="button" className={`login__tab${tab === t.key ? ' login__tab--active' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' ? <OverviewTab id={id} record={record} /> : null}
      {tab === 'profile' ? <ProfileTab id={id} record={record} editable={canUpdate} /> : null}
      {tab === 'onboarding' ? <OnboardingTab id={id} record={record} editable={canUpdate} /> : null}
      {tab === 'plan' ? <PlanTab id={id} record={record} editable={canSubscription} /> : null}
      {tab === 'admins' ? <AdminsTab id={id} canInvite={canManage || can('user:create')} /> : null}
      {tab === 'audit' ? <AuditTab id={id} /> : null}

      {statusTarget ? (
        <StatusForm
          id={id}
          current={statusTarget}
          onClose={() => setStatusTarget(null)}
          onDone={(message) => {
            setStatusTarget(null);
            toast.success(message);
            society.reload();
          }}
        />
      ) : null}
    </div>
  );
}

/* --------------------------------- overview --------------------------------- */

function OverviewTab({ id, record }: { id: string; record: SocietyDetail }) {
  const stats = useResource<SocietyStats>(`/platform/societies/${id}/stats`);
  const units = stats.data?.units;

  return (
    <div className="stack">
      {stats.error ? <ErrorAlert error={stats.error} /> : null}

      {stats.loading && !stats.data ? (
        <Loading />
      ) : (
        <>
          <div className="tiles">
            {[
              { label: 'Units', value: number(units?.total ?? record.totalUnits ?? 0), hint: `${number(units?.occupied ?? 0)} occupied · ${number(units?.vacant ?? 0)} vacant` },
              { label: 'Residents', value: number(stats.data?.residents ?? record.totalResidents ?? 0), hint: 'Across all units' },
              { label: 'Staff', value: number(stats.data?.staff ?? 0), hint: `${number(stats.data?.vendors ?? 0)} vendors` },
              { label: 'Collected', value: money(stats.data?.collected ?? 0), hint: `${money(stats.data?.billedTotal ?? 0)} billed` , tone: 'success' },
              { label: 'Outstanding', value: money(stats.data?.outstanding ?? 0), hint: 'Unpaid across all bills', tone: (stats.data?.outstanding ?? 0) > 0 ? 'warning' : 'success' },
              { label: 'Open complaints', value: number(stats.data?.openComplaints ?? 0), hint: `${number(stats.data?.visitorsLast30Days ?? 0)} visitors in 30 days` },
              { label: 'Active bookings', value: number(stats.data?.activeBookings ?? 0), hint: 'Amenity bookings in flight' },
            ].map((tile) => (
              <div key={tile.label} className={`tile${tile.tone ? ` tile--${tile.tone}` : ''}`}>
                <div className="tile__label">{tile.label}</div>
                <div className="tile__value">{tile.value}</div>
                <div className="tile__hint">{tile.hint}</div>
              </div>
            ))}
          </div>

          <div className="grid grid--2">
            <Card title="Occupancy">
              {units?.byOccupancy && Object.keys(units.byOccupancy).length > 0 ? (
                <KeyValue
                  items={Object.entries(units.byOccupancy).map(([key, value]) => [label(key), number(value)] as [string, string])}
                />
              ) : (
                <p className="faint small">No occupancy breakdown yet.</p>
              )}
              <KeyValue
                items={[
                  ['Locked', number(units?.locked ?? 0)],
                  ['Under maintenance', number(units?.underMaintenance ?? 0)],
                ]}
              />
            </Card>
            <Card title="Structure">
              <KeyValue
                items={[
                  ['Buildings', number(record.totalBuildings ?? 0)],
                  ['Wings', number(record.totalWings ?? 0)],
                  ['Units', number(record.totalUnits ?? 0)],
                  ['Gates', number(record.totalGates ?? 0)],
                  ['Staff', number(record.totalStaff ?? 0)],
                ]}
              />
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

/* ---------------------------------- profile --------------------------------- */

const PROFILE_KEYS = [
  'name',
  'slug',
  'legalName',
  'registrationNumber',
  'city',
  'state',
  'country',
  'pincode',
  'address',
  'timezone',
  'currency',
  'contactEmail',
  'contactPhone',
  'supportContact',
  'websiteUrl',
  'logoUrl',
  'coverImageUrl',
  'gstin',
  'notes',
] as const;

type ProfileKey = (typeof PROFILE_KEYS)[number];

/** Fields the schema treats as clearable, so an empty input sends `null` rather than `''`. */
const NULLABLE: readonly ProfileKey[] = [
  'legalName',
  'registrationNumber',
  'state',
  'pincode',
  'address',
  'contactEmail',
  'contactPhone',
  'supportContact',
  'websiteUrl',
  'logoUrl',
  'coverImageUrl',
  'gstin',
  'notes',
];

const TIMEZONES = ['Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney', 'UTC'];

function ProfileTab({ id, record, editable }: { id: string; record: SocietyDetail; editable: boolean }) {
  const toast = useToast();
  const baseline = useMemo(() => {
    const out = {} as Record<ProfileKey, string>;
    for (const key of PROFILE_KEYS) {
      const raw = (record as unknown as Record<string, unknown>)[key];
      out[key] = raw === null || raw === undefined ? '' : String(raw);
    }
    return out;
  }, [record]);

  const [form, setForm] = useState<Record<ProfileKey, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const values = form ?? baseline;

  const changed = useMemo(
    () => (form ? PROFILE_KEYS.filter((key) => (form[key] ?? '') !== baseline[key]) : []),
    [form, baseline],
  );

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!form) return;
    setBusy(true);
    setError(null);
    try {
      const patch: Record<string, unknown> = {};
      for (const key of changed) {
        const value = (form[key] ?? '').trim();
        // Send only what changed. Omitting a field is what keeps it: the schema carries no
        // defaults, so an untouched `timezone` or `currency` is never rewritten.
        patch[key] = value === '' && NULLABLE.includes(key) ? null : value;
      }
      if (form.notes !== baseline.notes) patch.isFeatured = record.isFeatured ?? false;
      await api.patch(`/platform/societies/${id}`, patch);
      toast.success('Society updated');
      setForm(null);
    } catch (err) {
      setError(err);
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  const set = (key: ProfileKey, value: string) => setForm((prev) => ({ ...(prev ?? baseline), [key]: value }));
  const slugValid = /^[a-z0-9-]{3,48}$/.test(values.slug);

  return (
    <form onSubmit={submit} className="stack">
      {error ? <ErrorAlert error={error} /> : null}

      <Card
        title="Society record"
        subtitle="What the platform stores about this tenant"
        actions={
          editable ? (
            <div className="row">
              {form ? (
                <Button size="sm" variant="ghost" onClick={() => setForm(null)}>
                  Discard
                </Button>
              ) : (
                <Button size="sm" onClick={() => setForm({ ...baseline })}>
                  Edit
                </Button>
              )}
              <Button size="sm" variant="primary" type="submit" busy={busy} disabled={!form || changed.length === 0 || !slugValid}>
                Save{changed.length ? ` (${changed.length})` : ''}
              </Button>
            </div>
          ) : undefined
        }
      >
        {!editable ? <Alert tone="warning">Your operator role can view this record but not change it.</Alert> : null}
        <Alert tone="info">
          The <b>plan</b> and <b>module entitlements</b> are not editable here. They live on the
          subscription, which is the only place that resolves the plan and re-syncs the tenant mirror
          the API authorises against — see the Plan &amp; limits tab.
        </Alert>

        <fieldset disabled={!editable || !form} className="grid grid--2" style={{ border: 0, padding: 0, margin: 0 }}>
          <Field label="Name" required hint="3–120 characters">
            <Input value={values.name} onChange={(e) => set('name', e.target.value)} />
          </Field>
          <Field label="Slug" required error={slugValid ? undefined : 'Must be 3–48 lowercase letters, numbers or dashes'} hint="Used in URLs and the database name">
            <Input value={values.slug} onChange={(e) => set('slug', e.target.value.toLowerCase())} />
          </Field>
          <Field label="Legal name">
            <Input value={values.legalName} onChange={(e) => set('legalName', e.target.value)} />
          </Field>
          <Field label="Registration number">
            <Input value={values.registrationNumber} onChange={(e) => set('registrationNumber', e.target.value)} />
          </Field>
          <Field label="City" required>
            <Input value={values.city} onChange={(e) => set('city', e.target.value)} />
          </Field>
          <Field label="State">
            <Input value={values.state} onChange={(e) => set('state', e.target.value)} />
          </Field>
          <Field label="Country" hint="ISO 3166-1 alpha-2">
            <Input value={values.country} onChange={(e) => set('country', e.target.value.toUpperCase())} maxLength={2} />
          </Field>
          <Field label="Pincode">
            <Input value={values.pincode} onChange={(e) => set('pincode', e.target.value)} inputMode="numeric" />
          </Field>
          <Field label="Timezone" hint="Drives every due date, SLA clock and amenity slot">
            <Select value={values.timezone} onChange={(e) => set('timezone', e.target.value)}>
              {values.timezone && !TIMEZONES.includes(values.timezone) ? <option value={values.timezone}>{values.timezone}</option> : null}
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Currency" hint="3-letter code">
            <Input value={values.currency} onChange={(e) => set('currency', e.target.value.toUpperCase())} maxLength={3} />
          </Field>
        </fieldset>

        <Field label="Address">
          <Textarea rows={2} value={values.address} onChange={(e) => set('address', e.target.value)} />
        </Field>

        <fieldset disabled={!editable || !form} className="grid grid--3" style={{ border: 0, padding: 0, margin: 0 }}>
          <Field label="Contact email">
            <Input type="email" value={values.contactEmail} onChange={(e) => set('contactEmail', e.target.value)} />
          </Field>
          <Field label="Contact phone">
            <Input value={values.contactPhone} onChange={(e) => set('contactPhone', e.target.value)} />
          </Field>
          <Field label="Support contact" hint="Shown to this society's users">
            <Input value={values.supportContact} onChange={(e) => set('supportContact', e.target.value)} />
          </Field>
          <Field label="Website">
            <Input value={values.websiteUrl} onChange={(e) => set('websiteUrl', e.target.value)} placeholder="https://" />
          </Field>
          <Field label="Logo URL">
            <Input value={values.logoUrl} onChange={(e) => set('logoUrl', e.target.value)} />
          </Field>
          <Field label="Cover image URL">
            <Input value={values.coverImageUrl} onChange={(e) => set('coverImageUrl', e.target.value)} />
          </Field>
        </fieldset>

        <div className="grid grid--2">
          <Field label="GSTIN" hint="Printed on this society's tax invoices">
            <Input value={values.gstin} onChange={(e) => set('gstin', e.target.value)} />
          </Field>
          <Field label="Operator notes" hint="Internal; not shown to the society">
            <Textarea rows={2} value={values.notes} onChange={(e) => set('notes', e.target.value)} />
          </Field>
        </div>
      </Card>
    </form>
  );
}

/* -------------------------------- onboarding -------------------------------- */

function OnboardingTab({ id, record, editable }: { id: string; record: SocietyDetail; editable: boolean }) {
  const toast = useToast();
  const onboarding = useResource<OnboardingState>(`/platform/societies/${id}/onboarding`);
  const [step, setStep] = useState('PROFILE');
  const [dryRun, setDryRun] = useState(false);
  const [busy, setBusy] = useState(false);

  const state = onboarding.data;
  const checklist = state?.checklist ?? [];
  const done = checklist.filter((c) => c.done).length;
  const blockers = checklist.filter((c) => !c.done && c.required);

  async function advance(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api.post<Record<string, unknown>>(`/platform/societies/${id}/onboarding`, {
        step,
        payload: {},
        dryRun,
      });
      toast.success(dryRun ? `Dry run: ${JSON.stringify(result).slice(0, 160)}` : `Onboarding step ${label(step)} recorded`);
      if (!dryRun) onboarding.reload();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      {onboarding.error ? <ErrorAlert error={onboarding.error} /> : null}

      {onboarding.loading && !state ? (
        <Loading />
      ) : (
        <>
          <Card title="Onboarding state">
            <KeyValue
              items={[
                ['Current step', label(state?.currentStep ?? record.onboardingStep ?? 'NOT_STARTED')],
                ['Completed', (state?.completedSteps ?? []).map((s) => label(s)).join(' → ') || '—'],
                ['Database provisioned', state?.databaseProvisioned ? 'Yes' : 'No'],
                ['Started', day(record.onboardingStartedAt)],
                ['Completed at', record.onboardingCompletedAt ? dateTime(record.onboardingCompletedAt) : '—'],
                ['Source', record.onboardingSource ? label(record.onboardingSource) : '—'],
                ['Checklist', `${done} of ${checklist.length} done`],
              ]}
            />
            {state?.counts ? (
              <div className="row row--wrap mt" style={{ gap: 8 }}>
                {Object.entries(state.counts).map(([key, value]) => (
                  <Pill key={key}>
                    {label(key)}: {number(value as number)}
                  </Pill>
                ))}
              </div>
            ) : null}
          </Card>

          <Card title="Activation checklist" subtitle="What still blocks this society going live">
            {checklist.length === 0 ? (
              <p className="faint small">No checklist returned.</p>
            ) : (
              <div className="stack" style={{ gap: 6 }}>
                {checklist.map((item) => (
                  <div key={item.key} className="row" style={{ gap: 8 }}>
                    <span aria-hidden>{item.done ? '✅' : item.required ? '⬜' : '◻️'}</span>
                    <span className={item.done ? '' : 'muted'}>{item.label}</span>
                    {!item.required ? <Pill>optional</Pill> : null}
                  </div>
                ))}
              </div>
            )}
            {blockers.length > 0 ? (
              <Alert tone="warning">
                {blockers.length} required step{blockers.length === 1 ? '' : 's'} outstanding:{' '}
                {blockers.map((b) => b.label).join('; ')}.
              </Alert>
            ) : (
              <Alert tone="success">Every required step is complete — this society can be activated.</Alert>
            )}
          </Card>

          {editable ? (
            <Card title="Record an onboarding step" subtitle="Use the dry run to see what a step would save before writing it">
              <form onSubmit={advance} className="row row--wrap" style={{ gap: 10, alignItems: 'flex-end' }}>
                <Field label="Step">
                  <Select value={step} onChange={(e) => setStep(e.target.value)}>
                    {['PROFILE', 'STRUCTURE', 'ADMIN', 'SETTINGS', 'ACTIVATION'].map((s) => (
                      <option key={s} value={s}>
                        {label(s)}
                      </option>
                    ))}
                  </Select>
                </Field>
                <label className="row" style={{ gap: 6, paddingBottom: 8 }}>
                  <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
                  <span className="small">Dry run</span>
                </label>
                <Button type="submit" variant="primary" busy={busy}>
                  {dryRun ? 'Preview' : 'Record step'}
                </Button>
              </form>
            </Card>
          ) : null}
        </>
      )}
    </div>
  );
}

/* ---------------------------------- plan ------------------------------------ */

function PlanTab({ id, record, editable }: { id: string; record: SocietyDetail; editable: boolean }) {
  const toast = useToast();
  const subscription = record.subscription;
  const limits = record.limits ?? {};

  const [form, setForm] = useState({
    tier: String(subscription?.tier ?? record.tier ?? 'FREE'),
    status: String(subscription?.status ?? 'ACTIVE'),
    renewalMode: String(subscription?.renewalMode ?? 'MONTHLY'),
    startDate: String(subscription?.startDate ?? '').slice(0, 10),
    endDate: String(subscription?.endDate ?? '').slice(0, 10),
    amount: String(subscription?.amount ?? 0),
    maxUnits: String(limits.maxUnits ?? 500),
    maxAdmins: String(limits.maxAdmins ?? 10),
    maxGates: String(limits.maxGates ?? 10),
    smsCredits: String(limits.smsCredits ?? 1000),
    storageMb: String(limits.storageMb ?? 10240),
    whatsappEnabled: Boolean(subscription?.whatsappEnabled),
    paymentGatewayEnabled: subscription?.paymentGatewayEnabled !== false,
    biometricEnabled: Boolean(subscription?.biometricEnabled),
    autoRenew: Boolean(subscription?.autoRenew),
    modules: (subscription?.modules?.length ? subscription.modules : record.modules ?? []) as string[],
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const currentModules = (subscription?.modules?.length ? subscription.modules : record.modules ?? []) as string[];
  const tierDefaultModules = PLAN_CODES.includes(form.tier as (typeof PLAN_CODES)[number]) ? form.tier : 'FREE';
  const modulesChanged = form.modules.join(',') !== currentModules.join(',');

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        tier: form.tier,
        status: form.status,
        renewalMode: form.renewalMode,
        amount: Number(form.amount || 0),
        whatsappEnabled: form.whatsappEnabled,
        paymentGatewayEnabled: form.paymentGatewayEnabled,
        biometricEnabled: form.biometricEnabled,
        autoRenew: form.autoRenew,
      };
      // Only send limits the operator actually set; omitted ones fall back to the existing values.
      for (const [key, value] of Object.entries({
        maxUnits: form.maxUnits,
        maxAdmins: form.maxAdmins,
        maxGates: form.maxGates,
        smsCredits: form.smsCredits,
        storageMb: form.storageMb,
      })) {
        if (value !== '') body[key] = Number(value);
      }
      if (form.startDate) body.startDate = form.startDate;
      if (form.endDate) body.endDate = form.endDate;
      // Sending the module list pins it; omitting it lets the server derive the tier's default set.
      if (form.modules.length > 0) body.modules = form.modules;

      await api.put(`/platform/societies/${id}/subscription`, body);
      toast.success('Subscription updated and the tenant mirror re-synced');
    } catch (err) {
      setError(err);
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      {error ? <ErrorAlert error={error} /> : null}

      <Card title="Current entitlements" subtitle="What this society is authorised for right now">
        <KeyValue
          items={[
            ['Plan', label(subscription?.planCode ?? subscription?.tier ?? record.tier ?? 'FREE')],
            ['Status', subscription?.status ? <Pill key="s" tone={subscription.status === 'ACTIVE' ? 'success' : subscription.status === 'TRIAL' ? 'info' : 'warning'}>{label(subscription.status)}</Pill> : '—'],
            ['Period', subscription?.startDate && subscription?.endDate ? `${day(subscription.startDate)} → ${day(subscription.endDate)}` : '—'],
            ['Renewal', label(subscription?.renewalMode ?? 'MONTHLY')],
            ['Amount', money(subscription?.amount ?? 0)],
            ['Auto-renew', subscription?.autoRenew ? 'Yes' : 'No'],
            ['Modules enabled', `${currentModules.length} of ${MODULE_KEYS.length}`],
            ['Tenant mirror', subscription?.outOfSync ? <Pill key="m" tone="danger">Out of sync</Pill> : <Pill key="m" tone="success">In sync</Pill>],
          ]}
        />
        {subscription?.outOfSync ? (
          <Alert tone="danger">
            The tenant's subscription mirror has drifted from this record. Authorisation reads the
            mirror, so the society is not getting what is shown here — saving the plan below
            re-syncs it.
          </Alert>
        ) : null}
        <KeyValue
          items={[
            ['Max units', number(limits.maxUnits ?? 0)],
            ['Max admins', number(limits.maxAdmins ?? 0)],
            ['Max gates', number(limits.maxGates ?? 0)],
            ['SMS credits', number(limits.smsCredits ?? 0)],
            ['Storage', `${number(limits.storageMb ?? 0)} MB`],
          ]}
        />
      </Card>

      <Card title="Change plan" subtitle="Resolves the plan, derives modules from the tier, recomputes limits and re-syncs the tenant">
        {!editable ? (
          <Alert tone="warning">Your operator role cannot change subscriptions.</Alert>
        ) : (
          <form onSubmit={submit} className="stack">
            <div className="grid grid--3">
              <Field label="Plan tier" required>
                <Select value={form.tier} onChange={(e) => setForm((p) => ({ ...p, tier: e.target.value }))}>
                  {PLAN_CODES.map((t) => (
                    <option key={t} value={t}>
                      {label(t)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Subscription status">
                <Select value={form.status} onChange={(e) => setForm((p) => ({ ...p, status: e.target.value }))}>
                  {SUBSCRIPTION_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {label(s)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Renewal mode">
                <Select value={form.renewalMode} onChange={(e) => setForm((p) => ({ ...p, renewalMode: e.target.value }))}>
                  {RENEWAL_MODES.map((m) => (
                    <option key={m} value={m}>
                      {label(m)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Amount (₹)">
                <Input value={form.amount} onChange={(e) => setForm((p) => ({ ...p, amount: e.target.value }))} inputMode="decimal" />
              </Field>
              <Field label="Start date">
                <Input type="date" value={form.startDate} onChange={(e) => setForm((p) => ({ ...p, startDate: e.target.value }))} />
              </Field>
              <Field label="End date" hint="Left blank: derived from the renewal mode">
                <Input type="date" value={form.endDate} onChange={(e) => setForm((p) => ({ ...p, endDate: e.target.value }))} />
              </Field>
            </div>

            <div className="grid grid--3">
              <Field label="Max units">
                <Input type="number" value={form.maxUnits} onChange={(e) => setForm((p) => ({ ...p, maxUnits: e.target.value }))} />
              </Field>
              <Field label="Max admins">
                <Input type="number" value={form.maxAdmins} onChange={(e) => setForm((p) => ({ ...p, maxAdmins: e.target.value }))} />
              </Field>
              <Field label="Max gates">
                <Input type="number" value={form.maxGates} onChange={(e) => setForm((p) => ({ ...p, maxGates: e.target.value }))} />
              </Field>
              <Field label="SMS credits">
                <Input type="number" value={form.smsCredits} onChange={(e) => setForm((p) => ({ ...p, smsCredits: e.target.value }))} />
              </Field>
              <Field label="Storage (MB)">
                <Input type="number" value={form.storageMb} onChange={(e) => setForm((p) => ({ ...p, storageMb: e.target.value }))} />
              </Field>
            </div>

            <div className="row row--wrap" style={{ gap: 16 }}>
              {(
                [
                  ['whatsappEnabled', 'WhatsApp notifications'],
                  ['paymentGatewayEnabled', 'Payment gateway'],
                  ['biometricEnabled', 'Biometric attendance'],
                  ['autoRenew', 'Auto-renew'],
                ] as const
              ).map(([key, text]) => (
                <label key={key} className="row" style={{ gap: 6 }}>
                  <input type="checkbox" checked={form[key]} onChange={(e) => setForm((p) => ({ ...p, [key]: e.target.checked }))} />
                  <span className="small">{text}</span>
                </label>
              ))}
            </div>

            <Field
              label="Modules"
              hint={`Leave all unchecked to let the ${label(tierDefaultModules)} tier's default set apply`}
            >
              <div className="grid grid--3" style={{ gap: 6 }}>
                {MODULE_KEYS.map((key) => (
                  <label key={key} className="row" style={{ gap: 6 }}>
                    <input
                      type="checkbox"
                      checked={form.modules.includes(key)}
                      onChange={(e) =>
                        setForm((p) => ({
                          ...p,
                          modules: e.target.checked ? [...p.modules, key] : p.modules.filter((m) => m !== key),
                        }))
                      }
                    />
                    <span className="small">{label(key)}</span>
                  </label>
                ))}
              </div>
            </Field>

            <div className="row">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setForm((p) => ({ ...p, modules: Array.from(new Set([...p.modules, ...(currentModules as string[])])) }))}
              >
                Keep current modules
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setForm((p) => ({ ...p, modules: [] }))}>
                Use the tier default set
              </Button>
            </div>

            {modulesChanged ? (
              <Alert tone="warning">
                You are pinning an explicit module list, which overrides the tier's default set.
                Clear every module to go back to deriving it from the plan.
              </Alert>
            ) : null}

            <div className="row">
              <Button type="submit" variant="primary" busy={busy}>
                Save subscription
              </Button>
            </div>
          </form>
        )}
      </Card>
    </div>
  );
}

/* ---------------------------------- admins ---------------------------------- */

function AdminsTab({ id, canInvite }: { id: string; canInvite: boolean }) {
  const toast = useToast();
  const admins = useResource<{ items: SocietyAdmin[] }>(`/platform/societies/${id}/admins`);
  const [inviting, setInviting] = useState(false);

  return (
    <div className="stack">
      <Card
        title="Administrators"
        subtitle="Accounts that can sign in to this society's console"
        actions={
          canInvite ? (
            <Button size="sm" variant="primary" onClick={() => setInviting(true)}>
              Invite an administrator
            </Button>
          ) : undefined
        }
        flush
      >
        {admins.loading ? (
          <Loading />
        ) : admins.error ? (
          <ErrorAlert error={admins.error} />
        ) : (
          <DataTable
            rows={admins.data?.items ?? []}
            rowKey={(a) => a.id}
            empty={<EmptyState title="No administrators" hint="Nobody can sign in to this society's console yet." />}
            columns={[
              { key: 'name', header: 'Name', render: (a) => <b>{a.fullName}</b> },
              { key: 'email', header: 'Email', render: (a) => a.email ?? <span className="faint">—</span> },
              { key: 'phone', header: 'Phone', render: (a) => a.phone ?? <span className="faint">—</span> },
              { key: 'roles', header: 'Roles', render: (a) => <span className="small">{(a.roles ?? []).map((r) => label(r)).join(', ')}</span> },
              {
                key: 'status',
                header: 'Status',
                render: (a) => (
                  <span className="row" style={{ gap: 6 }}>
                    <Pill tone={a.status === 'ACTIVE' ? 'success' : 'warning'}>{label(a.status)}</Pill>
                    {a.mustChangePassword ? <Pill tone="info">Must change password</Pill> : null}
                  </span>
                ),
              },
              { key: 'login', header: 'Last sign-in', render: (a) => <span className="small">{a.lastLoginAt ? dateTime(a.lastLoginAt) : 'Never'}</span> },
            ]}
          />
        )}
      </Card>

      {inviting ? (
        <InviteAdminForm
          id={id}
          onClose={() => setInviting(false)}
          onDone={(message) => {
            setInviting(false);
            toast.success(message);
            admins.reload();
          }}
        />
      ) : null}
    </div>
  );
}

function InviteAdminForm({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: (message: string) => void }) {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [roles, setRoles] = useState<string[]>(['SOCIETY_ADMIN']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { fullName: fullName.trim(), roles };
      if (email.trim()) body.email = email.trim();
      if (phone.trim()) body.phone = phone.trim();
      if (password) body.password = password;
      await api.post(`/platform/societies/${id}/admins`, body);
      onDone(`${fullName.trim()} can now sign in to this society's console`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const hasIdentifier = Boolean(email.trim() || phone.trim());

  return (
    <Modal
      title="Invite an administrator"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={submit} disabled={fullName.trim().length < 2 || roles.length === 0 || !hasIdentifier || !password}>
            Create login
          </Button>
        </>
      }
    >
      {error ? <ErrorAlert error={error} /> : null}
      <form onSubmit={submit} className="stack">
        <Alert tone="info">
          The account is created in <b>this society's own database</b>, so it cannot sign in anywhere
          else. The plan's maximum-administrator limit is enforced — the request fails rather than
          quietly exceeding it.
        </Alert>
        <Field label="Full name" required>
          <Input value={fullName} onChange={(e) => setFullName(e.target.value)} autoFocus required />
        </Field>
        <div className="grid grid--2">
          <Field label="Email" hint="Either an email or a phone is required to sign in">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label="Phone">
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91…" />
          </Field>
        </div>
        <Field
          label="Temporary password"
          hint="At least 8 characters with a letter and a number"
          error={!password ? 'Required: the server stores no password hash and returns none, so a blank password leaves an account nobody can sign in to' : undefined}
        >
          <Input value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Set one now — it cannot be recovered later" />
        </Field>
        <Field label="Roles" required>
          <div className="row row--wrap" style={{ gap: 10 }}>
            {ADMIN_ROLES.map((role) => (
              <label key={role} className="row" style={{ gap: 6 }}>
                <input
                  type="checkbox"
                  checked={roles.includes(role)}
                  onChange={(e) => setRoles((prev) => (e.target.checked ? [...prev, role] : prev.filter((r) => r !== role)))}
                />
                <span className="small">{label(role)}</span>
              </label>
            ))}
          </div>
        </Field>
        {!hasIdentifier ? <Alert tone="warning">Add an email or a phone number, otherwise nobody can sign in as this administrator.</Alert> : null}
      </form>
    </Modal>
  );
}

/* ----------------------------------- audit ---------------------------------- */

function AuditTab({ id }: { id: string }) {
  const [page, setPage] = useState(1);
  const limit = 25;
  const logs = useList<PlatformAuditLog>(
    `/platform/societies/${id}/audit-logs`,
    { page, limit, sort: 'createdAt', dir: 'desc' },
    [page],
  );
  const [detail, setDetail] = useState<PlatformAuditLog | null>(null);

  return (
    <Card title="Audit trail" subtitle="Every platform action against this society, newest first" flush>
      {logs.error ? <ErrorAlert error={logs.error} /> : null}
      {logs.loading ? (
        <Loading />
      ) : (
        <DataTable
          rows={logs.page.items}
          rowKey={(l) => l._id}
          onRowClick={setDetail}
          empty={<EmptyState title="No audit entries" hint="Nothing has been recorded against this society yet." />}
          columns={[
            { key: 'when', header: 'When', render: (l) => <span className="small nowrap">{dateTime(l.createdAt)}</span> },
            { key: 'action', header: 'Action', render: (l) => <code className="small">{l.action}</code> },
            { key: 'actor', header: 'Actor', render: (l) => <span className="small">{l.actorName ?? l.actorId ?? '—'}{l.actorType ? ` (${label(l.actorType)})` : ''}</span> },
            { key: 'module', header: 'Module', render: (l) => label(l.module ?? '—') },
            {
              key: 'changes',
              header: 'Changed',
              render: (l) => <span className="faint small">{(l.changedFields ?? []).join(', ') || '—'}</span>,
            },
            {
              key: 'severity',
              header: 'Severity',
              render: (l) => (
                <Pill tone={l.severity === 'CRITICAL' ? 'danger' : l.severity === 'WARNING' ? 'warning' : undefined}>{label(l.severity ?? 'INFO')}</Pill>
              ),
            },
            { key: 'status', header: 'Result', render: (l) => <Pill tone={l.status === 'SUCCESS' ? 'success' : 'danger'}>{label(l.status ?? 'SUCCESS')}</Pill> },
          ]}
        />
      )}
      <div className="card__foot">
        <Pagination page={page} limit={limit} total={logs.page.total} onPage={setPage} />
      </div>

      {detail ? (
        <Modal title={detail.action} onClose={() => setDetail(null)} wide footer={<Button onClick={() => setDetail(null)}>Close</Button>}>
          <KeyValue
            items={[
              ['When', dateTime(detail.createdAt)],
              ['Actor', `${detail.actorName ?? '—'} (${label(detail.actorType ?? '—')})`],
              ['Module', label(detail.module ?? '—')],
              ['Record', detail.recordId ? `${label(detail.recordType ?? 'record')} ${detail.recordId}` : '—'],
              ['Severity', label(detail.severity ?? 'INFO')],
              ['Result', label(detail.status ?? 'SUCCESS')],
              ['Request id', detail.requestId ?? '—'],
              ['Platform', detail.platform ?? '—'],
            ]}
          />
          {detail.errorMessage ? <Alert tone="danger">{detail.errorMessage}</Alert> : null}
          {detail.changedFields?.length ? (
            <Card title="Changed fields">
              <div className="row row--wrap" style={{ gap: 6 }}>
                {detail.changedFields.map((f) => (
                  <Pill key={f}>{f}</Pill>
                ))}
              </div>
            </Card>
          ) : null}
          <div className="grid grid--2">
            <Card title="Before">
              <pre className="small" style={{ maxHeight: 320, overflow: 'auto', margin: 0 }}>
                {JSON.stringify(detail.oldValue ?? {}, null, 2)}
              </pre>
            </Card>
            <Card title="After">
              <pre className="small" style={{ maxHeight: 320, overflow: 'auto', margin: 0 }}>
                {JSON.stringify(detail.newValue ?? {}, null, 2)}
              </pre>
            </Card>
          </div>
        </Modal>
      ) : null}
    </Card>
  );
}

/* ---------------------------------- status ---------------------------------- */

function StatusForm({ id, current, onClose, onDone }: { id: string; current: string; onClose: () => void; onDone: (message: string) => void }) {
  const [status, setStatus] = useState(current === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const suspending = status === 'SUSPENDED' || status === 'INACTIVE' || status === 'ARCHIVED';

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post(`/platform/societies/${id}/status`, {
        status,
        reason: reason.trim() || undefined,
      });
      onDone(`Society marked ${label(status).toLowerCase()}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Change society status"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={suspending ? 'danger' : 'primary'} busy={busy} onClick={submit} disabled={suspending && !reason.trim()}>
            Mark {label(status).toLowerCase()}
          </Button>
        </>
      }
    >
      {error ? <ErrorAlert error={error} /> : null}
      <form onSubmit={submit} className="stack">
        {suspending ? (
          <Alert tone="danger">
            This takes effect immediately: every request from this society's residents, guards and
            administrators will be rejected until it is reinstated. A reason is required, and it is
            written to the platform audit trail.
          </Alert>
        ) : (
          <Alert tone="info">Reinstating this society lets its users sign in again immediately.</Alert>
        )}
        <Field label="New status" required>
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            {SOCIETY_STATUSES.map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Reason" required={suspending} hint="Recorded in the audit trail">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder={suspending ? 'Non-payment of the subscription' : 'Payment received'} />
        </Field>
      </form>
    </Modal>
  );
}
