import { Link } from 'react-router-dom';
import { useResource } from '../lib/useResource.ts';
import { Alert, Button, Card, EmptyState, ErrorAlert, KeyValue, Loading, Pill } from '../components/ui.tsx';
import { label, money, number } from '../lib/format.ts';
import { useSession } from '../lib/session.tsx';
import type { PlatformOverview, Society } from '../lib/types.ts';

/**
 * Platform overview (§45, §79).
 *
 * `GET /platform/societies/stats/overview` is the only aggregate the control plane exposes, so the
 * dashboard is built from it plus the newest tenants. Monthly recurring revenue is summed from live
 * subscriptions, which is why a platform full of trials reads as zero rather than as missing data.
 */
export function DashboardPage() {
  const { can } = useSession();
  const overview = useResource<PlatformOverview>(can('dashboard:view') ? '/platform/societies/stats/overview' : null);
  const newest = useResource<{ items: Society[] }>('/platform/societies', { limit: 5, sortBy: 'createdAt', sortDir: 'desc' });

  if (!can('dashboard:view')) {
    return <Alert tone="warning">Your operator role cannot view platform statistics.</Alert>;
  }

  if (overview.loading && !overview.data) return <Loading />;
  if (overview.error) return <ErrorAlert error={overview.error} />;
  if (!overview.data) return <EmptyState title="No statistics" hint="The platform returned no overview." />;

  const stats = overview.data;
  // `number()` formats for display, so the thresholds compare against the raw values.
  const pendingCount = Number(stats.onboardingSocieties ?? 0);
  const suspendedCount = Number(stats.suspendedSocieties ?? 0);
  const pending = number(pendingCount);
  const suspended = number(suspendedCount);

  const tiles = [
    { label: 'Societies', value: number(stats.societies ?? 0), hint: `${number(stats.newThisMonth ?? 0)} created this month` },
    { label: 'Active', value: number(stats.activeSocieties ?? 0), hint: 'Serving residents and guards', tone: 'success' },
    { label: 'Onboarding', value: pending, hint: 'Not yet activated', tone: pendingCount > 0 ? 'warning' : undefined },
    { label: 'Suspended', value: suspended, hint: 'Sign-ins blocked', tone: suspendedCount > 0 ? 'danger' : undefined },
    { label: 'Units managed', value: number(stats.totalUnits ?? 0), hint: 'Across every tenant' },
    { label: 'Residents', value: number(stats.totalResidents ?? 0), hint: 'Across every tenant' },
    { label: 'Monthly recurring revenue', value: money(stats.monthlyRecurringRevenue ?? 0), hint: 'From active subscriptions', tone: 'success' },
  ];

  return (
    <div className="stack">
      {pendingCount > 0 ? (
        <Alert tone="warning">
          {pending} societ{pendingCount === 1 ? 'y is' : 'ies are'} mid-onboarding and cannot be used yet.
          Residents and guards are blocked from signing in until an operator activates them.{' '}
          <Link to="/societies?status=ONBOARDING">Review them</Link>.
        </Alert>
      ) : null}
      {suspendedCount > 0 ? (
        <Alert tone="danger">
          {suspended} societ{suspendedCount === 1 ? 'y is' : 'ies are'} suspended — every request from their
          users is being rejected.
        </Alert>
      ) : null}

      <div className="tiles">
        {tiles.map((tile) => (
          <div key={tile.label} className={`tile${tile.tone ? ` tile--${tile.tone}` : ''}`}>
            <div className="tile__label">{tile.label}</div>
            <div className="tile__value">{tile.value}</div>
            <div className="tile__hint">{tile.hint}</div>
          </div>
        ))}
      </div>

      <div className="grid grid--3">
        <Card title="By status">
          <Breakdown record={stats.byStatus} />
        </Card>
        <Card title="By plan">
          <Breakdown record={stats.byTier} />
        </Card>
        <Card title="By city">
          <Breakdown record={stats.byCity} />
        </Card>
      </div>

      <Card
        title="Newest societies"
        subtitle="Most recently created tenants"
        actions={
          <Link to="/societies">
            <Button size="sm" variant="ghost">
              View all
            </Button>
          </Link>
        }
      >
        {newest.loading ? (
          <Loading />
        ) : newest.error ? (
          <ErrorAlert error={newest.error} />
        ) : (newest.data?.items ?? []).length === 0 ? (
          <EmptyState title="No societies yet" hint="Onboard the first society to get started." />
        ) : (
          <div className="stack" style={{ gap: 8 }}>
            {(newest.data?.items ?? []).map((society) => (
              <Link key={society._id} to={`/societies/${society._id}`} className="row row--between" style={{ textDecoration: 'none', color: 'inherit' }}>
                <span>
                  <b>{society.name}</b>
                  <span className="faint small" style={{ display: 'block' }}>
                    {society.city ?? '—'}
                    {society.state ? `, ${society.state}` : ''} · {number(society.totalUnits ?? 0)} units ·{' '}
                    {number(society.totalResidents ?? 0)} residents
                  </span>
                </span>
                <span className="row" style={{ gap: 6 }}>
                  <Pill tone={society.tier === 'ENTERPRISE' ? 'brand' : undefined}>{label(society.tier ?? 'FREE')}</Pill>
                  <Pill tone={society.status === 'ACTIVE' ? 'success' : society.status === 'SUSPENDED' ? 'danger' : 'warning'}>
                    {label(society.status)}
                  </Pill>
                </span>
              </Link>
            ))}
          </div>
        )}
      </Card>

      <Card title="Platform posture">
        <KeyValue
          items={[
            ['Tenancy model', 'Database per society'],
            ['Isolation', 'A platform token names the society in the path; a tenant token can never reach these routes'],
            ['Entitlements', 'Enforced server-side on every request from the tenant subscription mirror'],
          ]}
        />
      </Card>
    </div>
  );
}

/** Small key/count breakdown, sorted largest first. */
function Breakdown({ record }: { record?: Record<string, number> }) {
  const rows = Object.entries(record ?? {})
    .map(([key, value]) => [label(key), Number(value ?? 0)] as [string, number])
    .sort((a, b) => b[1] - a[1]);
  if (rows.length === 0) return <p className="faint small">Nothing to show yet.</p>;
  const max = Math.max(...rows.map(([, value]) => value), 1);
  return (
    <div className="bars">
      {rows.map(([key, value]) => (
        <div key={key} className="bars__row">
          <span className="small nowrap" title={key}>
            {key}
          </span>
          <span className="bars__track">
            <span className="bars__fill" style={{ width: `${Math.max(3, (value / max) * 100)}%`, display: 'block' }} />
          </span>
          <b className="small nowrap right">{number(value)}</b>
        </div>
      ))}
    </div>
  );
}
