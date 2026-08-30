import { useEffect } from 'react';
import { DarkTheme, DefaultTheme, type Href, Stack, ThemeProvider, useRouter } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme } from 'react-native';
import 'react-native-reanimated';

import { useAutoSync } from '@/src/hooks/useAutoSync';

export { ErrorBoundary } from 'expo-router';

export const unstable_settings = {
  initialRouteName: '(tabs)',
};

export default function RootLayout() {
  const scheme = useColorScheme();
  const router = useRouter();
  useAutoSync();

  useEffect(() => {
    const openNotification = (response: Notifications.NotificationResponse) => {
      const url = response.notification.request.content.data?.url;
      if (typeof url === 'string') router.push(url as Href);
    };
    const subscription = Notifications.addNotificationResponseReceivedListener(openNotification);
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response) openNotification(response);
    });
    return () => subscription.remove();
  }, [router]);

  return (
    <ThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerBackTitle: 'Назад' }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen
          name="task-editor"
          options={{ presentation: 'modal', title: 'Задача', headerShown: false, gestureEnabled: true }}
        />
        <Stack.Screen name="event-editor" options={{ presentation: 'modal', title: 'Событие', headerShown: false, gestureEnabled: true }} />
        <Stack.Screen name="routines" options={{ headerShown: false }} />
        <Stack.Screen name="routine-editor" options={{ presentation: 'modal', title: 'Ритуал', headerShown: false, gestureEnabled: true }} />
        <Stack.Screen name="mail-accounts" options={{ headerShown: false }} />
        <Stack.Screen name="mail-account-editor" options={{ presentation: 'modal', title: 'Почта', headerShown: false, gestureEnabled: true }} />
        <Stack.Screen name="mail-reader" options={{ presentation: 'modal', title: 'Письмо', headerShown: false, gestureEnabled: true }} />
        <Stack.Screen name="mail-compose" options={{ presentation: 'modal', title: 'Новое письмо', headerShown: false, gestureEnabled: true }} />
        <Stack.Screen name="sync-settings" options={{ presentation: 'modal', headerShown: false, gestureEnabled: true }} />
      </Stack>
    </ThemeProvider>
  );
}
