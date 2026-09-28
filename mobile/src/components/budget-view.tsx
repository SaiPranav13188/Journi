import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { FadeInDown, useAnimatedStyle, useSharedValue, withDelay, withTiming, Easing } from 'react-native-reanimated';

import { Colors, Gradients, Radius, Shadow } from '@/constants/theme';
import { formatDate, formatMoney, formatRate, formatTimestamp } from '@/lib/format';
import type { Budget, ItineraryDay } from '@/lib/types';
import { PressableScale } from './ui/pressable-scale';
import { Text, type AppTextProps } from './ui/text';

/** Number that counts up smoothly whenever the value changes. */
function AnimatedMoney({ value, currency, ...textProps }: { value: number; currency: string } & AppTextProps) {
  const [display, setDisplay] = useState(value);
  const from = useRef(value);

  useEffect(() => {
    const start = from.current;
    const startTime = Date.now();
    const duration = 900;
    let frame: number;
    const tick = () => {
      const t = Math.min((Date.now() - startTime) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(start + (value - start) * eased);
      if (t < 1) frame = requestAnimationFrame(tick);
      else from.current = value;
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value]);

  return <Text {...textProps}>{formatMoney(display, currency)}</Text>;
}

function Bar({ fraction, color, delay }: { fraction: number; color: string; delay: number }) {
  const width = useSharedValue(0);
  useEffect(() => {
    width.set(withDelay(delay, withTiming(fraction, { duration: 800, easing: Easing.out(Easing.cubic) })));
  }, [fraction, delay, width]);
  const style = useAnimatedStyle(() => ({ width: `${Math.max(width.value * 100, 2)}%` }));
  return (
    <View style={styles.track}>
      <Animated.View style={[styles.fill, { backgroundColor: color }, style]} />
    </View>
  );
}

export function BudgetView({
  budget,
  days,
  originCity,
  destinationName,
  onEditFlights,
}: {
  budget: Budget;
  days: ItineraryDay[];
  originCity?: string | null;
  destinationName: string;
  /** Opens the "enter flight cost" dialog. */
  onEditFlights?: () => void;
}) {
  const foodSpots = budget.food_spots_inr ?? Math.max(0, budget.food_estimate - budget.food_per_day_inr * budget.num_days);
  const code = budget.local_currency_code;
  const rate = budget.exchange_rate_used;
  const showLocal = budget.is_international && rate != null;
  const toLocal = (inr: number) => (rate != null ? inr * rate : null);

  const flights = budget.flights_estimate ?? 0;
  const onGround = budget.on_ground_inr ?? budget.total_inr - flights;
  const rows = [
    {
      key: 'flights',
      label: 'Flights (return)',
      icon: 'airplane-outline' as const,
      color: '#0EA5E9',
      value: flights,
      detail:
        budget.flight_note === 'Entered by you'
          ? 'Entered by you'
          : budget.flight_note ||
            (originCity ? `${originCity} ⇄ ${destinationName}, economy, up and down` : 'Not included yet — add your flight cost'),
      action: onEditFlights ? { label: budget.flights_estimate ? 'Edit' : '+ Add flight cost', onPress: onEditFlights } : undefined,
    },
    {
      key: 'accommodation',
      label: 'Accommodation',
      icon: 'bed-outline' as const,
      color: '#0E6E6B',
      value: budget.accommodation_estimate,
      detail:
        budget.nights > 0
          ? `${formatMoney(budget.accommodation_per_night_inr, 'INR')} / night × ${budget.nights} night${budget.nights === 1 ? '' : 's'}`
          : 'No overnight stay',
    },
    {
      key: 'food',
      label: 'Food & drinks',
      icon: 'restaurant-outline' as const,
      color: '#FF6B4A',
      value: budget.food_estimate,
      detail: `${formatMoney(budget.food_per_day_inr, 'INR')} / day × ${budget.num_days} days${
        foodSpots > 0 ? ` + ${formatMoney(foodSpots, 'INR')} at cafés & restaurants in your plan` : ''
      }`,
    },
    {
      key: 'transport',
      label: 'Local transport',
      icon: 'bus-outline' as const,
      color: '#6366F1',
      value: budget.transport_estimate,
      detail: `${formatMoney(budget.local_transport_per_day_inr, 'INR')} / day × ${budget.num_days} days`,
    },
    {
      key: 'activities',
      label: 'Activities & entry fees',
      icon: 'ticket-outline' as const,
      color: '#F2B84B',
      value: budget.activities_estimate,
      detail: 'Entry fees & tickets for the places in your itinerary — see day by day below',
    },
  ];
  const max = Math.max(...rows.map((r) => r.value), 1);

  return (
    <View style={{ gap: 16 }}>
      <Animated.View entering={FadeInDown.duration(400)} style={styles.totalCard}>
        <LinearGradient colors={Gradients.night} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
        <View style={styles.totalDecor} />
        <Text variant="overline" color={Colors.gold}>
          {flights > 0 ? 'Total incl. return flights · per person' : 'Estimated total · per person'}
        </Text>
        <AnimatedMoney value={budget.total_inr} currency="INR" variant="display" color={Colors.white} style={{ marginTop: 6 }} />
        <Text variant="caption" color="rgba(255,255,255,0.65)">
          Indian Rupees (INR)
        </Text>
        {flights > 0 && (
          <View style={styles.split}>
            <View style={styles.splitItem}>
              <Ionicons name="airplane" size={14} color={Colors.gold} />
              <Text variant="caption" color="rgba(255,255,255,0.85)">
                Flights {formatMoney(flights, 'INR')}
              </Text>
            </View>
            <Text variant="caption" color="rgba(255,255,255,0.5)">
              +
            </Text>
            <View style={styles.splitItem}>
              <Ionicons name="location" size={14} color={Colors.gold} />
              <Text variant="caption" color="rgba(255,255,255,0.85)">
                On the ground {formatMoney(onGround, 'INR')}
              </Text>
            </View>
          </View>
        )}
        {showLocal && budget.total_local_currency != null && (
          <View style={styles.localTotal}>
            <Ionicons name="swap-vertical" size={16} color={Colors.gold} />
            <AnimatedMoney value={budget.total_local_currency} currency={code} variant="h3" color={Colors.white} />
            <Text variant="caption" color="rgba(255,255,255,0.65)">
              in {code}
            </Text>
          </View>
        )}
        {budget.is_international && rate == null && (
          <Text variant="caption" color="rgba(255,255,255,0.7)" style={{ marginTop: 10 }}>
            Live {code} rate unavailable right now — showing INR only.
          </Text>
        )}
      </Animated.View>

      <Animated.View entering={FadeInDown.delay(100).duration(400)} style={styles.card}>
        <Text variant="h3" style={{ marginBottom: 4 }}>
          Breakdown
        </Text>
        {rows.map((r, i) => (
          <View key={r.key} style={styles.row}>
            <View style={[styles.rowIcon, { backgroundColor: `${r.color}1A` }]}>
              <Ionicons name={r.icon} size={18} color={r.color} />
            </View>
            <View style={{ flex: 1, gap: 6 }}>
              <View style={styles.rowTop}>
                <Text variant="label" style={{ flex: 1 }}>
                  {r.label}
                </Text>
                <View style={{ alignItems: 'flex-end' }}>
                  <Text variant="bodyStrong">{formatMoney(r.value, 'INR')}</Text>
                  {showLocal && (
                    <Text variant="caption" color={Colors.muted}>
                      {formatMoney(toLocal(r.value), code)}
                    </Text>
                  )}
                </View>
              </View>
              <Bar fraction={r.value / max} color={r.color} delay={150 + i * 90} />
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text variant="caption" color={Colors.muted} style={{ flex: 1 }}>
                  {r.detail}
                </Text>
                {'action' in r && r.action && (
                  <PressableScale haptic onPress={r.action.onPress} hitSlop={8} style={styles.rowAction}>
                    <Text variant="label" color={Colors.primary} style={{ fontSize: 12 }}>
                      {r.action.label}
                    </Text>
                  </PressableScale>
                )}
              </View>
            </View>
          </View>
        ))}
      </Animated.View>

      <Animated.View entering={FadeInDown.delay(160).duration(400)} style={styles.card}>
        <View>
          <Text variant="h3">Day by day</Text>
          <Text variant="caption" color={Colors.muted}>
            Every place in your plan and what it costs. Add or remove places and this updates.
          </Text>
        </View>
        {days.map((day) => {
          const items = day.activities.filter((a) => !a.placeholder);
          const dayTotal = items.reduce((sum, a) => sum + (a.estimated_cost_inr || 0), 0);
          return (
            <View key={day.day_number} style={styles.dayBlock}>
              <View style={styles.dayHead}>
                <Text variant="label">
                  Day {day.day_number} · {formatDate(day.date, { weekday: 'short', day: 'numeric', month: 'short' })}
                </Text>
                <Text variant="label" color={Colors.primary}>
                  {formatMoney(dayTotal, 'INR')}
                </Text>
              </View>
              {items.length === 0 ? (
                <Text variant="caption" color={Colors.muted}>
                  No places yet
                </Text>
              ) : (
                items.map((a) => (
                  <View key={a.id} style={styles.itemRow}>
                    <Ionicons
                      name={a.category === 'food' ? 'restaurant-outline' : 'ticket-outline'}
                      size={13}
                      color={a.category === 'food' ? '#FF6B4A' : Colors.muted}
                    />
                    <Text variant="caption" color={Colors.inkSoft} numberOfLines={1} style={{ flex: 1 }}>
                      {a.title}
                      {(a.added_by_user || a.source_suggestion_id) && (
                        <Text variant="caption" color={Colors.accent}>
                          {'  '}· added
                        </Text>
                      )}
                    </Text>
                    <Text variant="caption" color={a.estimated_cost_inr > 0 ? Colors.ink : Colors.muted}>
                      {a.estimated_cost_inr > 0 ? formatMoney(a.estimated_cost_inr, 'INR') : 'Free'}
                    </Text>
                  </View>
                ))
              )}
            </View>
          );
        })}
      </Animated.View>

      {showLocal && (
        <Animated.View entering={FadeInDown.delay(200).duration(400)} style={styles.rateCard}>
          <Ionicons name="trending-up" size={20} color={Colors.primary} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="label">
              1 INR = {formatRate(rate!)} {code} · 1 {code} = ₹{formatRate(1 / rate!)}
            </Text>
            <Text variant="caption" color={Colors.muted}>
              {budget.exchange_rate_timestamp ? `Rate as of ${formatTimestamp(budget.exchange_rate_timestamp)}` : 'Live rate'}
              {budget.exchange_rate_provider ? ` · ${budget.exchange_rate_provider}` : ''}. Rates fluctuate — treat converted figures as a guide.
            </Text>
          </View>
        </Animated.View>
      )}

      <Animated.View entering={FadeInDown.delay(260).duration(400)} style={styles.note}>
        <Ionicons name="information-circle-outline" size={18} color={Colors.muted} />
        <Text variant="caption" color={Colors.muted} style={{ flex: 1 }}>
          {budget.notes ? `${budget.notes} ` : ''}Mid-range estimates for one traveller. Flight fares are typical economy prices for your dates and change often — check airlines before booking. Ask in chat to
          make it more budget-friendly or luxurious — the budget updates automatically.
        </Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  totalCard: { padding: 20, borderRadius: Radius.xxl, overflow: 'hidden', ...Shadow.raised },
  totalDecor: {
    position: 'absolute',
    right: -40,
    top: -40,
    width: 160,
    height: 160,
    borderRadius: 80,
    backgroundColor: 'rgba(242,184,75,0.12)',
  },
  split: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  splitItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  localTotal: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 14,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.12)',
  },
  card: { padding: 16, gap: 16, borderRadius: Radius.xl, backgroundColor: Colors.surface, ...Shadow.card },
  row: { flexDirection: 'row', gap: 12 },
  rowIcon: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  rowTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  track: { height: 6, borderRadius: 3, backgroundColor: Colors.surfaceAlt, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 3 },
  rowAction: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: Radius.pill, backgroundColor: Colors.primarySoft },
  dayBlock: { gap: 6, paddingTop: 12, borderTopWidth: 1, borderTopColor: Colors.surfaceAlt },
  dayHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  itemRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rateCard: { flexDirection: 'row', gap: 12, padding: 14, borderRadius: Radius.lg, backgroundColor: Colors.primarySoft },
  note: { flexDirection: 'row', gap: 8, paddingHorizontal: 4 },
});
