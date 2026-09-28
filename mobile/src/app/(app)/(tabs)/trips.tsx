import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { router, useFocusEffect } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useState } from 'react';
import { Alert, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { FadeInDown, FadeInUp, LinearTransition } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PlacePhoto } from '@/components/place-photo';
import { TripCard } from '@/components/trip-card';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { PressableScale } from '@/components/ui/pressable-scale';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { Colors, Radius } from '@/constants/theme';
import { api } from '@/lib/api';
import { clearDraft, loadDraft } from '@/lib/draft';
import { daysUntil, formatDateRange } from '@/lib/format';
import type { TripListItem, TripPlan } from '@/lib/types';

type Filter = 'upcoming' | 'past' | 'all';

export default function TripsScreen() {
  const insets = useSafeAreaInsets();
  const [trips, setTrips] = useState<TripListItem[] | null>(null);
  const [draft, setDraft] = useState<TripPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<Filter>('upcoming');

  const load = useCallback(async () => {
    loadDraft().then(setDraft);
    try {
      setTrips(await api.listTrips());
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

  const confirmDelete = (trip: TripListItem) => {
    Alert.alert(`Delete ${trip.destination.name} trip?`, 'This removes the itinerary, budget, bookings and conversation. This can’t be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          setTrips((prev) => prev?.filter((t) => t.id !== trip.id) ?? null);
          try {
            await api.deleteTrip(trip.id);
          } catch (err) {
            Alert.alert('Could not delete trip', (err as Error).message);
            load();
          }
        },
      },
    ]);
  };

  const upcoming = (trips ?? []).filter((t) => daysUntil(t.end_date) >= 0);
  const past = (trips ?? []).filter((t) => daysUntil(t.end_date) < 0).reverse();
  const shown = filter === 'upcoming' ? upcoming : filter === 'past' ? past : [...upcoming, ...past];

  return (
    <View style={{ flex: 1, backgroundColor: Colors.bg }}>
      <StatusBar style="dark" />
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + 12, paddingBottom: 32, paddingHorizontal: 20, gap: 16 }}
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
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text variant="h1">Your trips</Text>
            <Text variant="caption" color={Colors.muted}>
              {trips ? `${trips.length} saved · ${upcoming.length} upcoming` : 'Loading…'}
            </Text>
          </View>
          <Button title="New trip" icon="add" size="sm" onPress={() => router.push('/new-trip')} />
        </View>

        {draft && (
          <Animated.View entering={FadeInDown.duration(400)} layout={LinearTransition}>
            <PressableScale haptic onPress={() => router.push('/trip/draft')} style={styles.draft}>
              <PlacePhoto uri={draft.trip.destination.image_url} query={draft.trip.destination.name} style={styles.draftPhoto} width={300} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text variant="overline" color={Colors.accent}>
                  Unsaved plan
                </Text>
                <Text variant="title" numberOfLines={1}>
                  {draft.trip.destination.name}
                </Text>
                <Text variant="caption" color={Colors.muted}>
                  {formatDateRange(draft.trip.start_date, draft.trip.end_date)} · tap to continue
                </Text>
              </View>
              <IconButton
                icon="close"
                size={34}
                variant="plain"
                color={Colors.muted}
                onPress={() =>
                  Alert.alert('Discard unsaved plan?', 'Your unsaved itinerary and chat will be lost.', [
                    { text: 'Keep', style: 'cancel' },
                    {
                      text: 'Discard',
                      style: 'destructive',
                      onPress: async () => {
                        await clearDraft();
                        setDraft(null);
                      },
                    },
                  ])
                }
                accessibilityLabel="Discard draft"
              />
            </PressableScale>
          </Animated.View>
        )}

        <View style={styles.filters}>
          {(
            [
              { key: 'upcoming', label: `Upcoming${trips ? ` (${upcoming.length})` : ''}` },
              { key: 'past', label: `Past${trips ? ` (${past.length})` : ''}` },
              { key: 'all', label: 'All' },
            ] as const
          ).map((f) => (
            <PressableScale key={f.key} haptic onPress={() => setFilter(f.key)} style={[styles.filter, filter === f.key && styles.filterActive]}>
              <Text variant="label" color={filter === f.key ? Colors.white : Colors.inkSoft}>
                {f.label}
              </Text>
            </PressableScale>
          ))}
        </View>

        {error && !trips ? (
          <View style={styles.box}>
            <Ionicons name="cloud-offline-outline" size={32} color={Colors.muted} />
            <Text variant="body" color={Colors.inkSoft} center>
              {error}
            </Text>
            <Button title="Try again" variant="secondary" size="sm" onPress={load} />
          </View>
        ) : trips === null ? (
          [0, 1].map((i) => <Skeleton key={i} height={250} radius={Radius.xl} />)
        ) : shown.length === 0 ? (
          <Animated.View entering={FadeInUp.duration(400)} style={styles.box}>
            <Image source={require('@/assets/images/onboarding/oia_greece.jpg')} style={styles.emptyImg} contentFit="cover" />
            <Text variant="h3" center>
              {filter === 'past' ? 'No past trips yet' : 'No upcoming trips'}
            </Text>
            <Text variant="body" color={Colors.inkSoft} center>
              {filter === 'past' ? 'Trips you’ve completed will appear here.' : 'Pick a destination and dates — Journi plans the rest.'}
            </Text>
            {filter !== 'past' && <Button title="Plan a trip" icon="sparkles" onPress={() => router.push('/new-trip')} />}
          </Animated.View>
        ) : (
          <>
            {shown.map((trip, i) => (
              <Animated.View key={trip.id} entering={FadeInDown.delay(50 * i).duration(400)} layout={LinearTransition}>
                <TripCard
                  trip={trip}
                  onPress={() => router.push(`/trip/${trip.id}`)}
                  onLongPress={() => confirmDelete(trip)}
                />
              </Animated.View>
            ))}
            <Text variant="caption" color={Colors.muted} center>
              Tip: long-press a trip to delete it.
            </Text>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  draft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 10,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1.5,
    borderColor: Colors.accentSoft,
    borderStyle: 'dashed',
  },
  draftPhoto: { width: 60, height: 60, borderRadius: Radius.md },
  filters: { flexDirection: 'row', gap: 8 },
  filter: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: Radius.pill, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border },
  filterActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  box: { alignItems: 'center', gap: 10, padding: 22, borderRadius: Radius.xl, backgroundColor: Colors.surface },
  emptyImg: { width: 160, height: 110, borderRadius: Radius.lg },
});
