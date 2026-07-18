// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, useEffect, useRef, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NeonReviewFinding } from '../../../../shared/review-finding';
import type { ReviewSourceSnapshot } from '../../../../shared/review-source';
import type { KiloTaskRecord } from '../../api';

const capturedView = vi.hoisted(() => ({
  findings: [] as NeonReviewFinding[],
  props: null as MockMultiFileViewProps | null,
}));

type MockMultiFileViewProps = {
  annotationsByPath?: Record<string, unknown[] | undefined>;
  inspector?: ReactNode;
  onReviewSurfaceFindingsChange?: (
    surfaceId: string,
    findings: NeonReviewFinding[],
  ) => void;
  onReviewSurfaceIdChange?: (surfaceId: string | null) => void;
  renderAnnotation?: (annotation: unknown) => ReactNode;
  source?: ReviewSourceSnapshot;
};

vi.mock('./queries', async () => {
  const { resolvedReviewRevision } =
    await import('../../../../shared/review-source');
  return {
    useKiloTaskDiff: () => ({ data: null, error: null, isLoading: false }),
    usePreparedDiffFilePatch: () => ({
      data: null,
      error: null,
      isLoading: false,
    }),
    usePreparedDiffFiles: () => ({
      data: { files: [], revision: undefined },
      error: null,
      isLoading: false,
    }),
    useRepoDiff: () => ({
      data: {
        diffSummary: {
          additions: 1,
          binaryFiles: 0,
          deletions: 1,
          files: 1,
        },
        files: [
          {
            additions: 1,
            deletions: 1,
            path: 'src/app.ts',
            status: 'M',
            patch: '@@ -1 +1,2 @@\n-old\n+old\n+new\n',
          },
        ],
        revision: resolvedReviewRevision({
          kind: 'worktree-diff',
          id: 'tree-sha',
          baseId: 'base-sha',
        }),
      },
      error: null,
      isLoading: false,
    }),
    useRepoDiffFilePatch: () => ({
      data: undefined,
      error: null,
      isLoading: false,
    }),
  };
});

vi.mock('./MultiFileView', () => ({
  MultiFileView(props: MockMultiFileViewProps) {
    capturedView.props = props;
    const appliedSourceId = useRef<string | null>(null);
    useEffect(() => {
      const sourceId = props.source?.id;
      if (!sourceId || appliedSourceId.current === sourceId) return;
      appliedSourceId.current = sourceId;
      props.onReviewSurfaceIdChange?.('surface-kilo');
      props.onReviewSurfaceFindingsChange?.(
        'surface-kilo',
        capturedView.findings,
      );
    }, [props]);
    return <div>{props.inspector}</div>;
  },
}));

import { KiloTaskDiffReview } from './surfaces';

describe('KiloTaskDiffReview findings', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let queryClient: QueryClient;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    capturedView.props = null;
    capturedView.findings = [finding()];
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
    vi.restoreAllMocks();
  });

  it('renders prepared-backed Kilo findings with the existing revision composer', async () => {
    await renderTask(kiloTask('prepared-1'));

    expect(capturedView.props?.source?.promotionTargets).toEqual([
      {
        destination: 'prepared-diff-revision',
        preparedDiffId: 'prepared-1',
      },
    ]);
    expect(capturedView.props?.annotationsByPath?.['src/app.ts']).toHaveLength(
      1,
    );
    expect(capturedView.props?.renderAnnotation).toBeTypeOf('function');
    expect(container.textContent).toContain(
      'Promotion creates a prepared revision request',
    );

    const promote = container.querySelector<HTMLButtonElement>(
      'button[aria-label^="Request prepared revision:"]',
    );
    expect(promote?.disabled).toBe(false);
    await act(async () =>
      promote?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );

    expect(container.querySelector('textarea')?.value).toContain(
      'Keep the Kilo result safe',
    );
    expect(container.textContent).toContain(
      'This records the request only; it does not run or apply a revision.',
    );
    const mutationControls = [
      ...container.querySelectorAll<HTMLButtonElement>(
        'button[aria-label^="Dismiss locally:"], button[aria-label^="Request prepared revision:"]',
      ),
    ];
    expect(mutationControls).toHaveLength(2);
    expect(mutationControls.every((control) => control.disabled)).toBe(true);
  });

  it('keeps unsupported Kilo findings visible and explicitly local-only', async () => {
    await renderTask(kiloTask(null));

    expect(capturedView.props?.source?.promotionTargets).toEqual([]);
    expect(container.textContent).toContain(
      'This source does not support prepared revision requests. Findings remain local-only.',
    );
    expect(
      container.querySelector(
        'button[aria-label^="Request prepared revision:"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector('button[aria-label^="Dismiss locally:"]'),
    ).not.toBeNull();
  });

  it('labels a retained Kilo result without a managed worktree as static', async () => {
    const task = kiloTask(null);
    task.worktreeId = null;
    await renderTask(task);

    expect(container.textContent).toContain(
      'This retained Kilo result is static; no revision-bound live refresh is available.',
    );
    expect(capturedView.props?.source?.capabilities).not.toContain('refresh');
  });

  async function renderTask(task: KiloTaskRecord) {
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <KiloTaskDiffReview task={task} />
        </QueryClientProvider>,
      );
    });
  }
});

function finding(): NeonReviewFinding {
  return {
    schemaVersion: 2,
    id: 'kilo-finding',
    surfaceId: 'surface-kilo',
    sourceId: 'kilo-result:kilo-1',
    revisionKey: 'worktree-diff:base-sha:tree-sha',
    file: 'src/app.ts',
    anchor: {
      kind: 'line-range',
      side: 'additions',
      startLine: 2,
      endLine: 2,
    },
    title: 'Keep the Kilo result safe',
    explanation: 'The updated line needs a guard.',
    severity: 'major',
    confidence: 'high',
    suggestedAction: 'Add the missing guard.',
    provenance: {
      authorRole: 'display-assistant',
      model: 'openai/gpt-5',
      workflowRunId: 'run-42',
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

function kiloTask(preparedDiffId: string | null): KiloTaskRecord {
  return {
    id: 'kilo-1',
    title: 'Delegated change',
    prompt: 'Fix it.',
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
    preparedDiffId,
  };
}
