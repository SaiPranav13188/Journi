import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, BackHandler, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import Animated, {
  Extrapolation,
  FadeIn,
  FadeInDown,
  FadeInUp,
  FadeOut,
  FadeOutDown,
  interpolate,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BudgetLimitSheet } from '@/components/budget-limit-sheet';
import { BudgetSummary } from '@/components/budget-summary';
import { BudgetView } from '@/components/budget-view';
import { ReworkSheet } from '@/components/rework-sheet';
import { loadOfflinePack } from '@/lib/offline';
import { FlightCostSheet } from '@/components/flight-cost-sheet';
import { TripMap } from '@/components/trip-map';
import { ChatThread, Composer, DayFocusBar, SuggestionChips, type SuggestionActions } from '@/components/chat';
import { DayCard } from '@/components/day-card';
import { PlacePhoto } from '@/components/place-photo';
import { StatusPill } from '@/components/trip-card';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { PressableScale } from '@/components/ui/pressable-scale';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { weatherIcon } from '@/components/weather';
import { Colors, Radius, Shadow } from '@/constants/theme';
import { useAuth } from '@/context/auth-context';
import { useTripEditor, type BudgetChange } from '@/hooks/use-trip-editor';
import { api } from '@/lib/api';
import { clearDraft } from '@/lib/draft';
import { flagEmoji, formatDate, formatDateRange, formatMoney } from '@/lib/format';
import { agenticAiEnabled } from '@/lib/profile';
import type { Booking, ChatMessage, PlaceSuggestion, ReworkPreview, ReworkTarget, TimeOfDay } from '@/lib/types';

type Tab = 'itinerary' | 'map' | 'chat' | 'budget';
const HERO_HEIGHT = 330;

