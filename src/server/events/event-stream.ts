import {
  subscribeFactoryEvents,
  formatFactoryServerSentEvent,
} from '../../modules/factory';
import { Hono } from 'hono';
import { dashboardHeartbeatEventName } from '../../../shared/dashboard-events';
import {
  formatNotificationServerSentEvent,
  subscribeNotificationEvents,
} from '../../modules/app-state';
import {
  formatConfigServerSentEvent,
  replayConfigEventsAfter,
  subscribeConfigEvents,
} from '../../modules/config';
import {
  formatPrReviewServerSentEvent,
  subscribePrReviewEvents,
} from '../../modules/pr-reviews';
import {
  formatReviewTourServerSentEvent,
  subscribeReviewTourEvents,
} from '../../modules/pr-review-tours';
import {
  formatReviewSurfaceServerSentEvent,
  reviewSurfaceRegistry,
} from '../../modules/review-surfaces';
import {
  formatReviewSourceRevisionServerSentEvent,
  subscribeReviewSourceRevisionEvents,
} from '../../modules/review-refresh';
import {
  formatChatSessionCommandServerSentEvent,
  formatChatSessionServerSentEvent,
  subscribeChatSessionCommandEvents,
  subscribeChatSessionEvents,
} from '../../modules/sessions';
import {
  formatGitHubQueueSnapshotServerSentEvent,
  subscribeGitHubQueueSnapshotEvents,
} from '../../modules/github';

const eventStreamHeartbeatMs = 25_000;

function formatDashboardHeartbeat() {
  return `event: ${dashboardHeartbeatEventName}\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`;
}

export type EventStreamDependencies = {
  subscribeFactoryEvents?: typeof subscribeFactoryEvents;
  formatFactoryServerSentEvent?: typeof formatFactoryServerSentEvent;
  formatChatSessionCommandServerSentEvent: typeof formatChatSessionCommandServerSentEvent;
  formatChatSessionServerSentEvent: typeof formatChatSessionServerSentEvent;
  formatConfigServerSentEvent: typeof formatConfigServerSentEvent;
  formatGitHubQueueSnapshotServerSentEvent: typeof formatGitHubQueueSnapshotServerSentEvent;
  formatNotificationServerSentEvent: typeof formatNotificationServerSentEvent;
  formatPrReviewServerSentEvent: typeof formatPrReviewServerSentEvent;
  formatReviewSurfaceServerSentEvent: typeof formatReviewSurfaceServerSentEvent;
  formatReviewSourceRevisionServerSentEvent: typeof formatReviewSourceRevisionServerSentEvent;
  formatReviewTourServerSentEvent?: typeof formatReviewTourServerSentEvent;
  replayConfigEventsAfter: typeof replayConfigEventsAfter;
  subscribeChatSessionCommandEvents: typeof subscribeChatSessionCommandEvents;
  subscribeChatSessionEvents: typeof subscribeChatSessionEvents;
  subscribeConfigEvents: typeof subscribeConfigEvents;
  subscribeGitHubQueueSnapshotEvents: typeof subscribeGitHubQueueSnapshotEvents;
  subscribeNotificationEvents: typeof subscribeNotificationEvents;
  subscribePrReviewEvents: typeof subscribePrReviewEvents;
  subscribeReviewSurfaceEvents: typeof reviewSurfaceRegistry.subscribe;
  subscribeReviewSourceRevisionEvents: typeof subscribeReviewSourceRevisionEvents;
  subscribeReviewTourEvents?: typeof subscribeReviewTourEvents;
};

