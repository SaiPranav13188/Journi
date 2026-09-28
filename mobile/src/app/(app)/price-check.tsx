import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { IconButton } from '@/components/ui/icon-button';
import { PressableScale } from '@/components/ui/pressable-scale';
import { Text } from '@/components/ui/text';
import { Colors, Fonts, Radius, Shadow } from '@/constants/theme';
import { api } from '@/lib/api';
import { daysUntil, formatMoney } from '@/lib/format';
import type { PriceCheckResult, PriceItem, TripListItem } from '@/lib/types';

const VERDICT: Record<PriceItem['verdict'], { label: string; color: string; bg: string; icon: keyof typeof Ionicons.glyphMap }> = {
  cheap: { label: 'Good deal', color: '#15803D', bg: '#E4F5EA', icon: 'thumbs-up' },
  fair: { label: 'Fair price', color: '#0E6E6B', bg: '#DCEFEC', icon: 'checkmark-circle' },
  high: { label: 'A bit high', color: '#B45309', bg: '#FFF4E0', icon: 'alert-circle' },
  very_high: { label: 'Overpriced', color: '#DC2626', bg: '#FDECEC', icon: 'warning' },
  unknown: { label: 'Not sure', color: '#64748B', bg: '#EFEBE3', icon: 'help-circle' },
};

