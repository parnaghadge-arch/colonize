/**
 * Shift — pick the gate you are manning and start the shift.
 *
 * POST /guards/shift/login with the chosen gateId. Guards posted to exactly one gate
 * (their membership.gateIds) can start straight away without choosing.
 */

import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Alert, Button, Card, Screen, ScreenTitle, colors } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { useSession } from '../lib/session.tsx';
import type { Gate } from '../lib/types.ts';
import type { StackScreenProps } from '../nav.ts';

type Props = StackScreenProps<'Shift'>;

export function ShiftScreen(_props: Props) {
  const { who, startShift, logout } = useSession();
  const [gates, setGates] = useState<Gate[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const postedGates = who?.membership?.gateIds ?? [];

  const load = useCallback(async () => {
    try {
      const list = await api.get<Gate[] | { items?: Gate[] }>('/gates');
      const items = Array.isArray(list) ? list : (list.items ?? []);
      setGates(items.filter((g) => g.isActive !== false));
      if (postedGates.length === 1) setSelected(postedGates[0]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load gates.');
    }
  }, [postedGates]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const begin = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await startShift(selected);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the shift.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <ScreenTitle title="Start shift" subtitle={who?.society?.name} />
      {error ? <Alert tone="error">{error}</Alert> : null}

      <Text style={styles.label}>Select your gate</Text>
      {gates === null ? (
        <Card>
          <Text style={styles.muted}>Loading gates…</Text>
        </Card>
      ) : gates.length === 0 ? (
        <Card>
          <Text style={styles.muted}>No active gates found. Ask the society admin.</Text>
        </Card>
      ) : (
        gates.map((g) => {
          const id = g._id ?? g.id ?? '';
          const isSel = selected === id;
          return (
            <Pressable key={id} onPress={() => setSelected(id)} style={[styles.gateRow, isSel && styles.gateRowSelected]}>
              <View style={{ flex: 1 }}>
                <Text style={styles.gateName}>{g.name}</Text>
                <Text style={styles.muted}>{[g.code, g.type].filter(Boolean).join(' · ')}</Text>
              </View>
              <View style={[styles.radio, isSel && styles.radioSelected]}>
                {isSel ? <View style={styles.radioDot} /> : null}
              </View>
            </Pressable>
          );
        })
      )}

      <Button label="Start shift" onPress={() => void begin()} disabled={!selected} loading={busy} style={{ marginTop: 8 }} />
      <Button
        label="Sign out"
        variant="ghost"
        onPress={() => void logout()}
        style={{ marginTop: 8, opacity: 0.7 }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 13, fontWeight: '600', color: colors.textMuted, marginBottom: 8 },
  muted: { fontSize: 13.5, color: colors.textMuted, lineHeight: 19 },
  gateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    marginBottom: 10,
  },
  gateRowSelected: { borderColor: colors.brand, backgroundColor: colors.brandSoft },
  gateName: { fontSize: 15, fontWeight: 600, color: colors.text },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: colors.borderStrong, alignItems: 'center', justifyContent: 'center' },
  radioSelected: { borderColor: colors.brand },
  radioDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.brand },
});
