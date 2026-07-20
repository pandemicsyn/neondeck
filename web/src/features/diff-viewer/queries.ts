import { useQuery } from '@tanstack/react-query';
import {
  getKiloTaskDiff,
  getPreparedDiffFileDiff,
  getPreparedDiffFiles,
  getRepoDiff,
} from '../../api';
import { assertReviewRevisionCurrent } from '../../../../shared/review-refresh';

const maxPatchBytes = 256 * 1024;

export const diffViewerQueryKeys = {
  preparedDiffFiles: (preparedDiffId: string) =>
    ['diff-viewer', 'prepared-diff-files', preparedDiffId] as const,
  preparedDiffFile: (
    preparedDiffId: string,
    revisionKey: string | null,
    path: string | null,
  ) =>
    [
      'diff-viewer',
      'prepared-diff-file',
      preparedDiffId,
      revisionKey,
      path,
    ] as const,
  kiloTaskDiff: (taskId: string) =>
    ['diff-viewer', 'kilo-task-diff', taskId] as const,
  repoDiff: (input: {
    repoId: string;
    worktreeId?: string | null;
    base?: string;
    paths?: string[];
    revisionKey?: string | null;
  }) =>
    [
      'diff-viewer',
      'repo-diff',
      input.repoId,
      input.worktreeId ?? null,
      input.base ?? null,
      input.paths?.join('\0') ?? '',
      input.revisionKey ?? null,
    ] as const,
};

export function usePreparedDiffFiles(preparedDiffId: string) {
  return useQuery({
    queryKey: diffViewerQueryKeys.preparedDiffFiles(preparedDiffId),
    queryFn: ({ signal }) => getPreparedDiffFiles(preparedDiffId, { signal }),
    enabled: preparedDiffId.length > 0,
    refetchInterval: 30_000,
  });
}

export function usePreparedDiffFilePatch(
  preparedDiffId: string,
  revisionKey: string | null,
  path: string | null,
) {
  return useQuery({
    queryKey: diffViewerQueryKeys.preparedDiffFile(
      preparedDiffId,
      revisionKey,
      path,
    ),
    queryFn: async ({ signal }) => {
      const result = await getPreparedDiffFileDiff(
        {
          preparedDiffId,
          path: path ?? '',
          expectedRevisionKey: revisionKey ?? undefined,
          maxPatchBytes,
        },
        { signal },
      );
      assertReviewRevisionCurrent(
        revisionKey,
        result.revision!,
        'The prepared diff changed while loading this patch.',
      );
      return result;
    },
    staleTime: Infinity,
    enabled: preparedDiffId.length > 0 && Boolean(path) && Boolean(revisionKey),
  });
}

export function useKiloTaskDiff(taskId: string) {
  return useQuery({
    queryKey: diffViewerQueryKeys.kiloTaskDiff(taskId),
    queryFn: ({ signal }) => getKiloTaskDiff(taskId, { signal }),
    enabled: taskId.length > 0,
  });
}

export function useRepoDiff(input: {
  repoId: string;
  worktreeId?: string | null;
  base?: string;
  paths?: string[];
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: diffViewerQueryKeys.repoDiff(input),
    queryFn: ({ signal }) =>
      getRepoDiff(
        {
          repoId: input.repoId,
          worktreeId: input.worktreeId,
          base: input.base,
          paths: input.paths,
          includePatch: false,
          maxPatchBytes,
        },
        { signal },
      ),
    enabled: (input.enabled ?? true) && input.repoId.length > 0,
    refetchInterval: 30_000,
  });
}

export function useRepoDiffFilePatch(input: {
  repoId: string;
  worktreeId?: string | null;
  base?: string;
  path: string | null;
  revisionKey: string | null;
}) {
  return useQuery({
    queryKey: diffViewerQueryKeys.repoDiff({
      repoId: input.repoId,
      worktreeId: input.worktreeId,
      base: input.base,
      paths: input.path ? [input.path] : [],
      revisionKey: input.revisionKey,
    }),
    queryFn: async ({ signal }) => {
      const result = await getRepoDiff(
        {
          repoId: input.repoId,
          worktreeId: input.worktreeId,
          base: input.base,
          paths: input.path ? [input.path] : undefined,
          includePatch: true,
          maxPatchBytes,
          expectedRevisionKey: input.revisionKey ?? undefined,
        },
        { signal },
      );
      assertReviewRevisionCurrent(
        input.revisionKey,
        result.revision!,
        'The worktree changed while loading this patch.',
      );
      return result;
    },
    staleTime: Infinity,
    enabled:
      input.repoId.length > 0 &&
      Boolean(input.path) &&
      Boolean(input.revisionKey),
  });
}
