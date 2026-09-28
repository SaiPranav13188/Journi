import { Ionicons } from '@expo/vector-icons';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { Colors, Radius, Shadow } from '@/constants/theme';
import { formatDate } from '@/lib/format';
import type { ItineraryDay, ReworkPreview } from '@/lib/types';
import { Button } from './ui/button';
import { Text } from './ui/text';

const TIME_LABEL = { morning: '☀️ Morning', afternoon: '⛅ Afternoon', evening: '🌙 Evening' } as const;

interface ReworkSheetProps {
  visible: boolean;
  title: string;
  icon: keyof typeof Ionicons.glyphMap;
  /** null while the new plan is being prepared. */
  preview: ReworkPreview | null;
  /** Current versions of the days, to show before → after. */
  current: ItineraryDay[];
  applying: boolean;
  error: string | null;
  onSwap: () => void;
  onKeep: () => void;
}

function DayList({ day, dim }: { day: ItineraryDay; dim?: boolean }) {
  const order = { morning: 0, afternoon: 1, evening: 2 } as const;
  const acts = day.activities.filter((a) => !a.placeholder).sort((a, b) => order[a.time_of_day] - order[b.time_of_day]);
  return (
    <View style={{ gap: 6, opacity: dim ? 0.55 : 1 }}>
      {acts.map((a) => (
        <View key={a.id} style={styles.actRow}>
          <Text variant="caption" color={Colors.muted} style={{ width: 88, fontSize: 11 }}>
            {TIME_LABEL[a.time_of_day] ?? a.time_of_day}
          </Text>
          <Text variant="caption" color={Colors.ink} style={{ flex: 1 }} numberOfLines={2}>
            {a.title}
            {a.indoor ? '  ☂︎' : ''}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** Shows a proposed day before it replaces the current one: Swap plan / Keep original. */
export function ReworkSheet({ visible, title, icon, preview, current, applying, error, onSwap, onKeep }: ReworkSheetProps) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onKeep}>
      <Pressable style={styles.backdrop} onPress={applying ? undefined : onKeep}>
        <Pressable style={styles.sheet} onPress={() => {}}>
          <View style={styles.head}>
            <View style={styles.icon}>
              <Ionicons name={icon} size={20} color={Colors.white} />
            </View>
            <Text variant="h3" style={{ flex: 1 }}>
              {title}
            </Text>
          </View>

          {error ? (
            <View style={{ gap: 12 }}>
              <Text variant="body" color={Colors.danger}>
                {error}
              </Text>
              <Button title="Close" variant="outline" onPress={onKeep} />
            </View>
          ) : !preview ? (
            <View style={styles.loading}>
              <ActivityIndicator color={Colors.primary} />
              <Text variant="caption" color={Colors.inkSoft}>
                Preparing a new plan…
              </Text>
            </View>
          ) : (
            <Animated.View entering={FadeIn} style={{ gap: 12, flexShrink: 1 }}>
              {!!preview.reply && (
                <Text variant="caption" color={Colors.inkSoft}>
                  {preview.reply}
                </Text>
              )}
              <ScrollView style={{ maxHeight: 380 }} contentContainerStyle={{ gap: 14 }}>
                {preview.days.map((nd) => {
                  const old = current.find((d) => d.day_number === nd.day_number);
                  return (
                    <View key={nd.day_number} style={{ gap: 8 }}>
                      <Text variant="label">
                        Day {nd.day_number} · {formatDate(nd.date, { weekday: 'short', day: 'numeric', month: 'short' })}
                      </Text>
                      {old && (
                        <View style={styles.box}>
                          <Text variant="overline" color={Colors.muted}>
                            Now
                          </Text>
                          <DayList day={old} dim />
                        </View>
                      )}
                      <View style={[styles.box, styles.newBox]}>
                        <Text variant="overline" color={Colors.primary}>
                          New plan · {nd.theme}
                        </Text>
                        <DayList day={nd} />
                      </View>
                    </View>
                  );
                })}
              </ScrollView>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Button title="Keep original" variant="outline" onPress={onKeep} disabled={applying} style={{ flex: 1 }} />
                <Button title="Swap plan" icon="swap-horizontal" onPress={onSwap} loading={applying} style={{ flex: 1 }} />
              </View>
            </Animated.View>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(8,16,28,0.45)', justifyContent: 'center', padding: 16 },
  sheet: { gap: 14, padding: 18, borderRadius: Radius.xxl, backgroundColor: Colors.surface, maxHeight: '88%', ...Shadow.raised },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  icon: { width: 38, height: 38, borderRadius: 12, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center' },
  loading: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 20, justifyContent: 'center' },
  box: { gap: 8, padding: 12, borderRadius: Radius.lg, backgroundColor: Colors.bg },
  newBox: { backgroundColor: Colors.primarySoft },
  actRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
});