export default function TripScreen() {
  // tab / day let other screens deep-link, e.g. /trip/123?tab=map or ?tab=chat&day=1
  const {
    id,
    tab: initialTab,
    day: initialDay,
    arrival,
    rework: reworkAlertId,
  } = useLocalSearchParams<{ id: string; tab?: Tab; day?: string; arrival?: string; rework?: string }>();
  const insets = useSafeAreaInsets();
  const editor = useTripEditor(id);
  const { plan, sending, saving, isSaved, isFinalized } = editor;

  const [tab, setTab] = useState<Tab>(
    initialTab && ['itinerary', 'map', 'chat', 'budget'].includes(initialTab) ? initialTab : 'itinerary',
  );
  const [limitOpen, setLimitOpen] = useState(false);
  const [flightOpen, setFlightOpen] = useState(false);
  // Rain swap / flight-aware day preview.
  const [rework, setRework] = useState<{
    title: string;
    icon: keyof typeof Ionicons.glyphMap;
    preview: ReworkPreview | null;
    error: string | null;
  } | null>(null);
  const [applyingRework, setApplyingRework] = useState(false);
  const [hasOffline, setHasOffline] = useState(false);
  const [bookedTotal, setBookedTotal] = useState(0);
  const [expanded, setExpanded] = useState<Set<number>>(new Set([1]));
  const [draftText, setDraftText] = useState('');
  // Agentic chat can take a photo (menu, price tag…) for the Price-Check agent.
  const { user } = useAuth();
  const agentsOn = agenticAiEnabled(user);
  const [chatPhoto, setChatPhoto] = useState<{ uri: string; base64: string; mimeType: string } | null>(null);
  const [toast, setToast] = useState<{ text: string; kind: 'reply' | 'info' } | null>(null);
  // Day the user is adding places to (after tapping "Add places to Day N").
  const [focusDay, setFocusDay] = useState<number | null>(null);
  const composerRef = useRef<TextInput>(null);
  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const scrollY = useSharedValue(0);
  const tabRef = useRef<Tab>(tab);
  const locateTried = useRef<Set<string>>(new Set());

  /** "Budget +₹800 → ₹23,350" — or null when the total didn't move. */
  const budgetLine = (change?: BudgetChange | null) => {
    if (!change) return null;
    const diff = Math.round(change.after - change.before);
    if (!diff) return null;
    return `Budget ${diff > 0 ? '+' : '−'}${formatMoney(Math.abs(diff), 'INR')} → ${formatMoney(change.after, 'INR')}`;
  };
  useEffect(() => {
    tabRef.current = tab;
  }, [tab]);

  // Back from Chat/Budget returns to the Itinerary tab before leaving the trip.
  const goBack = () => {
    if (tabRef.current !== 'itinerary') {
      setTab('itinerary');
      setFocusDay(null);
      scrollRef.current?.scrollTo({ y: 0, animated: true });
    } else {
      router.back();
    }
  };
  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        if (tabRef.current === 'itinerary') return false;
        setTab('itinerary');
        setFocusDay(null);
        return true;
      });
      return () => sub.remove();
    }, []),
  );

  // Deep link ?tab=chat&day=N → open "add places" for that day once the plan loads.
  const [appliedDay, setAppliedDay] = useState(false);
  if (!appliedDay && initialDay && plan) {
    setAppliedDay(true);
    const n = Number(initialDay);
    if (plan.days.some((x) => x.day_number === n) && plan.trip.status !== 'finalized') setFocusDay(n);
  }

  // Map tab: fetch coordinates for places that don't have them yet.
  const planLoaded = Boolean(plan);
  useEffect(() => {
    if (tab !== 'map' || !planLoaded || editor.locating) return;
    const needs = editor.plan?.days.some((x) => x.activities.some((a) => !a.placeholder && a.lat == null && !locateTried.current.has(a.id)));
    if (!needs) return;
    editor.plan?.days.forEach((x) => x.activities.forEach((a) => locateTried.current.add(a.id)));
    editor.locatePlaces().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, planLoaded, plan?.days]);

  // Budget tab: how much is already booked for this trip.
  const startRework = async (targets: ReworkTarget[], title: string, icon: keyof typeof Ionicons.glyphMap) => {
    setRework({ title, icon, preview: null, error: null });
    try {
      const preview = await editor.previewRework(targets);
      setRework((cur) => (cur ? { ...cur, preview } : cur));
    } catch (err) {
      setRework((cur) => (cur ? { ...cur, error: (err as Error).message } : cur));
    }
  };

  const rainSwap = (dayNumber: number, warning: string) =>
    startRework(
      [
        {
          day_number: dayNumber,
          instruction: `Bad weather is forecast (${warning.replace(/\n/g, ' ')}). Replace outdoor activities with indoor or sheltered alternatives in the same area.`,
        },
      ],
      `Indoor plan for Day ${dayNumber}`,
      'umbrella',
    );

  // Flight-aware days: after a flight booking is saved (?arrival=1), rebuild the
  // arrival day (and the departure day) around the flight times.
  const [arrivalDone, setArrivalDone] = useState(false);
  const arrivalTripId = arrival && plan?.trip.id ? plan.trip.id : null;
  useEffect(() => {
    if (!arrivalTripId || arrivalDone || !plan) return;
    setArrivalDone(true);
    api
      .bookings(arrivalTripId)
      .then((list) => {
        const targets = flightTargets(plan.trip.start_date, plan.days.length, list);
        if (targets.length) startRework(targets, 'Plan around your flights', 'airplane');
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrivalTripId, arrivalDone]);

  // From an alert (?rework=<alert id>): the Weather Watcher prepared a preview —
  // show it with Swap plan / Keep original. Nothing changes unless they swap.
  const [reworkAlertDone, setReworkAlertDone] = useState(false);
  const reworkTripId = reworkAlertId && plan?.trip.id ? plan.trip.id : null;
  useEffect(() => {
    if (!reworkTripId || reworkAlertDone) return;
    setReworkAlertDone(true);
    api
      .listAlerts()
      .then((list) => {
        const alert = list.find((a) => a.id === reworkAlertId && a.trip_id === reworkTripId);
        const preview = alert?.metadata?.preview;
        if (!preview?.days?.length) return;
        const day = preview.days[0].day_number;
        setRework({ title: `Weather-proof plan for Day ${day}`, icon: 'umbrella', preview, error: null });
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reworkTripId, reworkAlertDone]);

  const savedTripId = plan?.trip.id ?? null;
  useEffect(() => {
    if (!savedTripId) return;
    loadOfflinePack(savedTripId).then((p) => setHasOffline(!!p));
  }, [savedTripId, tab]);
  useEffect(() => {
    if (tab !== 'budget' || !savedTripId) return;
    api
      .bookings(savedTripId)
      .then((list) => setBookedTotal(list.filter((b) => b.status !== 'cancelled').reduce((s, b) => s + b.cost_inr, 0)))
      .catch(() => {});
  }, [tab, savedTripId]);

  const openAddPlaces = (dayNumber: number) => {
    setFocusDay(dayNumber);
    setTab('chat');
    setToast(null);
    setTimeout(() => composerRef.current?.focus(), 350);
  };

  const onScroll = useAnimatedScrollHandler((e) => {
    scrollY.value = e.contentOffset.y;
  });

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.kind === 'reply' ? 7000 : 3000);
    return () => clearTimeout(t);
  }, [toast]);

  // Keep the chat scrolled to the newest message.
  useEffect(() => {
    if (tab === 'chat') setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 150);
  }, [tab, plan?.messages.length, sending, scrollRef]);

  const heroImageStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: interpolate(scrollY.value, [-HERO_HEIGHT, 0, HERO_HEIGHT], [-HERO_HEIGHT / 2, 0, HERO_HEIGHT * 0.45]) },
      { scale: interpolate(scrollY.value, [-HERO_HEIGHT, 0], [2, 1], Extrapolation.CLAMP) },
    ],
  }));
  const topBarStyle = useAnimatedStyle(() => ({
    opacity: interpolate(scrollY.value, [HERO_HEIGHT - 160, HERO_HEIGHT - 90], [0, 1], Extrapolation.CLAMP),
  }));

  const pickChatPhoto = () => {
    const pick = async (source: 'camera' | 'library') => {
      if (source === 'camera') {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) {
          Alert.alert('Camera access needed', 'Allow camera access in Settings to photograph prices.');
          return;
        }
      }
      const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], quality: 0.7, base64: true };
      const res = source === 'camera' ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
      const a = res.canceled ? null : res.assets[0];
      if (a?.base64) setChatPhoto({ uri: a.uri, base64: a.base64, mimeType: a.mimeType ?? 'image/jpeg' });
    };
    Alert.alert('Attach a photo', 'A menu, price tag or quote — Journi will check if the price is fair.', [
      { text: 'Camera', onPress: () => pick('camera') },
      { text: 'Photo library', onPress: () => pick('library') },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const send = async (text: string, retryOf?: ChatMessage) => {
    setDraftText('');
    const photo = retryOf ? null : chatPhoto;
    try {
      const result = await editor.sendMessage(text, retryOf, focusDay, photo ? { base64: photo.base64, mimeType: photo.mimeType } : null);
      if (photo) setChatPhoto(null);
      if (!result) return;
      // Show the AI's reply as a toast when the user isn't looking at the chat,
      // and expand the days that changed so they can see what's new.
      const line = budgetLine(result.budget);
      if (tabRef.current !== 'chat') setToast({ text: line ? `${result.reply}\n💰 ${line}` : result.reply, kind: 'reply' });
      else if (line) setToast({ text: `💰 ${line}`, kind: 'info' });
      if (result.changedDays.size) setExpanded((prev) => new Set([...prev, ...result.changedDays]));
      // Budget agent guardrail: a >15% overrun is always shown, not just a quiet number change.
      if (result.concern) Alert.alert('Over your budget limit', result.concern.message);
    } catch (err) {
      if (!retryOf) setDraftText(text);
      Alert.alert('Couldn’t update your plan', (err as Error).message);
    }
  };

  const suggestionActions: SuggestionActions = {
    addingIds: editor.busyIds,
    canAdd: !isFinalized,
    addedSlot: (dayNumber: number, s: PlaceSuggestion) =>
      plan?.days
        .find((x) => x.day_number === dayNumber)
        ?.activities.find((a) => a.source_suggestion_id === s.id || a.title.toLowerCase() === s.name.toLowerCase())?.time_of_day ?? null,
    onAdd: async (dayNumber: number, s: PlaceSuggestion, timeOfDay: TimeOfDay) => {
      try {
        const change = await editor.addSuggestion(dayNumber, s, timeOfDay);
        setExpanded((prev) => new Set([...prev, dayNumber]));
        const line = budgetLine(change);
        setToast({ text: `${s.name} added to Day ${dayNumber} · ${timeOfDay} ✓${line ? `\n💰 ${line}` : ''}`, kind: 'info' });
      } catch (err) {
        Alert.alert('Couldn’t add place', (err as Error).message);
      }
    },
  };

  const onSave = async () => {
    try {
      const wasDraft = !isSaved;
      await editor.save();
      setToast({ text: wasDraft ? 'Trip saved to your trips ✓ Keep refining anytime.' : 'Changes saved ✓', kind: 'info' });
    } catch (err) {
      Alert.alert('Couldn’t save trip', (err as Error).message);
    }
  };

  const onFinalize = () => {
    Alert.alert('Finalize this plan?', 'We’ll mark it complete. You can still view it anytime — and reopen it if plans change.', [
      { text: 'Not yet', style: 'cancel' },
      {
        text: 'Finalize',
        onPress: async () => {
          try {
            await editor.finalize();
            setToast({ text: 'Plan finalized 🎉 Have an amazing trip!', kind: 'info' });
          } catch (err) {
            Alert.alert('Couldn’t finalize', (err as Error).message);
          }
        },
      },
    ]);
  };

  const onReopen = async () => {
    try {
      await editor.reopen();
      setToast({ text: 'Plan reopened — chat away to refine it.', kind: 'info' });
    } catch (err) {
      Alert.alert('Couldn’t reopen', (err as Error).message);
    }
  };

  const openMenu = () => {
    if (!plan) return;
    Alert.alert(plan.trip.destination.name, undefined, [
      isSaved
        ? {
            text: 'Delete trip',
            style: 'destructive',
            onPress: () =>
              Alert.alert('Delete this trip?', 'The itinerary, budget and conversation will be removed.', [
                { text: 'Cancel', style: 'cancel' },
                {
                  text: 'Delete',
                  style: 'destructive',
                  onPress: async () => {
                    try {
                      await api.deleteTrip(plan.trip.id!);
                      router.back();
                    } catch (err) {
                      Alert.alert('Couldn’t delete', (err as Error).message);
                    }
                  },
                },
              ]),
          }
        : {
            text: 'Discard plan',
            style: 'destructive',
            onPress: async () => {
              await clearDraft();
              router.back();
            },
          },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const toggleDay = (n: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });

  // ---------------------------------------------------------------- loading
  if (editor.loading || !plan) {
    return (
      <View style={{ flex: 1, backgroundColor: Colors.bg }}>
        <StatusBar style="light" />
        <Skeleton height={HERO_HEIGHT} radius={0} />
        {editor.error ? (
          <View style={styles.errorBox}>
            <Ionicons name="cloud-offline-outline" size={36} color={Colors.muted} />
            <Text variant="body" color={Colors.inkSoft} center>
              {editor.error}
            </Text>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Button title="Go back" variant="outline" size="sm" onPress={() => router.back()} />
              <Button title="Retry" variant="secondary" size="sm" onPress={editor.reload} />
            </View>
            {id !== 'draft' && <OfflineFallback tripId={id} />}
          </View>
        ) : (
          <View style={{ padding: 20, gap: 14 }}>
            <Skeleton height={44} radius={Radius.pill} />
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} height={88} radius={Radius.xl} />
            ))}
          </View>
        )}
        <View style={[styles.heroButtons, { top: insets.top + 8 }]}>
          <IconButton icon="chevron-back" variant="glass" onPress={() => router.back()} accessibilityLabel="Back" />
        </View>
      </View>
    );
  }

  const { trip, days, budget, messages } = plan;
  const d = trip.destination;
  const destinationLabel = [d.name, d.country].filter(Boolean).join(', ');
  const warningCount = days.filter((x) => x.weather_warning).length;

  return (
    <View style={{ flex: 1, backgroundColor: Colors.bg }}>
      <StatusBar style="light" />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
        <View style={{ flex: 1 }}>
        <Animated.ScrollView
          ref={scrollRef}
          onScroll={onScroll}
          scrollEventThrottle={16}
          stickyHeaderIndices={[1]}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: 28 }}
          showsVerticalScrollIndicator={false}
        >
          {/* [0] Hero */}
          <View style={{ height: HERO_HEIGHT, overflow: 'hidden' }}>
            <Animated.View style={[StyleSheet.absoluteFill, heroImageStyle]}>
              <PlacePhoto uri={d.image_url} query={d.image_url ? null : destinationLabel} width={1200} style={StyleSheet.absoluteFill} fallbackIcon="airplane" />
            </Animated.View>
            <LinearGradient colors={['rgba(8,16,28,0.5)', 'rgba(8,16,28,0)', 'rgba(8,16,28,0.9)']} locations={[0, 0.35, 1]} style={StyleSheet.absoluteFill} />
            <Animated.View entering={FadeInDown.duration(600)} style={styles.heroText}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <StatusPill status={trip.status} onDark />
                {!isSaved && (
                  <View style={styles.unsavedPill}>
                    <Text variant="overline" color={Colors.white} style={{ letterSpacing: 0.6 }}>
                      Not saved
                    </Text>
                  </View>
                )}
              </View>
              <Text variant="caption" color="rgba(255,255,255,0.85)" style={{ marginTop: 10 }}>
                {flagEmoji(d.country_code)}  {d.country}
              </Text>
              <Text variant="display" color={Colors.white} numberOfLines={2}>
                {d.name}
              </Text>
              <View style={styles.heroStats}>
                <HeroStat icon="calendar-outline" text={`${formatDateRange(trip.start_date, trip.end_date)} · ${trip.num_days}d`} />
                {trip.origin_city && <HeroStat icon="airplane-outline" text={`from ${trip.origin_city}`} />}
                {budget && <HeroStat icon="wallet-outline" text={formatMoney(budget.total_inr, 'INR', { compact: true })} />}
                {warningCount > 0 && <HeroStat icon="warning-outline" text={`${warningCount} alert${warningCount > 1 ? 's' : ''}`} warn />}
              </View>
            </Animated.View>
          </View>

          {/* [1] Sticky tabs */}
          <View style={[styles.tabsWrap, { paddingTop: 10 }]}>
            <View style={styles.tabs}>
              {(
                [
                  { key: 'itinerary', label: 'Plan', icon: 'list-outline' },
                  { key: 'map', label: 'Map', icon: 'map-outline' },
                  { key: 'chat', label: 'Chat', icon: 'chatbubbles-outline' },
                  { key: 'budget', label: 'Budget', icon: 'wallet-outline' },
                ] as const
              ).map((t) => {
                const active = tab === t.key;
                return (
                  <PressableScale
                    key={t.key}
                    haptic
                    onPress={() => {
                      setTab(t.key);
                      if (t.key === 'chat') setToast(null);
                      else setFocusDay(null);
                    }}
                    style={[styles.tab, active && styles.tabActive]}
                  >
                    <Ionicons name={t.icon} size={16} color={active ? Colors.white : Colors.inkSoft} />
                    <Text variant="label" color={active ? Colors.white : Colors.inkSoft}>
                      {t.label}
                    </Text>
                    {t.key === 'chat' && messages.length > 0 && !active && (
                      <View style={styles.tabCount}>
                        <Text variant="overline" color={Colors.primary} style={{ fontSize: 10, letterSpacing: 0 }}>
                          {messages.length}
                        </Text>
                      </View>
                    )}
                  </PressableScale>
                );
              })}
            </View>
          </View>

          {/* [2] Tab content */}
          <View style={{ paddingHorizontal: 16, paddingTop: 16 }}>
            {tab === 'itinerary' && (
              <Animated.View key="itinerary" entering={FadeIn.duration(250)} style={{ gap: 14 }}>
                <StatusCard
                  isSaved={isSaved}
                  isFinalized={isFinalized}
                  saving={saving}
                  onSave={onSave}
                  onFinalize={onFinalize}
                  onReopen={onReopen}
                />

                {/* Travel tools */}
                <View style={styles.tools}>
                  {(
                    [
                      {
                        key: 'packing',
                        icon: 'bag-check-outline',
                        label: 'Packing list',
                        onPress: () => router.push({ pathname: '/packing/[id]', params: { id: trip.id ?? 'draft', name: d.name } }),
                      },
                      {
                        key: 'offline',
                        icon: hasOffline ? 'cloud-done-outline' : 'cloud-download-outline',
                        label: hasOffline ? 'Offline ✓' : 'Offline pack',
                        onPress: () =>
                          trip.id
                            ? router.push({ pathname: '/offline/[id]', params: { id: trip.id } })
                            : Alert.alert('Save your trip first', 'Save the trip to download it for offline use.'),
                      },
                      {
                        key: 'price',
                        icon: 'pricetag-outline',
                        label: 'Price check',
                        onPress: () =>
                          router.push({
                            pathname: '/price-check',
                            params: { place: [d.name, d.country].filter(Boolean).join(', '), countryCode: d.country_code ?? '' },
                          }),
                      },
                    ] as const
                  ).map((tool) => (
                    <PressableScale key={tool.key} haptic onPress={tool.onPress} style={styles.tool}>
                      <View style={styles.toolIcon}>
                        <Ionicons name={tool.icon} size={20} color={Colors.primary} />
                      </View>
                      <Text variant="caption" color={Colors.ink} style={{ fontSize: 12 }} numberOfLines={1}>
                        {tool.label}
                      </Text>
                    </PressableScale>
                  ))}
                </View>

                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
                  {days.map((day) => {
                    const icon = weatherIcon(day.weather_summary);
                    const available = day.weather_summary?.available;
                    return (
                      <View key={day.day_number} style={[styles.weatherDay, day.weather_warning && styles.weatherDayWarn]}>
                        <Text variant="overline" color={Colors.muted} style={{ fontSize: 10 }}>
                          {formatDate(day.date, { weekday: 'short' })}
                        </Text>
                        <Ionicons name={available ? icon.name : 'help-circle-outline'} size={22} color={available ? icon.color : Colors.muted} />
                        <Text variant="label" style={{ fontSize: 12 }}>
                          {available ? `${Math.round(day.weather_summary!.temp_max ?? 0)}°` : '—'}
                        </Text>
                        {day.weather_warning && <View style={styles.warnDot} />}
                      </View>
                    );
                  })}
                </ScrollView>

                {days.map((day, i) => (
                  <Animated.View key={`${day.day_number}-${day.date}`} entering={FadeInDown.delay(Math.min(i, 6) * 60).duration(400)}>
                    <DayCard
                      day={day}
                      destinationLabel={destinationLabel}
                      expanded={expanded.has(day.day_number)}
                      onToggle={() => toggleDay(day.day_number)}
                      updated={editor.updatedDays.has(day.day_number)}
                      editable={!isFinalized}
                      onAddPlaces={() => openAddPlaces(day.day_number)}
                      busyIds={editor.busyIds}
                      onRemoveActivity={(activity) =>
                        activity.placeholder
                          ? editor.removeActivity(day.day_number, activity.id).catch((err) => Alert.alert('Couldn’t remove', (err as Error).message))
                          : Alert.alert(`Remove ${activity.title}?`, `It will be taken off Day ${day.day_number}. You can add another place in its spot.`, [
                              { text: 'Cancel', style: 'cancel' },
                              {
                                text: 'Remove',
                                style: 'destructive',
                                onPress: () =>
                                  editor
                                    .removeActivity(day.day_number, activity.id)
                                    .then((change) => {
                                      const line = budgetLine(change);
                                      setToast({ text: `${activity.title} removed ✓${line ? `\n💰 ${line}` : ''}`, kind: 'info' });
                                    })
                                    .catch((err) => Alert.alert('Couldn’t remove', (err as Error).message)),
                              },
                            ])
                      }
                      onRainSwap={day.weather_warning ? () => rainSwap(day.day_number, day.weather_warning!) : undefined}
                      onToggleStatus={(activity) =>
                        editor
                          .setActivityStatus(day.day_number, activity.id, activity.status === 'confirmed' ? 'planned' : 'confirmed')
                          .catch((err) => Alert.alert('Couldn’t update', (err as Error).message))
                      }
                      onFillSlot={(activityId, query) =>
                        editor.fillSlot(day.day_number, activityId, query).then((change) => {
                          const line = budgetLine(change);
                          setToast({ text: `Place added to Day ${day.day_number} ✓${line ? `\n💰 ${line}` : ''}`, kind: 'info' });
                        })
                      }
                      onAccommodationChange={(note) =>
                        editor.updateAccommodation(day.day_number, note).catch((err) => Alert.alert('Couldn’t save note', (err as Error).message))
                      }
                    />
                  </Animated.View>
                ))}
              </Animated.View>
            )}

            {tab === 'chat' && (
              <Animated.View key="chat" entering={FadeIn.duration(250)}>
                <ChatThread messages={messages} typing={sending} onRetry={(m) => send(m.content, m)} actions={suggestionActions} />
              </Animated.View>
            )}

            {tab === 'map' && (
              <Animated.View key="map" entering={FadeIn.duration(250)}>
                <TripMap days={days} destination={d} locating={editor.locating} />
              </Animated.View>
            )}

            {tab === 'budget' && (
              <Animated.View key="budget" entering={FadeIn.duration(250)} style={{ gap: 16 }}>
                {budget && (
                  <>
                    {isSaved ? (
                      <BudgetSummary
                        title="Your budget"
                        budget={budget}
                        limit={trip.budget_limit_inr}
                        booked={bookedTotal}
                        onSetLimit={() => setLimitOpen(true)}
                      />
                    ) : (
                      <View style={styles.saveHint}>
                        <Ionicons name="flag-outline" size={16} color={Colors.primary} />
                        <Text variant="caption" color={Colors.inkSoft} style={{ flex: 1 }}>
                          Save your trip to set a budget limit and track bookings against it.
                        </Text>
                      </View>
                    )}
                    <BudgetLimitSheet
                      visible={limitOpen}
                      current={trip.budget_limit_inr}
                      estimate={budget.total_inr}
                      onClose={() => setLimitOpen(false)}
                      onSave={editor.setBudgetLimit}
                    />
                  </>
                )}
                {budget ? (
                  <>
                    <BudgetView
                      budget={budget}
                      days={days}
                      originCity={trip.origin_city}
                      destinationName={d.name}
                      onEditFlights={() => setFlightOpen(true)}
                    />
                    <FlightCostSheet
                      visible={flightOpen}
                      current={budget.flights_estimate}
                      onClose={() => setFlightOpen(false)}
                      onSave={async (amount) => {
                        const change = await editor.setFlightCost(amount);
                        const line = budgetLine(change);
                        if (line) setToast({ text: `Flight cost updated ✓\n💰 ${line}`, kind: 'info' });
                      }}
                    />
                  </>
                ) : (
                  <Text variant="body" color={Colors.muted} center>
                    No budget yet.
                  </Text>
                )}
              </Animated.View>
            )}
          </View>
        </Animated.ScrollView>

        {/* Compact top bar that appears once the hero scrolls away */}
        <Animated.View pointerEvents="none" style={[styles.topBar, { height: insets.top + 58 }, topBarStyle]}>
          <Text variant="title" numberOfLines={1} style={{ marginTop: insets.top + 18, marginHorizontal: 70 }} center>
            {d.name}
          </Text>
        </Animated.View>
        <View style={[styles.heroButtons, { top: insets.top + 8 }]} pointerEvents="box-none">
          <IconButton icon="chevron-back" variant="glass" onPress={goBack} accessibilityLabel="Back" />
          <IconButton icon="ellipsis-horizontal" variant="glass" onPress={openMenu} accessibilityLabel="More options" />
        </View>

        {/* Toasts */}
        {(toast || (sending && tab !== 'chat')) && (
          <Animated.View
            key={toast?.text ?? 'sending'}
            entering={FadeInUp.springify().damping(16)}
            exiting={FadeOutDown.duration(200)}
            style={styles.toastWrap}
          >
            <PressableScale
              onPress={() => {
                if (toast?.kind === 'reply' || sending) setTab('chat');
                setToast(null);
              }}
              style={styles.toast}
            >
              {sending && !toast ? (
                <>
                  <ActivityIndicator color={Colors.white} size="small" />
                  <Text variant="label" color={Colors.white} style={{ flex: 1 }}>
                    Journi is updating your plan…
                  </Text>
                </>
              ) : (
                <>
                  <Ionicons name={toast?.kind === 'reply' ? 'sparkles' : 'checkmark-circle'} size={18} color={Colors.gold} />
                  <Text variant="caption" color={Colors.white} style={{ flex: 1 }} numberOfLines={4}>
                    {toast?.text}
                  </Text>
                  {toast?.kind === 'reply' && <Ionicons name="chevron-forward" size={16} color="rgba(255,255,255,0.7)" />}
                </>
              )}
            </PressableScale>
          </Animated.View>
        )}

        </View>

        {/* Bottom dock: conversation composer (or finalized state) */}
        <View style={[styles.dock, { paddingBottom: insets.bottom + 10 }]}>
          {isFinalized ? (
            <Animated.View entering={FadeIn} exiting={FadeOut} style={styles.finalizedBar}>
              <Ionicons name="checkmark-done-circle" size={24} color={Colors.success} />
              <View style={{ flex: 1 }}>
                <Text variant="label">Plan finalized</Text>
                <Text variant="caption" color={Colors.muted}>
                  Reopen it to keep chatting and refining.
                </Text>
              </View>
              <Button title="Reopen" size="sm" variant="secondary" onPress={onReopen} loading={saving} />
            </Animated.View>
          ) : (
            <View style={{ gap: 10 }}>
              {tab === 'chat' && focusDay != null && days.some((x) => x.day_number === focusDay) ? (
                <DayFocusBar
                  dayNumber={focusDay}
                  theme={days.find((x) => x.day_number === focusDay)!.theme}
                  onPick={(m) => send(m)}
                  onClose={() => setFocusDay(null)}
                  disabled={sending}
                />
              ) : (
                tab === 'chat' && <SuggestionChips onPick={(s) => send(s)} disabled={sending} />
              )}
              <Composer
                ref={composerRef}
                placeholder={focusDay ? `What would you like to add to Day ${focusDay}?` : undefined}
                value={draftText}
                onChangeText={setDraftText}
                onSend={(t) => send(t)}
                sending={sending}
                onFocus={() => setTab('chat')}
                onAttach={agentsOn ? pickChatPhoto : undefined}
                attachment={chatPhoto}
                onClearAttachment={() => setChatPhoto(null)}
              />
            </View>
          )}
        </View>
      </KeyboardAvoidingView>

      <ReworkSheet
        visible={!!rework}
        title={rework?.title ?? ''}
        icon={rework?.icon ?? 'sparkles'}
        preview={rework?.preview ?? null}
        error={rework?.error ?? null}
        current={days}
        applying={applyingRework}
        onKeep={() => setRework(null)}
        onSwap={async () => {
          if (!rework?.preview) return;
          setApplyingRework(true);
          try {
            const change = await editor.applyDays(rework.preview.days);
            setExpanded((prev) => new Set([...prev, ...rework.preview!.days.map((x) => x.day_number)]));
            const line = budgetLine(change);
            setToast({ text: `Plan updated ✓${line ? `\n💰 ${line}` : ''}`, kind: 'info' });
            setRework(null);
          } catch (err) {
            setRework((cur) => (cur ? { ...cur, error: (err as Error).message } : cur));
          } finally {
            setApplyingRework(false);
          }
        }}
      />
    </View>
  );
}

