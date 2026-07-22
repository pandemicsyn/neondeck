import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ChatSessionRecord } from '../../../api';
import { SessionSelect } from './session-select';

function session(
  overrides: Partial<ChatSessionRecord> = {},
): ChatSessionRecord {
  return {
    id: 'session-1',
    title: 'Primary',
    agentName: 'display-assistant',
    kind: 'main',
    pinned: false,
    archivedAt: null,
    linkedRepoId: null,
    linkedWatchId: null,
    linkedTaskId: null,
    staleReasons: [],
    uiMetadata: null,
    summary: null,
    summaryGeneratedAt: null,
    summarySource: null,
    summaryRefreshNote: null,
    summaryStatus: 'missing',
    contextLoadedAt: '2026-07-21T18:00:00.000Z',
    contextMemoryIds: [],
    createdAt: '2026-07-21T18:00:00.000Z',
    updatedAt: '2026-07-21T18:00:00.000Z',
    lastActiveAt: '2026-07-21T18:00:00.000Z',
    ...overrides,
  };
}

describe('SessionSelect', () => {
  it('keeps the normal context state quiet', () => {
    const html = renderToStaticMarkup(
      <SessionSelect
        activeSessionId="session-1"
        disabled={false}
        onSelect={() => undefined}
        sessions={[session()]}
      />,
    );

    expect(html).toContain('>Primary</option>');
    expect(html).not.toContain('durable');
    expect(html).not.toContain('stale');
  });

  it('explains when the loaded context has changed', () => {
    const html = renderToStaticMarkup(
      <SessionSelect
        activeSessionId="session-1"
        disabled={false}
        onSelect={() => undefined}
        sessions={[
          session({
            staleReasons: [
              {
                type: 'memory',
                message: 'Project memory changed.',
                changedAt: '2026-07-21T18:05:00.000Z',
                target: null,
              },
            ],
          }),
        ]}
      />,
    );

    expect(html).toContain('Primary · context changed');
    expect(html).toContain(
      'title="Project memory changed. Start a new chat to load the latest context."',
    );
  });
});
