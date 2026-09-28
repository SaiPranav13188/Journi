import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, View } from 'react-native';

import { Colors, Radius, Shadow } from '@/constants/theme';
import { formatDate } from '@/lib/format';
import type { CurrentWeather } from '@/lib/types';
import { Text } from './ui/text';
import { weatherIcon } from './weather';

/** "Weather in Goa" — current conditions plus a 5-day outlook. */
export function WeatherCard({ place, weather }: { place: string; weather: CurrentWeather }) {
  const now = weather.current;
  const icon = weatherIcon(now);
  return (
    <View style={styles.card}>
      <Text variant="label" color={Colors.inkSoft}>
        Weather in {place} · right now
      </Text>
      <View style={styles.nowRow}>
        <Text variant="display" style={{ fontSize: 40, lineHeight: 46 }}>
          {Math.round(now.temp)}°
        </Text>
        <View style={{ flex: 1 }}>
          <Text variant="title">{now.condition}</Text>
          <Text variant="caption" color={Colors.muted}>
            Feels like {Math.round(now.feels_like)}° · 💧 {now.humidity}% · 💨 {Math.round(now.wind_speed)} km/h
          </Text>
        </View>
        <Ionicons name={icon.name} size={44} color={icon.color} />
      </View>
      <View style={styles.daysRow}>
        {weather.daily.map((d, i) => {
          const di = weatherIcon(d);
          return (
            <View key={d.date} style={styles.day}>
              <Text variant="caption" color={Colors.muted} style={{ fontSize: 11 }}>
                {i === 0 ? 'Today' : formatDate(d.date, { weekday: 'short' })}
              </Text>
              <Ionicons name={di.name} size={22} color={di.color} />
              <Text variant="label" style={{ fontSize: 12 }}>
                {Math.round(d.temp_max)}°
                <Text variant="caption" color={Colors.muted} style={{ fontSize: 11 }}>
                  /{Math.round(d.temp_min)}°
                </Text>
              </Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: 12, padding: 16, borderRadius: Radius.xl, backgroundColor: Colors.surface, ...Shadow.card },
  nowRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  daysRow: { flexDirection: 'row', justifyContent: 'space-between', paddingTop: 10, borderTopWidth: 1, borderTopColor: Colors.surfaceAlt },
  day: { alignItems: 'center', gap: 4, flex: 1 },
});
