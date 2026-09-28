import { Ionicons } from '@expo/vector-icons';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { Colors, Radius, Shadow } from '@/constants/theme';
import { formatMoney } from '@/lib/format';
import type { Budget } from '@/lib/types';
import { PressableScale } from './ui/pressable-scale';
import { Text } from './ui/text';

interface BudgetSummaryProps {
  budget: Budget;
  limit: number | null | undefined;
  /** Money already booked (Bookings) for this trip. */
  booked?: number;
  onSetLimit?: () => void;
  onViewDetails?: () => void;
  title?: string;
}

const ROWS: { key: keyof Budget; label: string; icon: keyof typeof Ionicons.glyphMap; color: string }[] = [
  { key: 'flights_estimate', label: 'Flights', icon: 'airplane-outline', color: '#0EA5E9' },
  { key: 'accommodation_estimate', label: 'Accommodation', icon: 'bed-outline', color: '#0E6E6B' },
  { key: 'activities_estimate', label: 'Activities', icon: 'ticket-outline', color: '#F2B84B' },
  { key: 'food_estimate', label: 'Food', icon: 'restaurant-outline', color: '#FF6B4A' },
  { key: 'transport_estimate', label: 'Transport', icon: 'bus-outline', color: '#6366F1' },
];

/** "Trip Budget" card: estimate vs your own limit, with a progress bar and categories. */
export function BudgetSummary({ budget, limit, booked = 0, onSetLimit, onViewDetails, title = 'Trip budget' }: BudgetSummaryProps) {
  const estimate = budget.total_inr;
  const pct = limit ? estimate / limit : 0;
  const over = limit ? estimate > limit : false;
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.set(withTiming(Math.min(pct, 1), { duration: 900, easing: Easing.out(Easing.cubic) }));
  }, [pct, progress]);
  const barStyle = useAnimatedStyle(() => ({ width: `${progress.value * 100}%` }));

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Text variant="h3">{title}</Text>
        {onViewDetails && (
          <PressableScale onPress={onViewDetails} hitSlop={8}>
            <Text variant="label" color={Colors.primary}>
              View details
            </Text>
          </PressableScale>
        )}
      </View>

      <View>
        <Text variant="h1">{formatMoney(estimate, 'INR')}</Text>
        {limit ? (
          <Text variant="caption" color={Colors.muted}>
            estimated · of your {formatMoney(limit, 'INR')} budget
          </Text>
        ) : (
          <Text variant="caption" color={Colors.muted}>
            estimated per person, incl. flights
          </Text>
        )}
      </View>

      {limit ? (
        <View style={{ gap: 6 }}>
          <View style={styles.track}>
            <Animated.View style={[styles.fill, { backgroundColor: over ? Colors.danger : Colors.success }, barStyle]} />
          </View>
          <View style={styles.head}>
            <Text variant="caption" color={over ? Colors.danger : Colors.success}>
              {over ? `${formatMoney(estimate - limit, 'INR')} over budget` : `${formatMoney(limit - estimate, 'INR')} left`}
            </Text>
            <PressableScale onPress={onSetLimit} hitSlop={8}>
              <Text variant="caption" color={Colors.primary}>
                {Math.round(pct * 100)}% · Edit
              </Text>
            </PressableScale>
          </View>
        </View>
      ) : (
        onSetLimit && (
          <PressableScale haptic onPress={onSetLimit} style={styles.setLimit}>
            <Ionicons name="flag-outline" size={16} color={Colors.primary} />
            <Text variant="label" color={Colors.primary}>
              Set your budget limit
            </Text>
          </PressableScale>
        )
      )}

      {booked > 0 && (
        <View style={styles.booked}>
          <Ionicons name="checkmark-done-outline" size={16} color={Colors.success} />
          <Text variant="caption" color={Colors.inkSoft} style={{ flex: 1 }}>
            Booked so far
          </Text>
          <Text variant="label">{formatMoney(booked, 'INR')}</Text>
        </View>
      )}

      <View style={{ gap: 8 }}>
        {ROWS.map((r) => {
          const value = Number(budget[r.key] ?? 0);
          if (r.key === 'flights_estimate' && !value) return null;
          return (
            <View key={r.key} style={styles.row}>
              <Ionicons name={r.icon} size={16} color={r.color} />
              <Text variant="caption" color={Colors.inkSoft} style={{ flex: 1 }}>
                {r.label}
              </Text>
              <Text variant="label" style={{ fontSize: 13 }}>
                {formatMoney(value, 'INR')}
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: 14, padding: 16, borderRadius: Radius.xl, backgroundColor: Colors.surface, ...Shadow.card },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  track: { height: 8, borderRadius: 4, backgroundColor: Colors.surfaceAlt, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 4 },
  setLimit: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 40,
    borderRadius: Radius.pill,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: Colors.primary,
  },
  booked: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderRadius: Radius.md, backgroundColor: Colors.successSoft },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
});
