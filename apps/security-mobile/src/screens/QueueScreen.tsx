/**
 * Queue — the live gate queue: who is waiting, who is approved but not in, who is inside.
 *
 *   • AWAITING_APPROVAL → Approve / Reject (POST /visitors/{id}/decide)
 *   • APPROVED / PRE_APPROVED → manual Check-in (POST /visitors/{id}/check-in)
 *   • INSIDE → manual Check-out (POST /visitors/{id}/check-out)
 *
 * QR scanning lives in the Scan tab; these buttons are the manual fallback.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Alert, Button, Card, EmptyState, Loading, Screen, Stat, StatusChip, colors } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { durationSince, formatTime, friendlyStatus } from '../lib/format.ts';
import { useSession } from '../lib/session.tsx';
import type { GateQueue, QueueVisitor } from '../lib/types.ts';
import type { ConsoleTabScreenProps } from '../nav.ts';

type Props = ConsoleTabScreenProps<'Queue'>;

export function QueueScreen(_props: Props) {
  const { gateId } = useSession();
  const [queue, setQueue] = useState<GateQueue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setQueue(await api.get<GateQueue>('/gate/queue', gateId ? { gateId } : undefined));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the gate queue.');
    }
  }, [gateId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Light auto-refresh: a gate queue changes constantly and guards should not have to.
  useEffect(() => {
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const decide = async (v: QueueVisitor, decision: 'APPROVE' | 'REJECT') => {
    setBusyId(v.id);
    setError(null);
    setNotice(null);
    try {
      await api.post(`/visitors/${v.id}/decide`, { decision });
      setNotice(`${v.visitorName} — ${decision.toLowerCase()}.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Decision failed.');
    } finally {
      setBusyId(null);
    }
  };

  const checkIn = async (v: QueueVisitor) => {
    setBusyId(v.id);
    setError(null);
    setNotice(null);
    try {
      await api.post(`/visitors/${v.id}/check-in`, { ...(gateId ? { gateId } : {}) });
      setNotice(`${v.visitorName} checked in.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Check-in failed.');
    } finally {
      setBusyId(null);
    }
  };

  const checkOut = async (v: QueueVisitor) => {
    setBusyId(v.id);
    setError(null);
    setNotice(null);
    try {
      const result = await api.post<{ durationMinutes?: number }>(`/visitors/${v.id}/check-out`, {
        ...(gateId ? { gateId } : {}),
      });
      setNotice(`${v.visitorName} checked out${typeof result.durationMinutes === 'number' ? ` after ${result.durationMinutes} min` : ''}.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Check-out failed.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Screen>
      <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.brand} />
      {queue ? (
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 14 }}>
          <Stat label="Awaiting" value={queue.counts?.awaiting ?? 0} tone={queue.counts?.awaiting ? 'warning' : 'default'} />
          <Stat label="Inside" value={queue.counts?.inside ?? 0} tone="info" />
          <Stat label="In today" value={queue.counts?.entriesToday ?? 0} tone="success" />
          <Stat label="Out today" value={queue.counts?.exitsToday ?? 0} />
        </View>
      ) : null}

      {error ? <Alert tone="error">{error}</Alert> : null}
      {notice ? <Alert tone="success">{notice}</Alert> : null}

      {!queue ? (
        <Loading label="Loading the gate queue…" />
      ) : (
        <ScrollView>
          <SectionTitle title={`Awaiting approval (${queue.awaitingApproval.length})`} />
          {queue.awaitingApproval.length === 0 ? (
            <EmptyState title="Nobody waiting" subtitle="New pre-approvals and at-gate registrations appear here." />
          ) : (
            queue.awaitingApproval.map((v) => (
              <QueueCard key={v.id} visitor={v} busy={busyId === v.id}>
                <View style={styles.actionRow}>
                  <Button label="Approve" variant="success" onPress={() => void decide(v, 'APPROVE')} loading={busyId === v.id} style={styles.halfBtn} />
                  <Button label="Reject" variant="danger" onPress={() => void decide(v, 'REJECT')} disabled={busyId === v.id} style={styles.halfBtn} />
                </View>
              </QueueCard>
            ))
          )}

          <SectionTitle title={`Approved — not entered (${queue.approvedNotEntered.length})`} />
          {queue.approvedNotEntered.length === 0 ? (
            <EmptyState title="All approved visitors are in" />
          ) : (
            queue.approvedNotEntered.map((v) => (
              <QueueCard key={v.id} visitor={v} busy={busyId === v.id}>
                <Text style={styles.hint}>{v.hasPass ? 'They have a QR pass — scan it, or use manual check-in.' : 'No QR pass — use manual check-in.'}</Text>
                <Button label="Manual check-in" onPress={() => void checkIn(v)} loading={busyId === v.id} style={{ marginTop: 8 }} />
              </QueueCard>
            ))
          )}

          <SectionTitle title={`Inside (${queue.inside.length})`} />
          {queue.inside.length === 0 ? (
            <EmptyState title="Nobody inside" />
          ) : (
            queue.inside.map((v) => (
              <QueueCard key={v.id} visitor={v} busy={busyId === v.id}>
                {v.entryTime ? <Text style={styles.hint}>Entered {formatTime(v.entryTime)} · {durationSince(v.entryTime)} ago</Text> : null}
                <Button label="Manual check-out" variant="secondary" onPress={() => void checkOut(v)} loading={busyId === v.id} style={{ marginTop: 8 }} />
              </QueueCard>
            ))
          )}
        </ScrollView>
      )}
    </Screen>
  );
}

function SectionTitle({ title }: { title: string }) {
  return <Text style={styles.sectionTitle}>{title}</Text>;
}

function QueueCard({ visitor, busy, children }: { visitor: QueueVisitor; busy: boolean; children: React.ReactNode }) {
  return (
    <Card style={busy ? { opacity: 0.7 } : undefined}>
      <View style={styles.headRow}>
        <View style={{ flex: 1, gap: 3 }}>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <Text style={styles.name}>{visitor.visitorName}</Text>
            <StatusChip status={visitor.status} />
          </View>
          <Text style={styles.meta} numberOfLines={1}>
            {[visitor.purpose, visitor.unit?.label ? `→ ${visitor.unit.label}` : null].filter(Boolean).join(' · ')}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {[
              visitor.visitorType ? friendlyStatus(visitor.visitorType) : null,
              visitor.numberOfVisitors && visitor.numberOfVisitors > 1 ? `${visitor.numberOfVisitors} people` : null,
              visitor.vehicleNumber ?? null,
              visitor.visitorPhone ?? null,
            ]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        </View>
        {visitor.createdAt ? (
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={styles.waiting}>{durationSince(visitor.createdAt)}</Text>
            <Text style={styles.meta}>waiting</Text>
          </View>
        ) : null}
      </View>
      <View style={{ marginTop: 10 }}>{children}</View>
    </Card>
  );
}

const styles = StyleSheet.create({
  sectionTitle: { fontSize: 13, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.6, marginVertical: 12 },
  headRow: { flexDirection: 'row', gap: 10 },
  name: { fontSize: 15, fontWeight: '700', color: colors.text },
  meta: { fontSize: 12.5, color: colors.textMuted },
  waiting: { fontSize: 13, fontWeight: '700', color: colors.warning },
  hint: { fontSize: 12.5, color: colors.textFaint, lineHeight: 18 },
  actionRow: { flexDirection: 'row', gap: 8 },
  halfBtn: { flex: 1 },
});
