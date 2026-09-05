/**
 * API client for the Colonize Resident App.
 *
 * Mirrors the web console's client: every call goes through `request()`, which
 *   • unwraps the standard `{ success, data, message, meta }` envelope
 *   • turns a failure envelope into a typed `ApiError` carrying `code` and field errors
 *   • attaches the bearer token and the `x-society-id` tenant header
 *
 * Base URL resolution (React Native cannot use a relative URL to reach another service):
 *   1. a user-set override persisted in secure storage (Settings → "API server")
 *   2. `EXPO_PUBLIC_API_URL` from the app's `.env` (inlined at bundle time)
 *   3. a sensible per-platform default: localhost for web / iOS simulator,
 *      10.0.2.2 (the Android emulator's alias for the host) for Android.
 *
 * A real device running Expo Go must use option 1 or 2 with the machine's LAN IP.
 */

import { Platform } from 'react-native';

import { secureStore } from './storage.ts';

const ENV_API_URL: string | undefined = process.env.EXPO_PUBLIC_API_URL;

function platformDefaultUrl(): string {
  if (Platform.OS === 'android') return 'http://10.0.2.2:4000/api';
  return 'http://localhost:4000/api';
}

let baseUrlOverride: string | null = null;

export function setApiBaseUrl(url: string | null): void {
  baseUrlOverride = url ? url.replace(/\/+$/, '') : null;
}

export async function loadApiBaseUrl(): Promise<string> {
  const saved = await secureStore.getItem('apiBaseUrl');
  setApiBaseUrl(saved ?? ENV_API_URL ?? null);
  return resolveBaseUrl();
}

export function resolveBaseUrl(): string {
  if (baseUrlOverride) return baseUrlOverride;
  if (ENV_API_URL) return ENV_API_URL.replace(/\/+$/, '');
  return platformDefaultUrl();
}

/* --------------------------------- errors ---------------------------------- */

export interface FieldError {
  field?: string;
  message: string;
  code?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fieldErrors: FieldError[];
  readonly details?: Record<string, unknown>;

  constructor(message: string, status: number, code: string, fieldErrors: FieldError[] = [], details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fieldErrors = fieldErrors;
    this.details = details;
  }

  forField(field: string): string | undefined {
    return this.fieldErrors.find((e) => e.field === field)?.message;
  }

  get isUnauthenticated(): boolean {
    return this.status === 401;
  }

  get isNetwork(): boolean {
    return this.status === 0;
  }
}

/* ------------------------------- token store ------------------------------- */

export const tokenStore = {
  async token(): Promise<string | null> {
    return secureStore.getItem('accessToken');
  },
  async societyId(): Promise<string | null> {
    return secureStore.getItem('societyId');
  },
  async save(accessToken: string, societyId?: string | null): Promise<void> {
    await secureStore.setItem('accessToken', accessToken);
    if (societyId) await secureStore.setItem('societyId', societyId);
  },
  async setSociety(societyId: string): Promise<void> {
    await secureStore.setItem('societyId', societyId);
  },
  async clear(): Promise<void> {
    await secureStore.deleteItem('accessToken');
    await secureStore.deleteItem('societyId');
  },
};

/* --------------------------------- request --------------------------------- */

export interface ApiMeta {
  page?: number;
  limit?: number;
  total?: number;
  totalPages?: number;
  requestId?: string;
  devOtp?: string;
  [key: string]: unknown;
}

export interface Envelope<T> {
  success: boolean;
  data: T;
  message?: string;
  meta?: ApiMeta;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  signal?: AbortSignal;
  /** Send without the bearer token (login, OTP). */
  anonymous?: boolean;
}

