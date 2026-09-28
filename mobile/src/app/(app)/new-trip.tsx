import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Keyboard, Platform, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeInRight, FadeOut, FadeOutLeft, LinearTransition } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PlacePhoto } from '@/components/place-photo';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { PressableScale } from '@/components/ui/pressable-scale';
import { Text } from '@/components/ui/text';
import { Colors, Fonts, Radius, Shadow } from '@/constants/theme';
import { useAuth } from '@/context/auth-context';
import { api } from '@/lib/api';
import { homeCity } from '@/lib/profile';
import { addDaysLocal, daysBetweenInclusive, flagEmoji, formatDate, toIsoDate } from '@/lib/format';
import type { Destination, PlaceSearchResult } from '@/lib/types';

const MAX_DAYS = 30;

const POPULAR = ['Goa', 'Kyoto', 'Bali', 'Paris', 'Manali', 'Singapore', 'Dubai', 'Kerala', 'Bangkok', 'London'];

const ORIGIN_KEY = 'journi:origin-city';
const ORIGIN_CITIES = ['Hyderabad', 'Bengaluru', 'Delhi', 'Mumbai', 'Chennai', 'Kolkata', 'Pune', 'Ahmedabad', 'Kochi'];

const DURATION_CHIPS = [
  { label: 'Weekend', days: 3 },
  { label: '5 days', days: 5 },
  { label: '1 week', days: 7 },
  { label: '10 days', days: 10 },
];

function typeIcon(type?: string | null): keyof typeof Ionicons.glyphMap {
  if (!type) return 'location-outline';
  if (/country/.test(type)) return 'flag-outline';
  if (/city|town|village|locality|municipality/.test(type)) return 'business-outline';
  if (/state|province|region|county|administrative/.test(type)) return 'map-outline';
  if (/island|beach|natural|park|peak|mountain/.test(type)) return 'leaf-outline';
  return 'location-outline';
}

type Step = 'destination' | 'dates';

