import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, tokenStore, onUnauthorized, ApiError } from './api.ts';
import type { LoginResult, SendOtpResult, WhoAmI } from './types.ts';

/**
 * Session state for the society console.
 *
 * The token and the society id live in localStorage so a refresh keeps you signed in. The
 * `x-society-id` header is attached by the API client from this store — never from a URL or a
 * form field, because the server verifies it against the token and rejects a mismatch.
 */

type Status = 'loading' | 'anonymous' | 'ready';

interface OtpChallenge {
  requestId: string;
  maskedTarget: string;
  otpLength: number;
  resendCooldownSeconds: number;
  expiresAt: string;
  /** Present only when the backend runs with EXPOSE_DEV_OTP=true. */
  devOtp?: string;
}

interface SessionValue {
  status: Status;
  who: WhoAmI | null;
  error: string | null;
  login: (identifier: string, password: string) => Promise<LoginResult>;
  sendOtp: (phone: string) => Promise<OtpChallenge>;
  verifyOtp: (phone: string, code: string) => Promise<LoginResult>;
  selectSociety: (societyId: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<WhoAmI | null>;
  can: (permission: string) => boolean;
  canAny: (...permissions: string[]) => boolean;
  hasModule: (moduleKey: string) => boolean;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>(tokenStore.token ? 'loading' : 'anonymous');
  const [who, setWho] = useState<WhoAmI | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadWhoami = useCallback(async (): Promise<WhoAmI | null> => {
    if (!tokenStore.token) {
      setWho(null);
      setStatus('anonymous');
      return null;
    }
    try {
      const me = await api.get<WhoAmI>('/whoami');
      // Trust the server for the active society: it is what the token was issued for.
      if (me?.society?.id) tokenStore.setSociety(me.society.id);
      setWho(me);
      setStatus('ready');
      setError(null);
      return me;
    } catch (err) {
      tokenStore.clear();
      setWho(null);
      setStatus('anonymous');
      setError(err instanceof ApiError ? err.message : 'Could not restore your session');
      return null;
    }
  }, []);

  useEffect(() => {
    void loadWhoami();
    return onUnauthorized(() => {
      setWho(null);
      setStatus('anonymous');
    });
  }, [loadWhoami]);

  const applyLogin = useCallback(async (result: LoginResult) => {
    tokenStore.save(result.accessToken);
    const preferred =
      result.user?.preferredSocietyId ?? result.user?.memberships?.[0]?.societyId ?? null;
    if (preferred) tokenStore.setSociety(preferred);
    await loadWhoami();
    return result;
  }, [loadWhoami]);

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
    // The envelope is needed because the development OTP arrives in `meta`, not `data`.
    const envelope = await api.envelope.post<SendOtpResult>('/auth/send-otp', {
      phone,
      channel: 'CONSOLE',
      purpose: 'LOGIN',
    });
    const data = envelope.data;
    const devOtp = envelope.meta?.devOtp;
    return {
      requestId: data.requestId,
      maskedTarget: data.maskedTarget,
      otpLength: data.otpLength,
      resendCooldownSeconds: data.resendCooldownSeconds,
      expiresAt: data.expiresAt,
      ...(typeof devOtp === 'string' ? { devOtp } : {}),
    };
  }, []);

  const verifyOtp = useCallback(
    async (phone: string, code: string) => {
      setError(null);
      const result = await api.anonymous.post<LoginResult>('/auth/verify-otp', {
        phone,
        code,
        purpose: 'LOGIN',
      });
      return applyLogin(result);
    },
    [applyLogin],
  );

  const selectSociety = useCallback(
    async (societyId: string) => {
      await api.post('/auth/select-society', { societyId });
      tokenStore.setSociety(societyId);
      await loadWhoami();
    },
    [loadWhoami],
  );

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout', {});
    } catch {
      // A failed revoke must not trap the user in the console.
    } finally {
      tokenStore.clear();
      setWho(null);
      setStatus('anonymous');
    }
  }, []);

  const permissions = useMemo(() => new Set(who?.permissions ?? []), [who]);
  const modules = useMemo(() => new Set(who?.enabledModules ?? []), [who]);

  const value = useMemo<SessionValue>(
    () => ({
      status,
      who,
      error,
      login,
      sendOtp,
      verifyOtp,
      selectSociety,
      logout,
      refresh: loadWhoami,
      can: (permission: string) => permissions.has(permission),
      canAny: (...perms: string[]) => perms.some((p) => permissions.has(p)),
      hasModule: (moduleKey: string) => modules.has(moduleKey),
    }),
    [status, who, error, login, sendOtp, verifyOtp, selectSociety, logout, loadWhoami, permissions, modules],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}
