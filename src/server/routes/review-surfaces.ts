import { Hono } from 'hono';
import * as v from 'valibot';
import {
  reviewSurfaceNavigationAckInputSchema,
  reviewSurfaceNavigationRequestSchema,
  reviewSurfaceRegistry,
  reviewSurfaceSnapshotSchema,
  type ReviewSurfaceRegistry,
} from '../../modules/review-surfaces';

export function createReviewSurfaceRoutes(
  registry: ReviewSurfaceRegistry = reviewSurfaceRegistry,
) {
  const routes = new Hono();

  routes.get('/review-surfaces', (c) =>
    c.json({ ok: true, surfaces: registry.list() }),
  );

  routes.get('/review-surfaces/:surfaceId', (c) => {
    const surface = registry.read(c.req.param('surfaceId'));
    return surface
      ? c.json({ ok: true, surface })
      : c.json({ ok: false, message: 'Review surface is not active.' }, 404);
  });

  routes.put('/review-surfaces/:surfaceId', async (c) => {
    const body = await readJson(c);
    const parsed = v.safeParse(reviewSurfaceSnapshotSchema, body);
    if (!parsed.success) return invalidInput(c, parsed.issues);
    if (parsed.output.surfaceId !== c.req.param('surfaceId')) {
      return c.json(
        { ok: false, message: 'Surface id does not match the route.' },
        400,
      );
    }
    return c.json({ ok: true, surface: registry.upsert(parsed.output) });
  });

  routes.delete('/review-surfaces/:surfaceId', (c) => {
    const removed = registry.remove(c.req.param('surfaceId'));
    return c.json({ ok: true, removed });
  });

  routes.post('/review-surfaces/:surfaceId/heartbeat', (c) => {
    const surface = registry.heartbeat(c.req.param('surfaceId'));
    return surface
      ? c.json({ ok: true, expiresAt: surface.expiresAt })
      : c.json({ ok: false, message: 'Review surface is not active.' }, 404);
  });

  routes.post('/review-surfaces/:surfaceId/navigation', async (c) => {
    const body = await readJson(c);
    const parsed = v.safeParse(reviewSurfaceNavigationRequestSchema, body);
    if (!parsed.success) return invalidInput(c, parsed.issues);
    const navigation = registry.navigate(
      c.req.param('surfaceId'),
      parsed.output,
    );
    return navigation
      ? c.json({ ok: true, navigation })
      : c.json({ ok: false, message: 'Review surface is not active.' }, 404);
  });

  routes.post(
    '/review-surfaces/:surfaceId/navigation/:commandId/ack',
    async (c) => {
      const body = await readJson(c);
      const parsed = v.safeParse(reviewSurfaceNavigationAckInputSchema, body);
      if (!parsed.success) return invalidInput(c, parsed.issues);
      const acknowledgement = registry.acknowledge(
        c.req.param('surfaceId'),
        c.req.param('commandId'),
        parsed.output,
      );
      return acknowledgement
        ? c.json({ ok: true, acknowledgement })
        : c.json(
            {
              ok: false,
              message: 'Review surface or navigation command is not active.',
            },
            404,
          );
    },
  );

  return routes;
}

async function readJson(c: {
  req: { json: () => Promise<unknown> };
}): Promise<unknown> {
  return c.req.json().catch(() => null);
}

function invalidInput(
  c: { json: (body: unknown, status: 400) => Response },
  issues: readonly v.BaseIssue<unknown>[],
) {
  return c.json(
    {
      ok: false,
      message: issues.map((issue) => issue.message).join('; '),
    },
    400,
  );
}
