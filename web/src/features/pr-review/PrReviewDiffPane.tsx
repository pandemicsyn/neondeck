import type { SelectedLineRange } from '@pierre/diffs/react';
import type { ReactNode } from 'react';
import { MiniEmpty } from '../../components/ui';
import { MultiFileView } from '../diff-viewer/MultiFileView';
import type { DiffFilePatch, DiffReviewAnnotation } from '../diff-viewer/types';
import type { ReviewSourceSnapshot } from '../../../../shared/review-source';
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
  onActivePathChange,
  onSelectedLinesChange,
  patchError,
  renderAnnotation,
  selectedLines,
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
  onActivePathChange: (path: string) => void;
  onSelectedLinesChange: (selection: SelectedLineRange | null) => void;
  patchError: string | null;
  renderAnnotation: (annotation: DiffReviewAnnotation) => ReactNode;
  selectedLines: SelectedLineRange | null;
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
        onActivePathChange={onActivePathChange}
        onSelectedLinesChange={onSelectedLinesChange}
        patchError={patchError}
        renderAnnotation={renderAnnotation}
        selectedLines={selectedLines}
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
