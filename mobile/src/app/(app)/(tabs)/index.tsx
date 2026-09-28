import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useFocusEffect } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useState } from 'react';
import { Alert, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PlacePhoto } from '@/components/place-photo';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { PressableScale } from '@/components/ui/pressable-scale';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { weatherIcon } from '@/components/weather';
import { MoreInfoToggle, TripMoreInfo } from '@/components/trip-more-info';
import { Colors, Radius, Shadow } from '@/constants/theme';
import { displayName, useAuth } from '@/context/auth-context';
import { useSavedPlaces } from '@/hooks/use-saved-places';
import { api } from '@/lib/api';
import { loadDraft } from '@/lib/draft';
import { daysUntil, flagEmoji, formatDateRange } from '@/lib/format';
import { weatherAlertsEnabled } from '@/lib/profile';
import type { Dashboard, TripPlan } from '@/lib/types';

const POPULAR = [
  { name: 'Bali', country: 'Indonesia', code: 'ID', tag: 'Beaches & temples' },
  { name: 'Paris', country: 'France', code: 'FR', tag: 'Art & cafés' },
  { name: 'Ladakh', country: 'India', code: 'IN', tag: 'High passes' },
  { name: 'Istanbul', country: 'Türkiye', code: 'TR', tag: 'Bazaars & history' },
  { name: 'Kyoto', country: 'Japan', code: 'JP', tag: 'Temples & gardens' },
];

