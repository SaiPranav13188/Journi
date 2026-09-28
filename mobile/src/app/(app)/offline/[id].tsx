import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { router, useLocalSearchParams } from 'expo-router';
import * as Sharing from 'expo-sharing';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { dayColor } from '@/components/trip-map';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { PressableScale } from '@/components/ui/pressable-scale';
import { Text } from '@/components/ui/text';
import { Colors, Radius, Shadow } from '@/constants/theme';
import { bookingType, formatBookingTime, STATUS_META } from '@/lib/bookings';
import { formatDate, formatDateRange, formatMoney, timeAgo } from '@/lib/format';
import { loadOfflinePack, removeOfflinePack, saveOfflinePack, type OfflinePack } from '@/lib/offline';
import { loadPacking, type PackingState } from '@/lib/packing';

const TIME_LABEL = { morning: '☀️ Morning', afternoon: '⛅ Afternoon', evening: '🌙 Evening' } as const;

/** Static map picture with numbered pins drawn on top (works with no internet). */
function OfflineMapView({ pack }: { pack: OfflinePack }) {
  const m = pack.map;
  if (!m) return null;
  const stops = pack.plan.days.flatMap((d) =>
    d.activities.filter((a) => !a.placeholder && a.lat != null && a.lng != null).map((a, i) => ({ id: a.id, day: d.day_number, n: i + 1, lat: a.lat!, lng: a.lng! })),
  );
  return (
    <View style={[styles.mapWrap, { aspectRatio: m.width / m.height }]}>
      <Image source={{ uri: m.file }} style={StyleSheet.absoluteFill} contentFit="fill" />
      {stops.map((s) => (
        <View
          key={s.id}
          style={[
            styles.pin,
            {
              backgroundColor: dayColor(s.day),
              left: `${((s.lng - m.minLng) / (m.maxLng - m.minLng)) * 100}%`,
              top: `${((m.maxLat - s.lat) / (m.maxLat - m.minLat)) * 100}%`,
            },
          ]}
        >
          <Text variant="caption" color={Colors.white} style={{ fontSize: 10, lineHeight: 12 }}>
            {s.n}
          </Text>
        </View>
      ))}
    </View>
  );
}

