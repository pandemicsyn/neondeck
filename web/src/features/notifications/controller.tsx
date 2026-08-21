import { useQueryClient } from '@tanstack/react-query';
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import {
  getNotifications,
  markNotificationRead,
  openNotificationEventStream,
  switchChatSession,
  type DashboardConfig,
  type NotificationChangeEvent,
  type NotificationRecord,
} from '../../api';
import { queryKeys } from '../../lib/query';
import { notificationQualifies, resolveToastConfig } from './policy';
import { initialToastState, toastReducer } from './reducer';
import { createNotificationChime } from './sound';
import { resolveNotificationTarget } from './targets';
import { ToastViewport } from './toast-viewport';
import type { ToastItem } from './types';

export const missedNotificationReplayWindowMs = 15 * 60_000;

export function NotificationController({
  children,
  config,
}: {
  children: ReactNode;
  config: DashboardConfig;
}) {
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(toastReducer, initialToastState);
  const [actionErrors, setActionErrors] = useState<
    Record<string, string | undefined>
  >({});
  const pendingIdsRef = useRef(new Set<string>());
  const seenNotificationIdsRef = useRef(new Set<string>());
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const toastConfig = useMemo(
    () => resolveToastConfig(config.notifications?.toasts),
    [config.notifications?.toasts],
  );
  const toastConfigRef = useRef(toastConfig);
  const previousToastConfigRef = useRef(toastConfig);
  const notificationChimeRef = useRef<ReturnType<
    typeof createNotificationChime
  > | null>(null);

  useEffect(() => {
    toastConfigRef.current = toastConfig;
    if (!sameToastConfig(previousToastConfigRef.current, toastConfig)) {
      dispatch({ type: 'reconfigure', config: toastConfig, now: Date.now() });
      previousToastConfigRef.current = toastConfig;
    }
  }, [toastConfig]);

  useEffect(() => {
    if (!toastConfig.soundEnabled) return;
    const chime = createNotificationChime();
    const unlock = () => chime.unlock();
    notificationChimeRef.current = chime;
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      if (notificationChimeRef.current === chime) {
        notificationChimeRef.current = null;
      }
      chime.close();
    };
  }, [toastConfig.soundEnabled]);

  useEffect(() => {
    let active = true;
    let reconciliation: Promise<void> | null = null;
    const refreshDependentQueries = () =>
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.runtimeStatus }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.chatSessionActivityRoot,
        }),
      ]);
    const refreshNotificationQueries = () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications });
      refreshDependentQueries();
    };
    const projectEvent = (event: NotificationChangeEvent) => {
      const currentToastConfig = toastConfigRef.current;
      const alreadySeen = seenNotificationIdsRef.current.has(
        event.notification.id,
      );
      if (event.action === 'created' || event.action === 'reconciled') {
        seenNotificationIdsRef.current.add(event.notification.id);
      }
      if (
        event.action === 'created' &&
        !alreadySeen &&
        currentToastConfig.soundEnabled &&
        notificationQualifies(event.notification, currentToastConfig)
      ) {
        notificationChimeRef.current?.play();
      }
      dispatch({
        type: 'notification-event',
        event,
        config: currentToastConfig,
        now: Date.now(),
      });
    };
    const reconcileNotifications = () => {
      if (reconciliation) return reconciliation;
      reconciliation = getNotifications()
        .then((response) => {
          if (!active) return;
          queryClient.setQueryData(queryKeys.notifications, response);
          const currentToastConfig = toastConfigRef.current;
          const recovered = replayableNotifications(
            response.items,
            currentToastConfig,
            Date.now(),
            seenNotificationIdsRef.current,
          );
          for (const notification of recovered) {
            seenNotificationIdsRef.current.add(notification.id);
            dispatch({
              type: 'notification-event',
              event: {
                id: notification.id,
                action: 'created',
                notification,
                changedAt: notification.updatedAt,
              },
              config: currentToastConfig,
              now: Date.now(),
            });
          }
          if (recovered.length > 0 && currentToastConfig.soundEnabled) {
            notificationChimeRef.current?.play();
          }
        })
        .catch((error) => {
          if (!active) return;
          console.warn(
            '[neondeck] notification reconciliation failed; retrying after reconnect',
            error,
          );
        })
        .finally(() => {
          reconciliation = null;
        });
      return reconciliation;
    };

    void reconcileNotifications();
    const unsubscribe = openNotificationEventStream(
      (event) => {
        refreshNotificationQueries();
        projectEvent(event);
      },
      undefined,
      () => {
        void reconcileNotifications();
      },
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [queryClient]);

  const dismiss = useCallback((item: ToastItem) => {
    dispatch({ type: 'remove', id: item.notification.id });
  }, []);

  const runDurableAction = useCallback(
    async (item: ToastItem, action: () => Promise<void>) => {
      const id = item.notification.id;
      if (pendingIdsRef.current.has(id)) return;
      pendingIdsRef.current.add(id);
      setPendingIds(new Set(pendingIdsRef.current));
      setActionErrors((current) => ({ ...current, [id]: undefined }));
      try {
        await action();
        await markNotificationRead(id);
        dispatch({ type: 'remove', id });
        setActionErrors((current) => {
          const next = { ...current };
          delete next[id];
          return next;
        });
      } catch (error) {
        setActionErrors((current) => ({
          ...current,
          [id]: error instanceof Error ? error.message : String(error),
        }));
      } finally {
        pendingIdsRef.current.delete(id);
        setPendingIds(new Set(pendingIdsRef.current));
      }
    },
    [],
  );

  const acknowledge = useCallback(
    (item: ToastItem) => {
      void runDurableAction(item, async () => {});
    },
    [runDurableAction],
  );

  const open = useCallback(
    (item: ToastItem) => {
      const target = resolveNotificationTarget(item.notification);
      void runDurableAction(item, async () => {
        if (target.kind === 'session') {
          if (!dispatchPluginNavigation('flue-chat')) {
            throw new Error('Chat is not available in this dashboard layout.');
          }
          const result = await switchChatSession(target.sessionId);
          if (!result.ok) throw new Error(result.message);
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: queryKeys.neonSession }),
            queryClient.invalidateQueries({ queryKey: queryKeys.chatSessions }),
          ]);
          return;
        }
        if (target.kind === 'plugin') {
          if (!dispatchPluginNavigation(target.pluginId)) {
            throw new Error(
              `${target.label.replace(/^Open /, '')} is not available in this dashboard layout.`,
            );
          }
          return;
        }
        window.open(target.href, '_blank', 'noopener,noreferrer');
      });
    },
    [queryClient, runDurableAction],
  );

  const visibleItems = state.items.slice(-toastConfig.maxVisible);
  return (
    <>
      {children}
      <ToastViewport
        actionErrors={actionErrors}
        density={config.appearance?.density ?? 'comfortable'}
        items={visibleItems}
        onAcknowledge={acknowledge}
        onDismiss={dismiss}
        onOpen={open}
        pendingIds={pendingIds}
        statuslinePosition={config.statusline?.position}
      />
    </>
  );
}

