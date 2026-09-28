import { Ionicons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, TextInput, View } from 'react-native';
import Animated, {
  FadeIn,
  FadeInDown,
  FadeOut,
  LinearTransition,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { Colors, Fonts, Radius, Shadow } from '@/constants/theme';
import { formatDate, formatMoney } from '@/lib/format';
import type { Activity, ItineraryDay, TimeOfDay } from '@/lib/types';
import { categoryIcon, PlacePhoto } from './place-photo';
import { PressableScale } from './ui/pressable-scale';
import { Text } from './ui/text';
import { WarningBanner, WeatherChip, WeatherDetails } from './weather';

const TIME_META: Record<TimeOfDay, { label: string; icon: keyof typeof Ionicons.glyphMap; color: string }> = {
  morning: { label: 'Morning', icon: 'sunny-outline', color: '#F59E0B' },
  afternoon: { label: 'Afternoon', icon: 'partly-sunny-outline', color: '#FF6B4A' },
  evening: { label: 'Evening', icon: 'moon-outline', color: '#6366F1' },
};

interface DayCardProps {
  day: ItineraryDay;
  destinationLabel: string;
  expanded: boolean;
  onToggle: () => void;
  updated?: boolean;
  editable: boolean;
  onAccommodationChange: (note: string | null) => void;
  /** Opens the chat to find places to add to this day. */
  onAddPlaces: () => void;
  /** Removes a place (leaving an empty slot) or deletes an empty slot. */
  onRemoveActivity: (activity: Activity) => void;
  /** Looks up a typed place name and puts it into an empty slot. */
  onFillSlot: (activityId: string, query: string) => Promise<unknown>;
  /** Activity ids with an edit in progress. */
  busyIds: Set<string>;
  /** Toggles a place between Planned and Confirmed (booked). */
  onToggleStatus: (activity: Activity) => void;
  /** Offers an indoor alternative for a day with a weather warning. */
  onRainSwap?: () => void;
}

/** Empty slot left after removing a place: type a name and Journi finds it. */
function EmptySlot({
  activity,
  last,
  busy,
  editable,
  onFill,
  onDismiss,
}: {
  activity: Activity;
  last: boolean;
  busy: boolean;
  editable: boolean;
  onFill: (query: string) => Promise<unknown>;
  onDismiss: () => void;
}) {
  const time = TIME_META[activity.time_of_day] ?? TIME_META.morning;
  const [typing, setTyping] = useState(false);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState('');

  const submit = async () => {
    const q = query.trim();
    if (q.length < 2) return;
    setSearching(q);
    try {
      await onFill(q);
      setTyping(false);
      setQuery('');
    } catch (err) {
      Alert.alert('Couldn’t find that place', (err as Error).message);
    } finally {
      setSearching('');
    }
  };

  return (
    <Animated.View entering={FadeIn.duration(250)} style={styles.activity}>
      <View style={styles.timeline}>
        <View style={[styles.timeDot, { backgroundColor: Colors.surface, borderWidth: 1.5, borderColor: time.color }]}>
          <Ionicons name={time.icon} size={12} color={time.color} />
        </View>
        {!last && <View style={styles.timeLine} />}
      </View>
      <View style={{ flex: 1, paddingBottom: last ? 0 : 18 }}>
        <Text variant="overline" color={time.color} style={{ marginBottom: 6 }}>
          {time.label}
        </Text>
        {searching || busy ? (
          <View style={[styles.emptySlot, { borderStyle: 'solid' }]}>
            <ActivityIndicator color={Colors.primary} />
            <Text variant="caption" color={Colors.inkSoft} style={{ flex: 1 }}>
              {searching ? `Searching the web for “${searching}”…` : 'Updating…'}
            </Text>
          </View>
        ) : typing ? (
          <Animated.View entering={FadeIn.duration(200)} style={[styles.emptySlot, { borderStyle: 'solid', borderColor: Colors.primary }]}>
            <Ionicons name="search" size={17} color={Colors.primary} />
            <TextInput
              autoFocus
              value={query}
              onChangeText={setQuery}
              onSubmitEditing={submit}
              placeholder="Type a place, e.g. Artjuna Cafe"
              placeholderTextColor={Colors.muted}
              returnKeyType="search"
              style={styles.slotInput}
              maxLength={120}
            />
            <PressableScale haptic onPress={submit} disabled={query.trim().length < 2} style={[styles.slotGo, query.trim().length < 2 && { opacity: 0.4 }]} accessibilityLabel="Find place">
              <Ionicons name="arrow-forward" size={16} color={Colors.white} />
            </PressableScale>
            <PressableScale onPress={() => setTyping(false)} hitSlop={8} accessibilityLabel="Cancel">
              <Ionicons name="close" size={18} color={Colors.muted} />
            </PressableScale>
          </Animated.View>
        ) : (
          <View style={styles.emptySlot}>
            <PressableScale haptic disabled={!editable} onPress={() => setTyping(true)} style={styles.slotAdd}>
              <View style={styles.slotPlus}>
                <Ionicons name="add" size={18} color={Colors.white} />
              </View>
              <View style={{ flex: 1 }}>
                <Text variant="label" color={Colors.primaryDark}>
                  Add a place here
                </Text>
                {!!activity.removed_title && (
                  <Text variant="caption" color={Colors.muted} numberOfLines={1} style={{ fontSize: 11 }}>
                    Removed: {activity.removed_title}
                  </Text>
                )}
              </View>
            </PressableScale>
            {editable && (
              <PressableScale onPress={onDismiss} hitSlop={8} accessibilityLabel="Delete empty slot">
                <Ionicons name="trash-outline" size={17} color={Colors.muted} />
              </PressableScale>
            )}
          </View>
        )}
      </View>
    </Animated.View>
  );
}

function ActivityItem({
  activity,
  destinationLabel,
  last,
  editable,
  busy,
  onRemove,
  onToggleStatus,
}: {
  activity: Activity;
  destinationLabel: string;
  last: boolean;
  editable: boolean;
  busy: boolean;
  onRemove: () => void;
  onToggleStatus: () => void;
}) {
  const confirmed = activity.status === 'confirmed';
  const time = TIME_META[activity.time_of_day] ?? TIME_META.morning;
  const query = activity.image_url ? null : activity.place_name ? `${activity.place_name}, ${destinationLabel}` : null;
  const hasPhoto = Boolean(activity.image_url || query);
  return (
    <View style={styles.activity}>
      <View style={styles.timeline}>
        <View style={[styles.timeDot, { backgroundColor: time.color }]}>
          <Ionicons name={time.icon} size={12} color={Colors.white} />
        </View>
        {!last && <View style={styles.timeLine} />}
      </View>
      <View style={{ flex: 1, paddingBottom: last ? 0 : 18 }}>
        <View style={styles.slotHeader}>
          <Text variant="overline" color={time.color} style={{ flex: 1 }}>
            {time.label}
          </Text>
          <PressableScale
            haptic
            disabled={!editable || busy}
            onPress={onToggleStatus}
            hitSlop={6}
            style={[styles.statusChip, confirmed ? styles.statusConfirmed : styles.statusPlanned]}
            accessibilityLabel={confirmed ? 'Mark as planned' : 'Mark as confirmed'}
          >
            <Ionicons name={confirmed ? 'checkmark-circle' : 'ellipse-outline'} size={12} color={confirmed ? Colors.success : Colors.muted} />
            <Text variant="caption" color={confirmed ? Colors.success : Colors.muted} style={{ fontSize: 11 }}>
              {confirmed ? 'Confirmed' : 'Planned'}
            </Text>
          </PressableScale>
          {editable &&
            (busy ? (
              <ActivityIndicator size="small" color={Colors.danger} />
            ) : (
              <PressableScale haptic onPress={onRemove} hitSlop={8} style={styles.removeBtn} accessibilityLabel={`Remove ${activity.title}`}>
                <Ionicons name="trash-outline" size={13} color={Colors.danger} />
                <Text variant="caption" color={Colors.danger} style={{ fontSize: 12 }}>
                  Remove
                </Text>
              </PressableScale>
            ))}
        </View>
        <View style={[styles.activityCard, busy && { opacity: 0.5 }]}>
          {hasPhoto && (
            <PlacePhoto uri={activity.image_url} query={query} width={700} style={styles.activityPhoto} fallbackIcon={categoryIcon(activity.category)} />
          )}
          <View style={{ padding: 12, gap: 4 }}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
              {!hasPhoto && (
                <View style={styles.catIcon}>
                  <Ionicons name={categoryIcon(activity.category)} size={16} color={Colors.primary} />
                </View>
              )}
              <Text variant="title" style={{ flex: 1 }}>
                {activity.title}
              </Text>
            </View>
            {(activity.rating != null || activity.added_by_user || activity.source_suggestion_id) && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                {activity.rating != null && (
                  <>
                    <Ionicons name="star" size={13} color={Colors.gold} />
                    <Text variant="label" style={{ fontSize: 12 }}>
                      {activity.rating.toFixed(1)}
                    </Text>
                    <Text variant="caption" color={Colors.muted} style={{ fontSize: 11 }}>
                      {activity.rating_source === 'google'
                        ? `${activity.rating_count != null ? `(${activity.rating_count.toLocaleString('en-IN')}) ` : ''}Google`
                        : 'approx.'}
                    </Text>
                  </>
                )}
                {(activity.added_by_user || activity.source_suggestion_id) && (
                  <View style={styles.addedTag}>
                    <Text variant="overline" color={Colors.accent} style={{ fontSize: 9, letterSpacing: 0.4 }}>
                      Added by you
                    </Text>
                  </View>
                )}
              </View>
            )}
            {!!activity.description && (
              <Text variant="caption" color={Colors.inkSoft}>
                {activity.description}
              </Text>
            )}
            <View style={styles.activityMeta}>
              {activity.place_name && (
                <View style={styles.metaItem}>
                  <Ionicons name="location-outline" size={13} color={Colors.muted} />
                  <Text variant="caption" color={Colors.muted} numberOfLines={1} style={{ maxWidth: 170 }}>
                    {activity.place_name}
                  </Text>
                </View>
              )}
              {activity.duration_hours != null && (
                <View style={styles.metaItem}>
                  <Ionicons name="time-outline" size={13} color={Colors.muted} />
                  <Text variant="caption" color={Colors.muted}>
                    {activity.duration_hours < 1 ? `${Math.round(activity.duration_hours * 60)} min` : `${activity.duration_hours} h`}
                  </Text>
                </View>
              )}
              <View style={styles.metaItem}>
                <Ionicons name="ticket-outline" size={13} color={Colors.muted} />
                <Text variant="caption" color={Colors.muted}>
                  {activity.estimated_cost_inr > 0 ? formatMoney(activity.estimated_cost_inr, 'INR') : 'Free'}
                </Text>
              </View>
              {activity.indoor && (
                <View style={[styles.metaItem, styles.indoorTag]}>
                  <Ionicons name="umbrella-outline" size={12} color={Colors.primary} />
                  <Text variant="caption" color={Colors.primary} style={{ fontSize: 11 }}>
                    Indoor
                  </Text>
                </View>
              )}
            </View>
          </View>
        </View>
      </View>
    </View>
  );
}

