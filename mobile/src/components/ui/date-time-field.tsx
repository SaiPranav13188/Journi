import { Ionicons } from '@expo/vector-icons';
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { Colors, Radius } from '@/constants/theme';
import { PressableScale } from './pressable-scale';
import { Text } from './text';

interface DateTimeFieldProps {
  label: string;
  value: Date | null;
  onChange: (d: Date | null) => void;
  optional?: boolean;
  minimumDate?: Date;
}

function display(d: Date) {
  return d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Tap to pick a date, then a time. Android uses the system dialogs; iOS an inline picker. */
export function DateTimeField({ label, value, onChange, optional, minimumDate }: DateTimeFieldProps) {
  const [iosOpen, setIosOpen] = useState(false);

  const open = () => {
    const base = value ?? (() => {
      const d = new Date();
      d.setHours(10, 0, 0, 0);
      return d;
    })();
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        value: base,
        mode: 'date',
        minimumDate,
        onValueChange: (_e, date) => {
          DateTimePickerAndroid.open({
            value: date,
            mode: 'time',
            onValueChange: (_e2, time) => {
              const combined = new Date(date);
              combined.setHours(time.getHours(), time.getMinutes(), 0, 0);
              onChange(combined);
            },
          });
        },
      });
    } else {
      if (!value) onChange(base);
      setIosOpen((o) => !o);
    }
  };

  return (
    <View style={{ gap: 6 }}>
      <Text variant="label" color={Colors.inkSoft}>
        {label}
        {optional ? ' (optional)' : ''}
      </Text>
      <View style={styles.field}>
        <PressableScale onPress={open} style={styles.tap}>
          <Ionicons name="calendar-outline" size={18} color={Colors.primary} />
          <Text variant="body" color={value ? Colors.ink : Colors.muted}>
            {value ? display(value) : 'Pick date & time'}
          </Text>
        </PressableScale>
        {value && optional && (
          <PressableScale onPress={() => onChange(null)} hitSlop={8} accessibilityLabel={`Clear ${label}`}>
            <Ionicons name="close-circle" size={18} color={Colors.muted} />
          </PressableScale>
        )}
      </View>
      {Platform.OS === 'ios' && iosOpen && value && (
        <DateTimePicker value={value} mode="datetime" display="inline" accentColor={Colors.primary} minimumDate={minimumDate} onValueChange={(_e, d) => onChange(d)} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    height: 52,
    paddingHorizontal: 14,
    borderRadius: Radius.lg,
    borderWidth: 1.5,
    borderColor: Colors.border,
    backgroundColor: Colors.surface,
  },
  tap: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, height: '100%' },
});
