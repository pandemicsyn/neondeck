import { Hono } from 'hono';
import * as v from 'valibot';
import {
  reviewSurfaceFindingsApplySchema,
  reviewSurfaceFindingsClearSchema,
  reviewSurfaceFindingsDismissSchema,
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

  routes.get('/review-surfaces/:surfaceId/findings', (c) => {
    const result = registry.readFindings(c.req.param('surfaceId'));
    return result.ok ? c.json(result) : c.json(result, 404);
  });

  routes.post('/review-surfaces/:surfaceId/findings/apply', async (c) => {
    const body = await readJson(c);
    const parsed = v.safeParse(reviewSurfaceFindingsApplySchema, body);
    if (!parsed.success) return invalidInput(c, parsed.issues);
    return findingResult(
      c,
      registry.applyFindings(c.req.param('surfaceId'), parsed.output),
    );
  });

  routes.post('/review-surfaces/:surfaceId/findings/dismiss', async (c) => {
    const body = await readJson(c);
    const parsed = v.safeParse(reviewSurfaceFindingsDismissSchema, body);
    if (!parsed.success) return invalidInput(c, parsed.issues);
    return findingResult(
      c,
      registry.dismissFindings(c.req.param('surfaceId'), parsed.output),
    );
  });

  routes.post('/review-surfaces/:surfaceId/findings/clear', async (c) => {
    const body = await readJson(c);
    const parsed = v.safeParse(reviewSurfaceFindingsClearSchema, body);
    if (!parsed.success) return invalidInput(c, parsed.issues);
    return findingResult(
      c,
      registry.clearFindings(c.req.param('surfaceId'), parsed.output),
    );
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

function findingResult(
  c: {
    json: (body: unknown, status?: 200 | 404 | 409) => Response;
  },
  result: ReturnType<ReviewSurfaceRegistry['applyFindings']>,
) {
  if (result.ok) return c.json(result, 200);
  return c.json(
    result,
    result.error?.code === 'surface-not-active' ? 404 : 409,
  );
}
