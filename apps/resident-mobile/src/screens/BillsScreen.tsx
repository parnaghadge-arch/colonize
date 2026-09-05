/** Bills — my units' bills, oldest-due first, with a pay button per due bill. */

import React, { useCallback, useState } from 'react';
import { Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { Alert, Button, Card, EmptyState, Loading, Screen, ScreenTitle, StatusChip, colors } from '../components/ui.tsx';
import { fetchPage } from '../lib/api.ts';
import { formatMoney, formatDate } from '../lib/format.ts';
import { useSession } from '../lib/session.tsx';
import type { Bill } from '../lib/types.ts';
import type { TabScreenProps } from '../nav.ts';

type Props = TabScreenProps<'Bills'>;

export function BillsScreen({ navigation }: Props) {
  const { who } = useSession();
  const currency = who?.society?.currency ?? 'INR';
  const [items, setItems] = useState<Bill[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const page = await fetchPage<Bill>('/bills/mine', { limit: 50, sortBy: 'dueDate', sortDir: 'asc' });
      setItems(page.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load bills.');
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

  const dueCount = (items ?? []).filter((b) => (b.dueAmount ?? 0) > 0.009).length;

  return (
    <Screen>
      <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.brand} />
      <ScreenTitle title="Bills" subtitle={items ? `${dueCount} due · ${items.length} total` : 'For your units'} />
      {error ? <Alert tone="error">{error}</Alert> : null}
      {items === null ? (
        <Loading />
      ) : items.length === 0 ? (
        <EmptyState title="No bills yet" subtitle="When the society generates maintenance bills, they will appear here." />
      ) : (
        items.map((b) => {
          const due = (b.dueAmount ?? 0) > 0.009;
          return (
            <Pressable key={b._id} onPress={() => navigation.navigate('BillDetail', { id: b._id })}>
              <Card style={due && overdue(b) ? { borderColor: colors.danger + '55' } : undefined}>
                <View style={styles.row}>
                  <View style={{ flex: 1, gap: 3 }}>
                    <Text style={styles.title}>
                      {b.invoiceNumber ?? 'Bill'} · {b.period}
                    </Text>
                    <Text style={styles.meta}>
                      {b.unitLabel ?? ''} · due {formatDate(b.dueDate)}
                      {due ? ` · pay ${formatMoney(b.dueAmount, currency)}` : ' · settled'}
                    </Text>
                  </View>
                  <View style={{ alignItems: 'flex-end', gap: 6 }}>
                    <Text style={styles.amount}>{formatMoney(b.totalAmount, currency)}</Text>
                    <StatusChip status={b.status} />
                  </View>
                </View>
              </Card>
            </Pressable>
          );
        })
      )}
    </Screen>
  );
}

function overdue(b: Bill): boolean {
  return b.status?.toUpperCase() === 'OVERDUE' || (new Date(b.dueDate).getTime() < Date.now() && (b.dueAmount ?? 0) > 0.009);
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  title: { fontSize: 14.5, fontWeight: 600, color: colors.text },
  meta: { fontSize: 12.5, color: colors.textMuted },
  amount: { fontSize: 15, fontWeight: '800', color: colors.text },
});
