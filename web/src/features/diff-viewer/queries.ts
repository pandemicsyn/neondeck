import { useQuery } from '@tanstack/react-query';
import {
  getKiloTaskDiff,
  getPreparedDiffFileDiff,
  getPreparedDiffFiles,
  getRepoDiff,
} from '../../api';

const maxPatchBytes = 256 * 1024;

export const diffViewerQueryKeys = {
  preparedDiffFiles: (preparedDiffId: string) =>
    ['diff-viewer', 'prepared-diff-files', preparedDiffId] as const,
  preparedDiffFile: (preparedDiffId: string, path: string | null) =>
    ['diff-viewer', 'prepared-diff-file', preparedDiffId, path] as const,
  kiloTaskDiff: (taskId: string) =>
    ['diff-viewer', 'kilo-task-diff', taskId] as const,
  repoDiff: (input: {
    repoId: string;
    worktreeId?: string | null;
    paths?: string[];
  }) =>
    [
      'diff-viewer',
      'repo-diff',
      input.repoId,
      input.worktreeId ?? null,
      input.paths?.join('\0') ?? '',
    ] as const,
};

export function usePreparedDiffFiles(preparedDiffId: string) {
  return useQuery({
    queryKey: diffViewerQueryKeys.preparedDiffFiles(preparedDiffId),
    queryFn: ({ signal }) => getPreparedDiffFiles(preparedDiffId, { signal }),
    enabled: preparedDiffId.length > 0,
  });
}

export function usePreparedDiffFilePatch(
  preparedDiffId: string,
  path: string | null,
) {
  return useQuery({
    queryKey: diffViewerQueryKeys.preparedDiffFile(preparedDiffId, path),
    queryFn: ({ signal }) =>
      getPreparedDiffFileDiff(
        {
          preparedDiffId,
          path: path ?? '',
          maxPatchBytes,
        },
        { signal },
      ),
    enabled: preparedDiffId.length > 0 && Boolean(path),
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
          paths: input.paths,
          includePatch: true,
          maxPatchBytes,
        },
        { signal },
      ),
    enabled: (input.enabled ?? true) && input.repoId.length > 0,
  });
}
