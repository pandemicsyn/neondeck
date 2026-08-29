import { Hono } from 'hono';
import * as v from 'valibot';
import {
  prReviewTourPresentationSchema,
  publishReviewTourPresentation,
  readPrReviewTour,
} from '../../modules/pr-review-tours';
import type { RuntimePaths } from '../../runtime-home';
import { safeJsonBody } from '../http';

export function createReviewTourRoutes(paths: RuntimePaths) {
  const routes = new Hono();

  routes.get('/review-tours/:conversationId', (c) => {
    const tour = readPrReviewTour(c.req.param('conversationId'), paths);
    return c.json({
      ok: true,
      action: 'pr_review_tour_read',
      changed: false,
      tour,
    });
  });

  routes.post('/review-tours/presentation', async (c) => {
    const parsed = v.safeParse(
      prReviewTourPresentationSchema,
      await safeJsonBody(c),
    );
    if (!parsed.success) {
      return c.json(
        {
          ok: false,
          action: 'pr_review_tour_presentation',
          changed: false,
          message: 'Invalid guided-tour presentation event.',
        },
        400,
      );
    }
    const changed = publishReviewTourPresentation(parsed.output, paths);
    return c.json(
      {
        ok: changed,
        action: 'pr_review_tour_presentation',
        changed,
        message: changed
          ? parsed.output.action === 'tour-activated'
            ? 'Queued guided-tour activation for surface acknowledgement.'
            : 'Published the guided-tour presentation event.'
          : 'The guided tour, step, or review surface is no longer current.',
      },
      changed ? 200 : 409,
    );
  });

  return routes;
}