export default function NewTripScreen() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ q?: string; destination?: string }>();
  const { user } = useAuth();
  // Opened from Explore with a place already chosen → go straight to dates.
  const [initialDestination] = useState<Destination | null>(() => {
    try {
      return params.destination ? (JSON.parse(params.destination) as Destination) : null;
    } catch {
      return null;
    }
  });
  const [step, setStep] = useState<Step>(initialDestination ? 'dates' : 'destination');
  const [query, setQuery] = useState(params.q ?? '');
  // Results are tagged with the query they belong to, so "searching" can be
  // derived instead of toggled inside the effect.
  const [search, setSearch] = useState<{ q: string; results: PlaceSearchResult[]; error: string | null }>({
    q: '',
    results: [],
    error: null,
  });
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);
  const [destination, setDestination] = useState<Destination | null>(initialDestination);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [startDate, setStartDate] = useState<Date>(addDaysLocal(today, 14));
  const [endDate, setEndDate] = useState<Date>(addDaysLocal(today, 18));
  const [iosPicker, setIosPicker] = useState<'start' | 'end' | null>(null);
  const [origin, setOrigin] = useState('');

  // Remember where the traveller usually flies from.
  useEffect(() => {
    AsyncStorage.getItem(ORIGIN_KEY)
      .then((saved) => {
        setOrigin((current) => current || saved || homeCity(user));
      })
      .catch(() => {});
  }, [user]);
  const inputRef = useRef<TextInput>(null);

  const trimmed = query.trim();
  const searching = trimmed.length >= 2 && search.q !== trimmed;
  const results = search.results;
  const searchError = resolveError ?? (search.q === trimmed ? search.error : null);

  // Debounced worldwide search.
  useEffect(() => {
    if (trimmed.length < 2) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const r = await api.searchPlaces(trimmed, controller.signal);
        setSearch({ q: trimmed, results: r, error: null });
      } catch (err) {
        if ((err as Error).name !== 'AbortError') setSearch({ q: trimmed, results: [], error: (err as Error).message });
      }
    }, 450);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed]);

  const selectPlace = async (place: PlaceSearchResult) => {
    Keyboard.dismiss();
    setResolveError(null);
    try {
      setResolving(place.place_id);
      const resolved: Destination =
        place.latitude != null && place.longitude != null && place.country_code
          ? (place as Destination)
          : await api.placeDetails(place.place_id);
      setDestination(resolved);
      setStep('dates');
    } catch (err) {
      setResolveError((err as Error).message);
    } finally {
      setResolving(null);
    }
  };

  const numDays = daysBetweenInclusive(toIsoDate(startDate), toIsoDate(endDate));
  const dateError =
    endDate <= startDate
      ? 'End date must be after the start date'
      : numDays > MAX_DAYS
        ? `Trips can be up to ${MAX_DAYS} days`
        : null;

  const applyStart = (date: Date) => {
    setStartDate(date);
    // Keep the same trip length when the start moves.
    const length = Math.max(numDays, 2);
    if (endDate <= date || numDays > MAX_DAYS) setEndDate(addDaysLocal(date, length - 1));
  };

  const openPicker = (which: 'start' | 'end') => {
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        value: which === 'start' ? startDate : endDate,
        mode: 'date',
        minimumDate: which === 'start' ? today : addDaysLocal(startDate, 1),
        maximumDate: which === 'end' ? addDaysLocal(startDate, MAX_DAYS - 1) : undefined,
        // Only fires when the user confirms a date (dismissing the dialog does nothing).
        onValueChange: (_event, date) => {
          if (which === 'start') applyStart(date);
          else setEndDate(date);
        },
      });
    } else {
      setIosPicker((cur) => (cur === which ? null : which));
    }
  };

  const originCity = origin.trim();
  const hasOrigin = originCity.length >= 2;

  const plan = () => {
    if (!destination || dateError) return;
    if (hasOrigin) AsyncStorage.setItem(ORIGIN_KEY, originCity).catch(() => {});
    router.replace({
      pathname: '/planning',
      params: {
        destination: JSON.stringify(destination),
        origin: hasOrigin ? originCity : '',
        start: toIsoDate(startDate),
        end: toIsoDate(endDate),
      },
    });
  };

  return (
    <View style={{ flex: 1, backgroundColor: Colors.bg }}>
      <StatusBar style={step === 'dates' ? 'light' : 'dark'} />

      {step === 'destination' ? (
        <Animated.View key="dest" entering={FadeIn.duration(250)} exiting={FadeOutLeft.duration(200)} style={{ flex: 1, paddingTop: insets.top + 8 }}>
          <View style={styles.topBar}>
            <IconButton icon="close" onPress={() => router.back()} accessibilityLabel="Close" />
            <Text variant="overline" color={Colors.muted}>
              Step 1 of 2
            </Text>
            <View style={{ width: 42 }} />
          </View>

          <View style={{ paddingHorizontal: 20, marginTop: 12 }}>
            <Text variant="h1">Where are you going?</Text>
            <Text variant="body" color={Colors.inkSoft} style={{ marginTop: 4 }}>
              Search any city, region, country or landmark worldwide.
            </Text>
            <View style={styles.searchBox}>
              <Ionicons name="search" size={20} color={Colors.primary} />
              <TextInput
                ref={inputRef}
                autoFocus={!params.q}
                value={query}
                onChangeText={(t) => {
                  setQuery(t);
                  setResolveError(null);
                }}
                placeholder="e.g. Kyoto, Swiss Alps, Goa…"
                placeholderTextColor={Colors.muted}
                style={styles.searchInput}
                returnKeyType="search"
                autoCorrect={false}
              />
              {searching ? (
                <ActivityIndicator color={Colors.primary} />
              ) : query.length > 0 ? (
                <PressableScale onPress={() => setQuery('')} hitSlop={10} accessibilityLabel="Clear search">
                  <Ionicons name="close-circle" size={20} color={Colors.muted} />
                </PressableScale>
              ) : null}
            </View>
          </View>

          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 40, gap: 8 }}>
            {query.trim().length < 2 ? (
              <Animated.View entering={FadeInDown.duration(400)}>
                <Text variant="overline" color={Colors.muted} style={{ marginBottom: 12 }}>
                  Popular with Journi travellers
                </Text>
                <View style={styles.chips}>
                  {POPULAR.map((p) => (
                    <PressableScale key={p} haptic onPress={() => setQuery(p)} style={styles.chip}>
                      <Ionicons name="trending-up" size={14} color={Colors.primary} />
                      <Text variant="label">{p}</Text>
                    </PressableScale>
                  ))}
                </View>
              </Animated.View>
            ) : searchError ? (
              <View style={styles.notice}>
                <Ionicons name="cloud-offline-outline" size={20} color={Colors.muted} />
                <Text variant="caption" color={Colors.inkSoft} style={{ flex: 1 }}>
                  {searchError}
                </Text>
              </View>
            ) : !searching && results.length === 0 ? (
              <View style={styles.notice}>
                <Ionicons name="compass-outline" size={20} color={Colors.muted} />
                <Text variant="caption" color={Colors.inkSoft} style={{ flex: 1 }}>
                  No places found for “{query.trim()}”. Try a different spelling or a nearby city.
                </Text>
              </View>
            ) : (
              results.map((r, i) => (
                <Animated.View key={r.place_id} entering={FadeInDown.delay(i * 40).duration(300)} layout={LinearTransition}>
                  <PressableScale haptic onPress={() => selectPlace(r)} disabled={!!resolving} style={styles.resultRow}>
                    <View style={styles.resultIcon}>
                      <Ionicons name={typeIcon(r.type)} size={20} color={Colors.primary} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text variant="title" numberOfLines={1}>
                        {r.name}
                      </Text>
                      <Text variant="caption" color={Colors.muted} numberOfLines={1}>
                        {r.subtitle}
                      </Text>
                    </View>
                    {resolving === r.place_id ? (
                      <ActivityIndicator color={Colors.primary} />
                    ) : (
                      <Text style={{ fontSize: 22 }}>{flagEmoji(r.country_code)}</Text>
                    )}
                  </PressableScale>
                </Animated.View>
              ))
            )}
          </ScrollView>
        </Animated.View>
      ) : (
        destination && (
          <Animated.View key="dates" entering={FadeInRight.duration(300)} exiting={FadeOut} style={{ flex: 1 }}>
            <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 120 }} bounces={false} keyboardShouldPersistTaps="handled">
              <PlacePhoto
                query={[destination.name, destination.country].filter(Boolean).join(', ')}
                width={1200}
                style={styles.destPhoto}
                fallbackIcon="airplane"
              >
                <LinearGradient colors={['rgba(8,16,28,0.45)', 'rgba(8,16,28,0)', 'rgba(8,16,28,0.85)']} locations={[0, 0.4, 1]} style={StyleSheet.absoluteFill} />
                <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
                  <IconButton icon="chevron-back" variant="glass" onPress={() => setStep('destination')} accessibilityLabel="Change destination" />
                  <Text variant="overline" color="rgba(255,255,255,0.85)">
                    Step 2 of 2
                  </Text>
                  <IconButton icon="close" variant="glass" onPress={() => router.back()} accessibilityLabel="Close" />
                </View>
                <Animated.View entering={FadeInDown.delay(150).duration(500)} style={styles.destText}>
                  <Text variant="caption" color="rgba(255,255,255,0.85)">
                    {flagEmoji(destination.country_code)}  {destination.country}
                  </Text>
                  <Text variant="display" color={Colors.white} numberOfLines={2}>
                    {destination.name}
                  </Text>
                </Animated.View>
              </PlacePhoto>

              <Animated.View entering={FadeInDown.delay(200).duration(500)} style={styles.datesCard}>
                <Text variant="h3">When are you travelling?</Text>

                <View style={styles.dateRow}>
                  <DateBox label="Start date" date={startDate} active={iosPicker === 'start'} onPress={() => openPicker('start')} />
                  <View style={styles.dateArrow}>
                    <Ionicons name="arrow-forward" size={16} color={Colors.muted} />
                  </View>
                  <DateBox label="End date" date={endDate} active={iosPicker === 'end'} onPress={() => openPicker('end')} />
                </View>

                {Platform.OS === 'ios' && iosPicker && (
                  <Animated.View entering={FadeInDown.duration(250)} exiting={FadeOut.duration(150)} layout={LinearTransition}>
                    <DateTimePicker
                      value={iosPicker === 'start' ? startDate : endDate}
                      mode="date"
                      display="inline"
                      accentColor={Colors.primary}
                      minimumDate={iosPicker === 'start' ? today : addDaysLocal(startDate, 1)}
                      maximumDate={iosPicker === 'end' ? addDaysLocal(startDate, MAX_DAYS - 1) : undefined}
                      onValueChange={(_e, date) => {
                        if (iosPicker === 'start') applyStart(date);
                        else setEndDate(date);
                      }}
                    />
                  </Animated.View>
                )}

                <View style={styles.chips}>
                  {DURATION_CHIPS.map((c) => {
                    const active = numDays === c.days;
                    return (
                      <PressableScale
                        key={c.label}
                        haptic
                        onPress={() => setEndDate(addDaysLocal(startDate, c.days - 1))}
                        style={[styles.chip, active && styles.chipActive]}
                      >
                        <Text variant="label" color={active ? Colors.white : Colors.ink}>
                          {c.label}
                        </Text>
                      </PressableScale>
                    );
                  })}
                </View>

                <Animated.View layout={LinearTransition} style={[styles.summary, dateError && { backgroundColor: Colors.dangerSoft }]}>
                  <Ionicons name={dateError ? 'alert-circle' : 'sunny-outline'} size={20} color={dateError ? Colors.danger : Colors.primary} />
                  <Text variant="bodyStrong" color={dateError ? Colors.danger : Colors.primaryDark} style={{ flex: 1 }}>
                    {dateError ?? `${numDays} days · ${numDays - 1} night${numDays - 1 === 1 ? '' : 's'} in ${destination.name}`}
                  </Text>
                </Animated.View>
              </Animated.View>

              <Animated.View entering={FadeInDown.delay(260).duration(500)} style={[styles.datesCard, { marginTop: 16 }]}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                  <View style={styles.planeIcon}>
                    <Ionicons name="airplane" size={18} color={Colors.white} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text variant="h3">
                      Flying from{' '}
                      <Text variant="caption" color={Colors.muted}>
                        (optional)
                      </Text>
                    </Text>
                    <Text variant="caption" color={Colors.muted}>
                      Add your city for a flight estimate — or skip and add the cost later in Budget
                    </Text>
                  </View>
                </View>
                <View style={styles.originInput}>
                  <Ionicons name="location-outline" size={18} color={Colors.primary} />
                  <TextInput
                    value={origin}
                    onChangeText={setOrigin}
                    placeholder="Your city, e.g. Hyderabad"
                    placeholderTextColor={Colors.muted}
                    style={styles.originText}
                    autoCapitalize="words"
                    returnKeyType="done"
                    maxLength={80}
                  />
                  {origin.length > 0 && (
                    <PressableScale onPress={() => setOrigin('')} hitSlop={10} accessibilityLabel="Clear departure city">
                      <Ionicons name="close-circle" size={18} color={Colors.muted} />
                    </PressableScale>
                  )}
                </View>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 8 }}>
                  {ORIGIN_CITIES.map((city) => {
                    const active = originCity.toLowerCase() === city.toLowerCase();
                    return (
                      <PressableScale
                        key={city}
                        haptic
                        onPress={() => {
                          setOrigin(city);
                          Keyboard.dismiss();
                        }}
                        style={[styles.chip, active && styles.chipActive]}
                      >
                        <Text variant="label" color={active ? Colors.white : Colors.ink}>
                          {city}
                        </Text>
                      </PressableScale>
                    );
                  })}
                </ScrollView>
                {hasOrigin && (
                  <Animated.View entering={FadeIn} style={styles.summary}>
                    <Ionicons name="swap-horizontal" size={18} color={Colors.primary} />
                    <Text variant="bodyStrong" color={Colors.primaryDark} style={{ flex: 1 }} numberOfLines={1}>
                      {originCity} ⇄ {destination.name}
                    </Text>
                  </Animated.View>
                )}
              </Animated.View>

              <Animated.View entering={FadeInDown.delay(300).duration(500)} style={styles.included}>
                {[
                  { icon: 'calendar-outline', text: 'Day-by-day itinerary with food picks' },
                  { icon: 'rainy-outline', text: 'Live forecast & bad-weather warnings' },
                  { icon: 'airplane-outline', text: hasOrigin ? 'Return flight estimate included in your total' : 'Flights optional — add your own cost anytime' },
                  { icon: 'wallet-outline', text: `Budget in ₹${destination.currency_code && destination.currency_code !== 'INR' ? ` and ${destination.currency_code}` : ''}` },
                  { icon: 'chatbubbles-outline', text: 'Refine it by chatting — as often as you like' },
                ].map((item) => (
                  <View key={item.text} style={styles.includedRow}>
                    <Ionicons name={item.icon as keyof typeof Ionicons.glyphMap} size={18} color={Colors.primary} />
                    <Text variant="caption" color={Colors.inkSoft}>
                      {item.text}
                    </Text>
                  </View>
                ))}
              </Animated.View>
            </ScrollView>

            <View style={[styles.bottomBar, { paddingBottom: insets.bottom + 12 }]}>
              <Button title="Plan my trip" icon="sparkles" size="lg" onPress={plan} disabled={!!dateError} fullWidth />
            </View>
          </Animated.View>
        )
      )}
    </View>
  );
}

