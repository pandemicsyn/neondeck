import { Hono } from 'hono';
import {
  formatConfigServerSentEvent,
  replayConfigEventsAfter,
  subscribeConfigEvents,
} from '../../modules/config';

const configEventHeartbeatMs = 10_000;
const configEventStreamMaxAgeMs = 20_000;

export function createConfigEventRoutes() {
  const routes = new Hono();

  routes.get('/config', (c) => {
    const lastEventId = c.req.header('last-event-id');
    const encoder = new TextEncoder();
    let cleanup = () => {};

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let active = true;
        function send(value: string) {
          if (!active) return;
          controller.enqueue(encoder.encode(value));
        }

        send('retry: 3000\n: connected\n\n');
        const unsubscribe = subscribeConfigEvents((event) => {
          send(formatConfigServerSentEvent(event));
        });
        for (const event of replayConfigEventsAfter(lastEventId)) {
          send(formatConfigServerSentEvent(event));
        }
        const heartbeat = setInterval(() => {
          send(`: heartbeat ${Date.now()}\n\n`);
        }, configEventHeartbeatMs);
        const maxAge = setTimeout(() => {
          send(': reconnecting\n\n');
          cleanup();
          controller.close();
        }, configEventStreamMaxAgeMs);

        cleanup = () => {
          if (!active) return;
          active = false;
          clearInterval(heartbeat);
          clearTimeout(maxAge);
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
