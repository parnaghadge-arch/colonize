import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { ApiError } from '../lib/api.ts';

/* --------------------------------- buttons -------------------------------- */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'default' | 'danger' | 'ghost';
  size?: 'sm' | 'md';
  busy?: boolean;
};

export function Button({ variant = 'default', size = 'md', busy = false, className = '', children, disabled, ...rest }: ButtonProps) {
  const classes = ['btn', variant !== 'default' ? `btn--${variant}` : '', size === 'sm' ? 'btn--sm' : '', className]
    .filter(Boolean)
    .join(' ');
  return (
    <button className={classes} disabled={disabled || busy} {...rest}>
      {busy ? <span className="spinner" /> : null}
      {children}
    </button>
  );
}

/* ---------------------------------- cards --------------------------------- */

export function Card({
  title,
  subtitle,
  actions,
  children,
  footer,
  flush = false,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  flush?: boolean;
}) {
  return (
    <section className="card">
      {(title || actions) && (
        <header className="card__head">
          <div style={{ flex: 1 }}>
            {title ? <h2>{title}</h2> : null}
            {subtitle ? <p className="small muted">{subtitle}</p> : null}
          </div>
          {actions}
        </header>
      )}
      <div className={flush ? undefined : 'card__body'}>{children}</div>
      {footer ? <footer className="card__foot">{footer}</footer> : null}
    </section>
  );
}

/* ---------------------------------- forms --------------------------------- */

export function Field({
  label,
  hint,
  error,
  required,
  children,
}: {
  label?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="field">
      {label ? (
        <span className="field__label">
          {label}
          {required ? <span className="field__req"> *</span> : null}
        </span>
      ) : null}
      {children}
      {hint && !error ? <span className="field__hint">{hint}</span> : null}
      {error ? <span className="field__error">{error}</span> : null}
    </label>
  );
}

/**
 * React 19 passes `ref` through as an ordinary prop, so a plain function component is enough —
 * no forwardRef wrapper.
 */
export function Input({
  invalid,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean; ref?: Ref<HTMLInputElement> }) {
  return <input className={`input${invalid ? ' input--invalid' : ''}`} {...rest} />;
}

