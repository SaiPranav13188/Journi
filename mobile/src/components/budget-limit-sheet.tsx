import { useState } from 'react';
import { KeyboardAvoidingView, Modal, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { Colors, Fonts, Radius, Shadow } from '@/constants/theme';
import { formatMoney } from '@/lib/format';
import { Button } from './ui/button';
import { Text } from './ui/text';

interface BudgetLimitSheetProps {
  visible: boolean;
  current: number | null | undefined;
  estimate: number;
  onClose: () => void;
  onSave: (limit: number | null) => Promise<void>;
}

/** Small dialog to set "my budget for this trip". */
export function BudgetLimitSheet({ visible, current, estimate, onClose, onSave }: BudgetLimitSheetProps) {
  const [value, setValue] = useState(current ? String(Math.round(current)) : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shownFor, setShownFor] = useState(visible);

  // Reset the input each time the sheet opens.
  if (visible !== shownFor) {
    setShownFor(visible);
    if (visible) {
      setValue(current ? String(Math.round(current)) : '');
      setError(null);
    }
  }

  const amount = Number(value.replace(/[^0-9]/g, ''));
  const suggestions = [Math.ceil((estimate * 1.1) / 1000) * 1000, Math.ceil((estimate * 1.25) / 5000) * 5000].filter(
    (v, i, arr) => v > 0 && arr.indexOf(v) === i,
  );

  const save = async (limit: number | null) => {
    setSaving(true);
    setError(null);
    try {
      await onSave(limit);
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
            <Text variant="h3">Your budget for this trip</Text>
            <Text variant="caption" color={Colors.muted}>
              Journi estimates {formatMoney(estimate, 'INR')} per person. Set the most you want to spend and we’ll track it.
            </Text>
            <View style={styles.inputRow}>
              <Text variant="h2" color={Colors.muted}>
                ₹
              </Text>
              <TextInput
                value={value}
                onChangeText={(t) => setValue(t.replace(/[^0-9]/g, ''))}
                keyboardType="number-pad"
                placeholder="60000"
                placeholderTextColor={Colors.muted}
                style={styles.input}
                autoFocus
                maxLength={9}
              />
            </View>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {suggestions.map((s) => (
                <Pressable key={s} onPress={() => setValue(String(s))} style={styles.suggestion}>
                  <Text variant="caption" color={Colors.primaryDark}>
                    {formatMoney(s, 'INR')}
                  </Text>
                </Pressable>
              ))}
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
  suggestion: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: Radius.pill, backgroundColor: Colors.primarySoft },
});
