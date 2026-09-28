import { Stack } from 'expo-router';

import { Colors } from '@/constants/theme';

export default function AppLayout() {
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: Colors.bg } }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="new-trip" options={{ animation: 'slide_from_bottom' }} />
      <Stack.Screen name="planning" options={{ animation: 'fade', gestureEnabled: false }} />
      <Stack.Screen name="trip/[id]" options={{ animation: 'fade_from_bottom' }} />
      <Stack.Screen name="alerts" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
      <Stack.Screen name="booking-editor" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
      <Stack.Screen name="packing/[id]" options={{ animation: 'slide_from_right' }} />
      <Stack.Screen name="price-check" options={{ animation: 'slide_from_bottom' }} />
      <Stack.Screen name="offline/[id]" options={{ animation: 'slide_from_right' }} />
    </Stack>
  );
}
