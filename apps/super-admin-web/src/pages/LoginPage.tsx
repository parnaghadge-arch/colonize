import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useSession } from '../lib/session.tsx';
import { ApiError } from '../lib/api.ts';
import { Button, ErrorAlert, Field, Input } from '../components/ui.tsx';

/**
 * Platform operator sign-in (§79).
 *
 * `POST /auth/platform/login` is the only entry point: a platform token is issued for operator
 * accounts and carries no society context, so the tenant OTP flow does not apply here and a society
 * administrator's credentials are rejected by `authenticatePlatform` rather than quietly downgraded.
 */
export function LoginPage() {
  const { login } = useSession();
  const navigate = useNavigate();
  const location = useLocation();

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(identifier.trim(), password);
      const from = (location.state as { from?: string } | null)?.from ?? '/';
      navigate(from, { replace: true });
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <div className="login__card">
        <div className="login__brand">
          <strong>Colonize</strong>
          <span>Platform Control Plane</span>
        </div>

        {error ? <ErrorAlert error={error} /> : null}

        <form onSubmit={onSubmit} className="stack">
          <Field label="Email" required>
            <Input
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              autoComplete="username"
              autoFocus
              placeholder="superadmin@colonize.local"
              required
            />
          </Field>
          <Field label="Password" required>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </Field>
          <Button type="submit" variant="primary" className="btn--block" busy={busy}>
            Sign in to the control plane
          </Button>
        </form>

        <div className="login__hint">
          <p className="small muted">
            Operator accounts only. Society administrators, residents and guards sign in to their own
            apps — their credentials are rejected here, and a platform token cannot be used against
            tenant routes.
          </p>
          {import.meta.env.DEV ? (
            <p className="small">
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                onClick={() => {
                  setIdentifier('superadmin@colonize.local');
                  setPassword('Colonize@Super1');
                }}
              >
                Fill the seeded super admin
              </button>
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function messageOf(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return 'Those credentials were not accepted for a platform operator account.';
    if (err.status === 403) return 'That account is not permitted to sign in to the control plane.';
    if (err.status === 429) return 'Too many attempts. Wait a moment and try again.';
    if (err.fieldErrors.length > 0) return `${err.message} — ${err.fieldErrors[0]?.message ?? ''}`;
    return err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong';
}
