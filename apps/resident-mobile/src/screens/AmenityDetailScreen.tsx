/**
 * Amenity detail — pick a date, see live slot availability, book a slot.
 *
 * Availability comes from GET /amenities/{id}/availability?date=YYYY-MM-DD; a booking is
 * POST /amenity-bookings { amenityId, slotId, date, ... }. The server enforces capacity,
 * hours and the society's booking rules; the app only surfaces what it is told.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Alert, Button, Card, KV, Loading, Screen, ScreenTitle, colors } from '../components/ui.tsx';
import { api, ApiError } from '../lib/api.ts';
import { formatMoney, localDate } from '../lib/format.ts';
import { useSession } from '../lib/session.tsx';
import type { Amenity, AmenitySlot, Availability } from '../lib/types.ts';
import type { StackScreenProps } from '../nav.ts';

type Props = StackScreenProps<'AmenityDetail'>;

const DAYS_AHEAD = 7;

export function AmenityDetailScreen({ route, navigation }: Props) {
  const { id } = route.params;
  const { who } = useSession();
  const currency = who?.society?.currency ?? 'INR';

  const [amenity, setAmenity] = useState<Amenity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dates, setDates] = useState<string[]>(() => Array.from({ length: DAYS_AHEAD }, (_, i) => localDate(i)));
  const [date, setDate] = useState<string>(localDate());
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [availLoading, setAvailLoading] = useState(false);
  const [slot, setSlot] = useState<AmenitySlot | null>(null);
  const [people, setPeople] = useState('1');
  const [booking, setBooking] = useState(false);

  const loadAmenity = useCallback(async () => {
    setError(null);
    try {
      setAmenity(await api.get<Amenity>(`/amenities/${id}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the amenity.');
    }
  }, [id]);

  const loadAvailability = useCallback(async (d: string) => {
    setAvailLoading(true);
    setSlot(null);
    try {
      setAvailability(await api.get<Availability>(`/amenities/${id}/availability`, { date: d }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load availability.');
      setAvailability(null);
    } finally {
      setAvailLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void loadAmenity();
  }, [loadAmenity]);

  useEffect(() => {
    void loadAvailability(date);
  }, [date, loadAvailability]);

  const [bookedNote, setBookedNote] = useState<string | null>(null);

  const book = async () => {
    if (!slot || !amenity) return;
    setBooking(true);
    setError(null);
    setBookedNote(null);
    try {
      const n = Math.max(1, Math.min(20, Number(people) || 1));
      const created = await api.post<{
        _id?: string;
        booking?: { _id: string; status?: string; totalAmount?: number };
        totalAmount?: number;
      }>('/amenity-bookings', {
        amenityId: amenity._id,
        slotId: slot.slotId,
        date,
        startTime: slot.startTime,
        endTime: slot.endTime,
        numberOfPeople: n,
      });
      const status = String(created.booking?.status ?? '').toUpperCase();
      const needsPayment =
        status === 'PENDING_PAYMENT' ||
        (!['CONFIRMED'].includes(status) && Number(created.booking?.totalAmount ?? created.totalAmount ?? 0) > 0.009);
      if (needsPayment) {
        // The slot is HELD, not confirmed — the resident must pay in My bookings.
        setBookedNote('Slot held for you — it is confirmed once the booking fee is paid. Open "My bookings" to pay.');
        setBooking(false);
        return;
      }
      // Confirmed (free amenity, or no fee) — go straight to the booking list.
      navigation.navigate('Bookings');
      setBooking(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not complete the booking.');
      setBooking(false);
    }
  };

  if (!amenity && !error) return <Screen scroll={false}><Loading /></Screen>;

  const freeSlots = (availability?.slots ?? []).filter((s) => s.available && !s.isPast);

  return (
    <Screen>
      {error ? <Alert tone="error">{error}</Alert> : null}
      {bookedNote ? (
        <Alert tone="info">
          {bookedNote} <Button label="Go to My bookings" variant="ghost" onPress={() => navigation.navigate('Bookings')} style={{ marginTop: 8, alignSelf: 'flex-start' }} />
        </Alert>
      ) : null}
      {amenity ? (
        <>
          <Card>
            <Text style={styles.name}>{amenity.name}</Text>
            {amenity.description ? <Text style={styles.desc}>{amenity.description}</Text> : null}
            <View style={{ marginTop: 10 }}>
              <KV label="Hours" value={amenity.openTime ? `${amenity.openTime} – ${amenity.closeTime ?? ''}` : '—'} />
              <KV label="Slot length" value={amenity.slotDurationMinutes ? `${amenity.slotDurationMinutes} min` : 'flexible'} />
              <KV label="Capacity" value={amenity.capacity ? String(amenity.capacity) : '—'} />
              <KV label="Booking fee" value={amenity.bookingFee ? formatMoney(amenity.bookingFee, currency) : 'free'} />
              {amenity.deposit ? <KV label="Deposit" value={formatMoney(amenity.deposit, currency)} /> : null}
              <KV label="Approval" value={amenity.requireApproval ? 'society approval needed' : 'instant'} />
            </View>
            {Array.isArray(amenity.rules) && amenity.rules.length > 0 ? (
              <View style={{ marginTop: 10, gap: 4 }}>
                {amenity.rules.map((r, i) => (
                  <Text key={i} style={styles.rule}>
                    • {r}
                  </Text>
                ))}
              </View>
            ) : null}
          </Card>

          <Text style={styles.sectionTitle}>Pick a day</Text>
          <View style={styles.dateStrip}>
            {dates.map((d) => {
              const dt = new Date(`${d}T00:00:00`);
              const selected = d === date;
              return (
                <Pressable key={d} onPress={() => setDate(d)} style={[styles.dateChip, selected && styles.dateChipActive]}>
                  <Text style={[styles.dateChipDow, selected && { color: '#fff' }]}>
                    {dt.toLocaleDateString('en-IN', { weekday: 'short' })}
                  </Text>
                  <Text style={[styles.dateChipDay, selected && { color: '#fff' }]}>
                    {dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {availLoading ? (
            <Loading label="Checking availability…" />
          ) : availability?.closed ? (
            <Card>
              <Text style={styles.muted}>This facility is closed on {new Date(`${date}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'long' })}s.</Text>
            </Card>
          ) : freeSlots.length === 0 ? (
            <Card>
              <Text style={styles.muted}>No free slots on {new Date(`${date}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} — try another day.</Text>
            </Card>
          ) : (
            <>
              <Text style={styles.sectionTitle}>
                Slots for {new Date(`${date}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
              </Text>
              {freeSlots.map((s) => (
                <Pressable key={s.slotId} onPress={() => setSlot(s)} style={[styles.slotRow, slot?.slotId === s.slotId && styles.slotRowActive]}>
                  <Text style={styles.slotTime}>
                    {s.startTime} – {s.endTime}
                  </Text>
                  <Text style={styles.slotCap}>
                    {s.remaining}/{s.capacity} free
                  </Text>
                  <Text style={styles.slotFee}>{s.fee ? formatMoney(s.fee, currency) : 'free'}</Text>
                </Pressable>
              ))}
            </>
          )}

          {slot ? (
            <Card style={{ marginTop: 14, borderColor: colors.brand + '55' }}>
              <Text style={styles.sectionTitle}>Your booking</Text>
              <KV label="Amenity" value={amenity.name} />
              <KV label="Date" value={new Date(`${date}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })} />
              <KV label="Slot" value={`${slot.startTime} – ${slot.endTime}`} />
              <View style={{ marginBottom: 12, gap: 4 }}>
                <Text style={styles.fieldLabel}>People</Text>
                <View style={styles.stepper}>
                  <Pressable onPress={() => setPeople(String(Math.max(1, (Number(people) || 1) - 1)))} style={styles.stepperBtn}>
                    <Text style={{ fontSize: 18, color: colors.brandDark, fontWeight: '700' }}>−</Text>
                  </Pressable>
                  <Text style={styles.stepperValue}>{people}</Text>
                  <Pressable onPress={() => setPeople(String(Math.min(20, (Number(people) || 1) + 1)))} style={styles.stepperBtn}>
                    <Text style={{ fontSize: 18, color: colors.brandDark, fontWeight: '700' }}>+</Text>
                  </Pressable>
                </View>
              </View>
              <Button
                label={amenity.requireApproval ? 'Request booking' : 'Confirm booking'}
                onPress={() => void book()}
                loading={booking}
              />
            </Card>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  name: { fontSize: 19, fontWeight: 700, color: colors.text },
  desc: { fontSize: 13.5, color: colors.textMuted, marginTop: 6, lineHeight: 19 },
  rule: { fontSize: 12.5, color: colors.textMuted },
  sectionTitle: { fontSize: 14.5, fontWeight: 600, color: colors.text, marginBottom: 8, marginTop: 4 },
  dateStrip: { flexDirection: 'row', gap: 8, marginBottom: 14 },
  dateChip: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    paddingVertical: 8,
    gap: 2,
  },
  dateChipActive: { backgroundColor: colors.brand, borderColor: colors.brand },
  dateChipDow: { fontSize: 11, color: colors.textFaint, fontWeight: '600' },
  dateChipDay: { fontSize: 11.5, color: colors.text, fontWeight: '700' },
  slotRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surface,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 12,
    marginBottom: 8,
    gap: 8,
  },
  slotRowActive: { borderColor: colors.brand, backgroundColor: colors.brandSoft },
  slotTime: { fontSize: 14, fontWeight: 600, color: colors.text },
  slotCap: { fontSize: 12, color: colors.textMuted },
  slotFee: { fontSize: 13, fontWeight: '700', color: colors.brandDark },
  fieldLabel: { fontSize: 13, fontWeight: '600', color: colors.textMuted, marginBottom: 6 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  stepperBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.brandSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperValue: { fontSize: 16, fontWeight: '700', color: colors.text, minWidth: 24, textAlign: 'center' },
  muted: { fontSize: 13.5, color: colors.textMuted },
});
