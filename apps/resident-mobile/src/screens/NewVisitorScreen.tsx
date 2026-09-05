/**
 * Invite a visitor — pre-approval with a QR pass (§11).
 *
 * No unitId is sent: the server derives it from the caller's membership. The pass QR is
 * generated server-side and shown in the QrPass screen.
 */

import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Alert, Button, Card, ChoiceRow, Field, Screen, ScreenTitle, colors } from '../components/ui.tsx';
import { api, ApiError } from '../lib/api.ts';
import { hhmm, localDate } from '../lib/format.ts';
import { VISITOR_TYPES } from '../lib/types.ts';
import type { StackScreenProps } from '../nav.ts';

type Props = StackScreenProps<'NewVisitor'>;

export function NewVisitorScreen({ navigation }: Props) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [date, setDate] = useState(localDate());
  const [arrival, setArrival] = useState(hhmm(new Date(Date.now() + 30 * 60 * 1000)));
  const [departure, setDeparture] = useState('');
  const [purpose, setPurpose] = useState('');
  const [type, setType] = useState<(typeof VISITOR_TYPES)[number]>('GUEST');
  const [count, setCount] = useState('1');
  const [vehicle, setVehicle] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const submit = async () => {
    const localErrors: Record<string, string> = {};
    if (name.trim().length < 2) localErrors.name = 'Visitor name is required.';
    if (purpose.trim().length < 2) localErrors.purpose = 'Purpose of visit is required.';
    if (arrival && !/^\d{2}:\d{2}$/.test(arrival)) localErrors.arrival = 'Use HH:MM, e.g. 10:30';
    setFieldErrors(localErrors);
    if (Object.keys(localErrors).length > 0) return;

    setBusy(true);
    setError(null);
    try {
      const created = await api.post<{ _id: string; passId?: string }>('/visitors/pre-approve', {
        visitorName: name.trim(),
        ...(phone.trim() ? { visitorPhone: phone.trim() } : {}),
        visitDate: date,
        expectedArrival: arrival,
        ...(departure ? { expectedDeparture: departure } : {}),
        purpose: purpose.trim(),
        visitorType: type,
        numberOfVisitors: Math.max(1, Math.min(50, Number(count) || 1)),
        ...(vehicle.trim() ? { vehicleNumber: vehicle.trim().toUpperCase() } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        generateQrPass: true,
      });
      navigation.replace('QrPass', { visitorId: created._id });
    } catch (err) {
      if (err instanceof ApiError) {
        const mapped: Record<string, string> = {};
        for (const fe of err.fieldErrors) if (fe.field) mapped[fe.field] = fe.message;
        setFieldErrors(mapped);
        setError(err.message);
      } else {
        setError('Could not create the visit.');
      }
      setBusy(false);
    }
  };

  return (
    <Screen>
      <ScreenTitle title="Invite a visitor" subtitle="They'll get a QR pass for the gate" />
      {error ? <Alert tone="error">{error}</Alert> : null}

      <Card>
        <Field label="Visitor name" value={name} onChangeText={setName} placeholder="Full name" autoCapitalize="words" autoCorrect error={fieldErrors.name} />
        <Field label="Phone (optional)" value={phone} onChangeText={setPhone} placeholder="+91…" keyboardType="phone-pad" error={fieldErrors.phone} />

        <Field label="Date" value={date} onChangeText={(t) => setDate(t.slice(0, 10))} keyboardType="default" hint="Use your keyboard: YYYY-MM-DD (e.g. today)." error={fieldErrors.date} />
        <View style={styles.timeRow}>
          <View style={{ flex: 1 }}>
            <Field label="Expected arrival" value={arrival} onChangeText={setArrival} placeholder="10:30" error={fieldErrors.arrival} />
          </View>
          <View style={{ flex: 1 }}>
            <Field label="Departure (optional)" value={departure} onChangeText={setDeparture} placeholder="13:00" />
          </View>
        </View>

        <Field label="Purpose" value={purpose} onChangeText={setPurpose} placeholder="e.g. Home maintenance" error={fieldErrors.purpose} />

        <Text style={styles.label}>Type</Text>
        <ChoiceRow options={VISITOR_TYPES} value={type} onSelect={setType} columns={3} />

        <View style={styles.timeRow}>
          <View style={{ flex: 1 }}>
            <Field label="People" value={count} onChangeText={setCount} keyboardType="numeric" />
          </View>
          <View style={{ flex: 1 }}>
            <Field label="Vehicle (optional)" value={vehicle} onChangeText={setVehicle} placeholder="MH12AB1234" autoCapitalize="characters" error={fieldErrors.vehicleNumber} />
          </View>
        </View>

        <Field label="Notes (optional)" value={notes} onChangeText={setNotes} placeholder="Gate instructions, ID proof…" multiline />
      </Card>

      <Button label="Create pass" onPress={() => void submit()} loading={busy} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 13, fontWeight: '600', color: colors.textMuted, marginBottom: 6 },
  timeRow: { flexDirection: 'row', gap: 10 },
});
