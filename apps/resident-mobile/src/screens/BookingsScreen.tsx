/** My amenity bookings — upcoming first, with cancel. */

import React, { useCallback, useState } from 'react';
import { RefreshControl, StyleSheet, Text, View } from 'react-native';

import { Alert, Button, Card, EmptyState, Loading, Screen, ScreenTitle, StatusChip, colors } from '../components/ui.tsx';
import { api, fetchPage } from '../lib/api.ts';
import { payNow } from '../lib/pay.ts';
import { formatDate, formatMoney } from '../lib/format.ts';
import { useSession } from '../lib/session.tsx';
import type { AmenityBooking } from '../lib/types.ts';
import type { StackScreenProps } from '../nav.ts';

type Props = StackScreenProps<'Bookings'>;

export function BookingsScreen(_props: Props) {
  const { who } = useSession();
  const currency = who?.society?.currency ?? 'INR';
  const [items, setItems] = useState<AmenityBooking[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [payNote, setPayNote] = useState<{ tone: 'success' | 'info'; text: string } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const page = await fetchPage<AmenityBooking>('/amenity-bookings/mine', { limit: 50 });
      setItems(page.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load bookings.');
    }
  }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  React.useEffect(() => {
    void load();
  }, [load]);

  const cancel = async (booking: AmenityBooking) => {
    setBusyId(booking._id);
    setError(null);
    try {
      await api.post(`/amenity-bookings/${booking._id}/cancel`, { reason: 'Cancelled by resident' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not cancel the booking.');
    } finally {
      setBusyId(null);
    }
  };

  const cancellable = (b: AmenityBooking) =>
    ['CONFIRMED', 'APPROVED', 'PENDING_APPROVAL', 'PENDING_PAYMENT'].includes(String(b.status).toUpperCase()) &&
    String(b.date).slice(0, 10) >= new Date().toISOString().slice(0, 10);

  const payable = (b: AmenityBooking) =>
    String(b.status).toUpperCase() === 'PENDING_PAYMENT' &&
    Number(b.totalAmount ?? b.fee ?? 0) > 0.009 &&
    String(b.date).slice(0, 10) >= new Date().toISOString().slice(0, 10);

  const pay = async (b: AmenityBooking) => {
    setBusyId(b._id);
    setPayNote(null);
    setError(null);
    try {
      const out = await payNow({ purpose: 'AMENITY_BOOKING', bookingId: b._id });
      if (out.verified) {
        setPayNote({
          tone: 'success',
          text: `Payment of ${formatMoney(out.order.amount ?? b.totalAmount ?? 0, currency)} captured — ${b.referenceNumber ?? 'the booking'} is now confirmed.`,
        });
        await load();
      } else {
        setPayNote({
          tone: 'info',
          text: `Checkout started for ${b.referenceNumber ?? 'the booking'} (order ${out.order.orderId}). Complete it in your payment app, then pull to refresh.`,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The booking payment could not be completed.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Screen>
      <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.brand} />
      <ScreenTitle title="My bookings" subtitle="Amenities you have reserved" />
      {error ? <Alert tone="error">{error}</Alert> : null}
      {payNote ? <Alert tone={payNote.tone}>{payNote.text}</Alert> : null}
      {items === null ? (
        <Loading />
      ) : items.length === 0 ? (
        <EmptyState title="No bookings yet" subtitle="Book the gym, pool or clubhouse from the Amenities tab." />
      ) : (
        items.map((b) => (
          <Card key={b._id}>
            <View style={styles.row}>
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={styles.title}>{b.amenity?.name ?? b.amenityName ?? 'Amenity'}</Text>
                <Text style={styles.meta}>
                  {formatDate(b.date)} · {b.startTime ? `${b.startTime}–${b.endTime}` : ''}
                  {b.totalAmount ? ` · ${formatMoney(b.totalAmount, currency)}` : ''}
                </Text>
                {b.rejectReason ? <Text style={styles.reject}>{b.rejectReason}</Text> : null}
              </View>
              <StatusChip status={b.status} />
            </View>
            {payable(b) ? (
              <Button
                label={`Pay ${formatMoney(Number(b.totalAmount ?? b.fee ?? 0), currency)} to confirm`}
                onPress={() => void pay(b)}
                loading={busyId === b._id}
                style={{ marginTop: 10 }}
              />
            ) : null}
            {cancellable(b) ? (
              <Button
                label="Cancel booking"
                variant="ghost"
                onPress={() => void cancel(b)}
                loading={busyId === b._id}
                style={{ marginTop: payable(b) ? 8 : 10, alignSelf: 'flex-start', paddingHorizontal: 14 }}
              />
            ) : null}
          </Card>
        ))
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  title: { fontSize: 14.5, fontWeight: 600, color: colors.text },
  meta: { fontSize: 12.5, color: colors.textMuted },
  reject: { fontSize: 12, color: colors.danger, marginTop: 2 },
});