function StatCard({
  icon,
  tint,
  label,
  value,
  hint,
  onPress,
  delay,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  tint: string;
  label: string;
  value: number | string;
  hint: string;
  onPress: () => void;
  delay: number;
}) {
  return (
    <Animated.View entering={FadeInDown.delay(delay).duration(450)} style={{ flex: 1 }}>
      <PressableScale haptic onPress={onPress} style={styles.stat}>
        <View style={[styles.statIcon, { backgroundColor: `${tint}1A` }]}>
          <Ionicons name={icon} size={18} color={tint} />
        </View>
        <Text variant="caption" color={Colors.muted} numberOfLines={1}>
          {label}
        </Text>
        <Text variant="h2">{value}</Text>
        <Text variant="caption" color={Colors.inkSoft} numberOfLines={1} style={{ fontSize: 11 }}>
          {hint}
        </Text>
      </PressableScale>
    </Animated.View>
  );
}

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

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const saved = useSavedPlaces();
  const [data, setData] = useState<Dashboard | null>(null);
  const [draft, setDraft] = useState<TripPlan | null>(null);
  const [alertCount, setAlertCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Finalized trips whose "More info" section is open.
  const [openInfo, setOpenInfo] = useState<Set<string>>(new Set());
  const toggleInfo = (id: string) =>
    setOpenInfo((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const alertsOn = weatherAlertsEnabled(user);

  const load = useCallback(async () => {
    loadDraft().then(setDraft);
    saved.refresh();
    try {
      const d = await api.dashboard();
      setData(d);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
    api
      .listAlerts(true)
      .then((a) => setAlertCount(a.length))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const next = data?.next_trip ?? null;
  const nextDays = next ? daysUntil(next.trip.start_date) : 0;
  const avatarUrl: string | undefined = user?.user_metadata?.avatar_url;

  return (
    <View style={{ flex: 1, backgroundColor: Colors.bg }}>
      <StatusBar style="dark" />
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + 12, paddingBottom: 32 }}
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
        {/* Header */}
        <Animated.View entering={FadeInDown.duration(450)} style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text variant="h1" numberOfLines={1}>
              Hello, {displayName(user)}! ✈️
            </Text>
            <Text variant="caption" color={Colors.muted}>
              Where do you want to explore next?
            </Text>
          </View>
          <IconButton
            icon="notifications-outline"
            badge={alertsOn ? alertCount : 0}
            onPress={() => router.push('/alerts')}
            accessibilityLabel="Alerts"
          />
          <PressableScale onPress={() => router.push('/profile')} haptic accessibilityLabel="Profile" style={styles.avatar}>
            {avatarUrl ? (
              <Image source={{ uri: avatarUrl }} style={StyleSheet.absoluteFill} />
            ) : (
              <Text variant="bodyStrong" color={Colors.white}>
                {displayName(user).charAt(0).toUpperCase()}
              </Text>
            )}
          </PressableScale>
        </Animated.View>

        <View style={styles.section}>
          <Button title="New trip" icon="add" onPress={() => router.push('/new-trip')} fullWidth />
        </View>

        {/* Stats */}
        <View style={[styles.section, { gap: 10 }]}>
          <View style={styles.statRow}>
            <StatCard
              icon="briefcase-outline"
              tint={Colors.primary}
              label="Upcoming trips"
              value={data?.stats.upcoming_trips ?? '–'}
              hint={next ? `Next: ${next.trip.destination.name} ${nextDays > 0 ? `in ${nextDays} days` : 'now'}` : 'Plan your next one'}
              onPress={() => router.push('/trips')}
              delay={60}
            />
            <StatCard
              icon="earth-outline"
              tint="#16A34A"
              label="Countries visited"
              value={data?.stats.countries_visited ?? '–'}
              hint="Keep exploring!"
              onPress={() => router.push('/trips')}
              delay={110}
            />
          </View>
          <View style={styles.statRow}>
            <StatCard
              icon="heart-outline"
              tint={Colors.danger}
              label="Saved places"
              value={data ? saved.places.length || data.stats.saved_places : '–'}
              hint="Your bucket list"
              onPress={() => router.push('/explore')}
              delay={160}
            />
            <StatCard
              icon="map-outline"
              tint="#6366F1"
              label="Total trips"
              value={data?.stats.total_trips ?? '–'}
              hint="Trips planned"
              onPress={() => router.push('/trips')}
              delay={210}
            />
          </View>
        </View>

        {/* Unsaved draft */}
        {draft && (
          <Animated.View entering={FadeInDown.duration(400)} style={styles.section}>
            <PressableScale haptic onPress={() => router.push('/trip/draft')} style={styles.draft}>
              <Ionicons name="create-outline" size={20} color={Colors.accent} />
              <Text variant="label" style={{ flex: 1 }} numberOfLines={1}>
                Continue planning {draft.trip.destination.name} (not saved yet)
              </Text>
              <Ionicons name="chevron-forward" size={18} color={Colors.muted} />
            </PressableScale>
          </Animated.View>
        )}

        {error && !data ? (
          <View style={[styles.section, styles.box]}>
            <Ionicons name="cloud-offline-outline" size={32} color={Colors.muted} />
            <Text variant="body" color={Colors.inkSoft} center>
              {error}
            </Text>
            <Button title="Try again" variant="secondary" size="sm" onPress={load} />
          </View>
        ) : !data ? (
          <View style={[styles.section, { gap: 14 }]}>
            <Skeleton height={200} radius={Radius.xl} />
            <Skeleton height={160} radius={Radius.xl} />
          </View>
        ) : next ? (
          <>
            {/* Upcoming trip hero */}
            <Animated.View entering={FadeInDown.delay(120).duration(500)} style={styles.section}>
              <PressableScale haptic onPress={() => router.push(`/trip/${next.trip.id}`)} style={styles.hero}>
                <PlacePhoto
                  uri={next.trip.destination.image_url}
                  query={next.trip.destination.name}
                  width={1200}
                  style={StyleSheet.absoluteFill}
                />
                <LinearGradient
                  colors={['rgba(8,16,28,0.75)', 'rgba(8,16,28,0.2)', 'rgba(8,16,28,0.55)']}
                  style={StyleSheet.absoluteFill}
                />
                <View style={styles.heroContent}>
                  <View style={styles.heroTag}>
                    <Text variant="overline" color={Colors.white} style={{ letterSpacing: 0.6 }}>
                      Upcoming trip
                    </Text>
                  </View>
                  <Text variant="h1" color={Colors.white} numberOfLines={1}>
                    {next.trip.destination.name} {flagEmoji(next.trip.destination.country_code)}
                  </Text>
                  <Text variant="caption" color="rgba(255,255,255,0.85)">
                    {formatDateRange(next.trip.start_date, next.trip.end_date)} ({next.trip.num_days} days)
                  </Text>
                  <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', marginTop: 'auto' }}>
                    <View style={styles.heroBtn}>
                      <Text variant="label">View trip details</Text>
                    </View>
                    {next.weather && (
                      <View style={styles.heroWeather}>
                        <Ionicons name={weatherIcon(next.weather.current).name} size={18} color={Colors.white} />
                        <Text variant="label" color={Colors.white}>
                          {Math.round(next.weather.current.temp)}° {next.weather.current.condition}
                        </Text>
                      </View>
                    )}
                  </View>
                </View>
              </PressableScale>
            </Animated.View>

            {/* More info — finalized trips only */}
            {next.trip.status === 'finalized' && (
              <Animated.View entering={FadeInDown.delay(160).duration(450)} style={[styles.section, { gap: 14 }]}>
                <MoreInfoToggle open={openInfo.has(next.trip.id!)} onPress={() => toggleInfo(next.trip.id!)} />
                {openInfo.has(next.trip.id!) && <TripMoreInfo tripId={next.trip.id!} />}
              </Animated.View>
            )}

            {/* Upcoming trips */}
            {data.upcoming_trips.length > 0 && (
              <Animated.View entering={FadeInDown.delay(320).duration(500)} style={styles.section}>
                <View style={styles.card}>
                  <SectionHeader title="Upcoming trips" action="View all" onAction={() => router.push('/trips')} />
                  {data.upcoming_trips.map((t) => (
                    <View key={t.id} style={{ gap: 10 }}>
                      <PressableScale haptic onPress={() => router.push(`/trip/${t.id}`)} style={styles.upcomingRow}>
                        <PlacePhoto uri={t.destination.image_url} query={t.destination.name} width={200} style={styles.upcomingImg} />
                        <View style={{ flex: 1 }}>
                          <Text variant="label" numberOfLines={1}>
                            {t.destination.name}, {t.destination.country}
                          </Text>
                          <Text variant="caption" color={Colors.muted}>
                            {formatDateRange(t.start_date, t.end_date)}
                          </Text>
                        </View>
                        <View style={styles.daysChip}>
                          <Text variant="caption" color={Colors.inkSoft} style={{ fontSize: 11 }}>
                            {daysUntil(t.start_date) > 0 ? `${daysUntil(t.start_date)} days` : 'Now'}
                          </Text>
                        </View>
                      </PressableScale>
                      {t.status === 'finalized' && t.id !== next.trip.id && (
                        <>
                          <MoreInfoToggle open={openInfo.has(t.id)} onPress={() => toggleInfo(t.id)} />
                          {openInfo.has(t.id) && <TripMoreInfo tripId={t.id} />}
                        </>
                      )}
                    </View>
                  ))}
                </View>
              </Animated.View>
            )}
          </>
        ) : (
          /* No trips yet */
          <Animated.View entering={FadeInUp.delay(100).duration(500)} style={styles.section}>
            <PressableScale haptic onPress={() => router.push('/new-trip')} style={styles.hero}>
              <Image source={require('@/assets/images/onboarding/matterhorn.jpg')} style={StyleSheet.absoluteFill} contentFit="cover" />
              <LinearGradient colors={['rgba(8,16,28,0.05)', 'rgba(8,16,28,0.8)']} style={StyleSheet.absoluteFill} />
              <View style={[styles.heroContent, { justifyContent: 'flex-end' }]}>
                <Text variant="overline" color={Colors.gold}>
                  AI trip planner
                </Text>
                <Text variant="h2" color={Colors.white}>
                  Plan your first trip
                </Text>
                <Text variant="caption" color="rgba(255,255,255,0.85)">
                  Pick a destination and dates — Journi drafts the whole plan in seconds.
                </Text>
              </View>
            </PressableScale>
          </Animated.View>
        )}

        {/* Saved destinations */}
        <Animated.View entering={FadeInDown.delay(360).duration(500)} style={[styles.section, { paddingHorizontal: 0 }]}>
          <View style={{ paddingHorizontal: 20 }}>
            <SectionHeader
              title={saved.places.length ? 'Saved destinations' : 'Popular destinations'}
              action="Explore"
              onAction={() => router.push('/explore')}
            />
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 20, gap: 12 }}>
            {(saved.places.length
              ? saved.places.map((p) => ({
                  key: p.id,
                  name: p.name,
                  country: p.country,
                  code: p.country_code,
                  image: p.image_url,
                  tag: p.country ?? '',
                }))
              : POPULAR.map((p) => ({
                  key: p.name,
                  name: p.name,
                  country: p.country,
                  code: p.code,
                  image: null as string | null,
                  tag: p.tag,
                }))
            ).map((p) => {
              const isSaved = saved.isSaved({ name: p.name, country_code: p.code });
              return (
                <PressableScale
                  key={p.key}
                  haptic
                  onPress={() => router.push({ pathname: '/new-trip', params: { q: p.name } })}
                  style={styles.destCard}
                >
                  <PlacePhoto
                    uri={p.image}
                    query={p.image ? null : `${p.name}, ${p.country ?? ''}`}
                    width={500}
                    style={StyleSheet.absoluteFill}
                  />
                  <LinearGradient colors={['rgba(8,16,28,0)', 'rgba(8,16,28,0.85)']} style={StyleSheet.absoluteFill} />
                  <PressableScale
                    haptic
                    onPress={() =>
                      saved
                        .toggle({ name: p.name, country: p.country, country_code: p.code, image_url: p.image })
                        .catch((err) => Alert.alert('Couldn’t update saved places', (err as Error).message))
                    }
                    style={styles.heart}
                    accessibilityLabel={isSaved ? `Remove ${p.name} from saved` : `Save ${p.name}`}
                  >
                    <Ionicons name={isSaved ? 'heart' : 'heart-outline'} size={17} color={isSaved ? Colors.danger : Colors.white} />
                  </PressableScale>
                  <View style={styles.destText}>
                    <Text variant="title" color={Colors.white} numberOfLines={1}>
                      {p.name}
                    </Text>
                    <Text variant="caption" color="rgba(255,255,255,0.8)" numberOfLines={1}>
                      {p.tag}
                    </Text>
                  </View>
                </PressableScale>
              );
            })}
            <PressableScale haptic onPress={() => router.push('/explore')} style={[styles.destCard, styles.destAdd]}>
              <Ionicons name="add-circle-outline" size={30} color={Colors.primary} />
              <Text variant="label" color={Colors.primary} center>
                Find more{'\n'}places
              </Text>
            </PressableScale>
          </ScrollView>
        </Animated.View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 20 },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  section: { paddingHorizontal: 20, marginTop: 18 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  statRow: { flexDirection: 'row', gap: 10 },
  stat: { gap: 2, padding: 14, borderRadius: Radius.lg, backgroundColor: Colors.surface, ...Shadow.card },
  statIcon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  draft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 14,
    borderRadius: Radius.lg,
    backgroundColor: Colors.accentSoft,
  },
  box: { alignItems: 'center', gap: 10, padding: 22, borderRadius: Radius.xl, backgroundColor: Colors.surface },
  hero: { height: 210, borderRadius: Radius.xxl, overflow: 'hidden', ...Shadow.raised },
  heroContent: { flex: 1, padding: 18, gap: 4 },
  heroTag: {
    alignSelf: 'flex-start',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: Radius.pill,
    backgroundColor: 'rgba(255,255,255,0.2)',
    marginBottom: 4,
  },
  heroBtn: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: Radius.md, backgroundColor: Colors.surface },
  heroWeather: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: Radius.md,
    backgroundColor: 'rgba(8,16,28,0.5)',
  },
  card: { gap: 12, padding: 16, borderRadius: Radius.xl, backgroundColor: Colors.surface, ...Shadow.card },
  timelineRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  dateCol: { width: 36, alignItems: 'center' },
  timelineDot: { width: 8, height: 8, borderRadius: 4, marginTop: 8 },
  timelineItem: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  statusChip: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: Radius.pill },
  confirmed: { backgroundColor: Colors.successSoft },
  planned: { backgroundColor: Colors.surfaceAlt },
  addActivity: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: 4 },
  upcomingRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  upcomingImg: { width: 52, height: 52, borderRadius: Radius.md },
  daysChip: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: Radius.pill, backgroundColor: Colors.surfaceAlt },
  destCard: { width: 140, height: 180, borderRadius: Radius.xl, overflow: 'hidden', backgroundColor: Colors.surfaceAlt },
  destAdd: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: Colors.primary,
    backgroundColor: Colors.primarySoft,
  },
  destText: { position: 'absolute', left: 12, right: 12, bottom: 12 },
  heart: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(8,16,28,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
