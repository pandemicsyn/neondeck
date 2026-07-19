// @vitest-environment jsdom

import { act, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  reviewSourceSchemaVersion,
  resolvedReviewRevision,
  type ReviewSourceSnapshot,
} from '../../../../shared/review-source';
import { useReviewSurface } from './use-review-surface';
import type { NeonReviewFinding } from '../../../../shared/review-finding';
import type { ReviewSurfaceSnapshot } from '../../../../shared/review-surface';
import { createReviewRefreshStatus } from '../../../../shared/review-refresh';

const api = vi.hoisted(() => ({
  acknowledge: vi.fn<() => Promise<undefined>>(),
  heartbeat: vi.fn<() => Promise<undefined>>(),
  open: vi.fn<
    (
      onEvent: (event: unknown) => void,
      onError?: (error?: Error | Event) => void,
      onOpen?: () => void,
    ) => () => void
  >(),
  register: vi.fn<(snapshot: ReviewSurfaceSnapshot) => Promise<undefined>>(),
  readFindings: vi.fn<
    (surfaceId: string) => Promise<{
      findings: NeonReviewFinding[];
      revisionKey: string | null;
      surfaceId: string;
    }>
  >(),
  remove: vi.fn<() => Promise<undefined>>(),
}));

vi.mock('../../api', () => ({
  acknowledgeReviewSurfaceNavigation: api.acknowledge,
  heartbeatReviewSurface: api.heartbeat,
  openReviewSurfaceEventStream: api.open,
  registerReviewSurface: api.register,
  readReviewSurfaceFindings: api.readFindings,
  removeReviewSurface: api.remove,
}));

