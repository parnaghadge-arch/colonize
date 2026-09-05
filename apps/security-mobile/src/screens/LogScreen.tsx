/** Log — today's gate crossings (GET /visitors/entries/log), newest first. */

import React, { useCallback, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Alert, Card, EmptyState, Loading, Screen, ScreenTitle, colors } from '../components/ui.tsx';
import { fetchPage } from '../lib/api.ts';
import { formatTime, friendlyStatus } from '../lib/format.ts';
import { useSession } from '../lib/session.tsx';
import type { EntryLogRow } from '../lib/types.ts';
import type { ConsoleTabScreenProps } from '../nav.ts';

type Props = ConsoleTabScreenProps<'Log'>;

export function LogScreen(_props: Props) {
  const { gateId } = useSession();
  const [rows, setRows] = useState<EntryLogRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const page = await fetchPage<EntryLogRow>('/visitors/entries/log', {
        ...(gateId ? { gateId } : {}),
        limit: 100,
      });
      setRows(page.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the crossing log.');
    }
  }, [gateId]);

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
      {rows === null ? (
        <Loading label="Loading the crossing log…" />
      ) : (
        <ScrollView>
          {error ? <Alert tone="error">{error}</Alert> : null}
          {rows.length === 0 ? (
            <EmptyState title="No crossings yet today" subtitle="Every scan and manual entry/exit will appear here." />
          ) : (
            rows.map((r) => {
              const isIn = r.direction === 'IN';
              return (
                <Card key={r._id} style={styles.rowCard}>
                  <View style={styles.arrow}>
                    <Text style={[styles.arrowGlyph, { color: isIn ? colors.success : colors.textMuted }]}>{isIn ? '→' : '←'}</Text>
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={styles.person}>{r.personName ?? r.visitorName ?? '—'}</Text>
                    <Text style={styles.meta} numberOfLines={1}>
                      {[
                        r.vehicleNumber ?? null,
                        r.entryType ? friendlyStatus(r.entryType) : null,
                        r.method ? friendlyStatus(r.method) : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                  </View>
                  <Text style={styles.time}>{formatTime(r.at)}</Text>
                </Card>
              );
            })
          )}
        </ScrollView>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  rowCard: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  arrow: { width: 34, height: 34, borderRadius: 17, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' },
  arrowGlyph: { fontSize: 18, fontWeight: '700' },
  person: { fontSize: 14.5, fontWeight: 600, color: colors.text },
  meta: { fontSize: 12, color: colors.textMuted },
  time: { fontSize: 13, fontWeight: '600', color: colors.textMuted },
});
