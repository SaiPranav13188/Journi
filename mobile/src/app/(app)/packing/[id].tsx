import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import Animated, { FadeInDown, useAnimatedStyle, withTiming } from 'react-native-reanimated';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { PressableScale } from '@/components/ui/pressable-scale';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { Colors, Fonts, Radius, Shadow } from '@/constants/theme';
import { api } from '@/lib/api';
import { loadDraft } from '@/lib/draft';
import { loadPacking, savePacking, type PackingState } from '@/lib/packing';

const CATEGORY_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  'documents & money': 'card-outline',
  clothes: 'shirt-outline',
  footwear: 'footsteps-outline',
  toiletries: 'water-outline',
  'health & safety': 'medkit-outline',
  electronics: 'phone-portrait-outline',
  'activity gear': 'trail-sign-outline',
  extras: 'sparkles-outline',
};

/** Smart packing list for a trip — built from its forecast and plan, saved on the phone. */
export default function PackingScreen() {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const insets = useSafeAreaInsets();
  const [state, setState] = useState<PackingState | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newItem, setNewItem] = useState('');

  const update = useCallback(
    (next: PackingState) => {
      setState(next);
      savePacking(id, next);
    },
    [id],
  );

  const generate = useCallback(async () => {
    setGenerating(true);
    setError(null);
    try {
      const draft = id === 'draft' ? await loadDraft() : null;
      const list = await api.packingList({
        tripId: id === 'draft' ? null : id,
        state: draft ? { trip: draft.trip, days: draft.days, budget: draft.budget } : undefined,
      });
      setState((prev) => {
        const next: PackingState = { list, checked: prev?.checked ?? {}, custom: prev?.custom ?? [] };
        savePacking(id, next);
        return next;
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setGenerating(false);
    }
  }, [id]);

  useEffect(() => {
    let active = true;
    loadPacking(id).then((saved) => {
      if (!active) return;
      setLoading(false);
      if (saved) setState(saved);
      else generate();
    });
    return () => {
      active = false;
    };
  }, [id, generate]);

  const allItems = state ? [...state.list.categories.flatMap((c) => c.items.map((i) => i.id)), ...state.custom.map((c) => c.id)] : [];
  const packed = allItems.filter((i) => state?.checked[i]).length;
  const pct = allItems.length ? packed / allItems.length : 0;
  const barStyle = useAnimatedStyle(() => ({ width: withTiming(`${pct * 100}%`, { duration: 400 }) }));

  const toggle = (itemId: string) => {
    if (!state) return;
    Haptics.selectionAsync().catch(() => {});
    update({ ...state, checked: { ...state.checked, [itemId]: !state.checked[itemId] } });
  };

  const addCustom = () => {
    const name = newItem.trim();
    if (!name || !state) return;
    update({ ...state, custom: [...state.custom, { id: `custom-${Date.now()}`, name }] });
    setNewItem('');
  };

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: Colors.bg }}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <IconButton icon="chevron-back" onPress={() => router.back()} accessibilityLabel="Back" />
        <View style={{ flex: 1 }}>
          <Text variant="h2">Packing list</Text>
          {!!name && (
            <Text variant="caption" color={Colors.muted}>
              {name} · built from your plan & forecast
            </Text>
          )}
        </View>
      </View>

      {loading || (generating && !state) ? (
        <View style={{ padding: 20, gap: 12 }}>
          <Text variant="caption" color={Colors.inkSoft}>
            Checking your forecast and activities…
          </Text>
          {[80, 140, 120, 100].map((h, i) => (
            <Skeleton key={i} height={h} radius={Radius.xl} />
          ))}
        </View>
      ) : error && !state ? (
        <View style={[styles.card, { margin: 20, alignItems: 'center' }]}>
          <Text variant="body" color={Colors.inkSoft} center>
            {error}
          </Text>
          <Button title="Try again" variant="secondary" size="sm" onPress={generate} />
        </View>
      ) : state ? (
        <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 40, gap: 16 }} keyboardShouldPersistTaps="handled">
          <View style={styles.card}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text variant="label">
                {packed} of {allItems.length} packed
              </Text>
              <Text variant="label" color={Colors.primary}>
                {Math.round(pct * 100)}%
              </Text>
            </View>
            <View style={styles.track}>
              <Animated.View style={[styles.fill, barStyle]} />
            </View>
            {pct === 1 && (
              <Text variant="caption" color={Colors.success}>
                All packed — have a great trip! 🎒
              </Text>
            )}
          </View>

          {state.list.categories.map((c, ci) => {
            const done = c.items.filter((i) => state.checked[i.id]).length;
            return (
              <Animated.View key={c.name} entering={FadeInDown.delay(ci * 50).duration(350)} style={styles.card}>
                <View style={styles.catHead}>
                  <Ionicons name={CATEGORY_ICONS[c.name.toLowerCase()] ?? 'bag-outline'} size={18} color={Colors.primary} />
                  <Text variant="h3" style={{ flex: 1 }}>
                    {c.name}
                  </Text>
                  <Text variant="caption" color={Colors.muted}>
                    {done}/{c.items.length}
                  </Text>
                </View>
                {c.items.map((item) => {
                  const checked = !!state.checked[item.id];
                  return (
                    <PressableScale key={item.id} onPress={() => toggle(item.id)} scaleTo={0.98} style={styles.itemRow}>
                      <Ionicons name={checked ? 'checkbox' : 'square-outline'} size={22} color={checked ? Colors.success : Colors.muted} />
                      <View style={{ flex: 1 }}>
                        <Text variant="body" color={checked ? Colors.muted : Colors.ink} style={checked ? styles.done : undefined}>
                          {item.name}
                          {item.essential && !checked ? <Text variant="caption" color={Colors.accent}>{'  '}must-have</Text> : null}
                        </Text>
                        {!!item.reason && (
                          <Text variant="caption" color={Colors.muted} style={{ fontSize: 12 }}>
                            {item.reason}
                          </Text>
                        )}
                      </View>
                    </PressableScale>
                  );
                })}
              </Animated.View>
            );
          })}

          <View style={styles.card}>
            <View style={styles.catHead}>
              <Ionicons name="add-circle-outline" size={18} color={Colors.primary} />
              <Text variant="h3" style={{ flex: 1 }}>
                My items
              </Text>
            </View>
            {state.custom.map((item) => {
              const checked = !!state.checked[item.id];
              return (
                <View key={item.id} style={styles.itemRow}>
                  <PressableScale onPress={() => toggle(item.id)} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 }}>
                    <Ionicons name={checked ? 'checkbox' : 'square-outline'} size={22} color={checked ? Colors.success : Colors.muted} />
                    <Text variant="body" color={checked ? Colors.muted : Colors.ink} style={[{ flex: 1 }, checked ? styles.done : undefined]}>
                      {item.name}
                    </Text>
                  </PressableScale>
                  <PressableScale
                    onPress={() => update({ ...state, custom: state.custom.filter((x) => x.id !== item.id) })}
                    hitSlop={8}
                    accessibilityLabel={`Remove ${item.name}`}
                  >
                    <Ionicons name="close" size={18} color={Colors.muted} />
                  </PressableScale>
                </View>
              );
            })}
            <View style={styles.addRow}>
              <TextInput
                value={newItem}
                onChangeText={setNewItem}
                onSubmitEditing={addCustom}
                placeholder="Add your own item"
                placeholderTextColor={Colors.muted}
                style={styles.addInput}
                returnKeyType="done"
                maxLength={80}
              />
              <PressableScale haptic onPress={addCustom} disabled={!newItem.trim()} style={[styles.addBtn, !newItem.trim() && { opacity: 0.4 }]}>
                <Ionicons name="add" size={20} color={Colors.white} />
              </PressableScale>
            </View>
          </View>

          <Button
            title={generating ? 'Rebuilding…' : 'Rebuild from latest plan & forecast'}
            icon="refresh"
            variant="secondary"
            loading={generating}
            onPress={() =>
              Alert.alert('Rebuild packing list?', 'We’ll use your latest plan and forecast. Your ticks and own items are kept.', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Rebuild', onPress: generate },
              ])
            }
            fullWidth
          />
        </ScrollView>
      ) : null}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingBottom: 8 },
  card: { gap: 10, padding: 16, borderRadius: Radius.xl, backgroundColor: Colors.surface, ...Shadow.card },
  track: { height: 8, borderRadius: 4, backgroundColor: Colors.surfaceAlt, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 4, backgroundColor: Colors.success },
  catHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  itemRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 4 },
  done: { textDecorationLine: 'line-through' },
  addRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  addInput: {
    flex: 1,
    height: 44,
    paddingHorizontal: 14,
    borderRadius: Radius.md,
    backgroundColor: Colors.bg,
    fontFamily: Fonts.medium,
    fontSize: 15,
    color: Colors.ink,
  },
  addBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center' },
});
