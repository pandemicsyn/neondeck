import { describe, expect, it } from 'vitest';
import {
  deltasFromChangedCategories,
  initialActionableDeltas,
} from './pr-watch-event-deltas';
import type { PrWatchEventWatermarkRecord } from '../pr-events';

const watch = {
  id: 'pandemicsyn/neondeck#164',
  repoId: 'neondeck',
  repoFullName: 'pandemicsyn/neondeck',
  prNumber: 164,
};

describe('per-item PR feedback deltas', () => {
  it('admits only the new comment in an existing review thread', () => {
    const previous = [
      watermark('review_threads', {
        threads: [thread(comment('101', 'fp-101'))],
      }),
    ];
    const current = [
      watermark('review_threads', {
        threads: [thread(comment('101', 'fp-101'), comment('102', 'fp-102'))],
      }),
    ];

    expect(
      deltasFromChangedCategories(['review_threads'], current, previous),
    ).toEqual([
      expect.objectContaining({
        type: 'review-comment',
        itemId: '102',
        change: 'new',
      }),
    ]);
  });

  it('retains overall review bodies and conversation comments as distinct items', () => {
    const current = [
      watermark('requested_changes_reviews', {
        reviews: [
          {
            id: 201,
            authorLogin: 'reviewer',
            body: 'Please cover the timeout path.',
            bodyTruncated: false,
            fingerprint: 'review-fp',
            actionable: true,
          },
        ],
      }),
      watermark('conversation_comments', {
        comments: [
          {
            id: 301,
            authorLogin: 'maintainer',
            body: 'Update the user-facing error too.',
            bodyTruncated: false,
            fingerprint: 'conversation-fp',
            actionable: true,
          },
        ],
      }),
    ];

    expect(
      deltasFromChangedCategories(
        ['requested_changes_reviews', 'conversation_comments'],
        current,
        [],
      ),
    ).toEqual([
      expect.objectContaining({
        type: 'requested-changes',
        review: expect.objectContaining({
          body: 'Please cover the timeout path.',
        }),
      }),
      expect.objectContaining({
        type: 'conversation-comment',
        comment: expect.objectContaining({
          body: 'Update the user-facing error too.',
        }),
      }),
    ]);
  });

  it('suppresses every unchanged comment from an addressed thread baseline but re-admits edits and replies', () => {
    const addressed = new Map([
      ['101', 'fp-101'],
      ['102', 'fp-102'],
    ]);
    const baseline = [
      watermark('review_threads', {
        threads: [thread(comment('101', 'fp-101'), comment('102', 'fp-102'))],
      }),
    ];
    expect(
      initialActionableDeltas(baseline, {
        addressedReviewCommentFingerprints: addressed,
      }),
    ).toEqual([]);

    const edited = [
      watermark('review_threads', {
        threads: [
          thread(comment('101', 'fp-101-edited'), comment('102', 'fp-102')),
        ],
      }),
    ];
    expect(
      initialActionableDeltas(edited, {
        addressedReviewCommentFingerprints: addressed,
      }),
    ).toEqual([expect.objectContaining({ itemId: '101', change: 'new' })]);

    const appended = [
      watermark('review_threads', {
        threads: [
          thread(
            comment('101', 'fp-101'),
            comment('102', 'fp-102'),
            comment('103', 'fp-103'),
          ),
        ],
      }),
    ];
    expect(
      initialActionableDeltas(appended, {
        addressedReviewCommentFingerprints: addressed,
      }),
    ).toEqual([expect.objectContaining({ itemId: '103', change: 'new' })]);
  });

  it('re-admits an addressed item when its fingerprint changes and blocks truncated feedback', () => {
    const current = [
      watermark('review_threads', {
        threads: [thread(comment('101', 'fp-new', { bodyTruncated: true }))],
      }),
    ];
    expect(
      initialActionableDeltas(current, {
        addressedReviewCommentFingerprints: new Map([['101', 'fp-old']]),
      }),
    ).toEqual([
      expect.objectContaining({
        type: 'incomplete-feedback',
        itemId: '101',
        actionable: false,
        requiresExplanation: true,
      }),
    ]);

    expect(
      initialActionableDeltas([
        watermark('conversation_comments', {
          truncated: true,
          comments: [],
        }),
      ]),
    ).toEqual([
      expect.objectContaining({
        type: 'incomplete-feedback',
        feedbackType: 'conversation_comments',
        actionable: false,
        requiresExplanation: true,
      }),
    ]);
  });

  it('suppresses only exact durable Neondeck deliveries, not users, bots, or forged markers', () => {
    const current = [
      watermark('conversation_comments', {
        comments: [
          conversation('301', 'user-fp', 'User feedback'),
          conversation('302', 'bot-fp', 'Bot feedback', { authorIsBot: true }),
          conversation('303', 'forged-fp', '<!-- neondeck:generated -->'),
          conversation('304', 'delivered-fp', 'Actual Neondeck delivery'),
        ],
      }),
    ];
    const deltas = initialActionableDeltas(current, {
      neondeckConversationCommentFingerprints: new Map([
        ['304', 'delivered-fp'],
      ]),
    });

    expect(deltas.map((delta) => delta.itemId)).toEqual(['301', '302', '303']);
    expect(deltas).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemId: '303',
          candidateReasoning: true,
          mutationEligible: false,
        }),
      ]),
    );
    expect(
      initialActionableDeltas(
        [
          watermark('conversation_comments', {
            comments: [
              conversation('304', 'delivered-fp-edited', 'Edited delivery'),
            ],
          }),
        ],
        {
          neondeckConversationCommentFingerprints: new Map([
            ['304', 'delivered-fp'],
          ]),
        },
      ),
    ).toEqual([expect.objectContaining({ itemId: '304', change: 'new' })]);
  });

  it('matches a Neondeck review reply by comment identity across thread state changes', () => {
    const delivered = new Map([['101', 'comment-only-fp']]);
    const resolvedThread = [
      watermark('review_threads', {
        threads: [
          thread({
            ...comment('101', 'context-fp-after-resolution'),
            deliveryFingerprint: 'comment-only-fp',
            isResolved: true,
          }),
        ],
      }),
    ];
    expect(
      initialActionableDeltas(resolvedThread, {
        neondeckReviewCommentFingerprints: delivered,
      }),
    ).toEqual([]);

    const edited = [
      watermark('review_threads', {
        threads: [
          thread({
            ...comment('101', 'context-fp-edited'),
            deliveryFingerprint: 'comment-only-fp-edited',
          }),
        ],
      }),
    ];
    expect(
      initialActionableDeltas(edited, {
        neondeckReviewCommentFingerprints: delivered,
      }),
    ).toEqual([expect.objectContaining({ itemId: '101' })]);
  });

  it('suppresses an exact Neondeck review while preserving co-occurring human requested changes', () => {
    const reviews = [
      {
        id: '901',
        fingerprint: 'self-review-fingerprint',
        authorLogin: 'neon',
        body: 'Automated review body',
        actionable: true,
        bodyTruncated: false,
      },
      {
        id: '902',
        fingerprint: 'human-review-fingerprint',
        authorLogin: 'maintainer',
        body: 'Please fix the remaining edge.',
        actionable: true,
        bodyTruncated: false,
      },
    ];
    expect(
      initialActionableDeltas(
        [watermark('requested_changes_reviews', { reviews })],
        {
          neondeckRequestedChangesReviewFingerprints: new Map([
            ['901', 'self-review-fingerprint'],
          ]),
        },
      ),
    ).toEqual([
      expect.objectContaining({
        type: 'requested-changes',
        itemId: '902',
      }),
    ]);

    expect(
      initialActionableDeltas(
        [
          watermark('requested_changes_reviews', {
            reviews: [{ ...reviews[0], fingerprint: 'edited-self-review' }],
          }),
        ],
        {
          neondeckRequestedChangesReviewFingerprints: new Map([
            ['901', 'self-review-fingerprint'],
          ]),
        },
      ),
    ).toEqual([expect.objectContaining({ itemId: '901' })]);
  });
});

function watermark(
  category: PrWatchEventWatermarkRecord['category'],
  watermark: Record<string, unknown>,
): PrWatchEventWatermarkRecord {
  return {
    watchId: watch.id,
    category,
    watermark: watermark as never,
    sourceUpdatedAt: '2026-07-19T00:00:00.000Z',
    checkedAt: '2026-07-19T00:00:00.000Z',
    createdAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:00.000Z',
  };
}
function thread(...comments: Array<Record<string, unknown>>) {
  return {
    id: 'thread-1',
    isResolved: false,
    isOutdated: false,
    commentsTruncated: false,
    comments,
  };
}

function comment(
  id: string,
  fingerprint: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    fingerprint,
    authorLogin: 'reviewer',
    body: `Feedback ${id}`,
    actionable: true,
    bodyTruncated: false,
    ...overrides,
  };
}

function conversation(
  id: string,
  fingerprint: string,
  body: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    fingerprint,
    authorLogin: 'reviewer',
    authorIsBot: false,
    body,
    actionable: true,
    bodyTruncated: false,
    ...overrides,
  };
}