function DateBox({ label, date, active, onPress }: { label: string; date: Date; active: boolean; onPress: () => void }) {
  const iso = toIsoDate(date);
  return (
    <PressableScale haptic onPress={onPress} style={[styles.dateBox, active && { borderColor: Colors.primary }]}>
      <Text variant="overline" color={Colors.muted}>
        {label}
      </Text>
      <Text variant="h3" style={{ fontFamily: Fonts.extrabold }}>
        {formatDate(iso, { day: 'numeric', month: 'short' })}
      </Text>
      <Text variant="caption" color={Colors.inkSoft}>
        {formatDate(iso, { weekday: 'long' })}, {date.getFullYear()}
      </Text>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16 },
  searchBox: {
    marginTop: 18,
    height: 58,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1.5,
    borderColor: Colors.primary,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    gap: 10,
    ...Shadow.card,
  },
  searchInput: { flex: 1, fontFamily: Fonts.semibold, fontSize: 17, color: Colors.ink, height: '100%' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: Radius.pill,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  notice: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 16, borderRadius: Radius.lg, backgroundColor: Colors.surface },
  resultRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
  },
  resultIcon: { width: 44, height: 44, borderRadius: 14, backgroundColor: Colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  destPhoto: { height: 340 },
  destText: { position: 'absolute', left: 20, right: 20, bottom: 44 },
  datesCard: {
    marginTop: -28,
    marginHorizontal: 16,
    padding: 18,
    gap: 16,
    borderRadius: Radius.xxl,
    backgroundColor: Colors.surface,
    ...Shadow.raised,
  },
  dateRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dateArrow: { width: 24, alignItems: 'center' },
  dateBox: {
    flex: 1,
    padding: 14,
    gap: 2,
    borderRadius: Radius.lg,
    borderWidth: 1.5,
    borderColor: Colors.border,
    backgroundColor: Colors.bg,
  },
  summary: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, borderRadius: Radius.lg, backgroundColor: Colors.primarySoft },
  included: { marginHorizontal: 20, marginTop: 20, gap: 10 },
  planeIcon: { width: 38, height: 38, borderRadius: 12, backgroundColor: Colors.accent, alignItems: 'center', justifyContent: 'center' },
  originInput: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    height: 50,
    paddingHorizontal: 14,
    borderRadius: Radius.lg,
    borderWidth: 1.5,
    borderColor: Colors.border,
    backgroundColor: Colors.bg,
  },
  originText: { flex: 1, height: '100%', fontFamily: Fonts.semibold, fontSize: 16, color: Colors.ink },
  includedRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 20,
    paddingTop: 12,
    backgroundColor: Colors.bg,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
});