export function DayCard({
  day,
  destinationLabel,
  expanded,
  onToggle,
  updated,
  editable,
  onAccommodationChange,
  onAddPlaces,
  onRemoveActivity,
  onFillSlot,
  busyIds,
  onToggleStatus,
  onRainSwap,
}: DayCardProps) {
  const [note, setNote] = useState(day.accommodation_note ?? '');
  const [syncedNote, setSyncedNote] = useState(day.accommodation_note);
  const flash = useSharedValue(0);

  // Pick up external changes to the note (e.g. after a save round-trip).
  if (day.accommodation_note !== syncedNote) {
    setSyncedNote(day.accommodation_note);
    setNote(day.accommodation_note ?? '');
  }

  // Briefly glow the card when the AI changes this day.
  useEffect(() => {
    if (updated) flash.set(withSequence(withTiming(1, { duration: 300 }), withTiming(0, { duration: 1400 })));
  }, [updated, flash]);
  const flashStyle = useAnimatedStyle(() => ({
    borderColor: flash.value > 0.01 ? `rgba(255,107,74,${flash.value})` : 'transparent',
  }));

  const order: TimeOfDay[] = ['morning', 'afternoon', 'evening'];
  const activities = [...day.activities].sort((a, b) => order.indexOf(a.time_of_day) - order.indexOf(b.time_of_day));
  const thumbs = activities.filter((a) => a.place_name && !a.placeholder).slice(0, 3);
  const commitNote = () => {
    const trimmed = note.trim();
    if (trimmed !== (day.accommodation_note ?? '')) onAccommodationChange(trimmed || null);
  };

  return (
    <Animated.View layout={LinearTransition.springify().damping(18)} style={[styles.card, flashStyle]}>
      <PressableScale onPress={onToggle} scaleTo={0.99} haptic style={styles.header}>
        <View style={styles.dayBadge}>
          <Text variant="overline" color={Colors.primary} style={{ fontSize: 10 }}>
            Day
          </Text>
          <Text variant="h3" color={Colors.primary} style={{ fontFamily: Fonts.extrabold, lineHeight: 22 }}>
            {day.day_number}
          </Text>
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text variant="caption" color={Colors.muted}>
              {formatDate(day.date, { weekday: 'short', day: 'numeric', month: 'short' })}
            </Text>
            {updated && (
              <Animated.View entering={FadeIn} style={styles.updatedTag}>
                <Text variant="overline" color={Colors.accent} style={{ fontSize: 9, letterSpacing: 0.5 }}>
                  Updated
                </Text>
              </Animated.View>
            )}
          </View>
          <Text variant="title" numberOfLines={expanded ? undefined : 2}>
            {day.theme}
          </Text>
        </View>
        <View style={{ alignItems: 'flex-end', gap: 8 }}>
          <WeatherChip weather={day.weather_summary} />
          <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={18} color={Colors.muted} />
        </View>
      </PressableScale>

      {/* The warning is always visible on the card, even when collapsed. */}
      {day.weather_warning && (
        <View style={{ paddingHorizontal: 14, paddingBottom: expanded ? 0 : 14 }}>
          <WarningBanner warning={day.weather_warning} />
          {onRainSwap && (
            <PressableScale haptic onPress={onRainSwap} style={styles.rainSwap} accessibilityLabel="Get an indoor plan for this day">
              <Ionicons name="umbrella" size={16} color={Colors.white} />
              <Text variant="label" color={Colors.white} style={{ fontSize: 13 }}>
                Get indoor plan
              </Text>
            </PressableScale>
          )}
        </View>
      )}

      {!expanded && thumbs.length > 0 && !day.weather_warning && (
        <Animated.View entering={FadeIn} exiting={FadeOut.duration(120)} style={styles.thumbRow}>
          {thumbs.map((a) => (
            <PlacePhoto key={a.id} query={`${a.place_name}, ${destinationLabel}`} width={400} style={styles.thumb} fallbackIcon={categoryIcon(a.category)} />
          ))}
          <Text variant="caption" color={Colors.muted} style={{ marginLeft: 4 }}>
            {activities.filter((a) => !a.placeholder).length} activities
          </Text>
        </Animated.View>
      )}

      {expanded && (
        <Animated.View entering={FadeInDown.duration(280)} style={styles.body}>
          <WeatherDetails weather={day.weather_summary} />

          <View>
            {activities.map((a, i) => (
              a.placeholder ? (
                <EmptySlot
                  key={a.id}
                  activity={a}
                  last={i === activities.length - 1}
                  busy={busyIds.has(a.id)}
                  editable={editable}
                  onFill={(q) => onFillSlot(a.id, q)}
                  onDismiss={() => onRemoveActivity(a)}
                />
              ) : (
                <ActivityItem
                  key={a.id ?? `${a.title}-${i}`}
                  activity={a}
                  destinationLabel={destinationLabel}
                  last={i === activities.length - 1}
                  editable={editable}
                  busy={busyIds.has(a.id)}
                  onRemove={() => onRemoveActivity(a)}
                  onToggleStatus={() => onToggleStatus(a)}
                />
              )
            ))}
          </View>

          {day.meal_suggestion && (
            <View style={styles.meal}>
              <PlacePhoto query={day.meal_suggestion.dish} width={400} style={styles.mealPhoto} fallbackIcon="restaurant" />
              <View style={{ flex: 1, gap: 2 }}>
                <Text variant="overline" color={Colors.accent}>
                  Must-try food
                </Text>
                <Text variant="title">{day.meal_suggestion.dish}</Text>
                {!!day.meal_suggestion.where && (
                  <Text variant="caption" color={Colors.inkSoft}>
                    📍 {day.meal_suggestion.where}
                  </Text>
                )}
                {!!day.meal_suggestion.description && (
                  <Text variant="caption" color={Colors.muted}>
                    {day.meal_suggestion.description}
                  </Text>
                )}
                {day.meal_suggestion.estimated_cost_inr > 0 && (
                  <Text variant="label" color={Colors.primary}>
                    ~{formatMoney(day.meal_suggestion.estimated_cost_inr, 'INR')}
                  </Text>
                )}
              </View>
            </View>
          )}

          <View style={styles.stay}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Ionicons name="bed-outline" size={18} color={Colors.primary} />
              <Text variant="label">Where you’re staying tonight</Text>
              <Text variant="caption" color={Colors.muted}>
                (optional)
              </Text>
            </View>
            <TextInput
              value={note}
              onChangeText={setNote}
              onBlur={commitNote}
              onSubmitEditing={commitNote}
              editable={editable}
              placeholder="Hotel name, address or a note like “Airbnb near city centre”"
              placeholderTextColor={Colors.muted}
              style={styles.stayInput}
              multiline
              maxLength={500}
              blurOnSubmit
              returnKeyType="done"
            />
          </View>
        </Animated.View>
      )}

      {editable && (
        <PressableScale haptic onPress={onAddPlaces} style={styles.addPlaces} accessibilityLabel={`Add places to Day ${day.day_number}`}>
          <View style={styles.addIcon}>
            <Ionicons name="add" size={18} color={Colors.white} />
          </View>
          <View style={{ flex: 1 }}>
            <Text variant="label" color={Colors.primaryDark}>
              Add places to Day {day.day_number}
            </Text>
            <Text variant="caption" color={Colors.muted} style={{ fontSize: 12 }}>
              Cafés, restaurants, attractions nearby — with photos & ratings
            </Text>
          </View>
          <Ionicons name="chatbubbles-outline" size={18} color={Colors.primary} />
        </PressableScale>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: Radius.xl, backgroundColor: Colors.surface, borderWidth: 1.5, borderColor: 'transparent', ...Shadow.card },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  dayBadge: {
    width: 52,
    height: 56,
    borderRadius: Radius.lg,
    backgroundColor: Colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  updatedTag: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: Radius.pill, backgroundColor: Colors.accentSoft },
  thumbRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingBottom: 14 },
  thumb: { width: 54, height: 40, borderRadius: Radius.sm },
  body: { paddingHorizontal: 14, paddingBottom: 16, paddingTop: 12, gap: 16 },
  activity: { flexDirection: 'row', gap: 12 },
  timeline: { width: 24, alignItems: 'center' },
  timeDot: { width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  timeLine: { flex: 1, width: 2, backgroundColor: Colors.border, marginTop: 4 },
  activityCard: { borderRadius: Radius.lg, backgroundColor: Colors.bg, overflow: 'hidden' },
  activityPhoto: { height: 130 },
  catIcon: { width: 28, height: 28, borderRadius: 8, backgroundColor: Colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  activityMeta: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 4 },
  metaItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  indoorTag: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: Radius.pill, backgroundColor: Colors.primarySoft },
  meal: { flexDirection: 'row', gap: 12, padding: 12, borderRadius: Radius.lg, backgroundColor: Colors.accentSoft },
  mealPhoto: { width: 84, height: 84, borderRadius: Radius.md },
  addedTag: { marginLeft: 4, paddingHorizontal: 6, paddingVertical: 1, borderRadius: Radius.pill, backgroundColor: Colors.accentSoft },
  addPlaces: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 14,
    marginBottom: 14,
    padding: 10,
    borderRadius: Radius.lg,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: Colors.primary,
    backgroundColor: Colors.primarySoft,
  },
  addIcon: { width: 32, height: 32, borderRadius: 16, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center' },
  rainSwap: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 8,
    height: 38,
    borderRadius: Radius.pill,
    backgroundColor: Colors.warning,
  },
  slotHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 6 },
  statusChip: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: Radius.pill },
  statusConfirmed: { backgroundColor: Colors.successSoft },
  statusPlanned: { backgroundColor: Colors.surfaceAlt },
  removeBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: Radius.pill,
    backgroundColor: Colors.dangerSoft,
  },
  emptySlot: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 58,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: Radius.lg,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    borderColor: Colors.border,
    backgroundColor: Colors.bg,
  },
  slotAdd: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  slotPlus: { width: 32, height: 32, borderRadius: 16, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center' },
  slotInput: { flex: 1, height: 40, fontFamily: Fonts.medium, fontSize: 14, color: Colors.ink },
  slotGo: { width: 32, height: 32, borderRadius: 16, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center' },
  stay: { gap: 8, padding: 12, borderRadius: Radius.lg, borderWidth: 1, borderColor: Colors.border, borderStyle: 'dashed' },
  stayInput: {
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: Radius.md,
    backgroundColor: Colors.bg,
    fontFamily: Fonts.medium,
    fontSize: 14,
    color: Colors.ink,
  },
});
