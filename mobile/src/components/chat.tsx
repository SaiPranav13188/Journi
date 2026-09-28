import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { forwardRef, useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Linking, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import Animated, {
  FadeIn,
  FadeInDown,
  FadeInUp,
  FadeOutDown,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { Colors, Fonts, Gradients, Radius, Shadow } from '@/constants/theme';
import { formatMoney } from '@/lib/format';
import type { ChatMessage, PlaceSuggestion, TimeOfDay } from '@/lib/types';
import { categoryIcon, PlacePhoto } from './place-photo';
import { PressableScale } from './ui/pressable-scale';
import { Text } from './ui/text';

function JourniAvatar({ size = 30 }: { size?: number }) {
  return (
    <LinearGradient colors={Gradients.brand} style={{ width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center' }}>
      <Ionicons name="paper-plane" size={size * 0.47} color={Colors.white} />
    </LinearGradient>
  );
}

function Dot({ delay }: { delay: number }) {
  const y = useSharedValue(0);
  useEffect(() => {
    y.set(withDelay(delay, withRepeat(withSequence(withTiming(-5, { duration: 280 }), withTiming(0, { duration: 280 })), -1)));
  }, [delay, y]);
  const style = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));
  return <Animated.View style={[styles.dot, style]} />;
}

export function TypingIndicator() {
  return (
    <Animated.View entering={FadeInDown.duration(250)} style={styles.rowLeft}>
      <JourniAvatar />
      <View style={[styles.bubble, styles.assistantBubble, styles.typing]}>
        <Dot delay={0} />
        <Dot delay={140} />
        <Dot delay={280} />
      </View>
    </Animated.View>
  );
}

function timeLabel(iso: string) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

// ------------------------------------------------------------ suggestions

export function Stars({ rating, size = 13 }: { rating: number; size?: number }) {
  return (
    <View style={{ flexDirection: 'row', gap: 1 }}>
      {[1, 2, 3, 4, 5].map((i) => (
        <Ionicons
          key={i}
          name={rating >= i - 0.25 ? 'star' : rating >= i - 0.75 ? 'star-half' : 'star-outline'}
          size={size}
          color={Colors.gold}
        />
      ))}
    </View>
  );
}

export interface SuggestionActions {
  /** Adds the place to the given day and time slot. */
  onAdd: (dayNumber: number, suggestion: PlaceSuggestion, timeOfDay: TimeOfDay) => void;
  /** The slot the place was added to on that day, or null if not added. */
  addedSlot: (dayNumber: number, suggestion: PlaceSuggestion) => TimeOfDay | null;
  addingIds: Set<string>;
  canAdd: boolean;
}

const SLOTS: { key: TimeOfDay; label: string; icon: keyof typeof Ionicons.glyphMap; color: string }[] = [
  { key: 'morning', label: 'Morning', icon: 'sunny-outline', color: '#F59E0B' },
  { key: 'afternoon', label: 'Afternoon', icon: 'partly-sunny-outline', color: '#FF6B4A' },
  { key: 'evening', label: 'Evening', icon: 'moon-outline', color: '#6366F1' },
];
const slotLabel = (t: TimeOfDay) => SLOTS.find((x) => x.key === t)?.label ?? t;

function SuggestionCard({ item, dayNumber, index, actions }: { item: PlaceSuggestion; dayNumber: number; index: number; actions: SuggestionActions }) {
  const [picking, setPicking] = useState(false);
  const addedTo = actions.addedSlot(dayNumber, item);
  const adding = actions.addingIds.has(item.id);
  const isGoogle = item.rating_source === 'google';

  return (
    <Animated.View entering={FadeInDown.delay(index * 60).duration(300)} style={styles.card}>
      <View style={styles.cardRow}>
        <PlacePhoto uri={item.image_url} query={null} width={300} style={styles.thumb} fallbackIcon={categoryIcon(item.category)}>
          <View style={styles.rank}>
            <Text variant="overline" color={Colors.white} style={{ letterSpacing: 0, fontSize: 10 }}>
              #{index + 1}
            </Text>
          </View>
        </PlacePhoto>

        <View style={{ flex: 1, gap: 3 }}>
          <Text variant="title" numberOfLines={2} style={{ fontSize: 15, lineHeight: 20 }}>
            {item.name}
          </Text>
          {item.rating != null && (
            <View style={styles.ratingRow}>
              <Text variant="label" style={{ fontSize: 12 }}>
                {item.rating.toFixed(1)}
              </Text>
              <Stars rating={item.rating} size={11} />
              <Text variant="caption" color={Colors.muted} style={{ fontSize: 11 }}>
                {isGoogle ? (item.rating_count != null ? `(${item.rating_count.toLocaleString('en-IN')}) Google` : 'Google') : 'approx.'}
              </Text>
            </View>
          )}
          {!!item.description && (
            <Text variant="caption" color={Colors.inkSoft} numberOfLines={2} style={{ fontSize: 12, lineHeight: 16 }}>
              {item.description}
            </Text>
          )}
          <Text variant="caption" color={Colors.muted} numberOfLines={1} style={{ fontSize: 11 }}>
            {[item.price_label, item.estimated_cost_inr > 0 ? `~${formatMoney(item.estimated_cost_inr, 'INR')}` : 'Free', item.address]
              .filter(Boolean)
              .join('  ·  ')}
          </Text>
        </View>
      </View>

      {/* Actions */}
      {adding ? (
        <View style={[styles.addBtn, { opacity: 0.8 }]}>
          <ActivityIndicator size="small" color={Colors.white} />
          <Text variant="label" color={Colors.white}>
            Adding to Day {dayNumber}…
          </Text>
        </View>
      ) : addedTo ? (
        <View style={styles.cardActions}>
          <View style={[styles.addBtn, styles.addedBtn]}>
            <Ionicons name="checkmark-circle" size={17} color={Colors.success} />
            <Text variant="label" color={Colors.success}>
              Added · Day {dayNumber} {slotLabel(addedTo)}
            </Text>
          </View>
          {!!item.maps_url && <MapButton url={item.maps_url} name={item.name} />}
        </View>
      ) : picking ? (
        <Animated.View entering={FadeIn.duration(200)} style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text variant="caption" color={Colors.inkSoft}>
              Add to Day {dayNumber} in the…
            </Text>
            <PressableScale onPress={() => setPicking(false)} hitSlop={10} accessibilityLabel="Cancel">
              <Ionicons name="close" size={16} color={Colors.muted} />
            </PressableScale>
          </View>
          <View style={styles.slotRow}>
            {SLOTS.map((slot) => {
              const suggested = slot.key === item.time_of_day;
              return (
                <PressableScale
                  key={slot.key}
                  haptic
                  onPress={() => {
                    setPicking(false);
                    actions.onAdd(dayNumber, item, slot.key);
                  }}
                  style={[styles.slotBtn, suggested && { borderColor: slot.color, backgroundColor: `${slot.color}14` }]}
                  accessibilityLabel={`Add to ${slot.label}`}
                >
                  <Ionicons name={slot.icon} size={18} color={slot.color} />
                  <Text variant="label" style={{ fontSize: 12 }}>
                    {slot.label}
                  </Text>
                  {suggested && (
                    <Text variant="caption" color={slot.color} style={{ fontSize: 9, lineHeight: 11 }}>
                      suggested
                    </Text>
                  )}
                </PressableScale>
              );
            })}
          </View>
        </Animated.View>
      ) : (
        <View style={styles.cardActions}>
          <PressableScale
            haptic
            disabled={!actions.canAdd}
            onPress={() => setPicking(true)}
            style={[styles.addBtn, !actions.canAdd && { opacity: 0.5 }]}
          >
            <Ionicons name="add-circle" size={17} color={Colors.white} />
            <Text variant="label" color={Colors.white}>
              {actions.canAdd ? `Add to Day ${dayNumber}` : 'Reopen plan to add'}
            </Text>
          </PressableScale>
          {!!item.maps_url && <MapButton url={item.maps_url} name={item.name} />}
        </View>
      )}
    </Animated.View>
  );
}

function MapButton({ url, name }: { url: string; name: string }) {
  return (
    <PressableScale haptic onPress={() => Linking.openURL(url)} style={styles.mapBtn} accessibilityLabel={`Open ${name} in maps`}>
      <Ionicons name="map-outline" size={16} color={Colors.primary} />
      <Text variant="label" color={Colors.primary} style={{ fontSize: 12 }}>
        Map
      </Text>
    </PressableScale>
  );
}

// ------------------------------------------------------------ bubbles

/** Group chat: whose messages are "mine", and how to render a poll the agent created. */
export interface GroupChatOptions {
  myUserId: string;
  renderPoll: (pollId: string) => ReactNode;
}

function MemberAvatar({ name }: { name: string }) {
  return (
    <View style={styles.memberAvatar}>
      <Text variant="label" color={Colors.white} style={{ fontSize: 13 }}>
        {name.charAt(0).toUpperCase()}
      </Text>
    </View>
  );
}

export function ChatBubble({ message, onRetry, actions, group }: { message: ChatMessage; onRetry?: () => void; actions: SuggestionActions; group?: GroupChatOptions }) {
  const isUser = message.role === 'user';
  const suggestions = message.metadata?.type === 'suggestions' ? message.metadata : null;
  const pollId = message.metadata?.type === 'poll' ? message.metadata.poll_id : null;
  // In a group, other members' messages sit on the left with their name.
  const fromOther = Boolean(group && isUser && message.user_id && message.user_id !== group.myUserId);
  const mine = isUser && !fromOther;

  return (
    <View style={{ gap: 10 }}>
      <Animated.View entering={FadeInUp.duration(300)} style={mine ? styles.rowRight : styles.rowLeft}>
        {!isUser && <JourniAvatar />}
        {fromOther && <MemberAvatar name={message.author_name ?? '?'} />}
        <View style={{ maxWidth: '80%', alignItems: mine ? 'flex-end' : 'flex-start', gap: 4 }}>
          {fromOther && (
            <Text variant="caption" color={Colors.muted} style={{ fontSize: 11 }}>
              {message.author_name}
            </Text>
          )}
          <View style={[styles.bubble, mine ? styles.userBubble : fromOther ? styles.memberBubble : styles.assistantBubble, message.failed && { opacity: 0.6 }]}>
            <Text variant="body" color={mine ? Colors.white : Colors.ink}>
              {message.content}
            </Text>
          </View>
          {message.failed ? (
            <PressableScale onPress={onRetry} style={styles.retry}>
              <Ionicons name="refresh" size={13} color={Colors.danger} />
              <Text variant="caption" color={Colors.danger}>
                Not sent — tap to retry
              </Text>
            </PressableScale>
          ) : (
            <Text variant="caption" color={Colors.muted} style={{ fontSize: 11 }}>
              {message.pending ? 'Sending…' : timeLabel(message.created_at)}
            </Text>
          )}
        </View>
      </Animated.View>

      {suggestions && suggestions.items.length > 0 && (
        <View style={styles.suggestionList}>
          <View style={styles.suggestionHeader}>
            <Ionicons name={categoryIcon(suggestions.items[0]?.category)} size={15} color={Colors.primary} />
            <Text variant="overline" color={Colors.primary}>
              {suggestions.items.length} {suggestions.category} · Day {suggestions.day_number}
            </Text>
          </View>
          {suggestions.items.map((item, i) => (
            <SuggestionCard key={item.id} item={item} dayNumber={suggestions.day_number} index={i} actions={actions} />
          ))}
        </View>
      )}

      {pollId && group && <View style={styles.suggestionList}>{group.renderPoll(pollId)}</View>}
    </View>
  );
}

export function ChatThread({
  messages,
  typing,
  onRetry,
  actions,
  group,
}: {
  messages: ChatMessage[];
  typing: boolean;
  onRetry: (m: ChatMessage) => void;
  actions: SuggestionActions;
  group?: GroupChatOptions;
}) {
  return (
    <View style={{ gap: 14 }}>
      <Animated.View entering={FadeIn} style={styles.intro}>
        <Ionicons name={group ? 'people-outline' : 'chatbubbles-outline'} size={18} color={Colors.primary} />
        <Text variant="caption" color={Colors.inkSoft} style={{ flex: 1 }}>
          {group
            ? 'Everyone in the group can chat here. Journi balances what each person wants, starts a poll when you disagree, and keeps track of who paid for what.'
            : 'Ask for any change, or try “show me famous coffee shops near my Day 1 plan” — tap Add to put a place straight into your day.'}
        </Text>
      </Animated.View>
      {messages.map((m, i) => (
        <ChatBubble key={m.id ?? `${m.created_at}-${i}`} message={m} onRetry={() => onRetry(m)} actions={actions} group={group} />
      ))}
      {typing && <TypingIndicator />}
    </View>
  );
}

// ------------------------------------------------------------ quick prompts

export const SUGGESTIONS = [
  'Make it more relaxed',
  'Add a day trip nearby',
  'Cheaper options please',
  'More local food spots',
  'Add 1 more day',
  'Swap in something outdoorsy',
];

export function SuggestionChips({ onPick, disabled }: { onPick: (s: string) => void; disabled?: boolean }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}>
      {SUGGESTIONS.map((s, i) => (
        <Animated.View key={s} entering={FadeInDown.delay(i * 50).duration(300)}>
          <PressableScale haptic disabled={disabled} onPress={() => onPick(s)} style={styles.suggestion}>
            <Ionicons name="sparkles-outline" size={13} color={Colors.primary} />
            <Text variant="caption" color={Colors.primaryDark}>
              {s}
            </Text>
          </PressableScale>
        </Animated.View>
      ))}
    </ScrollView>
  );
}

