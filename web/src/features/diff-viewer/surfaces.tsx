import { useEffect, useMemo, useState } from 'react';
import type {
  AutopilotPreparedDiff,
  DiffSummary,
  KiloTaskRecord,
  LearningCandidate,
  RepoEditEvent,
} from '../../api';
import { Badge, MiniEmpty } from '../../components/ui';
import { queryErrorMessage } from '../../lib/query';
import {
  firstRenderablePath,
  patchHasContent,
  splitUnifiedPatchFiles,
} from './helpers';
import { MultiFileView } from './MultiFileView';
import {
  useKiloTaskDiff,
  usePreparedDiffFilePatch,
  usePreparedDiffFiles,
  useRepoDiff,
} from './queries';
import type { DiffFilePatch } from './types';
import { DiffWorkerProvider, UnifiedPatchView } from './DiffViewer';
import {
  kiloResultReviewSource,
  preparedDiffReviewSource,
  repoEditEventReviewSource,
  skillPatchReviewSource,
} from './review-source';

export function PreparedDiffReview({ diff }: { diff: AutopilotPreparedDiff }) {
  const filesQuery = usePreparedDiffFiles(diff.id);
  const files = useMemo(
    () => filesQuery.data?.files ?? [],
    [filesQuery.data?.files],
  );
  const [activePath, setActivePath] = useState<string | null>(null);

  useEffect(() => {
    if (activePath && files.some((file) => file.path === activePath)) return;
    setActivePath(firstRenderablePath(files) ?? null);
  }, [activePath, files]);

  const filePatchQuery = usePreparedDiffFilePatch(diff.id, activePath);
  const activePatch =
    filePatchQuery.data?.diff ?? filePatchQuery.data?.file?.patch;
  const viewFiles = useMemo(
    () =>
      files.map((file) =>
        file.path === activePath
          ? {
              ...file,
              message: filePatchQuery.data?.message,
              patch: activePatch ?? null,
              truncated: filePatchQuery.data?.file?.truncated ?? file.truncated,
            }
          : file,
      ),
    [
      activePatch,
      activePath,
      filePatchQuery.data?.file?.truncated,
      filePatchQuery.data?.message,
      files,
    ],
  );
  const source = useMemo(
    () =>
      preparedDiffReviewSource(diff, viewFiles, filesQuery.data?.revision, {
        loadingPaths:
          activePath && filePatchQuery.isLoading
            ? new Set([activePath])
            : undefined,
        unavailablePaths:
          activePath && filePatchQuery.error
            ? new Set([activePath])
            : undefined,
      }),
    [
      activePath,
      diff,
      filePatchQuery.error,
      filePatchQuery.isLoading,
      filesQuery.data?.revision,
      viewFiles,
    ],
  );

  if (filesQuery.isLoading) {
    return <MiniEmpty label="Loading changed files." />;
  }

  if (filesQuery.error) {
    return (
      <MiniEmpty
        label={`Prepared diff unavailable: ${queryErrorMessage(filesQuery.error)}`}
      />
    );
  }

  return (
    <MultiFileView
      activePath={activePath}
      detail={`${diff.verificationStatus} verification - ${diff.pushApprovalStatus} push`}
      emptyLabel="No prepared-diff files."
      files={viewFiles}
      isLoadingPatch={Boolean(activePath) && filePatchQuery.isLoading}
      onActivePathChange={setActivePath}
      patchError={
        filePatchQuery.error ? queryErrorMessage(filePatchQuery.error) : null
      }
      source={source}
      title={diff.title}
      tone="primary"
    />
  );
}

export function SkillPatchDiffReview({
  afterHash,
  candidate,
  patch,
  title = 'Skill patch',
}: {
  afterHash?: string | null;
  candidate: Pick<LearningCandidate, 'id' | 'repoId' | 'skillId'>;
  patch: string | null | undefined;
  title?: string;
}) {
  const files = useMemo(() => splitUnifiedPatchFiles(patch), [patch]);
  const source = useMemo(
    () => skillPatchReviewSource(candidate, files, afterHash, title),
    [afterHash, candidate, files, title],
  );

  if (files.length > 1) {
    return (
      <MultiFileView
        detail="Learning candidate patch"
        emptyLabel="No patch content available."
        files={files}
        source={source}
        title={title}
        tone="violet"
      />
    );
  }

  return (
    <DiffWorkerProvider>
      <UnifiedPatchView
        detail="Learning candidate patch"
        patch={patch}
        source={source}
        title={title}
        tone="violet"
      />
    </DiffWorkerProvider>
  );
}

