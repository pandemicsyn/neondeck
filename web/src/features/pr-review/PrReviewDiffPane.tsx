import type { SelectedLineRange } from '@pierre/diffs/react';
import { useEffect, useState, type ReactNode } from 'react';
import { MiniEmpty } from '../../components/ui';
import { MultiFileView } from '../diff-viewer/MultiFileView';
import type { DiffNavigationScrollRequest } from '../diff-viewer/DiffViewer';
import type {
  DiffFilePatch,
  DiffReviewAnnotation,
  FileReviewMapEntry,
} from '../diff-viewer/types';
import type { ReviewSourceSnapshot } from '../../../../shared/review-source';
import type { NeonReviewFinding } from '../../../../shared/review-finding';
import type { ReviewRefreshStatus } from '../../../../shared/review-refresh';
import type { ReviewSurfaceNavigationTarget } from '../../../../shared/review-surface';
import {
  PrReviewFindingsSidebar,
  type PrReviewFindingsSidebarProps,
} from './PrReviewFindingsSidebar';

export function PrReviewDiffPane({
  activePath,
  annotationsByPath,
  detail,
  fileLoadMessage,
  files,
  findingsSidebar,
  isLoadingPatch,
  isStandalone,
  navigationScroll,
  fileFilter,
  onFileFilterChange,
  onReviewSurfaceFindingsChange,
  onReviewSurfaceIdChange,
  onReviewSurfaceNavigate,
  resolveReviewSurfaceTarget,
  onActivePathChange,
  onSelectedLinesChange,
  patchError,
  renderAnnotation,
  selectedLines,
  selectedAnnotationId,
  reviewMapByPath,
  reviewOrder,
  refreshStatus,
  source,
  title,
  contentOverride,
  columnToolbar,
  hideFileSelector,
}: {
  activePath: string | null;
  annotationsByPath: Record<string, DiffReviewAnnotation[]>;
  detail: string;
  fileLoadMessage: string | null;
  files: DiffFilePatch[];
  findingsSidebar: PrReviewFindingsSidebarProps;
  isLoadingPatch: boolean;
  isStandalone: boolean;
  navigationScroll: DiffNavigationScrollRequest | null;
  fileFilter: string | null;
  onFileFilterChange: (query: string | null, paths: string[] | null) => void;
  onReviewSurfaceFindingsChange: (
    surfaceId: string,
    findings: NeonReviewFinding[],
  ) => void;
  onReviewSurfaceIdChange: (surfaceId: string | null) => void;
  onReviewSurfaceNavigate: (target: ReviewSurfaceNavigationTarget) => void;
  resolveReviewSurfaceTarget: (
    target: ReviewSurfaceNavigationTarget,
  ) => boolean | Promise<boolean>;
  onActivePathChange: (path: string) => void;
  onSelectedLinesChange: (selection: SelectedLineRange | null) => void;
  patchError: string | null;
  renderAnnotation: (annotation: DiffReviewAnnotation) => ReactNode;
  selectedLines: SelectedLineRange | null;
  selectedAnnotationId: string | null;
  reviewMapByPath: ReadonlyMap<string, FileReviewMapEntry>;
  reviewOrder: readonly string[];
  refreshStatus: ReviewRefreshStatus;
  source: ReviewSourceSnapshot;
  title: string;
  contentOverride?: ReactNode;
  columnToolbar?: ReactNode;
  hideFileSelector?: boolean;
}) {
  const useCompactSidebar = useMediaQuery('(max-width: 1180px)');

  if (fileLoadMessage) {
    return (
      <div className="pr-review-load-state">
        <MiniEmpty label={fileLoadMessage} />
      </div>
    );
  }

  return (
    <>
      <MultiFileView
        activePath={activePath}
        annotationsByPath={annotationsByPath}
        detail={detail}
        contentOverride={contentOverride}
        columnToolbar={columnToolbar}
        hideFileSelector={hideFileSelector}
        emptyLabel="No PR file patches available."
        fileFilter={fileFilter}
        files={files}
        footer={
          isStandalone ? null : (
            <PrReviewFindingsSidebar {...findingsSidebar} variant="embedded" />
          )
        }
        inspector={
          isStandalone && !useCompactSidebar ? (
            <PrReviewFindingsSidebar {...findingsSidebar} variant="inspector" />
          ) : undefined
        }
        inspectorLabel="PR review inspector"
        isLoadingPatch={isLoadingPatch}
        navigationScroll={navigationScroll}
        onActivePathChange={onActivePathChange}
        onFileFilterChange={onFileFilterChange}
        onReviewSurfaceFindingsChange={onReviewSurfaceFindingsChange}
        onReviewSurfaceIdChange={onReviewSurfaceIdChange}
        onReviewSurfaceNavigate={onReviewSurfaceNavigate}
        resolveReviewSurfaceTarget={resolveReviewSurfaceTarget}
        onSelectedLinesChange={onSelectedLinesChange}
        patchError={patchError}
        renderAnnotation={renderAnnotation}
        reviewMapByPath={reviewMapByPath}
        reviewOrder={reviewOrder}
        refreshStatus={refreshStatus}
        selectedLines={selectedLines}
        selectedAnnotationId={selectedAnnotationId}
        source={source}
        title={title}
        tone="primary"
      />
      {isStandalone && useCompactSidebar ? (
        <PrReviewFindingsSidebar {...findingsSidebar} variant="compact" />
      ) : null}
    </>
  );
}

function useMediaQuery(query: string) {
  const getMatches = () =>
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(query).matches;
  const [matches, setMatches] = useState(getMatches);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [query]);

  return matches;
}
