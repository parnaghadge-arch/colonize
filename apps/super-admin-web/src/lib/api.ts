/**
 * API client for the Super Admin Panel (§79).
 *
 * Every call goes through `request()`, which:
 *   • unwraps the standard `{ success, data, message, meta }` envelope
 *   • turns a failure envelope into a typed `ApiError` carrying `code` and field errors, so a
 *     form can show the server's own message instead of a generic "something went wrong"
 *   • attaches the bearer token
 *
 * Unlike the society console this client sends **no** `x-society-id` header: a platform token is
 * deliberately tenant-less, and the backend's `authenticatePlatform` rejects tenant scope outright.
 * Every request names the society it acts on in the path instead.
 *
 * The base URL defaults to `/api` — a relative path — so the browser talks to its own origin and
 * the Vite dev server proxies to the backend. Nothing here ever points at localhost.
 */

const BASE_URL: string = (import.meta.env.VITE_API_URL as string | undefined) ?? '/api';

const TOKEN_KEY = 'colonize.super.accessToken';

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

  /** The message for one field, if the server reported a field-level error. */
  forField(field: string): string | undefined {
    return this.fieldErrors.find((e) => e.field === field)?.message;
  }

  get isUnauthenticated(): boolean {
    return this.status === 401;
  }

  /** A platform token used on a tenant route, or the reverse. */
  get isScopeRejected(): boolean {
    return this.code === 'TENANT_MISMATCH' || this.code === 'PLATFORM_CONTEXT_REQUIRED';
  }

  get isModuleDisabled(): boolean {
    return this.code === 'MODULE_DISABLED';
  }
}

/* ------------------------------- token store ------------------------------- */

export const tokenStore = {
  get token(): string | null {
    return localStorage.getItem(TOKEN_KEY);
  },
  save(accessToken: string): void {
    localStorage.setItem(TOKEN_KEY, accessToken);
  },
  clear(): void {
    localStorage.removeItem(TOKEN_KEY);
  },
};

/* --------------------------------- request --------------------------------- */

export interface ApiMeta {
  page?: number;
  limit?: number;
  total?: number;
  totalPages?: number;
  requestId?: string;
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
  /** Expect a binary response (PDF) and return the Blob. */
  raw?: boolean;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = `${BASE_URL}${path.startsWith('/') ? path : `/${path}`}`;
  if (!query) return url;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

/** Subscribers are notified when a 401 means the session is over. */
const unauthorizedListeners = new Set<() => void>();
export function onUnauthorized(fn: () => void): () => void {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

export async function requestEnvelope<T>(path: string, options: RequestOptions = {}): Promise<Envelope<T>> {
  const { method = 'GET', query, body, signal, anonymous = false, raw = false } = options;

  const headers: Record<string, string> = { Accept: raw ? 'application/pdf' : 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (!anonymous) {
    const token = tokenStore.token;
    if (token) headers.Authorization = `Bearer ${token}`;
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
    throw new ApiError('Cannot reach the Colonize API. Is the backend running?', 0, 'NETWORK_ERROR');
  }

  if (raw && response.ok) {
    return { success: true, data: (await response.blob()) as T };
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
      tokenStore.clear();
      unauthorizedListeners.forEach((fn) => fn());
    }
    throw apiError;
  }

  const envelope = (payload ?? {}) as Envelope<T>;
  // Some endpoints return the bare payload; normalise both shapes.
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
  blob: (path: string) => request<Blob>(path, { raw: true }),
  /** Full envelope, for endpoints that return something in `meta` (the dev OTP, request id). */
  envelope: {
    post: <T>(path: string, body?: unknown) => requestEnvelope<T>(path, { method: 'POST', body, anonymous: true }),
    get: <T>(path: string, query?: RequestOptions['query']) => requestEnvelope<T>(path, { method: 'GET', query }),
  },
  anonymous: {
    post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body, anonymous: true }),
    get: <T>(path: string, query?: RequestOptions['query']) => request<T>(path, { method: 'GET', query, anonymous: true }),
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
 *
 * Collection endpoints return `{ data: { items }, meta: { page, limit, total, totalPages } }` —
 * the pagination lives in `meta`, so this must be built from the whole envelope, not from
 * `data` alone.
 */
export function asPage<T>(raw: unknown, meta?: ApiMeta | null, fallbackLimit = 20): Page<T> {
  const source = (raw ?? {}) as Record<string, unknown>;
  const candidate = Array.isArray(raw)
    ? raw
    : source.items ?? source.rows ?? source.results ?? (Array.isArray(source.data) ? source.data : []);
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
