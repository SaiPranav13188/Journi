import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { KeyboardAvoidingView, Modal, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { Colors, Fonts, Radius, Shadow } from '@/constants/theme';
import { Button } from './ui/button';
import { Text } from './ui/text';

interface FlightCostSheetProps {
  visible: boolean;
  current: number | null | undefined;
  onClose: () => void;
  onSave: (amountInr: number | null) => Promise<void>;
}

/** Dialog to type your own return-flight cost; it goes straight into the budget. */
export function FlightCostSheet({ visible, current, onClose, onSave }: FlightCostSheetProps) {
  const [value, setValue] = useState(current ? String(Math.round(current)) : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shownFor, setShownFor] = useState(visible);

  // Reset the input each time the dialog opens.
  if (visible !== shownFor) {
    setShownFor(visible);
    if (visible) {
      setValue(current ? String(Math.round(current)) : '');
      setError(null);
    }
  }

  const amount = Number(value.replace(/[^0-9]/g, ''));

  const save = async (next: number | null) => {
    setSaving(true);
    setError(null);
    try {
      await onSave(next);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        <Pressable style={styles.backdrop} onPress={onClose}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={styles.icon}>
                <Ionicons name="airplane" size={18} color={Colors.white} />
              </View>
              <Text variant="h3" style={{ flex: 1 }}>
                Flight cost
              </Text>
            </View>
            <Text variant="caption" color={Colors.muted}>
              Enter what your return (up and down) flights cost per person. It’s added straight to your budget.
            </Text>
            <View style={styles.inputRow}>
              <Text variant="h2" color={Colors.muted}>
                ₹
              </Text>
              <TextInput
                value={value}
                onChangeText={(t) => setValue(t.replace(/[^0-9]/g, ''))}
                keyboardType="number-pad"
                placeholder="e.g. 18500"
                placeholderTextColor={Colors.muted}
                style={styles.input}
                autoFocus
                maxLength={9}
              />
            </View>
            {!!error && (
              <Text variant="caption" color={Colors.danger}>
                {error}
              </Text>
            )}
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 4 }}>
              {current ? <Button title="Remove" variant="danger" size="sm" onPress={() => save(null)} disabled={saving} /> : null}
              <View style={{ flex: 1 }} />
              <Button title="Cancel" variant="outline" size="sm" onPress={onClose} disabled={saving} />
              <Button title="Save" size="sm" onPress={() => save(amount)} disabled={!amount} loading={saving} />
            </View>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(8,16,28,0.45)', justifyContent: 'center', padding: 20 },
  sheet: { gap: 12, padding: 20, borderRadius: Radius.xxl, backgroundColor: Colors.surface, ...Shadow.raised },
  icon: { width: 34, height: 34, borderRadius: 10, backgroundColor: '#0EA5E9', alignItems: 'center', justifyContent: 'center' },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    height: 60,
    borderRadius: Radius.lg,
    borderWidth: 1.5,
    borderColor: Colors.primary,
  },
  input: { flex: 1, height: '100%', fontFamily: Fonts.bold, fontSize: 24, color: Colors.ink },
});
