import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { TicketUpload, type PickedTicket } from '@/components/ticket-upload';
import { Button } from '@/components/ui/button';
import { DateTimeField } from '@/components/ui/date-time-field';
import { IconButton } from '@/components/ui/icon-button';
import { PressableScale } from '@/components/ui/pressable-scale';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { TextField } from '@/components/ui/text-field';
import { Colors, Radius } from '@/constants/theme';
import { api } from '@/lib/api';
import { BOOKING_TYPES, bookingType, STATUS_META } from '@/lib/bookings';
import type { Booking, BookingStatus, BookingType, ExtractedBooking, TicketFieldFlag, TripListItem } from '@/lib/types';

/** "2026-11-07T09:15" (local time printed on the ticket) → Date in local time. */
function localToDate(v: string | null): Date | null {
  const m = v?.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])) : null;
}

/** Field names the Ticket agent can flag → form labels. */
const FLAG_LABEL: Record<string, string> = {
  type: 'Type',
  title: 'Name',
  provider: 'Provider',
  confirmation_code: 'Confirmation code',
  start_local: 'Start date/time',
  end_local: 'End date/time',
  location: 'Location',
  cost: 'Cost',
  trip: 'Trip',
};

/** Add or edit a booking. Params: id (edit), tripId (pre-select a trip). */
export default function BookingEditor() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id?: string; tripId?: string }>();
  const editing = Boolean(params.id);

  const [trips, setTrips] = useState<TripListItem[] | null>(null);
  const [loading, setLoading] = useState(editing);
  const [tripId, setTripId] = useState<string | null>(params.tripId ?? null);
  const [type, setType] = useState<BookingType>('flight');
  const [title, setTitle] = useState('');
  const [provider, setProvider] = useState('');
  const [code, setCode] = useState('');
  const [startAt, setStartAt] = useState<Date | null>(null);
  const [endAt, setEndAt] = useState<Date | null>(null);
  const [location, setLocation] = useState('');
  const [cost, setCost] = useState('');
  const [status, setStatus] = useState<BookingStatus>('confirmed');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);
  // Ticket upload → auto-fill.
  const [ticket, setTicket] = useState<{ ticket_path: string; ticket_name: string } | null>(null);
  const [filledFromTicket, setFilledFromTicket] = useState(false);
  const [extras, setExtras] = useState<(ExtractedBooking & { include: boolean })[]>([]);
  // Agentic ticket reading: fields the agent wasn't sure about, and bookings it already saved.
  const [ticketFlags, setTicketFlags] = useState<TicketFieldFlag[]>([]);
  const [autoSaved, setAutoSaved] = useState<Booking[]>([]);
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    let active = true;
    Promise.all([api.listTrips(), params.id && params.tripId ? api.bookings(params.tripId) : Promise.resolve([])])
      .then(([t, list]) => {
        if (!active) return;
        const sorted = t.sort((a, b) => a.start_date.localeCompare(b.start_date));
        setTrips(sorted);
        setTripId((cur) => cur ?? sorted[0]?.id ?? null);
        const b = list.find((x) => x.id === params.id);
        if (b) {
          setType(b.type);
          setTitle(b.title);
          setProvider(b.provider ?? '');
          setCode(b.confirmation_code ?? '');
          setStartAt(b.start_at ? new Date(b.start_at) : null);
          setEndAt(b.end_at ? new Date(b.end_at) : null);
          setLocation(b.location ?? '');
          setCost(b.cost_inr ? String(Math.round(b.cost_inr)) : '');
          setStatus(b.status);
          setNotes(b.notes ?? '');
          if (b.ticket_path) setTicket({ ticket_path: b.ticket_path, ticket_name: b.ticket_name ?? 'Ticket' });
        }
      })
      .catch((err) => Alert.alert('Couldn’t load', (err as Error).message))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [params.id, params.tripId]);

  const meta = bookingType(type);

  const fillFrom = (b: ExtractedBooking) => {
    setType(b.type);
    setTitle(b.title);
    setTitleError(null);
    setProvider(b.provider ?? '');
    setCode(b.confirmation_code ?? '');
    setStartAt(localToDate(b.start_local));
    setEndAt(localToDate(b.end_local));
    setLocation(b.location ?? '');
    setCost(b.cost_inr ? String(Math.round(b.cost_inr)) : '');
    setStatus(b.status);
    setNotes(b.notes ?? '');
    if (b.trip_id) setTripId(b.trip_id);
  };

  /** After the agent saved flights on its own, offer the same flight-aware day rework as a manual save. */
  const afterAutoSave = (saved: Booking[], summary: string) => {
    const flightTrip = saved.find((b) => b.type === 'flight' && b.start_at)?.trip_id;
    const title = saved.length === 1 ? 'Booking saved' : `${saved.length} bookings saved`;
    if (flightTrip) {
      Alert.alert(title, `${summary}

Journi can rebuild your arrival day (and last day) to fit your flight times. You’ll see a preview first.`, [
        { text: 'Not now', style: 'cancel', onPress: () => router.back() },
        { text: 'Adjust plan', onPress: () => router.replace(`/trip/${flightTrip}?arrival=1`) },
      ]);
    } else {
      Alert.alert(title, summary, [{ text: 'OK', onPress: () => router.back() }]);
    }
  };

  const readTicket = async (file: PickedTicket) => {
    const res = await api.extractTicket({ base64: file.base64, mimeType: file.mimeType, name: file.name, typeHint: type });
    if (res.needs_confirmation) {
      // Agentic: clear bookings are already saved; doubtful ones need the traveller's check.
      const saved = res.saved ?? [];
      const pending = res.needs_confirmation;
      if (!pending.length) {
        afterAutoSave(saved, res.summary ?? 'Everything on the ticket was clear, so it’s saved to your trip.');
        return;
      }
      setAutoSaved(saved);
      setTicketFlags(pending[0].flags);
      fillFrom(pending[0].booking);
      setExtras(pending.slice(1).map((p) => ({ ...p.booking, include: true })));
      setTicket(res.ticket);
      setFilledFromTicket(true);
      setTimeout(() => scrollRef.current?.scrollTo({ y: 0, animated: true }), 100);
      return;
    }
    fillFrom(res.bookings[0]);
    setExtras(res.bookings.slice(1).map((b) => ({ ...b, include: true })));
    setTicket(res.ticket);
    setFilledFromTicket(true);
    setTimeout(() => scrollRef.current?.scrollTo({ y: 0, animated: true }), 100);
  };

  const viewTicket = editing && params.id && ticket
    ? async () => {
        try {
          const { url } = await api.ticketUrl(params.id!);
          await WebBrowser.openBrowserAsync(url);
        } catch (err) {
          Alert.alert('Couldn’t open ticket', (err as Error).message);
        }
      }
    : undefined;
  const needsEnd = type === 'hotel' || type === 'car';

  const save = async () => {
    if (!title.trim()) {
      setTitleError('Give this booking a name');
      return;
    }
    if (!tripId) {
      Alert.alert('Choose a trip', 'Pick which trip this booking belongs to.');
      return;
    }
    if (startAt && endAt && endAt < startAt) {
      Alert.alert('Check the dates', 'The end time is before the start time.');
      return;
    }
    setSaving(true);
    const body = {
      trip_id: tripId,
      type,
      title: title.trim(),
      provider: provider.trim() || null,
      confirmation_code: code.trim() || null,
      start_at: startAt ? startAt.toISOString() : null,
      end_at: endAt ? endAt.toISOString() : null,
      location: location.trim() || null,
      cost_inr: Number(cost) || 0,
      status,
      notes: notes.trim() || null,
      ticket_path: ticket?.ticket_path ?? null,
      ticket_name: ticket?.ticket_name ?? null,
    };
    try {
      if (editing) await api.updateBooking(params.id!, body);
      else await api.createBooking(body);
      // Other segments from the same ticket (e.g. the return flight).
      for (const x of extras.filter((e) => e.include)) {
        const start = localToDate(x.start_local);
        const end = localToDate(x.end_local);
        await api.createBooking({
          trip_id: x.trip_id ?? tripId,
          type: x.type,
          title: x.title,
          provider: x.provider,
          confirmation_code: x.confirmation_code,
          start_at: start ? start.toISOString() : null,
          end_at: end ? end.toISOString() : null,
          location: x.location,
          cost_inr: x.cost_inr,
          status: x.status,
          notes: x.notes,
          ticket_path: ticket?.ticket_path ?? null,
          ticket_name: ticket?.ticket_name ?? null,
        });
      }
      const savedFlights = [type, ...extras.filter((e) => e.include).map((e) => e.type)].includes('flight') && (startAt || endAt);
      if (savedFlights && tripId) {
        Alert.alert('Plan around your flights?', 'Journi can rebuild your arrival day (and last day) to fit your flight times. You’ll see a preview first.', [
          { text: 'Not now', style: 'cancel', onPress: () => router.back() },
          { text: 'Adjust plan', onPress: () => router.replace(`/trip/${tripId}?arrival=1`) },
        ]);
      } else {
        router.back();
      }
    } catch (err) {
      Alert.alert('Couldn’t save booking', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = () =>
    Alert.alert('Delete this booking?', title, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.deleteBooking(params.id!);
            router.back();
          } catch (err) {
            Alert.alert('Couldn’t delete', (err as Error).message);
          }
        },
      },
    ]);

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: Colors.bg }}>
      <View style={[styles.header, { paddingTop: insets.top > 20 ? 14 : insets.top + 14 }]}>
        <Text variant="h2" style={{ flex: 1 }}>
          {editing ? 'Edit booking' : 'Add booking'}
        </Text>
        <IconButton icon="close" onPress={() => router.back()} accessibilityLabel="Close" />
      </View>

      {loading || trips === null ? (
        <View style={{ padding: 20, gap: 12 }}>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} height={54} radius={Radius.lg} />
          ))}
        </View>
      ) : (
        <ScrollView ref={scrollRef} contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 40, gap: 16 }} keyboardShouldPersistTaps="handled">
          {filledFromTicket && (
            <View style={styles.filled}>
              <Ionicons name="sparkles" size={18} color={Colors.success} />
              <View style={{ flex: 1 }}>
                <Text variant="label" color={Colors.success}>
                  Filled in from your ticket
                </Text>
                <Text variant="caption" color={Colors.inkSoft}>
                  {autoSaved.length
                    ? `${autoSaved.length} clear booking${autoSaved.length === 1 ? ' was' : 's were'} saved automatically. Please check this one, then save.`
                    : 'Please check the details, then save.'}
                </Text>
                {ticketFlags.map((f) => (
                  <Text key={`${f.field}-${f.reason}`} variant="caption" color={Colors.warning}>
                    • {FLAG_LABEL[f.field] ?? f.field}
                    {f.value ? ` (“${f.value}”)` : ''}: {f.reason}
                  </Text>
                ))}
              </View>
            </View>
          )}
          {extras.length > 0 && (
            <View style={styles.extras}>
              <Text variant="label">
                Also on this ticket ({extras.length})
              </Text>
              {extras.map((x, i) => (
                <PressableScale
                  key={`${x.title}-${i}`}
                  haptic
                  onPress={() => setExtras((prev) => prev.map((e, j) => (j === i ? { ...e, include: !e.include } : e)))}
                  style={styles.extraRow}
                >
                  <Ionicons name={x.include ? 'checkbox' : 'square-outline'} size={20} color={x.include ? Colors.primary : Colors.muted} />
                  <View style={{ flex: 1 }}>
                    <Text variant="caption" color={Colors.ink} numberOfLines={1}>
                      {x.title}
                    </Text>
                    <Text variant="caption" color={Colors.muted} style={{ fontSize: 11 }}>
                      {localToDate(x.start_local)?.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) ?? 'Date not found'}
                      {x.include ? ' · will be added too' : ' · skipped'}
                    </Text>
                  </View>
                </PressableScale>
              ))}
            </View>
          )}
          {/* Trip */}
          <View style={{ gap: 8 }}>
            <Text variant="label" color={Colors.inkSoft}>
              Trip
            </Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
              {trips.map((t) => (
                <PressableScale key={t.id} haptic onPress={() => setTripId(t.id)} style={[styles.chip, tripId === t.id && styles.chipActive]}>
                  <Text variant="label" color={tripId === t.id ? Colors.white : Colors.ink} style={{ fontSize: 13 }}>
                    {t.destination.name}
                  </Text>
                </PressableScale>
              ))}
            </ScrollView>
          </View>

          {/* Type */}
          <View style={{ gap: 8 }}>
            <Text variant="label" color={Colors.inkSoft}>
              Type
            </Text>
            <View style={styles.typeGrid}>
              {BOOKING_TYPES.map((t) => {
                const active = type === t.key;
                return (
                  <PressableScale
                    key={t.key}
                    haptic
                    onPress={() => setType(t.key)}
                    style={[styles.typeBtn, active && { borderColor: t.color, backgroundColor: `${t.color}14` }]}
                  >
                    <Ionicons name={t.icon} size={18} color={active ? t.color : Colors.muted} />
                    <Text variant="caption" color={active ? Colors.ink : Colors.inkSoft} style={{ fontSize: 12 }}>
                      {t.label}
                    </Text>
                  </PressableScale>
                );
              })}
            </View>
          </View>

          <TicketUpload type={type} onPicked={readTicket} attachedName={ticket?.ticket_name} onViewAttached={viewTicket} />

          <View style={styles.orRow}>
            <View style={styles.orLine} />
            <Text variant="caption" color={Colors.muted}>
              or type the details
            </Text>
            <View style={styles.orLine} />
          </View>

          <TextField
            label="Name"
            icon={meta.icon}
            placeholder={meta.titleHint}
            value={title}
            onChangeText={(t) => {
              setTitle(t);
              setTitleError(null);
            }}
            error={titleError}
            maxLength={120}
          />
          <TextField
            label="Airline / hotel / company (optional)"
            icon="business-outline"
            placeholder="e.g. IndiGo, Booking.com"
            value={provider}
            onChangeText={setProvider}
            maxLength={120}
          />
          <TextField
            label="Confirmation / PNR (optional)"
            icon="barcode-outline"
            placeholder="e.g. ABC123"
            value={code}
            onChangeText={setCode}
            autoCapitalize="characters"
            maxLength={60}
          />
          <DateTimeField label={type === 'hotel' ? 'Check-in' : type === 'flight' ? 'Departure' : 'Date & time'} value={startAt} onChange={setStartAt} optional />
          {needsEnd && <DateTimeField label={type === 'hotel' ? 'Check-out' : 'Return'} value={endAt} onChange={setEndAt} optional minimumDate={startAt ?? undefined} />}
          <TextField label="Location (optional)" icon="location-outline" placeholder="Address, terminal or meeting point" value={location} onChangeText={setLocation} maxLength={200} />
          <TextField
            label="Cost per person (₹, optional)"
            icon="wallet-outline"
            placeholder="0"
            value={cost}
            onChangeText={(t) => setCost(t.replace(/[^0-9]/g, ''))}
            keyboardType="number-pad"
            maxLength={9}
          />

          {/* Status */}
          <View style={{ gap: 8 }}>
            <Text variant="label" color={Colors.inkSoft}>
              Status
            </Text>
            <View style={styles.segment}>
              {(Object.keys(STATUS_META) as BookingStatus[]).map((s) => (
                <PressableScale key={s} haptic onPress={() => setStatus(s)} style={[styles.segmentItem, status === s && { backgroundColor: STATUS_META[s].bg }]}>
                  <Text variant="label" color={status === s ? STATUS_META[s].color : Colors.muted} style={{ fontSize: 13 }}>
                    {STATUS_META[s].label}
                  </Text>
                </PressableScale>
              ))}
            </View>
          </View>

          <TextField label="Notes (optional)" icon="document-text-outline" placeholder="Seat, baggage, room type…" value={notes} onChangeText={setNotes} multiline maxLength={1000} style={{ minHeight: 44 }} />

          <Button
            title={editing ? 'Save changes' : extras.some((e) => e.include) ? `Add ${1 + extras.filter((e) => e.include).length} bookings` : 'Add booking'}
            icon="checkmark"
            size="lg"
            onPress={save}
            loading={saving}
            fullWidth
          />
          {editing && <Button title="Delete booking" variant="danger" icon="trash-outline" onPress={remove} fullWidth />}
        </ScrollView>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingBottom: 6 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: Radius.pill, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  typeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  typeBtn: {
    width: '23%',
    flexGrow: 1,
    alignItems: 'center',
    gap: 4,
    paddingVertical: 10,
    borderRadius: Radius.md,
    borderWidth: 1.5,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  filled: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: Radius.lg, backgroundColor: Colors.successSoft },
  extras: { gap: 8, padding: 12, borderRadius: Radius.lg, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border },
  extraRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  orRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  orLine: { flex: 1, height: 1, backgroundColor: Colors.border },
  segment: { flexDirection: 'row', gap: 6, padding: 4, borderRadius: Radius.pill, backgroundColor: Colors.surfaceAlt },
  segmentItem: { flex: 1, height: 38, alignItems: 'center', justifyContent: 'center', borderRadius: Radius.pill },
});
