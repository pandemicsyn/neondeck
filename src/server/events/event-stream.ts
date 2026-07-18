import { Hono } from 'hono';
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

const eventStreamHeartbeatMs = 25_000;

export type EventStreamDependencies = {
  formatChatSessionCommandServerSentEvent: typeof formatChatSessionCommandServerSentEvent;
  formatChatSessionServerSentEvent: typeof formatChatSessionServerSentEvent;
  formatConfigServerSentEvent: typeof formatConfigServerSentEvent;
  formatNotificationServerSentEvent: typeof formatNotificationServerSentEvent;
  formatPrReviewServerSentEvent: typeof formatPrReviewServerSentEvent;
  formatReviewSurfaceServerSentEvent: typeof formatReviewSurfaceServerSentEvent;
  formatReviewSourceRevisionServerSentEvent: typeof formatReviewSourceRevisionServerSentEvent;
  replayConfigEventsAfter: typeof replayConfigEventsAfter;
  subscribeChatSessionCommandEvents: typeof subscribeChatSessionCommandEvents;
  subscribeChatSessionEvents: typeof subscribeChatSessionEvents;
  subscribeConfigEvents: typeof subscribeConfigEvents;
  subscribeNotificationEvents: typeof subscribeNotificationEvents;
  subscribePrReviewEvents: typeof subscribePrReviewEvents;
  subscribeReviewSurfaceEvents: typeof reviewSurfaceRegistry.subscribe;
  subscribeReviewSourceRevisionEvents: typeof subscribeReviewSourceRevisionEvents;
};

const defaultDependencies: EventStreamDependencies = {
  formatChatSessionCommandServerSentEvent,
  formatChatSessionServerSentEvent,
  formatConfigServerSentEvent,
  formatNotificationServerSentEvent,
  formatPrReviewServerSentEvent,
  formatReviewSurfaceServerSentEvent,
  formatReviewSourceRevisionServerSentEvent,
  replayConfigEventsAfter,
  subscribeChatSessionCommandEvents,
  subscribeChatSessionEvents,
  subscribeConfigEvents,
  subscribeNotificationEvents,
  subscribePrReviewEvents,
  subscribeReviewSurfaceEvents: reviewSurfaceRegistry.subscribe.bind(
    reviewSurfaceRegistry,
  ),
  subscribeReviewSourceRevisionEvents,
};

export function createEventStreamRoutes(
  dependencies: EventStreamDependencies = defaultDependencies,
) {
  const routes = new Hono();

  routes.get('/', (c) => {
    const encoder = new TextEncoder();
    const lastEventId = c.req.header('last-event-id');
    let cleanup = () => {};

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let active = true;
        const send = (value: string) => {
          if (!active) return;
          controller.enqueue(encoder.encode(value));
        };
        const unsubscribers = [
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
        ];

        send('retry: 3000\n: connected\n\n');
        for (const event of dependencies.replayConfigEventsAfter(lastEventId)) {
          send(dependencies.formatConfigServerSentEvent(event));
        }
        const heartbeat = setInterval(() => {
          send(`: heartbeat ${Date.now()}\n\n`);
        }, eventStreamHeartbeatMs);

        cleanup = () => {
          if (!active) return;
          active = false;
          clearInterval(heartbeat);
          for (const unsubscribe of unsubscribers) unsubscribe();
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
