import { PatchDiff, WorkerPoolContextProvider } from '@pierre/diffs/react';
import { useEffect, useState, type ReactNode } from 'react';
import { Badge, MiniEmpty } from '../../components/ui';
import { cn } from '../../lib/cn';
import { patchFilePaths, patchHasContent } from './helpers';
import {
  neondeckDiffOptions,
  neondeckDiffUnsafeCss,
  type ResolvedDiffTheme,
} from './theme';
import { diffHighlighterOptions, diffWorkerPoolOptions } from './worker';
import type { DiffViewTone } from './types';

type UnifiedPatchViewProps = {
  patch: string | null | undefined;
  title?: string;
  detail?: string;
  tone?: DiffViewTone;
  meta?: ReactNode;
  className?: string;
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
        <div className="flex shrink-0 items-center gap-1.5">
          {meta}
          <Badge>{fileCount || 1} files</Badge>
        </div>
      </header>
      <DiffWorkerProvider>
        <PatchDiff
          className="diff-patch"
          options={{
            ...neondeckDiffOptions(themeType),
            unsafeCSS: neondeckDiffUnsafeCss,
          }}
          patch={patch ?? ''}
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