export function replayableNotifications(
  notifications: readonly NotificationRecord[],
  config: ReturnType<typeof resolveToastConfig>,
  now: number,
  seenIds: ReadonlySet<string>,
) {
  const cutoff = now - missedNotificationReplayWindowMs;
  return notifications
    .filter((notification) => {
      const updatedAt = Date.parse(notification.updatedAt);
      return (
        !seenIds.has(notification.id) &&
        Number.isFinite(updatedAt) &&
        updatedAt >= cutoff &&
        notificationQualifies(notification, config)
      );
    })
    .sort(
      (left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt),
    )
    .slice(-config.maxVisible);
}

export function dispatchPluginNavigation(pluginId: string) {
  const detail = { pluginId, handled: false };
  const dispatched = window.dispatchEvent(
    new CustomEvent('neondeck:navigate', {
      cancelable: true,
      detail,
    }),
  );
  return detail.handled || !dispatched;
}

function sameToastConfig(
  left: ReturnType<typeof resolveToastConfig>,
  right: ReturnType<typeof resolveToastConfig>,
) {
  return (
    left.enabled === right.enabled &&
    left.minimumLevel === right.minimumLevel &&
    left.readyDurationMs === right.readyDurationMs &&
    left.maxVisible === right.maxVisible
  );
}
