import { useCallback, useEffect, useId, useState, type ReactNode } from 'react';
import type { SelectedLineRange } from '@pierre/diffs/react';
import { Badge, MiniEmpty } from '../../components/ui';
import { cn } from '../../lib/cn';
import {
  diffFileCountLabel,
  diffStatsLabel,
  filePatchStatus,
  firstRenderablePath,
  patchHasContent,
} from './helpers';
import { FileTreePane } from './FileTreePane';
import {
  DiffWorkerProvider,
  UnifiedPatchView,
  type DiffNavigationScrollRequest,
} from './DiffViewer';
import type {
  DiffFilePatch,
  DiffReviewAnnotation,
  DiffViewTone,
  FileReviewMapEntry,
} from './types';
import type { ReviewSourceSnapshot } from '../../../../shared/review-source';
import type { NeonReviewFinding } from '../../../../shared/review-finding';
import { reviewSourceDataAttributes } from './review-source';
import { useReviewSurface } from './use-review-surface';
import type { ReviewRefreshStatus } from '../../../../shared/review-refresh';
import { visiblePatchLineKeys } from '../../../../shared/patch-anchors';
import type { ReviewSurfaceNavigationTarget } from '../../../../shared/review-surface';

type MultiFileViewProps = {
  files: DiffFilePatch[];
  title: string;
  detail?: string;
  tone?: DiffViewTone;
  activePath?: string | null;
  onActivePathChange?: (path: string) => void;
  isLoadingPatch?: boolean;
  patchError?: string | null;
  emptyLabel?: string;
  className?: string;
  annotationsByPath?: Record<string, DiffReviewAnnotation[] | undefined>;
  renderAnnotation?: (annotation: DiffReviewAnnotation) => ReactNode;
  selectedLines?: SelectedLineRange | null;
  onSelectedLinesChange?: (selection: SelectedLineRange | null) => void;
  footer?: ReactNode;
  inspector?: ReactNode;
  inspectorLabel?: string;
  source?: ReviewSourceSnapshot;
  reviewMapByPath?: ReadonlyMap<string, FileReviewMapEntry>;
  fileFilter?: string | null;
  onFileFilterChange?: (query: string | null, paths: string[] | null) => void;
  reviewOrder?: readonly string[];
  selectedAnnotationId?: string | null;
  onReviewSurfaceFindingsChange?: (
    surfaceId: string,
    findings: NeonReviewFinding[],
  ) => void;
  onReviewSurfaceIdChange?: (surfaceId: string | null) => void;
  onReviewSurfaceNavigate?: (target: ReviewSurfaceNavigationTarget) => void;
  resolveReviewSurfaceTarget?: (
    target: ReviewSurfaceNavigationTarget,
  ) => boolean | Promise<boolean>;
  refreshStatus?: ReviewRefreshStatus;
  navigationScroll?: DiffNavigationScrollRequest | null;
  contentOverride?: ReactNode;
  columnToolbar?: ReactNode;
  hideFileSelector?: boolean;
};

