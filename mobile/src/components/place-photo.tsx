import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { Colors, Gradients } from '@/constants/theme';
import { usePlaceImage } from '@/hooks/use-place-image';
import { Skeleton } from './ui/skeleton';

const CATEGORY_ICONS: Record<string, keyof typeof Ionicons.glyphMap> = {
  sightseeing: 'camera-outline',
  culture: 'color-palette-outline',
  nature: 'leaf-outline',
  food: 'restaurant-outline',
  shopping: 'bag-handle-outline',
  adventure: 'trail-sign-outline',
  relaxation: 'cafe-outline',
  nightlife: 'moon-outline',
  transport: 'train-outline',
};

export function categoryIcon(category?: string | null): keyof typeof Ionicons.glyphMap {
  return CATEGORY_ICONS[category ?? ''] ?? 'location-outline';
}

const FALLBACK_GRADIENTS: readonly (readonly [string, string])[] = [
  Gradients.brand,
  Gradients.sunset,
  ['#6D5DD3', '#9B8CFF'],
  ['#2F80ED', '#56CCF2'],
  ['#11998E', '#38EF7D'],
];

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

interface PlacePhotoProps {
  /** Search query for the photo, e.g. "Fushimi Inari Taisha, Kyoto". */
  query?: string | null;
  /** Use a known URL instead of looking one up. */
  uri?: string | null;
  width?: number;
  fallbackIcon?: keyof typeof Ionicons.glyphMap;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}

/** A real photo of a place with a soft fade-in; falls back to a colourful gradient + icon. */
export function PlacePhoto({ query, uri, width = 800, fallbackIcon = 'image-outline', style, children }: PlacePhotoProps) {
  const lookup = usePlaceImage(uri ? null : query, width);
  const url = uri ?? lookup.url;
  const colors = FALLBACK_GRADIENTS[hash(query ?? uri ?? '') % FALLBACK_GRADIENTS.length];

  return (
    <View style={[styles.container, style]}>
      {!uri && lookup.loading ? (
        <Skeleton width="100%" height="100%" radius={0} style={StyleSheet.absoluteFill} />
      ) : url ? (
        <Image source={{ uri: url }} style={StyleSheet.absoluteFill} contentFit="cover" transition={400} cachePolicy="memory-disk" />
      ) : (
        <LinearGradient colors={colors} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={[StyleSheet.absoluteFill, styles.center]}>
          <Ionicons name={fallbackIcon} size={28} color="rgba(255,255,255,0.9)" />
        </LinearGradient>
      )}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { overflow: 'hidden', backgroundColor: Colors.surfaceAlt },
  center: { alignItems: 'center', justifyContent: 'center' },
});
