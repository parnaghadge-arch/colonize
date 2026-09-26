import { useState } from 'react';
import { api } from '../lib/api.ts';
import { useResource } from '../lib/useResource.ts';
import { Alert, Button, Card, ErrorAlert, Field, Input, Loading, Select } from './ui.tsx';
import { useToast } from './ui.tsx';
import { useSession } from '../lib/session.tsx';

const METHODS = ['UPI', 'QR', 'ONLINE', 'CASH', 'CHEQUE'] as const;

interface GatewaySettings {
  provider: string;
  keyId: string;
  keySecretSet: boolean;
  upiVpa: string;
  payeeName: string;
  methods: string[];
}

/**
 * Society-level payment gateway. Keys live in this society's settings and override the
 * server environment when a provider is chosen. A blank secret keeps the one already stored.
 */
export function GatewayPanel() {
  const { can } = useSession();
  const toast = useToast();
  const settings = useResource<GatewaySettings>('/payments/gateway');
  const [draft, setDraft] = useState<GatewaySettings | null>(null);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const current = draft ?? settings.data;
  const editable = can('payment:update') || can('setting:update') || can('society:update');

  function update(patch: Partial<GatewaySettings>) {
    if (!current) return;
    setDraft({ ...current, ...patch });
  }

  async function save() {
    if (!current) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await api.put<GatewaySettings>('/payments/gateway', {
        provider: current.provider,
        keyId: current.keyId,
        keySecret: secret.trim() || undefined,
        upiVpa: current.upiVpa,
        payeeName: current.payeeName,
        methods: current.methods,
      });
      setDraft(saved);
      setSecret('');
      settings.reload();
      toast.success('Payment gateway saved');
    } catch (err) {
      setError(err);
      toast.error(err);
    } finally {
      setBusy(false);
    }
  }

  if (settings.loading && !current) return <Card title="Payment gateway"><Loading /></Card>;
  if (!current) return settings.error ? <ErrorAlert error={settings.error} /> : null;

  return (
    <Card
      title="Payment gateway"
      subtitle="Residents pay by UPI, QR, the online gateway, cash or cheque. Cash and cheque wait for you to confirm."
      actions={editable ? <Button size="sm" variant="primary" busy={busy} onClick={() => void save()}>Save gateway</Button> : undefined}
    >
      {error ? <ErrorAlert error={error} /> : null}
      {settings.error ? <ErrorAlert error={settings.error} /> : null}
      <Alert tone="info">
        Choose Mock while testing. Choose Razorpay and paste this society's own keys to take live
        payments. Leave the secret blank to keep the one already saved{current.keySecretSet ? ' (a secret is saved)' : ''}.
      </Alert>
      <div className="form-row">
        <Field label="Gateway">
          <Select value={current.provider} disabled={!editable} onChange={(e) => update({ provider: e.target.value })}>
            <option value="inherit">Use the server default</option>
            <option value="mock">Mock (testing)</option>
            <option value="razorpay">Razorpay</option>
            <option value="none">No online gateway</option>
          </Select>
        </Field>
        <Field label="UPI ID" hint="Used for UPI and the QR code.">
          <Input value={current.upiVpa} disabled={!editable} onChange={(e) => update({ upiVpa: e.target.value })} placeholder="society@okbank" />
        </Field>
      </div>
      <div className="form-row">
        <Field label="Payee name">
          <Input value={current.payeeName} disabled={!editable} onChange={(e) => update({ payeeName: e.target.value })} placeholder="Green Valley Society" />
        </Field>
        <Field label="Razorpay key id">
          <Input value={current.keyId} disabled={!editable} onChange={(e) => update({ keyId: e.target.value })} placeholder="rzp_live_…" />
        </Field>
      </div>
      <Field label="Razorpay key secret" hint="Write-only. Blank keeps the current secret.">
        <Input type="password" value={secret} disabled={!editable} onChange={(e) => setSecret(e.target.value)} placeholder={current.keySecretSet ? 'Saved — enter a new secret to replace it' : 'Key secret'} autoComplete="off" />
      </Field>
      <Field label="Methods residents can use">
        <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
          {METHODS.map((method) => (
            <label key={method} className="row" style={{ gap: 6 }}>
              <input
                type="checkbox"
                disabled={!editable}
                checked={current.methods.includes(method)}
                onChange={(e) => {
                  const methods = e.target.checked
                    ? [...current.methods, method]
                    : current.methods.filter((item) => item !== method);
                  update({ methods: methods.length ? methods : [method] });
                }}
              />
              <span className="small">{method === 'QR' ? 'QR' : method[0] + method.slice(1).toLowerCase()}</span>
            </label>
          ))}
        </div>
      </Field>
    </Card>
  );
}
