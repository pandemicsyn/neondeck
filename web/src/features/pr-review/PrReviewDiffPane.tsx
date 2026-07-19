import type { SelectedLineRange } from '@pierre/diffs/react';
import type { ReactNode } from 'react';
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
}) {
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
        emptyLabel="No PR file patches available."
        fileFilter={fileFilter}
        files={files}
        footer={
          isStandalone ? null : (
            <PrReviewFindingsSidebar {...findingsSidebar} variant="embedded" />
          )
        }
        inspector={
          isStandalone ? (
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
      {isStandalone ? (
        <PrReviewFindingsSidebar {...findingsSidebar} variant="compact" />
      ) : null}
    </>
  );
}
