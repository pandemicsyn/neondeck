import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import {
  formatNotificationServerSentEvent,
  type NotificationEvent,
} from '../../modules/app-state';
import {
  formatConfigServerSentEvent,
  type ConfigChangeEvent,
} from '../../modules/config';
import {
  formatPrReviewServerSentEvent,
  prReviewTrustBoundary,
  type PrReviewEvent,
} from '../../modules/pr-reviews';
import { formatReviewSurfaceServerSentEvent } from '../../modules/review-surfaces';
import type { ReviewSurfaceChangeEvent } from '../../../shared/review-surface';
import {
  formatChatSessionCommandServerSentEvent,
  formatChatSessionServerSentEvent,
  type ChatSessionCommandChangeEvent,
  type ChatSessionEvent,
} from '../../modules/sessions';
import {
  createEventStreamRoutes,
  type EventStreamDependencies,
} from './event-stream';

describe('dashboard event stream', () => {
  it('fans all app-domain events into one stream and cleans up together', async () => {
    const harness = eventHarness();
    const app = new Hono().route('/api/events', harness.routes);
    const response = await app.request('http://localhost/api/events', {
      headers: { 'last-event-id': 'config-before' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(harness.replay).toHaveBeenCalledWith('config-before');

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const connected = await reader!.read();
    expect(new TextDecoder().decode(connected.value)).toContain(': connected');

    harness.emitAll();
    const output = await readUntil(
      reader!,
      'event: review-surface-change',
      new TextDecoder(),
    );
    expect(output).toContain('event: config-change');
    expect(output).toContain('event: notification-change');
    expect(output).toContain('event: chat-session-change');
    expect(output).toContain('event: chat-session-command-change');
    expect(output).toContain('event: review-change');
    expect(output).toContain('event: review-surface-change');

    await reader!.cancel();
    for (const unsubscribe of harness.unsubscribers) {
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    }
  });

  it('keeps the config replay cursor after a later non-config event', async () => {
    const harness = eventHarness();
    const app = new Hono().route('/api/events', harness.routes);
    const response = await app.request('http://localhost/api/events');
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    await reader!.read();

    harness.emitConfigAndNotification();
    const output = await readUntil(
      reader!,
      'event: notification-change',
      new TextDecoder(),
    );
    const cursor = lastEventId(output);
    expect(cursor).toBe('config-1');
    await reader!.cancel();

    harness.replay.mockClear();
    const reconnect = await app.request('http://localhost/api/events', {
      headers: { 'last-event-id': cursor! },
    });
    expect(harness.replay).toHaveBeenCalledWith('config-1');
    await reconnect.body?.cancel();
  });
});

function eventHarness() {
  let configListener: ((event: ConfigChangeEvent) => void) | undefined;
  let notificationListener: ((event: NotificationEvent) => void) | undefined;
  let sessionListener: ((event: ChatSessionEvent) => void) | undefined;
  let commandListener:
    ((event: ChatSessionCommandChangeEvent) => void) | undefined;
  let reviewListener: ((event: PrReviewEvent) => void) | undefined;
  let reviewSurfaceListener:
    ((event: ReviewSurfaceChangeEvent) => void) | undefined;
  const unsubscribers = [
    vi.fn<() => void>(),
    vi.fn<() => void>(),
    vi.fn<() => void>(),
    vi.fn<() => void>(),
    vi.fn<() => void>(),
    vi.fn<() => void>(),
  ];
  const replay = vi.fn<
    (lastEventId: string | null | undefined) => ConfigChangeEvent[]
  >(() => []);
  const dependencies: EventStreamDependencies = {
    formatChatSessionCommandServerSentEvent,
    formatChatSessionServerSentEvent,
    formatConfigServerSentEvent,
    formatNotificationServerSentEvent,
    formatPrReviewServerSentEvent,
    formatReviewSurfaceServerSentEvent,
    replayConfigEventsAfter: replay,
    subscribeChatSessionCommandEvents(listener) {
      commandListener = listener;
      return unsubscribers[3]!;
    },
    subscribeChatSessionEvents(listener) {
      sessionListener = listener;
      return unsubscribers[2]!;
    },
    subscribeConfigEvents(listener) {
      configListener = listener;
      return unsubscribers[0]!;
    },
    subscribeNotificationEvents(listener) {
      notificationListener = listener;
      return unsubscribers[1]!;
    },
    subscribePrReviewEvents(listener) {
      reviewListener = listener;
      return unsubscribers[4]!;
    },
    subscribeReviewSurfaceEvents(listener) {
      reviewSurfaceListener = listener;
      return unsubscribers[5]!;
    },
  };

  return {
    routes: createEventStreamRoutes(dependencies),
    replay,
    unsubscribers,
    emitAll() {
      configListener?.(configEvent());
      notificationListener?.(notificationEvent());
      sessionListener?.(sessionEvent());
      commandListener?.(commandEvent());
      reviewListener?.(reviewEvent());
      reviewSurfaceListener?.(reviewSurfaceEvent());
    },
    emitConfigAndNotification() {
      configListener?.(configEvent());
      notificationListener?.(notificationEvent());
    },
  };
}

function reviewSurfaceEvent(): ReviewSurfaceChangeEvent {
  return {
    id: 'review-surface-event-1',
    action: 'removed',
    surfaceId: 'surface-1',
    changedAt: '2026-07-18T00:00:00.000Z',
    surface: null,
    navigation: null,
    acknowledgement: null,
    findings: null,
    reason: 'closed',
  };
}

function lastEventId(output: string) {
  return [...output.matchAll(/^id:\s*(.+)$/gmu)].at(-1)?.[1];
}

function configEvent(): ConfigChangeEvent {
  return {
    id: 'config-1',
    action: 'config_reload',
    changed: false,
    home: '/tmp/neondeck',
    files: [],
    target: 'all',
    changedAt: '2026-07-15T00:00:00.000Z',
  };
}

function notificationEvent(): NotificationEvent {
  return {
    id: 'notification-event-1',
    action: 'created',
    changedAt: '2026-07-15T00:00:00.000Z',
    notification: {
      id: 'notification-1',
      level: 'info',
      title: 'Event test',
      message: 'Notification event.',
      source: 'test',
      sourceId: null,
      data: null,
      readAt: null,
      resolvedAt: null,
      occurrenceCount: 1,
      createdAt: '2026-07-15T00:00:00.000Z',
      updatedAt: '2026-07-15T00:00:00.000Z',
    },
  };
}

function sessionEvent(): ChatSessionEvent {
  const timestamp = '2026-07-15T00:00:00.000Z';
  return {
    id: 'session-event-1',
    action: 'updated',
    surface: 'dashboard',
    changedAt: timestamp,
    session: {
      id: 'session-1',
      title: 'Session',
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
      contextLoadedAt: timestamp,
      contextMemoryIds: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      lastActiveAt: timestamp,
    },
  };
}

function commandEvent(): ChatSessionCommandChangeEvent {
  const timestamp = '2026-07-15T00:00:00.000Z';
  return {
    id: 'command-1',
    action: 'updated',
    sessionId: 'session-1',
    changedAt: timestamp,
    event: {
      id: 'command-1',
      sessionId: 'session-1',
      input: '/briefing',
      status: 'completed',
      result: null,
      flueRunId: null,
      workflowSummaryId: null,
      createdAt: timestamp,
      completedAt: timestamp,
      updatedAt: timestamp,
    },
  };
}

function reviewEvent(): PrReviewEvent {
  const timestamp = '2026-07-15T00:00:00.000Z';
  return {
    id: 'review-event-1',
    action: 'changed',
    changedAt: timestamp,
    review: {
      id: 'review-1',
      ref: 'owner/repo#1',
      repoFullName: 'owner/repo',
      prNumber: 1,
      title: 'Review me',
      author: 'author',
      prUrl: 'https://github.com/owner/repo/pull/1',
      status: 'ready',
      runId: 'run-1',
      headSha: 'head-1',
      origin: 'panel',
      reviewUrl: '/review?repo=owner%2Frepo&number=1',
      reportIds: ['report-1'],
      findingCount: 0,
      seededCount: 0,
      reportOnlyCount: 0,
      reportOnlyFindings: [],
      trustBoundary: prReviewTrustBoundary,
      verdict: null,
      previousVerdict: null,
      githubReviewUrl: null,
      failureMessage: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      readyAt: timestamp,
      submittedAt: null,
      failedAt: null,
    },
  };
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  expected: string,
  decoder: TextDecoder,
) {
  let output = '';
  for (let count = 0; count < 8 && !output.includes(expected); count += 1) {
    const chunk = await reader.read();
    if (chunk.value) output += decoder.decode(chunk.value, { stream: true });
  }
  return output;
}
