/**
 * Session state for the security app.
 *
 * Token + society persist in secure storage. The active gate posting (set on shift
 * start) is persisted too, so the console remembers which gate the guard is manning.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { api, tokenStore, onUnauthorized, ApiError, loadApiBaseUrl } from './api.ts';
import type { LoginResult, WhoAmI } from './types.ts';

type Status = 'loading' | 'anonymous' | 'ready';

interface SessionValue {
  status: Status;
  who: WhoAmI | null;
  error: string | null;
  bootstrapped: boolean;
  /** The gate this guard is posted at for the current shift, if any. */
  gateId: string | null;
  login: (identifier: string, password: string) => Promise<LoginResult>;
  startShift: (gateId: string) => Promise<void>;
  endShift: () => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<WhoAmI | null>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [bootstrapped, setBootstrapped] = useState(false);
  const [status, setStatus] = useState<Status>('loading');
  const [who, setWho] = useState<WhoAmI | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gateId, setGateId] = useState<string | null>(null);

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
      const savedGate = await tokenStore.gateId();
      setGateId(savedGate);
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

  const startShift = useCallback(
    async (gid: string) => {
      await api.post('/guards/shift/login', { gateId: gid });
      await tokenStore.setGate(gid);
      setGateId(gid);
    },
    [],
  );

  const endShift = useCallback(async () => {
    try {
      await api.post('/guards/shift/logout', {});
    } catch {
      // The guard can still leave; the shift log row stays for reconciliation.
    } finally {
      await tokenStore.setGate(null);
      setGateId(null);
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post('/auth/logout', {});
    } catch {
      // A failed revoke must not trap the guard in the app.
    } finally {
      await tokenStore.clear();
      setGateId(null);
      setWho(null);
      setStatus('anonymous');
    }
  }, []);

  const value = useMemo<SessionValue>(
    () => ({
      status,
      who,
      error,
      bootstrapped,
      gateId,
      login,
      startShift,
      endShift,
      logout,
      refresh: loadWhoami,
    }),
    [status, who, error, bootstrapped, gateId, login, startShift, endShift, logout, loadWhoami],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}
