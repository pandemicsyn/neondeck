import { describe, expect, it } from 'vitest';
import {
  parsePrReviewerConversationId,
  prReviewerConversationId,
} from '../shared/pr-reviewer-session';

describe('PR reviewer conversation IDs', () => {
  it('binds a conversation to one reviewed head revision', () => {
    const reviewId = 'review-123';
    const headSha = 'a'.repeat(40);

    expect(
      parsePrReviewerConversationId(
        prReviewerConversationId(reviewId, headSha),
      ),
    ).toEqual({ reviewId, headSha });
  });

  it('continues to parse legacy unversioned conversation IDs', () => {
    expect(parsePrReviewerConversationId('review-123')).toEqual({
      reviewId: 'review-123',
      headSha: null,
    });
  });
});
