import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { ActivityIndicator, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Colors, Gradients, Radius, Shadow } from '@/constants/theme';
import { PressableScale } from './pressable-scale';
import { Text } from './text';

type Variant = 'primary' | 'accent' | 'secondary' | 'ghost' | 'outline' | 'danger' | 'onDark';

interface ButtonProps {
  title: string;
  onPress?: () => void;
  variant?: Variant;
  icon?: keyof typeof Ionicons.glyphMap;
  iconRight?: keyof typeof Ionicons.glyphMap;
  loading?: boolean;
  disabled?: boolean;
  size?: 'md' | 'lg' | 'sm';
  style?: StyleProp<ViewStyle>;
  fullWidth?: boolean;
}

const textColor: Record<Variant, string> = {
  primary: Colors.white,
  accent: Colors.white,
  secondary: Colors.primaryDark,
  ghost: Colors.primary,
  outline: Colors.ink,
  danger: Colors.danger,
  onDark: Colors.white,
};

export function Button({ title, onPress, variant = 'primary', icon, iconRight, loading, disabled, size = 'md', style, fullWidth }: ButtonProps) {
  const height = size === 'lg' ? 56 : size === 'sm' ? 38 : 48;
  const fontSize = size === 'sm' ? 14 : 16;
  const color = textColor[variant];
  const isGradient = variant === 'primary' || variant === 'accent';

  const content = (
    <View style={[styles.content, { height, paddingHorizontal: size === 'sm' ? 14 : 22 }]}>
      {loading ? (
        <ActivityIndicator color={color} />
      ) : (
        <>
          {icon && <Ionicons name={icon} size={fontSize + 3} color={color} />}
          <Text variant="bodyStrong" color={color} style={{ fontSize }} numberOfLines={1}>
            {title}
          </Text>
          {iconRight && <Ionicons name={iconRight} size={fontSize + 2} color={color} />}
        </>
      )}
    </View>
  );

  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled || loading}
      haptic
      accessibilityRole="button"
      accessibilityLabel={title}
      style={[
        styles.base,
        fullWidth && { alignSelf: 'stretch' },
        variant === 'secondary' && { backgroundColor: Colors.primarySoft },
        variant === 'outline' && { borderWidth: 1.5, borderColor: Colors.border, backgroundColor: Colors.surface },
        variant === 'danger' && { backgroundColor: Colors.dangerSoft },
        variant === 'onDark' && { backgroundColor: 'rgba(255,255,255,0.14)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)' },
        isGradient && Shadow.card,
        (disabled || loading) && { opacity: 0.55 },
        style,
      ]}
    >
      {isGradient ? (
        <LinearGradient
          colors={variant === 'accent' ? Gradients.sunset : Gradients.brand}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.gradient}
        >
          {content}
        </LinearGradient>
      ) : (
        content
      )}
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  base: { borderRadius: Radius.pill, overflow: 'hidden' },
  gradient: { borderRadius: Radius.pill },
  content: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
});
