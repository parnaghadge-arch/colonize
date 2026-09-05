/**
 * Guard sign-in — password only (guards are staff accounts issued login credentials by the
 * society). The "API server" override works exactly like in the resident app.
 */

import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Alert, Button, Field, colors } from '../components/ui.tsx';
import { ApiError, resolveBaseUrl, setApiBaseUrl } from '../lib/api.ts';
import { secureStore } from '../lib/storage.ts';
import { useSession } from '../lib/session.tsx';

export function LoginScreen() {
  const session = useSession();

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [showServer, setShowServer] = useState(false);
  const [serverUrl, setServerUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const baseUrl = resolveBaseUrl();

  const submit = async () => {
    setError(null);
    setNotice(null);
    if (identifier.trim().length < 3) return setError('Enter your phone number or email.');
    if (!password) return setError('Enter your password.');
    setBusy(true);
    try {
      await session.login(identifier.trim(), password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  };

  const saveServer = async () => {
    setError(null);
    const url = serverUrl.trim();
    if (url) {
      try {
        new URL(url);
      } catch {
        setError('Enter a full URL, e.g. http://192.168.1.20:4000/api');
        return;
      }
      await secureStore.setItem('apiBaseUrl', url);
      setApiBaseUrl(url);
      setNotice('API server saved.');
    } else {
      await secureStore.deleteItem('apiBaseUrl');
      setApiBaseUrl(null);
      setNotice('Using the default API server for this platform.');
    }
    setShowServer(false);
  };

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right', 'bottom']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <View style={styles.logo}>
            <View style={styles.logoMark}>
              <Text style={styles.logoMarkText}>🛡</Text>
            </View>
            <Text style={styles.appName}>Colonize Security</Text>
            <Text style={styles.tagline}>Gate console for duty guards</Text>
          </View>

          {error ? <Alert tone="error">{error}</Alert> : null}
          {notice ? <Alert tone="info">{notice}</Alert> : null}

          <Field label="Phone or email" value={identifier} onChangeText={setIdentifier} placeholder="+91…" keyboardType="phone-pad" />
          <Field label="Password" value={password} onChangeText={setPassword} placeholder="Your guard password" secureTextEntry />
          <Button label="Sign in" onPress={() => void submit()} loading={busy} />

          <Pressable
            onPress={() => {
              setServerUrl(baseUrl);
              setShowServer((v) => !v);
            }}
            style={{ marginTop: 26, alignSelf: 'center' }}
          >
            <Text style={{ color: colors.textFaint, fontSize: 13 }}>API server: {baseUrl}</Text>
          </Pressable>

          {showServer ? (
            <View style={{ marginTop: 10, gap: 10, alignItems: 'stretch' }}>
              <Field
                label="Base URL (blank = platform default)"
                value={serverUrl}
                onChangeText={setServerUrl}
                placeholder="http://192.168.1.20:4000/api"
                hint="For a phone on your Wi-Fi, use the computer's LAN IP."
              />
              <Button label="Save server" onPress={() => void saveServer()} variant="secondary" />
            </View>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 24, paddingBottom: 48, flexGrow: 1 },
  logo: { alignItems: 'center', marginTop: 40, marginBottom: 32 },
  logoMark: {
    width: 64,
    height: 64,
    borderRadius: 18,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  logoMarkText: { fontSize: 30 },
  appName: { fontSize: 25, fontWeight: '800', color: colors.text, letterSpacing: -0.5 },
  tagline: { fontSize: 14, color: colors.textMuted, marginTop: 4 },
});
