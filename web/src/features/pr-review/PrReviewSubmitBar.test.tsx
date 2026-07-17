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

    expect(html).toContain('aria-label="Review submission controls"');
    expect(html).toContain('<legend class="sr-only">Review verdict</legend>');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('id="pr-review-summary-body"');
    expect(html).toContain('>Submit</button>');
  });
});
