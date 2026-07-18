// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewRefreshStatus } from '../../../../shared/review-refresh';
import type { ReviewSourceSnapshot } from '../../../../shared/review-source';
import type { AutopilotPreparedDiff, KiloTaskRecord } from '../../api';

const state = vi.hoisted(() => ({
  guards: {
    mutationPending: false,
    revisionConfirmationOpen: false,
    selectionActive: false,
  },
  preparedRevision: 'prepared-a',
  repoRevision: 'repo-a',
  fileCount: 2,
  patchPaths: [] as Array<string | null>,
  viewProps: null as ViewProps | null,
}));

type ViewProps = {
  activePath?: string | null;
  files: Array<{ path: string; patch?: string | null }>;
  inspector?: ReactNode;
  refreshStatus?: ReviewRefreshStatus;
  selectedAnnotationId?: string | null;
  source?: ReviewSourceSnapshot;
};

vi.mock('../../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api')>()),
  openReviewSourceRevisionEventStream: () => () => undefined,
}));

vi.mock('./queries', async () => {
  const { resolvedReviewRevision } =
    await import('../../../../shared/review-source');
  const files = () =>
    Array.from({ length: state.fileCount }, (_, index) => ({
      additions: 1,
      binary: false,
      deletions: 1,
      path: `src/file-${index.toString().padStart(3, '0')}.ts`,
      patch: null,
      status: 'M',
      truncated: false,
    }));
  const revision = (id: string) =>
    resolvedReviewRevision({
      kind: 'worktree-diff',
      id,
      baseId: 'base-sha',
    });
  return {
    diffViewerQueryKeys: {
      preparedDiffFiles: (id: string) => ['prepared', id],
      repoDiff: (input: unknown) => ['repo', input],
    },
    useKiloTaskDiff: () => ({ data: null, error: null, isLoading: false }),
    usePreparedDiffFiles: () => ({
      data: { files: files(), revision: revision(state.preparedRevision) },
      error: null,
      isLoading: false,
    }),
    usePreparedDiffFilePatch: (
      _preparedDiffId: string,
      _revisionKey: string | null,
      path: string | null,
    ) => ({
      data: path
        ? { diff: `@@ -1 +1 @@\n-old\n+${path}\n`, file: { path } }
        : undefined,
      error: null,
      isLoading: false,
    }),
    useRepoDiff: () => ({
      data: {
        diffSummary: {
          additions: state.fileCount,
          binaryFiles: 0,
          deletions: state.fileCount,
          files: state.fileCount,
        },
        files: files(),
        revision: revision(state.repoRevision),
      },
      error: null,
      isLoading: false,
    }),
    useRepoDiffFilePatch: (input: { path: string | null }) => {
      state.patchPaths.push(input.path);
      return {
        data: input.path
          ? {
              files: [
                {
                  path: input.path,
                  patch: `@@ -1 +1 @@\n-old\n+${input.path}\n`,
                },
              ],
            }
          : undefined,
        error: null,
        isLoading: false,
      };
    },
  };
});

vi.mock('./use-prepared-finding-review', () => ({
  usePreparedFindingReview: () => ({
    annotationsByPath: {},
    inspector: (
      <div data-testid="continuity">Approval and recovery context</div>
    ),
    inspectorLabel: 'Findings',
    onReviewSurfaceFindingsChange: () => undefined,
    onReviewSurfaceIdChange: () => undefined,
    refreshGuards: state.guards,
    renderAnnotation: () => null,
    reviewMapByPath: new Map(),
    selectedAnnotationId: state.guards.selectionActive
      ? 'finding:selected'
      : null,
  }),
}));

vi.mock('./MultiFileView', () => ({
  MultiFileView(props: ViewProps) {
    state.viewProps = props;
    return <div data-testid="mounted-view">{props.inspector}</div>;
  },
}));

import { KiloTaskDiffReview, PreparedDiffReview } from './surfaces';