/** Builds "plan around your flights" instructions from the trip's flight bookings. */
function flightTargets(startDate: string, numDays: number, bookings: Booking[]): ReworkTarget[] {
  const flights = bookings.filter((b) => b.type === 'flight' && b.status !== 'cancelled');
  const dayOf = (iso: string) => {
    const d = new Date(iso);
    const local = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const [y, m, dd] = startDate.split('-').map(Number);
    return Math.round((local.getTime() - new Date(y, m - 1, dd).getTime()) / 86_400_000) + 1;
  };
  const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const targets: ReworkTarget[] = [];

  // Arrival: the flight landing on/near day 1 (first two days of the trip).
  const arrivals = flights
    .filter((f) => f.end_at || f.start_at)
    .map((f) => ({ f, at: (f.end_at ?? f.start_at)! }))
    .filter(({ at }) => dayOf(at) >= 1 && dayOf(at) <= Math.min(2, numDays))
    .sort((a, b) => a.at.localeCompare(b.at));
  if (arrivals[0]) {
    const { f, at } = arrivals[0];
    targets.push({
      day_number: dayOf(at),
      instruction: `The traveller's flight ${f.title} lands at ${hhmm(at)} this day. Nothing may start before about 2 hours after landing (immigration and airport transfer). Include hotel check-in. If landing after 18:00, keep only a relaxed dinner near the hotel. If landing in the morning, keep the day light for jet lag.`,
    });
  }

  // Departure: the flight leaving on the last day.
  const departures = flights
    .filter((f) => f.start_at && dayOf(f.start_at) === numDays && numDays > 1)
    .sort((a, b) => b.start_at!.localeCompare(a.start_at!));
  if (departures[0] && !targets.some((t) => t.day_number === numDays)) {
    const f = departures[0];
    targets.push({
      day_number: numDays,
      instruction: `The traveller's flight ${f.title} departs at ${hhmm(f.start_at!)}${f.location ? ` from ${f.location}` : ''}. The day must end at least 3 hours before departure, with hotel check-out and nothing far from the airport near the end.`,
    });
  }
  return targets;
}

