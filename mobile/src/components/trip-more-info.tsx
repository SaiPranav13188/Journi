import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';

import { Colors, Radius, Shadow } from '@/constants/theme';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import type { Booking, CurrentWeather, TripPlan } from '@/lib/types';
import { BudgetLimitSheet } from './budget-limit-sheet';
import { BudgetSummary } from './budget-summary';
import { dayColor, TripMap } from './trip-map';
import { PressableScale } from './ui/pressable-scale';
import { Skeleton } from './ui/skeleton';
import { Text } from './ui/text';
import { WeatherCard } from './weather-card';

const TIME_LABEL = { morning: '☀️ Morning', afternoon: '⛅ Afternoon', evening: '🌙 Evening' } as const;

function SectionHeader({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  return (
    <View style={styles.sectionHeader}>
      <Text variant="h3">{title}</Text>
      {action && (
        <PressableScale onPress={onAction} hitSlop={8}>
          <Text variant="label" color={Colors.primary}>
            {action}
          </Text>
        </PressableScale>
      )}
    </View>
  );
}

/**
 * "More info" for a finalized trip: weather, itinerary, map and budget.
 * Loads its own data so it can sit under any trip on Home.
 */
export function TripMoreInfo({ tripId }: { tripId: string }) {
  const [plan, setPlan] = useState<TripPlan | null>(null);
  const [weather, setWeather] = useState<CurrentWeather | null>(null);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [limitOpen, setLimitOpen] = useState(false);

  useEffect(() => {
    let active = true;
    api
      .getTrip(tripId)
      .then((p) => {
        if (!active) return;
        setPlan(p);
        const d = p.trip.destination;
        api.weather(d.latitude, d.longitude).then((w) => active && setWeather(w)).catch(() => {});
        api.bookings(tripId).then((b) => active && setBookings(b)).catch(() => {});
        // Pin places on the map the first time.
        if (p.days.some((day) => day.activities.some((a) => !a.placeholder && a.lat == null))) {
          setLocating(true);
          api
            .geocode({ tripId })
            .then((res) => active && setPlan((cur) => (cur ? { ...cur, days: res.days } : cur)))
            .catch(() => {})
            .finally(() => active && setLocating(false));
        }
      })
      .catch((err) => active && setError((err as Error).message));
    return () => {
      active = false;
    };
  }, [tripId]);

  if (error) {
    return (
      <Text variant="caption" color={Colors.muted} center>
        {error}
      </Text>
    );
  }
  if (!plan) {
    return (
      <View style={{ gap: 14 }}>
        <Skeleton height={170} radius={Radius.xl} />
        <Skeleton height={220} radius={Radius.xl} />
      </View>
    );
  }

  const { trip, days, budget } = plan;
  const d = trip.destination;
  const booked = bookings.filter((b) => b.status !== 'cancelled').reduce((s, b) => s + b.cost_inr, 0);

  return (
    <Animated.View entering={FadeInDown.duration(350)} style={{ gap: 18 }}>
      {/* Weather */}
      {weather ? <WeatherCard place={d.name} weather={weather} /> : <Skeleton height={170} radius={Radius.xl} />}

      {/* Itinerary */}
      <View style={styles.card}>
        <SectionHeader title="Itinerary" action="View all" onAction={() => router.push(`/trip/${tripId}`)} />
        {days.map((day) => {
          const items = day.activities.filter((a) => !a.placeholder).slice(0, 2);
          return (
            <View key={day.day_number} style={styles.timelineRow}>
              <View style={styles.dateCol}>
                <Text variant="overline" color={Colors.muted} style={{ fontSize: 10 }}>
                  {formatDate(day.date, { month: 'short' })}
                </Text>
                <Text variant="h3">{formatDate(day.date, { day: 'numeric' })}</Text>
              </View>
              <View style={[styles.timelineDot, { backgroundColor: dayColor(day.day_number) }]} />
              <View style={{ flex: 1, gap: 8 }}>
                {items.length === 0 ? (
                  <Text variant="caption" color={Colors.muted}>
                    Nothing planned yet
                  </Text>
                ) : (
                  items.map((a) => (
                    <PressableScale key={a.id} onPress={() => router.push(`/trip/${tripId}`)} style={styles.timelineItem}>
                      <View style={{ flex: 1 }}>
                        <Text variant="label" numberOfLines={1}>
                          {a.title}
                        </Text>
                        <Text variant="caption" color={Colors.muted} numberOfLines={1} style={{ fontSize: 11 }}>
                          {TIME_LABEL[a.time_of_day] ?? a.time_of_day}
                          {a.place_name && a.place_name !== a.title ? ` · ${a.place_name}` : ''}
                        </Text>
                      </View>
                      <View style={[styles.statusChip, a.status === 'confirmed' ? styles.confirmed : styles.planned]}>
                        <Text variant="caption" color={a.status === 'confirmed' ? Colors.success : Colors.muted} style={{ fontSize: 11 }}>
                          {a.status === 'confirmed' ? 'Confirmed' : 'Planned'}
                        </Text>
                      </View>
                    </PressableScale>
                  ))
                )}
              </View>
            </View>
          );
        })}
      </View>

      {/* Map */}
      <View>
        <SectionHeader title="Map" action="Full map" onAction={() => router.push(`/trip/${tripId}?tab=map`)} />
        <PressableScale onPress={() => router.push(`/trip/${tripId}?tab=map`)}>
          <View pointerEvents="none">
            <TripMap days={days} destination={d} compact locating={locating} />
          </View>
        </PressableScale>
      </View>

      {/* Budget */}
      {budget && (
        <>
          <BudgetSummary
            budget={budget}
            limit={trip.budget_limit_inr}
            booked={booked}
            onSetLimit={() => setLimitOpen(true)}
            onViewDetails={() => router.push(`/trip/${tripId}?tab=budget`)}
          />
          <BudgetLimitSheet
            visible={limitOpen}
            current={trip.budget_limit_inr}
            estimate={budget.total_inr}
            onClose={() => setLimitOpen(false)}
            onSave={async (limit) => {
              await api.setBudgetLimit(tripId, limit);
              setPlan((cur) => (cur ? { ...cur, trip: { ...cur.trip, budget_limit_inr: limit } } : cur));
            }}
          />
        </>
      )}
    </Animated.View>
  );
}

/** The "More info" button that opens/closes the section. */
export function MoreInfoToggle({ open, onPress }: { open: boolean; onPress: () => void }) {
  return (
    <PressableScale haptic onPress={onPress} style={styles.toggle} accessibilityLabel={open ? 'Hide more info' : 'Show more info'}>
      <Ionicons name="information-circle-outline" size={20} color={Colors.primary} />
      <View style={{ flex: 1 }}>
        <Text variant="label" color={Colors.primaryDark}>
          {open ? 'Hide info' : 'More info'}
        </Text>
        {!open && (
          <Text variant="caption" color={Colors.muted} style={{ fontSize: 12 }}>
            Weather, itinerary, map & budget
          </Text>
        )}
      </View>
      <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={18} color={Colors.primary} />
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  card: { gap: 12, padding: 16, borderRadius: Radius.xl, backgroundColor: Colors.surface, ...Shadow.card },
  timelineRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  dateCol: { width: 36, alignItems: 'center' },
  timelineDot: { width: 8, height: 8, borderRadius: 4, marginTop: 8 },
  timelineItem: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusChip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: Radius.pill },
  confirmed: { backgroundColor: Colors.successSoft },
  planned: { backgroundColor: Colors.surfaceAlt },
  toggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: Radius.lg,
    backgroundColor: Colors.primarySoft,
  },
});
