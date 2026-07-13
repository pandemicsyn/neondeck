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
    minimumLevel: config?.minimumLevel ?? DEFAULT_TOAST_CONFIG.minimumLevel,
    readyDurationMs: Math.min(
      60_000,
      Math.max(
        1_000,
        Math.round(
          config?.readyDurationMs ?? DEFAULT_TOAST_CONFIG.readyDurationMs,
        ),
      ),
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
  return notification.level === 'ready' ? now + config.readyDurationMs : null;
}
