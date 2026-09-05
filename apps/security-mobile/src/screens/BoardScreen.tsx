/**
 * Board — the security dashboard: all gates with today's counts, who is on duty,
 * the hourly in/out curve and today's deliveries (GET /guards/dashboard).
 */

import React, { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Alert, Card, EmptyState, KV, Loading, Screen, ScreenTitle, Stat, colors } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { formatTime } from '../lib/format.ts';
import { useSession } from '../lib/session.tsx';
import type { SecurityDashboard } from '../lib/types.ts';
import type { ConsoleTabScreenProps } from '../nav.ts';

type Props = ConsoleTabScreenProps<'Board'>;

export function BoardScreen({ navigation }: Props) {
  const { gateId, endShift, who } = useSession();
  const [data, setData] = useState<SecurityDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ending, setEnding] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api.get<SecurityDashboard>('/guards/dashboard'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the dashboard.');
    }
  }, []);

  const onRefresh = useCallback(async () => {
    await load();
  }, [load]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const finishShift = async () => {
    setEnding(true);
    try {
      await endShift();
      navigation.navigate('Shift');
    } finally {
      setEnding(false);
    }
  };

  const maxHour = data ? Math.max(1, ...data.hourly.map((h) => h.in + h.out)) : 1;
  const onDutyHere = (data?.guardsOnDuty ?? []).filter((g) => g.gateId === gateId);

  return (
    <Screen>
      <ScreenTitle title="Society board" subtitle={`${who?.society?.name} · ${who?.society?.timezone}`} />
      {error ? <Alert tone="error">{error}</Alert> : null}
      {!data ? (
        <Loading label="Loading the security dashboard…" />
      ) : (
        <ScrollView>
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
            <Stat label="Entries today" value={data.queue?.counts?.entriesToday ?? 0} tone="success" />
            <Stat label="Inside now" value={data.queue?.counts?.inside ?? 0} tone="info" />
            <Stat label="Deliveries" value={data.deliveriesToday ?? 0} tone={data.deliveriesToday ? 'warning' : 'default'} />
            <Stat label="On duty" value={(data.guardsOnDuty ?? []).length} />
          </View>

          <Text style={styles.sectionTitle}>Gates</Text>
          {(data.gates ?? []).map((g) => {
            const id = g._id ?? g.id ?? '';
            const active = id === gateId;
            return (
              <Card key={id} style={active ? { borderColor: colors.brand + '88' } : undefined}>
                <View style={styles.gateRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.gateName}>
                      {g.name} {active ? '· yours' : ''}
                    </Text>
                    <Text style={styles.meta}>
                      {[g.code, g.type, g.lastEntryAt ? `last entry ${formatTime(g.lastEntryAt)}` : 'no entries yet']
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                  </View>
                  <Text style={styles.gateCount}>{g.entriesToday ?? 0}</Text>
                </View>
              </Card>
            );
          })}

          <Text style={styles.sectionTitle}>Hourly crossings</Text>
          <Card>
            {(data.hourly ?? []).length === 0 ? (
              <Text style={styles.meta}>No crossings recorded yet today.</Text>
            ) : (
              <View style={styles.chart}>
                {data.hourly.map((h) => (
                  <View key={h.hour} style={styles.chartCol}>
                    <View style={styles.chartBars}>
                      <View style={[styles.chartBar, { height: ((h.in / maxHour) * 84) + 2, backgroundColor: colors.success }]} />
                      <View style={[styles.chartBar, { height: ((h.out / maxHour) * 84) + 2, backgroundColor: colors.textFaint }]} />
                    </View>
                    <Text style={styles.chartHour}>{h.hour}</Text>
                  </View>
                ))}
              </View>
            )}
            <View style={styles.legend}>
              <View style={styles.legendItem}>
                <View style={[styles.legendDot, { backgroundColor: colors.success }]} />
                <Text style={styles.meta}>in</Text>
              </View>
              <View style={styles.legendItem}>
                <View style={[styles.legendDot, { backgroundColor: colors.textFaint }]} />
                <Text style={styles.meta}>out</Text>
              </View>
            </View>
          </Card>

          <Text style={styles.sectionTitle}>Guards on duty</Text>
          {(data.guardsOnDuty ?? []).length === 0 ? (
            <EmptyState title="Nobody logged on duty" />
          ) : (
            (data.guardsOnDuty ?? []).map((g) => (
              <Card key={g.userId}>
                <KV label="Gate" value={(data.gates ?? []).find((gate) => (gate._id ?? gate.id) === g.gateId)?.name ?? g.gateId} />
                <KV label="Since" value={formatTime(g.loginAt)} />
                {g.shift ? <KV label="Shift" value={g.shift} /> : null}
              </Card>
            ))
          )}

          {onDutyHere.length > 0 ? (
            <Pressable onPress={() => void finishShift()} style={{ marginTop: 8, marginBottom: 20 }}>
              <View style={styles.endShiftBtn}>
                <Text style={styles.endShiftLabel}>{ending ? 'Ending shift…' : 'End my shift'}</Text>
              </View>
            </Pressable>
          ) : null}
        </ScrollView>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  sectionTitle: { fontSize: 13, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.6, marginVertical: 12 },
  gateRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  gateName: { fontSize: 15, fontWeight: 600, color: colors.text },
  meta: { fontSize: 12.5, color: colors.textMuted, marginTop: 2 },
  gateCount: { fontSize: 22, fontWeight: '800', color: colors.brand },
  chart: { flexDirection: 'row', alignItems: 'flex-end', gap: 3, minHeight: 100 },
  chartCol: { flex: 1, alignItems: 'center', gap: 4 },
  chartBars: { height: 88, justifyContent: 'flex-end', alignItems: 'center', flexDirection: 'row', gap: 2, width: '100%' },
  chartBar: { width: 7, borderRadius: 3 },
  chartHour: { fontSize: 9, color: colors.textFaint },
  legend: { flexDirection: 'row', gap: 14, marginTop: 10 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  endShiftBtn: { borderRadius: 12, borderWidth: 1, borderColor: colors.danger + '88', paddingVertical: 14, alignItems: 'center' },
  endShiftLabel: { color: colors.danger, fontSize: 15, fontWeight: '700' },
});