const defaultDependencies: EventStreamDependencies = {
  subscribeFactoryEvents,
  formatFactoryServerSentEvent,
  formatChatSessionCommandServerSentEvent,
  formatChatSessionServerSentEvent,
  formatConfigServerSentEvent,
  formatGitHubQueueSnapshotServerSentEvent,
  formatNotificationServerSentEvent,
  formatPrReviewServerSentEvent,
  formatReviewSurfaceServerSentEvent,
  formatReviewSourceRevisionServerSentEvent,
  formatReviewTourServerSentEvent,
  replayConfigEventsAfter,
  subscribeChatSessionCommandEvents,
  subscribeChatSessionEvents,
  subscribeConfigEvents,
  subscribeGitHubQueueSnapshotEvents,
  subscribeNotificationEvents,
  subscribePrReviewEvents,
  subscribeReviewSurfaceEvents: reviewSurfaceRegistry.subscribe.bind(
    reviewSurfaceRegistry,
  ),
  subscribeReviewSourceRevisionEvents,
  subscribeReviewTourEvents,
};

export type EventStreamOptions = {
  onConnectionChange?: (event: {
    activeConnections: number;
    state: 'connected' | 'disconnected';
  }) => void;
};

export function createEventStreamRoutes(
  dependencies: EventStreamDependencies = defaultDependencies,
  options: EventStreamOptions = {},
) {
  const routes = new Hono();
  let activeConnections = 0;

  routes.get('/', (c) => {
    const encoder = new TextEncoder();
    const lastEventId = c.req.header('last-event-id');
    let cleanup = () => {};

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let active = true;
        activeConnections += 1;
        options.onConnectionChange?.({
          activeConnections,
          state: 'connected',
        });
        const send = (value: string) => {
          if (!active) return;
          controller.enqueue(encoder.encode(value));
        };
        const unsubscribers = [
          ...(dependencies.subscribeFactoryEvents &&
          dependencies.formatFactoryServerSentEvent
            ? [
                dependencies.subscribeFactoryEvents((event) =>
                  send(dependencies.formatFactoryServerSentEvent!(event)),
                ),
              ]
            : []),
          dependencies.subscribeConfigEvents((event) => {
            send(dependencies.formatConfigServerSentEvent(event));
          }),
          dependencies.subscribeNotificationEvents((event) => {
            send(dependencies.formatNotificationServerSentEvent(event));
          }),
          dependencies.subscribeChatSessionEvents((event) => {
            send(dependencies.formatChatSessionServerSentEvent(event));
          }),
          dependencies.subscribeChatSessionCommandEvents((event) => {
            send(dependencies.formatChatSessionCommandServerSentEvent(event));
          }),
          dependencies.subscribePrReviewEvents((event) => {
            send(dependencies.formatPrReviewServerSentEvent(event));
          }),
          dependencies.subscribeReviewSurfaceEvents((event) => {
            send(dependencies.formatReviewSurfaceServerSentEvent(event));
          }),
          dependencies.subscribeReviewSourceRevisionEvents((event) => {
            send(dependencies.formatReviewSourceRevisionServerSentEvent(event));
          }),
          ...(dependencies.subscribeReviewTourEvents &&
          dependencies.formatReviewTourServerSentEvent
            ? [
                dependencies.subscribeReviewTourEvents((event) => {
                  send(dependencies.formatReviewTourServerSentEvent!(event));
                }),
              ]
            : []),
          dependencies.subscribeGitHubQueueSnapshotEvents((event) => {
            send(dependencies.formatGitHubQueueSnapshotServerSentEvent(event));
          }),
        ];

        send('retry: 3000\n: connected\n\n');
        send(formatDashboardHeartbeat());
        for (const event of dependencies.replayConfigEventsAfter(lastEventId)) {
          send(dependencies.formatConfigServerSentEvent(event));
        }
        const heartbeat = setInterval(() => {
          send(formatDashboardHeartbeat());
        }, eventStreamHeartbeatMs);

        cleanup = () => {
          if (!active) return;
          active = false;
          clearInterval(heartbeat);
          for (const unsubscribe of unsubscribers) unsubscribe();
          activeConnections = Math.max(0, activeConnections - 1);
          options.onConnectionChange?.({
            activeConnections,
            state: 'disconnected',
          });
        };
      },
      cancel() {
        cleanup();
      },
    });

    return new Response(stream, {
      headers: {
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'content-type': 'text/event-stream; charset=utf-8',
        'x-accel-buffering': 'no',
      },
    });
  });

  return routes;
}
