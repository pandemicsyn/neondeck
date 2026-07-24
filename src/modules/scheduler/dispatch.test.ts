import { describe, expect, it } from 'vitest';
import { watchNotificationCopy } from './dispatch';

describe('watch notification copy', () => {
  it('explains why a merged PR needs attention', () => {
    expect(
      watchNotificationCopy(
        {
          id: 'Kilo-Org/cloud#4480',
          repoFullName: 'Kilo-Org/cloud',
          prNumber: 4480,
          status: 'attention-needed',
          prState: 'closed',
          lastSnapshot: {
            merged: true,
            checks: { status: 'failure', total: 50, failed: 1, pending: 0 },
          },
        },
        'Updated watch "Kilo-Org/cloud#4480".',
      ),
    ).toEqual({
      title: 'PR 4480 needs attention',
      message: 'Kilo-Org/cloud#4480 is merged, but 1 of 50 checks failed.',
    });
  });

  it('announces aggregate GitHub review approval', () => {
    expect(
      watchNotificationCopy(
        {
          id: 'Kilo-Org/cloud#4722',
          repoFullName: 'Kilo-Org/cloud',
          prNumber: 4722,
          status: 'ready',
          prState: 'open',
          lastSnapshot: {
            merged: false,
            reviewDecision: 'APPROVED',
            checks: null,
          },
        },
        'Updated watch "Kilo-Org/cloud#4722".',
      ),
    ).toEqual({
      title: 'PR 4722 approved',
      message: 'Kilo-Org/cloud#4722: required reviews approved.',
    });
  });
});
