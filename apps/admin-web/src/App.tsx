import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppShell } from './components/AppShell.tsx';
import { Loading } from './components/ui.tsx';
import { useSession } from './lib/session.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { DashboardPage } from './pages/DashboardPage.tsx';
import { StructurePage } from './pages/StructurePage.tsx';
import { ResidentsPage } from './pages/ResidentsPage.tsx';
import { VisitorsPage } from './pages/VisitorsPage.tsx';
import { GateConsolePage } from './pages/GateConsolePage.tsx';
import { ComplaintsPage } from './pages/ComplaintsPage.tsx';
import { WorkOrdersPage } from './pages/WorkOrdersPage.tsx';
import { VendorsPage } from './pages/VendorsPage.tsx';
import { StaffPage } from './pages/StaffPage.tsx';
import { BillsPage } from './pages/BillsPage.tsx';
import { PaymentsPage } from './pages/PaymentsPage.tsx';
import { AccountingPage } from './pages/AccountingPage.tsx';
import { AmenitiesPage } from './pages/AmenitiesPage.tsx';
import { BookingsPage } from './pages/BookingsPage.tsx';
import { ReportsPage } from './pages/ReportsPage.tsx';
import { SettingsPage } from './pages/SettingsPage.tsx';

/** Route tree. Everything below `/` requires an authenticated tenant session. */
export function App() {
  const { status } = useSession();
  const location = useLocation();

  if (status === 'loading') {
    return (
      <div className="login">
        <div className="login__card">
          <Loading label="Restoring your session…" />
        </div>
      </div>
    );
  }

  if (status === 'anonymous') {
    return (
      <Routes>
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<Navigate to={location.state?.from ?? '/'} replace />} />
      <Route element={<AppShell />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/structure" element={<StructurePage />} />
        <Route path="/residents" element={<ResidentsPage />} />
        <Route path="/visitors" element={<VisitorsPage />} />
        <Route path="/gate" element={<GateConsolePage />} />
        <Route path="/complaints" element={<ComplaintsPage />} />
        <Route path="/work-orders" element={<WorkOrdersPage />} />
        <Route path="/vendors" element={<VendorsPage />} />
        <Route path="/staff" element={<StaffPage />} />
        <Route path="/bills" element={<BillsPage />} />
        <Route path="/payments" element={<PaymentsPage />} />
        <Route path="/accounting" element={<AccountingPage />} />
        <Route path="/amenities" element={<AmenitiesPage />} />
        <Route path="/bookings" element={<BookingsPage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

function NotFound() {
  return (
    <div className="card">
      <div className="empty">
        <strong>Page not found</strong>
        <p className="small">That route does not exist in the society console.</p>
      </div>
    </div>
  );
}
