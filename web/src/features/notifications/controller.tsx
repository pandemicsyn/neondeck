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
  markNotificationRead,
  openNotificationEventStream,
  switchChatSession,
  type DashboardConfig,
} from '../../api';
import { queryKeys } from '../../lib/query';
import { resolveToastConfig } from './policy';
import { initialToastState, toastReducer } from './reducer';
import { resolveNotificationTarget } from './targets';
import { ToastViewport } from './toast-viewport';
import type { ToastItem } from './types';

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
  const [pendingIds, setPendingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const toastConfig = useMemo(
    () => resolveToastConfig(config.notifications?.toasts),
    [config.notifications?.toasts],
  );
  const toastConfigRef = useRef(toastConfig);
  const previousToastConfigRef = useRef(toastConfig);

  useEffect(() => {
    toastConfigRef.current = toastConfig;
    if (!sameToastConfig(previousToastConfigRef.current, toastConfig)) {
      dispatch({ type: 'reconfigure', config: toastConfig, now: Date.now() });
      previousToastConfigRef.current = toastConfig;
    }
  }, [toastConfig]);

  useEffect(() => {
    return openNotificationEventStream((event) => {
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.notifications }),
        queryClient.invalidateQueries({ queryKey: queryKeys.runtimeStatus }),
      ]);
      dispatch({
        type: 'notification-event',
        event,
        config: toastConfigRef.current,
        now: Date.now(),
      });
    });
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

export function dispatchPluginNavigation(pluginId: string) {
  const detail = { pluginId, handled: false };
  window.dispatchEvent(new CustomEvent('neondeck:navigate', { detail }));
  return detail.handled;
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
