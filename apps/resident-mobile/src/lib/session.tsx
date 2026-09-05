/**
 * Session state for the resident app.
 *
 * The token and society id persist in secure storage so a cold start restores the
 * session. `x-society-id` is attached by the API client from this store — never from
 * user input, because the server verifies it against the token and rejects a mismatch.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { api, tokenStore, onUnauthorized, ApiError } from './api.ts';
import { loadApiBaseUrl } from './api.ts';
import type { LoginResult, OtpChallenge, WhoAmI } from './types.ts';

type Status = 'loading' | 'anonymous' | 'ready';

interface SessionValue {
  status: Status;
  who: WhoAmI | null;
  error: string | null;
  /** True until the persisted API base URL has been loaded (first render gate). */
  bootstrapped: boolean;
  login: (identifier: string, password: string) => Promise<LoginResult>;
  sendOtp: (phone: string) => Promise<OtpChallenge>;
  verifyOtp: (phone: string, code: string) => Promise<LoginResult>;
  selectSociety: (societyId: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<WhoAmI | null>;
  hasModule: (moduleKey: string) => boolean;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [bootstrapped, setBootstrapped] = useState(false);
  const [status, setStatus] = useState<Status>('loading');
  const [who, setWho] = useState<WhoAmI | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadWhoami = useCallback(async (): Promise<WhoAmI | null> => {
    const token = await tokenStore.token();
    if (!token) {
      setWho(null);
      setStatus('anonymous');
      return null;
    }
    try {
      const me = await api.get<WhoAmI>('/whoami');
      if (me?.society?.id) await tokenStore.setSociety(me.society.id);
      setWho(me);
      setStatus('ready');
      setError(null);
      return me;
    } catch (err) {
      await tokenStore.clear();
      setWho(null);
      setStatus('anonymous');
      setError(err instanceof ApiError ? err.message : 'Could not restore your session');
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await loadApiBaseUrl();
      if (cancelled) return;
      setBootstrapped(true);
      await loadWhoami();
    })();
    const off = onUnauthorized(() => {
      setWho(null);
      setStatus('anonymous');
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [loadWhoami]);

  const applyLogin = useCallback(
    async (result: LoginResult) => {
      await tokenStore.save(result.accessToken);
      const preferred = result.user?.preferredSocietyId ?? result.user?.memberships?.[0]?.societyId ?? null;
      if (preferred) await tokenStore.setSociety(preferred);
      await loadWhoami();
      return result;
    },
    [loadWhoami],
  );

  const login = useCallback(
    async (identifier: string, password: string) => {
      setError(null);
      const result = await api.anonymous.post<LoginResult>('/auth/login', { identifier, password });
      return applyLogin(result);
    },
    [applyLogin],
  );

  const sendOtp = useCallback(async (phone: string): Promise<OtpChallenge> => {
    setError(null);
    const envelope = await api.envelope.post<Record<string, unknown>>('/auth/send-otp', {
      phone,
      channel: 'CONSOLE',
      purpose: 'LOGIN',
    });
    const data = (envelope.data ?? {}) as Record<string, unknown>;
    const devOtp = envelope.meta?.devOtp;
    return {
      requestId: String(data.requestId ?? ''),
      channel: String(data.channel ?? 'CONSOLE'),
      maskedTarget: String(data.maskedTarget ?? phone),
      otpLength: Number(data.otpLength ?? 6),
      resendCooldownSeconds: Number(data.resendCooldownSeconds ?? 30),
      expiresAt: String(data.expiresAt ?? ''),
      ...(typeof devOtp === 'string' ? { devOtp } : {}),
    };
  }, []);

  const verifyOtp = useCallback(
    async (phone: string, code: string) => {
      setError(null);
      const result = await api.anonymous.post<LoginResult>('/auth/verify-otp', {
        phone,
        otp: code,
        purpose: 'LOGIN',
      });
      return applyLogin(result);
    },
    [applyLogin],
  );

  const selectSociety = useCallback(
    async (societyId: string) => {
      await api.post('/auth/select-society', { societyId });
      await tokenStore.setSociety(societyId);
      await loadWhoami();
    },
    [loadWhoami],
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout', {});
    } catch {
      // A failed revoke must not trap the user in the app.
    } finally {
      await tokenStore.clear();
      setWho(null);
      setStatus('anonymous');
    }
  }, []);

  const modules = useMemo(() => new Set(who?.enabledModules ?? []), [who]);

  const value = useMemo<SessionValue>(
    () => ({
      status,
      who,
      error,
      bootstrapped,
      login,
      sendOtp,
      verifyOtp,
      selectSociety,
      logout,
      refresh: loadWhoami,
      hasModule: (moduleKey: string) => modules.has(moduleKey),
    }),
    [status, who, error, bootstrapped, login, sendOtp, verifyOtp, selectSociety, logout, loadWhoami, modules],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}
