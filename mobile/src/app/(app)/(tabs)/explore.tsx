import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useFocusEffect } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Keyboard, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import Animated, { FadeInDown, LinearTransition } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PlacePhoto } from '@/components/place-photo';
import { PressableScale } from '@/components/ui/pressable-scale';
import { Text } from '@/components/ui/text';
import { Colors, Fonts, Radius, Shadow } from '@/constants/theme';
import { useSavedPlaces } from '@/hooks/use-saved-places';
import { api } from '@/lib/api';
import { flagEmoji } from '@/lib/format';
import type { Destination, PlaceSearchResult, SavedPlace } from '@/lib/types';

const POPULAR = [
  { name: 'Bali', country: 'Indonesia', code: 'ID', tag: 'Beaches & temples' },
  { name: 'Kyoto', country: 'Japan', code: 'JP', tag: 'Temples & gardens' },
  { name: 'Paris', country: 'France', code: 'FR', tag: 'Art & cafés' },
  { name: 'Ladakh', country: 'India', code: 'IN', tag: 'High passes' },
  { name: 'Santorini', country: 'Greece', code: 'GR', tag: 'Sunsets & sea' },
  { name: 'Istanbul', country: 'Türkiye', code: 'TR', tag: 'Bazaars & history' },
  { name: 'Goa', country: 'India', code: 'IN', tag: 'Beaches & nightlife' },
  { name: 'Dubai', country: 'United Arab Emirates', code: 'AE', tag: 'Skylines & desert' },
];

/** Opens the new-trip flow straight at the dates step for this place. */
async function planTrip(place: { place_id?: string | null; name: string; latitude?: number | null; longitude?: number | null; country_code?: string | null }) {
  try {
    let dest: Destination | null = null;
    if (place.place_id && place.latitude != null && place.longitude != null && place.country_code) {
      dest = place as Destination;
    } else if (place.place_id) {
      dest = await api.placeDetails(place.place_id);
    }
    if (dest) router.push({ pathname: '/new-trip', params: { destination: JSON.stringify(dest) } });
    else router.push({ pathname: '/new-trip', params: { q: place.name } });
  } catch {
    router.push({ pathname: '/new-trip', params: { q: place.name } });
  }
}

