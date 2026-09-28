import { Ionicons } from '@expo/vector-icons';
import { useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { WebView } from 'react-native-webview';

import { Colors, Radius, Shadow } from '@/constants/theme';
import { formatDate } from '@/lib/format';
import type { Destination, ItineraryDay } from '@/lib/types';
import { PressableScale } from './ui/pressable-scale';
import { Text } from './ui/text';

export const DAY_COLORS = ['#0E6E6B', '#FF6B4A', '#6366F1', '#F59E0B', '#0EA5E9', '#DB2777', '#16A34A', '#9333EA', '#EA580C', '#0891B2'];
export const dayColor = (dayNumber: number) => DAY_COLORS[(dayNumber - 1) % DAY_COLORS.length];

interface Stop {
  id: string;
  dayNumber: number;
  index: number; // 1-based within the day
  title: string;
  lat: number;
  lng: number;
}

function stopsFor(days: ItineraryDay[]): Stop[] {
  return days.flatMap((d) =>
    d.activities
      .filter((a) => !a.placeholder && a.lat != null && a.lng != null)
      .map((a, i) => ({ id: a.id, dayNumber: d.day_number, index: i + 1, title: a.title, lat: a.lat!, lng: a.lng! })),
  );
}

/**
 * Leaflet map with OpenStreetMap (CARTO) tiles in a WebView — works on every
 * phone without a Google Maps key.
 */
function mapHtml(stops: Stop[], center: { lat: number; lng: number }, zoom: number, interactive: boolean) {
  // Escape "<" so a place name can never close the <script> tag.
  const data = JSON.stringify(stops.map((s) => ({ ...s, color: dayColor(s.dayNumber) }))).replace(/</g, '\\u003c');
  return `<!doctype html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  html,body,#map{margin:0;height:100%;background:#EFEBE3}
  .pin{width:24px;height:24px;border-radius:12px;border:2px solid #fff;color:#fff;font:700 11px/20px -apple-system,Roboto,sans-serif;text-align:center;box-shadow:0 1px 4px rgba(0,0,0,.35)}
  .leaflet-popup-content{font:600 13px -apple-system,Roboto,sans-serif;margin:8px 10px}
</style></head><body><div id="map"></div><script>
  var stops = ${data};
  var map = L.map("map", { zoomControl: ${interactive}, attributionControl: true, dragging: ${interactive}, touchZoom: ${interactive},
    scrollWheelZoom: false, doubleClickZoom: ${interactive}, boxZoom: false, keyboard: false, tap: ${interactive} })
    .setView([${center.lat}, ${center.lng}], ${zoom});
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19, attribution: "Tiles © Esri" }).addTo(map);
  var byDay = {};
  stops.forEach(function (s) { (byDay[s.dayNumber] = byDay[s.dayNumber] || []).push(s); });
  Object.keys(byDay).forEach(function (d) {
    var pts = byDay[d].map(function (s) { return [s.lat, s.lng]; });
    if (pts.length > 1) L.polyline(pts, { color: byDay[d][0].color, weight: 3, dashArray: "6 6" }).addTo(map);
  });
  var bounds = [];
  stops.forEach(function (s) {
    var icon = L.divIcon({ className: "", html: "<div class=\\"pin\\" style=\\"background:" + s.color + "\\">" + s.index + "</div>", iconSize: [24, 24], iconAnchor: [12, 12] });
    L.marker([s.lat, s.lng], { icon: icon }).addTo(map).bindPopup("Day " + s.dayNumber + " · " + s.index + ". " + s.title.replace(/</g, "&lt;"));
    bounds.push([s.lat, s.lng]);
  });
  // The WebView can start at a tiny size; re-fit once it has its real size.
  function fit() {
    map.invalidateSize();
    if (bounds.length > 1) map.fitBounds(bounds, { padding: [${interactive ? 40 : 24}, ${interactive ? 40 : 24}] });
    else if (bounds.length === 1) map.setView(bounds[0], 14);
  }
  fit();
  window.addEventListener("resize", fit);
  setTimeout(fit, 250);
  setTimeout(fit, 900);
</script></body></html>`;
}

interface TripMapProps {
  days: ItineraryDay[];
  destination: Destination;
  /** Small, non-interactive preview (dashboard). */
  compact?: boolean;
  locating?: boolean;
  style?: StyleProp<ViewStyle>;
}

/** Map of the itinerary: numbered stops per day, joined by a coloured route. */
export function TripMap({ days, destination, compact, locating, style }: TripMapProps) {
  const [dayFilter, setDayFilter] = useState<number | null>(null);

  const visibleDays = useMemo(() => (dayFilter ? days.filter((d) => d.day_number === dayFilter) : days), [days, dayFilter]);
  const stops = useMemo(() => stopsFor(visibleDays), [visibleDays]);
  const missing = useMemo(
    () => visibleDays.flatMap((d) => d.activities.filter((a) => !a.placeholder && a.lat == null).map((a) => a.title)),
    [visibleDays],
  );

  const countryLevel = destination.country && destination.name.toLowerCase() === destination.country.toLowerCase();
  const html = useMemo(
    () => mapHtml(stops, { lat: destination.latitude, lng: destination.longitude }, countryLevel ? 5 : 11, !compact),
    [stops, destination.latitude, destination.longitude, countryLevel, compact],
  );

  return (
    <View style={[{ gap: 12 }, style]}>
      {!compact && days.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
          <PressableScale haptic onPress={() => setDayFilter(null)} style={[styles.chip, dayFilter === null && styles.chipActive]}>
            <Text variant="label" color={dayFilter === null ? Colors.white : Colors.ink} style={{ fontSize: 12 }}>
              All days
            </Text>
          </PressableScale>
          {days.map((d) => {
            const active = dayFilter === d.day_number;
            return (
              <PressableScale
                key={d.day_number}
                haptic
                onPress={() => setDayFilter(d.day_number)}
                style={[styles.chip, active && { backgroundColor: dayColor(d.day_number), borderColor: dayColor(d.day_number) }]}
              >
                <View style={[styles.dot, { backgroundColor: active ? Colors.white : dayColor(d.day_number) }]} />
                <Text variant="label" color={active ? Colors.white : Colors.ink} style={{ fontSize: 12 }}>
                  Day {d.day_number}
                </Text>
              </PressableScale>
            );
          })}
        </ScrollView>
      )}

      <View style={[styles.mapWrap, compact ? { height: 180 } : { height: 380 }]}>
        <WebView
          originWhitelist={['*']}
          source={{ html }}
          style={StyleSheet.absoluteFill}
          scrollEnabled={false}
          pointerEvents={compact ? 'none' : 'auto'}
          javaScriptEnabled
          setSupportMultipleWindows={false}
        />

        {(locating || (stops.length === 0 && !compact)) && (
          <View style={styles.overlay}>
            {locating ? (
              <>
                <ActivityIndicator color={Colors.primary} />
                <Text variant="caption" color={Colors.inkSoft}>
                  Placing your stops on the map…
                </Text>
              </>
            ) : (
              <Text variant="caption" color={Colors.inkSoft}>
                No places to show yet
              </Text>
            )}
          </View>
        )}
      </View>

      {!compact && (
        <View style={{ gap: 10 }}>
          {visibleDays.map((d) => {
            const dayStops = stops.filter((s) => s.dayNumber === d.day_number);
            if (dayStops.length === 0) return null;
            return (
              <View key={d.day_number} style={styles.legendDay}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <View style={[styles.dot, { backgroundColor: dayColor(d.day_number), width: 10, height: 10 }]} />
                  <Text variant="label">
                    Day {d.day_number} · {formatDate(d.date, { weekday: 'short', day: 'numeric', month: 'short' })}
                  </Text>
                </View>
                {dayStops.map((s) => (
                  <View key={s.id} style={styles.legendRow}>
                    <View style={[styles.legendNum, { borderColor: dayColor(d.day_number) }]}>
                      <Text variant="caption" color={dayColor(d.day_number)} style={{ fontSize: 11 }}>
                        {s.index}
                      </Text>
                    </View>
                    <Text variant="caption" color={Colors.inkSoft} numberOfLines={1} style={{ flex: 1 }}>
                      {s.title}
                    </Text>
                  </View>
                ))}
              </View>
            );
          })}
          {missing.length > 0 && !locating && (
            <View style={styles.missing}>
              <Ionicons name="help-circle-outline" size={16} color={Colors.muted} />
              <Text variant="caption" color={Colors.muted} style={{ flex: 1 }}>
                Couldn’t pin on the map: {missing.join(', ')}
              </Text>
            </View>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  mapWrap: { borderRadius: Radius.xl, overflow: 'hidden', backgroundColor: Colors.surfaceAlt, ...Shadow.card },
  overlay: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: 10,
    borderRadius: Radius.md,
    backgroundColor: 'rgba(255,255,255,0.94)',
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: Radius.pill,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  dot: { width: 8, height: 8, borderRadius: 5 },
  legendDay: { gap: 6, padding: 12, borderRadius: Radius.lg, backgroundColor: Colors.surface },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 4 },
  legendNum: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  missing: { flexDirection: 'row', gap: 6, paddingHorizontal: 4 },
});
