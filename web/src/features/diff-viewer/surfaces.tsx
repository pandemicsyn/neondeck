import { useEffect, useMemo, useState } from 'react';
import type {
  AutopilotPreparedDiff,
  DiffSummary,
  KiloTaskRecord,
  RepoEditEvent,
} from '../../api';
import { Badge, MiniEmpty } from '../../components/ui';
import { queryErrorMessage } from '../../lib/query';
import {
  diffFileCountLabel,
  firstRenderablePath,
  patchFilePaths,
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
import { UnifiedPatchView } from './DiffViewer';

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
  const viewFiles = files.map((file) =>
    file.path === activePath
      ? {
          ...file,
          message: filePatchQuery.data?.message,
          patch: activePatch ?? null,
          truncated: filePatchQuery.data?.file?.truncated ?? file.truncated,
        }
      : file,
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
      title={diff.title}
      tone="primary"
    />
  );
}

export function SkillPatchDiffReview({
  patch,
  title = 'Skill patch',
}: {
  patch: string | null | undefined;
  title?: string;
}) {
  const files = useMemo(() => splitUnifiedPatchFiles(patch), [patch]);

  if (files.length > 1) {
    return (
      <MultiFileView
        detail="Learning candidate patch"
        emptyLabel="No patch content available."
        files={files}
        title={title}
        tone="violet"
      />
    );
  }

  return (
    <UnifiedPatchView
      detail="Learning candidate patch"
      patch={patch}
      title={title}
      tone="violet"
    />
  );
}

export function KiloTaskDiffReview({ task }: { task: KiloTaskRecord }) {
  const repoDiffQuery = useRepoDiff({
    repoId: task.repoId,
    worktreeId: task.worktreeId,
    enabled: Boolean(task.repoId),
  });
  const kiloDiffQuery = useKiloTaskDiff(task.id);
  const repoFiles = repoDiffQuery.data?.files ?? [];
  const fallbackFiles = useMemo(
    () => kiloSummaryFiles(kiloDiffQuery.data?.diff ?? task.diff),
    [kiloDiffQuery.data?.diff, task.diff],
  );
  const files = repoFiles.length > 0 ? repoFiles : fallbackFiles;
  const summary =
    repoDiffQuery.data?.diffSummary ??
    summaryFromKilo(kiloDiffQuery.data?.diff ?? task.diff);

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
      title={task.title}
      tone="violet"
    />
  );
}

export function RepoEditEventDiffReview({ event }: { event: RepoEditEvent }) {
  const hasStoredPatch = patchHasContent(event.diffPatch);
  const paths =
    event.paths.length > 0 ? event.paths : patchFilePaths(event.diffPatch);
  const storedFiles = useMemo(
    () => splitUnifiedPatchFiles(event.diffPatch),
    [event.diffPatch],
  );
  const repoDiffQuery = useRepoDiff({
    enabled: !hasStoredPatch && paths.length > 0,
    paths,
    repoId: event.repoId,
    worktreeId: event.worktreeId,
  });

  if (hasStoredPatch) {
    if (storedFiles.length > 1) {
      return (
        <MultiFileView
          detail={event.reason ?? event.action}
          emptyLabel="No repo-edit patch available."
          files={storedFiles}
          title={`${event.repoId} - ${event.action}`}
          tone={event.status === 'failed' ? 'accent' : 'primary'}
        />
      );
    }

    return (
      <UnifiedPatchView
        detail={event.reason ?? event.action}
        meta={<Badge>{event.status}</Badge>}
        patch={event.diffPatch}
        title={`${event.repoId} - ${event.action}`}
        tone={event.status === 'failed' ? 'accent' : 'primary'}
      />
    );
  }

  if (repoDiffQuery.isLoading) {
    return <MiniEmpty label="Loading repo-edit diff." />;
  }

  if (repoDiffQuery.error) {
    return (
      <MiniEmpty
        label={`Repo-edit diff unavailable: ${queryErrorMessage(repoDiffQuery.error)}`}
      />
    );
  }

  return (
    <MultiFileView
      detail={event.reason ?? diffFileCountLabel(paths.length)}
      emptyLabel="No repo-edit patch available."
      files={repoDiffQuery.data?.files ?? []}
      title={`${event.repoId} - ${event.action}`}
      tone={event.status === 'failed' ? 'accent' : 'primary'}
    />
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
