import { Ionicons } from '@expo/vector-icons';
import Constants from 'expo-constants';
import { Image } from 'expo-image';
import { router, useFocusEffect } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Switch, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/button';
import { PressableScale } from '@/components/ui/pressable-scale';
import { Text } from '@/components/ui/text';
import { TextField } from '@/components/ui/text-field';
import { Colors, Radius, Shadow } from '@/constants/theme';
import { displayName, useAuth } from '@/context/auth-context';
import { useSavedPlaces } from '@/hooks/use-saved-places';
import { api } from '@/lib/api';
import { daysUntil } from '@/lib/format';
import { agenticAiEnabled, homeCity, weatherAlertsEnabled } from '@/lib/profile';
import { supabase } from '@/lib/supabase';

function Row({
  icon,
  label,
  hint,
  right,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  hint?: string;
  right?: React.ReactNode;
  onPress?: () => void;
}) {
  const content = (
    <View style={styles.row}>
      <View style={styles.rowIcon}>
        <Ionicons name={icon} size={18} color={Colors.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text variant="label">{label}</Text>
        {!!hint && (
          <Text variant="caption" color={Colors.muted} numberOfLines={2}>
            {hint}
          </Text>
        )}
      </View>
      {right ?? (onPress ? <Ionicons name="chevron-forward" size={18} color={Colors.muted} /> : null)}
    </View>
  );
  return onPress ? (
    <PressableScale haptic onPress={onPress} scaleTo={0.99}>
      {content}
    </PressableScale>
  ) : (
    content
  );
}

export default function ProfileScreen() {
  const insets = useSafeAreaInsets();
  const { user, signOut } = useAuth();
  const saved = useSavedPlaces();
  const [stats, setStats] = useState<{ trips: number; countries: number } | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [city, setCity] = useState('');
  const [saving, setSaving] = useState(false);

  const alertsOn = weatherAlertsEnabled(user);
  const agentsOn = agenticAiEnabled(user);
  const avatarUrl: string | undefined = user?.user_metadata?.avatar_url;
  const fullName: string = user?.user_metadata?.full_name || user?.user_metadata?.name || displayName(user);

  useFocusEffect(
    useCallback(() => {
      api
        .listTrips()
        .then((t) =>
          setStats({
            trips: t.length,
            countries: new Set(t.filter((x) => daysUntil(x.end_date) < 0).map((x) => x.destination.country_code).filter(Boolean)).size,
          }),
        )
        .catch(() => {});
    }, []),
  );

  const startEditing = () => {
    setName(fullName);
    setCity(homeCity(user));
    setEditing(true);
  };

  const updateMetadata = async (data: Record<string, unknown>) => {
    const { error } = await supabase.auth.updateUser({ data });
    if (error) throw error;
  };

  const saveProfile = async () => {
    setSaving(true);
    try {
      await updateMetadata({ full_name: name.trim() || fullName, home_city: city.trim() });
      setEditing(false);
    } catch (err) {
      Alert.alert('Couldn’t save profile', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: Colors.bg }}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={{ paddingTop: insets.top + 12, paddingBottom: 32, paddingHorizontal: 20, gap: 18 }} keyboardShouldPersistTaps="handled">
        <Text variant="h1">Profile</Text>

        <Animated.View entering={FadeInDown.duration(400)} style={[styles.card, { alignItems: 'center' }]}>
          <View style={styles.avatar}>
            {avatarUrl ? (
              <Image source={{ uri: avatarUrl }} style={StyleSheet.absoluteFill} />
            ) : (
              <Text variant="h1" color={Colors.white}>
                {fullName.charAt(0).toUpperCase()}
              </Text>
            )}
          </View>
          <Text variant="h2">{fullName}</Text>
          <Text variant="caption" color={Colors.muted}>
            {user?.email}
          </Text>
          <View style={styles.statsRow}>
            {[
              { label: 'Trips', value: stats?.trips ?? '–' },
              { label: 'Countries', value: stats?.countries ?? '–' },
              { label: 'Saved', value: saved.places.length },
            ].map((s) => (
              <View key={s.label} style={styles.statItem}>
                <Text variant="h2">{s.value}</Text>
                <Text variant="caption" color={Colors.muted}>
                  {s.label}
                </Text>
              </View>
            ))}
          </View>
        </Animated.View>

        {editing ? (
          <Animated.View entering={FadeInDown.duration(300)} style={[styles.card, { gap: 14 }]}>
            <TextField label="Your name" icon="person-outline" value={name} onChangeText={setName} maxLength={60} />
            <TextField
              label="Home city (you usually fly from)"
              icon="airplane-outline"
              placeholder="e.g. Hyderabad"
              value={city}
              onChangeText={setCity}
              maxLength={80}
            />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Button title="Cancel" variant="outline" onPress={() => setEditing(false)} style={{ flex: 1 }} />
              <Button title="Save" onPress={saveProfile} loading={saving} style={{ flex: 1 }} />
            </View>
          </Animated.View>
        ) : (
          <Animated.View entering={FadeInDown.delay(80).duration(400)} style={styles.card}>
            <Text variant="overline" color={Colors.muted}>
              Account
            </Text>
            <Row icon="person-outline" label="Edit profile" hint="Name and home city" onPress={startEditing} />
            <Row icon="airplane-outline" label="Home city" hint={homeCity(user) || 'Not set — used to pre-fill “Flying from”'} onPress={startEditing} />
          </Animated.View>
        )}

        <Animated.View entering={FadeInDown.delay(140).duration(400)} style={styles.card}>
          <Text variant="overline" color={Colors.muted}>
            Settings
          </Text>
          <Row
            icon="thunderstorm-outline"
            label="Weather alerts"
            hint="Show a notification when bad weather is forecast for a saved trip"
            right={
              <Switch
                value={alertsOn}
                onValueChange={(v) => updateMetadata({ weather_alerts: v }).catch((err) => Alert.alert('Couldn’t update', (err as Error).message))}
                trackColor={{ true: Colors.primary, false: Colors.border }}
                thumbColor={Colors.white}
              />
            }
          />
          <Row
            icon="sparkles-outline"
            label="Agentic AI (beta)"
            hint="Journi’s AI decides which checks each request needs — weather, places, budget — and can save clear tickets for you"
            right={
              <Switch
                value={agentsOn}
                onValueChange={(v) => updateMetadata({ agentic_ai: v }).catch((err) => Alert.alert('Couldn’t update', (err as Error).message))}
                trackColor={{ true: Colors.primary, false: Colors.border }}
                thumbColor={Colors.white}
              />
            }
          />
          <Row icon="notifications-outline" label="Alerts inbox" hint="Weather warnings, suggested plan changes and budget alerts" onPress={() => router.push('/alerts')} />
          <Row icon="heart-outline" label="Saved places" hint="Your bucket list" onPress={() => router.push('/explore')} />
          <Row icon="ticket-outline" label="Bookings" hint="Flights, hotels and tickets" onPress={() => router.push('/bookings')} />
        </Animated.View>

        <Animated.View entering={FadeInDown.delay(200).duration(400)} style={styles.card}>
          <Text variant="overline" color={Colors.muted}>
            About
          </Text>
          <Row icon="information-circle-outline" label="Journi" hint={`Version ${Constants.expoConfig?.version ?? '1.0.0'} · AI trip planner`} />
          <Row
            icon="shield-checkmark-outline"
            label="Your data"
            hint="Trips, bookings and saved places are private to your account."
          />
        </Animated.View>

        <Button
          title="Sign out"
          variant="danger"
          icon="log-out-outline"
          onPress={() =>
            Alert.alert('Sign out?', 'You can sign back in any time — your trips stay saved.', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Sign out', style: 'destructive', onPress: () => signOut() },
            ])
          }
          fullWidth
        />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: 6, padding: 16, borderRadius: Radius.xl, backgroundColor: Colors.surface, ...Shadow.card },
  avatar: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    marginBottom: 6,
  },
  statsRow: { flexDirection: 'row', alignSelf: 'stretch', marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: Colors.surfaceAlt },
  statItem: { flex: 1, alignItems: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  rowIcon: { width: 36, height: 36, borderRadius: 10, backgroundColor: Colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
});
