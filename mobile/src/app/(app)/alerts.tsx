import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { IconButton } from '@/components/ui/icon-button';
import { PressableScale } from '@/components/ui/pressable-scale';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { Colors, Radius, Shadow } from '@/constants/theme';
import { api } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import type { TripAlert } from '@/lib/types';

/** Icon per alert kind: weather warnings, Weather Watcher rework previews, budget concerns. */
function alertIcon(a: TripAlert): keyof typeof Ionicons.glyphMap {
  if (a.kind === 'rework_suggestion') return 'umbrella-outline';
  if (a.kind === 'budget_concern') return 'wallet-outline';
  return 'thunderstorm-outline';
}

export default function AlertsScreen() {
  const insets = useSafeAreaInsets();
  const [alerts, setAlerts] = useState<TripAlert[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = () =>
    api
      .listAlerts()
      .then((list) => {
        setAlerts(list);
        setError(null);
        // Opening the inbox marks everything as seen.
        if (list.some((a) => !a.read)) api.markAlertsRead().catch(() => {});
      })
      .catch((err: Error) => setError(err.message));

  useEffect(() => {
    api
      .listAlerts()
      .then((list) => {
        setAlerts(list);
        if (list.some((a) => !a.read)) api.markAlertsRead().catch(() => {});
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: Colors.bg, paddingTop: insets.top > 20 ? 12 : insets.top + 12 }}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text variant="h2">Trip alerts</Text>
          <Text variant="caption" color={Colors.muted}>
            We re-check the forecast daily for your upcoming trips.
          </Text>
        </View>
        <IconButton icon="close" onPress={() => router.back()} accessibilityLabel="Close" />
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 16, gap: 10, paddingBottom: insets.bottom + 24 }}
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
      >
        {error ? (
          <Text variant="body" color={Colors.inkSoft} center style={{ marginTop: 40 }}>
            {error}
          </Text>
        ) : alerts === null ? (
          [0, 1, 2].map((i) => <Skeleton key={i} height={76} radius={Radius.lg} />)
        ) : alerts.length === 0 ? (
          <Animated.View entering={FadeInDown} style={styles.empty}>
            <View style={styles.emptyIcon}>
              <Ionicons name="sunny" size={34} color={Colors.gold} />
            </View>
            <Text variant="h3" center>
              Clear skies ahead
            </Text>
            <Text variant="body" color={Colors.inkSoft} center>
              If the forecast turns bad for one of your saved trips, you’ll see it here.
            </Text>
          </Animated.View>
        ) : (
          alerts.map((a, i) => (
            <Animated.View key={a.id} entering={FadeInDown.delay(i * 50).duration(350)}>
              <PressableScale
                haptic
                onPress={() => {
                  router.back();
                  // A rework preview opens straight into Swap plan / Keep original.
                  if (a.kind === 'rework_suggestion' && a.metadata?.preview) {
                    router.push({ pathname: '/trip/[id]', params: { id: a.trip_id, rework: a.id } });
                  } else if (a.kind === 'budget_concern') {
                    router.push({ pathname: '/trip/[id]', params: { id: a.trip_id, tab: 'budget' } });
                  } else {
                    router.push(`/trip/${a.trip_id}`);
                  }
                }}
                style={[styles.alert, !a.read && styles.alertUnread]}
              >
                <View style={styles.alertIcon}>
                  <Ionicons name={alertIcon(a)} size={20} color={Colors.warning} />
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                    <Text variant="label" numberOfLines={1} style={{ flex: 1 }}>
                      {a.destination_name ?? 'Your trip'}
                      {a.day_number ? ` · Day ${a.day_number}` : ''}
                    </Text>
                    <Text variant="caption" color={Colors.muted}>
                      {timeAgo(a.created_at)}
                    </Text>
                  </View>
                  <Text variant="caption" color={Colors.inkSoft}>
                    {a.message}
                  </Text>
                  {a.kind === 'rework_suggestion' && a.metadata?.preview ? (
                    <Text variant="caption" color={Colors.primary}>
                      Tap to review the new plan
                    </Text>
                  ) : null}
                </View>
                {!a.read && <View style={styles.unreadDot} />}
              </PressableScale>
            </Animated.View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingBottom: 8 },
  empty: { alignItems: 'center', gap: 10, padding: 28, marginTop: 30, borderRadius: Radius.xl, backgroundColor: Colors.surface },
  emptyIcon: { width: 72, height: 72, borderRadius: 36, backgroundColor: '#FFF6DD', alignItems: 'center', justifyContent: 'center' },
  alert: { flexDirection: 'row', gap: 12, padding: 14, borderRadius: Radius.lg, backgroundColor: Colors.surface, ...Shadow.card },
  alertUnread: { borderWidth: 1, borderColor: Colors.warningBorder },
  alertIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: Colors.warningBg, alignItems: 'center', justifyContent: 'center' },
  unreadDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.accent, alignSelf: 'center' },
});
