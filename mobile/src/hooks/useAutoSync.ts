import { useEffect } from 'react';
import NetInfo from '@react-native-community/netinfo';
import { AppState } from 'react-native';

import { syncNow } from '@/src/services/sync';
import { useDayDeskStore } from '@/src/store/useDayDeskStore';

export function useAutoSync() {
  const hydrated = useDayDeskStore((state) => state.hydrated);
  const queuedChanges = useDayDeskStore((state) => state.syncQueue.length);

  useEffect(() => {
    if (!hydrated) return undefined;
    let online = true;
    let active = AppState.currentState === 'active';
    const unsubscribeNetwork = NetInfo.addEventListener((state) => {
      online = state.isConnected === true && state.isInternetReachable !== false;
      if (online) void syncNow();
      else useDayDeskStore.getState().setSyncStatus('offline');
    });
    const appStateSubscription = AppState.addEventListener('change', (nextState) => {
      active = nextState === 'active';
      if (active && online) void syncNow();
    });
    const interval = setInterval(() => { if (active && online) void syncNow(); }, 60_000);
    return () => {
      unsubscribeNetwork();
      appStateSubscription.remove();
      clearInterval(interval);
    };
  }, [hydrated]);

  useEffect(() => {
    if (!hydrated || queuedChanges === 0) return undefined;
    const timer = setTimeout(() => {
      void NetInfo.fetch().then((state) => {
        if (state.isConnected === true && state.isInternetReachable !== false) return syncNow();
        return false;
      });
    }, 1_200);
    return () => clearTimeout(timer);
  }, [hydrated, queuedChanges]);
}
