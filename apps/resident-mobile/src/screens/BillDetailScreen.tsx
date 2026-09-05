/**
 * Bill detail + payment.
 *
 * The payment flow is exactly the API's two-step contract (§29, §59):
 *   1. POST /payments/intent — the client says WHAT it pays for; the server computes HOW MUCH.
 *   2. POST /payments/verify — with the gateway order/payment ids and signature.
 *
 * With the mock gateway (PAYMENT_GATEWAY=mock, the development default) the order carries
 * `mockPaymentId` + `mockSignature`, so the app completes the real signature dance end to end.
 */

import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Alert, Button, Card, KV, Loading, Screen, StatusChip, colors } from '../components/ui.tsx';
import { api, ApiError } from '../lib/api.ts';
import { formatDateTime, formatMoney, formatDate } from '../lib/format.ts';
import { useSession } from '../lib/session.tsx';
import type { Bill, PaymentOrder, VerifyResult } from '../lib/types.ts';
import type { StackScreenProps } from '../nav.ts';

type Props = StackScreenProps<'BillDetail'>;

function clientRequestId(): string {
  return `app-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function BillDetailScreen({ route }: Props) {
  const { id } = route.params;
  const { who } = useSession();
  const currency = who?.society?.currency ?? 'INR';

  const [bill, setBill] = useState<Bill | null>(null);
  const [error, setError] = useState<string | null>(null);
  // stage drives WHICH card is shown; busy drives the spinner on whichever action is running.
  const [stage, setStage] = useState<'idle' | 'checkout' | 'done'>('idle');
  const [busy, setBusy] = useState(false);
  const [order, setOrder] = useState<PaymentOrder | null>(null);
  const [paymentId, setPaymentId] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<VerifyResult | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const b = await api.get<Bill>(`/bills/${id}`);
      setBill(b);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the bill.');
    }
  }, [id]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const startPayment = async () => {
    if (!bill) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ payment: { _id: string }; order: PaymentOrder; duplicate?: boolean }>('/payments/intent', {
        purpose: 'MAINTENANCE',
        billId: bill._id,
        clientRequestId: clientRequestId(),
      });
      setPaymentId(result.payment._id);
      setOrder(result.order);
      setStage('checkout');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start the payment.');
    } finally {
      setBusy(false);
    }
  };

  const completePayment = async () => {
    if (!paymentId || !order) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<VerifyResult>('/payments/verify', {
        paymentId,
        gatewayOrderId: order.orderId,
        gatewayPaymentId: order.mockPaymentId ?? `pay_${clientRequestId()}`,
        signature: order.mockSignature ?? '',
      });
      setReceipt(result);
      setStage('done');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The payment could not be completed.');
    } finally {
      setBusy(false);
    }
  };

  if (!bill && !error) return <Screen scroll={false}><Loading /></Screen>;

  const due = Number(bill?.dueAmount ?? 0);
  const canPay = due > 0.009 && !['WAIVED', 'CANCELED', 'CANCELLED'].includes(String(bill?.status ?? '').toUpperCase());

  return (
    <Screen>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {bill ? (
        <>
          <Card>
            <View style={styles.head}>
              <Text style={styles.invoice}>{bill.invoiceNumber ?? 'Bill'}</Text>
              <StatusChip status={bill.status} />
            </View>
            <Text style={styles.period}>{bill.period}</Text>
            <View style={styles.totalRow}>
              <Text style={styles.total}>{formatMoney(bill.totalAmount, currency)}</Text>
              {due > 0.009 ? <Text style={styles.due}>due {formatMoney(due, currency)}</Text> : <Text style={styles.settled}>fully paid</Text>}
            </View>
          </Card>

          <Card>
            <KV label="Unit" value={bill.unitLabel ?? '—'} />
            <KV label="Period start" value={formatDate(bill.periodStart)} />
            <KV label="Period end" value={formatDate(bill.periodEnd)} />
            <KV label="Due date" value={formatDate(bill.dueDate)} />
            <KV label="Subtotal" value={formatMoney(bill.subtotal, currency)} />
            <KV label="Tax" value={formatMoney(bill.totalTax, currency)} />
            {(bill.penalty ?? 0) > 0 || (bill.lateFee ?? 0) > 0 ? (
              <KV label="Charges" value={formatMoney((bill.penalty ?? 0) + (bill.lateFee ?? 0), currency)} />
            ) : null}
            <KV label="Paid so far" value={formatMoney(bill.paidAmount, currency)} />
            <KV label="Generated" value={formatDateTime(bill.createdAt)} />
          </Card>

          {Array.isArray(bill.items) && bill.items.length > 0 ? (
            <Card>
              {bill.items.map((item, i) => (
                <View key={i} style={styles.itemRow}>
                  <Text style={styles.itemName}>{item.description ?? item.label ?? item.name ?? 'Item'}</Text>
                  <Text style={styles.itemAmount}>{formatMoney(item.amount, currency)}</Text>
                </View>
              ))}
            </Card>
          ) : null}

          {stage === 'done' && receipt ? (
            <Alert tone="success">
              Payment of {formatMoney(receipt.payment.amount ?? due, currency)} captured
              {receipt.receipt?.receiptNumber ? ` — receipt ${receipt.receipt.receiptNumber}` : ''}. The bill is updated.
            </Alert>
          ) : null}

          {stage === 'checkout' && order ? (
            <Card style={{ borderColor: colors.brand + '66' }}>
              <Text style={styles.payTitle}>Checkout</Text>
              <KV label="Gateway order" value={order.orderId} mono />
              <KV label="Amount" value={formatMoney(order.amount ?? due, currency)} />
              <Text style={styles.payHint}>
                {order.mockPaymentId
                  ? 'Development mock gateway — complete the signature check to capture.'
                  : 'Your payment sheet will open. Come back here once you are done.'}
              </Text>
              {order.mockPaymentId ? (
                <Button label={`Pay ${formatMoney(order.amount ?? due, currency)}`} onPress={() => void completePayment()} loading={busy} style={{ marginTop: 8 }} />
              ) : null}
            </Card>
          ) : null}

          {canPay && stage === 'idle' ? (
            <Button label={`Pay ${formatMoney(due, currency)}`} onPress={() => void startPayment()} loading={busy} />
          ) : null}

          <Pressable
            onPress={() => {
              setStage('idle');
              setOrder(null);
              setPaymentId(null);
              setReceipt(null);
              setError(null);
              void load();
            }}
            style={{ alignSelf: 'center', marginTop: 10 }}
          >
            <Text style={{ color: colors.textFaint }}>Refresh bill</Text>
          </Pressable>
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  invoice: { fontSize: 13, color: colors.textFaint, fontFamily: 'monospace' },
  period: { fontSize: 17, fontWeight: '700', color: colors.text },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 10 },
  total: { fontSize: 24, fontWeight: '800', color: colors.text },
  due: { fontSize: 14, fontWeight: '700', color: colors.danger },
  settled: { fontSize: 14, fontWeight: '700', color: colors.success },
  itemRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 4, gap: 12 },
  itemName: { fontSize: 13.5, color: colors.text, flex: 1 },
  itemAmount: { fontSize: 13.5, color: colors.textMuted, fontWeight: '600' },
  payTitle: { fontSize: 15, fontWeight: 600, color: colors.text, marginBottom: 8 },
  payHint: { fontSize: 12.5, color: colors.textMuted, marginTop: 8, lineHeight: 18 },
});
