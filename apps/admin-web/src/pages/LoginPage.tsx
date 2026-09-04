import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSession } from '../lib/session.tsx';
import { ApiError } from '../lib/api.ts';
import { Button, ErrorAlert, Field, Input } from '../components/ui.tsx';

/**
 * Society console sign-in.
 *
 * Two real paths: password, and OTP over the console channel. When the backend runs with
 * EXPOSE_DEV_OTP=true the generated code is returned and offered as a one-click fill — that
 * affordance disappears entirely in production, where the code is only ever delivered by
 * SMS/WhatsApp/email.
 */
export function LoginPage() {
  const { login, sendOtp, verifyOtp, error: sessionError } = useSession();
  const navigate = useNavigate();

  const [mode, setMode] = useState<'password' | 'otp'>('password');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');

  const [phone, setPhone] = useState('');
  const [challenge, setChallenge] = useState<{ requestId: string; maskedTarget: string; devOtp?: string } | null>(null);
  const [code, setCode] = useState('');
  const [cooldown, setCooldown] = useState(0);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onPassword(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(identifier.trim(), password);
      navigate('/', { replace: true });
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  async function onSendOtp(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await sendOtp(phone.trim());
      setChallenge({ requestId: result.requestId, maskedTarget: result.maskedTarget, devOtp: result.devOtp });
      setCooldown(result.resendCooldownSeconds);
      const timer = setInterval(() => {
        setCooldown((c) => {
          if (c <= 1) {
            clearInterval(timer);
            return 0;
          }
          return c - 1;
        });
      }, 1000);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  async function onVerifyOtp(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await verifyOtp(phone.trim(), code.trim());
      navigate('/', { replace: true });
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  const shownError = error ?? sessionError;

  return (
    <div className="login">
      <div className="login__card">
        <div className="login__brand">
          <h1>Colonize</h1>
          <p>Society Management Console</p>
        </div>

        <div className="login__tabs">
          <button
            type="button"
            className={`login__tab${mode === 'password' ? ' login__tab--active' : ''}`}
            onClick={() => {
              setMode('password');
              setError(null);
            }}
          >
            Password
          </button>
          <button
            type="button"
            className={`login__tab${mode === 'otp' ? ' login__tab--active' : ''}`}
            onClick={() => {
              setMode('otp');
              setError(null);
            }}
          >
            OTP
          </button>
        </div>

        {shownError ? <ErrorAlert error={shownError} onDismiss={() => setError(null)} /> : null}

        {mode === 'password' ? (
          <form onSubmit={onPassword}>
            <Field label="Email or mobile number" required>
              <Input
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder="admin@greenvalley.local"
                autoComplete="username"
                autoFocus
                required
              />
            </Field>
            <Field label="Password" required>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
                required
              />
            </Field>
            <Button type="submit" variant="primary" className="btn--block" busy={busy}>
              Sign in
            </Button>
          </form>
        ) : challenge ? (
          <form onSubmit={onVerifyOtp}>
            <p className="small muted mb">
              A {6}-digit code was sent to <b>{challenge.maskedTarget}</b>.
            </p>
            <Field label="Enter the code" required>
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="123456"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={8}
                autoFocus
                required
              />
            </Field>
            {challenge.devOtp ? (
              <div className="alert alert--warning">
                Development mode: the code is <code>{challenge.devOtp}</code>.{' '}
                <button type="button" className="btn btn--sm" onClick={() => setCode(challenge.devOtp!)}>
                  Fill it in
                </button>
              </div>
            ) : null}
            <Button type="submit" variant="primary" className="btn--block" busy={busy}>
              Verify and sign in
            </Button>
            <Button
              type="button"
              className="btn--block"
              style={{ marginTop: 8 }}
              disabled={cooldown > 0}
              onClick={() => {
                setChallenge(null);
                setCode('');
              }}
            >
              Use a different number
            </Button>
          </form>
        ) : (
          <form onSubmit={onSendOtp}>
            <Field label="Registered mobile number" required hint="Include the country code if it is not +91.">
              <Input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+919800000101"
                autoComplete="tel"
                inputMode="tel"
                autoFocus
                required
              />
            </Field>
            <Button type="submit" variant="primary" className="btn--block" busy={busy}>
              Send code
            </Button>
          </form>
        )}

        <div className="login__hint">
          <b>Seeded demo society — Green Valley Residency</b>
          <br />
          Admin <code>admin@greenvalley.local</code> / <code>GreenValley@1</code>
          <br />
          Resident <code>+919800000101</code> · Guard <code>+919800000901</code> / <code>Guard@1234</code>
          <br />
          <span className="faint">
            OTP codes are rate-limited per number: use a different seeded number rather than retrying one.
          </span>
        </div>
      </div>
    </div>
  );
}

function messageOf(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.fieldErrors.length > 0) return `${err.message} — ${err.fieldErrors[0]!.message}`;
    return err.message;
  }
  return err instanceof Error ? err.message : 'Sign-in failed';
}