export function KiloTaskDiffReview({ task }: { task: KiloTaskRecord }) {
  const repoDiffQuery = useRepoDiff({
    repoId: task.repoId,
    worktreeId: task.worktreeId,
    enabled: Boolean(task.repoId),
  });
  const kiloDiffQuery = useKiloTaskDiff(task.id);
  const repoFiles = useMemo(
    () => repoDiffQuery.data?.files ?? [],
    [repoDiffQuery.data?.files],
  );
  const fallbackFiles = useMemo(
    () => kiloSummaryFiles(kiloDiffQuery.data?.diff ?? task.diff),
    [kiloDiffQuery.data?.diff, task.diff],
  );
  const files = useMemo(
    () => (repoFiles.length > 0 ? repoFiles : fallbackFiles),
    [fallbackFiles, repoFiles],
  );
  const summary =
    repoDiffQuery.data?.diffSummary ??
    summaryFromKilo(kiloDiffQuery.data?.diff ?? task.diff);
  const source = useMemo(
    () => kiloResultReviewSource(task, files, repoDiffQuery.data?.revision),
    [files, repoDiffQuery.data?.revision, task],
  );

  if (repoDiffQuery.isLoading) {
    return <MiniEmpty label="Loading Kilo diff." />;
  }

  if (repoDiffQuery.error && files.length === 0) {
    return (
      <MiniEmpty
        label={`Kilo diff unavailable: ${queryErrorMessage(repoDiffQuery.error)}`}
      />
    );
  }

  return (
    <MultiFileView
      detail={summary ? summaryLabel(summary) : task.cwd}
      emptyLabel="No Kilo changes to render."
      files={files}
      patchError={
        repoDiffQuery.error ? queryErrorMessage(repoDiffQuery.error) : null
      }
      source={source}
      title={task.title}
      tone="violet"
    />
  );
}

export function RepoEditEventDiffReview({ event }: { event: RepoEditEvent }) {
  const hasStoredPatch = patchHasContent(event.diffPatch);
  const storedFiles = useMemo(
    () => splitUnifiedPatchFiles(event.diffPatch),
    [event.diffPatch],
  );
  const source = useMemo(
    () => repoEditEventReviewSource(event, storedFiles),
    [event, storedFiles],
  );

  if (hasStoredPatch) {
    if (storedFiles.length > 1) {
      return (
        <MultiFileView
          detail={event.reason ?? event.action}
          emptyLabel="No repo-edit patch available."
          files={storedFiles}
          source={source}
          title={`${event.repoId} - ${event.action}`}
          tone={event.status === 'failed' ? 'accent' : 'primary'}
        />
      );
    }

    return (
      <DiffWorkerProvider>
        <UnifiedPatchView
          detail={event.reason ?? event.action}
          meta={<Badge>{event.status}</Badge>}
          patch={event.diffPatch}
          source={source}
          title={`${event.repoId} - ${event.action}`}
          tone={event.status === 'failed' ? 'accent' : 'primary'}
        />
      </DiffWorkerProvider>
    );
  }

  return (
    <MiniEmpty label="No captured repo-edit patch is available for this historical event." />
  );
}

function kiloSummaryFiles(
  diff: KiloTaskRecord['diff'] | undefined,
): DiffFilePatch[] {
  if (!diff?.ok) return [];
  return diff.files.map((file) => ({
    ...file,
    binary: false,
    generatedLike: false,
    message: 'The Kilo diff route returned summary metadata only.',
    patch: null,
  }));
}

function summaryFromKilo(
  diff: KiloTaskRecord['diff'] | undefined,
): DiffSummary | null {
  if (!diff?.ok) return null;
  return {
    additions: diff.additions,
    binaryFiles: diff.binaryFiles,
    deletions: diff.deletions,
    files: diff.fileCount,
  };
}

function summaryLabel(summary: DiffSummary) {
  return `${summary.files} files - +${summary.additions} -${summary.deletions} - ${summary.binaryFiles} binary`;
}
