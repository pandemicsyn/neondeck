import { Hono } from 'hono';
import {
  formatPrReviewServerSentEvent,
  subscribePrReviewEvents,
} from '../../modules/pr-reviews';

export function createReviewEventRoutes() {
  const routes = new Hono();

  routes.get('/reviews', () => {
    const encoder = new TextEncoder();
    let cleanup = () => {};
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (value: string) =>
          controller.enqueue(encoder.encode(value));
        send(': connected\n\n');
        const unsubscribe = subscribePrReviewEvents((event) => {
          send(formatPrReviewServerSentEvent(event));
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
