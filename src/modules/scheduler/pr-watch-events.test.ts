import type { CoordinateAutopilotAdmissionResult } from '../autopilot';
import { describe, expect, it } from 'vitest';
import {
  pendingEventResultsFromJobResult,
  triageAdmissionResultFromCoordination,
} from './pr-watch-events';
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
const eventId = 'watch:164:review_threads:feedback';
const eventInput = { eventId, source: 'watch' as const };

describe('watch triage coordinator results', () => {
  it('reports a workflow dispatch failure with durable retry evidence and attention', () => {
    const result = triageAdmissionResultFromCoordination({
      watch,
      eventId,
      input: eventInput,
      admissionId: 'admission:164',
      coordination: coordination('dispatch-failed'),
    });

    expect(result).toMatchObject({
      ok: false,
      changed: true,
      message: 'Autopilot triage admission failed: Flue is unavailable.',
      triage: {
        status: 'failed',
        input: { ...eventInput, admissionId: 'admission:164' },
        dispatch: {
          admissionId: 'admission:164',
          attemptId: 'attempt:164',
          attemptStatus: 'failed',
          workflow: 'triage-pr-event',
          error: 'Flue is unavailable',
        },
      },
      notifications: [
        expect.objectContaining({
          level: 'attention',
          sourceId: `triage:${watch.id}:${eventId}:dispatch-failed`,
        }),
      ],
    });
    expect(
      pendingEventResultsFromJobResult({
        eventResults: [{ watchId: watch.id, triage: result.triage! }],
      } as never),
    ).toEqual([
      expect.objectContaining({
        watchId: watch.id,
        triage: expect.objectContaining({
          status: 'failed',
          input: { ...eventInput, admissionId: 'admission:164' },
        }),
      }),
    ]);
  });

  it.each([
    ['cas-lost', true, 'cas-lost', 0],
    ['stale-reservation', true, 'stale-reservation', 0],
    ['not-reserved', true, 'not-reserved', 0],
    ['orphaned-receipt', false, 'orphaned-receipt', 1],
    ['unsupported-transport', false, 'unsupported-transport', 1],
    ['missing', false, 'missing', 1],
  ] as const)(
    'maps %s without claiming the triage workflow launched',
    (status, ok, triageStatus, notificationCount) => {
      const result = triageAdmissionResultFromCoordination({
        watch,
        eventId,
        input: eventInput,
        admissionId: 'admission:164',
        coordination: coordination(status),
      });

      expect(result).toMatchObject({
        ok,
        triage: {
          status: triageStatus,
          input: { ...eventInput, admissionId: 'admission:164' },
        },
      });
      expect(result.triage).not.toMatchObject({ status: 'admitted' });
      expect(result.notifications).toHaveLength(notificationCount);
    },
  );
});

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

function coordination(
  status:
    | 'cas-lost'
    | 'stale-reservation'
    | 'not-reserved'
    | 'orphaned-receipt'
    | 'unsupported-transport'
    | 'missing'
    | 'dispatch-failed',
): CoordinateAutopilotAdmissionResult {
  const context = {
    attempt: {
      id: 'attempt:164',
      status: status === 'dispatch-failed' ? 'failed' : 'reserved',
      attemptNumber: 1,
      workflow: 'triage-pr-event',
    },
    admission: {
      id: 'admission:164',
      state: 'triage-admitted',
      version: 3,
    },
  };
  const dispatched =
    status === 'missing'
      ? { status }
      : status === 'dispatch-failed'
        ? { status, error: 'Flue is unavailable', ...context }
        : status === 'orphaned-receipt'
          ? { status, runId: 'run:orphaned', ...context }
          : { status, ...context };
  return {
    advanced: { status: 'reserved' },
    dispatched,
  } as unknown as CoordinateAutopilotAdmissionResult;
}
