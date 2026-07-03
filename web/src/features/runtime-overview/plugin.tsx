import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import {
  getExecutionApprovals,
  getKiloTasks,
  getMemories,
  getNotifications,
  getRepoEditEvents,
  getRepoHealth,
  getRepoRegistry,
  getRuntimeSkills,
  getRuntimeStatus,
  getSafetyPolicy,
  getSchedulerJobs,
  getWorkflowObservability,
  getWorktrees,
  openNotificationEventStream,
} from '../../api';
import { EmptyState } from '../../App';
import { useConfigEvents } from '../../lib/config-events';
import { queryErrorMessage, queryKeys } from '../../lib/query';
import type { DisplayPlugin } from '../../types';
import { parsePositiveIntegerConfig } from '../../plugins/config';
import { RuntimeView } from './components/runtime-view';
import { invalidateRuntimeQueries, runtimeSnapshotFromQueries } from './queries';
import { runtimeOverviewDefaultConfig, type RuntimeOverviewConfig } from './types';

export const RuntimeOverviewPlugin = {
  id: 'runtime-overview',
  title: 'Runtime overview',
  kind: 'data',
  defaultConfig: runtimeOverviewDefaultConfig,
  parseConfig: (config) =>
    parsePositiveIntegerConfig(runtimeOverviewDefaultConfig, config),
  Component({ config }) {
    const queryClient = useQueryClient();
    const [
      statusQuery,
      registryQuery,
      repoHealthQuery,
      jobsQuery,
      skillsQuery,
      memoriesQuery,
      notificationsQuery,
      executionApprovalsQuery,
      safetyQuery,
      workflowsQuery,
      kiloTasksQuery,
      repoEditEventsQuery,
      worktreesQuery,
    ] = useQueries({
      queries: [
        {
          queryKey: queryKeys.runtimeStatus,
          queryFn: getRuntimeStatus,
          refetchInterval: 30_000,
        },
        {
          queryKey: queryKeys.repoRegistry,
          queryFn: getRepoRegistry,
          refetchInterval: 30_000,
        },
        {
          queryKey: queryKeys.repoHealth,
          queryFn: getRepoHealth,
          refetchInterval: 30_000,
        },
        {
          queryKey: queryKeys.schedulerJobs,
          queryFn: getSchedulerJobs,
          refetchInterval: 30_000,
        },
        {
          queryKey: queryKeys.runtimeSkills,
          queryFn: getRuntimeSkills,
          refetchInterval: 30_000,
        },
        {
          queryKey: queryKeys.memories,
          queryFn: () => getMemories(),
          refetchInterval: 30_000,
        },
        {
          queryKey: queryKeys.notifications,
          queryFn: getNotifications,
          refetchInterval: 30_000,
        },
        {
          queryKey: queryKeys.executionApprovals,
          queryFn: () => getExecutionApprovals({ includeResolved: true }),
          refetchInterval: 30_000,
        },
        {
          queryKey: queryKeys.safetyPolicy,
          queryFn: getSafetyPolicy,
          refetchInterval: 30_000,
        },
        {
          queryKey: queryKeys.workflowObservability,
          queryFn: getWorkflowObservability,
          refetchInterval: 30_000,
        },
        {
          queryKey: queryKeys.kiloTasks,
          queryFn: getKiloTasks,
          refetchInterval: 15_000,
        },
        {
          queryKey: queryKeys.repoEditEvents,
          queryFn: getRepoEditEvents,
          refetchInterval: 30_000,
        },
        {
          queryKey: queryKeys.worktrees,
          queryFn: getWorktrees,
          refetchInterval: 30_000,
        },
      ],
    });

    useConfigEvents(() => {
      void invalidateRuntimeQueries(queryClient);
    });

    useEffect(() => {
      return openNotificationEventStream(() => {
        void Promise.all([
          queryClient.invalidateQueries({
            queryKey: queryKeys.notifications,
          }),
          queryClient.invalidateQueries({
            queryKey: queryKeys.runtimeStatus,
          }),
        ]);
      });
    }, [queryClient]);

    if (statusQuery.isLoading) {
      return (
        <EmptyState title="Runtime loading" detail="Reading backend state." />
      );
    }

    if (statusQuery.error) {
      return (
        <EmptyState
          title="Runtime unavailable"
          detail={queryErrorMessage(statusQuery.error)}
        />
      );
    }

    const status = statusQuery.data;
    if (!status) {
      return <EmptyState title="Runtime unavailable" detail="No data." />;
    }

    const snapshot = runtimeSnapshotFromQueries(status, {
      registry: registryQuery,
      repoHealth: repoHealthQuery,
      jobs: jobsQuery,
      skills: skillsQuery,
      memories: memoriesQuery,
      notifications: notificationsQuery,
      executionApprovals: executionApprovalsQuery,
      safety: safetyQuery,
      workflows: workflowsQuery,
      kiloTasks: kiloTasksQuery,
      repoEditEvents: repoEditEventsQuery,
      worktrees: worktreesQuery,
    });

    if (!snapshot) {
      return <EmptyState title="Runtime unavailable" detail="No data." />;
    }

    return (
      <RuntimeView
        config={config}
        onRefresh={() => void invalidateRuntimeQueries(queryClient)}
        snapshot={snapshot}
      />
    );
  },
} satisfies DisplayPlugin<RuntimeOverviewConfig>;
