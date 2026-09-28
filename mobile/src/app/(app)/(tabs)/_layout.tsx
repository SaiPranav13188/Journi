import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Tabs } from 'expo-router/js-tabs';
import { Platform } from 'react-native';

import { Colors, Fonts } from '@/constants/theme';

type IconName = keyof typeof Ionicons.glyphMap;

const TABS: { name: string; title: string; icon: IconName; iconActive: IconName }[] = [
  { name: 'index', title: 'Home', icon: 'home-outline', iconActive: 'home' },
  { name: 'trips', title: 'Trips', icon: 'briefcase-outline', iconActive: 'briefcase' },
  { name: 'explore', title: 'Explore', icon: 'compass-outline', iconActive: 'compass' },
  { name: 'bookings', title: 'Bookings', icon: 'ticket-outline', iconActive: 'ticket' },
  { name: 'profile', title: 'Profile', icon: 'person-circle-outline', iconActive: 'person-circle' },
];

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: Colors.primary,
        tabBarInactiveTintColor: Colors.muted,
        tabBarLabelStyle: { fontFamily: Fonts.semibold, fontSize: 11 },
        tabBarStyle: {
          backgroundColor: Colors.surface,
          borderTopColor: Colors.border,
          height: Platform.OS === 'ios' ? 86 : 66,
          paddingTop: 6,
        },
        sceneStyle: { backgroundColor: Colors.bg },
      }}
      screenListeners={{
        tabPress: () => {
          Haptics.selectionAsync().catch(() => {});
        },
      }}
    >
      {TABS.map((t) => (
        <Tabs.Screen
          key={t.name}
          name={t.name}
          options={{
            title: t.title,
            tabBarIcon: ({ color, focused, size }) => <Ionicons name={focused ? t.iconActive : t.icon} size={size} color={color} />,
          }}
        />
      ))}
    </Tabs>
  );
}
