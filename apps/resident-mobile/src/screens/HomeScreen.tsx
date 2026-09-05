/**
 * Home — the resident's dashboard: money owed, open complaints and upcoming bookings,
 * with one-tap shortcuts into the four daily flows.
 */

import React, { useCallback, useState } from 'react';
import { Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { Alert, Button, Card, EmptyState, Loading, Screen, ScreenTitle, StatusChip, colors } from '../components/ui.tsx';
import { api, fetchPage } from '../lib/api.ts';
import { formatDateTime, formatMoney, initials } from '../lib/format.ts';
import { useSession } from '../lib/session.tsx';
import type { AmenityBooking, Bill, Complaint } from '../lib/types.ts';
import type { TabScreenProps } from '../nav.ts';

type Props = TabScreenProps<'Home'>;

export function HomeScreen({ navigation }: Props) {
  const { who } = useSession();
  const [bills, setBills] = useState<Bill[] | null>(null);
  const [complaints, setComplaints] = useState<Complaint[] | null>(null);
  const [bookings, setBookings] = useState<AmenityBooking[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [billPage, complaintPage, bookingPage] = await Promise.all([
        fetchPage<Bill>('/bills/mine', { limit: 12 }),
        fetchPage<Complaint>('/complaints/mine', { limit: 12 }),
        fetchPage<AmenityBooking>('/amenity-bookings/mine', { limit: 12 }),
      ]);
      setBills(billPage.items);
      setComplaints(complaintPage.items);
      setBookings(bookingPage.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your dashboard.');
    }
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const currency = who?.society?.currency ?? 'INR';
  const dueBills = (bills ?? []).filter((b) => (b.dueAmount ?? 0) > 0.009);
  const totalDue = dueBills.reduce((sum, b) => sum + Number(b.dueAmount ?? 0), 0);
  const openComplaints = (complaints ?? []).filter((c) => !['CLOSED', 'CANCELLED', 'CANCELED'].includes(String(c.status).toUpperCase()));
  const today = new Date().toISOString().slice(0, 10);
  const upcomingBookings = (bookings ?? []).filter(
    (b) => String(b.date).slice(0, 10) >= today && !['CANCELLED', 'CANCELED', 'REJECTED'].includes(String(b.status).toUpperCase()),
  );
  const loading = bills === null || complaints === null || bookings === null;

  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  })();

  return (
    <Screen>
      <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.brand} />
      <ScreenTitle title={`${greeting}, ${who?.user?.fullName?.split(' ')[0] ?? 'there'}`} subtitle={who?.society?.name} />

      {error ? <Alert tone="error">{error}</Alert> : null}
      {loading ? (
        <Loading label="Loading your dashboard…" />
      ) : (
        <>
          <View style={styles.statRow}>
            <StatCard
              label="Outstanding"
              value={formatMoney(totalDue, currency)}
              sub={dueBills.length ? `${dueBills.length} bill${dueBills.length > 1 ? 's' : ''}` : 'all settled'}
              tone={totalDue > 0 ? 'warning' : 'success'}
              onPress={() => navigation.navigate('Bills')}
            />
            <StatCard
              label="Open complaints"
              value={String(openComplaints.length)}
              sub={openComplaints.length ? 'being handled' : 'nothing pending'}
              tone={openComplaints.length ? 'info' : 'success'}
              onPress={() => navigation.navigate('Complaints')}
            />
          </View>

          <Card>
            <Pressable onPress={() => navigation.navigate('Bookings')}>
              <View style={styles.bookingHeader}>
                <Text style={styles.bookingTitle}>Upcoming bookings</Text>
                <Text style={{ color: colors.textFaint, fontSize: 13 }}>view all ›</Text>
              </View>
              {upcomingBookings.length === 0 ? (
                <Text style={styles.muted}>Nothing booked. Grab the clubhouse or the badminton court!</Text>
              ) : (
                upcomingBookings.slice(0, 3).map((b) => (
                  <View key={b._id} style={styles.bookingRow}>
                    <View style={styles.bookingDateBox}>
                      <Text style={styles.bookingDateDay}>{String(b.date).slice(8, 10)}</Text>
                      <Text style={styles.bookingDateMonth}>{new Date(`${String(b.date).slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { month: 'short' })}</Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.bookingName}>{b.amenity?.name ?? b.amenityName ?? 'Amenity'}</Text>
                      <Text style={styles.muted}>{b.startTime ? `${b.startTime}–${b.endTime}` : String(b.date).slice(0, 10)}</Text>
                    </View>
                    <StatusChip status={b.status} />
                  </View>
                ))
              )}
            </Pressable>
          </Card>

          <View style={styles.actions}>
            <ActionTile label="Raise a complaint" icon="🛠" onPress={() => navigation.navigate('NewComplaint')} />
            <ActionTile label="Pay a bill" icon="💳" onPress={() => navigation.navigate('Bills')} />
            <ActionTile label="Book an amenity" icon="🏸" onPress={() => navigation.navigate('Amenities')} />
            <ActionTile label="Invite a visitor" icon="🎟" onPress={() => navigation.navigate('Visitors')} />
          </View>

          <Card>
            <View style={styles.bookingHeader}>
              <Text style={styles.bookingTitle}>Recent complaints</Text>
              <Pressable onPress={() => navigation.navigate('Complaints')}>
                <Text style={{ color: colors.textFaint, fontSize: 13 }}>view all ›</Text>
              </Pressable>
            </View>
            {openComplaints.length === 0 && (complaints?.length ?? 0) === 0 ? (
              <EmptyState title="No complaints yet" subtitle="If something needs fixing, raise it and track it here." />
            ) : openComplaints.length === 0 ? (
              <Text style={styles.muted}>All caught up — no open complaints.</Text>
            ) : (
              openComplaints.slice(0, 3).map((c) => (
                <Pressable key={c._id} onPress={() => navigation.navigate('ComplaintDetail', { id: c._id })}>
                  <View style={styles.complaintRow}>
                    <View style={{ flex: 1, gap: 3 }}>
                      <Text style={styles.complaintTitle} numberOfLines={1}>
                        {c.referenceNumber ? `${c.referenceNumber} · ` : ''}
                        {c.title}
                      </Text>
                      <Text style={styles.muted} numberOfLines={1}>
                        {String(c.category).toLowerCase()} · {formatDateTime(c.createdAt)}
                      </Text>
                    </View>
                    <StatusChip status={c.status} />
                  </View>
                  <View style={{ height: 10 }} />
                </Pressable>
              ))
            )}
          </Card>

          <Card style={{ alignItems: 'center', gap: 8 }}>
            <View style={styles.avatar}>{initials(who?.user?.fullName)}</View>
            <Text style={{ fontWeight: 600, color: colors.text }}>{who?.user?.fullName}</Text>
            <Text style={styles.muted}>
              {who?.user?.phone} {who?.user?.email ? `· ${who.user.email}` : ''}
            </Text>
            <Button label="Open profile" variant="ghost" onPress={() => navigation.navigate('Profile')} style={{ marginTop: 4, alignSelf: 'stretch' }} />
          </Card>
        </>
      )}
    </Screen>
  );
}

function StatCard({
  label,
  value,
  sub,
  tone,
  onPress,
}: {
  label: string;
  value: string;
  sub: string;
  tone: 'warning' | 'info' | 'success';
  onPress: () => void;
}) {
  const tones = { warning: colors.warningSoft, info: colors.infoSoft, success: colors.successSoft } as const;
  const textTones = { warning: colors.warning, info: colors.info, success: colors.success } as const;
  return (
    <Pressable onPress={onPress} style={[styles.statCard, { backgroundColor: tones[tone] }, styles.statRowItem]}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, { color: textTones[tone] }]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      <Text style={styles.statSub}>{sub}</Text>
    </Pressable>
  );
}

function ActionTile({ label, icon, onPress }: { label: string; icon: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={styles.actionTile}>
      <Text style={{ fontSize: 24 }}>{icon}</Text>
      <Text style={styles.actionLabel} numberOfLines={2}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  statRow: { flexDirection: 'row', gap: 10, marginBottom: 12 },
  statRowItem: { flex: 1 },
  statCard: { borderRadius: 12, padding: 14, gap: 2 },
  statLabel: { fontSize: 12.5, color: colors.textMuted, fontWeight: '600' },
  statValue: { fontSize: 22, fontWeight: '800', letterSpacing: -0.4 },
  statSub: { fontSize: 12, color: colors.textFaint },
  bookingHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  bookingTitle: { fontSize: 15, fontWeight: 600, color: colors.text },
  bookingRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
  bookingDateBox: {
    width: 42,
    height: 46,
    borderRadius: 10,
    backgroundColor: colors.brandSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bookingDateDay: { fontSize: 15, fontWeight: '800', color: colors.brandDark },
  bookingDateMonth: { fontSize: 10.5, color: colors.brandDark, fontWeight: '600' },
  bookingName: { fontSize: 14, fontWeight: '600', color: colors.text },
  muted: { fontSize: 12.5, color: colors.textMuted },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 12, marginHorizontal: -4 },
  actionTile: {
    flex: 1,
    minWidth: '42%',
    marginHorizontal: 4,
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 14,
    gap: 8,
  },
  actionLabel: { fontSize: 13, fontWeight: '600', color: colors.text, lineHeight: 17 },
  complaintRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  complaintTitle: { fontSize: 14, fontWeight: '600', color: colors.text },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.brand,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // (avatar text style inlined via Text props)
  complaintDivider: { height: 10 },
});
