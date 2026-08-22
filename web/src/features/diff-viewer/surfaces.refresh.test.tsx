// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, useEffect, useRef, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewRefreshStatus } from '../../../../shared/review-refresh';
import {
  reviewRevisionKey,
  type ReviewSourceSnapshot,
} from '../../../../shared/review-source';
import type { NeonReviewFinding } from '../../../../shared/review-finding';
import type { PreparedDiffRecord } from '../../api';

const state = vi.hoisted(() => ({
  findings: [] as NeonReviewFinding[],
  preparedError: false,
  preparedHasData: true,
  preparedRevision: 'prepared-a',
  fileCount: 2,
  viewProps: null as ViewProps | null,
}));

type ViewProps = {
  activePath?: string | null;
  files: Array<{ path: string; patch?: string | null }>;
  inspector?: ReactNode;
  refreshStatus?: ReviewRefreshStatus;
  selectedAnnotationId?: string | null;
  source?: ReviewSourceSnapshot;
  onReviewSurfaceFindingsChange?: (
    surfaceId: string,
    findings: NeonReviewFinding[],
  ) => void;
  onReviewSurfaceIdChange?: (surfaceId: string | null) => void;
};

vi.mock('../../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api')>()),
  openReviewSourceRevisionEventStream: () => () => undefined,
}));