describe('useReviewSurface', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    api.acknowledge.mockResolvedValue(undefined);
    api.heartbeat.mockResolvedValue(undefined);
    api.register.mockResolvedValue(undefined);
    api.readFindings.mockImplementation(async (surfaceId) => ({
      findings: [],
      revisionKey: 'git-commit::head-sha',
      surfaceId,
    }));
    api.remove.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    act(() => root.unmount());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    container.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('subscribes before registering a navigable review surface', async () => {
    let onOpen: (() => void) | undefined;
    api.open.mockImplementation(
      (
        _onEvent: (event: unknown) => void,
        _onError?: (error?: Error | Event) => void,
        handleOpen?: () => void,
      ) => {
        onOpen = handleOpen;
        return vi.fn<() => void>();
      },
    );

    act(() => root.render(<ReviewSurfaceHarness source={reviewSource()} />));

    expect(api.open).toHaveBeenCalledTimes(1);
    expect(api.register).not.toHaveBeenCalled();

    await act(async () => onOpen?.());

    expect(api.register).toHaveBeenCalledTimes(1);
  });

  it('serializes snapshot updates and removes the surface only after pending writes', async () => {
    const firstWrite = deferred<undefined>();
    const secondWrite = deferred<undefined>();
    api.register
      .mockImplementationOnce(() => firstWrite.promise)
      .mockImplementationOnce(() => secondWrite.promise);
    api.open.mockImplementation((_onEvent, _onError, onOpen) => {
      onOpen?.();
      return vi.fn<() => void>();
    });

    const firstSource = reviewSource();
    await act(async () =>
      root.render(<OptionalSurfaceHarness source={firstSource} />),
    );
    const nextSource = reviewSource();
    nextSource.revision = resolvedReviewRevision({
      kind: 'git-commit',
      id: 'next-head-sha',
    });
    await act(async () =>
      root.render(<OptionalSurfaceHarness source={nextSource} />),
    );
    await act(async () =>
      root.render(<OptionalSurfaceHarness source={null} />),
    );

    expect(api.register).toHaveBeenCalledTimes(1);
    expect(api.remove).not.toHaveBeenCalled();

    await act(async () => {
      firstWrite.resolve(undefined);
      await firstWrite.promise;
    });
    expect(api.register).toHaveBeenCalledTimes(2);
    expect(api.remove).not.toHaveBeenCalled();

    await act(async () => {
      secondWrite.resolve(undefined);
      await secondWrite.promise;
    });
    expect(api.remove).toHaveBeenCalledTimes(1);
  });

  it('keeps heartbeats active while SSE is disconnected', async () => {
    vi.useFakeTimers();
    let onError: ((error?: Error | Event) => void) | undefined;
    api.open.mockImplementation((_onEvent, handleError, onOpen) => {
      onError = handleError;
      onOpen?.();
      return vi.fn<() => void>();
    });

    await act(async () =>
      root.render(<ReviewSurfaceHarness source={reviewSource()} />),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => onError?.(new Event('error')));
    const nextSource = reviewSource();
    nextSource.revision = resolvedReviewRevision({
      kind: 'git-commit',
      id: 'next-head-sha',
    });
    await act(async () =>
      root.render(<ReviewSurfaceHarness source={nextSource} />),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });

    expect(api.register).toHaveBeenLastCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({
          revision: expect.objectContaining({ id: 'next-head-sha' }),
        }),
      }),
    );
    expect(api.heartbeat).toHaveBeenCalledTimes(1);
  });

  it('publishes the active filter, guided order, annotation, and diff selection together', async () => {
    api.open.mockImplementation((_onEvent, _onError, onOpen) => {
      onOpen?.();
      return vi.fn<() => void>();
    });

    await act(async () => root.render(<NavigationSurfaceHarness />));

    expect(api.register).toHaveBeenCalledWith(
      expect.objectContaining({
        activePath: 'src/b.ts',
        fileFilter: 'src/b',
        reviewOrder: ['src/b.ts', 'src/a.ts'],
        selectedAnnotationId: 'draft-b',
        selection: expect.objectContaining({
          path: 'src/b.ts',
          startLine: 8,
          endLine: 8,
        }),
      }),
    );
  });

  it('registers and updates a non-current refresh status', async () => {
    api.open.mockImplementation((_onEvent, _onError, onOpen) => {
      onOpen?.();
      return vi.fn<() => void>();
    });
    const source = reviewSource();
    const availableRevision = resolvedReviewRevision({
      kind: 'git-commit',
      id: 'next-head-sha',
    });
    const available = createReviewRefreshStatus({
      appliedRevision: source.revision,
      availableRevision,
      safety: { safe: false, reasons: ['active-selection'] },
      state: 'available',
    });

    await act(async () =>
      root.render(
        <RefreshSurfaceHarness refresh={available} source={source} />,
      ),
    );
    expect(api.register).toHaveBeenLastCalledWith(
      expect.objectContaining({ refresh: available }),
    );

    const applying = { ...available, state: 'applying' as const };
    await act(async () =>
      root.render(<RefreshSurfaceHarness refresh={applying} source={source} />),
    );
    expect(api.register).toHaveBeenCalledTimes(2);
    expect(api.register).toHaveBeenLastCalledWith(
      expect.objectContaining({ refresh: applying }),
    );
  });

  it('refreshes only targeted finding metadata without re-registering or loading patches', async () => {
    let onEvent: ((event: unknown) => void) | undefined;
    api.open.mockImplementation((handleEvent, _onError, onOpen) => {
      onEvent = handleEvent;
      onOpen?.();
      return vi.fn<() => void>();
    });
    api.readFindings.mockImplementation(async (surfaceId) => ({
      findings: [finding()],
      revisionKey: 'git-commit::head-sha',
      surfaceId,
    }));

    await act(async () => root.render(<FindingSurfaceHarness />));
    const surfaceId = api.register.mock.calls[0]?.[0]?.surfaceId as string;
    expect(container.textContent).toBe('1:finding-a');
    expect(api.register).toHaveBeenCalledTimes(1);

    api.readFindings.mockClear();
    await act(async () => {
      onEvent?.({
        action: 'findings-changed',
        surfaceId: 'another-surface',
        navigation: null,
      });
      await Promise.resolve();
    });
    expect(api.readFindings).not.toHaveBeenCalled();

    await act(async () => {
      onEvent?.({
        action: 'findings-changed',
        surfaceId,
        navigation: null,
      });
      await Promise.resolve();
    });
    expect(api.readFindings).toHaveBeenCalledTimes(1);
    expect(api.readFindings).toHaveBeenCalledWith(surfaceId);
    expect(api.register).toHaveBeenCalledTimes(1);
  });

  it('does not refetch when a findings response changes the registered review order', async () => {
    api.open.mockImplementation((_onEvent, _onError, onOpen) => {
      onOpen?.();
      return vi.fn<() => void>();
    });
    api.readFindings.mockImplementation(async (surfaceId) => ({
      findings: [finding()],
      revisionKey: 'git-commit::head-sha',
      surfaceId,
    }));

    await act(async () => root.render(<FindingOrderSurfaceHarness />));
    await act(async () => Promise.resolve());

    expect(container.textContent).toBe('src/b.ts,src/a.ts');
    expect(api.register).toHaveBeenCalledTimes(2);
    expect(api.readFindings).toHaveBeenCalledTimes(1);
  });

  it('ignores out-of-order finding reads and keeps the newest targeted response', async () => {
    let onEvent: ((event: unknown) => void) | undefined;
    const first = deferred<{
      findings: NeonReviewFinding[];
      revisionKey: string | null;
      surfaceId: string;
    }>();
    const second = deferred<{
      findings: NeonReviewFinding[];
      revisionKey: string | null;
      surfaceId: string;
    }>();
    api.open.mockImplementation((handleEvent, _onError, onOpen) => {
      onEvent = handleEvent;
      onOpen?.();
      return vi.fn<() => void>();
    });
    api.readFindings
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    await act(async () => root.render(<FindingSurfaceHarness />));
    const surfaceId = api.register.mock.calls[0]?.[0]?.surfaceId as string;
    await act(async () => {
      onEvent?.({ action: 'findings-changed', surfaceId, navigation: null });
      await Promise.resolve();
    });
    await act(async () => {
      second.resolve({
        findings: [finding('newest')],
        revisionKey: 'git-commit::head-sha',
        surfaceId,
      });
      await second.promise;
    });
    expect(container.textContent).toBe('1:newest');

    await act(async () => {
      first.resolve({
        findings: [finding('older')],
        revisionKey: 'git-commit::head-sha',
        surfaceId,
      });
      await first.promise;
    });
    expect(container.textContent).toBe('1:newest');
  });

  it('ignores a finding read completed after the mounted source revision changes', async () => {
    const pending = deferred<{
      findings: NeonReviewFinding[];
      revisionKey: string | null;
      surfaceId: string;
    }>();
    api.open.mockImplementation((_onEvent, _onError, onOpen) => {
      onOpen?.();
      return vi.fn<() => void>();
    });
    api.readFindings.mockImplementationOnce(() => pending.promise);

    await act(async () =>
      root.render(<ReplaceableFindingSurfaceHarness source={reviewSource()} />),
    );
    const surfaceId = api.register.mock.calls[0]?.[0]?.surfaceId as string;
    const nextSource = reviewSource();
    nextSource.revision = resolvedReviewRevision({
      kind: 'git-commit',
      id: 'next-head-sha',
    });
    await act(async () =>
      root.render(<ReplaceableFindingSurfaceHarness source={nextSource} />),
    );
    await act(async () => {
      pending.resolve({
        findings: [finding('old-revision')],
        revisionKey: 'git-commit::head-sha',
        surfaceId,
      });
      await pending.promise;
    });

    expect(container.textContent).toBe('0');
  });
});

