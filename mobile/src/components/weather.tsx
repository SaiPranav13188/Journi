import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { Colors, Radius } from '@/constants/theme';
import type { WeatherSummary } from '@/lib/types';
import { Text } from './ui/text';

const ICONS: Record<NonNullable<WeatherSummary['icon']>, { name: keyof typeof Ionicons.glyphMap; color: string }> = {
  sunny: { name: 'sunny', color: '#F59E0B' },
  'partly-cloudy': { name: 'partly-sunny', color: '#F59E0B' },
  cloudy: { name: 'cloudy', color: '#64748B' },
  fog: { name: 'reorder-three', color: '#94A3B8' },
  drizzle: { name: 'rainy-outline', color: '#3B82F6' },
  rain: { name: 'rainy', color: '#2563EB' },
  snow: { name: 'snow', color: '#38BDF8' },
  thunderstorm: { name: 'thunderstorm', color: '#7C3AED' },
};

export function weatherIcon(w?: { icon?: WeatherSummary['icon'] } | null) {
  return ICONS[w?.icon ?? 'cloudy'] ?? ICONS.cloudy;
}

export function WeatherChip({ weather, onDark }: { weather: WeatherSummary | null; onDark?: boolean }) {
  if (!weather?.available) {
    return (
      <View style={[styles.chip, onDark && styles.chipDark]}>
        <Ionicons name="time-outline" size={13} color={onDark ? Colors.white : Colors.muted} />
        <Text variant="caption" color={onDark ? Colors.white : Colors.muted} style={{ fontSize: 12 }}>
          {weather?.reason === 'past' ? '—' : 'Forecast soon'}
        </Text>
      </View>
    );
  }
  const icon = weatherIcon(weather);
  return (
    <View style={[styles.chip, onDark && styles.chipDark]}>
      <Ionicons name={icon.name} size={15} color={onDark ? Colors.white : icon.color} />
      <Text variant="label" color={onDark ? Colors.white : Colors.ink} style={{ fontSize: 12 }}>
        {Math.round(weather.temp_max ?? 0)}°
        <Text variant="caption" color={onDark ? 'rgba(255,255,255,0.7)' : Colors.muted} style={{ fontSize: 12 }}>
          {' '}
          / {Math.round(weather.temp_min ?? 0)}°
        </Text>
      </Text>
    </View>
  );
}

/** Detailed forecast row shown inside an expanded day. */
export function WeatherDetails({ weather }: { weather: WeatherSummary | null }) {
  if (!weather?.available) {
    return (
      <View style={styles.details}>
        <Ionicons name="telescope-outline" size={18} color={Colors.muted} />
        <Text variant="caption" color={Colors.inkSoft} style={{ flex: 1 }}>
          {weather?.reason === 'beyond_forecast_range'
            ? 'Too far ahead for a reliable forecast — we’ll check again daily as your trip gets closer.'
            : 'Forecast unavailable right now.'}
        </Text>
      </View>
    );
  }
  const icon = weatherIcon(weather);
  return (
    <View style={styles.details}>
      <Ionicons name={icon.name} size={24} color={icon.color} />
      <View style={{ flex: 1 }}>
        <Text variant="label">{weather.condition}</Text>
        <Text variant="caption" color={Colors.muted}>
          {Math.round(weather.temp_min ?? 0)}–{Math.round(weather.temp_max ?? 0)}°C · 💧 {weather.precipitation_probability ?? 0}% · 💨{' '}
          {Math.round(weather.wind_speed_max ?? 0)} km/h
        </Text>
      </View>
    </View>
  );
}

export function WarningBanner({ warning }: { warning: string }) {
  const lines = warning.split('\n').filter(Boolean);
  return (
    <Animated.View entering={FadeIn.duration(300)} style={styles.warning}>
      {lines.map((line) => (
        <Text key={line} variant="caption" color={Colors.warning} style={{ fontFamily: 'PlusJakartaSans_600SemiBold' }}>
          {line}
        </Text>
      ))}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: Radius.pill,
    backgroundColor: Colors.bg,
  },
  chipDark: { backgroundColor: 'rgba(255,255,255,0.18)' },
  details: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: Radius.md, backgroundColor: Colors.bg },
  warning: {
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: Radius.md,
    backgroundColor: Colors.warningBg,
    borderWidth: 1,
    borderColor: Colors.warningBorder,
  },
});