export function MultiFileView({
  activePath,
  className,
  detail,
  emptyLabel = 'No changed files.',
  files,
  isLoadingPatch = false,
  onActivePathChange,
  patchError,
  annotationsByPath,
  renderAnnotation,
  selectedLines,
  onSelectedLinesChange,
  footer,
  inspector,
  inspectorLabel = 'Diff inspector',
  source,
  reviewMapByPath,
  fileFilter,
  onFileFilterChange,
  reviewOrder,
  selectedAnnotationId,
  onReviewSurfaceFindingsChange,
  onReviewSurfaceIdChange,
  onReviewSurfaceNavigate,
  resolveReviewSurfaceTarget,
  refreshStatus,
  navigationScroll,
  contentOverride,
  columnToolbar,
  hideFileSelector = false,
  title,
  tone = 'primary',
}: MultiFileViewProps) {
  const selectId = useId();
  const [uncontrolledPath, setUncontrolledPath] = useState<string | null>(
    () => firstRenderablePath(files) ?? null,
  );
  const selectedPath = activePath ?? uncontrolledPath;
  const selectedFile =
    files.find((file) => file.path === selectedPath) ?? files[0] ?? null;
  const patch = selectedFile?.patch ?? null;
  const selectPath = useCallback(
    (path: string) => {
      setUncontrolledPath(path);
      onActivePathChange?.(path);
    },
    [onActivePathChange],
  );
  const surfaceId = useReviewSurface(
    source
      ? {
          activePath: selectedFile?.path ?? null,
          fileFilter: fileFilter ?? null,
          onNavigatePath: selectPath,
          onFindingsChange: onReviewSurfaceFindingsChange,
          onSurfaceIdChange: onReviewSurfaceIdChange,
          onNavigateTarget: onReviewSurfaceNavigate,
          canResolveNavigationTarget: (target) =>
            resolveReviewSurfaceTarget?.(target) ??
            reviewSurfaceTargetExists(files, annotationsByPath, target),
          reviewOrder,
          selectedAnnotationId: selectedAnnotationId ?? null,
          selection: selectedLines,
          source,
          refresh: refreshStatus,
        }
      : null,
  );

  useEffect(() => {
    if (selectedPath && files.some((file) => file.path === selectedPath)) {
      return;
    }
    const nextPath = firstRenderablePath(files) ?? null;
    setUncontrolledPath(nextPath);
    if (nextPath && onActivePathChange) onActivePathChange(nextPath);
  }, [files, onActivePathChange, selectedPath]);

  if (files.length === 0) {
    return <MiniEmpty label={emptyLabel} />;
  }

  const status = selectedFile ? filePatchStatus(selectedFile) : null;

  return (
    <section
      className={cn(
        'diff-multi-file',
        inspector ? 'diff-multi-file-with-inspector' : undefined,
        className,
      )}
      {...(source ? reviewSourceDataAttributes(source) : {})}
      {...(surfaceId ? { 'data-review-surface-id': surfaceId } : {})}
    >
      <aside className="diff-tree-pane">
        <FileTreePane
          filterQuery={fileFilter}
          files={files}
          onFilterChange={onFileFilterChange}
          onSelectPath={selectPath}
          reviewMapByPath={reviewMapByPath}
          selectedPath={selectedFile?.path ?? null}
        />
      </aside>
      <div className="diff-file-column">
        {columnToolbar}
        <div className="diff-file-selector" hidden={hideFileSelector}>
          <label className="sr-only" htmlFor={selectId}>
            Changed file
          </label>
          <select
            className="w-full border border-line bg-field px-2 py-1 font-mono text-[10px] text-ink outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-primary"
            id={selectId}
            onChange={(event) => selectPath(event.currentTarget.value)}
            value={selectedFile?.path ?? ''}
          >
            {files.map((file) => (
              <option key={file.path} value={file.path}>
                {file.path}
              </option>
            ))}
          </select>
        </div>
        {contentOverride ?? (
          <DiffWorkerProvider>
            <UnifiedPatchView
              className="min-h-0 flex-1"
              detail={detail ?? selectedFile?.path}
              lineAnnotations={
                selectedFile
                  ? annotationsByPath?.[selectedFile.path]
                  : undefined
              }
              meta={
                selectedFile ? (
                  <>
                    <Badge>{selectedFile.status}</Badge>
                    <Badge>{diffStatsLabel(selectedFile)}</Badge>
                  </>
                ) : (
                  <Badge>{diffFileCountLabel(files.length)}</Badge>
                )
              }
              navigationScroll={navigationScroll}
              patch={patchHasContent(patch) ? patch : null}
              renderAnnotation={renderAnnotation}
              selectedLines={selectedLines}
              onSelectedLinesChange={onSelectedLinesChange}
              title={title}
              tone={tone}
            />
          </DiffWorkerProvider>
        )}
        {isLoadingPatch ? (
          <p className="border-x border-b border-line bg-field px-2 py-1 font-mono text-[10px] text-muted">
            Loading patch...
          </p>
        ) : null}
        {patchError ? (
          <p className="border-x border-b border-line bg-field px-2 py-1 font-mono text-[10px] text-accent">
            {patchError}
          </p>
        ) : null}
        {status && !isLoadingPatch && !patchError ? (
          <p className="border-x border-b border-line bg-field px-2 py-1 font-mono text-[10px] text-muted">
            {status}
          </p>
        ) : null}
        {footer}
      </div>
      {inspector ? (
        <aside aria-label={inspectorLabel} className="diff-inspector-pane">
          {inspector}
        </aside>
      ) : null}
    </section>
  );
}

export function reviewSurfaceTargetExists(
  files: readonly DiffFilePatch[],
  annotationsByPath:
    Record<string, DiffReviewAnnotation[] | undefined> | undefined,
  target: ReviewSurfaceNavigationTarget,
) {
  if (
    target.annotationId &&
    !reviewSurfaceAnnotationMatchesTarget(
      annotationsByPath?.[target.path],
      target,
    )
  ) {
    return false;
  }
  if (!target.anchor) return files.some((file) => file.path === target.path);
  const patch = files.find((file) => file.path === target.path)?.patch;
  if (typeof patch !== 'string' || !patchHasContent(patch)) return false;
  return patchContainsReviewSurfaceTarget(patch, target);
}

export function reviewSurfaceAnnotationMatchesTarget(
  annotations: readonly DiffReviewAnnotation[] | undefined,
  target: ReviewSurfaceNavigationTarget,
) {
  if (!target.annotationId) return true;
  const annotation = annotations?.find(
    (item) => item.metadata.id === target.annotationId,
  );
  if (!annotation) return false;
  if (target.anchor && annotation.metadata.exactAnchor) {
    const exactAnchor = annotation.metadata.exactAnchor;
    return (
      exactAnchor.side === target.anchor.side &&
      exactAnchor.startLine === target.anchor.startLine &&
      exactAnchor.endLine === target.anchor.endLine
    );
  }
  return target.anchor
    ? annotation.side === target.anchor.side &&
        annotation.lineNumber >= target.anchor.startLine &&
        annotation.lineNumber <= target.anchor.endLine
    : true;
}

export function patchContainsReviewSurfaceTarget(
  patch: string,
  target: ReviewSurfaceNavigationTarget,
) {
  if (!target.anchor) return true;
  const visible = visiblePatchLineKeys(patch);
  for (
    let line = target.anchor.startLine;
    line <= target.anchor.endLine;
    line += 1
  ) {
    if (!visible.has(`${target.anchor.side}:${line}`)) return false;
  }
  return true;
}
