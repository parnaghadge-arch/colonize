/**
 * Login — password or OTP, exactly as the API exposes it.
 *
 * Development note: when the API runs with EXPOSE_DEV_OTP=true the OTP arrives in the
 * send-otp response (`meta.devOtp`) and is shown on screen — same convention as the web
 * console, so a developer without an SMS gateway can still walk the OTP flow.
 */

import React, { useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Alert, Button, Field, colors } from '../components/ui.tsx';
import { ApiError, resolveBaseUrl, setApiBaseUrl } from '../lib/api.ts';
import { secureStore } from '../lib/storage.ts';
import { useSession } from '../lib/session.tsx';

type Mode = 'password' | 'otp';

export function LoginScreen() {
  const session = useSession();

  const [mode, setMode] = useState<Mode>('password');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [challenge, setChallenge] = useState<{ maskedTarget: string; devOtp?: string } | null>(null);
  const [showServer, setShowServer] = useState(false);
  const [serverUrl, setServerUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const baseUrl = useMemo(() => resolveBaseUrl(), [showServer]); // eslint-disable-line react-hooks/exhaustive-deps

  const submitPassword = async () => {
    setError(null);
    setNotice(null);
    if (identifier.trim().length < 3) return setError('Enter your email or phone number.');
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

  const requestOtp = async () => {
    setError(null);
    setNotice(null);
    setChallenge(null);
    const digits = phone.replace(/[\s-]/g, '');
    if (!/^[+]?[0-9]{10,15}$/.test(digits)) return setError('Enter a valid mobile number (with country code).');
    setBusy(true);
    try {
      const result = await session.sendOtp(digits);
      setChallenge({ maskedTarget: result.maskedTarget, devOtp: result.devOtp });
      setNotice(`OTP sent to ${result.maskedTarget}.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send the OTP.');
    } finally {
      setBusy(false);
    }
  };

  const submitOtp = async () => {
    setError(null);
    if (otp.trim().length < 4) return setError('Enter the OTP code.');
    setBusy(true);
    try {
      await session.verifyOtp(phone, otp.trim());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not verify the OTP.');
    } finally {
      setBusy(false);
    }
  };

  const saveServer = async () => {
    setError(null);
    setNotice(null);
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
      setServerUrl(url);
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
              <Text style={styles.logoMarkText}>C</Text>
            </View>
            <Text style={styles.appName}>Colonize</Text>
            <Text style={styles.tagline}>Your society, in your pocket</Text>
          </View>

          <View style={styles.modeTabs}>
            {(['password', 'otp'] as const).map((m) => (
              <Pressable key={m} onPress={() => { setMode(m); setError(null); }} style={[styles.modeTab, mode === m && styles.modeTabActive]}>
                <Text style={[styles.modeTabLabel, mode === m && { color: colors.brandDark, fontWeight: '700' }]}>
                  {m === 'password' ? 'Password' : 'OTP'}
                </Text>
              </Pressable>
            ))}
          </View>

          {error ? <Alert tone="error">{error}</Alert> : null}
          {notice ? <Alert tone="info">{notice}</Alert> : null}

          {mode === 'password' ? (
            <>
              <Field label="Email or phone" value={identifier} onChangeText={setIdentifier} placeholder="you@society.com or +91…" keyboardType="phone-pad" />
              <Field label="Password" value={password} onChangeText={setPassword} placeholder="Your password" secureTextEntry />
              <Button label="Sign in" onPress={() => void submitPassword()} loading={busy} />
            </>
          ) : (
            <>
              <Field label="Mobile number" value={phone} onChangeText={(t) => setPhone(t)} placeholder="+91 98…" keyboardType="phone-pad" hint="The OTP is sent to this number." />
              {challenge?.devOtp ? <Alert tone="warning">Development OTP (EXPOSE_DEV_OTP): {challenge.devOtp}</Alert> : null}
              {!challenge ? (
                <Button label="Send OTP" onPress={() => void requestOtp()} loading={busy} />
              ) : (
                <>
                  <Field label="Enter the OTP" value={otp} onChangeText={setOtp} placeholder="6-digit code" keyboardType="numeric" />
                  <Button label="Verify & sign in" onPress={() => void submitOtp()} loading={busy} />
                  <Button label="Resend OTP" variant="ghost" onPress={() => void requestOtp()} disabled={busy} style={{ marginTop: 8 }} />
                </>
              )}
            </>
          )}

          <Pressable onPress={() => { setServerUrl(baseUrl); setShowServer((v) => !v); }} style={{ marginTop: 26, alignSelf: 'center' }}>
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
    backgroundColor: colors.brand,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  logoMarkText: { color: '#fff', fontSize: 32, fontWeight: '800' },
  appName: { fontSize: 26, fontWeight: '800', color: colors.text, letterSpacing: -0.5 },
  tagline: { fontSize: 14, color: colors.textMuted, marginTop: 4 },
  modeTabs: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 4,
    marginBottom: 18,
  },
  modeTab: { flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: 9 },
  modeTabActive: { backgroundColor: colors.brandSoft },
  modeTabLabel: { fontSize: 14, color: colors.textMuted, fontWeight: '600' },
});