const PLACE_CATEGORIES: { label: string; query: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { label: 'Coffee shops', query: 'famous coffee shops', icon: 'cafe-outline' },
  { label: 'Restaurants', query: 'famous restaurants', icon: 'restaurant-outline' },
  { label: 'Attractions', query: 'must-see attractions', icon: 'camera-outline' },
  { label: 'Street food', query: 'best street food spots', icon: 'fast-food-outline' },
  { label: 'Shopping', query: 'best shopping spots', icon: 'bag-handle-outline' },
  { label: 'Treks & adventure', query: 'treks and adventure activities', icon: 'trail-sign-outline' },
  { label: 'Nightlife', query: 'popular bars and nightlife', icon: 'moon-outline' },
];

/** Banner shown after tapping "Add places" on a day: quick categories for that day. */
export function DayFocusBar({
  dayNumber,
  theme,
  onPick,
  onClose,
  disabled,
}: {
  dayNumber: number;
  theme: string;
  onPick: (message: string) => void;
  onClose: () => void;
  disabled?: boolean;
}) {
  return (
    <Animated.View entering={FadeInDown.duration(250)} exiting={FadeOutDown.duration(150)} style={{ gap: 8 }}>
      <View style={styles.focusHeader}>
        <View style={styles.focusBadge}>
          <Text variant="overline" color={Colors.white} style={{ letterSpacing: 0.4 }}>
            Day {dayNumber}
          </Text>
        </View>
        <Text variant="caption" color={Colors.inkSoft} numberOfLines={1} style={{ flex: 1 }}>
          Find places to add · {theme}
        </Text>
        <PressableScale onPress={onClose} hitSlop={10} accessibilityLabel="Stop adding to this day">
          <Ionicons name="close" size={18} color={Colors.muted} />
        </PressableScale>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }}>
        {PLACE_CATEGORIES.map((c) => (
          <PressableScale
            key={c.label}
            haptic
            disabled={disabled}
            onPress={() => onPick(`Show me ${c.query} near my Day ${dayNumber} plan`)}
            style={[styles.suggestion, { borderColor: Colors.accentSoft }]}
          >
            <Ionicons name={c.icon} size={14} color={Colors.accent} />
            <Text variant="caption" color={Colors.ink}>
              {c.label}
            </Text>
          </PressableScale>
        ))}
      </ScrollView>
    </Animated.View>
  );
}

