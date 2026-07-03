import { Hono } from 'hono';
import {
  formatNotificationServerSentEvent,
  subscribeNotificationEvents,
} from '../../notification-events';

export function createNotificationEventRoutes() {
  const routes = new Hono();

  routes.get('/notifications', () => {
    const encoder = new TextEncoder();
    let cleanup = () => {};

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        function send(value: string) {
          controller.enqueue(encoder.encode(value));
        }

        send(': connected\n\n');
        const unsubscribe = subscribeNotificationEvents((event) => {
          send(formatNotificationServerSentEvent(event));
        });
        const heartbeat = setInterval(() => {
          send(`: heartbeat ${Date.now()}\n\n`);
        }, 25_000);

        cleanup = () => {
          clearInterval(heartbeat);
          unsubscribe();
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
