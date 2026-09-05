/** Profile — who is signed in, which society, and the sign-out action. */

import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Alert, Button, Card, KV, Screen, ScreenTitle, colors } from '../components/ui.tsx';
import { useSession } from '../lib/session.tsx';

export function ProfileScreen() {
  const { who, logout, refresh } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signOut = async () => {
    setBusy(true);
    setError(null);
    try {
      await logout();
    } catch {
      setError('Could not sign out — your session is still active on the server.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <ScreenTitle title="Profile" subtitle={who?.society?.name} />
      {error ? <Alert tone="error">{error}</Alert> : null}

      <Card style={{ alignItems: 'center', marginBottom: 14 }}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{(who?.user?.fullName ?? '?').slice(0, 1).toUpperCase()}</Text>
        </View>
        <Text style={styles.name}>{who?.user?.fullName}</Text>
        <Text style={styles.roles}>{(who?.user?.roles ?? []).join(' · ')}</Text>
      </Card>

      <Card>
        <KV label="Email" value={who?.user?.email ?? '—'} />
        <KV label="Phone" value={who?.user?.phone ?? '—'} />
      </Card>

      <Card>
        <KV label="Society" value={who?.society?.name ?? '—'} />
        <KV label="Timezone" value={who?.society?.timezone ?? '—'} />
        <KV label="Currency" value={who?.society?.currency ?? '—'} />
        <KV label="Primary unit" value={who?.membership?.primaryUnitId ? 'Linked' : 'Not linked'} />
      </Card>

      <Card>
        <KV label="Modules enabled" value={String(who?.enabledModules?.length ?? 0)} />
        <Text style={styles.modules} numberOfLines={4}>
          {(who?.enabledModules ?? []).join(', ')}
        </Text>
      </Card>

      <Button label="Refresh profile" variant="secondary" onPress={() => void refresh()} style={{ marginBottom: 10 }} />
      <Button label="Sign out" variant="danger" onPress={() => void signOut()} loading={busy} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.brand,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },
  avatarText: { color: '#fff', fontSize: 28, fontWeight: '800' },
  name: { fontSize: 17, fontWeight: '700', color: colors.text },
  roles: { fontSize: 13, color: colors.textMuted, marginTop: 4 },
  modules: { fontSize: 12.5, color: colors.textMuted, marginTop: 6, lineHeight: 18 },
});
