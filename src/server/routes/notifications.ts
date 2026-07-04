import { Hono } from 'hono';
import {
  listNotifications,
  markNotificationRead,
  resolveNotification,
} from '../../app-state';
import type { RuntimePaths } from '../../runtime-home';

export function createNotificationRoutes(paths: RuntimePaths) {
  const routes = new Hono();

  routes.get('/', async (c) => {
    const includeResolved = c.req.query('includeResolved') === '1';
    return c.json({
      items: await listNotifications(paths, { includeResolved }),
      policy: notificationPolicy(),
      fetchedAt: new Date().toISOString(),
    });
  });

  routes.post('/:id/read', async (c) => {
    await markNotificationRead(c.req.param('id'), paths);
    return c.json({ ok: true });
  });

  routes.post('/:id/resolve', async (c) => {
    await resolveNotification(c.req.param('id'), paths);
    return c.json({ ok: true });
  });

  return routes;
}

function notificationPolicy() {
  return {
    info: 'Passive updates such as queued scheduled work.',
    ready: 'Completed work or green checks that can be glanced at and cleared.',
    attention:
      'Actionable failures, missing configuration, blocked watches, or failed Flue work.',
    urgent:
      'Release or production-facing failures that should interrupt passive viewing.',
    reconcile:
      'Unresolved notifications with the same source and source id are updated in place and counted.',
    autopilot:
      'Autopilot notifications use deterministic source ids by prepared diff/workflow and state: review-fix, ci-fix, verify, push-blocked, pushed, comment-result, and failed-workflow. Repeated retries reconcile in place; state changes create separate actionable records with recovery metadata.',
    kilo: 'Kilo notifications reconcile by delegated task and state: started, progress, waiting-approval, completed, failed, timed-out, needs-review, verified, promote-blocked, and promoted. Progress updates replace one task progress row; result workflow states create separate actionable records linked to the task.',
  };
}