/** Shown when the trip can't load (e.g. no internet) but an offline copy exists. */
function OfflineFallback({ tripId }: { tripId: string }) {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    loadOfflinePack(tripId).then((p) => setAvailable(!!p));
  }, [tripId]);
  if (!available) return null;
  return (
    <Button
      title="Open offline copy"
      icon="cloud-done-outline"
      onPress={() => router.replace({ pathname: '/offline/[id]', params: { id: tripId } })}
      style={{ marginTop: 12 }}
    />
  );
}

function HeroStat({ icon, text, warn }: { icon: keyof typeof Ionicons.glyphMap; text: string; warn?: boolean }) {
  return (
    <View style={[styles.heroStat, warn && { backgroundColor: 'rgba(245,158,11,0.3)' }]}>
      <Ionicons name={icon} size={13} color={Colors.white} />
      <Text variant="caption" color={Colors.white} style={{ fontSize: 12 }}>
        {text}
      </Text>
    </View>
  );
}

function StatusCard({
  isSaved,
  isFinalized,
  saving,
  onSave,
  onFinalize,
  onReopen,
}: {
  isSaved: boolean;
  isFinalized: boolean;
  saving: boolean;
  onSave: () => void;
  onFinalize: () => void;
  onReopen: () => void;
}) {
  if (isFinalized) {
    return (
      <Animated.View entering={FadeInDown} style={[styles.statusCard, { backgroundColor: Colors.successSoft }]}>
        <Text style={{ fontSize: 26 }}>🎉</Text>
        <View style={{ flex: 1 }}>
          <Text variant="label" color={Colors.success}>
            Your plan is finalized
          </Text>
          <Text variant="caption" color={Colors.inkSoft}>
            Changed your mind? Reopen it and keep chatting.
          </Text>
        </View>
        <Button title="Reopen" size="sm" variant="outline" onPress={onReopen} loading={saving} />
      </Animated.View>
    );
  }
  return (
    <Animated.View entering={FadeInDown} style={styles.statusCard}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="label">{isSaved ? 'Saved · still editable' : 'Happy with it so far?'}</Text>
        <Text variant="caption" color={Colors.muted}>
          {isSaved ? 'Keep refining by chat. Finalize when you’re done.' : 'Save to keep it in your trips — you can still refine it later.'}
        </Text>
        <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
          <Button title={isSaved ? 'Save' : 'Save trip'} icon="bookmark-outline" size="sm" variant={isSaved ? 'secondary' : 'primary'} onPress={onSave} loading={saving} />
          <Button title="Finalize plan" icon="checkmark-done" size="sm" variant="outline" onPress={onFinalize} disabled={saving} />
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  heroText: { position: 'absolute', left: 20, right: 20, bottom: 22 },
  heroStats: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  heroStat: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: Radius.pill,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  unsavedPill: { paddingHorizontal: 9, paddingVertical: 5, borderRadius: Radius.pill, backgroundColor: 'rgba(255,107,74,0.85)' },
  heroButtons: { position: 'absolute', left: 16, right: 16, flexDirection: 'row', justifyContent: 'space-between' },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: Colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  tabsWrap: { backgroundColor: Colors.bg, paddingHorizontal: 16, paddingBottom: 6 },
  tabs: { flexDirection: 'row', gap: 6, padding: 5, borderRadius: Radius.pill, backgroundColor: Colors.surface, ...Shadow.card },
  tab: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, height: 40, borderRadius: Radius.pill },
  tools: { flexDirection: 'row', gap: 8 },
  tool: { flex: 1, alignItems: 'center', gap: 6, paddingVertical: 12, borderRadius: Radius.lg, backgroundColor: Colors.surface, ...Shadow.card },
  toolIcon: { width: 38, height: 38, borderRadius: 19, backgroundColor: Colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  saveHint: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, borderRadius: Radius.lg, backgroundColor: Colors.primarySoft },
  tabActive: { backgroundColor: Colors.primary },
  tabCount: { minWidth: 18, height: 18, borderRadius: 9, backgroundColor: Colors.primarySoft, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  statusCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: Radius.xl,
    backgroundColor: Colors.surface,
    ...Shadow.card,
  },
  weatherDay: {
    width: 56,
    alignItems: 'center',
    gap: 4,
    paddingVertical: 10,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  weatherDayWarn: { borderColor: Colors.warningBorder, backgroundColor: Colors.warningBg },
  warnDot: { position: 'absolute', top: 6, right: 6, width: 7, height: 7, borderRadius: 4, backgroundColor: Colors.warning },
  errorBox: { margin: 20, padding: 24, gap: 12, alignItems: 'center', borderRadius: Radius.xl, backgroundColor: Colors.surface },
  toastWrap: { position: 'absolute', left: 16, right: 16, bottom: 10 },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 14,
    borderRadius: Radius.lg,
    backgroundColor: Colors.ink,
    ...Shadow.raised,
  },
  dock: {
    paddingTop: 10,
    backgroundColor: 'rgba(246,244,239,0.97)',
    borderTopWidth: 1,
    borderTopColor: Colors.border,
  },
  finalizedBar: { flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: 16, padding: 12, borderRadius: Radius.lg, backgroundColor: Colors.surface },
});
