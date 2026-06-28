import type { RuntimePaths } from './runtime-home';

export type ConfigChangeEvent = {
  id: string;
  action: string;
  changed: boolean;
  home: string;
  files: string[];
  target: string | null;
  changedAt: string;
};

type ConfigChangeListener = (event: ConfigChangeEvent) => void;

const listeners = new Set<ConfigChangeListener>();

export function publishConfigEvent(event: ConfigChangeEvent) {
  for (const listener of listeners) {
    listener(event);
  }
}

export function subscribeConfigEvents(listener: ConfigChangeListener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function configEventFromChange(
  paths: RuntimePaths,
  change: {
    id?: string | number | bigint;
    action: string;
    changed: boolean;
    files: string[];
    target?: string | null;
    changedAt: string;
  },
): ConfigChangeEvent {
  return {
    id: String(change.id ?? `${change.changedAt}:${change.action}`),
    action: change.action,
    changed: change.changed,
    home: paths.home,
    files: change.files,
    target: change.target ?? null,
    changedAt: change.changedAt,
  };
}

export function formatConfigServerSentEvent(event: ConfigChangeEvent) {
  return [
    `id: ${event.id}`,
    'event: config-change',
    `data: ${JSON.stringify(event)}`,
    '',
    '',
  ].join('\n');
}