describe('revision-aware prepared and Kilo surfaces', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let queryClient: QueryClient;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    state.guards = {
      mutationPending: false,
      revisionConfirmationOpen: false,
      selectionActive: false,
    };
    state.preparedRevision = 'prepared-a';
    state.repoRevision = 'repo-a';
    state.fileCount = 2;
    state.patchPaths = [];
    state.viewProps = null;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    container.remove();
  });

  it('distinguishes availability from application and preserves a selected finding explicitly', async () => {
    state.guards.selectionActive = true;
    await render(<PreparedDiffReview diff={preparedDiff()} />);
    const mountedContext = container.querySelector(
      '[data-testid="continuity"]',
    );

    state.preparedRevision = 'prepared-b';
    await render(<PreparedDiffReview diff={preparedDiff()} />);

    expect(container.textContent).toContain('New revision available');
    expect(container.textContent).toContain(
      'a line, range, or annotation selection is active',
    );
    const apply = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Apply the available review revision"]',
    );
    expect(apply?.disabled).toBe(false);
    expect(state.viewProps?.source?.revision).toMatchObject({
      id: 'prepared-a',
    });

    await act(async () =>
      apply?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );

    expect(state.viewProps?.source?.revision).toMatchObject({
      id: 'prepared-b',
    });
    expect(state.viewProps?.selectedAnnotationId).toBe('finding:selected');
    expect(state.viewProps?.refreshStatus?.preservation).toBe('preserved');
    expect(container.querySelector('[data-testid="continuity"]')).toBe(
      mountedContext,
    );
  });

  it('keeps a prepared revision confirmation open and blocks refresh application', async () => {
    const externalRefreshGuard = {
      mutationPending: false,
      revisionConfirmationOpen: true,
    };
    await render(
      <PreparedDiffReview
        diff={preparedDiff()}
        externalRefreshGuard={externalRefreshGuard}
      />,
    );
    state.preparedRevision = 'prepared-b';
    await render(
      <PreparedDiffReview
        diff={preparedDiff()}
        externalRefreshGuard={externalRefreshGuard}
      />,
    );

    expect(container.textContent).toContain('a revision confirmation is open');
    expect(
      container.querySelector<HTMLButtonElement>(
        'button[aria-label="Apply the available review revision"]',
      )?.disabled,
    ).toBe(true);
    expect(state.viewProps?.source?.revision).toMatchObject({
      id: 'prepared-a',
    });
  });

  it('keeps a 305-file Kilo refresh lazy and reuses the surrounding surface', async () => {
    state.fileCount = 305;
    state.guards.selectionActive = true;
    await render(<KiloTaskDiffReview task={kiloTask()} />);
    const mountedView = container.querySelector('[data-testid="mounted-view"]');

    state.repoRevision = 'repo-b';
    await render(<KiloTaskDiffReview task={kiloTask()} />);
    const apply = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Apply the available review revision"]',
    );
    await act(async () =>
      apply?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );

    const requestedPaths = new Set(state.patchPaths.filter(Boolean));
    expect(state.viewProps?.files).toHaveLength(305);
    expect(requestedPaths).toEqual(new Set(['src/file-000.ts']));
    expect(
      state.viewProps?.files.filter((file) => Boolean(file.patch)),
    ).toHaveLength(1);
    expect(container.querySelector('[data-testid="mounted-view"]')).toBe(
      mountedView,
    );
    expect(state.viewProps?.source?.revision).toMatchObject({ id: 'repo-b' });
  });

  async function render(node: ReactNode) {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>,
      );
    });
  }
});

function preparedDiff(): AutopilotPreparedDiff {
  return {
    id: 'prepared-1',
    repoId: 'repo-1',
    repoFullName: 'example/repo',
    prNumber: 42,
    worktreeId: 'worktree-1',
    localPath: '/tmp/worktree-1',
    title: 'Prepared change',
    status: 'prepared',
    pushApprovalStatus: 'pending',
    verificationStatus: 'not-run',
    sourceOfTruth: 'worktree',
    summary: 'Waiting for approval.',
    revisionRun: null,
    updatedAt: '2026-07-18T00:00:00.000Z',
  };
}

function kiloTask(): KiloTaskRecord {
  return {
    id: 'kilo-1',
    title: 'Kilo result',
    prompt: 'Change it.',
    repoId: 'repo-1',
    repoFullName: 'example/repo',
    worktreeId: 'worktree-1',
    lockId: null,
    cwd: '/tmp/worktree-1',
    mode: 'direct-edit',
    status: 'succeeded',
    explicitUserRequest: true,
    autoEnabled: false,
    cliPath: 'kilo',
    args: [],
    pid: null,
    processStartedAt: null,
    rootSessionId: null,
    childSessionIds: [],
    rawLogPath: null,
    summary: null,
    exitCode: 0,
    error: null,
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
    completedAt: '2026-07-18T00:00:00.000Z',
    preparedDiffId: 'prepared-1',
  };
}
