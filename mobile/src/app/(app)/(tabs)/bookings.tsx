import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { router, useFocusEffect } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useState } from 'react';
import { Alert, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { FadeIn, FadeInDown, LinearTransition } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/button';
import { PressableScale } from '@/components/ui/pressable-scale';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { Colors, Radius, Shadow } from '@/constants/theme';
import { api } from '@/lib/api';
import { bookingType, formatBookingTime, STATUS_META } from '@/lib/bookings';
import { daysUntil, formatDateRange, formatMoney } from '@/lib/format';
import type { Booking, TripListItem } from '@/lib/types';

export default function BookingsScreen() {
  const insets = useSafeAreaInsets();
  const [trips, setTrips] = useState<TripListItem[] | null>(null);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [tripFilter, setTripFilter] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [t, b] = await Promise.all([api.listTrips(), api.bookings()]);
      setTrips(t.sort((x, y) => x.start_date.localeCompare(y.start_date)));
      setBookings(b);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const copy = async (code: string) => {
    await Clipboard.setStringAsync(code);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    setCopied(code);
    setTimeout(() => setCopied(null), 1500);
  };

  const shownTrips = (trips ?? []).filter((t) => !tripFilter || t.id === tripFilter);
  const upcomingFirst = [...shownTrips].sort((a, b) => Number(daysUntil(a.end_date) < 0) - Number(daysUntil(b.end_date) < 0));
  const addBooking = () => router.push({ pathname: '/booking-editor', params: tripFilter ? { tripId: tripFilter } : {} });

  return (
    <View style={{ flex: 1, backgroundColor: Colors.bg }}>
      <StatusBar style="dark" />
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + 12, paddingBottom: 32, gap: 16 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={Colors.primary}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
          />
        }
        showsVerticalScrollIndicator={false}
      >
        <View style={[styles.pad, styles.header]}>
          <View style={{ flex: 1 }}>
            <Text variant="h1">Bookings</Text>
            <Text variant="caption" color={Colors.muted}>
              Upload a ticket and Journi fills in the details for you.
            </Text>
          </View>
          {trips && trips.length > 0 && <Button title="Add" icon="add" size="sm" onPress={addBooking} />}
        </View>

        {trips && trips.length > 1 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: 20 }}>
            {[{ id: null as string | null, label: 'All trips' }, ...trips.map((t) => ({ id: t.id as string | null, label: t.destination.name }))].map((f) => (
              <PressableScale key={f.id ?? 'all'} haptic onPress={() => setTripFilter(f.id)} style={[styles.chip, tripFilter === f.id && styles.chipActive]}>
                <Text variant="label" color={tripFilter === f.id ? Colors.white : Colors.inkSoft} style={{ fontSize: 13 }}>
                  {f.label}
                </Text>
              </PressableScale>
            ))}
          </ScrollView>
        )}

        {error && !trips ? (
          <View style={[styles.pad, styles.box]}>
            <Text variant="body" color={Colors.inkSoft} center>
              {error}
            </Text>
            <Button title="Try again" variant="secondary" size="sm" onPress={load} />
          </View>
        ) : trips === null ? (
          <View style={[styles.pad, { gap: 12 }]}>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} height={90} radius={Radius.lg} />
            ))}
          </View>
        ) : trips.length === 0 ? (
          <View style={[styles.pad, styles.box]}>
            <Ionicons name="ticket-outline" size={36} color={Colors.primary} />
            <Text variant="h3" center>
              No trips yet
            </Text>
            <Text variant="body" color={Colors.inkSoft} center>
              Save a trip first, then keep its flight, hotel and activity bookings here.
            </Text>
            <Button title="Plan a trip" icon="sparkles" onPress={() => router.push('/new-trip')} />
          </View>
        ) : (
          upcomingFirst.map((trip, ti) => {
            const list = bookings.filter((b) => b.trip_id === trip.id);
            const total = list.filter((b) => b.status !== 'cancelled').reduce((s, b) => s + b.cost_inr, 0);
            return (
              <Animated.View key={trip.id} entering={FadeInDown.delay(ti * 60).duration(400)} style={[styles.pad, { gap: 10 }]}>
                <View style={styles.tripHead}>
                  <View style={{ flex: 1 }}>
                    <Text variant="h3" numberOfLines={1}>
                      {trip.destination.name}
                    </Text>
                    <Text variant="caption" color={Colors.muted}>
                      {formatDateRange(trip.start_date, trip.end_date)} · {list.length} booking{list.length === 1 ? '' : 's'}
                      {total > 0 ? ` · ${formatMoney(total, 'INR')} booked` : ''}
                    </Text>
                  </View>
                  <PressableScale haptic onPress={() => router.push({ pathname: '/booking-editor', params: { tripId: trip.id } })} style={styles.addSmall}>
                    <Ionicons name="add" size={18} color={Colors.primary} />
                  </PressableScale>
                </View>

                {list.length === 0 ? (
                  <PressableScale haptic onPress={() => router.push({ pathname: '/booking-editor', params: { tripId: trip.id } })} style={styles.empty}>
                    <Ionicons name="add-circle-outline" size={20} color={Colors.primary} />
                    <Text variant="caption" color={Colors.inkSoft} style={{ flex: 1 }}>
                      Add your flight, hotel or tickets for this trip
                    </Text>
                  </PressableScale>
                ) : (
                  list.map((b) => {
                    const t = bookingType(b.type);
                    const s = STATUS_META[b.status];
                    return (
                      <Animated.View key={b.id} layout={LinearTransition}>
                        <PressableScale haptic onPress={() => router.push({ pathname: '/booking-editor', params: { id: b.id, tripId: b.trip_id } })} style={[styles.card, b.status === 'cancelled' && { opacity: 0.55 }]}>
                          <View style={[styles.typeIcon, { backgroundColor: `${t.color}1A` }]}>
                            <Ionicons name={t.icon} size={20} color={t.color} />
                          </View>
                          <View style={{ flex: 1, gap: 3 }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                              <Text variant="title" numberOfLines={1} style={{ flex: 1, fontSize: 15 }}>
                                {b.title}
                              </Text>
                              <View style={[styles.status, { backgroundColor: s.bg }]}>
                                <Text variant="caption" color={s.color} style={{ fontSize: 11 }}>
                                  {s.label}
                                </Text>
                              </View>
                            </View>
                            <Text variant="caption" color={Colors.muted} numberOfLines={1}>
                              {[formatBookingTime(b.start_at), b.provider, b.location].filter(Boolean).join(' · ') || t.label}
                            </Text>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 2 }}>
                              {!!b.confirmation_code && (
                                <PressableScale onPress={() => copy(b.confirmation_code!)} hitSlop={6} style={styles.code}>
                                  <Ionicons name={copied === b.confirmation_code ? 'checkmark' : 'copy-outline'} size={12} color={Colors.primary} />
                                  <Text variant="caption" color={Colors.primary} style={{ fontSize: 12 }}>
                                    {copied === b.confirmation_code ? 'Copied' : b.confirmation_code}
                                  </Text>
                                </PressableScale>
                              )}
                              {!!b.ticket_path && (
                                <PressableScale
                                  onPress={() =>
                                    api
                                      .ticketUrl(b.id)
                                      .then(({ url }) => WebBrowser.openBrowserAsync(url))
                                      .catch((err) => Alert.alert('Couldn’t open ticket', (err as Error).message))
                                  }
                                  hitSlop={6}
                                  style={styles.code}
                                >
                                  <Ionicons name="attach" size={13} color={Colors.primary} />
                                  <Text variant="caption" color={Colors.primary} style={{ fontSize: 12 }}>
                                    Ticket
                                  </Text>
                                </PressableScale>
                              )}
                              {b.cost_inr > 0 && (
                                <Text variant="label" style={{ fontSize: 13, marginLeft: 'auto' }}>
                                  {formatMoney(b.cost_inr, 'INR')}
                                </Text>
                              )}
                            </View>
                          </View>
                        </PressableScale>
                      </Animated.View>
                    );
                  })
                )}
              </Animated.View>
            );
          })
        )}

        {copied && (
          <Animated.View entering={FadeIn} style={[styles.pad]}>
            <Text variant="caption" color={Colors.muted} center>
              Confirmation code copied
            </Text>
          </Animated.View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  pad: { paddingHorizontal: 20 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: Radius.pill, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  box: { alignItems: 'center', gap: 10, padding: 22, borderRadius: Radius.xl, backgroundColor: Colors.surface },
  tripHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  addSmall: { width: 36, height: 36, borderRadius: 18, backgroundColor: Colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  empty: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 14,
    borderRadius: Radius.lg,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: Colors.border,
  },
  card: { flexDirection: 'row', gap: 12, padding: 14, borderRadius: Radius.lg, backgroundColor: Colors.surface, ...Shadow.card },
  typeIcon: { width: 42, height: 42, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  status: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: Radius.pill },
  code: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: Radius.sm, backgroundColor: Colors.primarySoft },
});