/** "Is this price fair?" — photo of a menu, price tag or quote → ₹ and a verdict. */
export default function PriceCheckScreen() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ place?: string; countryCode?: string }>();
  const [trips, setTrips] = useState<TripListItem[]>([]);
  const [place, setPlace] = useState(params.place ?? '');
  const [countryCode, setCountryCode] = useState<string | null>(params.countryCode ?? null);
  const [note, setNote] = useState('');
  const [photo, setPhoto] = useState<{ uri: string; base64: string; mimeType: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<PriceCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .listTrips()
      .then((t) => {
        const upcoming = t.filter((x) => daysUntil(x.end_date) >= 0).sort((a, b) => a.start_date.localeCompare(b.start_date));
        setTrips(upcoming);
        // Default to the next trip's destination.
        if (!params.place && upcoming[0]) {
          setPlace((cur) => cur || [upcoming[0].destination.name, upcoming[0].destination.country].filter(Boolean).join(', '));
          setCountryCode((cur) => cur ?? upcoming[0].destination.country_code);
        }
      })
      .catch(() => {});
  }, [params.place]);

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
    if (!a?.base64) return;
    const next = { uri: a.uri, base64: a.base64, mimeType: a.mimeType ?? 'image/jpeg' };
    setPhoto(next);
    setResult(null);
    check(next);
  };

  const check = async (p = photo) => {
    if (!p) return;
    if (place.trim().length < 2) {
      setError('Tell us which city you’re in first.');
      return;
    }
    setChecking(true);
    setError(null);
    try {
      setResult(await api.priceCheck({ base64: p.base64, mimeType: p.mimeType, place: place.trim(), countryCode, note: note.trim() || null }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setChecking(false);
    }
  };

  const worst = result?.items.some((i) => i.verdict === 'very_high') ? 'very_high' : result?.items.some((i) => i.verdict === 'high') ? 'high' : 'fair';

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: Colors.bg }}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <IconButton icon="chevron-back" onPress={() => router.back()} accessibilityLabel="Back" />
        <View style={{ flex: 1 }}>
          <Text variant="h2">Is this price fair?</Text>
          <Text variant="caption" color={Colors.muted}>
            Snap a menu, price tag or taxi quote
          </Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 40, gap: 16 }} keyboardShouldPersistTaps="handled">
        <View style={styles.card}>
          <Text variant="label" color={Colors.inkSoft}>
            Where are you?
          </Text>
          <View style={styles.inputRow}>
            <Ionicons name="location-outline" size={18} color={Colors.primary} />
            <TextInput
              value={place}
              onChangeText={(t) => {
                setPlace(t);
                setCountryCode(null);
              }}
              placeholder="City, e.g. Hanoi, Vietnam"
              placeholderTextColor={Colors.muted}
              style={styles.input}
              maxLength={120}
            />
          </View>
          {trips.length > 0 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }} keyboardShouldPersistTaps="handled">
              {trips.map((t) => {
                const label = [t.destination.name, t.destination.country].filter(Boolean).join(', ');
                const active = place === label;
                return (
                  <PressableScale
                    key={t.id}
                    haptic
                    onPress={() => {
                      setPlace(label);
                      setCountryCode(t.destination.country_code);
                    }}
                    style={[styles.chip, active && styles.chipActive]}
                  >
                    <Text variant="caption" color={active ? Colors.white : Colors.ink}>
                      {t.destination.name}
                    </Text>
                  </PressableScale>
                );
              })}
            </ScrollView>
          )}
          <View style={styles.inputRow}>
            <Ionicons name="chatbox-ellipses-outline" size={18} color={Colors.primary} />
            <TextInput
              value={note}
              onChangeText={setNote}
              placeholder="Optional: e.g. taxi from airport to Old Quarter"
              placeholderTextColor={Colors.muted}
              style={styles.input}
              maxLength={200}
            />
          </View>
        </View>

        <View style={styles.buttons}>
          <PressableScale haptic onPress={() => pick('camera')} style={styles.bigBtn}>
            <Ionicons name="camera" size={26} color={Colors.white} />
            <Text variant="label" color={Colors.white}>
              Take photo
            </Text>
          </PressableScale>
          <PressableScale haptic onPress={() => pick('library')} style={[styles.bigBtn, styles.bigBtnAlt]}>
            <Ionicons name="images-outline" size={26} color={Colors.primary} />
            <Text variant="label" color={Colors.primary}>
              From photos
            </Text>
          </PressableScale>
        </View>

        {photo && (
          <View style={styles.photoWrap}>
            <Image source={{ uri: photo.uri }} style={StyleSheet.absoluteFill} contentFit="cover" />
            {checking && (
              <View style={styles.photoOverlay}>
                <ActivityIndicator color={Colors.white} />
                <Text variant="label" color={Colors.white}>
                  Checking local prices…
                </Text>
              </View>
            )}
          </View>
        )}

        {!!error && (
          <View style={[styles.card, { flexDirection: 'row', alignItems: 'center', gap: 10 }]}>
            <Ionicons name="alert-circle" size={20} color={Colors.danger} />
            <Text variant="caption" color={Colors.danger} style={{ flex: 1 }}>
              {error}
            </Text>
            {photo && (
              <PressableScale onPress={() => check()} hitSlop={8}>
                <Text variant="label" color={Colors.primary}>
                  Retry
                </Text>
              </PressableScale>
            )}
          </View>
        )}

        {result && (
          <Animated.View entering={FadeInDown.duration(400)} style={{ gap: 12 }}>
            <View style={[styles.summary, { backgroundColor: VERDICT[worst].bg }]}>
              <Ionicons name={VERDICT[worst].icon} size={24} color={VERDICT[worst].color} />
              <View style={{ flex: 1 }}>
                <Text variant="label" color={VERDICT[worst].color}>
                  {result.what ?? 'Prices checked'}
                </Text>
                {!!result.summary && (
                  <Text variant="caption" color={Colors.inkSoft}>
                    {result.summary}
                  </Text>
                )}
              </View>
            </View>

            {result.items.map((i, idx) => {
              const v = VERDICT[i.verdict];
              return (
                <Animated.View key={`${i.name}-${idx}`} entering={FadeInDown.delay(idx * 50).duration(300)} style={styles.item}>
                  <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
                    <View style={{ flex: 1 }}>
                      <Text variant="title" style={{ fontSize: 15 }}>
                        {i.name}
                      </Text>
                      <Text variant="caption" color={Colors.muted}>
                        {formatMoney(i.price, result.currency)}
                        {i.price_inr != null && result.currency !== 'INR' ? `  ≈  ${formatMoney(i.price_inr, 'INR')}` : ''}
                      </Text>
                    </View>
                    <View style={[styles.badge, { backgroundColor: v.bg }]}>
                      <Ionicons name={v.icon} size={13} color={v.color} />
                      <Text variant="caption" color={v.color} style={{ fontSize: 12 }}>
                        {v.label}
                      </Text>
                    </View>
                  </View>
                  {i.typical_low_inr != null && i.typical_high_inr != null && (
                    <Text variant="caption" color={Colors.inkSoft}>
                      Usual price: {formatMoney(i.typical_low_inr, 'INR')} – {formatMoney(i.typical_high_inr, 'INR')}
                      {result.currency !== 'INR' && i.typical_low != null && i.typical_high != null
                        ? ` (${formatMoney(i.typical_low, result.currency)} – ${formatMoney(i.typical_high, result.currency)})`
                        : ''}
                    </Text>
                  )}
                  {!!i.note && (
                    <Text variant="caption" color={Colors.muted}>
                      {i.note}
                    </Text>
                  )}
                </Animated.View>
              );
            })}

            {!!result.tip && (
              <View style={styles.tip}>
                <Ionicons name="bulb-outline" size={18} color={Colors.gold} />
                <Text variant="caption" color={Colors.inkSoft} style={{ flex: 1 }}>
                  {result.tip}
                </Text>
              </View>
            )}
            <Text variant="caption" color={Colors.muted} center>
              AI estimates of typical local prices — use them as a guide.
            </Text>
          </Animated.View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingBottom: 8 },
  card: { gap: 10, padding: 16, borderRadius: Radius.xl, backgroundColor: Colors.surface, ...Shadow.card },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    height: 48,
    paddingHorizontal: 12,
    borderRadius: Radius.md,
    backgroundColor: Colors.bg,
  },
  input: { flex: 1, height: '100%', fontFamily: Fonts.medium, fontSize: 15, color: Colors.ink },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: Radius.pill, backgroundColor: Colors.bg, borderWidth: 1, borderColor: Colors.border },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  buttons: { flexDirection: 'row', gap: 10 },
  bigBtn: { flex: 1, alignItems: 'center', gap: 6, paddingVertical: 18, borderRadius: Radius.xl, backgroundColor: Colors.primary },
  bigBtnAlt: { backgroundColor: Colors.primarySoft },
  photoWrap: { height: 200, borderRadius: Radius.xl, overflow: 'hidden', backgroundColor: Colors.surfaceAlt },
  photoOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(8,16,28,0.55)', alignItems: 'center', justifyContent: 'center', gap: 8 },
  summary: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: Radius.lg },
  item: { gap: 6, padding: 14, borderRadius: Radius.lg, backgroundColor: Colors.surface, ...Shadow.card },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: Radius.pill },
  tip: { flexDirection: 'row', gap: 10, padding: 14, borderRadius: Radius.lg, backgroundColor: '#FFF8E6' },
});
