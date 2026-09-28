import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useState } from 'react';
import { ActivityIndicator, Alert, Share, StyleSheet, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { Colors, Radius, Shadow } from '@/constants/theme';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import type { ExpenseCategory, GroupDetails, GroupMember, GroupPoll, MemberPreferences, Pace } from '@/lib/types';
import { Button } from './ui/button';
import { PressableScale } from './ui/pressable-scale';
import { Skeleton } from './ui/skeleton';
import { Text } from './ui/text';
import { TextField } from './ui/text-field';

const INTERESTS = ['beaches', 'food', 'museums', 'history', 'nature', 'hiking', 'nightlife', 'shopping', 'adventure', 'relaxation', 'photography', 'culture'];
const PACES: { key: Pace; label: string }[] = [
  { key: 'relaxed', label: 'Relaxed' },
  { key: 'balanced', label: 'Balanced' },
  { key: 'packed', label: 'Packed' },
];
const CATEGORIES: { key: ExpenseCategory; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { key: 'stay', label: 'Stay', icon: 'bed-outline' },
  { key: 'food', label: 'Food', icon: 'restaurant-outline' },
  { key: 'transport', label: 'Transport', icon: 'car-outline' },
  { key: 'activity', label: 'Activity', icon: 'ticket-outline' },
  { key: 'shopping', label: 'Shopping', icon: 'bag-outline' },
  { key: 'other', label: 'Other', icon: 'ellipsis-horizontal' },
];
const inr = (n: number) => formatMoney(n, 'INR');

function Card({ title, icon, children, right }: { title: string; icon: keyof typeof Ionicons.glyphMap; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Ionicons name={icon} size={17} color={Colors.primary} />
        <Text variant="title" style={{ flex: 1, fontSize: 16 }}>
          {title}
        </Text>
        {right}
      </View>
      {children}
    </View>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <PressableScale haptic onPress={onPress} style={[styles.chip, active && styles.chipActive]}>
      <Text variant="label" color={active ? Colors.white : Colors.inkSoft} style={{ fontSize: 13 }}>
        {label}
      </Text>
    </PressableScale>
  );
}

function Avatar({ name, size = 34 }: { name: string; size?: number }) {
  return (
    <View style={[styles.avatar, { width: size, height: size, borderRadius: size / 2 }]}>
      <Text variant="label" color={Colors.white} style={{ fontSize: size * 0.42 }}>
        {name.charAt(0).toUpperCase()}
      </Text>
    </View>
  );
}

function prefSummary(p: MemberPreferences) {
  return [
    p.interests?.length ? p.interests.slice(0, 4).join(', ') : null,
    p.pace ? `${p.pace} pace` : null,
    p.budget_per_person_inr ? `≤ ${inr(p.budget_per_person_inr)}` : null,
    p.dietary || null,
  ]
    .filter(Boolean)
    .join(' · ');
}

// ------------------------------------------------------------ polls (also used in chat)

export function PollCard({ poll, tripId, myUserId, members, onChanged }: { poll: GroupPoll; tripId: string; myUserId: string; members: GroupMember[]; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const mine = poll.votes.find((v) => v.user_id === myUserId)?.option_id ?? null;
  const counts = poll.live.counts;
  const total = Math.max(1, poll.votes.length);
  const waitingOn = members.filter((m) => !poll.votes.some((v) => v.user_id === m.user_id)).map((m) => m.display_name);
  const winner = poll.status === 'closed' ? poll.result?.winner_label ?? null : null;

  const castVote = async (optionId: string) => {
    setBusy(optionId);
    try {
      await api.groups.vote(tripId, poll.id, optionId);
      onChanged();
    } catch (err) {
      Alert.alert('Couldn’t vote', (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={styles.poll}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Ionicons name="stats-chart-outline" size={15} color={Colors.primary} />
        <Text variant="overline" color={Colors.primary}>
          {poll.status === 'open' ? 'Group poll' : 'Poll closed'}
          {poll.day_number ? ` · Day ${poll.day_number}` : ''}
        </Text>
      </View>
      <Text variant="bodyStrong">{poll.question}</Text>
      {poll.options.map((o) => {
        const n = counts[o.id] ?? 0;
        const picked = mine === o.id;
        const isWinner = winner === o.label;
        return (
          <PressableScale
            key={o.id}
            haptic
            disabled={poll.status !== 'open' || busy != null}
            onPress={() => castVote(o.id)}
            style={[styles.option, picked && styles.optionPicked, isWinner && styles.optionWinner]}
          >
            <View style={[styles.optionBar, { width: `${Math.round((n / total) * 100)}%` }]} />
            <Text variant="label" color={Colors.ink} style={{ flex: 1 }}>
              {isWinner ? '🏆 ' : picked ? '✓ ' : ''}
              {o.label}
            </Text>
            {busy === o.id ? <ActivityIndicator size="small" color={Colors.primary} /> : <Text variant="label" color={Colors.inkSoft}>{n}</Text>}
          </PressableScale>
        );
      })}
      {poll.status === 'open' ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text variant="caption" color={Colors.muted} style={{ flex: 1 }}>
            {waitingOn.length ? `Waiting on ${waitingOn.join(', ')}` : 'Everyone voted'} · Journi applies the result when all have voted
          </Text>
          <PressableScale
            haptic
            onPress={() =>
              Alert.alert('Close this poll now?', 'Journi will go with the current votes.', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Close poll', onPress: () => api.groups.closePoll(tripId, poll.id).then(onChanged).catch((e) => Alert.alert('Couldn’t close', (e as Error).message)) },
              ])
            }
          >
            <Text variant="label" color={Colors.primary} style={{ fontSize: 12 }}>
              Close now
            </Text>
          </PressableScale>
        </View>
      ) : (
        <Text variant="caption" color={Colors.muted}>
          {winner ? `Winner: ${winner}` : poll.result?.tie ? `Tie: ${poll.result.leaders.join(' / ')}` : 'No votes'}
        </Text>
      )}
    </View>
  );
}

// ------------------------------------------------------------ my preferences

function PreferencesForm({ tripId, initial, onSaved }: { tripId: string; initial: MemberPreferences; onSaved: () => void }) {
  const [interests, setInterests] = useState<string[]>(initial.interests ?? []);
  const [budget, setBudget] = useState(initial.budget_per_person_inr ? String(initial.budget_per_person_inr) : '');
  const [pace, setPace] = useState<Pace | null>(initial.pace ?? null);
  const [dietary, setDietary] = useState(initial.dietary ?? '');
  const [notes, setNotes] = useState(initial.notes ?? '');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await api.groups.savePreferences(tripId, {
        interests,
        budget_per_person_inr: Number(budget) > 0 ? Number(budget) : null,
        pace,
        dietary: dietary.trim() || null,
        notes: notes.trim() || null,
      });
      onSaved();
    } catch (err) {
      Alert.alert('Couldn’t save', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={{ gap: 12 }}>
      <Text variant="caption" color={Colors.inkSoft}>
        Journi balances everyone’s wishes when it changes the plan.
      </Text>
      <View style={styles.wrap}>
        {INTERESTS.map((i) => (
          <Chip key={i} label={i} active={interests.includes(i)} onPress={() => setInterests((cur) => (cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i]))} />
        ))}
      </View>
      <View style={styles.wrap}>
        {PACES.map((p) => (
          <Chip key={p.key} label={p.label} active={pace === p.key} onPress={() => setPace(pace === p.key ? null : p.key)} />
        ))}
      </View>
      <TextField label="My budget per person (₹)" icon="wallet-outline" keyboardType="number-pad" value={budget} onChangeText={(t) => setBudget(t.replace(/[^0-9]/g, ''))} placeholder="e.g. 45000" />
      <TextField label="Dietary needs" icon="leaf-outline" value={dietary} onChangeText={setDietary} placeholder="e.g. vegetarian, no seafood" maxLength={120} />
      <TextField label="Anything else?" icon="chatbubble-ellipses-outline" value={notes} onChangeText={setNotes} placeholder="e.g. I get motion sick on boats" maxLength={300} />
      <Button title="Save my preferences" icon="checkmark" onPress={save} loading={saving} />
    </View>
  );
}

// ------------------------------------------------------------ expenses

function AddExpense({ tripId, members, myUserId, onSaved }: { tripId: string; members: GroupMember[]; myUserId: string; onSaved: () => void }) {
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [paidBy, setPaidBy] = useState(myUserId);
  const [split, setSplit] = useState<string[]>(members.map((m) => m.user_id));
  const [category, setCategory] = useState<ExpenseCategory>('other');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (description.trim().length < 2 || !(Number(amount) > 0)) {
      Alert.alert('Almost there', 'Add what it was for and the amount.');
      return;
    }
    if (!split.length) {
      Alert.alert('Who shares it?', 'Pick at least one person.');
      return;
    }
    setSaving(true);
    try {
      await api.groups.addExpense(tripId, {
        description: description.trim(),
        amount_inr: Number(amount),
        paid_by: paidBy,
        split_among: split.length === members.length ? null : split,
        category,
      });
      setDescription('');
      setAmount('');
      onSaved();
    } catch (err) {
      Alert.alert('Couldn’t save', (err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={{ gap: 10 }}>
      <TextField label="What for?" icon="receipt-outline" value={description} onChangeText={setDescription} placeholder="e.g. Hotel in Hanoi" maxLength={120} />
      <TextField label="Amount (₹)" icon="cash-outline" keyboardType="decimal-pad" value={amount} onChangeText={(t) => setAmount(t.replace(/[^0-9.]/g, ''))} placeholder="e.g. 6000" />
      <View style={styles.wrap}>
        {CATEGORIES.map((c) => (
          <Chip key={c.key} label={c.label} active={category === c.key} onPress={() => setCategory(c.key)} />
        ))}
      </View>
      <Text variant="label" color={Colors.inkSoft}>
        Paid by
      </Text>
      <View style={styles.wrap}>
        {members.map((m) => (
          <Chip key={m.user_id} label={m.user_id === myUserId ? 'Me' : m.display_name} active={paidBy === m.user_id} onPress={() => setPaidBy(m.user_id)} />
        ))}
      </View>
      <Text variant="label" color={Colors.inkSoft}>
        Split equally between
      </Text>
      <View style={styles.wrap}>
        {members.map((m) => (
          <Chip
            key={m.user_id}
            label={m.user_id === myUserId ? 'Me' : m.display_name}
            active={split.includes(m.user_id)}
            onPress={() => setSplit((cur) => (cur.includes(m.user_id) ? cur.filter((x) => x !== m.user_id) : [...cur, m.user_id]))}
          />
        ))}
      </View>
      <Button title="Add expense" icon="add" onPress={save} loading={saving} />
    </View>
  );
}

// ------------------------------------------------------------ panel

interface GroupPanelProps {
  tripId: string;
  destinationName: string;
  group: GroupDetails | null;
  error: string | null;
  onReload: () => void;
  onLeft: () => void;
}

export function GroupPanel({ tripId, destinationName, group, error, onReload, onLeft }: GroupPanelProps) {
  const [editingPrefs, setEditingPrefs] = useState(false);
  const [addingExpense, setAddingExpense] = useState(false);

  if (!group) {
    return error ? (
      <View style={styles.card}>
        <Text variant="body" color={Colors.inkSoft} center>
          {error}
        </Text>
        <Button title="Try again" variant="secondary" size="sm" onPress={onReload} />
      </View>
    ) : (
      <View style={{ gap: 12 }}>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} height={120} radius={Radius.xl} />
        ))}
      </View>
    );
  }

  const me = group.members.find((m) => m.user_id === group.my_user_id);
  const isOwner = group.owner_id === group.my_user_id;
  const nameOf = (id: string) => (id === group.my_user_id ? 'You' : group.members.find((m) => m.user_id === id)?.display_name ?? 'Former member');
  const code = group.join_code ?? '';
  const openPolls = group.polls.filter((p) => p.status === 'open');
  const closedPolls = group.polls.filter((p) => p.status === 'closed').slice(0, 3);
  const myNet = group.balances.people.find((p) => p.user_id === group.my_user_id)?.net_inr ?? 0;

  const share = () =>
    Share.share({
      message: `Join my ${destinationName} trip on Journi! Open the app → Groups → Join, and enter the code ${code}`,
    }).catch(() => {});

  return (
    <Animated.View entering={FadeIn.duration(250)} style={{ gap: 14 }}>
      {/* Invite */}
      <Card title="Invite friends" icon="person-add-outline">
        <View style={styles.codeBox}>
          <Text variant="caption" color={Colors.inkSoft}>
            Join code
          </Text>
          <Text variant="h2" color={Colors.primary} style={{ letterSpacing: 2 }}>
            {code}
          </Text>
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button
            title="Copy"
            icon="copy-outline"
            variant="outline"
            size="sm"
            style={{ flex: 1 }}
            onPress={() => Clipboard.setStringAsync(code).then(() => Alert.alert('Copied', `${code} is on your clipboard.`))}
          />
          <Button title="Share" icon="share-social-outline" size="sm" style={{ flex: 1 }} onPress={share} />
        </View>
      </Card>

      {/* Members */}
      <Card title={`Members (${group.members.length})`} icon="people-outline">
        {group.members.map((m) => (
          <View key={m.user_id} style={styles.memberRow}>
            <Avatar name={m.display_name} />
            <View style={{ flex: 1, gap: 1 }}>
              <Text variant="label">
                {m.user_id === group.my_user_id ? `${m.display_name} (you)` : m.display_name}
                {m.role === 'owner' ? ' · organiser' : ''}
              </Text>
              <Text variant="caption" color={Colors.muted} numberOfLines={2}>
                {prefSummary(m.preferences) || 'No preferences yet'}
              </Text>
            </View>
            {isOwner && m.role !== 'owner' && (
              <PressableScale
                haptic
                accessibilityLabel={`Remove ${m.display_name}`}
                onPress={() =>
                  Alert.alert(`Remove ${m.display_name}?`, 'They’ll lose access to this trip.', [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Remove', style: 'destructive', onPress: () => api.groups.removeMember(tripId, m.user_id).then(onReload).catch((e) => Alert.alert('Couldn’t remove', (e as Error).message)) },
                  ])
                }
              >
                <Ionicons name="close-circle-outline" size={22} color={Colors.muted} />
              </PressableScale>
            )}
          </View>
        ))}
        {!isOwner && (
          <Button
            title="Leave group"
            icon="exit-outline"
            variant="ghost"
            size="sm"
            onPress={() =>
              Alert.alert('Leave this group trip?', 'You can rejoin later with the code.', [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Leave', style: 'destructive', onPress: () => api.groups.removeMember(tripId, group.my_user_id).then(onLeft).catch((e) => Alert.alert('Couldn’t leave', (e as Error).message)) },
              ])
            }
          />
        )}
      </Card>

      {/* My preferences */}
      <Card
        title="My preferences"
        icon="heart-outline"
        right={
          <PressableScale haptic onPress={() => setEditingPrefs((v) => !v)}>
            <Text variant="label" color={Colors.primary}>
              {editingPrefs ? 'Close' : 'Edit'}
            </Text>
          </PressableScale>
        }
      >
        {editingPrefs ? (
          <PreferencesForm
            tripId={tripId}
            initial={me?.preferences ?? {}}
            onSaved={() => {
              setEditingPrefs(false);
              onReload();
            }}
          />
        ) : (
          <Text variant="caption" color={Colors.inkSoft}>
            {me && prefSummary(me.preferences) ? prefSummary(me.preferences) : 'Tell Journi what you like — interests, pace, budget, food needs — so the plan works for you too. You can also just say it in the chat.'}
          </Text>
        )}
      </Card>

      {/* Polls */}
      <Card title="Polls" icon="stats-chart-outline">
        {openPolls.length === 0 && closedPolls.length === 0 ? (
          <Text variant="caption" color={Colors.inkSoft}>
            When the group disagrees, Journi starts a poll in the chat — e.g. “Day 2: beach or museums?”.
          </Text>
        ) : (
          [...openPolls, ...closedPolls].map((p) => <PollCard key={p.id} poll={p} tripId={tripId} myUserId={group.my_user_id} members={group.members} onChanged={onReload} />)
        )}
      </Card>

      {/* Money */}
      <Card
        title="Money"
        icon="wallet-outline"
        right={
          <PressableScale haptic onPress={() => setAddingExpense((v) => !v)}>
            <Text variant="label" color={Colors.primary}>
              {addingExpense ? 'Close' : '+ Expense'}
            </Text>
          </PressableScale>
        }
      >
        <View style={styles.statsRow}>
          <View style={styles.stat}>
            <Text variant="caption" color={Colors.muted}>
              Estimate / person
            </Text>
            <Text variant="title">{group.estimate.per_person_inr != null ? inr(group.estimate.per_person_inr) : '—'}</Text>
          </View>
          <View style={styles.stat}>
            <Text variant="caption" color={Colors.muted}>
              Group ({group.estimate.members})
            </Text>
            <Text variant="title">{group.estimate.group_total_inr != null ? inr(group.estimate.group_total_inr) : '—'}</Text>
          </View>
          <View style={styles.stat}>
            <Text variant="caption" color={Colors.muted}>
              Spent so far
            </Text>
            <Text variant="title">{inr(group.balances.total_spent_inr)}</Text>
          </View>
        </View>

        {addingExpense && (
          <AddExpense
            tripId={tripId}
            members={group.members}
            myUserId={group.my_user_id}
            onSaved={() => {
              setAddingExpense(false);
              onReload();
            }}
          />
        )}

        {group.balances.total_spent_inr > 0 && (
          <View style={{ gap: 6 }}>
            <Text variant="label" color={myNet > 0 ? Colors.success : myNet < 0 ? Colors.danger : Colors.inkSoft}>
              {myNet > 0 ? `You get back ${inr(myNet)}` : myNet < 0 ? `You owe ${inr(-myNet)}` : 'You’re all settled'}
            </Text>
            {group.balances.settlements.map((s, i) => (
              <Text key={i} variant="caption" color={Colors.inkSoft}>
                • {nameOf(s.from_user_id)} → {nameOf(s.to_user_id)}: {inr(s.amount_inr)}
              </Text>
            ))}
          </View>
        )}

        {group.expenses.length === 0 ? (
          <Text variant="caption" color={Colors.inkSoft}>
            Log who paid for what — or just tell Journi in the chat: “I paid ₹6,000 for the hotel”.
          </Text>
        ) : (
          group.expenses.slice(0, 20).map((e) => (
            <View key={e.id} style={styles.expenseRow}>
              <Ionicons name={CATEGORIES.find((c) => c.key === e.category)?.icon ?? 'receipt-outline'} size={18} color={Colors.primary} />
              <View style={{ flex: 1 }}>
                <Text variant="label" numberOfLines={1}>
                  {e.description}
                </Text>
                <Text variant="caption" color={Colors.muted}>
                  {nameOf(e.paid_by)} paid · split {e.split_among.length === group.members.length ? 'by everyone' : `by ${e.split_among.length}`}
                </Text>
              </View>
              <Text variant="label">{inr(e.amount_inr)}</Text>
              <PressableScale
                haptic
                accessibilityLabel="Delete expense"
                onPress={() =>
                  Alert.alert('Delete this expense?', e.description, [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Delete', style: 'destructive', onPress: () => api.groups.deleteExpense(tripId, e.id).then(onReload).catch((err) => Alert.alert('Couldn’t delete', (err as Error).message)) },
                  ])
                }
              >
                <Ionicons name="trash-outline" size={17} color={Colors.muted} />
              </PressableScale>
            </View>
          ))
        )}
      </Card>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: { gap: 12, padding: 16, borderRadius: Radius.xl, backgroundColor: Colors.surface, ...Shadow.card },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  codeBox: { alignItems: 'center', gap: 2, paddingVertical: 12, borderRadius: Radius.lg, backgroundColor: Colors.primarySoft },
  memberRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  avatar: { backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center' },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: Radius.pill, backgroundColor: Colors.bg, borderWidth: 1, borderColor: Colors.border },
  chipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  poll: { gap: 8, padding: 12, borderRadius: Radius.lg, backgroundColor: Colors.bg },
  option: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10, borderRadius: Radius.md, backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border, overflow: 'hidden' },
  optionPicked: { borderColor: Colors.primary },
  optionWinner: { borderColor: Colors.success },
  optionBar: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: Colors.primarySoft },
  statsRow: { flexDirection: 'row', gap: 8 },
  stat: { flex: 1, gap: 2, padding: 10, borderRadius: Radius.md, backgroundColor: Colors.bg },
  expenseRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
});
