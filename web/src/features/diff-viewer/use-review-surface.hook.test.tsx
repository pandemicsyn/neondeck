// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  reviewSourceSchemaVersion,
  resolvedReviewRevision,
  type ReviewSourceSnapshot,
} from '../../../../shared/review-source';
import { useReviewSurface } from './use-review-surface';

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
  register: vi.fn<() => Promise<undefined>>(),
  remove: vi.fn<() => Promise<undefined>>(),
}));

vi.mock('../../api', () => ({
  acknowledgeReviewSurfaceNavigation: api.acknowledge,
  heartbeatReviewSurface: api.heartbeat,
  openReviewSurfaceEventStream: api.open,
  registerReviewSurface: api.register,
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
    api.remove.mockResolvedValue(undefined);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
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
});

function ReviewSurfaceHarness({ source }: { source: ReviewSourceSnapshot }) {
  useReviewSurface({
    activePath: source.files[0]?.path ?? null,
    source,
  });
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
    externalUrl: 'https://github.com/example/repo/pull/42',
  };
}
