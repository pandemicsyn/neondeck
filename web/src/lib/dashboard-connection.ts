import { useSyncExternalStore } from 'react';
import { dashboardEventHub } from '../api/event-hub';

export function useDashboardEventConnectionState() {
  return useSyncExternalStore(
    dashboardEventHub.subscribeConnectionState,
    dashboardEventHub.getConnectionState,
    () => 'closed',
  );
}
