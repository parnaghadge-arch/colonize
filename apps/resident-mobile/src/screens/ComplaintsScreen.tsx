/** Complaints — list my complaints, open the detail, raise a new one. */

import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { Alert, Card, EmptyState, Loading, Screen, ScreenTitle, StatusChip, Button, colors } from '../components/ui.tsx';
import { fetchPage } from '../lib/api.ts';
import { formatDateTime, friendlyStatus } from '../lib/format.ts';
import type { Complaint } from '../lib/types.ts';
import type { TabScreenProps } from '../nav.ts';

type Props = TabScreenProps<'Complaints'>;

export function ComplaintsScreen({ navigation }: Props) {
  const [items, setItems] = useState<Complaint[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const page = await fetchPage<Complaint>('/complaints/mine', { limit: 50 });
      setItems(page.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load complaints.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  return (
    <Screen>
      <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.brand} />
      <ScreenTitle title="Complaints" subtitle="Issues raised from your units" />
      {error ? <Alert tone="error">{error}</Alert> : null}
      {items === null ? (
        <Loading />
      ) : items.length === 0 ? (
        <EmptyState title="No complaints yet" subtitle="When something breaks or needs attention, raise a complaint and track it here." />
      ) : (
        items.map((c) => (
          <Pressable key={c._id} onPress={() => navigation.navigate('ComplaintDetail', { id: c._id })}>
            <Card>
              <View style={styles.row}>
                <View style={{ flex: 1, gap: 3 }}>
                  <Text style={styles.title} numberOfLines={2}>
                    {c.referenceNumber ? `${c.referenceNumber} · ` : ''}
                    {c.title}
                  </Text>
                  <Text style={styles.meta}>
                    {friendlyStatus(c.category)} · {formatDateTime(c.createdAt)}
                    {c.assigneeName ? ` · with ${c.assigneeName}` : ''}
                  </Text>
                </View>
                <StatusChip status={c.status} />
              </View>
            </Card>
          </Pressable>
        ))
      )}
      <Button label="+ Raise a complaint" onPress={() => navigation.navigate('NewComplaint')} style={{ marginTop: 6 }} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  title: { fontSize: 14.5, fontWeight: '600', color: colors.text },
  meta: { fontSize: 12.5, color: colors.textMuted },
});
