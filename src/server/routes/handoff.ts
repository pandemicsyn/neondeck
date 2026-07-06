import { Hono, type Context } from 'hono';
import {
  createHandoffNote,
  registerHandoffPr,
  registerHandoffWatchPr,
  registerHandoffReleaseWatch,
} from '../../modules/handoff';
import type { RuntimePaths } from '../../runtime-home';
import { safeJsonObject } from '../http';

export function createHandoffRoutes(paths: RuntimePaths) {
  const routes = new Hono();

  routes.post('/handoff/watch-pr', async (c) => {
    const input = await handoffBody(c);
    if (!input.ok) return c.json(input.result, 400);
    const body = input.body;
    const result = await registerHandoffWatchPr(
      {
        ref: body.ref,
        source: body.source,
        desiredTerminalState: body.desiredTerminalState,
        intervalSeconds: body.intervalSeconds,
      } as Parameters<typeof registerHandoffWatchPr>[0],
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/handoff/watch-release', async (c) => {
    const input = await handoffBody(c);
    if (!input.ok) return c.json(input.result, 400);
    const result = await registerHandoffReleaseWatch(
      input.body as Parameters<typeof registerHandoffReleaseWatch>[0],
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/handoff/note', async (c) => {
    const input = await handoffBody(c);
    if (!input.ok) return c.json(input.result, 400);
    const result = await createHandoffNote(
      input.body as Parameters<typeof createHandoffNote>[0],
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  routes.post('/handoff/register-pr', async (c) => {
    const input = await handoffBody(c);
    if (!input.ok) return c.json(input.result, 400);
    const result = await registerHandoffPr(
      input.body as Parameters<typeof registerHandoffPr>[0],
      paths,
    );
    return c.json(result, result.ok ? 200 : 400);
  });

  return routes;
}

async function handoffBody(c: Context) {
  const body = await safeJsonObject(c);
  if (typeof body.source !== 'string' || !body.source.trim()) {
    return {
      ok: false as const,
      result: {
        ok: false,
        action: 'handoff_request',
        changed: false,
        message: 'Handoff API requests require a source field.',
        deckUrl: '/',
        requires: ['source'],
      },
    };
  }

  return { ok: true as const, body };
}