function ReviewSurfaceHarness({ source }: { source: ReviewSourceSnapshot }) {
  useReviewSurface({
    activePath: source.files[0]?.path ?? null,
    source,
  });
  return null;
}

function OptionalSurfaceHarness({
  source,
}: {
  source: ReviewSourceSnapshot | null;
}) {
  useReviewSurface(
    source
      ? {
          activePath: source.files[0]?.path ?? null,
          source,
        }
      : null,
  );
  return null;
}

function NavigationSurfaceHarness() {
  useReviewSurface({
    activePath: 'src/b.ts',
    fileFilter: 'src/b',
    reviewOrder: ['src/b.ts', 'src/a.ts'],
    selectedAnnotationId: 'draft-b',
    selection: { side: 'additions', start: 8, end: 8 },
    source: reviewSource(),
  });
  return null;
}

function RefreshSurfaceHarness({
  refresh,
  source,
}: {
  refresh: ReviewSurfaceSnapshot['refresh'];
  source: ReviewSourceSnapshot;
}) {
  useReviewSurface({
    activePath: source.files[0]?.path ?? null,
    refresh,
    source,
  });
  return null;
}

function FindingSurfaceHarness() {
  const [findings, setFindings] = useState<NeonReviewFinding[]>([]);
  const source = useMemo(reviewSource, []);
  useReviewSurface({
    activePath: 'src/a.ts',
    onFindingsChange: (_surfaceId, next) => setFindings(next),
    source,
  });
  return <span>{`${findings.length}:${findings[0]?.id ?? ''}`}</span>;
}

