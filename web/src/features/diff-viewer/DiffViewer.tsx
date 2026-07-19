import {
  CodeView,
  PatchDiff,
  WorkerPoolContextProvider,
  type CodeViewHandle,
  type CodeViewItem,
  type SelectedLineRange,
} from '@pierre/diffs/react';
import { getSingularPatch } from '@pierre/diffs';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
import { useReviewSurface } from './use-review-surface';
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
  navigationScroll?: DiffNavigationScrollRequest | null;
};

export type DiffNavigationScrollRequest = {
  token: number;
  line: number | null;
  selection: SelectedLineRange | null;
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
  navigationScroll,
}: UnifiedPatchViewProps) {
  const codeViewRef =
    useRef<CodeViewHandle<DiffReviewAnnotationMetadata>>(null);
  const shellRef = useRef<HTMLElement>(null);
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
  const surfaceId = useReviewSurface(
    source
      ? {
          activePath: source.files[0]?.path ?? null,
          selection: selectedLines,
          source,
        }
      : null,
  );

  useEffect(() => {
    if (!navigationScroll || !patchHasContent(patch)) return;
    const frame = window.requestAnimationFrame(() => {
      if (useCodeView) {
        const target = navigationScroll.selection
          ? {
              type: 'range' as const,
              id: codeViewItemId,
              range: navigationScroll.selection,
              align: 'center' as const,
              behavior: 'smooth-auto' as const,
            }
          : navigationScroll.line
            ? {
                type: 'line' as const,
                id: codeViewItemId,
                lineNumber: navigationScroll.line,
                align: 'center' as const,
                behavior: 'smooth-auto' as const,
              }
            : {
                type: 'item' as const,
                id: codeViewItemId,
                align: 'start' as const,
                behavior: 'smooth-auto' as const,
              };
        codeViewRef.current?.scrollTo(target);
        return;
      }
      scrollPatchDiffToNavigationTarget(shellRef.current, navigationScroll);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [navigationScroll, patch, useCodeView]);

  if (!patchHasContent(patch)) {
    return <MiniEmpty label="No patch content available." />;
  }

  const fileCount = patchFilePaths(patch).length;

  return (
    <section
      className={cn('diff-viewer-shell', className)}
      ref={shellRef}
      {...(source ? reviewSourceDataAttributes(source) : {})}
      {...(surfaceId ? { 'data-review-surface-id': surfaceId } : {})}
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
          ref={codeViewRef}
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

function scrollPatchDiffToNavigationTarget(
  shell: HTMLElement | null,
  navigation: DiffNavigationScrollRequest,
) {
  if (!shell) return;
  const container = shell.querySelector('diffs-container');
  const renderedDiff = container?.shadowRoot;
  const selectedAnnotation = shell.querySelector<HTMLElement>(
    '[data-navigation-selected]',
  );
  const selectedLine = renderedDiff?.querySelector<HTMLElement>(
    '[data-selected-line]',
  );
  const requestedLine = navigation.line
    ? renderedDiff?.querySelector<HTMLElement>(
        `[data-line="${navigation.line}"]`,
      )
    : null;
  const target =
    selectedAnnotation ??
    selectedLine ??
    requestedLine ??
    (container instanceof HTMLElement ? container : null);
  target?.scrollIntoView({
    behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    block: navigation.selection || navigation.line ? 'center' : 'start',
    inline: 'nearest',
  });
}

function prefersReducedMotion() {
  return (
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
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
