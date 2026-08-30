import { useEffect } from 'react';
import NetInfo from '@react-native-community/netinfo';
import { AppState } from 'react-native';

import { syncNow } from '@/src/services/sync';
import { useDayDeskStore } from '@/src/store/useDayDeskStore';

export function useAutoSync() {
  const hydrated = useDayDeskStore((state) => state.hydrated);

  useEffect(() => {
    if (!hydrated) return undefined;
    let online = true;
    const unsubscribeNetwork = NetInfo.addEventListener((state) => {
      online = state.isConnected === true && state.isInternetReachable !== false;
      if (online) void syncNow();
      else useDayDeskStore.getState().setSyncStatus('offline');
    });
    const appStateSubscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active' && online) void syncNow();
    });
    return () => {
      unsubscribeNetwork();
      appStateSubscription.remove();
    };
  }, [hydrated]);
}
