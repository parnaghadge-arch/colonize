import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, useState, type ReactNode } from 'react';
import { useSession } from '../lib/session.tsx';
import { Button, ErrorAlert, Modal } from './ui.tsx';
import { LinkHomeForm } from './LinkHomeForm.tsx';

/**
 * Console chrome.
 *
 * The navigation is derived from the session: an entry appears only when the society's plan
 * includes its module *and* the signed-in user holds a permission for it. That way there are no
 * buttons in this app that lead to a 403 — a rule the spec calls out explicitly.
 */

interface NavItem {
  to: string;
  label: string;
  glyph: string;
  module?: string;
  permission?: string;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV: NavGroup[] = [
  {
    label: 'Overview',
    items: [{ to: '/', label: 'Dashboard', glyph: '▦' }],
  },
  {
    label: 'Community',
    items: [
      { to: '/structure', label: 'Structure', glyph: '⌂', permission: 'unit:view' },
      { to: '/residents', label: 'Residents', glyph: '☺', module: 'residents', permission: 'resident:view' },
      { to: '/visitors', label: 'Visitors', glyph: '⇄', module: 'visitorManagement', permission: 'visitor:view' },
      { to: '/gate', label: 'Gate console', glyph: '⛨', module: 'visitorManagement', permission: 'visitor:scan' },
    ],
  },
  {
    label: 'Services',
    items: [
      { to: '/complaints', label: 'Complaints', glyph: '✎', module: 'complaints', permission: 'complaint:view' },
      { to: '/work-orders', label: 'Work orders', glyph: '⚒', module: 'workOrders', permission: 'workorder:view' },
      { to: '/vendors', label: 'Vendors', glyph: '⚖', module: 'vendorManagement', permission: 'vendor:view' },
      { to: '/staff', label: 'Staff', glyph: '⚇', module: 'staffAttendance', permission: 'staff:view' },
    ],
  },
  {
    label: 'Money',
    items: [
      { to: '/bills', label: 'Bills', glyph: '₹', module: 'maintenanceBilling', permission: 'bill:view' },
      { to: '/payments', label: 'Payments', glyph: '◈', module: 'payments', permission: 'payment:view' },
      { to: '/accounting', label: 'Accounting', glyph: 'Σ', module: 'accounting', permission: 'accounting:view' },
    ],
  },
  {
    label: 'Facilities',
    items: [
      { to: '/amenities', label: 'Amenities', glyph: '◉', module: 'amenities', permission: 'amenity:view' },
      { to: '/bookings', label: 'Bookings', glyph: '▤', module: 'amenities', permission: 'amenitybooking:view' },
    ],
  },
  {
    label: 'Insights',
    items: [
      { to: '/reports', label: 'Reports', glyph: '◫', module: 'advancedReports', permission: 'report:view' },
      { to: '/settings', label: 'Settings', glyph: '⚙', permission: 'society:view' },
    ],
  },
];

const TITLES: Record<string, { title: string; subtitle: string }> = {
  '/': { title: 'Dashboard', subtitle: 'Your society at a glance' },
  '/structure': { title: 'Structure', subtitle: 'Buildings, wings, floors and units' },
  '/residents': { title: 'Residents', subtitle: 'Owners, tenants and family members' },
  '/visitors': { title: 'Visitors', subtitle: 'Pre-approvals, passes and the entry log' },
  '/gate': { title: 'Gate console', subtitle: 'Scan a pass and decide the queue' },
  '/complaints': { title: 'Complaints', subtitle: 'Raise, assign, resolve and verify' },
  '/work-orders': { title: 'Work orders', subtitle: 'Work assigned to vendors and staff' },
  '/vendors': { title: 'Vendors', subtitle: 'Approved service providers' },
  '/staff': { title: 'Staff', subtitle: 'Society employees and guards' },
  '/bills': { title: 'Maintenance bills', subtitle: 'Generate, send and collect' },
  '/payments': { title: 'Payments', subtitle: 'Collections, refunds and receipts' },
  '/accounting': { title: 'Accounting', subtitle: 'Ledgers, journal entries and statements' },
  '/amenities': { title: 'Amenities', subtitle: 'Facilities residents can book' },
  '/bookings': { title: 'Amenity bookings', subtitle: 'Approve, check in and cancel' },
  '/reports': { title: 'Reports', subtitle: 'Operational and financial reporting' },
  '/settings': { title: 'Settings', subtitle: 'Society profile and subscription' },
};

export function AppShell() {
  const { who, logout, hasModule, can, setActingClient } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const [loggingOut, setLoggingOut] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<unknown>(null);
  const [linking, setLinking] = useState(false);
  const memberMode = who?.clientHints?.actingAs === 'resident' && Boolean(who?.clientHints?.canManageSociety);
  const canManage = Boolean(who?.clientHints?.canManageSociety);

  useEffect(() => {
    if (memberMode && location.pathname !== '/my-home') navigate('/my-home', { replace: true });
  }, [memberMode, location.pathname, navigate]);

  const groups = NAV.map((group) => ({
    ...group,
    items: group.items.filter((item) => {
      if (item.module && !hasModule(item.module)) return false;
      if (item.permission && !can(item.permission)) return false;
      return true;
    }),
  })).filter((group) => group.items.length > 0);

  const meta = memberMode
    ? { title: 'My home', subtitle: 'You are acting as a resident of your own flat' }
    : TITLES[location.pathname] ?? { title: 'Colonize', subtitle: '' };

  async function actAsResident() {
    setSwitchError(null);
    if (!who?.clientHints?.canActAsResident) {
      setLinking(true);
      return;
    }
    setSwitching(true);
    try {
      await setActingClient('resident');
      navigate('/my-home');
    } catch (err) {
      setSwitchError(err);
      setLinking(true);
    } finally {
      setSwitching(false);
    }
  }

  async function manageSociety() {
    setSwitching(true);
    setSwitchError(null);
    try {
      await setActingClient('console');
      navigate('/');
    } catch (err) {
      setSwitchError(err);
    } finally {
      setSwitching(false);
    }
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar__brand">
          <strong>Colonize</strong>
          <span>Society Console</span>
        </div>

        <div className="sidebar__society">
          <div className="sidebar__society-text">
            <b>{who?.society?.name ?? '—'}</b>
            <span>{who?.society?.timezone ?? ''}</span>
          </div>
          {who?.society?.logoUrl ? (
            <img className="sidebar__logo" src={who.society.logoUrl} alt="" />
          ) : null}
        </div>

        <nav className="sidebar__nav">
          {memberMode ? (
            <div className="sidebar__group">
              <span>My home</span>
              <NavLink to="/my-home" className={({ isActive }) => `sidebar__link${isActive ? ' sidebar__link--active' : ''}`}>
                <span className="glyph" aria-hidden>⌂</span>
                My flat
              </NavLink>
            </div>
          ) : groups.map((group) => (
            <div className="sidebar__group" key={group.label}>
              <span>{group.label}</span>
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === '/'}
                  className={({ isActive }) => `sidebar__link${isActive ? ' sidebar__link--active' : ''}`}
                >
                  <span className="glyph" aria-hidden>
                    {item.glyph}
                  </span>
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar__footer">
          <div className="sidebar__user">{who?.user?.fullName ?? '—'}</div>
          <div className="sidebar__roles">{(who?.user?.roles ?? []).join(', ')}</div>
          <Button
            size="sm"
            variant="ghost"
            className="btn--block"
            busy={loggingOut}
            onClick={async () => {
              setLoggingOut(true);
              await logout();
            }}
          >
            Sign out
          </Button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="topbar__title">
            <h1>{meta.title}</h1>
            {meta.subtitle ? <p>{meta.subtitle}</p> : null}
          </div>
          <div className="topbar__actions">
            {canManage ? (
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                <Button size="sm" variant={memberMode ? 'default' : 'primary'} busy={switching} onClick={() => void manageSociety()}>
                  Manage society
                </Button>
                <Button size="sm" variant={memberMode ? 'primary' : 'default'} busy={switching} onClick={() => void actAsResident()}>
                  My home
                </Button>
              </div>
            ) : null}
            <PlanBadge />
            <Button
              size="sm"
              variant="ghost"
              busy={loggingOut}
              onClick={async () => {
                setLoggingOut(true);
                await logout();
              }}
            >
              Sign out
            </Button>
          </div>
        </header>
        <main className="content">
          {switchError && !linking ? <ErrorAlert error={switchError} /> : null}
          <Outlet />
        </main>
        {linking ? (
          <Modal title="Link your flat" onClose={() => setLinking(false)}>
            <LinkHomeForm
              onLinked={async () => {
                setLinking(false);
                setSwitching(true);
                try {
                  await setActingClient('resident');
                  navigate('/my-home');
                } catch (err) {
                  setSwitchError(err);
                } finally {
                  setSwitching(false);
                }
              }}
            />
          </Modal>
        ) : null}
      </div>
    </div>
  );
}

function PlanBadge(): ReactNode {
  const { who } = useSession();
  const count = who?.enabledModules?.length ?? 0;
  return (
    <span className="pill pill--brand" title="Modules enabled by this society's subscription plan">
      {count} modules enabled
    </span>
  );
}
