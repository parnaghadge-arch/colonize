import { useState } from 'react';
import { api } from '../lib/api.ts';
import { useResource } from '../lib/useResource.ts';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  ErrorAlert,
  Field,
  Input,
  Loading,
  Modal,
  StatusPill,
} from '../components/ui.tsx';
import { label, money } from '../lib/format.ts';
import { useSession } from '../lib/session.tsx';

interface MineBills {
  bills: Array<{
    _id: string;
    invoiceNumber?: string;
    period?: string;
    dueAmount?: number;
    totalAmount?: number;
    status?: string;
    unit?: string | null;
  }>;
  totals?: { due?: number };
}

interface PayOptions {
  methods: string[];
  upiVpa?: string | null;
  payeeName?: string | null;
  onlineEnabled?: boolean;
  provider?: string;
}

interface QrPayload {
  dataUrl: string;
  uri: string;
  amount?: number | null;
  vpa?: string;
}

/**
 * The same person, wearing the resident hat. Every call on this page is a resident-scoped
 * endpoint, so it cannot generate bills or confirm someone else's payment.
 */
export function MemberHomePage() {
  const { who } = useSession();
  const home = useResource<{ unit?: { label?: string; unitNumber?: string } }>('/residents/my-unit');
  const bills = useResource<MineBills>('/bills/mine');
  const options = useResource<PayOptions>('/payments/options');
  const [paying, setPaying] = useState<MineBills['bills'][number] | null>(null);

  const unitLabel = home.data?.unit?.label ?? home.data?.unit?.unitNumber ?? who?.membership?.primaryUnitId ?? 'your flat';
  const due = bills.data?.totals?.due ?? 0;

  return (
    <div className="stack">
      <Alert tone="info">
        You are acting as a resident of <b>{unitLabel}</b>. Society management is paused until you
        switch back to Manage society.
      </Alert>
      {home.error ? <ErrorAlert error={home.error} /> : null}
      {bills.error ? <ErrorAlert error={bills.error} /> : null}

      <div className="tiles">
        <div className="tile tile--brand">
          <div className="tile__label">Flat</div>
          <div className="tile__value">{home.loading ? '…' : unitLabel}</div>
        </div>
        <div className={`tile ${due > 0 ? 'tile--warning' : 'tile--success'}`}>
          <div className="tile__label">Due</div>
          <div className="tile__value">{money(due)}</div>
        </div>
      </div>

      <Card title="My bills" subtitle="Pay by UPI, QR, the online gateway, cash or cheque.">
        {bills.loading ? (
          <Loading />
        ) : (bills.data?.bills ?? []).length === 0 ? (
          <EmptyState title="No bills yet" hint="When the society raises a bill for your flat, it shows up here." />
        ) : (
          <div className="stack">
            {(bills.data?.bills ?? []).map((bill) => (
              <div key={bill._id} className="row" style={{ justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <div>
                  <b>{bill.invoiceNumber ?? 'Bill'}</b>
                  <div className="small faint">{bill.period} · {bill.unit ?? unitLabel}</div>
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <StatusPill status={bill.status} />
                  <span>{money(bill.dueAmount ?? 0)}</span>
                  {(bill.dueAmount ?? 0) > 0 ? (
                    <Button size="sm" variant="primary" onClick={() => setPaying(bill)}>Pay</Button>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {paying ? (
        <PayModal
          bill={paying}
          options={options.data}
          onClose={() => setPaying(null)}
          onDone={() => {
            setPaying(null);
            bills.reload();
          }}
        />
      ) : null}
    </div>
  );
}

function PayModal({
  bill,
  options,
  onClose,
  onDone,
}: {
  bill: MineBills['bills'][number];
  options?: PayOptions | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const methods = (options?.methods ?? ['UPI', 'QR', 'ONLINE', 'CASH', 'CHEQUE']).filter((method) => method !== 'ONLINE' || options?.onlineEnabled !== false);
  const [mode, setMode] = useState(methods[0] ?? 'UPI');
  const [reference, setReference] = useState('');
  const [chequeNumber, setChequeNumber] = useState('');
  const [bankName, setBankName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [qr, setQr] = useState<QrPayload | null>(null);
  const [onlinePaymentId, setOnlinePaymentId] = useState<string | null>(null);

  async function loadQr() {
    setBusy(true);
    setError(null);
    try {
      setQr(await api.get<QrPayload>('/payments/upi-qr', { billId: bill._id }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function claim() {
    setBusy(true);
    setError(null);
    try {
      await api.post('/payments/claim', {
        billId: bill._id,
        mode,
        referenceNumber: reference.trim() || undefined,
        chequeNumber: chequeNumber.trim() || undefined,
        bankName: bankName.trim() || undefined,
        clientRequestId: `${bill._id}-${mode}-${Date.now()}`,
      });
      setMessage('Submitted. The office will confirm this before it is applied to the bill.');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function payOnline() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ payment: { _id: string }; order: { checkoutUrl?: string; mockPaymentId?: string; mockSignature?: string; orderId: string } }>('/payments/intent', {
        purpose: 'MAINTENANCE',
        billId: bill._id,
        clientRequestId: `${bill._id}-online-${Date.now()}`,
      });
      if (result.order.checkoutUrl) {
        window.open(result.order.checkoutUrl, '_blank', 'noopener');
        setMessage('Checkout opened in a new tab. After you pay, come back and tap “I’ve paid”.');
        setOnlinePaymentId(result.payment._id);
        return;
      }
      if (result.order.mockPaymentId && result.order.mockSignature) {
        await api.post('/payments/verify', {
          paymentId: result.payment._id,
          gatewayOrderId: result.order.orderId,
          gatewayPaymentId: result.order.mockPaymentId,
          signature: result.order.mockSignature,
        });
        onDone();
        return;
      }
      setMessage('The gateway order was created. Complete it in the checkout window, then refresh.');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Pay ${bill.invoiceNumber ?? 'bill'}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Close</Button>
          {mode === 'ONLINE' ? (
            onlinePaymentId ? (
              <Button variant="primary" busy={busy} onClick={() => void api.post(`/payments/${onlinePaymentId}/sync`).then(onDone).catch(setError)}>I’ve paid</Button>
            ) : (
              <Button variant="primary" busy={busy} onClick={() => void payOnline()}>Pay online</Button>
            )
          ) : (
            <Button variant="primary" busy={busy} onClick={() => void claim()} disabled={Boolean(message)}>Submit for confirmation</Button>
          )}
        </>
      }
    >
      {error ? <ErrorAlert error={error} /> : null}
      {message ? <Alert tone="success">{message}</Alert> : null}
      <p className="small">Balance due {money(bill.dueAmount ?? 0)}. Cash and cheque are confirmed by the office before the bill changes.</p>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', margin: '12px 0' }}>
        {methods.map((method) => (
          <Button key={method} size="sm" variant={mode === method ? 'primary' : 'default'} onClick={() => { setMode(method); setMessage(null); }}>
            {label(method)}
          </Button>
        ))}
      </div>
      {mode === 'UPI' ? (
        <Alert tone="info">Pay {options?.upiVpa ? <>to <b>{options.upiVpa}</b></> : 'using the society UPI ID'}{options?.payeeName ? ` (${options.payeeName})` : ''}, then enter the UTR.</Alert>
      ) : null}
      {mode === 'QR' ? (
        <div className="stack">
          {qr?.dataUrl ? <img src={qr.dataUrl} alt="UPI QR" style={{ width: 220, maxWidth: '100%', alignSelf: 'center' }} /> : (
            <Button onClick={() => void loadQr()} busy={busy}>Show QR</Button>
          )}
        </div>
      ) : null}
      {mode === 'CHEQUE' ? (
        <div className="form-row">
          <Field label="Cheque number"><Input value={chequeNumber} onChange={(e) => setChequeNumber(e.target.value)} /></Field>
          <Field label="Bank"><Input value={bankName} onChange={(e) => setBankName(e.target.value)} /></Field>
        </div>
      ) : null}
      {mode !== 'ONLINE' && mode !== 'CASH' ? (
        <Field label={mode === 'CHEQUE' ? 'Note' : 'UTR or reference'}>
          <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="UTR or transaction id" />
        </Field>
      ) : null}
    </Modal>
  );
}