export default function ExploreScreen() {
  const insets = useSafeAreaInsets();
  const saved = useSavedPlaces();
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState<{ q: string; results: PlaceSearchResult[]; error: string | null }>({ q: '', results: [], error: null });
  const trimmed = query.trim();
  const searching = trimmed.length >= 2 && search.q !== trimmed;

  useFocusEffect(
    useCallback(() => {
      saved.refresh();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []),
  );

  useEffect(() => {
    if (trimmed.length < 2) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const results = await api.searchPlaces(trimmed, controller.signal);
        setSearch({ q: trimmed, results, error: null });
      } catch (err) {
        if ((err as Error).name !== 'AbortError') setSearch({ q: trimmed, results: [], error: (err as Error).message });
      }
    }, 450);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed]);

  const toggleSave = (p: Partial<SavedPlace> & { name: string }) =>
    saved.toggle(p).catch((err) => Alert.alert('Couldn’t update saved places', (err as Error).message));

  return (
    <View style={{ flex: 1, backgroundColor: Colors.bg }}>
      <StatusBar style="dark" />
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + 12, paddingBottom: 32, gap: 22 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={{ paddingHorizontal: 20, gap: 12 }}>
          <View>
            <Text variant="h1">Explore</Text>
            <Text variant="caption" color={Colors.muted}>
              Find places, save them to your bucket list, and plan a trip in one tap.
            </Text>
          </View>
          <View style={styles.searchBox}>
            <Ionicons name="search" size={19} color={Colors.primary} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search any city, country or landmark"
              placeholderTextColor={Colors.muted}
              style={styles.searchInput}
              returnKeyType="search"
              onSubmitEditing={Keyboard.dismiss}
            />
            {searching ? (
              <ActivityIndicator color={Colors.primary} />
            ) : query.length > 0 ? (
              <PressableScale onPress={() => setQuery('')} hitSlop={10} accessibilityLabel="Clear search">
                <Ionicons name="close-circle" size={19} color={Colors.muted} />
              </PressableScale>
            ) : null}
          </View>
        </View>

        <View style={{ paddingHorizontal: 20 }}>
          <PressableScale haptic onPress={() => router.push('/price-check')} style={styles.priceCard}>
            <View style={styles.priceIcon}>
              <Ionicons name="pricetag" size={20} color={Colors.white} />
            </View>
            <View style={{ flex: 1 }}>
              <Text variant="label">Is this price fair?</Text>
              <Text variant="caption" color={Colors.muted}>
                Snap a menu, price tag or taxi quote — see it in ₹ with a verdict
              </Text>
            </View>
            <Ionicons name="camera-outline" size={20} color={Colors.primary} />
          </PressableScale>
        </View>

        {trimmed.length >= 2 && (
          <View style={{ paddingHorizontal: 20, gap: 8 }}>
            {search.q === trimmed && search.error ? (
              <Text variant="caption" color={Colors.inkSoft}>
                {search.error}
              </Text>
            ) : search.q === trimmed && search.results.length === 0 ? (
              <Text variant="caption" color={Colors.inkSoft}>
                No places found for “{trimmed}”.
              </Text>
            ) : (
              search.results.map((r, i) => {
                const isSaved = saved.isSaved(r);
                return (
                  <Animated.View key={r.place_id} entering={FadeInDown.delay(i * 40).duration(300)} layout={LinearTransition}>
                    <View style={styles.resultRow}>
                      <Text style={{ fontSize: 24 }}>{flagEmoji(r.country_code)}</Text>
                      <View style={{ flex: 1 }}>
                        <Text variant="title" numberOfLines={1}>
                          {r.name}
                        </Text>
                        <Text variant="caption" color={Colors.muted} numberOfLines={1}>
                          {r.subtitle}
                        </Text>
                      </View>
                      <PressableScale
                        haptic
                        onPress={() => toggleSave({ ...r, latitude: r.latitude, longitude: r.longitude })}
                        style={[styles.roundBtn, isSaved && { backgroundColor: Colors.dangerSoft }]}
                        accessibilityLabel={isSaved ? 'Remove from saved' : 'Save place'}
                      >
                        <Ionicons name={isSaved ? 'heart' : 'heart-outline'} size={18} color={Colors.danger} />
                      </PressableScale>
                      <PressableScale haptic onPress={() => planTrip(r)} style={styles.planBtn}>
                        <Text variant="label" color={Colors.white} style={{ fontSize: 12 }}>
                          Plan
                        </Text>
                      </PressableScale>
                    </View>
                  </Animated.View>
                );
              })
            )}
          </View>
        )}

        {/* Saved places */}
        <View style={{ gap: 12 }}>
          <View style={styles.sectionHeader}>
            <Text variant="h3">Your saved places</Text>
            <Text variant="caption" color={Colors.muted}>
              {saved.places.length} saved
            </Text>
          </View>
          {saved.places.length === 0 ? (
            <View style={[styles.emptySaved, { marginHorizontal: 20 }]}>
              <Ionicons name="heart-outline" size={26} color={Colors.danger} />
              <Text variant="caption" color={Colors.inkSoft} center>
                Tap the ♥ on any place to add it to your bucket list.
              </Text>
            </View>
          ) : (
            <View style={styles.grid}>
              {saved.places.map((p, i) => (
                <Animated.View key={p.id} entering={FadeInDown.delay(i * 40).duration(350)} layout={LinearTransition} style={styles.gridItem}>
                  <PressableScale haptic onPress={() => planTrip(p)} style={styles.savedCard}>
                    <PlacePhoto uri={p.image_url} query={p.image_url ? null : `${p.name}, ${p.country ?? ''}`} width={500} style={StyleSheet.absoluteFill} />
                    <LinearGradient colors={['rgba(8,16,28,0)', 'rgba(8,16,28,0.85)']} style={StyleSheet.absoluteFill} />
                    <PressableScale haptic onPress={() => toggleSave(p)} style={styles.heart} accessibilityLabel={`Remove ${p.name}`}>
                      <Ionicons name="heart" size={17} color={Colors.danger} />
                    </PressableScale>
                    <View style={styles.cardText}>
                      <Text variant="title" color={Colors.white} numberOfLines={1}>
                        {p.name}
                      </Text>
                      <Text variant="caption" color="rgba(255,255,255,0.8)" numberOfLines={1}>
                        {flagEmoji(p.country_code)} {p.country ?? ''} · Tap to plan
                      </Text>
                    </View>
                  </PressableScale>
                </Animated.View>
              ))}
            </View>
          )}
        </View>

        {/* Popular */}
        <View style={{ gap: 12 }}>
          <View style={styles.sectionHeader}>
            <Text variant="h3">Popular destinations</Text>
          </View>
          <View style={styles.grid}>
            {POPULAR.map((p, i) => {
              const isSaved = saved.isSaved({ name: p.name, country_code: p.code });
              return (
                <Animated.View key={p.name} entering={FadeInDown.delay(i * 50).duration(350)} style={styles.gridItem}>
                  <PressableScale haptic onPress={() => planTrip({ name: p.name })} style={styles.savedCard}>
                    <PlacePhoto query={`${p.name}, ${p.country}`} width={500} style={StyleSheet.absoluteFill} />
                    <LinearGradient colors={['rgba(8,16,28,0)', 'rgba(8,16,28,0.85)']} style={StyleSheet.absoluteFill} />
                    <PressableScale
                      haptic
                      onPress={() => toggleSave({ name: p.name, country: p.country, country_code: p.code })}
                      style={styles.heart}
                      accessibilityLabel={isSaved ? `Remove ${p.name}` : `Save ${p.name}`}
                    >
                      <Ionicons name={isSaved ? 'heart' : 'heart-outline'} size={17} color={Colors.danger} />
                    </PressableScale>
                    <View style={styles.cardText}>
                      <Text variant="title" color={Colors.white}>
                        {p.name}
                      </Text>
                      <Text variant="caption" color="rgba(255,255,255,0.8)" numberOfLines={1}>
                        {p.tag}
                      </Text>
                    </View>
                  </PressableScale>
                </Animated.View>
              );
            })}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  searchBox: {
    height: 54,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1.5,
    borderColor: Colors.border,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    gap: 10,
    ...Shadow.card,
  },
  searchInput: { flex: 1, height: '100%', fontFamily: Fonts.semibold, fontSize: 16, color: Colors.ink },
  priceCard: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: Radius.lg, backgroundColor: Colors.surface, ...Shadow.card },
  priceIcon: { width: 40, height: 40, borderRadius: 12, backgroundColor: Colors.accent, alignItems: 'center', justifyContent: 'center' },
  resultRow: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: Radius.lg, backgroundColor: Colors.surface },
  roundBtn: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.surfaceAlt },
  planBtn: { height: 38, paddingHorizontal: 14, borderRadius: 19, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.primary },
  sectionHeader: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', paddingHorizontal: 20 },
  emptySaved: { alignItems: 'center', gap: 6, padding: 18, borderRadius: Radius.xl, backgroundColor: Colors.surface },
  grid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 14 },
  gridItem: { width: '50%', padding: 6 },
  savedCard: { height: 170, borderRadius: Radius.xl, overflow: 'hidden', backgroundColor: Colors.surfaceAlt },
  heart: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.9)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardText: { position: 'absolute', left: 12, right: 12, bottom: 12 },
});
