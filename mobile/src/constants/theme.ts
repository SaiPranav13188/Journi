import { Platform } from 'react-native';

export const Colors = {
  ink: '#0F1B2D',
  inkSoft: '#4B5565',
  muted: '#8A93A3',
  bg: '#F6F4EF',
  surface: '#FFFFFF',
  surfaceAlt: '#EFEBE3',
  border: '#E6E1D8',

  primary: '#0E6E6B',
  primaryDark: '#0A4F4D',
  primarySoft: '#DCEFEC',

  accent: '#FF6B4A',
  accentSoft: '#FFE9E2',
  gold: '#F2B84B',

  warning: '#B45309',
  warningBg: '#FFF4E0',
  warningBorder: '#F9D9A6',
  danger: '#DC2626',
  dangerSoft: '#FDECEC',
  success: '#15803D',
  successSoft: '#E4F5EA',

  white: '#FFFFFF',
  black: '#000000',
  overlay: 'rgba(8, 16, 28, 0.55)',
} as const;

export const Gradients = {
  brand: ['#0E6E6B', '#149C96'] as const,
  sunset: ['#FF9A5A', '#FF5E62'] as const,
  night: ['#0F1B2D', '#1F3B57'] as const,
  heroFade: ['rgba(8,16,28,0)', 'rgba(8,16,28,0.35)', 'rgba(8,16,28,0.9)'] as const,
  topFade: ['rgba(8,16,28,0.55)', 'rgba(8,16,28,0)'] as const,
};

export const Fonts = {
  regular: 'PlusJakartaSans_400Regular',
  medium: 'PlusJakartaSans_500Medium',
  semibold: 'PlusJakartaSans_600SemiBold',
  bold: 'PlusJakartaSans_700Bold',
  extrabold: 'PlusJakartaSans_800ExtraBold',
} as const;

export const Spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

export const Radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 22,
  xxl: 28,
  pill: 999,
} as const;

export const Shadow = {
  card: Platform.select({
    ios: { shadowColor: '#0F1B2D', shadowOpacity: 0.08, shadowRadius: 16, shadowOffset: { width: 0, height: 6 } },
    default: { elevation: 3 },
  }),
  raised: Platform.select({
    ios: { shadowColor: '#0F1B2D', shadowOpacity: 0.16, shadowRadius: 22, shadowOffset: { width: 0, height: 10 } },
    default: { elevation: 8 },
  }),
};