// ------------------------------------------------------------ composer

interface ComposerProps {
  onSend: (text: string) => void;
  sending: boolean;
  onFocus?: () => void;
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  /** Agentic chat: attach a photo (e.g. a menu or taxi quote for a price check). Hidden when omitted. */
  onAttach?: () => void;
  attachment?: { uri: string } | null;
  onClearAttachment?: () => void;
}

export const Composer = forwardRef<TextInput, ComposerProps>(function Composer(
  { onSend, sending, onFocus, value, onChangeText, placeholder, onAttach, attachment, onClearAttachment },
  ref,
) {
  const canSend = value.trim().length > 0 && !sending;
  const scale = useSharedValue(canSend ? 1 : 0.85);
  const [height, setHeight] = useState(44);

  useEffect(() => {
    scale.set(withSpring(canSend ? 1 : 0.85, { damping: 14 }));
  }, [canSend, scale]);
  const sendStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }], opacity: canSend ? 1 : 0.5 }));

  const send = () => {
    if (!canSend) return;
    onSend(value.trim());
  };

  return (
    <View style={{ gap: 8 }}>
      {attachment ? (
        <View style={styles.attachmentRow}>
          <Image source={{ uri: attachment.uri }} style={styles.attachmentThumb} />
          <Text variant="caption" color={Colors.inkSoft} style={{ flex: 1 }}>
            Photo attached — ask e.g. “Is this price fair?”
          </Text>
          {!sending && (
            <PressableScale haptic onPress={onClearAttachment} accessibilityLabel="Remove photo">
              <Ionicons name="close-circle" size={22} color={Colors.muted} />
            </PressableScale>
          )}
        </View>
      ) : null}
      <View style={styles.composer}>
        {onAttach && (
          <PressableScale haptic onPress={onAttach} disabled={sending} accessibilityLabel="Attach a photo" style={styles.attach}>
            <Ionicons name="camera-outline" size={20} color={Colors.primary} />
          </PressableScale>
        )}
        <TextInput
        ref={ref}
        value={value}
        onChangeText={onChangeText}
        onFocus={onFocus}
        placeholder={sending ? 'Journi is working on it…' : placeholder ?? 'Ask Journi to change anything…'}
        placeholderTextColor={Colors.muted}
        style={[styles.input, { height: Math.min(Math.max(44, height), 110) }]}
        multiline
        maxLength={1000}
        editable={!sending}
        onContentSizeChange={(e) => setHeight(e.nativeEvent.contentSize.height + 20)}
      />
      <Animated.View style={sendStyle}>
        <PressableScale haptic onPress={send} disabled={!canSend} accessibilityLabel="Send message" style={styles.send}>
          <LinearGradient colors={Gradients.sunset} style={styles.sendInner}>
            <Ionicons name={sending ? 'hourglass-outline' : 'arrow-up'} size={20} color={Colors.white} />
          </LinearGradient>
        </PressableScale>
      </Animated.View>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  rowLeft: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  rowRight: { flexDirection: 'row', justifyContent: 'flex-end' },
  bubble: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 20 },
  userBubble: { backgroundColor: Colors.primary, borderBottomRightRadius: 6 },
  memberBubble: { backgroundColor: Colors.primarySoft, borderBottomLeftRadius: 6 },
  memberAvatar: { width: 30, height: 30, borderRadius: 15, backgroundColor: Colors.accent, alignItems: 'center', justifyContent: 'center' },
  assistantBubble: { backgroundColor: Colors.surface, borderBottomLeftRadius: 6, ...Shadow.card },
  typing: { flexDirection: 'row', gap: 5, paddingVertical: 14 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: Colors.muted },
  retry: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  intro: { flexDirection: 'row', gap: 10, padding: 12, borderRadius: Radius.lg, backgroundColor: Colors.primarySoft },
  suggestionList: { marginLeft: 38, gap: 12 },
  suggestionHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  card: { padding: 10, gap: 10, borderRadius: Radius.lg, backgroundColor: Colors.surface, ...Shadow.card },
  cardRow: { flexDirection: 'row', gap: 10 },
  thumb: { width: 78, height: 78, borderRadius: Radius.md },
  rank: {
    position: 'absolute',
    top: 4,
    left: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: Radius.pill,
    backgroundColor: 'rgba(8,16,28,0.6)',
  },
  ratingRow: { flexDirection: 'row', alignItems: 'center', gap: 4, flexWrap: 'wrap' },
  cardActions: { flexDirection: 'row', gap: 8 },
  addBtn: {
    flex: 1,
    height: 36,
    borderRadius: Radius.pill,
    backgroundColor: Colors.primary,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  addedBtn: { backgroundColor: Colors.successSoft },
  mapBtn: {
    height: 36,
    paddingHorizontal: 12,
    borderRadius: Radius.pill,
    backgroundColor: Colors.primarySoft,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  slotRow: { flexDirection: 'row', gap: 8 },
  slotBtn: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
    paddingVertical: 8,
    borderRadius: Radius.md,
    borderWidth: 1.5,
    borderColor: Colors.border,
    backgroundColor: Colors.bg,
  },
  suggestion: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: Radius.pill,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.primarySoft,
  },
  focusHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16 },
  focusBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: Radius.pill, backgroundColor: Colors.accent },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 16 },
  input: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 12,
    borderRadius: 22,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    fontFamily: Fonts.medium,
    fontSize: 15,
    color: Colors.ink,
  },
  send: { width: 44, height: 44, borderRadius: 22 },
  attach: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  attachmentRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 16, padding: 8, borderRadius: Radius.lg, backgroundColor: Colors.surface },
  attachmentThumb: { width: 40, height: 40, borderRadius: Radius.md },
  sendInner: { flex: 1, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
});
