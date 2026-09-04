import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, onUnauthorized, tokenStore } from './api.ts';

/**
 * Platform session.
 *
 * Deliberately unlike the society console's: `GET /whoami` requires a tenant context and answers a
 * platform token with 403, so there is no identity endpoint to re-hydrate from. `POST
 * /auth/platform/login` returns the operator together with their resolved permission set, and that
 * is what gets persisted. On a hard refresh the stored operator is trusted for *rendering* only —
 * the token still gates every request, and a 401 anywhere clears the session and returns to login.
 */

export interface PlatformUser {
  id: string;
  email: string | null;
  phone: string | null;
  fullName: string;
  roles: string[];
  permissions: string[];
  avatarUrl?: string | null;
}

interface LoginResponse {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  expiresIn?: number;
  sessionId?: string;
  user: PlatformUser;
}

interface SessionValue {
  user: PlatformUser | null;
  /** Null until the stored session has been read, so the router does not flash the login page. */
  ready: boolean;
  login: (identifier: string, password: string) => Promise<PlatformUser>;
  logout: () => void;
  can: (permission: string) => boolean;
  canAny: (...permissions: string[]) => boolean;
  isSuperAdmin: boolean;
}

const STORAGE_KEY = 'colonize.super.user';

const SessionContext = createContext<SessionValue | null>(null);

function readStoredUser(): PlatformUser | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PlatformUser;
    return parsed && typeof parsed.id === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PlatformUser | null>(null);
  const [ready, setReady] = useState(false);

  // Only restore an operator if a token is actually present; a cleared token means signed out.
  useEffect(() => {
    setUser(tokenStore.token ? readStoredUser() : null);
    setReady(true);
  }, []);

  useEffect(
    () =>
      onUnauthorized(() => {
        localStorage.removeItem(STORAGE_KEY);
        setUser(null);
      }),
    [],
  );

  const login = useCallback(async (identifier: string, password: string): Promise<PlatformUser> => {
    const result = await api.anonymous.post<LoginResponse>('/auth/platform/login', { identifier, password });
    tokenStore.save(result.accessToken);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(result.user));
    setUser(result.user);
    return result.user;
  }, []);

  const logout = useCallback(() => {
    tokenStore.clear();
    localStorage.removeItem(STORAGE_KEY);
    setUser(null);
  }, []);

  const permissions = useMemo(() => new Set(user?.permissions ?? []), [user]);

  const value = useMemo<SessionValue>(
    () => ({
      user,
      ready,
      login,
      logout,
      can: (permission: string) => permissions.has(permission),
      canAny: (...wanted: string[]) => wanted.some((p) => permissions.has(p)),
      isSuperAdmin: (user?.roles ?? []).includes('SUPER_ADMIN'),
    }),
    [user, ready, login, logout, permissions],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}
