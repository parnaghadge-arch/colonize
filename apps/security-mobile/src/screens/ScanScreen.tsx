/**
 * Scan — the guard's primary action: point the camera at a QR gate pass.
 *
 * The QR payload is an opaque signed token (§12) — no PII travels in the code. The app
 * posts it to POST /gate/scan with the current gate and the action (entry / exit); the
 * server validates the signature, capacity and expiry, records the entry, and tells us
 * the human-readable result. A manual token entry covers cameras that are unavailable
 * (permissions, web, damaged reader).
 */

import React, { useCallback, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';

import { Alert, Button, Card, Field, Screen, ScreenTitle, Stat, colors } from '../components/ui.tsx';
import { api, ApiError } from '../lib/api.ts';
import { formatTime } from '../lib/format.ts';
import { useSession } from '../lib/session.tsx';
import type { ScanResult } from '../lib/types.ts';
import type { ConsoleTabScreenProps } from '../nav.ts';

type Props = ConsoleTabScreenProps<'Scan'>;

type ScanAction = 'CHECK_IN' | 'CHECK_OUT';

interface LastScan {
  ok: boolean;
  message: string;
  kind?: string;
  detail?: string;
  at: number;
}

export function ScanScreen(_props: Props) {
  const { gateId, who } = useSession();
  const [permission, requestPermission] = useCameraPermissions();
  const [action, setAction] = useState<ScanAction>('CHECK_IN');
  const [manualToken, setManualToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<LastScan | null>(null);
  const [cameraOn, setCameraOn] = useState(Platform.OS !== 'web');
  const scanningRef = useRef(false);

  const runScan = useCallback(
    async (token: string) => {
      const clean = token.trim();
      if (clean.length < 10) {
        setLast({ ok: false, message: 'Token too short', at: Date.now() });
        return;
      }
      setBusy(true);
      scanningRef.current = true;
      try {
        // CHECK_IN / CHECK_OUT answer with `{ visitor, entry, … }` and the server's message
        // ("Ravi checked in at Main Gate"). A rejected pass is an HTTP 4xx and lands in
        // the catch below, so a 200 with an entry row is the acceptance.
        const envelope = await api.envelope.post<ScanResult>('/gate/scan', {
          token: clean,
          gateId: gateId ?? undefined,
          action,
        });
        const result = envelope.data;
        const accepted = Boolean(result.entry ?? result.visitor);
        const entity = (result.entity ?? result.visitor ?? null) as { visitorName?: string; name?: string } | null;
        const name = entity?.visitorName ?? entity?.name;
        setLast({
          ok: accepted,
          message: accepted
            ? envelope.message ?? (name ? `${name} — ${action === 'CHECK_IN' ? 'entry recorded' : 'exit recorded'}` : 'Pass accepted')
            : `Rejected: ${result.reason ?? 'invalid pass'}`,
          detail:
            result.entry?.at
              ? `recorded ${formatTime(String(result.entry.at))}`
              : result.durationMinutes !== undefined
                ? `stay: ${result.durationMinutes} min`
                : undefined,
          at: Date.now(),
        });
      } catch (err) {
        setLast({
          ok: false,
          message: err instanceof ApiError ? err.message : 'Scan failed — try again.',
          at: Date.now(),
        });
      } finally {
        setBusy(false);
        scanningRef.current = false;
        setManualToken('');
      }
    },
    [action, gateId],
  );

  const onBarcode = useCallback(
    (data: { data: string }) => {
      if (scanningRef.current) return; // ignore until the previous scan settles
      void runScan(data.data);
    },
    [runScan],
  );

  return (
    <Screen>
      <ScreenTitle title="Gate scan" subtitle={gateId ? `Gate ${gateId.slice(-6)} · ${who?.society?.name ?? ''}` : who?.society?.name} />

      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
        <Pressable style={[styles.actionTab, action === 'CHECK_IN' && styles.actionTabActive]} onPress={() => setAction('CHECK_IN')}>
          <Text style={[styles.actionTabLabel, action === 'CHECK_IN' && { color: '#fff' }]}>Entry</Text>
        </Pressable>
        <Pressable style={[styles.actionTab, action === 'CHECK_OUT' && styles.actionTabExitActive]} onPress={() => setAction('CHECK_OUT')}>
          <Text style={[styles.actionTabLabel, action === 'CHECK_OUT' && { color: '#fff' }]}>Exit</Text>
        </Pressable>
      </View>

      {cameraOn && Platform.OS !== 'web' ? (
        <View style={styles.cameraBox}>
          {permission?.granted ? (
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              enableTorch
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={onBarcode}
            />
          ) : (
            <View style={styles.cameraPlaceholder}>
              <Text style={styles.cameraText}>Camera access is needed to scan passes.</Text>
              <Button label="Allow camera" variant="secondary" onPress={() => void requestPermission()} style={{ alignSelf: 'center', marginTop: 10 }} />
            </View>
          )}
          <View style={styles.reticle} pointerEvents="none" />
        </View>
      ) : (
        <Card>
          <Text style={styles.muted}>
            {Platform.OS === 'web'
              ? 'Camera scanning is unavailable in the browser build — use the manual token below.'
              : 'Camera is off — use the manual token below, or turn the camera back on.'}
          </Text>
          {Platform.OS !== 'web' ? (
            <Button label="Turn camera on" variant="secondary" onPress={() => setCameraOn(true)} style={{ alignSelf: 'center', marginTop: 10 }} />
          ) : null}
        </Card>
      )}

      {last ? (
        <View style={{ marginVertical: 14 }}>
          <Card style={last.ok ? { borderColor: colors.success + '77', backgroundColor: colors.successSoft } : { borderColor: colors.danger + '77', backgroundColor: colors.dangerSoft }}>
            <Text style={[styles.lastTitle, { color: last.ok ? colors.success : colors.danger }]}>{last.ok ? '✓' : '✗'} {last.message}</Text>
            {last.detail ? <Text style={[styles.lastDetail, { color: colors.textMuted }]}>{last.detail}</Text> : null}
          </Card>
        </View>
      ) : null}

      <Card>
        <Field
          label="Manual token (no camera)"
          value={manualToken}
          onChangeText={setManualToken}
          placeholder="Paste or type the pass token"
          hint="Shown under the QR on the resident's pass screen."
        />
        <Button label={`Submit ${action === 'CHECK_IN' ? 'entry' : 'exit'}`} onPress={() => void runScan(manualToken)} loading={busy} disabled={manualToken.trim().length < 10} />
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  actionTab: {
    flex: 1,
    paddingVertical: 11,
    borderRadius: 10,
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  actionTabActive: { backgroundColor: colors.success, borderColor: colors.success },
  actionTabExitActive: { backgroundColor: colors.danger, borderColor: colors.danger },
  actionTabLabel: { fontSize: 15, fontWeight: '700', color: colors.textMuted },
  cameraBox: { height: 300, borderRadius: 14, overflow: 'hidden', marginBottom: 4, backgroundColor: '#000' },
  cameraPlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 20 },
  cameraText: { color: colors.textMuted, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  reticle: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    width: 190,
    height: 190,
    marginLeft: -95,
    marginTop: -95,
    borderWidth: 2.5,
    borderColor: 'rgba(47,129,247,0.9)',
    borderRadius: 16,
  },
  muted: { fontSize: 13.5, color: colors.textMuted, lineHeight: 19 },
  lastTitle: { fontSize: 15, fontWeight: '700' },
  lastDetail: { fontSize: 12.5, marginTop: 4 },
});
