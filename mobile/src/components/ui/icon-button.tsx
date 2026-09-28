import { Ionicons } from '@expo/vector-icons';
import { BlurView } from 'expo-blur';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Colors } from '@/constants/theme';
import { PressableScale } from './pressable-scale';
import { Text } from './text';

interface IconButtonProps {
  icon: keyof typeof Ionicons.glyphMap;
  onPress?: () => void;
  /** 'glass' for use on top of photos, 'solid' on plain backgrounds. */
  variant?: 'glass' | 'solid' | 'plain';
  size?: number;
  badge?: number;
  color?: string;
  accessibilityLabel: string;
  style?: StyleProp<ViewStyle>;
}

export function IconButton({ icon, onPress, variant = 'solid', size = 42, badge, color, accessibilityLabel, style }: IconButtonProps) {
  const iconColor = color ?? (variant === 'glass' ? Colors.white : Colors.ink);
  return (
    <PressableScale
      onPress={onPress}
      haptic
      scaleTo={0.9}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={[{ width: size, height: size, borderRadius: size / 2 }, style]}
    >
      <View style={[styles.inner, { borderRadius: size / 2 }, variant === 'solid' && styles.solid]}>
        {variant === 'glass' && <BlurView intensity={40} tint="dark" style={StyleSheet.absoluteFill} />}
        <Ionicons name={icon} size={size * 0.5} color={iconColor} />
      </View>
      {!!badge && (
        <View style={styles.badge}>
          <Text variant="overline" color={Colors.white} style={{ fontSize: 10, letterSpacing: 0 }}>
            {badge > 9 ? '9+' : badge}
          </Text>
        </View>
      )}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  inner: { flex: 1, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  solid: { backgroundColor: Colors.surface, borderWidth: 1, borderColor: Colors.border },
  badge: {
    position: 'absolute',
    top: -2,
    right: -2,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 9,
    backgroundColor: Colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: Colors.bg,
  },
});
