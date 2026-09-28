import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { router, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeInDown,
  FadeInUp,
  FadeOut,
  FadeOutUp,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PlacePhoto } from '@/components/place-photo';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { Colors, Radius } from '@/constants/theme';
import { api } from '@/lib/api';
import { saveDraft } from '@/lib/draft';
import { daysBetweenInclusive, flagEmoji, formatDateRange } from '@/lib/format';
import type { Destination } from '@/lib/types';

const COLD_START_HINT_MS = 9000;

function buildSteps(d: Destination, days: number, origin: string) {
  const currency = d.currency_code && d.currency_code !== 'INR' ? d.currency_code : null;
  return [
    { icon: 'partly-sunny-outline', text: `Checking the forecast in ${d.name}…` },
    ...(origin ? [{ icon: 'airplane-outline', text: `Estimating return flights from ${origin}…` } as const] : []),
    currency ? { icon: 'swap-horizontal-outline', text: `Getting today’s ₹ → ${currency} rate…` } : { icon: 'map-outline', text: 'Mapping the must-see spots…' },
    { icon: 'restaurant-outline', text: 'Finding local dishes worth the trip…' },
    { icon: 'calendar-outline', text: `Crafting ${days} days of adventures…` },
    { icon: 'wallet-outline', text: 'Estimating your budget…' },
    { icon: 'sparkles-outline', text: 'Adding the finishing touches…' },
  ] as const;
}

/** Plane gently bobbing along a dotted flight path. */
function FlyingPlane() {
  const x = useSharedValue(0);
  const bob = useSharedValue(0);
  useEffect(() => {
    x.set(withRepeat(withTiming(1, { duration: 2600, easing: Easing.inOut(Easing.sin) }), -1, true));
    bob.set(withRepeat(withSequence(withTiming(-6, { duration: 700 }), withTiming(6, { duration: 700 })), -1, true));
    return () => {
      cancelAnimation(x);
      cancelAnimation(bob);
    };
  }, [x, bob]);
  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: -70 + x.value * 140 }, { translateY: bob.value - Math.sin(x.value * Math.PI) * 18 }, { rotate: `${-10 + x.value * 20}deg` }],
  }));
  return (
    <View style={styles.planeArea}>
      <View style={styles.flightPath}>
        {Array.from({ length: 13 }).map((_, i) => (
          <View key={i} style={[styles.pathDot, { transform: [{ translateY: -Math.sin((i / 12) * Math.PI) * 18 }] }]} />
        ))}
      </View>
      <Animated.View style={[styles.plane, style]}>
        <Ionicons name="airplane" size={34} color={Colors.white} />
      </Animated.View>
    </View>
  );
}

