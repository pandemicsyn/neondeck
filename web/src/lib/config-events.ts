import { useEffect, useRef } from 'react';
import type { ConfigChangeEvent } from '../api';

export const configChangeEventName = 'neondeck:config-change';

declare global {
  interface WindowEventMap {
    [configChangeEventName]: CustomEvent<ConfigChangeEvent>;
  }
}

export function dispatchConfigChangeEvent(event: ConfigChangeEvent) {
  window.dispatchEvent(
    new CustomEvent(configChangeEventName, {
      detail: event,
    }),
  );
}

export function useConfigEvents(callback: (event: ConfigChangeEvent) => void) {
  const callbackRef = useRef(callback);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    const listener = (event: WindowEventMap[typeof configChangeEventName]) => {
      callbackRef.current(event.detail);
    };

    window.addEventListener(configChangeEventName, listener);
    return () => window.removeEventListener(configChangeEventName, listener);
  }, []);
}

export function configEventTouchesFile(
  event: ConfigChangeEvent,
  fileName: string,
) {
  return event.files.some(
    (file) => file === fileName || file.endsWith(`/${fileName}`),
  );
}
