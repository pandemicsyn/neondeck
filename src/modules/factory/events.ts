import type { FactoryChangeEvent } from '../../../shared/factory';
const listeners = new Set<(event: FactoryChangeEvent) => void>();
export function subscribeFactoryEvents(
  listener: (event: FactoryChangeEvent) => void,
) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function publishFactoryChange() {
  const event: FactoryChangeEvent = { changedAt: new Date().toISOString() };
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      /* A disconnected UI must not turn a committed mutation into failure. */
    }
  }
}
export function formatFactoryServerSentEvent(event: FactoryChangeEvent) {
  return `event: factory-change\ndata: ${JSON.stringify(event)}\n\n`;
}
