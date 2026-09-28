import { Ionicons } from '@expo/vector-icons';
import { forwardRef, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View, type TextInputProps } from 'react-native';
import Animated, { interpolateColor, useAnimatedStyle, useDerivedValue, withTiming } from 'react-native-reanimated';

import { Colors, Fonts, Radius } from '@/constants/theme';
import { Text } from './text';

interface TextFieldProps extends TextInputProps {
  label?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  error?: string | null;
  secureToggle?: boolean;
}

export const TextField = forwardRef<TextInput, TextFieldProps>(function TextField(
  { label, icon, error, secureToggle, secureTextEntry, onFocus, onBlur, style, ...rest },
  ref,
) {
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(true);
  const progress = useDerivedValue(() => withTiming(focused ? 1 : 0, { duration: 180 }));

  const borderStyle = useAnimatedStyle(() => ({
    borderColor: error ? Colors.danger : interpolateColor(progress.value, [0, 1], [Colors.border, Colors.primary]),
  }));

  return (
    <View style={{ gap: 6 }}>
      {label && (
        <Text variant="label" color={Colors.inkSoft}>
          {label}
        </Text>
      )}
      <Animated.View style={[styles.field, borderStyle]}>
        {icon && <Ionicons name={icon} size={19} color={focused ? Colors.primary : Colors.muted} />}
        <TextInput
          ref={ref}
          placeholderTextColor={Colors.muted}
          secureTextEntry={secureToggle ? hidden : secureTextEntry}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          style={[styles.input, style]}
          {...rest}
        />
        {secureToggle && (
          <Pressable onPress={() => setHidden((h) => !h)} hitSlop={10} accessibilityLabel={hidden ? 'Show password' : 'Hide password'}>
            <Ionicons name={hidden ? 'eye-outline' : 'eye-off-outline'} size={20} color={Colors.muted} />
          </Pressable>
        )}
      </Animated.View>
      {!!error && (
        <Text variant="caption" color={Colors.danger}>
          {error}
        </Text>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    height: 54,
    paddingHorizontal: 16,
    borderRadius: Radius.lg,
    borderWidth: 1.5,
    backgroundColor: Colors.surface,
  },
  input: { flex: 1, fontFamily: Fonts.medium, fontSize: 16, color: Colors.ink, height: '100%' },
});
