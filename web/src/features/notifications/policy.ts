import type {
  DashboardToastConfig,
  NotificationLevel,
  NotificationRecord,
} from '../../api';
import { DEFAULT_TOAST_CONFIG } from './types';

export const notificationLevelRank: Record<NotificationLevel, number> = {
  info: 0,
  ready: 1,
  attention: 2,
  urgent: 3,
};

export function resolveToastConfig(
  config: Partial<DashboardToastConfig> | undefined,
): DashboardToastConfig {
  return {
    enabled: config?.enabled ?? DEFAULT_TOAST_CONFIG.enabled,
    soundEnabled: config?.soundEnabled ?? DEFAULT_TOAST_CONFIG.soundEnabled,
    minimumLevel: config?.minimumLevel ?? DEFAULT_TOAST_CONFIG.minimumLevel,
    readyDurationMs: clampReadyDuration(
      config?.readyDurationMs ?? DEFAULT_TOAST_CONFIG.readyDurationMs,
    ),
    maxVisible: Math.min(
      3,
      Math.max(
        1,
        Math.round(config?.maxVisible ?? DEFAULT_TOAST_CONFIG.maxVisible),
      ),
    ),
  };
}

export function notificationQualifies(
  notification: Pick<NotificationRecord, 'level' | 'readAt' | 'resolvedAt'>,
  config: DashboardToastConfig,
) {
  return (
    config.enabled &&
    !notification.readAt &&
    !notification.resolvedAt &&
    notificationLevelRank[notification.level] >=
      notificationLevelRank[config.minimumLevel]
  );
}

export function notificationExpiresAt(
  notification: Pick<NotificationRecord, 'level'>,
  config: DashboardToastConfig,
  now: number,
) {
  return notification.level === 'ready' && config.readyDurationMs > 0
    ? now + config.readyDurationMs
    : null;
}

function clampReadyDuration(value: number) {
  const rounded = Math.round(value);
  return rounded === 0 ? 0 : Math.min(86_400_000, Math.max(1_000, rounded));
}
