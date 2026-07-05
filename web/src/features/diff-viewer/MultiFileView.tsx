import { useEffect, useId, useState, type ReactNode } from 'react';
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
import { UnifiedPatchView } from './DiffViewer';
import type {
  DiffFilePatch,
  DiffReviewAnnotation,
  DiffViewTone,
} from './types';

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

  const selectPath = (path: string) => {
    setUncontrolledPath(path);
    onActivePathChange?.(path);
  };
  const status = selectedFile ? filePatchStatus(selectedFile) : null;

  return (
    <section className={cn('diff-multi-file', className)}>
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
    </section>
  );
}
