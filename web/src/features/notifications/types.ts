import type {
  DashboardToastConfig,
  NotificationChangeEvent,
  NotificationRecord,
} from '../../api';

export const DEFAULT_TOAST_CONFIG: DashboardToastConfig = {
  enabled: true,
  soundEnabled: true,
  minimumLevel: 'ready',
  readyDurationMs: 3_600_000,
  maxVisible: 3,
};

export const MAX_QUEUED_TOASTS = 100;

export type ToastItem = {
  notification: NotificationRecord;
  admittedAt: number;
  expiresAt: number | null;
};

export type ToastState = {
  items: ToastItem[];
};

export type ToastAction =
  | {
      type: 'notification-event';
      event: NotificationChangeEvent;
      config: DashboardToastConfig;
      now: number;
    }
  | { type: 'remove'; id: string }
  | {
      type: 'reconfigure';
      config: DashboardToastConfig;
      now: number;
    }
  | { type: 'clear' };

export type NotificationTarget =
  | {
      kind: 'plugin';
      pluginId: string;
      label: string;
    }
  | {
      kind: 'session';
      sessionId: string;
      label: string;
    }
  | {
      kind: 'url';
      href: string;
      label: string;
    };
