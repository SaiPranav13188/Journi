import { Text as RNText, type TextProps, type TextStyle } from 'react-native';

import { Colors, Fonts } from '@/constants/theme';

type Variant = 'display' | 'h1' | 'h2' | 'h3' | 'title' | 'body' | 'bodyStrong' | 'caption' | 'label' | 'overline';

const variants: Record<Variant, TextStyle> = {
  display: { fontFamily: Fonts.extrabold, fontSize: 34, lineHeight: 40, letterSpacing: -0.8 },
  h1: { fontFamily: Fonts.extrabold, fontSize: 28, lineHeight: 34, letterSpacing: -0.6 },
  h2: { fontFamily: Fonts.bold, fontSize: 22, lineHeight: 28, letterSpacing: -0.3 },
  h3: { fontFamily: Fonts.bold, fontSize: 18, lineHeight: 24, letterSpacing: -0.2 },
  title: { fontFamily: Fonts.semibold, fontSize: 16, lineHeight: 22 },
  body: { fontFamily: Fonts.regular, fontSize: 15, lineHeight: 22 },
  bodyStrong: { fontFamily: Fonts.semibold, fontSize: 15, lineHeight: 22 },
  caption: { fontFamily: Fonts.medium, fontSize: 13, lineHeight: 18 },
  label: { fontFamily: Fonts.semibold, fontSize: 13, lineHeight: 18 },
  overline: { fontFamily: Fonts.bold, fontSize: 11, lineHeight: 14, letterSpacing: 1.2, textTransform: 'uppercase' },
};

export interface AppTextProps extends TextProps {
  variant?: Variant;
  color?: string;
  center?: boolean;
}

export function Text({ variant = 'body', color = Colors.ink, center, style, ...rest }: AppTextProps) {
  return <RNText style={[variants[variant], { color }, center && { textAlign: 'center' }, style]} {...rest} />;
}
