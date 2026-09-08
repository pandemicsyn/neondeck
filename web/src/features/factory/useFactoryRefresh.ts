import { useRef, useState } from 'react';

/** User-requested refresh feedback, independent of polling and invalidation. */
export function useFactoryRefresh() {
  const active = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  async function refresh(action: () => Promise<unknown>) {
    if (active.current) return;
    active.current = true;
    setRefreshing(true);
    try {
      await action();
    } finally {
      active.current = false;
      setRefreshing(false);
    }
  }
  return { refreshing, refresh };
}
