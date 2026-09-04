import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppShell } from './components/AppShell.tsx';
import { Loading } from './components/ui.tsx';
import { useSession } from './lib/session.tsx';
import { LoginPage } from './pages/LoginPage.tsx';
import { DashboardPage } from './pages/DashboardPage.tsx';
import { SocietiesPage } from './pages/SocietiesPage.tsx';
import { SocietyDetailPage } from './pages/SocietyDetailPage.tsx';

/** Route tree. Everything below `/` requires an authenticated *platform* session. */
export function App() {
  const { ready, user } = useSession();
  const location = useLocation();

  if (!ready) {
    return (
      <div className="login">
        <div className="login__card">
          <Loading label="Restoring your session…" />
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <Routes>
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<Navigate to={(location.state as { from?: string } | null)?.from ?? '/'} replace />} />
      <Route element={<AppShell />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/societies" element={<SocietiesPage />} />
        <Route path="/societies/:id" element={<SocietyDetailPage />} />
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
        <p className="small">That route does not exist in the control plane.</p>
      </div>
    </div>
  );
}
