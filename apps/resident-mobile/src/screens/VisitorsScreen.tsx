/** Visitors — visits to my units: invite a guest (QR pass generated) or view the pass. */

import React, { useCallback, useState } from 'react';
import { Alert as RNAlert, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { Alert, Button, Card, EmptyState, Loading, Screen, ScreenTitle, StatusChip, colors } from '../components/ui.tsx';
import { api, fetchPage } from '../lib/api.ts';
import { formatDate, formatTime } from '../lib/format.ts';
import type { Visitor } from '../lib/types.ts';
import type { TabScreenProps } from '../nav.ts';

type Props = TabScreenProps<'Visitors'>;

export function VisitorsScreen({ navigation }: Props) {
  const [items, setItems] = useState<Visitor[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const page = await fetchPage<Visitor>('/visitors/mine', { limit: 30 });
      setItems(page.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load visitors.');
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

  const hasPass = (v: Visitor) => Boolean(v.passId) || ['AWAITING_APPROVAL', 'APPROVED', 'PRE_APPROVED', 'INSIDE'].includes(String(v.status).toUpperCase());

  const cancellable = (v: Visitor) => ['AWAITING_APPROVAL', 'APPROVED', 'PRE_APPROVED'].includes(String(v.status).toUpperCase());

  const [busyId, setBusyId] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const cancel = (v: Visitor) => {
    RNAlert.alert(
      'Cancel this visit?',
      `${v.visitorName ?? v.name ?? 'This visitor'} — ${v.visitDate ? `${formatDate(v.visitDate)} ` : ''}${v.expectedArrival ? `· ${v.expectedArrival}` : ''}\nTheir QR pass will stop working at the gate.`,
      [
        { text: 'Keep', style: 'cancel' },
        {
          text: 'Cancel visit',
          style: 'destructive',
          onPress: async () => {
            setBusyId(v._id);
            setCancelError(null);
            try {
              await api.post(`/visitors/${v._id}/cancel`, { reason: 'Cancelled by resident' });
              await load();
            } catch (err) {
              setCancelError(err instanceof Error ? err.message : 'Could not cancel the visit.');
            } finally {
              setBusyId(null);
            }
          },
        },
      ],
    );
  };

  return (
    <Screen>
      <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.brand} />
      <ScreenTitle title="Visitors" subtitle="Guests coming to your unit" />
      {error ? <Alert tone="error">{error}</Alert> : null}
      {cancelError ? <Alert tone="error">{cancelError}</Alert> : null}
      {items === null ? (
        <Loading />
      ) : items.length === 0 ? (
        <EmptyState title="No visits planned" subtitle="Invite a guest and they get a QR pass the gate can scan." />
      ) : (
        items.map((v) => (
          <Card key={v._id}>
            <View style={styles.row}>
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={styles.name}>{v.visitorName ?? v.name ?? 'Visitor'}</Text>
                <Text style={styles.meta}>
                  {v.purpose ? `${v.purpose} · ` : ''}
                  {v.visitDate ? `${formatDate(v.visitDate)}` : ''}
                  {v.expectedArrival ? ` · ${v.expectedArrival}` : ''}
                </Text>
                <Text style={styles.meta}>
                  {[v.visitorType, v.numberOfVisitors ? `${v.numberOfVisitors} people` : null, v.vehicleNumber].filter(Boolean).join(' · ')}
                </Text>
              </View>
              <View style={{ alignItems: 'flex-end', gap: 8 }}>
                <StatusChip status={v.status} />
                {hasPass(v) ? (
                  <Pressable onPress={() => navigation.navigate('QrPass', { visitorId: v._id })}>
                    <Text style={styles.passLink}>Show pass ›</Text>
                  </Pressable>
                ) : null}
                {cancellable(v) ? (
                  <Pressable onPress={() => cancel(v)} disabled={busyId !== null}>
                    <Text style={styles.cancelLink}>{busyId === v._id ? 'Cancelling…' : 'Cancel visit'}</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          </Card>
        ))
      )}
      <Button label="+ Invite a visitor" onPress={() => navigation.navigate('NewVisitor')} style={{ marginTop: 6 }} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  name: { fontSize: 15, fontWeight: 600, color: colors.text },
  meta: { fontSize: 12.5, color: colors.textMuted },
  passLink: { color: colors.brandDark, fontSize: 13, fontWeight: '600' },
  cancelLink: { color: colors.danger, fontSize: 12.5, fontWeight: '500' },
});
