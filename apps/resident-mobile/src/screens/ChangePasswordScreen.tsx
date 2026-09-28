/**
 * Change password — forced after the temporary first sign-in, and available later from Profile.
 *
 * Uses the existing `POST /auth/change-password` (current + new). The temporary password
 * for every resident is Resident@123; the server rejects keeping it.
 */

import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { Alert, Button, Card, Field, Screen, ScreenTitle, colors } from '../components/ui.tsx';
import { api, ApiError } from '../lib/api.ts';
import { useSession } from '../lib/session.tsx';

const TEMPORARY_PASSWORD = 'Resident@123';

function passwordProblem(value: string): string | null {
  if (value.length < 8) return 'Use at least 8 characters.';
  if (!/[a-zA-Z]/.test(value) || !/[0-9]/.test(value)) return 'Include at least one letter and one number.';
  if (value === TEMPORARY_PASSWORD) return 'Choose something other than the temporary password.';
  return null;
}

export function ChangePasswordForm({
  forced = false,
  onChanged,
}: {
  forced?: boolean;
  onChanged?: () => void;
}) {
  const { refresh } = useSession();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    setNotice(null);
    if (!current) return setError('Enter your current password.');
    const problem = passwordProblem(next);
    if (problem) return setError(problem);
    if (next !== confirm) return setError('The two new passwords do not match.');
    if (next === current) return setError('Choose a password that is different from the current one.');

    setBusy(true);
    try {
      await api.post('/auth/change-password', { currentPassword: current, newPassword: next });
      setCurrent('');
      setNext('');
      setConfirm('');
      await refresh();
      setNotice('Password updated.');
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change the password.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      {forced ? (
        <Text style={styles.hint}>
          Your first password is {TEMPORARY_PASSWORD}. Enter it below, then choose a password only you know.
        </Text>
      ) : (
        <Text style={styles.hint}>Use your current password. At least 8 characters, with a letter and a number.</Text>
      )}
      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      <Field label="Current password" value={current} onChangeText={setCurrent} placeholder={forced ? TEMPORARY_PASSWORD : 'Current password'} secureTextEntry />
      <Field label="New password" value={next} onChangeText={setNext} placeholder="A new password" secureTextEntry />
      <Field label="Confirm new password" value={confirm} onChangeText={setConfirm} placeholder="Repeat the new password" secureTextEntry />
      <Button label={forced ? 'Save and continue' : 'Update password'} onPress={() => void submit()} loading={busy} />
    </Card>
  );
}

/** The only screen a resident sees until they replace the temporary password. */
export function ChangePasswordScreen() {
  const { logout } = useSession();
  const [busy, setBusy] = useState(false);

  return (
    <Screen>
      <ScreenTitle title="Change your password" subtitle="This is required before you can use the app" />
      <ChangePasswordForm forced />
      <View style={{ height: 12 }} />
      <Button
        label="Sign out"
        variant="ghost"
        loading={busy}
        onPress={() => {
          setBusy(true);
          void logout().finally(() => setBusy(false));
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  hint: { fontSize: 13.5, color: colors.textMuted, lineHeight: 19, marginBottom: 12 },
});
