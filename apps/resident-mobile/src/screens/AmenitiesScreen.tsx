/** Amenities — bookable facilities with fees, hours and capacity. */

import React, { useCallback, useState } from 'react';
import { Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { Alert, Card, EmptyState, Loading, Screen, ScreenTitle, colors } from '../components/ui.tsx';
import { fetchPage } from '../lib/api.ts';
import { formatMoney } from '../lib/format.ts';
import { useSession } from '../lib/session.tsx';
import type { Amenity } from '../lib/types.ts';
import type { TabScreenProps } from '../nav.ts';

type Props = TabScreenProps<'Amenities'>;

const TYPE_EMOJI: Record<string, string> = {
  CLUBHOUSE: '🏛',
  GYM: '🏋️',
  POOL: '🏊',
  BADMINTON: '🏸',
  TENNIS: '🎾',
  SQUASH: '🏹',
  PARKING: '🅿️',
  THEATRE: '🎬',
  YOGA: '🧘',
  PLAYGROUND: '🛝',
  GARDEN: '🌳',
  OTHER: '📍',
};

export function AmenitiesScreen({ navigation }: Props) {
  const { who } = useSession();
  const currency = who?.society?.currency ?? 'INR';
  const [items, setItems] = useState<Amenity[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      // The list query filter matches on string equality, and `isActive` is a boolean
      // column — so fetch the catalogue and drop inactive rows here instead.
      const page = await fetchPage<Amenity>('/amenities', { limit: 100 });
      setItems(page.items.filter((a) => a.isActive !== false));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load amenities.');
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

  return (
    <Screen>
      <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.brand} />
      <ScreenTitle title="Amenities" subtitle="Book shared facilities" />
      {error ? <Alert tone="error">{error}</Alert> : null}
      {items === null ? (
        <Loading />
      ) : items.length === 0 ? (
        <EmptyState title="Nothing to book yet" subtitle="Your society has not published any bookable amenities." />
      ) : (
        items.map((a) => (
          <Pressable key={a._id} onPress={() => navigation.navigate('AmenityDetail', { id: a._id })}>
            <Card>
              <View style={styles.row}>
                <View style={styles.iconBox}>{TYPE_EMOJI[String(a.type ?? '').toUpperCase()] ?? '📍'}</View>
                <View style={{ flex: 1, gap: 3 }}>
                  <Text style={styles.name}>{a.name}</Text>
                  <Text style={styles.meta} numberOfLines={1}>
                    {[a.location, a.openTime && `${a.openTime}–${a.closeTime}`, a.capacity ? `capacity ${a.capacity}` : null]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                </View>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text style={styles.fee}>{a.bookingFee ? formatMoney(a.bookingFee, currency) : 'free'}</Text>
                  {a.requireApproval ? <Text style={styles.approval}>approval</Text> : null}
                </View>
              </View>
            </Card>
          </Pressable>
        ))
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  iconBox: { width: 44, height: 44, borderRadius: 12, backgroundColor: colors.brandSoft, alignItems: 'center', justifyContent: 'center' },
  name: { fontSize: 15, fontWeight: 600, color: colors.text },
  meta: { fontSize: 12.5, color: colors.textMuted },
  fee: { fontSize: 13.5, fontWeight: '700', color: colors.text },
  approval: { fontSize: 11, color: colors.warning, marginTop: 2 },
});
