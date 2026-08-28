import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PrReviewSubmitBar } from './PrReviewSubmitBar';

describe('PrReviewSubmitBar accessibility', () => {
  it('keeps verdict and summary controls available with submission actions', () => {
    const html = renderToStaticMarkup(
      <PrReviewSubmitBar
        cleanCommentCount={1}
        draft={null}
        isBusy={false}
        isDurableReviewReady
        isHeadAvailable
        isLocked={false}
        isSubmitting={false}
        onBodyBlur={vi.fn<() => void>()}
        onBodyChange={vi.fn<(value: string) => void>()}
        onBodyFocus={vi.fn<() => void>()}
        onDiscard={vi.fn<() => void>()}
        onPendingCountClick={vi.fn<() => void>()}
        onSubmit={vi.fn<() => void>()}
        onVerdictChange={vi.fn<
          (value: 'comment' | 'approve' | 'request-changes') => void
        >()}
        reviewBody="Summary"
        staleCommentCount={0}
        statusMessage={null}
        trustBoundary={null}
        tourOpen
        verdict="comment"
      />,
    );

    expect(html).toContain('aria-label="Review submission controls"');
    expect(html).toContain('<legend class="sr-only">Review verdict</legend>');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('id="pr-review-summary-body"');
    expect(html).toContain('>Submit</button>');
    expect(html).toContain('tour open · not a comment');
  });

  it('locks summary and submission controls during a revision update', () => {
    const html = renderToStaticMarkup(
      <PrReviewSubmitBar
        cleanCommentCount={1}
        draft={null}
        isBusy
        isDurableReviewReady
        isHeadAvailable
        isLocked
        isSubmitting={false}
        onBodyBlur={vi.fn<() => void>()}
        onBodyChange={vi.fn<(value: string) => void>()}
        onBodyFocus={vi.fn<() => void>()}
        onDiscard={vi.fn<() => void>()}
        onPendingCountClick={vi.fn<() => void>()}
        onSubmit={vi.fn<() => void>()}
        onVerdictChange={vi.fn<
          (value: 'comment' | 'approve' | 'request-changes') => void
        >()}
        reviewBody="Summary"
        staleCommentCount={0}
        statusMessage={null}
        trustBoundary={null}
        verdict="comment"
      />,
    );

    expect(html).toMatch(/<textarea[^>]*disabled=""/);
    expect(html).toContain(
      '<button class="pr-review-count" disabled="" title="Cycle through pending draft comments" type="button">1 pending</button>',
    );
    expect(html).toContain('<button disabled="" type="button">Submit</button>');
  });

  it('keeps Submit enabled while an admitted draft autosave is pending', () => {
    const html = renderToStaticMarkup(
      <PrReviewSubmitBar
        cleanCommentCount={0}
        draft={null}
        isBusy
        isDurableReviewReady
        isHeadAvailable
        isLocked={false}
        isSubmitting={false}
        onBodyBlur={vi.fn<() => void>()}
        onBodyChange={vi.fn<(value: string) => void>()}
        onBodyFocus={vi.fn<() => void>()}
        onDiscard={vi.fn<() => void>()}
        onPendingCountClick={vi.fn<() => void>()}
        onSubmit={vi.fn<() => void>()}
        onVerdictChange={vi.fn<
          (value: 'comment' | 'approve' | 'request-changes') => void
        >()}
        reviewBody="Saved by blur"
        staleCommentCount={0}
        statusMessage={null}
        trustBoundary={null}
        verdict="comment"
      />,
    );

    expect(html).toMatch(/<button(?![^>]*disabled)[^>]*>Submit<\/button>/);
  });
});
