import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  dismissUpdate,
  getUpdateStatus,
  markNotificationRead,
} from '../../api';
import { queryKeys } from '../../lib/query';

export function UpdateBanner({
  dashboardVersion = import.meta.env.VITE_NEONDECK_VERSION,
}: {
  dashboardVersion?: string;
} = {}) {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: queryKeys.updateStatus,
    queryFn: getUpdateStatus,
    refetchInterval: 6 * 60 * 60_000,
  });
  const dismissMutation = useMutation({
    mutationFn: dismissUpdate,
    onSuccess: async (status) => {
      queryClient.setQueryData(queryKeys.updateStatus, status);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.notifications,
      });
    },
  });
  if (!data?.enabled) return null;
  if (data.currentVersion !== dashboardVersion) {
    return (
      <BannerShell
        message={
          <>
            Neondeck {data.currentVersion} is running. Reload this dashboard to
            use the matching interface.
          </>
        }
        signal="updated"
      >
        <button
          className="update-banner-action"
          onClick={() => window.location.reload()}
          type="button"
        >
          Reload
        </button>
      </BannerShell>
    );
  }
  if (!data.updateAvailable || data.dismissed || !data.latestVersion) {
    return null;
  }

  const latestVersion = data.latestVersion;
  const markSeen = () => {
    if (!data.notificationId) return;
    void markNotificationRead(data.notificationId)
      .catch(() => undefined)
      .finally(() => {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.notifications,
        });
      });
  };
  const dismissError = dismissMutation.error
    ? dismissMutation.error instanceof Error
      ? dismissMutation.error.message
      : String(dismissMutation.error)
    : null;

  return (
    <BannerShell
      message={
        <>
          Neondeck {latestVersion} is available
          <span className="update-banner-current">
            {' '}
            · running {data.currentVersion}
          </span>
        </>
      }
      signal="update"
    >
      <a
        className="update-banner-action"
        href={data.docsUrl}
        onClick={markSeen}
        rel="noreferrer"
        target="_blank"
      >
        Upgrade guide
      </a>
      {data.releaseUrl ? (
        <a
          className="update-banner-action update-banner-release"
          href={data.releaseUrl}
          onClick={markSeen}
          rel="noreferrer"
          target="_blank"
        >
          Release notes
        </a>
      ) : null}
      {dismissError ? (
        <span className="update-banner-error" role="alert">
          {dismissError}
        </span>
      ) : null}
      <button
        aria-label={`Dismiss the ${latestVersion} update notice`}
        className="update-banner-dismiss"
        disabled={dismissMutation.isPending}
        onClick={() => dismissMutation.mutate(latestVersion)}
        type="button"
      >
        ×
      </button>
    </BannerShell>
  );
}

function BannerShell({
  children,
  message,
  signal,
}: {
  children: ReactNode;
  message: ReactNode;
  signal: string;
}) {
  return (
    <output aria-live="polite" className="update-banner">
      <span className="update-banner-signal">{signal}</span>
      <span className="update-banner-message">{message}</span>
      {children}
    </output>
  );
}