export default function OfflineScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const [pack, setPack] = useState<OfflinePack | null>(null);
  const [packing, setPacking] = useState<PackingState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [imageTicket, setImageTicket] = useState<string | null>(null);

  const refreshLocal = useCallback(async () => {
    const [p, pk] = await Promise.all([loadOfflinePack(id), loadPacking(id)]);
    setPack(p);
    setPacking(pk);
    setLoaded(true);
  }, [id]);

  useEffect(() => {
    let active = true;
    Promise.all([loadOfflinePack(id), loadPacking(id)]).then(([p, pk]) => {
      if (!active) return;
      setPack(p);
      setPacking(pk);
      setLoaded(true);
    });
    return () => {
      active = false;
    };
  }, [id]);

  const download = async () => {
    setSaving(true);
    try {
      await saveOfflinePack(id);
      await refreshLocal();
    } catch (err) {
      Alert.alert('Couldn’t download', `${(err as Error).message}\n\nMake sure you’re connected to the internet.`);
    } finally {
      setSaving(false);
    }
  };

  const openTicket = async (uri: string) => {
    if (/\.(jpe?g|png|webp|heic|heif)$/i.test(uri)) {
      setImageTicket(uri);
      return;
    }
    if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri, { dialogTitle: 'Open ticket' });
    else Alert.alert('Can’t open', 'No app available to open this file.');
  };

  const plan = pack?.plan;

  return (
    <View style={{ flex: 1, backgroundColor: Colors.bg }}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <IconButton icon="chevron-back" onPress={() => router.back()} accessibilityLabel="Back" />
        <View style={{ flex: 1 }}>
          <Text variant="h2">Offline trip pack</Text>
          <Text variant="caption" color={Colors.muted}>
            {pack ? `Saved on this phone · updated ${timeAgo(pack.savedAt)}` : 'Use your trip with no internet'}
          </Text>
        </View>
      </View>

      {!loaded ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={Colors.primary} />
      ) : !pack || !plan ? (
        <View style={{ padding: 20, gap: 16 }}>
          <View style={[styles.card, { alignItems: 'center', gap: 12 }]}>
            <View style={styles.bigIcon}>
              <Ionicons name="cloud-download-outline" size={30} color={Colors.primary} />
            </View>
            <Text variant="h3" center>
              Take your trip offline
            </Text>
            <Text variant="body" color={Colors.inkSoft} center>
              Save the itinerary, bookings, ticket files, a map and your packing list on this phone — perfect for flights and places without signal.
            </Text>
            <Button title="Download for offline" icon="download-outline" onPress={download} loading={saving} fullWidth />
          </View>
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 40, gap: 16 }}>
          <View style={styles.statusCard}>
            <Ionicons name="checkmark-circle" size={22} color={Colors.success} />
            <View style={{ flex: 1 }}>
              <Text variant="label" color={Colors.success}>
                Available offline
              </Text>
              <Text variant="caption" color={Colors.inkSoft}>
                {plan.trip.destination.name} · {formatDateRange(plan.trip.start_date, plan.trip.end_date)}
              </Text>
            </View>
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button title="Update" icon="refresh" variant="secondary" size="sm" onPress={download} loading={saving} style={{ flex: 1 }} />
            <Button
              title="Remove"
              icon="trash-outline"
              variant="danger"
              size="sm"
              onPress={() =>
                Alert.alert('Remove offline copy?', 'The trip stays in your account — only the copy on this phone is deleted.', [
                  { text: 'Cancel', style: 'cancel' },
                  {
                    text: 'Remove',
                    style: 'destructive',
                    onPress: async () => {
                      await removeOfflinePack(id);
                      setPack(null);
                    },
                  },
                ])
              }
              style={{ flex: 1 }}
            />
          </View>

          {pack.map && (
            <Animated.View entering={FadeInDown.duration(350)} style={{ gap: 8 }}>
              <Text variant="h3">Map</Text>
              <OfflineMapView pack={pack} />
            </Animated.View>
          )}

          <Animated.View entering={FadeInDown.delay(60).duration(350)} style={styles.card}>
            <Text variant="h3">Itinerary</Text>
            {plan.days.map((day) => (
              <View key={day.day_number} style={{ gap: 6 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <View style={[styles.dot, { backgroundColor: dayColor(day.day_number) }]} />
                  <Text variant="label">
                    Day {day.day_number} · {formatDate(day.date, { weekday: 'short', day: 'numeric', month: 'short' })}
                  </Text>
                </View>
                <Text variant="caption" color={Colors.muted}>
                  {day.theme}
                </Text>
                {day.activities
                  .filter((a) => !a.placeholder)
                  .map((a, i) => (
                    <Text key={a.id} variant="caption" color={Colors.ink} style={{ paddingLeft: 16 }}>
                      {i + 1}. {TIME_LABEL[a.time_of_day] ?? a.time_of_day} — {a.title}
                      {a.estimated_cost_inr > 0 ? ` · ${formatMoney(a.estimated_cost_inr, 'INR')}` : ''}
                    </Text>
                  ))}
                {day.meal_suggestion && (
                  <Text variant="caption" color={Colors.inkSoft} style={{ paddingLeft: 16 }}>
                    🍜 {day.meal_suggestion.dish}
                    {day.meal_suggestion.where ? ` · ${day.meal_suggestion.where}` : ''}
                  </Text>
                )}
                {!!day.accommodation_note && (
                  <Text variant="caption" color={Colors.inkSoft} style={{ paddingLeft: 16 }}>
                    🛏 {day.accommodation_note}
                  </Text>
                )}
              </View>
            ))}
          </Animated.View>

          <Animated.View entering={FadeInDown.delay(120).duration(350)} style={styles.card}>
            <Text variant="h3">Bookings & tickets</Text>
            {pack.bookings.length === 0 ? (
              <Text variant="caption" color={Colors.muted}>
                No bookings saved for this trip.
              </Text>
            ) : (
              pack.bookings.map((b) => {
                const t = bookingType(b.type);
                const s = STATUS_META[b.status];
                return (
                  <View key={b.id} style={styles.bookingRow}>
                    <View style={[styles.typeIcon, { backgroundColor: `${t.color}1A` }]}>
                      <Ionicons name={t.icon} size={18} color={t.color} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text variant="label" numberOfLines={1}>
                        {b.title}
                      </Text>
                      <Text variant="caption" color={Colors.muted} numberOfLines={2} style={{ fontSize: 11 }}>
                        {[formatBookingTime(b.start_at), b.confirmation_code && `PNR ${b.confirmation_code}`, b.location, s.label].filter(Boolean).join(' · ')}
                      </Text>
                    </View>
                    {b.local_ticket && (
                      <PressableScale haptic onPress={() => openTicket(b.local_ticket!)} style={styles.ticketBtn}>
                        <Ionicons name="document-attach-outline" size={15} color={Colors.primary} />
                        <Text variant="caption" color={Colors.primary} style={{ fontSize: 12 }}>
                          Ticket
                        </Text>
                      </PressableScale>
                    )}
                  </View>
                );
              })
            )}
          </Animated.View>

          <Animated.View entering={FadeInDown.delay(180).duration(350)} style={styles.card}>
            <Text variant="h3">Packing list</Text>
            {packing ? (
              <>
                {packing.list.categories.map((c) => (
                  <View key={c.name} style={{ gap: 4 }}>
                    <Text variant="label" color={Colors.inkSoft}>
                      {c.name}
                    </Text>
                    {c.items.map((i) => (
                      <Text key={i.id} variant="caption" color={packing.checked[i.id] ? Colors.muted : Colors.ink}>
                        {packing.checked[i.id] ? '☑' : '☐'} {i.name}
                      </Text>
                    ))}
                  </View>
                ))}
                <PressableScale onPress={() => router.push({ pathname: '/packing/[id]', params: { id } })}>
                  <Text variant="label" color={Colors.primary}>
                    Open packing list ›
                  </Text>
                </PressableScale>
              </>
            ) : (
              <Text variant="caption" color={Colors.muted}>
                Open the packing list once while online — it’s then saved on this phone automatically.
              </Text>
            )}
          </Animated.View>
        </ScrollView>
      )}

      <Modal visible={!!imageTicket} transparent animationType="fade" onRequestClose={() => setImageTicket(null)}>
        <Pressable style={styles.imageModal} onPress={() => setImageTicket(null)}>
          {imageTicket && <Image source={{ uri: imageTicket }} style={{ width: '100%', height: '80%' }} contentFit="contain" />}
          <Text variant="label" color={Colors.white}>
            Tap to close
          </Text>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingBottom: 8 },
  card: { gap: 10, padding: 16, borderRadius: Radius.xl, backgroundColor: Colors.surface, ...Shadow.card },
  bigIcon: { width: 64, height: 64, borderRadius: 32, backgroundColor: Colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  statusCard: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, borderRadius: Radius.lg, backgroundColor: Colors.successSoft },
  mapWrap: { width: '100%', borderRadius: Radius.xl, overflow: 'hidden', backgroundColor: Colors.surfaceAlt },
  pin: {
    position: 'absolute',
    width: 20,
    height: 20,
    marginLeft: -10,
    marginTop: -10,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: Colors.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  bookingRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  typeIcon: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  ticketBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 6, borderRadius: Radius.pill, backgroundColor: Colors.primarySoft },
  imageModal: { flex: 1, backgroundColor: 'rgba(0,0,0,0.9)', alignItems: 'center', justifyContent: 'center', gap: 16, padding: 16 },
});
