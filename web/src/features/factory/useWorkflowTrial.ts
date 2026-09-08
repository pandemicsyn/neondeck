import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { RepoWorkflowRun } from '../../../../shared/repo-workflow-runs';
import {
  getCurrentRepoWorkflowRun,
  startRepoWorkflowRun,
} from './workflow-api';

function completed(run: RepoWorkflowRun | null | undefined) {
  return (
    !!run &&
    run.status !== 'running' &&
    run.status !== 'uncertain' &&
    run.phase === 'complete' &&
    run.cleanup === 'complete'
  );
}

export function useWorkflowTrial(repoId: string, active: boolean) {
  const client = useQueryClient();
  const key = ['repo-workflow-current', repoId];
  const [lastRun, setLastRun] = useState<RepoWorkflowRun | null>(null);
  const starting = useRef(false);
  const [busy, setBusy] = useState(false);
  const discovery = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => getCurrentRepoWorkflowRun(repoId, { signal }),
    enabled: active,
    retry: false,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchInterval: (query) => {
      const owned = query.state.data?.run;
      const latest = owned?.runId === lastRun?.runId ? lastRun : owned;
      // Completion can be persisted before the lock is released. Only poll
      // that gap; stop on a lookup error and leave explicit retry available.
      return query.state.status !== 'error' && owned && completed(latest)
        ? 1000
        : false;
    },
  });
  const owned = discovery.data?.run;
  useEffect(() => {
    if (owned)
      // Retain externally discovered identity after its server lock disappears.
      // oxlint-disable-next-line react/set-state-in-effect
      setLastRun((previous) =>
        previous?.runId === owned.runId ? previous : owned,
      );
  }, [owned]);
  // Discovery identifies ownership; it must not overwrite newer observations
  // from the status endpoint for that same run (including transient uncertainty).
  const run =
    owned && owned.runId !== lastRun?.runId ? owned : (lastRun ?? owned);
  const observedBlocked =
    !!run &&
    (run.status === 'running' ||
      run.status === 'uncertain' ||
      run.cleanup === 'retained' ||
      run.phase !== 'complete');
  const observed = useCallback(
    (result: RepoWorkflowRun) => {
      setLastRun(result);
      if (
        result.status !== 'running' &&
        (result.phase === 'complete' || result.cleanup === 'retained')
      ) {
        void client.invalidateQueries({
          queryKey: ['repo-workflow-current', repoId],
        });
      }
    },
    [client, repoId],
  );
  async function start(profileId: string, expectedFingerprint: string) {
    if (
      starting.current ||
      observedBlocked ||
      discovery.isPending ||
      discovery.isFetching ||
      discovery.isError ||
      discovery.data?.run
    )
      return;
    starting.current = true;
    setBusy(true);
    try {
      // A fresh lock read closes the gap between mount and this explicit click.
      await client.cancelQueries({ queryKey: key });
      const current = await discovery.refetch({ throwOnError: true });
      if (current.data?.run) return;
      try {
        const next = await startRepoWorkflowRun(repoId, {
          profileId,
          expectedFingerprint,
        });
        await client.cancelQueries({ queryKey: key });
        setLastRun(next);
        client.setQueryData(key, { run: next });
      } catch (error) {
        // The server may have accepted a request whose response was lost.
        const recovered = await discovery.refetch();
        // An owned run may also belong to a concurrent request. Show its
        // progress without claiming this particular start succeeded.
        if (!recovered.isSuccess || !recovered.data.run) throw error;
      }
    } finally {
      starting.current = false;
      setBusy(false);
    }
  }
  return {
    run,
    observed,
    start,
    discovery,
    waitingForRelease: !!owned && completed(run),
    blocked:
      !active ||
      observedBlocked ||
      busy ||
      discovery.isPending ||
      discovery.isFetching ||
      discovery.isError ||
      !!discovery.data?.run,
  };
}