vi.mock('./queries', async () => {
  const { resolvedReviewRevision } =
    await import('../../../../shared/review-source');
  const files = (prefix = 'src') =>
    Array.from({ length: state.fileCount }, (_, index) => ({
      additions: 1,
      binary: false,
      deletions: 1,
      path: `${prefix}/file-${index.toString().padStart(3, '0')}.ts`,
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
    },
    usePreparedDiffFiles: () => ({
      data: state.preparedHasData
        ? { files: files(), revision: revision(state.preparedRevision) }
        : undefined,
      error: state.preparedError
        ? new Error('Prepared metadata refresh failed.')
        : null,
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
  };
});

vi.mock('./MultiFileView', () => ({
  MultiFileView(props: ViewProps) {
    state.viewProps = props;
    const publishedRevision = useRef<string | null>(null);
    useEffect(() => {
      const key = `${props.source?.id}:${props.source ? reviewRevisionKey(props.source.revision) : null}`;
      if (!props.source || publishedRevision.current === key) return;
      publishedRevision.current = key;
      props.onReviewSurfaceIdChange?.('surface-review');
      props.onReviewSurfaceFindingsChange?.('surface-review', state.findings);
    }, [props]);
    return (
      <div data-testid="mounted-view">
        <div data-testid="continuity">{props.inspector}</div>
      </div>
    );
  },
}));

import { PreparedDiffReview } from './surfaces';

describe('revision-aware prepared surfaces', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let queryClient: QueryClient;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    state.findings = [];
    state.preparedError = false;
    state.preparedHasData = true;
    state.preparedRevision = 'prepared-a';
    state.fileCount = 2;
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

  it('retains an old-revision finding as history and degrades a vanished selection', async () => {
    state.findings = [finding('prepared-a', 'prepared-diff:prepared-1')];
    await render(<PreparedDiffReview diff={preparedDiff()} />);
    await selectFinding();
    const mountedContext = container.querySelector(
      '[data-testid="continuity"]',
    );

    state.findings = [
      {
        ...state.findings[0]!,
        lifecycle: {
          ...state.findings[0]!.lifecycle,
          state: 'stale',
          reason: 'The prepared worktree changed.',
        },
      },
    ];
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
    expect(state.viewProps?.selectedAnnotationId).toBeNull();
    expect(state.viewProps?.refreshStatus?.preservation).toBe('degraded');
    expect(container.textContent).toContain('Not attached');
    expect(container.querySelector('[data-testid="continuity"]')).toBe(
      mountedContext,
    );
  });

  it('preserves a selected finding only when the same target exists on the next revision', async () => {
    const current = finding('prepared-a', 'prepared-diff:prepared-1');
    const next = finding('prepared-b', 'prepared-diff:prepared-1');
    state.findings = [current];
    await render(<PreparedDiffReview diff={preparedDiff()} />);
    await selectFinding();
    await act(async () => {
      state.findings = [current, next];
      state.viewProps?.onReviewSurfaceFindingsChange?.(
        'surface-review',
        state.findings,
      );
    });
    state.findings = [
      {
        ...current,
        lifecycle: {
          ...current.lifecycle,
          state: 'stale',
          reason: 'The prepared worktree changed.',
        },
      },
      next,
    ];

    state.preparedRevision = 'prepared-b';
    await render(<PreparedDiffReview diff={preparedDiff()} />);
    const apply = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Apply the available review revision"]',
    );
    await act(async () =>
      apply?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );

    expect(state.viewProps?.source?.revision).toMatchObject({
      id: 'prepared-b',
    });
    expect(state.viewProps?.selectedAnnotationId).not.toBeNull();
    expect(state.viewProps?.refreshStatus?.preservation).toBe('preserved');
  });

  it.each(['dismissed', 'resolved', 'stale'] as const)(
    'reports a degraded prepared refresh after the selected finding becomes %s',
    async (lifecycleState) => {
      await expect(
        expectLifecycleSelectionDegraded(lifecycleState),
      ).resolves.toBe('degraded');
    },
  );

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

  it('rejects a retained prepared candidate until metadata refresh succeeds', async () => {
    const guardedRefresh = {
      mutationPending: false,
      revisionConfirmationOpen: true,
    };
    await render(
      <PreparedDiffReview
        diff={preparedDiff()}
        externalRefreshGuard={guardedRefresh}
      />,
    );
    const mountedView = container.querySelector('[data-testid="mounted-view"]');

    state.preparedRevision = 'prepared-b';
    await render(
      <PreparedDiffReview
        diff={preparedDiff()}
        externalRefreshGuard={guardedRefresh}
      />,
    );
    const retainedApply = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Apply the available review revision"]',
    );
    expect(retainedApply).not.toBeNull();
    expect(retainedApply?.disabled).toBe(true);

    state.preparedError = true;
    await render(<PreparedDiffReview diff={preparedDiff()} />);

    expect(container.textContent).toContain(
      'Prepared diff refresh unavailable: Prepared metadata refresh failed.',
    );
    expect(container.querySelector('[data-testid="mounted-view"]')).toBe(
      mountedView,
    );
    expect(
      container.querySelector(
        'button[aria-label="Apply the available review revision"]',
      ),
    ).toBeNull();
    expect(state.viewProps?.refreshStatus).toMatchObject({
      availableRevision: null,
      state: 'current',
    });
    expect(state.viewProps?.source?.revision).toMatchObject({
      id: 'prepared-a',
    });

    await act(async () =>
      retainedApply?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(state.viewProps?.source?.revision).toMatchObject({
      id: 'prepared-a',
    });

    state.preparedError = false;
    await render(<PreparedDiffReview diff={preparedDiff()} />);
    expect(state.viewProps?.source?.revision).toMatchObject({
      id: 'prepared-b',
    });
  });

  it('shows an unavailable state when initial prepared metadata loading fails', async () => {
    state.preparedHasData = false;
    state.preparedError = true;

    await render(<PreparedDiffReview diff={preparedDiff()} />);

    expect(container.textContent).toContain(
      'Prepared diff unavailable: Prepared metadata refresh failed.',
    );
    expect(container.querySelector('[data-testid="mounted-view"]')).toBeNull();
  });

  async function render(node: ReactNode) {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>,
      );
    });
  }

  async function selectFinding() {
    const show = container.querySelector<HTMLButtonElement>(
      'button[aria-label^="Show finding:"]',
    );
    expect(show).not.toBeNull();
    await act(async () =>
      show?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
  }

  async function expectLifecycleSelectionDegraded(
    lifecycleState: Extract<
      NeonReviewFinding['lifecycle']['state'],
      'dismissed' | 'resolved' | 'stale'
    >,
  ) {
    state.findings = [finding('prepared-a', 'prepared-diff:prepared-1')];
    await render(<PreparedDiffReview diff={preparedDiff()} />);
    await selectFinding();
    const lifecycleFinding = {
      ...state.findings[0]!,
      lifecycle: {
        ...state.findings[0]!.lifecycle,
        state: lifecycleState,
        reason: `The finding became ${lifecycleState}.`,
      },
    };
    await act(async () => {
      state.findings = [lifecycleFinding];
      state.viewProps?.onReviewSurfaceFindingsChange?.(
        'surface-review',
        state.findings,
      );
    });
    expect(state.viewProps?.selectedAnnotationId).not.toBeNull();

    state.preparedRevision = 'prepared-b';
    await render(<PreparedDiffReview diff={preparedDiff()} />);
    const apply = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Apply the available review revision"]',
    );
    await act(async () =>
      apply?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );

    expect(state.viewProps?.selectedAnnotationId).toBeNull();
    expect(state.viewProps?.refreshStatus?.preservation).toBe('degraded');
    return state.viewProps?.refreshStatus?.preservation;
  }
});

function preparedDiff(): PreparedDiffRecord {
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
    updatedAt: '2026-07-18T00:00:00.000Z',
  };
}

function finding(revisionId: string, sourceId: string): NeonReviewFinding {
  return {
    schemaVersion: 2,
    id: 'selected',
    surfaceId: 'surface-review',
    sourceId,
    revisionKey: `worktree-diff:base-sha:${revisionId}`,
    file: 'src/file-000.ts',
    anchor: {
      kind: 'line-range',
      side: 'additions',
      startLine: 1,
      endLine: 1,
    },
    title: 'Selected finding',
    explanation: 'Keep this finding tied to its revision.',
    severity: 'major',
    confidence: 'high',
    suggestedAction: 'Review the changed line.',
    provenance: {
      authorRole: 'display-assistant',
      model: 'openai/gpt-5',
      workflowRunId: 'run-1',
      createdAt: '2026-07-18T12:00:00.000Z',
    },
    lifecycle: {
      state: 'active',
      changedAt: '2026-07-18T12:00:00.000Z',
      reason: null,
      promotion: null,
    },
  };
}