export function Textarea({ invalid, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return <textarea className={`textarea${invalid ? ' input--invalid' : ''}`} {...rest} />;
}

export function Select({ children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className="select" {...rest}>
      {children}
    </select>
  );
}

/** A label/value pair for read-only detail views. */
export function KeyValue({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="kv">
      {items.map(([label, value]) => (
        <div key={label} style={{ display: 'contents' }}>
          <dt>{label}</dt>
          <dd>{value ?? <span className="faint">—</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ---------------------------------- pills --------------------------------- */

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'brand';

const STATUS_TONES: Record<string, Tone> = {
  // generic lifecycle
  ACTIVE: 'success', PAID: 'success', CONFIRMED: 'success', RESOLVED: 'success', CLOSED: 'success',
  VERIFIED: 'success', COMPLETED: 'success', APPROVED: 'success', CHECKED_OUT: 'success',
  PRESENT: 'success', SETTLED: 'success', CAPTURED: 'success', OCCUPIED: 'success',
  // in flight
  PENDING: 'warning', PENDING_PAYMENT: 'warning', IN_PROGRESS: 'warning', ASSIGNED: 'warning',
  AT_GATE: 'warning', WAITING: 'warning', CHECKED_IN: 'info', ONGOING: 'info',
  PARTIALLY_PAID: 'warning', SENT: 'info', GENERATED: 'info', OPEN: 'info', ACKNOWLEDGED: 'info',
  // negative
  OVERDUE: 'danger', FAILED: 'danger', REJECTED: 'danger', CANCELLED: 'danger', DENIED: 'danger',
  DISPUTED: 'danger', SUSPENDED: 'danger', EXPIRED: 'danger', REVOKED: 'danger',
  TERMINATED: 'danger', ABSENT: 'danger', WAIVED: 'neutral', DRAFT: 'neutral',
  VACANT: 'neutral', INACTIVE: 'neutral', LOCKED: 'warning', UNDER_MAINTENANCE: 'warning',
};

export function Pill({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={tone === 'neutral' ? 'pill' : `pill pill--${tone}`}>{children}</span>;
}

/** Humanise SCREAMING_SNAKE and colour it by lifecycle meaning. */
export function StatusPill({ status }: { status?: string | null }) {
  if (!status) return <span className="faint">—</span>;
  const tone = STATUS_TONES[status] ?? 'neutral';
  const label = status
    .split('_')
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(' ');
  return <Pill tone={tone}>{label}</Pill>;
}

/* --------------------------------- feedback -------------------------------- */

export function Alert({ tone = 'info', children }: { tone?: Tone; children: ReactNode }) {
  return <div className={`alert alert--${tone === 'neutral' ? 'info' : tone === 'brand' ? 'info' : tone}`}>{children}</div>;
}

/** Renders an ApiError usefully: field errors are shown by the form, the rest as a banner. */
export function ErrorAlert({ error, onDismiss }: { error: unknown; onDismiss?: () => void }) {
  if (!error) return null;
  const message = error instanceof ApiError ? error.message : error instanceof Error ? error.message : String(error);
  return (
    <Alert tone="danger">
      <div className="row row--between">
        <span>{message}</span>
        {onDismiss ? (
          <button className="btn btn--ghost btn--sm" onClick={onDismiss} aria-label="Dismiss">
            ×
          </button>
        ) : null}
      </div>
      {error instanceof ApiError && error.fieldErrors.length > 0 ? (
        <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          {error.fieldErrors.map((f, i) => (
            <li key={i}>
              {f.field ? <code>{f.field}</code> : null} {f.message}
            </li>
          ))}
        </ul>
      ) : null}
    </Alert>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading-block">
      <span className="spinner spinner--lg" />
      <p className="muted small" style={{ marginTop: 10 }}>
        {label}
      </p>
    </div>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {hint ? <p className="small">{hint}</p> : null}
      {action ? <div style={{ marginTop: 12 }}>{action}</div> : null}
    </div>
  );
}

/* ---------------------------------- toasts --------------------------------- */

interface ToastItem {
  id: number;
  message: string;
  tone: 'default' | 'success' | 'error';
}

interface ToastApi {
  show: (message: string, tone?: ToastItem['tone']) => void;
  success: (message: string) => void;
  error: (error: unknown) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const show = useCallback((message: string, tone: ToastItem['tone'] = 'default') => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, message, tone }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4200);
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      show,
      success: (message: string) => show(message, 'success'),
      error: (error: unknown) => {
        const message =
          error instanceof ApiError
            ? error.fieldErrors.length > 0
              ? `${error.message} — ${error.fieldErrors[0]!.message}`
              : error.message
            : error instanceof Error
              ? error.message
              : 'Something went wrong';
        show(message, 'error');
      },
    }),
    [show],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={t.tone === 'default' ? 'toast' : `toast toast--${t.tone}`}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

/* ---------------------------------- modal ---------------------------------- */

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide = false,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={wide ? 'modal modal--wide' : 'modal'} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal__head">
          <h2>{title}</h2>
          <button className="modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>
        <div className="modal__body">{children}</div>
        {footer ? <footer className="modal__foot">{footer}</footer> : null}
      </div>
    </div>
  );
}

/* ---------------------------------- table ---------------------------------- */

export interface Column<Row> {
  key: string;
  header: ReactNode;
  render: (row: Row) => ReactNode;
  align?: 'left' | 'right';
  width?: string;
}

export function DataTable<Row extends object>({
  rows,
  columns,
  rowKey,
  empty,
  footer,
  onRowClick,
}: {
  rows: Row[];
  columns: Array<Column<Row>>;
  rowKey?: (row: Row, index: number) => string;
  empty?: ReactNode;
  footer?: ReactNode;
  onRowClick?: (row: Row) => void;
}) {
  if (rows.length === 0) return <>{empty ?? <EmptyState title="Nothing here yet" />}</>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={c.align === 'right' ? 'num' : undefined} style={c.width ? { width: c.width } : undefined}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={rowKey ? rowKey(row, index) : ((row as { _id?: string })._id ?? String(index))}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              style={onRowClick ? { cursor: 'pointer' } : undefined}
            >
              {columns.map((c) => (
                <td key={c.key} className={c.align === 'right' ? 'num' : undefined}>
                  {c.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer ? <tfoot><tr><td colSpan={columns.length}>{footer}</td></tr></tfoot> : null}
      </table>
    </div>
  );
}

/* -------------------------------- pagination ------------------------------- */

export function Pagination({
  page,
  limit,
  total,
  onPage,
}: {
  page: number;
  limit: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  if (total === 0) return null;
  const from = (page - 1) * limit + 1;
  const to = Math.min(total, page * limit);
  return (
    <div className="pagination">
      <span>
        {from}–{to} of {total}
      </span>
      <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        ← Prev
      </Button>
      <span>
        Page {page} / {totalPages}
      </span>
      <Button size="sm" variant="ghost" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
        Next →
      </Button>
    </div>
  );
}
