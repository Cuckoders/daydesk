import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import { type ColorValue, Platform } from 'react-native';

import { useAppColors } from '@/src/theme';

type TabIconName = React.ComponentProps<typeof Ionicons>['name'];

function icon(name: TabIconName, focusedName: TabIconName) {
  return ({ color, size, focused }: { color: ColorValue; size: number; focused: boolean }) => (
    <Ionicons name={focused ? focusedName : name} color={color} size={size} />
  );
}

export default function TabLayout() {
  const colors = useAppColors();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        tabBarStyle: {
          backgroundColor: colors.tabBar,
          borderTopColor: colors.border,
          height: Platform.OS === 'ios' ? 84 : 68,
          paddingTop: 7,
          paddingBottom: Platform.OS === 'ios' ? 25 : 9,
        },
        tabBarLabelStyle: { fontSize: 12, fontWeight: '600' },
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Сегодня', tabBarIcon: icon('sunny-outline', 'sunny') }} />
      <Tabs.Screen name="tasks" options={{ title: 'Задачи', tabBarIcon: icon('checkbox-outline', 'checkbox') }} />
      <Tabs.Screen name="calendar" options={{ title: 'Календарь', tabBarIcon: icon('calendar-outline', 'calendar') }} />
      <Tabs.Screen name="mail" options={{ title: 'Почта', tabBarIcon: icon('mail-outline', 'mail') }} />
    </Tabs>
  );
}