/** Subscribers are notified when a 401 means the session is over. */
const unauthorizedListeners = new Set<() => void>();
export function onUnauthorized(fn: () => void): () => void {
  unauthorizedListeners.add(fn);
  return () => {
    unauthorizedListeners.delete(fn);
  };
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = `${resolveBaseUrl()}${path.startsWith('/') ? path : `/${path}`}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

export async function requestEnvelope<T>(path: string, options: RequestOptions = {}): Promise<Envelope<T>> {
  const { method = 'GET', query, body, signal, anonymous = false } = options;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (!anonymous) {
    const [token, societyId] = await Promise.all([tokenStore.token(), tokenStore.societyId()]);
    if (token) headers.Authorization = `Bearer ${token}`;
    if (societyId) headers['x-society-id'] = societyId;
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(
      `Cannot reach the Colonize API at ${resolveBaseUrl()}. Check your connection and the API server setting.`,
      0,
      'NETWORK_ERROR',
    );
  }

  let payload: unknown = null;
  const text = await response.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const err = (payload ?? {}) as Partial<Envelope<unknown>> & {
      code?: string;
      errors?: FieldError[];
      details?: Record<string, unknown>;
    };
    const apiError = new ApiError(
      err.message ?? `Request failed with status ${response.status}`,
      response.status,
      err.code ?? 'UNKNOWN',
      err.errors ?? [],
      err.details,
    );
    if (response.status === 401 && !anonymous) {
      void tokenStore.clear();
      unauthorizedListeners.forEach((fn) => fn());
    }
    throw apiError;
  }

  const envelope = (payload ?? {}) as Envelope<T>;
  if (envelope && typeof envelope === 'object' && 'data' in envelope) return envelope;
  return { success: true, data: payload as T };
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const envelope = await requestEnvelope<T>(path, options);
  return envelope.data;
}

export const api = {
  get: <T>(path: string, query?: RequestOptions['query'], signal?: AbortSignal) =>
    request<T>(path, { method: 'GET', query, signal }),
  post: <T>(path: string, body?: unknown, query?: RequestOptions['query']) =>
    request<T>(path, { method: 'POST', body, query }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  del: <T>(path: string, body?: unknown) => request<T>(path, { method: 'DELETE', body }),
  /** Full envelope, for endpoints that return something in `meta` (the dev OTP). */
  envelope: {
    post: <T>(path: string, body?: unknown) =>
      requestEnvelope<T>(path, { method: 'POST', body, anonymous: true }),
  },
  anonymous: {
    post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body, anonymous: true }),
  },
};

/* ------------------------------ list envelopes ----------------------------- */

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages?: number;
}

/**
 * Normalise the several list shapes the API uses into one `Page`.
 * Collection endpoints return `{ data: { items }, meta: { page, limit, total, totalPages } }`.
 */
export function asPage<T>(raw: unknown, meta?: ApiMeta | null, fallbackLimit = 20): Page<T> {
  const source = (raw ?? {}) as Record<string, unknown>;
  // /bills/mine names its list `bills`; every other collection endpoint uses `items`.
  const candidate = Array.isArray(raw)
    ? raw
    : source.items ?? source.bills ?? source.rows ?? source.results ?? (Array.isArray(source.data) ? source.data : []);
  const items = (Array.isArray(candidate) ? candidate : []) as T[];

  const m = (meta ?? source) as Record<string, unknown>;
  const pick = (key: string, fallback: number): number => {
    const value = Number(m[key]);
    return Number.isFinite(value) ? value : fallback;
  };

  const total = pick('total', items.length);
  const limit = pick('limit', fallbackLimit);
  const page = pick('page', 1);
  const totalPages = m.totalPages !== undefined ? Number(m.totalPages) : limit > 0 ? Math.ceil(total / limit) : 1;

  return { items, total, page, limit, totalPages };
}

/** Fetch a paginated collection and return the rows together with their pagination. */
export async function fetchPage<T>(path: string, query?: RequestOptions['query'], signal?: AbortSignal): Promise<Page<T>> {
  const envelope = await requestEnvelope<unknown>(path, { method: 'GET', query, signal });
  return asPage<T>(envelope.data, envelope.meta);
}
