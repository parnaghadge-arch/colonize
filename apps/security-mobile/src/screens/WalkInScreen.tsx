/**
 * Walk-in registration — a guest who arrives without a resident's pre-approval.
 *
 * The guard records the visitor at the gate (POST /visitors/at-gate). The visitor then
 * appears in the Queue as AWAITING_APPROVAL (the resident approves from their phone) or
 * APPROVED immediately when the society has auto-approval enabled. Unit is picked from a
 * live search (GET /units?search=…) — a guard has no fixed unit of their own.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Alert, Button, Card, Field, Loading, Screen, colors } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { useSession } from '../lib/session.tsx';
import type { StackScreenProps } from '../nav.ts';

type Props = StackScreenProps<'WalkIn'>;

interface UnitOption {
  _id: string;
  unitNumber: string;
  label?: string | null;
}

const VISITOR_TYPES = ['GUEST', 'RELATIVE', 'SERVICE', 'DELIVERY', 'CAB', 'STAFF'];

export function WalkInScreen({ navigation }: Props) {
  const { gateId } = useSession();

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [purpose, setPurpose] = useState('');
  const [visitorType, setVisitorType] = useState('GUEST');
  const [people, setPeople] = useState('1');
  const [vehicle, setVehicle] = useState('');
  const [notes, setNotes] = useState('');

  // Unit search — debounce the typing, keep the latest request winning.
  const [unitQuery, setUnitQuery] = useState('');
  const [unit, setUnit] = useState<UnitOption | null>(null);
  const [results, setResults] = useState<UnitOption[] | null>(null);
  const [searching, setSearching] = useState(false);
  const requestSeq = useRef(0);

  const searchUnits = useCallback(async (q: string) => {
    const seq = ++requestSeq.current;
    if (q.trim().length < 2) {
      setResults(null);
      return;
    }
    setSearching(true);
    try {
      const page = await api.get<{ items: UnitOption[] }>('/units', { search: q.trim(), limit: 6 });
      if (seq !== requestSeq.current) return;
      setResults(page.items ?? []);
    } catch {
      if (seq === requestSeq.current) setResults([]);
    } finally {
      if (seq === requestSeq.current) setSearching(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void searchUnits(unitQuery), 350);
    return () => clearTimeout(t);
  }, [unitQuery, searchUnits]);

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canSubmit = name.trim().length >= 2 && purpose.trim().length >= 2 && unit !== null && !busy;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post('/visitors/at-gate', {
        visitorName: name.trim(),
        unitId: unit!._id,
        purpose: purpose.trim(),
        visitorType,
        numberOfVisitors: Math.max(1, Number(people) || 1),
        ...(phone.trim() ? { visitorPhone: phone.trim() } : {}),
        ...(vehicle.trim() ? { vehicleNumber: vehicle.trim().toUpperCase() } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        ...(gateId ? { gateId } : {}),
      });
      navigation.goBack();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not register the visitor.');
      setBusy(false);
    }
  };

  const typeChip = (t: string) => (
    <Pressable
      key={t}
      onPress={() => setVisitorType(t)}
      style={[styles.typeChip, visitorType === t && styles.typeChipActive]}
    >
      <Text style={[styles.typeChipText, visitorType === t && styles.typeChipTextActive]}>{t}</Text>
    </Pressable>
  );

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: 10 }} keyboardShouldPersistTaps="handled">
        <Text style={styles.intro}>
          Register a guest who is here at the gate now. They will be added to the queue{
            ' — '
          }the resident approves from their phone, or they are admitted directly when auto-
          approval is on.
        </Text>

        <Field
          label="Visitor name"
          value={name}
          onChangeText={setName}
          placeholder="Full name"
          autoCapitalize="words"
          autoCorrect
        />

        <Text style={styles.fieldLabel}>Unit</Text>
        {unit ? (
          <Card style={{ marginBottom: 14 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <View style={{ flex: 1 }}>
                <Text style={styles.unitLabel}>{unit.label ?? unit.unitNumber}</Text>
                <Text style={styles.unitMeta}>Unit {unit.unitNumber}</Text>
              </View>
              <Pressable
                onPress={() => {
                  setUnit(null);
                  setResults(null);
                }}
              >
                <Text style={styles.unitChange}>Change</Text>
              </Pressable>
            </View>
          </Card>
        ) : (
          <View style={{ marginBottom: 14 }}>
            <Field
              label="Search unit"
              value={unitQuery}
              onChangeText={(t) => {
                setUnitQuery(t);
                setResults(null);
              }}
              placeholder="e.g. E4401 or wing + number"
            />
            {searching ? <Loading label="Searching units…" /> : null}
            {results && results.length > 0 ? (
              <Card>
                {results.map((u) => (
                  <Pressable key={u._id} onPress={() => { setUnit(u); setResults(null); }} style={styles.resultRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.unitLabel}>{u.label ?? u.unitNumber}</Text>
                      <Text style={styles.unitMeta}>Unit {u.unitNumber}</Text>
                    </View>
                    <Text style={styles.unitPick}>Select ›</Text>
                  </Pressable>
                ))}
              </Card>
            ) : null}
            {results && results.length === 0 ? (
              <Text style={styles.hint}>No unit matches that search.</Text>
            ) : null}
          </View>
        )}

        <Field
          label="Phone (optional)"
          value={phone}
          onChangeText={setPhone}
          placeholder="+91 …"
          keyboardType="phone-pad"
        />

        <Field
          label="Purpose"
          value={purpose}
          onChangeText={setPurpose}
          placeholder="Maintenance, delivery, guest…"
          autoCapitalize="sentences"
        />

        <Text style={styles.fieldLabel}>Visitor type</Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
          {VISITOR_TYPES.map(typeChip)}
        </View>

        <View style={{ flexDirection: 'row', gap: 10 }}>
          <View style={{ flex: 1 }}>
            <Field label="People" value={people} onChangeText={setPeople} keyboardType="numeric" />
          </View>
          <View style={{ flex: 1.4 }}>
            <Field label="Vehicle (optional)" value={vehicle} onChangeText={setVehicle} placeholder="MH 12 AB 1234" />
          </View>
        </View>

        <Field label="Notes (optional)" value={notes} onChangeText={setNotes} multiline hint="Anything the resident or the log should know." />

        {error ? <Alert tone="error">{error}</Alert> : null}

        <Button label={busy ? 'Registering…' : 'Add to gate queue'} onPress={submit} disabled={!canSubmit} />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  intro: { fontSize: 13, lineHeight: 18, color: colors.textMuted, marginBottom: 4 },
  fieldLabel: { fontSize: 13, fontWeight: '600', color: colors.text, marginBottom: 6 },
  unitLabel: { fontSize: 14, fontWeight: '600', color: colors.text },
  unitMeta: { fontSize: 12, color: colors.textMuted },
  unitChange: { color: colors.brand, fontWeight: '600', fontSize: 13 },
  unitPick: { color: colors.brand, fontWeight: '600', fontSize: 13 },
  resultRow: { paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 8 },
  hint: { fontSize: 12.5, color: colors.textMuted, marginTop: 6 },
  typeChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  typeChipActive: { backgroundColor: colors.brandSoft, borderColor: colors.brand },
  typeChipText: { fontSize: 12, fontWeight: '600', color: colors.textMuted },
  typeChipTextActive: { color: colors.brandDark },
});
