import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeInDown,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { PressableScale } from '@/components/ui/pressable-scale';
import { Text } from '@/components/ui/text';
import { Colors, Fonts, Gradients, Radius } from '@/constants/theme';
import { useAuth } from '@/context/auth-context';

const SLIDES = [
  { image: require('@/assets/images/onboarding/oia_greece.jpg'), place: 'Oia, Santorini', country: 'Greece' },
  { image: require('@/assets/images/onboarding/kyoto.jpg'), place: 'Kinkaku-ji, Kyoto', country: 'Japan' },
  { image: require('@/assets/images/onboarding/hawa_mahal.jpg'), place: 'Hawa Mahal, Jaipur', country: 'India' },
  { image: require('@/assets/images/onboarding/machu_picchu.jpg'), place: 'Machu Picchu', country: 'Peru' },
  { image: require('@/assets/images/onboarding/matterhorn.jpg'), place: 'The Matterhorn', country: 'Switzerland' },
  { image: require('@/assets/images/onboarding/taj_mahal.jpg'), place: 'Taj Mahal, Agra', country: 'India' },
];

const SLIDE_MS = 5000;

/** Slowly zooming background photo ("Ken Burns" effect). */
function KenBurnsImage({ source }: { source: number }) {
  const scale = useSharedValue(1.05);
  useEffect(() => {
    scale.set(withTiming(1.22, { duration: SLIDE_MS + 1200, easing: Easing.linear }));
  }, [scale]);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <Animated.View entering={FadeIn.duration(1100)} exiting={FadeOut.duration(1100)} style={[StyleSheet.absoluteFill, style]}>
      <Image source={source} style={StyleSheet.absoluteFill} contentFit="cover" />
    </Animated.View>
  );
}

export default function WelcomeScreen() {
  const { signInWithGoogle } = useAuth();
  const [index, setIndex] = useState(0);
  const [googleLoading, setGoogleLoading] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setIndex((i) => (i + 1) % SLIDES.length), SLIDE_MS);
    return () => clearInterval(id);
  }, []);

  const slide = SLIDES[index];

  const onGoogle = async () => {
    try {
      setGoogleLoading(true);
      await signInWithGoogle();
    } catch (err) {
      Alert.alert('Google sign-in failed', (err as Error).message);
    } finally {
      setGoogleLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <StatusBar style="light" />
      <KenBurnsImage key={index} source={slide.image} />
      <LinearGradient colors={Gradients.topFade} style={styles.topFade} />
      <LinearGradient colors={['rgba(8,16,28,0)', 'rgba(8,16,28,0.6)', 'rgba(8,16,28,0.96)']} locations={[0, 0.4, 1]} style={styles.bottomFade} />

      <SafeAreaView style={styles.safe}>
        <Animated.View entering={FadeInDown.delay(150).duration(700)} style={styles.brandRow}>
          <View style={styles.logo}>
            <Ionicons name="paper-plane" size={18} color={Colors.white} />
          </View>
          <Text variant="h3" color={Colors.white} style={{ fontFamily: Fonts.extrabold, letterSpacing: -0.3 }}>
            Journi
          </Text>
        </Animated.View>

        <View style={{ flex: 1 }} />

        <Animated.View key={`cap-${index}`} entering={FadeInDown.duration(600)} style={styles.placeChip}>
          <Ionicons name="location" size={14} color={Colors.gold} />
          <Text variant="label" color={Colors.white}>
            {slide.place} · {slide.country}
          </Text>
        </Animated.View>

        <Animated.View entering={FadeInDown.delay(300).duration(800)}>
          <Text variant="display" color={Colors.white} style={{ fontSize: 38, lineHeight: 44 }}>
            Plan trips that feel{'\n'}like a conversation.
          </Text>
          <Text variant="body" color="rgba(255,255,255,0.82)" style={{ marginTop: 12, fontSize: 16, lineHeight: 24 }}>
            Tell Journi where you&apos;re headed. Get a day-by-day plan with live weather, budgets in ₹ and local currency — then
            just chat to fine-tune it.
          </Text>
        </Animated.View>

        <View style={styles.dots}>
          {SLIDES.map((_, i) => (
            <View key={i} style={[styles.dot, i === index && styles.dotActive]} />
          ))}
        </View>

        <Animated.View entering={FadeInDown.delay(500).duration(800)} style={{ gap: 12 }}>
          <PressableScale haptic onPress={onGoogle} disabled={googleLoading} style={styles.googleBtn} accessibilityRole="button">
            <Ionicons name="logo-google" size={20} color={Colors.ink} />
            <Text variant="bodyStrong" style={{ fontSize: 16 }}>
              {googleLoading ? 'Connecting…' : 'Continue with Google'}
            </Text>
          </PressableScale>
          <PressableScale haptic onPress={() => router.push('/email')} style={styles.emailBtn} accessibilityRole="button">
            <Ionicons name="mail-outline" size={20} color={Colors.white} />
            <Text variant="bodyStrong" color={Colors.white} style={{ fontSize: 16 }}>
              Continue with email
            </Text>
          </PressableScale>
          <Text variant="caption" color="rgba(255,255,255,0.6)" center style={{ marginTop: 4 }}>
            By continuing you agree to Journi&apos;s Terms & Privacy Policy.
          </Text>
        </Animated.View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.ink },
  topFade: { position: 'absolute', top: 0, left: 0, right: 0, height: 180 },
  bottomFade: { position: 'absolute', left: 0, right: 0, bottom: 0, height: '75%' },
  safe: { flex: 1, paddingHorizontal: 24, paddingBottom: 12 },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8 },
  logo: {
    width: 34,
    height: 34,
    borderRadius: 11,
    backgroundColor: Colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ rotate: '-8deg' }],
  },
  placeChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: Radius.pill,
    backgroundColor: 'rgba(255,255,255,0.16)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.22)',
    marginBottom: 16,
  },
  dots: { flexDirection: 'row', gap: 6, marginVertical: 24 },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.35)' },
  dotActive: { width: 22, backgroundColor: Colors.white },
  googleBtn: {
    height: 56,
    borderRadius: Radius.pill,
    backgroundColor: Colors.white,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  emailBtn: {
    height: 56,
    borderRadius: Radius.pill,
    backgroundColor: 'rgba(255,255,255,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
});