export default function PlanningScreen() {
  const params = useLocalSearchParams<{ destination: string; origin: string; start: string; end: string }>();
  const destination: Destination = JSON.parse(params.destination);
  const numDays = daysBetweenInclusive(params.start, params.end);
  const steps = buildSteps(destination, numDays, params.origin?.trim() ?? '');

  const [stepIndex, setStepIndex] = useState(0);
  const [showColdStart, setShowColdStart] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shownError = error;
  const [attempt, setAttempt] = useState(0);
  const progress = useSharedValue(0);
  const cancelled = useRef(false);

  const run = useCallback(async () => {
    progress.set(0);
    // Ease towards 92% while waiting; jump to 100% when the plan arrives.
    progress.set(withTiming(0.92, { duration: 28_000, easing: Easing.out(Easing.cubic) }));

    try {
      const plan = await api.generateItinerary(destination, params.origin?.trim() || null, params.start, params.end);
      if (cancelled.current) return;
      progress.set(withTiming(1, { duration: 350 }));
      await saveDraft({ trip: plan.trip, days: plan.days, budget: plan.budget, messages: plan.messages });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      setTimeout(() => router.replace('/trip/draft'), 400);
    } catch (err) {
      if (cancelled.current) return;
      cancelAnimation(progress);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
      setError((err as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  useEffect(() => {
    cancelled.current = false;
    run();
    const stepTimer = setInterval(() => setStepIndex((i) => Math.min(i + 1, steps.length - 1)), 3800);
    const coldTimer = setTimeout(() => setShowColdStart(true), COLD_START_HINT_MS);
    return () => {
      cancelled.current = true;
      clearInterval(stepTimer);
      clearTimeout(coldTimer);
    };
  }, [run, steps.length]);

  const barStyle = useAnimatedStyle(() => ({ width: `${progress.value * 100}%` }));
  const step = steps[stepIndex];

  return (
    <View style={{ flex: 1, backgroundColor: Colors.ink }}>
      <StatusBar style="light" />
      <PlacePhoto uri={destination.image_url} query={`${destination.name}, ${destination.country ?? ''}`} width={1200} style={StyleSheet.absoluteFill} />
      <LinearGradient colors={['rgba(8,16,28,0.55)', 'rgba(8,16,28,0.8)', 'rgba(8,16,28,0.97)']} style={StyleSheet.absoluteFill} />

      <SafeAreaView style={styles.safe}>
        <Animated.View entering={FadeInDown.duration(600)} style={{ alignItems: 'center', gap: 6 }}>
          <Text variant="overline" color={Colors.gold}>
            {flagEmoji(destination.country_code)}  {destination.country ?? 'Your trip'}
          </Text>
          <Text variant="display" color={Colors.white} center numberOfLines={2}>
            {destination.name}
          </Text>
          <Text variant="body" color="rgba(255,255,255,0.75)">
            {formatDateRange(params.start, params.end)} · {numDays} days
          </Text>
        </Animated.View>

        {shownError ? (
          <Animated.View entering={FadeInUp.duration(400)} style={styles.errorCard}>
            <View style={styles.errorIcon}>
              <Ionicons name="cloud-offline-outline" size={28} color={Colors.accent} />
            </View>
            <Text variant="h3" color={Colors.white} center>
              We hit some turbulence
            </Text>
            <Text variant="body" color="rgba(255,255,255,0.75)" center>
              {shownError}
            </Text>
            <View style={{ gap: 10, alignSelf: 'stretch', marginTop: 8 }}>
              <Button title="Try again" icon="refresh" onPress={() => {
                  setError(null);
                  setStepIndex(0);
                  setShowColdStart(false);
                  setAttempt((a) => a + 1);
                }} fullWidth />
              <Button title="Change trip details" variant="onDark" onPress={() => router.replace('/new-trip')} />
            </View>
          </Animated.View>
        ) : (
          <View style={{ alignItems: 'center', alignSelf: 'stretch' }}>
            <FlyingPlane />
            <Text variant="h2" color={Colors.white} center>
              Planning your trip…
            </Text>
            <View style={styles.stepRow}>
              <Animated.View key={stepIndex} entering={FadeInDown.duration(350)} exiting={FadeOutUp.duration(250)} style={styles.stepInner}>
                <Ionicons name={step.icon as keyof typeof Ionicons.glyphMap} size={18} color={Colors.gold} />
                <Text variant="body" color="rgba(255,255,255,0.85)">
                  {step.text}
                </Text>
              </Animated.View>
            </View>
            <View style={styles.track}>
              <Animated.View style={[styles.bar, barStyle]}>
                <LinearGradient colors={['#FFB36B', '#FF6B4A']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={StyleSheet.absoluteFill} />
              </Animated.View>
            </View>
            {showColdStart && (
              <Animated.View entering={FadeIn.duration(500)} exiting={FadeOut} style={styles.coldStart}>
                <Ionicons name="cafe-outline" size={16} color="rgba(255,255,255,0.7)" />
                <Text variant="caption" color="rgba(255,255,255,0.7)" style={{ flex: 1 }}>
                  Waking up our servers after a quiet spell — the first plan can take up to a minute. Hang tight!
                </Text>
              </Animated.View>
            )}
          </View>
        )}

        {!error ? (
          <Button title="Cancel" variant="onDark" onPress={() => router.back()} style={{ alignSelf: 'center' }} size="sm" />
        ) : (
          <View />
        )}
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, justifyContent: 'space-between', paddingHorizontal: 24, paddingVertical: 24 },
  planeArea: { height: 120, width: 240, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  flightPath: { position: 'absolute', flexDirection: 'row', gap: 8, alignItems: 'center' },
  pathDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.35)' },
  plane: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(255,107,74,0.9)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepRow: { height: 32, marginTop: 10, justifyContent: 'center', alignSelf: 'stretch', alignItems: 'center', overflow: 'hidden' },
  stepInner: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  track: { marginTop: 22, height: 6, alignSelf: 'stretch', marginHorizontal: 20, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.15)', overflow: 'hidden' },
  bar: { height: '100%', borderRadius: 3, overflow: 'hidden' },
  coldStart: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 22,
    padding: 12,
    borderRadius: Radius.md,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  errorCard: { alignItems: 'center', gap: 10, padding: 22, borderRadius: Radius.xxl, backgroundColor: 'rgba(255,255,255,0.08)' },
  errorIcon: { width: 60, height: 60, borderRadius: 30, backgroundColor: 'rgba(255,107,74,0.15)', alignItems: 'center', justifyContent: 'center' },
});
