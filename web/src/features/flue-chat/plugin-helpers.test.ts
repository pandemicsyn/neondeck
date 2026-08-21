import { describe, expect, it } from 'vitest';
import type { ChatSessionRecord } from '../../api';
import { linkedContextLabel } from './plugin';

function session(
  uiMetadata: ChatSessionRecord['uiMetadata'],
): ChatSessionRecord {
  return {
    id: 'session-1',
    title: 'Review',
    agentName: 'display-assistant',
    kind: 'repo',
    pinned: false,
    archivedAt: null,
    linkedRepoId: null,
    linkedWatchId: null,
    linkedTaskId: null,
    staleReasons: [],
    uiMetadata,
    summary: null,
    summaryGeneratedAt: null,
    summarySource: null,
    summaryRefreshNote: null,
    summaryStatus: 'missing',
    contextLoadedAt: '2026-08-21T00:00:00.000Z',
    contextMemoryIds: [],
    createdAt: '2026-08-21T00:00:00.000Z',
    updatedAt: '2026-08-21T00:00:00.000Z',
    lastActiveAt: '2026-08-21T00:00:00.000Z',
  };
}

describe('Flue chat linked context metadata', () => {
  it('retains valid PR fields when an unrelated metadata field is malformed', () => {
    expect(
      linkedContextLabel(
        session({
          source: 'github-pr',
          repo: 'pandemicsyn/neondeck',
          prNumber: 303,
          url: { malformed: true },
        }),
      ),
    ).toBe('pandemicsyn/neondeck#303');
  });
});
