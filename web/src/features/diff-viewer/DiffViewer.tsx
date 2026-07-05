import {
  PatchDiff,
  WorkerPoolContextProvider,
  type SelectedLineRange,
} from '@pierre/diffs/react';
import { useEffect, useState, type ReactNode } from 'react';
import { Badge, MiniEmpty } from '../../components/ui';
import { cn } from '../../lib/cn';
import { diffFileCountLabel, patchFilePaths, patchHasContent } from './helpers';
import {
  neondeckDiffOptions,
  neondeckDiffUnsafeCss,
  type ResolvedDiffTheme,
} from './theme';
import { diffHighlighterOptions, diffWorkerPoolOptions } from './worker';
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
};

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
}: UnifiedPatchViewProps) {
  const themeType = useResolvedDiffTheme();

  if (!patchHasContent(patch)) {
    return <MiniEmpty label="No patch content available." />;
  }

  const fileCount = patchFilePaths(patch).length;

  return (
    <section className={cn('diff-viewer-shell', className)}>
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
      <DiffWorkerProvider>
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
      </DiffWorkerProvider>
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
