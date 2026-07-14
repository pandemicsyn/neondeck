import { describe, expect, it } from 'vitest';
import type { NotificationRecord } from '../../api';
import { resolveNotificationTarget } from './targets';

describe('notification target resolution', () => {
  it.each([
    [
      'prepared diff',
      note({ data: { preparedDiffId: 'diff-1' } }),
      { kind: 'plugin', pluginId: 'autopilot', label: 'Open autopilot' },
    ],
    [
      'approval',
      note({ source: 'mcp', data: { approvalId: 'approval-1' } }),
      {
        kind: 'plugin',
        pluginId: 'runtime-overview',
        label: 'Open approvals',
      },
    ],
    [
      'Kilo task',
      note({ source: 'kilo', data: { taskId: 'task-1' } }),
      {
        kind: 'plugin',
        pluginId: 'runtime-overview',
        label: 'Open tasks',
      },
    ],
    [
      'briefing session',
      note({ source: 'briefing', data: { sessionId: 'session-1' } }),
      { kind: 'session', sessionId: 'session-1', label: 'Open session' },
    ],
    [
      'Flue run',
      note({ source: 'flue', data: { runId: 'run-1' } }),
      {
        kind: 'plugin',
        pluginId: 'workflow-observability',
        label: 'Inspect run',
      },
    ],
    [
      'fallback',
      note({ source: 'unknown', data: null }),
      {
        kind: 'plugin',
        pluginId: 'runtime-overview',
        label: 'Open notifications',
      },
    ],
  ])('resolves %s without scraping prose', (_label, notification, target) => {
    expect(resolveNotificationTarget(notification)).toEqual(target);
  });

  it('accepts only local review URLs', () => {
    expect(
      resolveNotificationTarget(
        note({ data: { reviewUrl: '/review?repo=owner/repo&number=1' } }),
      ),
    ).toEqual({
      kind: 'url',
      href: '/review?repo=owner/repo&number=1',
      label: 'Open review',
    });
    expect(
      resolveNotificationTarget(
        note({ source: 'unknown', data: { reviewUrl: 'https://bad.test' } }),
      ).kind,
    ).toBe('plugin');
  });
});

function note(overrides: Partial<NotificationRecord>): NotificationRecord {
  return {
    id: 'note',
    level: 'ready',
    title: 'Title not used for routing',
    message: 'Message not used for routing',
    source: 'autopilot',
    sourceId: 'one',
    data: {},
    readAt: null,
    resolvedAt: null,
    occurrenceCount: 1,
    createdAt: '2026-07-11T00:00:00.000Z',
    updatedAt: '2026-07-11T00:00:00.000Z',
    ...overrides,
  };
}
