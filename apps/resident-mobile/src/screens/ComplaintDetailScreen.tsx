/** Complaint detail — status, timeline of comments, and the resident's verify action. */

import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Alert, Button, Card, KV, Loading, Screen, StatusChip, colors } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { formatDateTime, friendlyStatus } from '../lib/format.ts';
import type { Complaint, ComplaintComment } from '../lib/types.ts';
import type { StackScreenProps } from '../nav.ts';

type Props = StackScreenProps<'ComplaintDetail'>;

export function ComplaintDetailScreen({ route, navigation }: Props) {
  const { id } = route.params;
  const [complaint, setComplaint] = useState<Complaint | null>(null);
  const [comments, setComments] = useState<ComplaintComment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const c = await api.get<Complaint>(`/complaints/${id}`);
      setComplaint(c);
      try {
        const cs = await api.get<ComplaintComment[] | { items?: ComplaintComment[] }>(`/complaints/${id}/comments`);
        setComments(Array.isArray(cs) ? cs : (cs.items ?? []));
      } catch {
        setComments([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the complaint.');
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const verify = async () => {
    setActionBusy(true);
    setError(null);
    try {
      await api.post(`/complaints/${id}/verify`, { note: 'Verified by resident' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not verify the complaint.');
    } finally {
      setActionBusy(false);
    }
  };

  const reopen = async () => {
    setActionBusy(true);
    setError(null);
    try {
      await api.post(`/complaints/${id}/reopen`, { note: 'Reopened by resident' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reopen the complaint.');
    } finally {
      setActionBusy(false);
    }
  };

  if (!complaint && !error) return <Screen scroll={false}><Loading /></Screen>;

  const status = String(complaint?.status ?? '').toUpperCase();
  const verifiable = ['RESOLVED', 'IN_PROGRESS', 'ASSIGNED', 'COMPLETED'].includes(status);
  const reopenable = ['CLOSED', 'CANCELLED', 'CANCELED'].includes(status);

  return (
    <Screen>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {complaint ? (
        <>
          <Card>
            <View style={styles.head}>
              <View style={{ flex: 1 }}>
                <Text style={styles.ref}>{complaint.referenceNumber ?? ''}</Text>
                <Text style={styles.title}>{complaint.title}</Text>
              </View>
              <StatusChip status={complaint.status} />
            </View>
            {complaint.description ? <Text style={styles.desc}>{complaint.description}</Text> : null}
          </Card>

          <Card>
            <KV label="Category" value={friendlyStatus(complaint.category)} />
            <KV label="Priority" value={complaint.priority ?? '—'} />
            <KV label="Location" value={complaint.unitLabel ?? complaint.locationText ?? complaint.locationType ?? '—'} />
            <KV label="Raised" value={formatDateTime(complaint.createdAt)} />
            <KV label="Assignee" value={complaint.assigneeName ?? 'Not assigned yet'} />
            <KV label="Work order" value={complaint.workOrderId ? `WO · ${String(complaint.workOrderId).slice(-8)}` : '—'} />
          </Card>

          {verifiable ? (
            <Button label="Mark as verified & closed" onPress={() => void verify()} loading={actionBusy} />
          ) : null}
          {reopenable ? (
            <Button label="Reopen this complaint" variant="secondary" onPress={() => void reopen()} loading={actionBusy} style={{ marginTop: 10 }} />
          ) : null}

          <Card style={{ marginTop: 12 }}>
            <Text style={styles.sectionTitle}>Activity</Text>
            {comments.length === 0 ? (
              <Text style={styles.muted}>No updates yet.</Text>
            ) : (
              comments.slice().reverse().map((c, i) => (
                <View key={c._id ?? i} style={styles.timelineItem}>
                  <View style={styles.timelineDot} />
                  <View style={{ flex: 1, paddingLeft: 12 }}>
                    <Text style={styles.timelineMeta}>
                      {c.authorName ? `${c.authorName} · ` : ''}
                      {formatDateTime(c.createdAt)}
                    </Text>
                    <Text style={styles.timelineBody}>{c.body ?? c.comment ?? ''}</Text>
                  </View>
                </View>
              ))
            )}
          </Card>
        </>
      ) : null}
      <Pressable onPress={() => navigation.goBack()} style={{ alignSelf: 'center', marginTop: 8 }}>
        <Text style={{ color: colors.textFaint }}>Done</Text>
      </Pressable>
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  ref: { fontSize: 12, color: colors.textFaint, fontFamily: 'monospace' },
  title: { fontSize: 17, fontWeight: '700', color: colors.text, marginTop: 2 },
  desc: { fontSize: 14, color: colors.textMuted, marginTop: 10, lineHeight: 20 },
  sectionTitle: { fontSize: 15, fontWeight: 600, color: colors.text, marginBottom: 10 },
  muted: { fontSize: 13.5, color: colors.textMuted },
  timelineItem: { flexDirection: 'row', gap: 8, paddingBottom: 14 },
  timelineDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.brand, marginTop: 6 },
  timelineMeta: { fontSize: 11.5, color: colors.textFaint },
  timelineBody: { fontSize: 13.5, color: colors.text, marginTop: 2, lineHeight: 19 },
});
