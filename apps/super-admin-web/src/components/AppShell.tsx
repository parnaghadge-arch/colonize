import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useState } from 'react';
import { useSession } from '../lib/session.tsx';
import { Button } from './ui.tsx';

/**
 * Control-plane chrome (§79).
 *
 * Navigation is derived from the operator's resolved permissions rather than a static list, so a
 * role that cannot manage subscriptions never sees a subscription button that would 403.
 */

interface NavItem {
  to: string;
  label: string;
  glyph: string;
  /** Shown when the operator holds any of these. Omit for always-visible entries. */
  anyOf?: string[];
}

const NAV: NavItem[] = [
  { to: '/', label: 'Overview', glyph: '▦', anyOf: ['dashboard:view'] },
  { to: '/societies', label: 'Societies', glyph: '⌂', anyOf: ['society:view', 'society:manage'] },
];

export function AppShell() {
  const { user, logout, canAny, isSuperAdmin } = useSession();
  const location = useLocation();
  const [loggingOut, setLoggingOut] = useState(false);

  const items = NAV.filter((item) => !item.anyOf || canAny(...item.anyOf));

  // Titles are matched on a prefix so `/societies/:id` keeps the societies heading.
  const heading = location.pathname.startsWith('/societies/')
    ? { title: 'Society', subtitle: 'Provisioning, plan, administrators and audit trail' }
    : location.pathname.startsWith('/societies')
      ? { title: 'Societies', subtitle: 'Every tenant on the platform' }
      : { title: 'Platform overview', subtitle: 'Tenants, occupancy and recurring revenue' };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar__brand">
          <strong>Colonize</strong>
          <span>Control Plane</span>
        </div>

        <div className="sidebar__society">
          <b>Platform operator</b>
          <span>{isSuperAdmin ? 'Full administrative scope' : 'Restricted scope'}</span>
        </div>

        <nav className="sidebar__nav">
          <div className="sidebar__group">
            <span>SaaS</span>
            {items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  `sidebar__link${isActive || (item.to === '/societies' && location.pathname.startsWith('/societies')) ? ' sidebar__link--active' : ''}`
                }
              >
                <span className="glyph" aria-hidden>
                  {item.glyph}
                </span>
                {item.label}
              </NavLink>
            ))}
          </div>
        </nav>

        <div className="sidebar__footer">
          <div className="sidebar__user">{user?.fullName ?? '—'}</div>
          <div className="sidebar__roles">{(user?.roles ?? []).join(', ')}</div>
          <Button
            size="sm"
            variant="ghost"
            className="btn--block"
            busy={loggingOut}
            onClick={() => {
              setLoggingOut(true);
              logout();
            }}
          >
            Sign out
          </Button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="topbar__title">
            <h1>{heading.title}</h1>
            {heading.subtitle ? <p>{heading.subtitle}</p> : null}
          </div>
          <div className="topbar__actions">
            <span className="pill pill--brand" title="Platform tokens carry no society context">
              {user?.permissions.length ?? 0} permissions
            </span>
          </div>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
