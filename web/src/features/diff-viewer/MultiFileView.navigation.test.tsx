// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SelectedLineRange } from '@pierre/diffs/react';
import type { DiffFilePatch } from './types';

const capture = vi.hoisted(() => ({
  diff: vi.fn<(props: Record<string, unknown>) => void>(),
  surface: vi.fn<(input: Record<string, unknown> | null) => void>(),
  tree: vi.fn<(props: Record<string, unknown>) => void>(),
}));

vi.mock('./use-review-surface', () => ({
  useReviewSurface(input: Record<string, unknown> | null) {
    capture.surface(input);
    return 'surface-navigation-test';
  },
}));

vi.mock('./FileTreePane', () => ({
  FileTreePane(props: Record<string, unknown>) {
    capture.tree(props);
    return (
      <button
        onClick={() =>
          (props.onSelectPath as ((path: string) => void) | undefined)?.(
            'src/a.ts',
          )
        }
        type="button"
      >
        Select src/a.ts
      </button>
    );
  },
}));

vi.mock('./DiffViewer', () => ({
  DiffWorkerProvider({ children }: { children: React.ReactNode }) {
    return children;
  },
  UnifiedPatchView(props: Record<string, unknown>) {
    capture.diff(props);
    return <div data-selected-diff="" />;
  },
}));

import { MultiFileView } from './MultiFileView';
import {
  reviewSourceSchemaVersion,
  resolvedReviewRevision,
} from '../../../../shared/review-source';

describe('MultiFileView navigation synchronization', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it('keeps tree, diff anchor, inspector, and review-surface snapshot on one active target', () => {
    const onActivePathChange = vi.fn<(path: string) => void>();
    const initialSelection = {
      side: 'additions',
      start: 3,
      end: 3,
    } as SelectedLineRange;
    const selection = {
      side: 'additions',
      start: 8,
      end: 8,
    } as SelectedLineRange;
    const files = reviewFiles();

    act(() =>
      root.render(
        <MultiFileView
          activePath="src/a.ts"
          fileFilter="src/"
          files={files}
          inspector={<p>Inspector target: draft-stable on src/a.ts</p>}
          onActivePathChange={onActivePathChange}
          reviewOrder={['src/b.ts', 'src/a.ts']}
          selectedAnnotationId="draft-stable"
          selectedLines={initialSelection}
          source={reviewSource(files)}
          title="Navigation synchronization"
        />,
      ),
    );

    expect(capture.tree).toHaveBeenLastCalledWith(
      expect.objectContaining({ selectedPath: 'src/a.ts' }),
    );
    expect(capture.diff).toHaveBeenLastCalledWith(
      expect.objectContaining({ selectedLines: initialSelection }),
    );

    act(() =>
      root.render(
        <MultiFileView
          activePath="src/b.ts"
          fileFilter="src/b"
          files={files}
          inspector={<p>Inspector target: draft-stable on src/b.ts</p>}
          onActivePathChange={onActivePathChange}
          reviewOrder={['src/b.ts', 'src/a.ts']}
          selectedAnnotationId="draft-stable"
          selectedLines={selection}
          source={reviewSource(files)}
          title="Navigation synchronization"
        />,
      ),
    );

    expect(capture.tree).toHaveBeenLastCalledWith(
      expect.objectContaining({
        filterQuery: 'src/b',
        selectedPath: 'src/b.ts',
      }),
    );
    expect(capture.diff).toHaveBeenLastCalledWith(
      expect.objectContaining({
        patch: files[1]!.patch,
        selectedLines: selection,
      }),
    );
    expect(capture.surface).toHaveBeenLastCalledWith(
      expect.objectContaining({
        activePath: 'src/b.ts',
        fileFilter: 'src/b',
        reviewOrder: ['src/b.ts', 'src/a.ts'],
        selectedAnnotationId: 'draft-stable',
        selection,
      }),
    );
    expect(container.textContent).toContain(
      'Inspector target: draft-stable on src/b.ts',
    );
    expect(
      container
        .querySelector('.diff-multi-file')
        ?.getAttribute('data-review-surface-id'),
    ).toBe('surface-navigation-test');

    act(() =>
      [...container.querySelectorAll('button')]
        .find((button) => button.textContent?.includes('Select src/a.ts'))
        ?.click(),
    );
    expect(onActivePathChange).toHaveBeenCalledWith('src/a.ts');
  });
});

function reviewFiles(): DiffFilePatch[] {
  return ['a', 'b'].map((name) => ({
    additions: 1,
    deletions: 1,
    path: `src/${name}.ts`,
    patch: `diff --git a/src/${name}.ts b/src/${name}.ts\n@@ -1 +1 @@\n-old\n+${name}\n`,
    status: 'modified',
  }));
}

function reviewSource(files: DiffFilePatch[]) {
  return {
    schemaVersion: reviewSourceSchemaVersion,
    id: 'github-pr:example/repo#42',
    kind: 'github-pr' as const,
    title: 'Navigation synchronization',
    revision: resolvedReviewRevision({ kind: 'git-commit', id: 'head-sha' }),
    repository: {
      repoId: 'repo-1',
      repoFullName: 'example/repo',
      worktreeId: null,
      localPath: null,
      localAccess: false,
    },
    files: files.map((file) => ({
      path: file.path,
      previousPath: null,
      status: 'modified' as const,
      additions: file.additions,
      deletions: file.deletions,
      generatedLike: false,
      patchState: 'available' as const,
      patchMessage: null,
    })),
    capabilities: ['comments' as const],
    promotionTargets: [
      {
        destination: 'github-review-draft' as const,
        repoFullName: 'example/repo',
        prNumber: 42,
      },
    ],
    externalUrl: null,
  };
}
