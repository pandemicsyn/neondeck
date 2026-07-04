import { Hono } from 'hono';
import {
  formatChatSessionServerSentEvent,
  subscribeChatSessionEvents,
} from '../../modules/sessions';

export function createSessionEventRoutes() {
  const routes = new Hono();

  routes.get('/sessions', () => {
    const encoder = new TextEncoder();
    let cleanup = () => {};

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        function send(value: string) {
          controller.enqueue(encoder.encode(value));
        }

        send(': connected\n\n');
        const unsubscribe = subscribeChatSessionEvents((event) => {
          send(formatChatSessionServerSentEvent(event));
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
