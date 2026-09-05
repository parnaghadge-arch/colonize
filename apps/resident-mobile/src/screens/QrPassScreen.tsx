/**
 * QR pass — the resident shows this at the gate; the guard's camera scans it.
 *
 * The image is a server-rendered data URL (GET /visitors/{id}/qr). The raw signed token is
 * also shown: a guard without camera access can enter it manually in the security app.
 */

import React, { useCallback, useState } from 'react';
import { Image, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';

import { Alert, Card, KV, Loading, Screen, ScreenTitle, colors } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { formatDateTime } from '../lib/format.ts';
import type { QrPass } from '../lib/types.ts';
import type { StackScreenProps } from '../nav.ts';

type Props = StackScreenProps<'QrPass'>;

export function QrPassScreen({ route }: Props) {
  const { visitorId } = route.params;
  const [pass, setPass] = useState<QrPass | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPass(await api.get<QrPass>(`/visitors/${visitorId}/qr`));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the pass.');
    } finally {
      setLoading(false);
    }
  }, [visitorId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const share = async () => {
    if (!pass) return;
    await Share.share({
      message: `Colonize gate pass for ${pass.visitor?.name ?? 'my visitor'} at ${pass.visitor?.purpose ?? 'my society'}.\nPass token (for manual entry at the gate):\n${pass.token}`,
    });
  };

  if (loading && !pass) return <Screen scroll={false}><Loading label="Fetching your pass…" /></Screen>;

  return (
    <Screen>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {pass ? (
        <>
          <Card style={styles.passCard}>
            <Text style={styles.passTitle}>Gate pass</Text>
            <View style={styles.qrBox}>
              <Image source={{ uri: pass.dataUrl }} style={styles.qr} resizeMode="contain" />
            </View>
            {pass.visitor?.name ? <Text style={styles.visitorName}>{pass.visitor.name}</Text> : null}
            {pass.visitor?.purpose ? <Text style={styles.visitorPurpose}>{pass.visitor.purpose}</Text> : null}
          </Card>

          <Card>
            <KV label="Valid from" value={formatDateTime(pass.validFrom)} />
            <KV label="Valid till" value={formatDateTime(pass.validTill)} />
            <KV label="Entries used" value={`${pass.entriesUsed ?? 0} / ${pass.maxEntries ?? 1}`} />
          </Card>

          <Card>
            <Text style={styles.tokenLabel}>Manual token (if the gate has no camera)</Text>
            <Text style={styles.token} selectable>
              {pass.token}
            </Text>
          </Card>

          <View style={{ flexDirection: 'row', gap: 10 }}>
            <Pressable style={{ flex: 1 }} onPress={() => void load()}>
              <View style={styles.ghostBtn}>
                <Text style={styles.ghostBtnLabel}>Refresh</Text>
              </View>
            </Pressable>
            <Pressable style={{ flex: 1 }} onPress={() => void share()}>
              <View style={[styles.ghostBtn, { backgroundColor: colors.brand }]}>
                <Text style={[styles.ghostBtnLabel, { color: '#fff' }]}>Share pass</Text>
              </View>
            </Pressable>
          </View>
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  passCard: { alignItems: 'center', padding: 22, gap: 8 },
  passTitle: { fontSize: 13, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 1 },
  qrBox: {
    width: 220,
    height: 220,
    borderRadius: 14,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 12,
  },
  qr: { width: '100%', height: '100%' },
  visitorName: { fontSize: 17, fontWeight: '700', color: colors.text },
  visitorPurpose: { fontSize: 13, color: colors.textMuted },
  tokenLabel: { fontSize: 12.5, color: colors.textMuted, marginBottom: 6 },
  token: { fontFamily: 'monospace', fontSize: 11.5, color: colors.text, lineHeight: 17 },
  ghostBtn: { borderRadius: 10, paddingVertical: 12, alignItems: 'center', backgroundColor: colors.brandSoft, borderWidth: 1, borderColor: 'transparent' },
  ghostBtnLabel: { color: colors.brandDark, fontWeight: 600, fontSize: 14 },
});
