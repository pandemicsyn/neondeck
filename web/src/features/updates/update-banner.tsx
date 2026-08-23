import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
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
  const [dismissPending, setDismissPending] = useState(false);
  const [dismissError, setDismissError] = useState<string | null>(null);
  const { data } = useQuery({
    queryKey: queryKeys.updateStatus,
    queryFn: getUpdateStatus,
    refetchInterval: 6 * 60 * 60_000,
  });
  if (!data?.enabled) return null;
  if (data.currentVersion !== dashboardVersion) {
    return (
      <output aria-live="polite" className="update-banner">
        <span className="update-banner-signal">updated</span>
        <span className="update-banner-message">
          Neondeck {data.currentVersion} is running. Reload this dashboard to
          use the matching interface.
        </span>
        <button
          className="update-banner-action"
          onClick={() => window.location.reload()}
          type="button"
        >
          Reload
        </button>
      </output>
    );
  }
  if (!data.updateAvailable || data.dismissed || !data.latestVersion) {
    return null;
  }

  const latestVersion = data.latestVersion;
  const notificationId = `neondeck-update:${latestVersion}`;
  const markSeen = () => {
    void markNotificationRead(notificationId)
      .catch(() => undefined)
      .finally(() => {
        void queryClient.invalidateQueries({
          queryKey: queryKeys.notifications,
        });
      });
  };
  const dismiss = async () => {
    if (dismissPending) return;
    setDismissPending(true);
    setDismissError(null);
    try {
      const status = await dismissUpdate(latestVersion);
      queryClient.setQueryData(queryKeys.updateStatus, status);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.notifications,
      });
    } catch (error) {
      setDismissError(error instanceof Error ? error.message : String(error));
    } finally {
      setDismissPending(false);
    }
  };

  return (
    <output aria-live="polite" className="update-banner">
      <span className="update-banner-signal">update</span>
      <span className="update-banner-message">
        Neondeck {latestVersion} is available
        <span className="update-banner-current">
          {' '}
          · running {data.currentVersion}
        </span>
      </span>
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
        disabled={dismissPending}
        onClick={() => void dismiss()}
        type="button"
      >
        ×
      </button>
    </output>
  );
}
