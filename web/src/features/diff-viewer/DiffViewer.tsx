import {
  CodeView,
  PatchDiff,
  WorkerPoolContextProvider,
  type CodeViewItem,
  type SelectedLineRange,
} from '@pierre/diffs/react';
import { getSingularPatch } from '@pierre/diffs';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Badge, MiniEmpty } from '../../components/ui';
import { cn } from '../../lib/cn';
import {
  diffFileCountLabel,
  patchChangedLineCount,
  patchFilePaths,
  patchHasContent,
} from './helpers';
import {
  neondeckCodeViewOptions,
  neondeckDiffOptions,
  neondeckDiffUnsafeCss,
  type ResolvedDiffTheme,
} from './theme';
import { diffHighlighterOptions, diffWorkerPoolOptions } from './worker';
import type { ReviewSourceSnapshot } from '../../../../shared/review-source';
import { reviewSourceDataAttributes } from './review-source';
import type {
  DiffReviewAnnotation,
  DiffReviewAnnotationMetadata,
  DiffViewTone,
} from './types';

type UnifiedPatchViewProps = {
  patch: string | null | undefined;
  title?: string;
  detail?: string;
  tone?: DiffViewTone;
  meta?: ReactNode;
  className?: string;
  lineAnnotations?: DiffReviewAnnotation[];
  renderAnnotation?: (annotation: DiffReviewAnnotation) => ReactNode;
  selectedLines?: SelectedLineRange | null;
  onSelectedLinesChange?: (selection: SelectedLineRange | null) => void;
  virtualizeLargePatches?: boolean;
  codeViewTextScale?: number;
  source?: ReviewSourceSnapshot;
};

const codeViewChangedLineThreshold = 2_000;
const codeViewItemId = 'active-diff';

export function DiffWorkerProvider({ children }: { children: ReactNode }) {
  return (
    <WorkerPoolContextProvider
      highlighterOptions={diffHighlighterOptions}
      poolOptions={diffWorkerPoolOptions}
    >
      {children}
    </WorkerPoolContextProvider>
  );
}

export function UnifiedPatchView({
  patch,
  title = 'Diff',
  detail,
  tone = 'primary',
  meta,
  className,
  lineAnnotations,
  renderAnnotation,
  selectedLines,
  onSelectedLinesChange,
  virtualizeLargePatches = true,
  codeViewTextScale,
  source,
}: UnifiedPatchViewProps) {
  const themeType = useResolvedDiffTheme();
  const useCodeView =
    virtualizeLargePatches &&
    patchChangedLineCount(patch) >= codeViewChangedLineThreshold;
  const codeViewItems = useMemo(
    () =>
      useCodeView && patch
        ? ([
            {
              id: codeViewItemId,
              type: 'diff',
              fileDiff: getSingularPatch(patch),
              annotations: lineAnnotations,
            },
          ] satisfies CodeViewItem<DiffReviewAnnotationMetadata>[])
        : [],
    [lineAnnotations, patch, useCodeView],
  );

  if (!patchHasContent(patch)) {
    return <MiniEmpty label="No patch content available." />;
  }

  const fileCount = patchFilePaths(patch).length;

  return (
    <section
      className={cn('diff-viewer-shell', className)}
      {...(source ? reviewSourceDataAttributes(source) : {})}
    >
      <header className="diff-viewer-header">
        <div className="min-w-0">
          <p className={cn('diff-viewer-title', toneClass(tone))}>{title}</p>
          {detail ? <p className="diff-viewer-detail">{detail}</p> : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          {meta}
          <Badge>{diffFileCountLabel(fileCount || 1)}</Badge>
        </div>
      </header>
      {useCodeView ? (
        <CodeView<DiffReviewAnnotationMetadata>
          className="diff-patch diff-code-view"
          items={codeViewItems}
          onSelectedLinesChange={
            onSelectedLinesChange
              ? (selection) => onSelectedLinesChange(selection?.range ?? null)
              : undefined
          }
          options={{
            ...neondeckCodeViewOptions(themeType, codeViewTextScale),
            enableLineSelection: Boolean(onSelectedLinesChange),
            unsafeCSS: neondeckDiffUnsafeCss,
          }}
          renderAnnotation={
            renderAnnotation
              ? (annotation) =>
                  renderAnnotation(annotation as DiffReviewAnnotation)
              : undefined
          }
          selectedLines={
            selectedLines === undefined
              ? undefined
              : selectedLines
                ? { id: codeViewItemId, range: selectedLines }
                : null
          }
        />
      ) : (
        <PatchDiff<DiffReviewAnnotationMetadata>
          className="diff-patch"
          lineAnnotations={lineAnnotations}
          options={{
            ...neondeckDiffOptions(themeType),
            controlledSelection: selectedLines !== undefined,
            enableLineSelection: Boolean(onSelectedLinesChange),
            onLineSelectionEnd: onSelectedLinesChange,
            unsafeCSS: neondeckDiffUnsafeCss,
          }}
          patch={patch ?? ''}
          renderAnnotation={renderAnnotation}
          selectedLines={selectedLines}
        />
      )}
    </section>
  );
}

function toneClass(tone: DiffViewTone) {
  if (tone === 'accent') return 'text-accent';
  if (tone === 'violet') return 'text-violet';
  return 'text-primary';
}

function useResolvedDiffTheme(): ResolvedDiffTheme {
  const [theme, setTheme] = useState<ResolvedDiffTheme>(() =>
    readResolvedDiffTheme(),
  );

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setTheme(readResolvedDiffTheme());
    });
    observer.observe(root, {
      attributeFilter: ['data-theme'],
      attributes: true,
    });
    setTheme(readResolvedDiffTheme());
    return () => observer.disconnect();
  }, []);

  return theme;
}

function readResolvedDiffTheme(): ResolvedDiffTheme {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}
