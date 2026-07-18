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
import { DiffWorkerProvider, UnifiedPatchView } from './DiffViewer';
import type {
  DiffFilePatch,
  DiffReviewAnnotation,
  DiffViewTone,
} from './types';
import type { ReviewSourceSnapshot } from '../../../../shared/review-source';
import { reviewSourceDataAttributes } from './review-source';
import { useReviewSurface } from './use-review-surface';

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
          onNavigatePath: selectPath,
          selection: selectedLines,
          source,
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
          files={files}
          onSelectPath={selectPath}
          selectedPath={selectedFile?.path ?? null}
        />
      </aside>
      <div className="diff-file-column">
        <div className="diff-file-selector">
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
        <DiffWorkerProvider>
          <UnifiedPatchView
            className="min-h-0 flex-1"
            detail={detail ?? selectedFile?.path}
            lineAnnotations={
              selectedFile ? annotationsByPath?.[selectedFile.path] : undefined
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
            patch={patchHasContent(patch) ? patch : null}
            renderAnnotation={renderAnnotation}
            selectedLines={selectedLines}
            onSelectedLinesChange={onSelectedLinesChange}
            title={title}
            tone={tone}
          />
        </DiffWorkerProvider>
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
