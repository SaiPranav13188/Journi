import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useState } from 'react';
import { Alert, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PlacePhoto } from '@/components/place-photo';
import { Button } from '@/components/ui/button';
import { PressableScale } from '@/components/ui/pressable-scale';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { TextField } from '@/components/ui/text-field';
import { Colors, Radius, Shadow } from '@/constants/theme';
import { useAuth } from '@/context/auth-context';
import { api } from '@/lib/api';
import { daysUntil, formatDateRange } from '@/lib/format';
import type { GroupListItem, TripListItem } from '@/lib/types';

const openGroup = (tripId: string) => router.push({ pathname: '/trip/[id]', params: { id: tripId, tab: 'group' } });

/** Group trips: plan together with friends. Always powered by Journi's agents. */
export default function GroupsScreen() {
  const insets = useSafeAreaInsets();
  const { user } = useAuth();
  const [groups, setGroups] = useState<GroupListItem[] | null>(null);
  const [myTrips, setMyTrips] = useState<TripListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [code, setCode] = useState('');
  const [joining, setJoining] = useState(false);
  const [picking, setPicking] = useState(false);
  const [creatingId, setCreatingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [g, trips] = await Promise.all([api.groups.list(), api.listTrips()]);
      setGroups(g);
      // Trips I own that aren't shared yet (and haven't ended).
      setMyTrips(trips.filter((t) => !t.is_group && t.owner_id === user?.id && daysUntil(t.end_date) >= 0));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [user?.id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const join = async () => {
    if (code.trim().length < 4) {
      Alert.alert('Enter a code', 'Ask the organiser for the trip’s join code, e.g. JRN-4K7Q.');
      return;
    }
    setJoining(true);
    try {
      const res = await api.groups.join(code);
      setCode('');
      if (!res.already_member) Alert.alert('You’re in! 🎉', `You joined the ${res.destination_name} trip. Add your preferences so Journi plans for you too.`);
      openGroup(res.trip_id);
    } catch (err) {
      Alert.alert('Couldn’t join', (err as Error).message);
    } finally {
      setJoining(false);
    }
  };

  const share = async (trip: TripListItem) => {
    setCreatingId(trip.id);
    try {
      await api.groups.create(trip.id);
      setPicking(false);
      openGroup(trip.id);
    } catch (err) {
      Alert.alert('Couldn’t create the group', (err as Error).message);
    } finally {
      setCreatingId(null);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: Colors.bg }}>
      <StatusBar style="dark" />
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + 12, paddingBottom: 32, paddingHorizontal: 20, gap: 16 }}
        keyboardShouldPersistTaps="handled"
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
        <View>
          <Text variant="h1">Group trips</Text>
          <Text variant="caption" color={Colors.muted}>
            Plan together — Journi balances everyone’s wishes, runs polls and splits costs.
          </Text>
        </View>

        {/* Join */}
        <Animated.View entering={FadeInDown.duration(350)} style={styles.card}>
          <Text variant="title">Join a friend’s trip</Text>
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'flex-end' }}>
            <View style={{ flex: 1 }}>
              <TextField icon="key-outline" value={code} onChangeText={(t) => setCode(t.toUpperCase())} placeholder="JRN-4K7Q" autoCapitalize="characters" autoCorrect={false} maxLength={12} onSubmitEditing={join} />
            </View>
            <Button title="Join" onPress={join} loading={joining} />
          </View>
        </Animated.View>

        {/* Create */}
        <Animated.View entering={FadeInDown.delay(60).duration(350)} style={styles.card}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text variant="title">Plan with friends</Text>
              <Text variant="caption" color={Colors.inkSoft}>
                Share one of your trips — everyone can chat with Journi and edit the plan.
              </Text>
            </View>
            {!picking && <Button title="Start" icon="people" size="sm" onPress={() => setPicking(true)} />}
          </View>
          {picking &&
            (myTrips.length === 0 ? (
              <View style={{ gap: 8 }}>
                <Text variant="caption" color={Colors.inkSoft}>
                  Save a trip first, then share it here.
                </Text>
                <Button title="Plan a new trip" icon="sparkles" variant="secondary" size="sm" onPress={() => router.push('/new-trip')} />
              </View>
            ) : (
              <View style={{ gap: 8 }}>
                {myTrips.map((t) => (
                  <PressableScale key={t.id} haptic disabled={creatingId != null} onPress={() => share(t)} style={styles.pickRow}>
                    <PlacePhoto uri={t.destination.image_url} query={t.destination.name} style={styles.pickPhoto} width={200} />
                    <View style={{ flex: 1 }}>
                      <Text variant="label">{t.destination.name}</Text>
                      <Text variant="caption" color={Colors.muted}>
                        {formatDateRange(t.start_date, t.end_date)}
                      </Text>
                    </View>
                    <Text variant="label" color={Colors.primary}>
                      {creatingId === t.id ? 'Sharing…' : 'Share'}
                    </Text>
                  </PressableScale>
                ))}
                <Button title="Cancel" variant="ghost" size="sm" onPress={() => setPicking(false)} />
              </View>
            ))}
        </Animated.View>

        {/* My groups */}
        <Text variant="h3">Your groups</Text>
        {error && !groups ? (
          <View style={styles.card}>
            <Text variant="body" color={Colors.inkSoft} center>
              {error}
            </Text>
            <Button title="Try again" variant="secondary" size="sm" onPress={load} />
          </View>
        ) : groups === null ? (
          [0, 1].map((i) => <Skeleton key={i} height={96} radius={Radius.xl} />)
        ) : groups.length === 0 ? (
          <View style={[styles.card, { alignItems: 'center' }]}>
            <Ionicons name="people-outline" size={34} color={Colors.muted} />
            <Text variant="body" color={Colors.inkSoft} center>
              No group trips yet. Start one above, or join with a code from a friend.
            </Text>
          </View>
        ) : (
          groups.map((g, i) => (
            <Animated.View key={g.id} entering={FadeInDown.delay(40 * i).duration(350)}>
              <PressableScale haptic onPress={() => openGroup(g.id)} style={styles.groupRow}>
                <PlacePhoto uri={g.destination.image_url} query={g.destination.name} style={styles.groupPhoto} width={300} />
                <View style={{ flex: 1, gap: 3 }}>
                  <Text variant="overline" color={g.is_owner ? Colors.accent : Colors.primary}>
                    {g.is_owner ? 'Organiser' : 'Member'} · {g.member_count} {g.member_count === 1 ? 'person' : 'people'}
                  </Text>
                  <Text variant="title" numberOfLines={1}>
                    {g.destination.name}
                  </Text>
                  <Text variant="caption" color={Colors.muted} numberOfLines={1}>
                    {formatDateRange(g.start_date, g.end_date)} · {g.member_names.join(', ')}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={Colors.muted} />
              </PressableScale>
            </Animated.View>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: 12, padding: 16, borderRadius: Radius.xl, backgroundColor: Colors.surface, ...Shadow.card },
  pickRow: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 8, borderRadius: Radius.lg, backgroundColor: Colors.bg },
  pickPhoto: { width: 48, height: 48, borderRadius: Radius.md },
  groupRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 10, borderRadius: Radius.xl, backgroundColor: Colors.surface, ...Shadow.card },
  groupPhoto: { width: 72, height: 72, borderRadius: Radius.lg },
});