function FindingOrderSurfaceHarness() {
  const [reviewOrder, setReviewOrder] = useState(['src/a.ts', 'src/b.ts']);
  const source = useMemo(reviewSource, []);
  useReviewSurface({
    activePath: 'src/a.ts',
    onFindingsChange: (_surfaceId, next) => {
      if (next.length > 0) setReviewOrder(['src/b.ts', 'src/a.ts']);
    },
    reviewOrder,
    source,
  });
  return <span>{reviewOrder.join(',')}</span>;
}

function ReplaceableFindingSurfaceHarness({
  source,
}: {
  source: ReviewSourceSnapshot;
}) {
  const [findings, setFindings] = useState<NeonReviewFinding[]>([]);
  useReviewSurface({
    activePath: source.files[0]?.path ?? null,
    onFindingsChange: (_surfaceId, next) => setFindings(next),
    source,
  });
  return <span>{findings.length}</span>;
}

function finding(id = 'finding-a'): NeonReviewFinding {
  return {
    schemaVersion: 2,
    id,
    surfaceId: 'surface-a',
    sourceId: 'github-pr:example/repo#42',
    revisionKey: 'git-commit::head-sha',
    file: 'src/a.ts',
    anchor: {
      kind: 'line-range',
      side: 'additions',
      startLine: 1,
      endLine: 1,
    },
    title: 'Finding title',
    explanation: 'Finding explanation.',
    severity: 'major',
    confidence: 'high',
    suggestedAction: null,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function reviewSource(): ReviewSourceSnapshot {
  return {
    schemaVersion: reviewSourceSchemaVersion,
    id: 'github-pr:example/repo#42',
    kind: 'github-pr',
    title: 'Review surface contract',
    revision: resolvedReviewRevision({
      kind: 'git-commit',
      id: 'head-sha',
    }),
    repository: {
      repoId: 'repo-1',
      repoFullName: 'example/repo',
      worktreeId: null,
      localPath: '/tmp/repo',
      localAccess: true,
    },
    files: ['src/a.ts', 'src/b.ts'].map((path) => ({
      path,
      previousPath: null,
      status: 'modified',
      additions: 1,
      deletions: 1,
      generatedLike: false,
      patchState: 'available',
      patchMessage: null,
    })),
    capabilities: ['comments', 'refresh'],
    promotionTargets: [
      {
        destination: 'github-review-draft',
        repoFullName: 'example/repo',
        prNumber: 42,
      },
    ],
    externalUrl: 'https://github.com/example/repo/pull/42',
  };
}
