import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import * as Speech from 'expo-speech';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo } from 'react';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { Colors, Fonts } from '@/constants/theme';
import { Text } from './ui/text';

const DURATION = 4600; // ms on screen before fading into the app
const FADE_OUT = 450;

/** One cherry-blossom petal drifting down and sideways while it spins. */
function Petal({ delay, startX, drift, size, fall, height }: { delay: number; startX: number; drift: number; size: number; fall: number; height: number }) {
  const t = useSharedValue(0);
  useEffect(() => {
    t.set(withDelay(delay, withRepeat(withTiming(1, { duration: fall, easing: Easing.linear }), -1, false)));
  }, [t, delay, fall]);
  const style = useAnimatedStyle(() => ({
    opacity: t.value < 0.05 ? t.value * 20 : t.value > 0.9 ? (1 - t.value) * 10 : 0.95,
    transform: [
      { translateX: startX + Math.sin(t.value * Math.PI * 2) * 24 + drift * t.value },
      { translateY: -40 + t.value * (height + 80) },
      { rotate: `${t.value * 540}deg` },
      { scaleX: 0.6 + 0.4 * Math.abs(Math.cos(t.value * Math.PI * 3)) },
    ],
  }));
  return <Animated.View style={[styles.petal, { width: size, height: size * 0.72, borderRadius: size }, style]} />;
}

/**
 * Animated welcome shown each time the app opens: a slow walk down an old
 * Kyoto street (Ninenzaka) with falling cherry blossoms, the Journi logo and
 * a spoken "Welcome to Journi". Tap Skip to go straight in.
 */
export function IntroSplash({ onFinish }: { onFinish: () => void }) {
  const { width, height } = useWindowDimensions();
  const push = useSharedValue(1);
  const pan = useSharedValue(0);
  const logo = useSharedValue(0);
  const title = useSharedValue(0);
  const fade = useSharedValue(1);

  const petals = useMemo(
    () =>
      Array.from({ length: 16 }, (_, i) => ({
        key: i,
        delay: (i * 260) % 2400,
        startX: ((i * 53) % 100) / 100 * width,
        drift: ((i % 5) - 2) * 30,
        size: 9 + (i % 4) * 3,
        fall: 3200 + (i % 6) * 450,
      })),
    [width],
  );

  useEffect(() => {
    // "Walking" into the street: slow push-in with a slight sway.
    push.set(withTiming(1.32, { duration: DURATION + FADE_OUT, easing: Easing.out(Easing.quad) }));
    pan.set(withRepeat(withSequence(withTiming(1, { duration: 700 }), withTiming(-1, { duration: 700 })), -1, true));
    logo.set(withDelay(500, withTiming(1, { duration: 900, easing: Easing.out(Easing.back(1.4)) })));
    title.set(withDelay(1100, withTiming(1, { duration: 900, easing: Easing.out(Easing.cubic) })));

    const speak = setTimeout(() => {
      Speech.speak('Welcome to Journi', { rate: 0.9, pitch: 1.0, language: 'en-US' });
    }, 1200);
    const out = setTimeout(() => {
      fade.set(withTiming(0, { duration: FADE_OUT }));
    }, DURATION);
    const done = setTimeout(onFinish, DURATION + FADE_OUT);
    return () => {
      clearTimeout(speak);
      clearTimeout(out);
      clearTimeout(done);
      Speech.stop();
    };
    // Runs once per app launch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const bgStyle = useAnimatedStyle(() => ({
    transform: [{ scale: push.value }, { translateY: pan.value * 2.5 }, { rotate: `${pan.value * 0.25}deg` }],
  }));
  const logoStyle = useAnimatedStyle(() => ({
    opacity: logo.value,
    transform: [{ translateY: (1 - logo.value) * -40 }, { rotate: `${(1 - logo.value) * -25}deg` }, { scale: 0.6 + logo.value * 0.4 }],
  }));
  const titleStyle = useAnimatedStyle(() => ({
    opacity: title.value,
    transform: [{ translateY: (1 - title.value) * 18 }],
  }));
  const rootStyle = useAnimatedStyle(() => ({ opacity: fade.value }));

  return (
    <Animated.View style={[StyleSheet.absoluteFill, styles.root, rootStyle]}>
      <StatusBar style="light" />
      <Animated.View style={[StyleSheet.absoluteFill, bgStyle]}>
        <Image source={require('@/assets/images/onboarding/intro_ninenzaka.jpg')} style={StyleSheet.absoluteFill} contentFit="cover" />
      </Animated.View>
      {/* Warm evening light + readable bottom */}
      <LinearGradient colors={['rgba(255,150,90,0.28)', 'rgba(255,120,120,0.08)', 'rgba(8,16,28,0.85)']} locations={[0, 0.45, 1]} style={StyleSheet.absoluteFill} />

      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        {petals.map(({ key, ...p }) => (
          <Petal key={key} {...p} height={height} />
        ))}
      </View>

      <View style={styles.center} pointerEvents="none">
        <Animated.View style={[styles.logo, logoStyle]}>
          <Ionicons name="paper-plane" size={34} color={Colors.white} />
        </Animated.View>
        <Animated.View style={[{ alignItems: 'center' }, titleStyle]}>
          <Text variant="title" color="rgba(255,255,255,0.9)" style={{ letterSpacing: 2 }}>
            WELCOME TO
          </Text>
          <Text color={Colors.white} style={styles.brand}>
            Journi
          </Text>
          <Text variant="caption" color="rgba(255,255,255,0.8)">
            Your AI travel companion
          </Text>
        </Animated.View>
      </View>

      <Pressable onPress={onFinish} style={styles.skip} hitSlop={12} accessibilityRole="button" accessibilityLabel="Skip intro">
        <Text variant="label" color={Colors.white}>
          Skip
        </Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: Colors.ink, zIndex: 100, overflow: 'hidden' },
  petal: { position: 'absolute', top: 0, left: 0, backgroundColor: '#FFC4D6', shadowColor: '#FF8FB1', shadowOpacity: 0.4, shadowRadius: 3 },
  center: { position: 'absolute', left: 0, right: 0, bottom: '18%', alignItems: 'center', gap: 16 },
  logo: {
    width: 70,
    height: 70,
    borderRadius: 22,
    backgroundColor: Colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.5)',
  },
  brand: { fontFamily: Fonts.extrabold, fontSize: 56, lineHeight: 64, letterSpacing: -1.5 },
  skip: {
    position: 'absolute',
    top: 54,
    right: 20,
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: 'rgba(8,16,28,0.45)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
  },
});
