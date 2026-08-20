// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NeonReviewFinding } from '../../../../shared/review-finding';
import type {
  GitHubPrReviewDraftComment,
  PrReviewReportOnlyFinding,
} from '../../api';
import { PrReviewFindingsSidebar } from './PrReviewFindingsSidebar';

describe('PR review findings sidebar', () => {
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
  });

  it('surfaces healthy local drafts with provenance and exact-line actions', () => {
    const neon = draftComment({
      body: 'Neon review finding (nit): Associate the disclosure control.',
      id: 'neon-draft',
      line: 59,
      origin: 'neon',
    });
    const human = draftComment({
      body: 'Please keep this fallback explicit.',
      id: 'human-draft',
      line: 10,
      origin: 'human',
    });
    const onSelectDraftComment =
      vi.fn<(comment: GitHubPrReviewDraftComment) => void>();

    act(() =>
      root.render(
        <PrReviewFindingsSidebar
          actionsLocked={() => false}
          activePath={neon.path}
          cleanCommentCount={2}
          draft={null}
          draftComments={[human, neon]}
          files={[
            {
              additions: 2,
              deletions: 0,
              path: neon.path,
              status: 'modified',
            },
          ]}
          findingResolution={() => ({
            state: 'unavailable',
            reason: 'No finding.',
          })}
          isDeleting={false}
          isDismissingFinding={() => false}
          isLoadingThreads={false}
          isPromotingFinding={() => false}
          neonFindings={[]}
          onChooseLine={vi.fn<(finding: PrReviewReportOnlyFinding) => void>()}
          onDelete={vi.fn<(commentId: string) => void>()}
          onDismissFinding={vi.fn<(finding: NeonReviewFinding) => void>()}
          onPromoteFinding={vi.fn<(finding: NeonReviewFinding) => void>()}
          onReanchor={vi.fn<(comment: GitHubPrReviewDraftComment) => void>()}
          onSelectDraftComment={onSelectDraftComment}
          onSelectFinding={vi.fn<(finding: NeonReviewFinding) => void>()}
          promoteLabel="Add to local draft"
          promotionDisabledReason={() => null}
          review={null}
          reviewThreads={[]}
          selectedAnnotationId={neon.id}
          staleCommentCount={0}
          staleDraftComments={[]}
          unresolvedThreads={[]}
          variant="embedded"
        />,
      ),
    );

    expect(container.textContent).toContain('Draft comments');
    expect(container.textContent).toContain('Generated · nit');
    expect(container.textContent).toContain('Local draft');
    expect(container.textContent).toContain('L59');
    expect(
      container.querySelector('[aria-current="true"]')?.textContent,
    ).toContain('Associate the disclosure control.');

    const showButtons = [
      ...container.querySelectorAll<HTMLButtonElement>('button'),
    ].filter((button) => button.textContent === 'Show comment');
    expect(showButtons).toHaveLength(2);
    const selectedShowButton = container.querySelector<HTMLButtonElement>(
      '[aria-current="true"] button',
    );
    act(() => selectedShowButton!.click());
    expect(onSelectDraftComment).toHaveBeenCalledWith(neon);
  });

  it('keeps draft comment order stable when the active file changes', () => {
    const comments = [
      {
        ...draftComment({
          body: 'Third.',
          id: 'third',
          line: 30,
          origin: 'human',
        }),
        path: 'src/b.ts',
      },
      {
        ...draftComment({
          body: 'Second.',
          id: 'second',
          line: 20,
          origin: 'human',
        }),
        path: 'src/a.ts',
      },
      {
        ...draftComment({
          body: 'First.',
          id: 'first',
          line: 10,
          origin: 'human',
        }),
        path: 'src/a.ts',
      },
    ];
    const sidebarProps = {
      actionsLocked: () => false,
      cleanCommentCount: 3,
      draft: null,
      draftComments: comments,
      files: [],
      findingResolution: () => ({
        state: 'unavailable' as const,
        reason: 'No finding.',
      }),
      isDeleting: false,
      isDismissingFinding: () => false,
      isLoadingThreads: false,
      isPromotingFinding: () => false,
      neonFindings: [],
      onChooseLine: vi.fn<(finding: PrReviewReportOnlyFinding) => void>(),
      onDelete: vi.fn<(commentId: string) => void>(),
      onDismissFinding: vi.fn<(finding: NeonReviewFinding) => void>(),
      onPromoteFinding: vi.fn<(finding: NeonReviewFinding) => void>(),
      onReanchor: vi.fn<(comment: GitHubPrReviewDraftComment) => void>(),
      onSelectDraftComment:
        vi.fn<(comment: GitHubPrReviewDraftComment) => void>(),
      onSelectFinding: vi.fn<(finding: NeonReviewFinding) => void>(),
      promoteLabel: 'Add to local draft',
      promotionDisabledReason: () => null,
      review: null,
      reviewThreads: [],
      selectedAnnotationId: null,
      staleCommentCount: 0,
      staleDraftComments: [],
      unresolvedThreads: [],
      variant: 'embedded' as const,
    };
    act(() =>
      root.render(
        <PrReviewFindingsSidebar {...sidebarProps} activePath="src/a.ts" />,
      ),
    );
    const draftCommentSummaries = () =>
      [
        ...container.querySelectorAll('.pr-review-neon-finding-summary'),
      ].map(
        (element) =>
          element.querySelector('.pr-review-neon-finding-copy')?.textContent,
      );
    const initialOrder = draftCommentSummaries();

    act(() =>
      root.render(
        <PrReviewFindingsSidebar {...sidebarProps} activePath="src/b.ts" />,
      ),
    );
    const updatedOrder = draftCommentSummaries();

    expect(initialOrder).toEqual(['First.', 'Second.', 'Third.']);
    expect(updatedOrder).toEqual(initialOrder);
  });
});

function draftComment(
  input: Pick<GitHubPrReviewDraftComment, 'body' | 'id' | 'line' | 'origin'>,
): GitHubPrReviewDraftComment {
  return {
    ...input,
    createdAt: '2026-07-24T15:43:56.000Z',
    draftId: 'draft-1',
    path: 'src/collapsible-code-block.tsx',
    side: 'RIGHT',
    sourceFindingId: null,
    startLine: null,
    startSide: null,
    updatedAt: '2026-07-24T15:43:56.000Z',
  };
}
