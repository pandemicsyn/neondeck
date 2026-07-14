import { describe, expect, it } from 'vitest';
import type { NotificationRecord, PrWatch } from '../api';
import {
  notificationDisplayMessage,
  prWatchAttentionReason,
} from './watch-status';

const watch = {
  id: 'Kilo-Org/cloud#4480',
  status: 'attention-needed',
  prState: 'closed',
  lastSnapshot: {
    state: 'closed',
    merged: true,
    mergeCommitSha: 'abc',
    checks: {
      status: 'failure',
      total: 50,
      successful: 40,
      failed: 1,
      pending: 0,
      checkedAt: '2026-07-14T08:02:35.301Z',
    },
    title: 'Direct ingest',
    url: 'https://github.com/Kilo-Org/cloud/pull/4480',
    updatedAt: '2026-07-13T21:26:02Z',
    headSha: 'def',
    baseRef: 'main',
  },
} satisfies Pick<PrWatch, 'id' | 'status' | 'prState' | 'lastSnapshot'>;

describe('PR watch status presentation', () => {
  it('summarizes the evidence behind attention-needed', () => {
    expect(prWatchAttentionReason(watch)).toBe(
      'Merged, but 1 of 50 checks failed.',
    );
  });

  it('upgrades legacy generic watch notification messages from their data', () => {
    expect(
      notificationDisplayMessage({
        id: 'notification-1',
        level: 'attention',
        title: 'PR watch needs attention',
        message: 'Updated watch "Kilo-Org/cloud#4480".',
        source: 'watch-pr',
        sourceId: watch.id,
        data: watch,
        readAt: null,
        resolvedAt: null,
        occurrenceCount: 1,
        createdAt: '2026-07-14T08:02:35.301Z',
        updatedAt: '2026-07-14T08:02:35.301Z',
      } satisfies NotificationRecord),
    ).toBe('Kilo-Org/cloud#4480: Merged, but 1 of 50 checks failed.');
  });
});
