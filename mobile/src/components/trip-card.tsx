import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, View } from 'react-native';

import { Colors, Radius, Shadow } from '@/constants/theme';
import { daysUntil, formatDateRange, formatMoney } from '@/lib/format';
import type { TripListItem } from '@/lib/types';
import { PlacePhoto } from './place-photo';
import { PressableScale } from './ui/pressable-scale';
import { Text } from './ui/text';

function countdownLabel(start: string, end: string) {
  const toStart = daysUntil(start);
  const toEnd = daysUntil(end);
  if (toStart > 1) return `In ${toStart} days`;
  if (toStart === 1) return 'Tomorrow';
  if (toStart === 0) return 'Starts today';
  if (toEnd >= 0) return 'Happening now';
  return 'Completed';
}

export function StatusPill({ status, onDark }: { status: TripListItem['status']; onDark?: boolean }) {
  const finalized = status === 'finalized';
  return (
    <View
      style={[
        styles.pill,
        { backgroundColor: finalized ? Colors.successSoft : onDark ? 'rgba(255,255,255,0.92)' : Colors.accentSoft },
      ]}
    >
      <Ionicons name={finalized ? 'checkmark-circle' : 'sparkles'} size={12} color={finalized ? Colors.success : Colors.accent} />
      <Text variant="overline" color={finalized ? Colors.success : Colors.accent} style={{ letterSpacing: 0.6 }}>
        {finalized ? 'Finalized' : 'Planning'}
      </Text>
    </View>
  );
}

interface TripCardProps {
  trip: TripListItem;
  onPress: () => void;
  onLongPress?: () => void;
}

export function TripCard({ trip, onPress, onLongPress }: TripCardProps) {
  const d = trip.destination;
  const past = daysUntil(trip.end_date) < 0;

  return (
    <PressableScale onPress={onPress} onLongPress={onLongPress} delayLongPress={350} haptic style={[styles.card, past && { opacity: 0.85 }]}>
      <PlacePhoto uri={d.image_url} query={d.image_url ? null : [d.name, d.country].filter(Boolean).join(', ')} width={1000} style={styles.photo} fallbackIcon="airplane">
        <LinearGradient colors={['rgba(8,16,28,0.35)', 'rgba(8,16,28,0)', 'rgba(8,16,28,0.8)']} locations={[0, 0.35, 1]} style={StyleSheet.absoluteFill} />
        <View style={styles.photoTop}>
          <StatusPill status={trip.status} onDark />
          <View style={styles.countdown}>
            <Ionicons name={past ? 'flag' : 'time-outline'} size={12} color={Colors.white} />
            <Text variant="overline" color={Colors.white} style={{ letterSpacing: 0.4 }}>
              {countdownLabel(trip.start_date, trip.end_date)}
            </Text>
          </View>
        </View>
        <View style={styles.photoBottom}>
          <Text variant="h2" color={Colors.white} numberOfLines={1}>
            {d.name}
          </Text>
          <Text variant="caption" color="rgba(255,255,255,0.85)">
            {[d.country, formatDateRange(trip.start_date, trip.end_date)].filter(Boolean).join('  ·  ')}
          </Text>
        </View>
      </PlacePhoto>

      <View style={styles.body}>
        {!!trip.summary && (
          <Text variant="caption" color={Colors.inkSoft} numberOfLines={1}>
            {trip.summary}
          </Text>
        )}
        <View style={styles.metaRow}>
          <View style={styles.meta}>
            <Ionicons name="calendar-outline" size={15} color={Colors.primary} />
            <Text variant="label">{trip.num_days} days</Text>
          </View>
          {trip.total_inr != null && (
            <View style={styles.meta}>
              <Ionicons name="wallet-outline" size={15} color={Colors.primary} />
              <Text variant="label">
                {formatMoney(trip.total_inr, 'INR', { compact: true })}
                {trip.local_currency_code !== 'INR' && trip.total_local_currency != null && (
                  <Text variant="caption" color={Colors.muted}>
                    {'  '}≈ {formatMoney(trip.total_local_currency, trip.local_currency_code, { compact: true })}
                  </Text>
                )}
              </Text>
            </View>
          )}
          {trip.warning_count > 0 && !past && (
            <View style={[styles.meta, styles.warnChip]}>
              <Ionicons name="warning" size={13} color={Colors.warning} />
              <Text variant="caption" color={Colors.warning}>
                {trip.warning_count}
              </Text>
            </View>
          )}
        </View>
      </View>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: Radius.xl, backgroundColor: Colors.surface, ...Shadow.card },
  photo: { height: 190, borderTopLeftRadius: Radius.xl, borderTopRightRadius: Radius.xl },
  photoTop: { flexDirection: 'row', justifyContent: 'space-between', padding: 14 },
  photoBottom: { position: 'absolute', left: 16, right: 16, bottom: 14 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 9, paddingVertical: 5, borderRadius: Radius.pill },
  countdown: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: Radius.pill,
    backgroundColor: 'rgba(8,16,28,0.45)',
  },
  body: { padding: 14, gap: 10 },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 16, flexWrap: 'wrap' },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  warnChip: {
    marginLeft: 'auto',
    backgroundColor: Colors.warningBg,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: Radius.pill,
    gap: 4,
  },
});
