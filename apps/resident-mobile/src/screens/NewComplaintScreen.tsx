/** Raise a complaint — category, title, description, priority, location. */

import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';

import { Alert, Button, Card, ChoiceRow, Field, Screen, ScreenTitle, colors } from '../components/ui.tsx';
import { api, ApiError } from '../lib/api.ts';
import { useSession } from '../lib/session.tsx';
import { COMPLAINT_CATEGORIES, COMPLAINT_PRIORITIES, type ComplaintCategory } from '../lib/types.ts';
import type { RootStackParamList } from '../nav.ts';

type Nav = NativeStackNavigationProp<RootStackParamList>;

export function NewComplaintScreen() {
  const navigation = useNavigation<Nav>();
  const { who } = useSession();

  const [category, setCategory] = useState<ComplaintCategory | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<(typeof COMPLAINT_PRIORITIES)[number]>('MEDIUM');
  const [locationType, setLocationType] = useState<'UNIT' | 'COMMON_AREA' | 'AMENITY'>('UNIT');
  const [locationText, setLocationText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const submit = async () => {
    const localErrors: Record<string, string> = {};
    if (!category) localErrors.category = 'Pick a category.';
    if (title.trim().length < 3) localErrors.title = 'Give it a short title (3+ characters).';
    if (description.trim().length < 3) localErrors.description = 'Describe the issue (3+ characters).';
    setFieldErrors(localErrors);
    if (Object.keys(localErrors).length > 0) return;

    setBusy(true);
    setError(null);
    try {
      const unitId = who?.membership?.primaryUnitId ?? null;
      const created = await api.post<{ _id?: string; complaint?: { _id: string } }>('/complaints', {
        category,
        title: title.trim(),
        description: description.trim(),
        priority,
        locationType,
        ...(locationType === 'UNIT' && unitId ? { unitId } : {}),
        ...(locationText.trim() ? { locationText: locationText.trim() } : {}),
      });
      const complaintId = created.complaint?._id ?? created._id;
      if (!complaintId) throw new Error('The server did not return the new complaint id');
      navigation.replace('ComplaintDetail', { id: complaintId });
    } catch (err) {
      if (err instanceof ApiError) {
        const mapped: Record<string, string> = {};
        for (const fe of err.fieldErrors) if (fe.field) mapped[fe.field] = fe.message;
        setFieldErrors(mapped);
        setError(err.message);
      } else {
        setError('Could not raise the complaint.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <ScreenTitle title="New complaint" subtitle="Tell us what needs fixing" />
      {error ? <Alert tone="error">{error}</Alert> : null}

      <Card>
        <Text style={styles.label}>Category</Text>
        {fieldErrors.category ? <Text style={styles.errorText}>{fieldErrors.category}</Text> : null}
        <ChoiceRow options={COMPLAINT_CATEGORIES} value={category} onSelect={setCategory} columns={3} />

        <Field label="Title" value={title} onChangeText={setTitle} placeholder="e.g. Water leakage in the bathroom" error={fieldErrors.title} />
        <Field
          label="Description"
          value={description}
          onChangeText={setDescription}
          placeholder="What is happening, since when, any photos for the caretaker…"
          multiline
          error={fieldErrors.description}
        />

        <Text style={styles.label}>Priority</Text>
        <ChoiceRow options={COMPLAINT_PRIORITIES} value={priority} onSelect={setPriority} columns={4} />

        <Text style={styles.label}>Location</Text>
        <ChoiceRow options={['UNIT', 'COMMON_AREA', 'AMENITY'] as const} value={locationType} onSelect={setLocationType} columns={3} />
        {locationType !== 'UNIT' ? (
          <Field label="Where exactly?" value={locationText} onChangeText={setLocationText} placeholder="e.g. Gym floor, near the mirrors" hint="Only needed for common areas / amenities." />
        ) : (
          <Text style={styles.hint}>Will be filed against your registered unit.</Text>
        )}
      </Card>

      <Button label="Submit complaint" onPress={() => void submit()} loading={busy} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 13, fontWeight: '600', color: colors.textMuted, marginBottom: 6 },
  errorText: { color: colors.danger, fontSize: 12.5, marginBottom: 6 },
  hint: { fontSize: 12.5, color: colors.textFaint, marginTop: 4 },
});
