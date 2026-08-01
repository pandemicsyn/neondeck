import { Hono } from 'hono';
import {
  readActivityObservability,
  readActivitySubmission,
  readActivitySubmissionEvents,
} from '../../modules/learning';
import type { RuntimePaths } from '../../runtime-home';

export function createActivityRoutes(paths: RuntimePaths) {
  const routes = new Hono();

  routes.get('/', async (c) => {
    return c.json(await readActivityObservability(paths));
  });

  routes.get('/submissions/:submissionId', async (c) => {
    const submissionId = c.req.param('submissionId');
    const afterEventId = parseAfterEventId(c.req.query('afterEventId'));
    if (afterEventId === null) {
      return c.json(
        { error: 'afterEventId must be a non-negative integer.' },
        400,
      );
    }
    const submission = await readActivitySubmission(submissionId, paths);
    if (!submission) {
      return c.json({ error: 'Activity submission not found.' }, 404);
    }
    const history = await readActivitySubmissionEvents(submissionId, paths, {
      afterEventId,
    });
    return c.json({
      ok: true,
      action: 'activity_submission_read',
      submission,
      events: history.events,
      eventHistory: {
        totalEventCount: history.totalEventCount,
        retainedEventCount: history.retainedEventCount,
        isTruncated: history.isTruncated,
      },
      fetchedAt: new Date().toISOString(),
    });
  });

  return routes;
}

function parseAfterEventId(value: string | undefined) {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
